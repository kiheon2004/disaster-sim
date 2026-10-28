import type { SimulationSystem, SystemContext } from './SimulationSystem';

/** Below these speeds (m/s, rad/s) a calm body on uneven ground may be resting… */
const REST_LINEAR = 0.15;
const REST_ANGULAR = 0.3;
/** …and it is, if it stays within REST_DRIFT (m) of where it was REST_STEPS (0.5 s) earlier. */
const REST_DRIFT = 0.03;
const REST_STEPS = 30;

/**
 * Copies body poses from the physics engine into runtime entities and debris.
 *
 * Uneven terrain: a rigid box (car chassis, fallen person) resting across non-coplanar
 * heightfield triangles can settle into a millimetre-scale contact limit cycle just above the
 * engine's sleep threshold and stay awake forever (≈3× physics cost on hilly stress scenes).
 * Such bodies are put to sleep after resting calmly for REST_STEPS; any wind force or contact
 * wakes them again. Decided from simulation state only (deterministic); never on flat terrain,
 * where the engine's own sleeping already works and results must stay bit-identical.
 */
export class PoseSyncSystem implements SimulationSystem {
  readonly name = 'poseSync';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['forces'] as const;
  readonly writes = ['poses'] as const;

  update({ runtime, physics, env }: SystemContext) {
    // Never put bodies to sleep while the ground shakes (they must keep feeling it).
    const settle = !env.terrain.flat && !env.groundMotion.active;
    for (const e of runtime.entities.values()) {
      if (!e.dynamic || e.body === null) continue;
      e.pose = physics.getPose(e.body);
      const dx = e.pose.position[0] - e.initialPose.position[0];
      const dz = e.pose.position[2] - e.initialPose.position[2];
      e.displacement = Math.hypot(dx, dz);
      if (!settle || e.loadRatio > 0.02 || physics.isSleeping(e.body)) {
        e.quietSteps = 0;
        continue;
      }
      const v = physics.getLinearVelocity(e.body);
      const w = physics.getAngularVelocity(e.body);
      const p = e.pose.position;
      const ref = e.restRef;
      if (Math.hypot(v[0], v[1], v[2]) < REST_LINEAR && Math.hypot(w[0], w[1], w[2]) < REST_ANGULAR) {
        if (e.quietSteps === 0) {
          ref[0] = p[0]; ref[1] = p[1]; ref[2] = p[2];
        }
        if (Math.hypot(p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]) > REST_DRIFT) e.quietSteps = 0;
        else if (++e.quietSteps >= REST_STEPS) {
          physics.sleep(e.body);
          e.quietSteps = 0;
        }
      } else e.quietSteps = 0;
    }
    for (const d of runtime.debris) d.pose = physics.getPose(d.body);
  }
}
