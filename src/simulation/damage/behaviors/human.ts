import { vScale } from '@/core/math';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { applyFatigue, healthLevel, loadLevel } from '../fatigue';

/** Load ratio at which a standing person is knocked over immediately (gust). */
const KNOCKDOWN_RATIO = 1.0;

export function knockDown(e: RuntimeEntity, ctx: SystemContext, reason: 'wind' | 'impact') {
  if (e.flags.fallen || !e.dynamic || e.body === null) return;
  e.flags.fallen = true;
  e.rev++;
  const { physics, env } = ctx;
  const flow = env.wind.baseSpeed > 0.5 ? env.wind.flow() : ([1, 0, 0] as [number, number, number]);
  physics.setRotationsLocked(e.body, false);
  // Tip over downwind: angular impulse about the horizontal axis ⟂ flow, plus a shove.
  const m = e.source.physics.mass;
  physics.applyTorqueImpulse(e.body, vScale([flow[2], 0, -flow[0]], m * 0.55));
  physics.applyImpulse(e.body, vScale(flow, m * 0.6));
  ctx.log(e.id, 'danger', { key: reason === 'wind' ? 'log.human.fallen' : 'log.human.hit' });
}

export function updateHuman(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  const p = e.source.physics;
  e.health = applyFatigue(e.health, e.loadRatio, p.durability, Infinity, dt);
  if (!e.flags.fallen && (e.loadRatio >= KNOCKDOWN_RATIO || e.health < 0.6)) knockDown(e, ctx, 'wind');

  let s = worst(loadLevel(e.loadRatio), healthLevel(e.health));
  if (e.flags.fallen) s = worst(s, DamageState.CRITICAL);
  // People are never shown as "destroyed".
  e.state = Math.min(s, DamageState.CRITICAL) as DamageState;
}
