import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { updateHuman, knockDown } from '../damage/behaviors/human';
import { updateTree } from '../damage/behaviors/tree';
import { updateCar } from '../damage/behaviors/car';
import { updateBuilding } from '../damage/behaviors/building';
import { updateAnchoredStructure } from '../damage/behaviors/structure';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { BodyUserData } from '@/physics/PhysicsEngine';
import type { Hazard } from '../analysis/DamageEvent';

/**
 * Damage evaluation (postPhysics): fatigue, state transitions and per-type reactions,
 * plus impact damage from contact forces (debris hitting people and cars).
 */
export class DamageSystem implements SimulationSystem {
  readonly name = 'damage';
  readonly phase = 'postPhysics' as const;

  update(ctx: SystemContext, dt: number) {
    for (const e of ctx.runtime.entities.values()) {
      switch (e.source.type) {
        case 'human':
          updateHuman(e, ctx, dt);
          break;
        case 'tree':
          updateTree(e, ctx, dt);
          break;
        case 'car':
          updateCar(e, ctx);
          break;
        case 'building':
          updateBuilding(e, ctx, dt);
          break;
        case 'streetLight':
        case 'sign':
        case 'wall':
          updateAnchoredStructure(e, ctx, dt);
          break;
      }
    }
    this.processImpacts(ctx);
  }

  private processImpacts(ctx: SystemContext) {
    const events = ctx.physics.drainContactEvents();
    for (const ev of events) {
      this.impact(ctx, ev.a, ev.b, ev.force);
      this.impact(ctx, ev.b, ev.a, ev.force);
    }
  }

  /** Hazard behind the striking body: the debris' origin, or what last moved the entity. */
  private hazardOf(ctx: SystemContext, other: BodyUserData): Hazard {
    if (other.debrisId) {
      // Only earthquakes tag debris; wind-only runs never search (keeps them unchanged and cheap).
      if (!ctx.runtime.seismic) return 'wind';
      return ctx.runtime.debris.find((d) => d.id === other.debrisId)?.hazard ?? 'wind';
    }
    return ctx.runtime.entities.get(other.entityId)?.lastHazard ?? 'wind';
  }

  /** `target` was hit by `other` with the given contact force. */
  private impact(ctx: SystemContext, target: BodyUserData | null, other: BodyUserData | null, force: number) {
    if (!target || !other || target.debrisId) return;
    // Only moving things (debris or another entity) cause impact damage; ignore self-contacts.
    if (other.entityId === target.entityId && !other.debrisId) return;
    const e: RuntimeEntity | undefined = ctx.runtime.entities.get(target.entityId);
    if (!e) return;
    if (e.source.type === 'human') {
      if (force > 1200) {
        e.health = Math.max(0, e.health - force / 20000);
        e.lastCause = 'impact';
        if (!e.flags.fallen) {
          e.lastHazard = this.hazardOf(ctx, other);
          knockDown(e, ctx, 'impact', force);
        }
      }
    } else if (e.source.type === 'car') {
      const dmg = force / (e.source.physics.mass * 9.81 * 30);
      if (dmg > 0.02) {
        const before = e.health;
        e.health = Math.max(0, e.health - dmg);
        e.lastCause = 'impact';
        if (dmg > 0.05) ctx.recordDamage(e, { eventType: 'IMPACT', cause: 'impact', force, damageBefore: 1 - before, damageAfter: 1 - e.health, hazard: this.hazardOf(ctx, other) });
        if (!e.counters.hitLogged && dmg > 0.05) {
          e.counters.hitLogged = 1;
          ctx.log(e.id, 'warn', { key: 'log.car.hit' });
        }
      }
    }
  }
}
