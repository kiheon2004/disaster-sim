import { canopyFactor } from '../vegetation/vegetation';
import type { Quat, Vec3 } from '@/core/types';
import { qRotate, qRotateInto, vLen, vScale, vSub } from '@/core/math';
import { AIR_DENSITY, WIND_FORCE_SCALE } from '@/core/units';
import { boxProjectedArea, loadRatio } from '../damage/windLoad';
import { createLocalWind } from '../wind/SpatialWindField';
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { residualStrength } from '../interactions/integrity';

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Plates (roof panels, signs) generate lift when tumbling through the air. */
const PLATE_LIFT = 0.45;
const DEBRIS_CD = 1.15;

// Scratch buffers (the loop is synchronous; nothing retains them).
const cop: Vec3 = [0, 0, 0];
const rot: Vec3 = [0, 0, 0];
const dirW: Vec3 = [0, 0, 0];
const local: Vec3 = [0, 0, 0];
const qc: Quat = [0, 0, 0, 1];
const debrisWind = createLocalWind();
const flow: [number, number] = [0, 0];

function conjInto(q: Quat): Quat {
  qc[0] = -q[0]; qc[1] = -q[1]; qc[2] = -q[2]; qc[3] = q[3];
  return qc;
}

/**
 * Aerodynamic loading (prePhysics):
 *  - samples the wind field at each object's center of pressure,
 *  - records the load ratio for the damage system,
 *  - applies drag F = ½ρ·Cd·A·|v_rel|²  at the pressure center of every dynamic body
 *    (so tipping torque and sliding emerge from the rigid-body solver).
 *
 * Phase 29 (atmosphere experiments only): the air is the atmosphere's — ρ at the centre of pressure
 * (p(z)/(R·T)), the velocity = the prescribed wind (Phase 15 background, unchanged) + the computed
 * flow (column + near-surface layer; zero in a resting atmosphere, so nothing is added twice), the
 * load ratio × ρ/ρ_design (design speeds are sea-level calibrations: load ∝ ρ·v²), and dynamic bodies
 * moving through still air get the same drag (their own motion) — one force per body through the
 * ForceLedger's 'wind' source, never a second one.
 */
export class WindForceSystem implements SimulationSystem {
  readonly name = 'windForce';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['airflow', 'poses', 'water'] as const;
  readonly writes = ['forces'] as const;
  readonly lagged = ['poses', 'water'] as const;
  /**
   * Calm: sampling returns exact zeros, so one calm pass resets every entity's wind state and
   * later calm steps would only rewrite the same zeros — they are skipped (earthquake- or
   * flood-only runs no longer sample the wind field for every object each step).
   */
  private dirty = false;

  isActive(ctx: SystemContext) {
    return ctx.env.wind.blowing || this.dirty || ctx.env.atmosphere.rt !== null;
  }

  update({ env, runtime, physics, time, forces, interactions }: SystemContext) {
    const field = env.windField;
    const rho0 = env.airDensity || AIR_DENSITY;
    let rho = rho0;
    const atm = env.atmosphere.rt;
    const calm = !env.wind.blowing && !atm;
    this.dirty = !calm;

    for (const e of runtime.entities.values()) {
      if (e.def.inert) continue;
      const p = e.pose.position;
      qRotateInto(rot, e.pose.quaternion, e.copLocal);
      cop[0] = p[0] + rot[0];
      cop[1] = p[1] + rot[1];
      cop[2] = p[2] + rot[2];
      // Local wind from the spatial field (an object never sits in its own wake), written into
      // the entity's own LocalWind. Static objects reuse their obstacle effect until it changes.
      const lw = field.sample(cop, time, e.id, e.dynamic ? undefined : e.windCache, e.localWind);
      // Phase 19 (opt-in): trees inside a forest feel the canopy-sheltered wind.
      if (e.canopy) {
        const k = canopyFactor(e, lw.velocity[0], lw.velocity[2]);
        if (k < 1) {
          lw.velocity[0] *= k; lw.velocity[1] *= k; lw.velocity[2] *= k;
          lw.speed *= k;
          lw.shelter *= k;
        }
      }
      if (atm) {
        // Phase 29: computed flow on top of the prescribed wind, local density.
        atm.flowAt(cop[0], cop[2], cop[1] - env.terrain.sampleHeight(cop[0], cop[2]), flow);
        lw.velocity[0] += flow[0]; lw.velocity[2] += flow[1];
        lw.speed = Math.hypot(lw.velocity[0], lw.velocity[1], lw.velocity[2]);
        rho = atm.densityAt(cop[0], cop[1], cop[2]);
      }
      const v = lw.velocity;
      const speed = lw.speed;
      e.windAtCop = speed;
      e.loadRatio = loadRatio(speed, e.source.physics.windResistance * e.strength);
      if (atm) e.loadRatio *= rho / AIR_DENSITY;
      // Residual strength (Phase 15): earthquake / flood damage lowers the capacity the wind
      // load is compared with (load ∝ v², capacity × (1 − 0.3·D)). Exactly 1 without them.
      if (interactions && (e.seismic || e.flood)) e.loadRatio /= residualStrength(e, 'wind');
      // Modular buildings (Phase 17): failed members lower the lateral capacity (any hazard).
      // A partial collapse leaves less building to catch the wind (load ∝ exposed area).
      if (e.modular !== undefined && !e.flags.collapsed && (e.modular.reserve < 1 || e.modular.windShare < 1)) e.loadRatio *= e.modular.windShare / e.modular.reserve;
      if (e.loadRatio > e.peakLoadRatio) e.peakLoadRatio = e.loadRatio;
      if (speed > 0.05) {
        const inv = 1 / speed;
        dirW[0] = v[0] * inv;
        dirW[1] = v[1] * inv;
        dirW[2] = v[2] * inv;
        const areaW = e.source.physics.frontalAreaOverride ?? boxProjectedArea(e.dims, qRotateInto(local, conjInto(e.pose.quaternion), dirW)) * e.areaFactor;
        e.windLoad = 0.5 * rho * e.source.physics.dragCoefficient * areaW * speed * speed * WIND_FORCE_SCALE;
      } else e.windLoad = 0;

      if (calm || !e.dynamic || e.body === null) continue;
      // Phase 35: a wheeled vehicle's air drag (relative to this local wind) is the vehicle model's — one 'wind' claim.
      if (e.vehicle?.level === 'vehicle') continue;
      const vRel = vSub(v, physics.getLinearVelocity(e.body));
      const rel = vLen(vRel);
      if (rel < 0.05) continue;
      const dir = vScale(vRel, 1 / rel);
      // Silhouette area for the current orientation (a toppled car presents its roof, etc.).
      let area = (e.source.physics.frontalAreaOverride ?? boxProjectedArea(e.dims, qRotate(conj(e.pose.quaternion), dir)) * e.areaFactor);
      // Wind + flood (Phase 15 interaction): only the part above the water catches the wind —
      // the submerged part gets the water drag instead (WaterForceSystem). No double loading.
      if (interactions && e.flood && e.flood.submerged > 0) area *= 1 - e.flood.submerged;
      const f = 0.5 * rho * e.source.physics.dragCoefficient * area * rel * rel * WIND_FORCE_SCALE;
      forces.forceAtPoint('wind', e.body, vScale(dir, f), cop, e);
    }

    if (calm) return;
    for (const d of runtime.debris) {
      const v = field.sample(d.pose.position, time, undefined, undefined, debrisWind).velocity;
      if (atm) {
        const q = d.pose.position;
        atm.flowAt(q[0], q[2], q[1] - env.terrain.sampleHeight(q[0], q[2]), flow);
        v[0] += flow[0]; v[2] += flow[1];
        rho = atm.densityAt(q[0], q[1], q[2]);
      }
      const vRel = vSub(v, physics.getLinearVelocity(d.body));
      const rel = vLen(vRel);
      if (rel < 0.05) continue;
      const dir = vScale(vRel, 1 / rel);
      const area = boxProjectedArea(d.size, qRotate(conj(d.pose.quaternion), dir));
      const f = 0.5 * rho * DEBRIS_CD * area * rel * rel * WIND_FORCE_SCALE;
      const force = vScale(dir, f);
      if (d.plate) force[1] += f * PLATE_LIFT * Math.min(1, Math.max(0, 1 - env.terrain.heightAboveGround(d.pose.position) / 60));
      forces.forceAtPoint('wind', d.body, force, d.pose.position, d);
    }
  }
}
