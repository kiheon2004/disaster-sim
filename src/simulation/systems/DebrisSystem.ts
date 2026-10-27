import type { SimulationSystem, SystemContext } from './SimulationSystem';

const OUT_OF_WORLD = 800;

/** Housekeeping for rigid debris: removes pieces that left the world. */
export class DebrisSystem implements SimulationSystem {
  readonly name = 'debris';
  readonly phase = 'postPhysics' as const;

  update({ runtime, physics }: SystemContext) {
    const before = runtime.debris.length;
    runtime.debris = runtime.debris.filter((d) => {
      const [x, y, z] = d.pose.position;
      const out = y < -30 || Math.abs(x) > OUT_OF_WORLD || Math.abs(z) > OUT_OF_WORLD;
      if (out) physics.removeBody(d.body);
      return !out;
    });
    if (runtime.debris.length !== before) runtime.debrisRev++;
  }
}
