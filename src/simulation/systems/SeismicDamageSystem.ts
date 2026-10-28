import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { updateBuildingQuake, updateInfraQuake, updatePersonQuake } from '../damage/behaviors/seismic';

/**
 * Earthquake damage evaluation (postPhysics, after StructuralResponseSystem and before the
 * DamageSystem, which folds the results into the shared NORMAL … DESTROYED states).
 * See damage/behaviors/seismic.ts for the criteria. Idle without an earthquake.
 */
export class SeismicDamageSystem implements SimulationSystem {
  readonly name = 'seismicDamage';
  readonly phase = 'postPhysics' as const;

  update(ctx: SystemContext, dt: number) {
    const sr = ctx.runtime.seismic;
    if (!sr || (!ctx.env.groundMotion.active && sr.freeVibration <= 0)) return;
    for (const e of sr.entities) {
      switch (e.source.type) {
        case 'building':
          updateBuildingQuake(e, ctx, sr.model, dt);
          break;
        case 'streetLight':
        case 'sign':
        case 'wall':
          if (e.seismic!.unit >= 0) updateInfraQuake(e, ctx, sr.model, dt);
          break;
        case 'human':
          if (ctx.env.groundMotion.active) updatePersonQuake(e, ctx, dt);
          break;
      }
    }
  }
}
