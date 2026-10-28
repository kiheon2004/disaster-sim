import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { ensureFloodRuntime } from '../flood/FloodState';
import {
  updateBuildingFlood, updateCarFlood, updateExposureOnly, updateInfraFlood, updatePersonFlood, updateRoadFlood,
} from '../damage/behaviors/flood';

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

  update(ctx: SystemContext, dt: number) {
    const field = ctx.env.flood.field;
    if (!field) return;
    const fr = ensureFloodRuntime(ctx.runtime);
    const rdt = dt * FLOOD_ROUNDS;
    const list = fr.entities;
    for (let i = ctx.step % FLOOD_ROUNDS; i < list.length; i += FLOOD_ROUNDS) {
      const e = list[i];
      switch (e.source.type) {
        case 'building':
          updateBuildingFlood(e, ctx, field, rdt);
          break;
        case 'car':
          updateCarFlood(e, ctx, field, rdt);
          break;
        case 'human':
          updatePersonFlood(e, ctx, field, rdt);
          break;
        case 'streetLight':
        case 'sign':
        case 'wall':
          updateInfraFlood(e, ctx, field, rdt);
          break;
        case 'road':
          updateRoadFlood(e, ctx, field, rdt);
          break;
        default:
          updateExposureOnly(e, field, rdt);
      }
    }
  }
}
