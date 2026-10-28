import type { Vec3 } from '@/core/types';
import { qRotate, vAdd, vLen, vScale, vSub } from '@/core/math';
import { AIR_DENSITY, WIND_FORCE_SCALE } from '@/core/units';
import { boxProjectedArea, loadRatio } from '../damage/windLoad';
import type { SimulationSystem, SystemContext } from './SimulationSystem';

const conj = (q: [number, number, number, number]): [number, number, number, number] => [-q[0], -q[1], -q[2], q[3]];

/** Plates (roof panels, signs) generate lift when tumbling through the air. */
const PLATE_LIFT = 0.45;
const DEBRIS_CD = 1.15;

/**
 * Aerodynamic loading (prePhysics):
 *  - samples the wind field at each object's center of pressure,
 *  - records the load ratio for the damage system,
 *  - applies drag F = ½ρ·Cd·A·|v_rel|²  at the pressure center of every dynamic body
 *    (so tipping torque and sliding emerge from the rigid-body solver).
 */
export class WindForceSystem implements SimulationSystem {
  readonly name = 'windForce';
  readonly phase = 'prePhysics' as const;

  update({ env, runtime, physics, time }: SystemContext) {
    const field = env.windField;
    const rho = env.airDensity || AIR_DENSITY;
    const calm = env.wind.baseSpeed <= 0.01;

    for (const e of runtime.entities.values()) {
      if (e.def.inert) continue;
      const cop: Vec3 = vAdd(e.pose.position, qRotate(e.pose.quaternion, e.copLocal));
      // Local wind from the spatial field (an object never sits in its own wake).
      // Static objects reuse their obstacle effect until the wind turns.
      const lw = field.sample(cop, time, e.id, e.dynamic ? undefined : e.windCache);
      e.localWind = lw;
      const v = lw.velocity;
      const speed = lw.speed;
      e.windAtCop = speed;
      e.loadRatio = loadRatio(speed, e.source.physics.windResistance * e.strength);
      if (e.loadRatio > e.peakLoadRatio) e.peakLoadRatio = e.loadRatio;
      if (speed > 0.05) {
        const dirW = vScale(v, 1 / speed);
        const areaW = e.source.physics.frontalAreaOverride ?? boxProjectedArea(e.dims, qRotate(conj(e.pose.quaternion), dirW)) * e.areaFactor;
        e.windLoad = 0.5 * rho * e.source.physics.dragCoefficient * areaW * speed * speed * WIND_FORCE_SCALE;
      } else e.windLoad = 0;

      if (calm || !e.dynamic || e.body === null) continue;
      const vRel = vSub(v, physics.getLinearVelocity(e.body));
      const rel = vLen(vRel);
      if (rel < 0.05) continue;
      const dir = vScale(vRel, 1 / rel);
      // Silhouette area for the current orientation (a toppled car presents its roof, etc.).
      const area = (e.source.physics.frontalAreaOverride ?? boxProjectedArea(e.dims, qRotate(conj(e.pose.quaternion), dir)) * e.areaFactor);
      const f = 0.5 * rho * e.source.physics.dragCoefficient * area * rel * rel * WIND_FORCE_SCALE;
      physics.addForceAtPoint(e.body, vScale(dir, f), cop);
    }

    if (calm) return;
    for (const d of runtime.debris) {
      const v = field.velocityAt(d.pose.position, time);
      const vRel = vSub(v, physics.getLinearVelocity(d.body));
      const rel = vLen(vRel);
      if (rel < 0.05) continue;
      const dir = vScale(vRel, 1 / rel);
      const area = boxProjectedArea(d.size, qRotate(conj(d.pose.quaternion), dir));
      const f = 0.5 * rho * DEBRIS_CD * area * rel * rel * WIND_FORCE_SCALE;
      const force = vScale(dir, f);
      if (d.plate) force[1] += f * PLATE_LIFT * Math.min(1, Math.max(0, 1 - d.pose.position[1] / 60));
      physics.addForceAtPoint(d.body, force, d.pose.position);
    }
  }
}
