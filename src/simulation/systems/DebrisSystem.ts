import type { SimulationSystem, SystemContext } from './SimulationSystem';

const OUT_OF_WORLD = 800;

/** Housekeeping for rigid debris: removes pieces that left the world. */
export class DebrisSystem implements SimulationSystem {
  readonly name = 'debris';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['debris', 'poses'] as const;
  readonly writes = ['debris'] as const;

  update({ runtime, physics, env }: SystemContext) {
    const before = runtime.debris.length;
    const floor = env.terrain.minHeight - 30;
    runtime.debris = runtime.debris.filter((d) => {
      const [x, y, z] = d.pose.position;
      const out = y < floor || Math.abs(x) > OUT_OF_WORLD || Math.abs(z) > OUT_OF_WORLD;
      if (out) physics.removeBody(d.body);
      return !out;
    });
    if (runtime.debris.length !== before) runtime.debrisRev++;
  }
}
