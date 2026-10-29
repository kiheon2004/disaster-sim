import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { responses } from '../response/responses';

/**
 * Earthquake damage evaluation (postPhysics, after StructuralResponseSystem and before the
 * DamageSystem, which folds the results into the shared NORMAL … DESTROYED states).
 * See damage/behaviors/seismic.ts for the criteria. Idle without an earthquake.
 */
export class SeismicDamageSystem implements SimulationSystem {
  readonly name = 'seismicDamage';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['structure', 'poses'] as const;
  readonly writes = ['damage', 'debris'] as const;
  /** Phase 25: structural collapse of a step is resolved later in it (StructuralCollapseSystem) — seen on the next step. */
  readonly lagged = ['structure'] as const;

  isActive(ctx: SystemContext) {
    const sr = ctx.runtime.seismic;
    return sr !== undefined && (ctx.env.groundMotion.active || ctx.env.blast.loading || sr.freeVibration > 0);
  }

  update(ctx: SystemContext, dt: number) {
    const sr = ctx.runtime.seismic;
    if (!sr || (!ctx.env.groundMotion.active && !ctx.env.blast.loading && sr.freeVibration <= 0)) return;
    // Object responses to the groundMotion channel (response/responses.ts), in entity order.
    for (const e of sr.entities) responses.respond('groundMotion', e, ctx, dt);
  }
}
