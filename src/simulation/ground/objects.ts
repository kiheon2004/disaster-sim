/**
 * How objects respond to moving and deposited sediment (Phase 22). The sediment is a CONTINUUM
 * (the depth-averaged layer of the granular solver), never per-particle bodies:
 *
 *  - moving layer (thickness h, velocity u, density ρ_d = mass / volume of the cell):
 *      dynamic bodies  drag ½·ρ_d·C_d·A·|u_rel|·u_rel through the ForceLedger ('sediment'), every
 *                      step (SedimentForceSystem) — same law as water drag, Phase 14
 *      people          stability ratio max(drag / (μ·W), overturning moment / righting moment) — as
 *                      the Phase 14 flood person model with debris density; ≥ 1 → knocked down
 *      structures      dynamic pressure α·ρ_d·u² over the flow depth (α = 1, the lower end of the
 *                      range used for debris-flow impact, e.g. Hübl et al. 2009 report α ≈ 0.7–5)
 *  - loose deposit (thickness d against the object): at-rest earth pressure ½·K₀·γ_d·d²·B,
 *    K₀ = 1 − sin φ of the debris.
 *  Buildings: lateral load vs. the lateral strength of the structural system (the same capacity
 *    as the flood and earthquake models; modular buildings: ground-story member capacity),
 *    damage accumulates above 50 % like the flood model and folds into the ground channel.
 *  Poles, signs, walls, trees: base moment vs. the design moment of their wind design (as the
 *    flood model) → topple (they become free bodies).
 *  Burial: loose material at the object above a fraction of its height (people 0.7, vehicles
 *    0.6, small structures 0.8) → BURIED (recorded once).
 *
 * Not modelled: impact of individual boulders, abrasion, the sediment's own drag reduction by the
 * object (no blockage), pressure distribution over a facade (one resultant).
 */
import { GRAVITY } from '@/core/units';
import type { GeoField } from '@/ground/GeoField';
import { DEG } from '@/ground/materials';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { DamageState, worst } from '../damage/DamageState';
import { seismicOf, STRUCTURAL_SYSTEMS } from '../seismic/structuralProps';
import { residualStrength } from '../interactions/integrity';
import { footprint, groundLevel, stateOf } from '../deformation/response';
import { knockDown } from '../damage/behaviors/human';
import type { GroundFailureChannel } from './GroundFailureChannel';
import { currentStories } from '../buildings/modular';

export const AIR = 1.225;
/** Dynamic pressure coefficient of debris impact (lower end of the published range). */
export const DEBRIS_ALPHA = 1;
export const STRUCT_ONSET = 0.5;
export const STRUCT_RATE = 0.02;
const BURIAL: Record<string, number> = { human: 0.7, car: 0.6, truck: 0.6, streetLight: 0.8, sign: 0.8, wall: 0.8, tree: 0.8 };
const PERSON_CD = 1.1, PERSON_MU = 0.5;
export const FOOT_LEVER = 0.15;

/** Flow at a vertex: thickness, velocity (x, z), bulk density, loose deposit. */
export interface FlowSample { h: number; ux: number; uz: number; rho: number; deposit: number; phi: number }

export function flowAt(f: GeoField, x: number, z: number, out: FlowSample): FlowSample {
  out.h = 0; out.ux = 0; out.uz = 0; out.rho = 0; out.deposit = 0; out.phi = 30 * DEG;
  const i = f.index(x, z);
  if (i < 0) return out;
  const ix = i % f.nx, iz = (i - ix) / f.nx;
  out.deposit = f.loose[i];
  out.phi = f.profile(i).friction * DEG;
  const h = f.h[i];
  const A = f.dx * f.dx;
  if (out.deposit > 0) out.rho = f.looseMass[i] / (out.deposit * A);
  if (h <= 1e-3) return out;
  out.h = h;
  out.rho = f.mass[i] / (h * A);
  const n = f.nx;
  const qxl = ix > 0 ? f.qx[iz * (n - 1) + ix - 1] : 0, qxr = ix < n - 1 ? f.qx[iz * (n - 1) + ix] : 0;
  const qzd = iz > 0 ? f.qz[(iz - 1) * n + ix] : 0, qzu = iz < f.nz - 1 ? f.qz[iz * n + ix] : 0;
  out.ux = (qxl + qxr) / 2 / h;
  out.uz = (qzd + qzu) / 2 / h;
  return out;
}

const sample: FlowSample = { h: 0, ux: 0, uz: 0, rho: 0, deposit: 0, phi: 0 };

/** Lateral strength of a building's structure (N) — as the flood model. */
export function lateralCapacity(e: RuntimeEntity): number {
  if (e.modular) {
    // Ground-story strength of the members still standing (Phase 25: the collapse engine's state).
    const c = currentStories(e.modular);
    return Math.max(0, Math.min(c.vx[0] ?? 0, c.vz[0] ?? 0)) * (e.source.seismic?.structure.strengthFactor ?? 1);
  }
  const seismic = seismicOf(e.source);
  const cy = seismic ? STRUCTURAL_SYSTEMS[seismic.structure.system].cy * seismic.structure.strengthFactor : 0.25;
  return cy * e.source.physics.mass * GRAVITY * Math.max(0.2, e.source.transform.scale[1]);
}

/** Which phenomenon governs a point ("sinkhole:p1" …) for damage records. */
export function sourceAt(ch: GroundFailureChannel, x: number, z: number): string | undefined {
  const f = ch.field!;
  const i = f.index(x, z);
  if (i < 0 || f.owner[i] < 0) return undefined;
  const m = ch.modelOf(f.owner[i]);
  if (!m) return undefined;
  const kind = 'kind' in m ? m.kind : 'cavityHeight' in m.spec ? 'sinkhole' : 'landslide';
  return `${kind}:${m.name}`;
}

/** Responses of every object near moving / deposited sediment (10 Hz, after the flow step). */
export function respondToSediment(ctx: SystemContext, ch: GroundFailureChannel, dt: number): number {
  const f = ch.field!;
  let n = 0;
  for (const e of ctx.runtime.entities.values()) {
    if (e.def.inert || e.flags.collapsed) continue;
    const p = e.pose.position;
    const fs = flowAt(f, p[0], p[2], sample);
    if (fs.h <= 0.02 && fs.deposit <= 0.02 && e.source.type !== 'building') continue;
    if (e.source.type === 'building') {
      if (respondBuilding(e, ctx, ch, f, dt)) n++;
      continue;
    }
    n++;
    const st = stateOf(e);
    st.overburden = fs.deposit + fs.h;
    st.source ??= sourceAt(ch, p[0], p[2]);
    const H = e.dims[1];
    const burial = BURIAL[e.source.type];
    if (burial !== undefined && st.overburden >= burial * H && !st.noted.has('buried')) {
      st.noted.add('buried');
      e.state = worst(e.state, DamageState.CRITICAL);
      e.lastHazard = 'ground';
      ctx.recordDamage(e, { eventType: 'BURIED', cause: 'burial', hazard: 'ground', response: st.overburden, source: st.source });
      ctx.log(e.id, 'danger', { key: 'log.ground.buried', params: { m: st.overburden.toFixed(2) } });
    }
    const speed = Math.hypot(fs.ux, fs.uz);
    if (e.source.type === 'human') {
      if (e.flags.fallen || !e.dynamic) continue;
      const w = e.dims[0] * e.areaFactor;
      const d = Math.min(fs.h, H);
      const fd = 0.5 * fs.rho * PERSON_CD * w * d * speed * speed;
      const W = e.source.physics.mass * GRAVITY;
      const r = Math.max(fd / (PERSON_MU * W), (fd * d * 0.5) / (W * FOOT_LEVER));
      st.debrisRatio = r;
      if (r >= 1) knockDown(e, ctx, 'ground', fd, speed > 0 ? [fs.ux / speed, 0, fs.uz / speed] : undefined);
      continue;
    }
    if (e.source.type === 'streetLight' || e.source.type === 'sign' || e.source.type === 'wall' || e.source.type === 'tree') {
      if (e.flags.toppled || e.dynamic || e.body === null) continue;
      const w = e.source.type === 'wall' ? e.dims[0] : Math.min(e.dims[0], e.dims[2]);
      const k0 = 1 - Math.sin(fs.phi);
      const dep = Math.min(H, fs.deposit), hf = Math.min(H, fs.h);
      // Base moments: earth pressure (resultant at d/3) + dynamic pressure (at h/2, over the deposit).
      const earth = 0.5 * k0 * fs.rho * GRAVITY * dep * dep * w * (dep / 3);
      const dyn = DEBRIS_ALPHA * fs.rho * speed * speed * hf * w * (dep + hf / 2);
      const windDesign = e.source.physics.windResistance * e.strength;
      let design = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * windDesign * windDesign * Math.max(0.5, e.copLocal[1]);
      if (ctx.interactions) design *= residualStrength(e, 'ground');
      const ratio = design > 0 ? (earth + dyn) / design : 0;
      st.debrisRatio = ratio;
      if (ratio >= e.source.physics.breakThreshold) {
        ctx.physics.setBodyKind(e.body, 'dynamic');
        e.dynamic = true;
        e.flags.toppled = true;
        st.damage = 1;
        st.health = 0;
        e.state = DamageState.DESTROYED;
        e.lastHazard = 'ground';
        e.lastCause = 'debris';
        ctx.recordDamage(e, { eventType: 'TOPPLED', cause: 'debris', hazard: 'ground', response: ratio, force: earth + dyn, source: st.source });
        ctx.log(e.id, 'danger', { key: 'log.ground.toppled' });
        if (speed > 0.1) ctx.physics.applyImpulse(e.body, [(fs.ux / speed) * e.source.physics.mass * 0.5, 0, (fs.uz / speed) * e.source.physics.mass * 0.5]);
      }
    }
  }
  return n;
}

/** Buildings: lateral sediment load at the most loaded footprint point. Returns true if loaded. */
function respondBuilding(e: RuntimeEntity, ctx: SystemContext, ch: GroundFailureChannel, f: GeoField, dt: number): boolean {
  const { hx, hz, yaw } = footprint(e);
  const [x0, , z0] = e.initialPose.position;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let best = 0, dep = 0, hf = 0, rho = 0, speed = 0, phi = 30 * DEG, bx = x0, bz = z0;
  // Perimeter samples (where the sediment presses on the walls) and the centre.
  for (const [u, v] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [0, 0]]) {
    const x = x0 + u * hx * 1.1 * c + v * hz * 1.1 * s, z = z0 - u * hx * 1.1 * s + v * hz * 1.1 * c;
    const fs = flowAt(f, x, z, sample);
    const sp = Math.hypot(fs.ux, fs.uz);
    const load = 0.5 * (1 - Math.sin(fs.phi)) * fs.rho * GRAVITY * fs.deposit * fs.deposit + DEBRIS_ALPHA * fs.rho * sp * sp * fs.h;
    if (load > best) { best = load; dep = fs.deposit; hf = fs.h; rho = fs.rho; speed = sp; phi = fs.phi; bx = x; bz = z; }
  }
  if (best <= 0) return false;
  const st = stateOf(e);
  st.source ??= sourceAt(ch, bx, bz);
  st.overburden = dep + hf;
  const B = Math.max(e.dims[0], e.dims[2]);
  const F = best * B;
  const capacity = lateralCapacity(e) * (ctx.interactions ? residualStrength(e, 'ground') : 1);
  const r = capacity > 0 ? F / capacity : 0;
  st.debrisRatio = r;
  let d = st.debrisDamage ?? 0;
  if (r > STRUCT_ONSET) d += STRUCT_RATE * ((r - STRUCT_ONSET) / STRUCT_ONSET) * dt * (r >= 1.5 ? 10 : 1);
  st.debrisDamage = Math.min(1, d);
  if (st.debrisDamage > st.damage) {
    st.damage = st.debrisDamage;
    st.health = 1 - st.damage;
    const level = groundLevel(st);
    if (level > e.state) {
      e.state = level;
      e.lastHazard = 'ground';
      e.lastCause = 'debris';
    }
    if (st.damage >= 0.3 && !st.noted.has('debrisLoad')) {
      st.noted.add('debrisLoad');
      // (The state transition itself is recorded once by the MetricsSystem with hazard / cause / source.)
      ctx.log(e.id, 'danger', { key: 'log.ground.buildingLoaded', params: { r: r.toFixed(2) } });
    }
  }
  void rho; void speed; void phi;
  return true;
}
