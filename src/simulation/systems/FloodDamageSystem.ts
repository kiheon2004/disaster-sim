import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { ensureFloodRuntime } from '../flood/FloodState';
import { responses } from '../response/responses';

/** Objects are evaluated in staggered rounds (each every ROUNDS steps with ROUNDS × dt): 20 Hz. */
export const FLOOD_ROUNDS = 3;

/**
 * Flood damage evaluation (Phase 14, postPhysics — after the earthquake damage and before the
 * DamageSystem, which folds `e.flood.health` / floodLevel() into the shared states with worst()).
 * See damage/behaviors/flood.ts for the criteria. Idle until the water model is active.
 */
export class FloodDamageSystem implements SimulationSystem {
  readonly name = 'floodDamage';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['water', 'poses', 'structure'] as const;
  readonly writes = ['damage', 'debris', 'exposure'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.flood.field !== null;
  }

  update(ctx: SystemContext, dt: number) {
    const field = ctx.env.flood.field;
    if (!field) return;
    const fr = ensureFloodRuntime(ctx.runtime);
    const rdt = dt * FLOOD_ROUNDS;
    const list = fr.entities;
    for (let i = ctx.step % FLOOD_ROUNDS; i < list.length; i += FLOOD_ROUNDS) {
      // Object responses to the water channel (response/responses.ts).
      responses.respond('water', list[i], ctx, rdt);
    }
  }
}
