import { qRotate } from '@/core/math';
import { GRAVITY } from '@/core/units';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { healthLevel } from '../fatigue';
import { pushHazard } from '../../flood/FloodState';
import { pushedByBlast, pushedByImpact, pushedBySediment } from '../../forces/ForceLedger';
import { HAZARDS, type DamageCause, type Hazard } from '../../analysis/DamageEvent';

/**
 * Phase 35 Level 1 passive objects (crate, barrel, container, furniture, road barrier, ball): events only — the motion
 * is Rapier's answer to the existing hazard forces. MOVED (> 1 m) and TOPPLED (body up-axis below 0.35, not for a ball)
 * once each, with the car's cause attribution; state from health (contact impacts, see passiveImpact) — a broken
 * object (health 0) is DESTROYED and reported once as BROKEN. No new physics: a broken crate stays one rigid body.
 */
export function updatePassiveObject(e: RuntimeEntity, ctx: SystemContext) {
  const { hazard, cause } = attribution(e, ctx);
  if (e.def.passive?.toppleEvent && !e.flags.toppled && qRotate(e.pose.quaternion, [0, 1, 0])[1] < 0.35) {
    e.flags.toppled = true;
    e.rev++;
    ctx.log(e.id, 'warn', { key: 'log.dynamicObject.toppled' });
    ctx.recordDamage(e, { eventType: 'TOPPLED', cause, hazard });
  }
  if (e.displacement > 1 && !e.counters.movedLogged) {
    e.counters.movedLogged = 1;
    ctx.log(e.id, 'info', { key: 'log.dynamicObject.moved' });
    ctx.recordDamage(e, { eventType: 'MOVED', cause, hazard });
  }
  e.state = worst(DamageState.NORMAL, healthLevel(e.health));
}

/** What pushed the object (same chain and precedence as cars: water > ejecta > blast > sediment > fragment > afloat > shaking > wind). */
function attribution(e: RuntimeEntity, ctx: SystemContext): { hazard: Hazard | undefined; cause: DamageCause } {
  const water = pushHazard(e);
  const hit = !water && pushedByImpact(e, ctx.forces.step);
  const blast = !water && !hit && pushedByBlast(e, ctx.forces.step);
  const ground = !water && !hit && !blast && (pushedBySediment(e, ctx.forces.step) || (e.ground !== undefined && e.localWind.speed < 1));
  const frag = !water && !hit && !blast && !ground && e.counters.fragStep !== undefined && ctx.step - e.counters.fragStep < 120 && e.localWind.speed < 1 ? HAZARDS[e.counters.fragHazard] : undefined;
  const afloat = !water && !hit && !blast && !ground && !frag && e.localWind.speed < 1 && (e.flood?.submerged ?? 0) > 0;
  const shaken = !water && !hit && !blast && !ground && !frag && !afloat && e.localWind.speed < 1 && (e.seismic?.pga ?? 0) > 0;
  const hazard: Hazard | undefined = water ?? (hit ? 'impact' : blast ? 'blast' : ground ? 'ground' : frag ?? (afloat ? 'flood' : shaken ? 'earthquake' : undefined));
  const cause: DamageCause = e.lastCause === 'impact' || frag ? 'impact' : hit ? 'ejecta' : blast ? 'blast' : ground ? 'debris' : shaken ? 'shaking' : water || afloat ? (e.flood!.buoyancyRatio >= 1 ? 'buoyancy' : 'hydrodynamic') : 'push';
  return { hazard, cause };
}

/**
 * Contact damage of a passive object (DamageSystem.impact): a contact force F costs F / (m·g·factor) of health
 * (factor per type / material: furniture 8 … container 60; a ball never breaks). Below 2 % per strike nothing happens;
 * from 5 % an IMPACT event (once per strike episode); at zero health one BROKEN event. Returns the damage fraction.
 */
export interface StrikeHooks {
  /** Health decrement of this strike (per-episode peak in modular scenes) and whether it is the episode's first report. */
  episode(dmg: number): { inc: number; first: boolean };
  /** Hazard behind the striker. */
  hazard(): Hazard;
  /** A fragment strike is recorded by the structural engine instead (secondary attribution). */
  strike?(dmg: number): void;
  /** The IMPACT event of this episode was recorded. */
  recorded?(): void;
}

export function passiveImpact(e: RuntimeEntity, ctx: SystemContext, force: number, hooks: StrikeHooks): number {
  const factor = e.def.passive!.impactFactor(e.source.params);
  if (!Number.isFinite(factor)) return 0;
  const dmg = force / (e.source.physics.mass * GRAVITY * factor);
  if (dmg <= 0.02 || e.health <= 0) return dmg;
  const before = e.health;
  const ep = hooks.episode(dmg);
  e.health = Math.max(0, e.health - ep.inc);
  e.lastCause = 'impact';
  if (hooks.strike) hooks.strike(dmg);
  else if (dmg > 0.05 && ep.first) {
    hooks.recorded?.();
    ctx.recordDamage(e, { eventType: 'IMPACT', cause: 'impact', force, damageBefore: 1 - before, damageAfter: 1 - e.health, hazard: hooks.hazard() });
  }
  if (!e.counters.hitLogged && dmg > 0.05) {
    e.counters.hitLogged = 1;
    ctx.log(e.id, 'warn', { key: 'log.dynamicObject.hit' });
  }
  if (e.health <= 0 && !e.counters.broken) {
    e.counters.broken = 1;
    e.rev++;
    ctx.log(e.id, 'danger', { key: 'log.dynamicObject.broken' });
    ctx.recordDamage(e, { eventType: 'BROKEN', cause: 'impact', force, damageBefore: 1 - before, damageAfter: 1, hazard: hooks.hazard() });
  }
  return dmg;
}
