import type { SimulationSystem, SystemContext } from './SimulationSystem';

/** Copies body poses from the physics engine into runtime entities and debris. */
export class PoseSyncSystem implements SimulationSystem {
  readonly name = 'poseSync';
  readonly phase = 'postPhysics' as const;

  update({ runtime, physics }: SystemContext) {
    for (const e of runtime.entities.values()) {
      if (!e.dynamic || e.body === null) continue;
      e.pose = physics.getPose(e.body);
      const dx = e.pose.position[0] - e.initialPose.position[0];
      const dz = e.pose.position[2] - e.initialPose.position[2];
      e.displacement = Math.hypot(dx, dz);
    }
    for (const d of runtime.debris) d.pose = physics.getPose(d.body);
  }
}
