/**
 * Earthquake damage criteria (Phase 13). Every failure follows from the computed response —
 * inter-story drift, floor acceleration, foundation tilt, ground motion at a person's feet —
 * against a capacity; no "magnitude ≥ X ⇒ destroyed" rule exists anywhere.
 *
 *  - windows:          story drift at the window vs. glass racking capacity
 *  - cladding/units/   floor acceleration at the part vs. its anchorage capacity
 *    signs/parapets/
 *    roof panels
 *  - wall cracking:    peak story drift between the slight and extensive thresholds
 *  - structure:        damage index D (drift + cumulative plastic drift) ≥ 1, or foundation
 *                      tilt ≥ 3 × the failure threshold → collapse into rigid debris
 *  - poles/signs/walls: their own SDOF damage index ≥ 1 → topple / collapse
 *  - people:           balance reserve drained by ground acceleration / velocity
 *
 * Capacities scatter per part (±35 %), derived from the object seed and the part id, so the
 * outcome is reproducible and independent of the simulation RNG stream.
 * Demand ratios between 0.75 and 1.3 accumulate damage over the cycles (low-cycle fatigue);
 * ≥ 1.3 fails at once.
 */
import type { Vec3 } from '@/core/types';
import { hashString, seededRandom, vAdd, vScale } from '@/core/math';
import { GRAVITY } from '@/core/units';
import type { ComponentKind } from '@/core/model';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeComponent, RuntimeEntity } from '../../SimulationRuntime';
import type { StructuralModel } from '../../seismic/StructuralModel';
import { DamageState, worst } from '../DamageState';
import { componentWorldNormal, componentWorldPos, spawnDebris, spawnParticles } from '../spawn';
import { collapse, COMPONENT_ROUNDS, noteFacadeFailure } from './building';
import { detachByQuake, failByQuake } from './structure';
import { knockDown } from './human';
import { seismicDamageIndex } from '../seismicLevels';
import { infraProps } from '../../seismic/structuralProps';
import { MATERIALS, type MaterialId } from '@/buildings/materials';
import { updateModularQuake } from '../../buildings/modular';

const ONSET = 0.75;
const INSTANT = 1.3;
const ACCUMULATE = 1.6; // damage per second per unit of demand ratio above ONSET

/** Median capacities: drift ratio (windows) or floor acceleration in g (anchored parts). */
const CAPACITY: Partial<Record<ComponentKind, number>> = {
  window: 0.011,
  sign: 0.9,
  exterior: 0.7,
  wall: 0.75,
  roof: 1.6,
};
const SHOP_WINDOW = 0.007;
/** Drift capacity of a door frame (modular buildings, Phase 17). */
const DOOR_DRIFT = 0.015;

/** Deterministic per-part scatter factor in [0.65, 1.35]. */
function scatter(seed: number, id: string): number {
  return 0.65 + 0.7 * seededRandom((seed ^ hashString(`eq:${id}`)) >>> 0)();
}

/** Drift-based (true) or acceleration-based (false) capacity of a facade part. */
export const isDriftPart = (kind: ComponentKind) => kind === 'window' || kind === 'cladding' || kind === 'door';

export function capacities(e: RuntimeEntity): Float64Array {
  const st = e.seismic!;
  if (st.capacity) return st.capacity;
  const cap = new Float64Array(e.components.length);
  e.components.forEach((c, i) => {
    let base: number;
    if (c.spec.kind === 'cladding') base = MATERIALS[(c.spec.material ?? 'masonry') as MaterialId]?.facadeDrift ?? 0.004; // Phase 17 envelope panels
    else if (c.spec.kind === 'door') base = DOOR_DRIFT;
    else base = c.spec.kind === 'window' && c.spec.size[0] > 2 && c.spec.size[1] > 2 && !e.modular ? SHOP_WINDOW : (CAPACITY[c.spec.kind] ?? Infinity);
    cap[i] = base * scatter(e.source.seed, c.spec.id);
  });
  st.partDamage = new Float64Array(e.components.length);
  return (st.capacity = cap);
}

/** Damage accumulation: returns true when the part fails. */
export function accumulate(dmg: Float64Array, i: number, ratio: number, dt: number): boolean {
  if (ratio >= INSTANT) {
    dmg[i] = 1;
    return true;
  }
  if (ratio > ONSET) dmg[i] = Math.min(1, dmg[i] + (ratio - ONSET) * ACCUMULATE * dt);
  return dmg[i] >= 1;
}

const LOG_MILESTONES = [1, 10, 40, 160];

function countAndLog(e: RuntimeEntity, ctx: SystemContext, kind: string, key: 'log.quake.windows' | 'log.quake.parts') {
  const n = (e.counters[kind] = (e.counters[kind] ?? 0) + 1);
  if (LOG_MILESTONES.includes(n)) ctx.log(e.id, 'warn', { key, params: { n } });
}

const vel: [number, number] = [0, 0];

/** A facade part shaken off / broken by the earthquake. */
export function failPart(e: RuntimeEntity, c: RuntimeComponent, ctx: SystemContext, model: StructuralModel, response: number, cause: 'drift' | 'acceleration') {
  const st = e.seismic!;
  const pos = (c.worldPos ??= componentWorldPos(e, c.spec));
  const normal = componentWorldNormal(e, c.spec) ?? ([0, 1, 0] as Vec3);
  const k = e.source.transform.scale;
  const size: Vec3 = [c.spec.size[0] * k[0], c.spec.size[1] * k[1], c.spec.size[2] * k[2]];
  const before = c.health;
  c.health = 0;
  c.state = DamageState.DESTROYED;
  e.rev++;
  noteFacadeFailure(e);
  ctx.recordDamage(e, {
    eventType: c.spec.kind === 'window' ? 'BROKEN' : 'DETACHED',
    cause,
    hazard: 'earthquake',
    componentId: c.spec.id,
    componentKind: c.spec.kind,
    worldPosition: pos,
    localWindSpeed: 0,
    force: c.spec.mass * (cause === 'acceleration' ? response * GRAVITY : model.accelAt(st.unit, pos[1] - e.pose.position[1])),
    damageBefore: 1 - before,
    damageAfter: 1,
    response,
  });
  // Parts leave with the floor's sway velocity (scaled by height) plus a small outward push.
  const H = Math.max(1, e.dims[1]);
  model.topVelocity(st.unit, vel);
  const f = Math.max(0, Math.min(1, (pos[1] - e.pose.position[1]) / H));
  const sway: Vec3 = [vel[0] * f, 0, vel[1] * f];
  if (c.spec.kind === 'window') {
    c.condition = 'broken';
    // Glass falls out of the frame and down the facade.
    spawnParticles(ctx, 'glass', pos, 8, vAdd(vScale(normal, 1.2), sway), 0.8, '#cfe6f7');
    countAndLog(e, ctx, 'quakeWindow', 'log.quake.windows');
    return;
  }
  c.condition = 'detached';
  spawnDebris(ctx, e, {
    kind: c.spec.kind,
    position: pos,
    size,
    mass: c.spec.mass,
    color: c.spec.color ?? '#888',
    push: vAdd(sway, vScale(normal, 0.5)),
    hazard: 'earthquake',
  });
  if (c.spec.kind === 'sign') ctx.log(e.id, 'warn', { key: 'log.quake.sign' });
  else countAndLog(e, ctx, 'quakePart', 'log.quake.parts');
}

export const CRACK_LEVELS = [0.01, 0.6];

export function updateBuildingQuake(e: RuntimeEntity, ctx: SystemContext, model: StructuralModel, dt: number) {
  if (e.flags.collapsed) return;
  if (e.modular) {
    updateModularQuake(e, ctx, model, dt);
    return;
  }
  const st = e.seismic!;
  const th = st.thresholds!;
  const ui = st.unit;

  // Wall cracking from the peak drift so far.
  st.crack = Math.max(0, Math.min(1, (st.peakDrift - th.slight) / (th.extensive - th.slight)));
  const level = CRACK_LEVELS.findIndex((l, i) => i >= st.crackRecorded && st.crack >= l);
  if (level >= 0 && level >= st.crackRecorded) {
    st.crackRecorded = level + 1;
    e.rev++;
    ctx.recordDamage(e, { eventType: 'CRACKED', cause: 'drift', hazard: 'earthquake', response: st.peakDrift, damageBefore: 1 - e.health, damageAfter: 1 - e.health, localWindSpeed: 0 });
    ctx.log(e.id, level === 0 ? 'info' : 'warn', { key: level === 0 ? 'log.quake.cracks' : 'log.quake.heavyCracks' });
  }

  // Foundation failure (excess residual tilt).
  if (!st.foundationFailed && st.tiltMag >= st.failureTilt) {
    st.foundationFailed = true;
    e.rev++;
    ctx.recordDamage(e, { eventType: 'TILTED', cause: 'foundation', hazard: 'earthquake', response: (st.tiltMag * 180) / Math.PI, localWindSpeed: 0 });
    ctx.log(e.id, 'danger', { key: 'log.quake.tilted', params: { deg: ((st.tiltMag * 180) / Math.PI).toFixed(1) } });
  }

  // Structural collapse.
  const D = seismicDamageIndex(st);
  if (D >= 1) {
    const tiltDriven = st.tiltMag / (3 * st.failureTilt) >= st.damage;
    let dx = tiltDriven ? st.tilt[0] : st.top[0];
    let dz = tiltDriven ? st.tilt[1] : st.top[1];
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) { dx /= l; dz /= l; } else { dx = st.shakeDir[0]; dz = st.shakeDir[1]; }
    model.topVelocity(ui, vel);
    collapse(e, ctx, { dir: [dx, 0, dz], speed: Math.hypot(vel[0], vel[1]), cause: tiltDriven ? 'foundation' : 'drift', response: tiltDriven ? (st.tiltMag * 180) / Math.PI : st.peakDrift });
    e.state = DamageState.DESTROYED;
    return;
  }

  // Facade parts, staggered in rounds like the wind evaluation.
  if (!ctx.env.groundMotion.active) return;
  const cap = capacities(e);
  const dmg = st.partDamage!;
  const comps = e.components;
  const cdt = dt * COMPONENT_ROUNDS;
  for (let ci = ctx.step % COMPONENT_ROUNDS; ci < comps.length; ci += COMPONENT_ROUNDS) {
    const c = comps[ci];
    if (c.condition !== 'intact' || c.spec.kind === 'structure' || cap[ci] === Infinity) continue;
    const y = c.spec.position[1] * e.source.transform.scale[1];
    let ratio: number;
    let response: number;
    if (c.spec.kind === 'window') {
      response = model.storyDrift(ui, model.storyAt(ui, y));
      ratio = response / cap[ci];
    } else {
      response = model.accelAt(ui, y) / GRAVITY;
      ratio = response / cap[ci];
    }
    if (accumulate(dmg, ci, ratio, cdt)) failPart(e, c, ctx, model, response, c.spec.kind === 'window' ? 'drift' : 'acceleration');
    else if (dmg[ci] > 0) {
      c.health = Math.min(c.health, 1 - dmg[ci]);
      c.state = worst(c.state, dmg[ci] > 0.5 ? DamageState.CRITICAL : DamageState.DAMAGED);
    }
  }
}

export function updateInfraQuake(e: RuntimeEntity, ctx: SystemContext, model: StructuralModel, dt: number) {
  if (e.flags.toppled || e.flags.collapsed) return;
  const st = e.seismic!;
  if (st.damage >= 1) {
    let dx = st.top[0];
    let dz = st.top[1];
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) { dx /= l; dz /= l; } else { dx = st.shakeDir[0]; dz = st.shakeDir[1]; }
    failByQuake(e, ctx, [dx, 0, dz], st.peakDrift);
    return;
  }
  if (!ctx.env.groundMotion.active) return;
  const inf = infraProps(e.source.type, e.dims as Vec3);
  if (!inf || inf.attachmentCapacity === Infinity) return;
  const dmg = (st.partDamage ??= new Float64Array(e.components.length));
  const response = model.accelAt(st.unit, e.dims[1]) / GRAVITY;
  e.components.forEach((c, ci) => {
    if (c.spec.kind === 'structure' || c.condition !== 'intact') return;
    const ratio = response / (inf.attachmentCapacity * scatter(e.source.seed, c.spec.id));
    if (accumulate(dmg, ci, ratio, dt)) detachByQuake(e, c, ctx, response);
  });
}

/** Ground acceleration / velocity at which an average standing person starts to lose balance. */
const BALANCE_ACCEL = 2.5; // m/s² (≈ 0.25 g)
const BALANCE_VEL = 0.35; // m/s
const BALANCE_ONSET = 0.6;
const DRAIN = 3;
const RECOVER = 0.1;
const FALL_NOW = 1.8;

export function updatePersonQuake(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  if (e.flags.fallen || !e.dynamic || e.body === null) return;
  const st = e.seismic!;
  const g = st.ground;
  const a = Math.hypot(g.a[0], g.a[2]);
  const v = Math.hypot(g.v[0], g.v[2]);
  const s = e.strength;
  const demand = Math.max(a / (BALANCE_ACCEL * s), v / (BALANCE_VEL * s));
  if (demand > BALANCE_ONSET) st.balance -= (demand - BALANCE_ONSET) * DRAIN * dt;
  else st.balance = Math.min(1, st.balance + RECOVER * dt);
  if (demand >= FALL_NOW || st.balance <= 0) {
    // The body is thrown opposite to the ground acceleration (inertia).
    knockDown(e, ctx, 'earthquake', undefined, [-st.shakeDir[0], 0, -st.shakeDir[1]]);
  }
}
