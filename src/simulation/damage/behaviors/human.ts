import { vScale } from '@/core/math';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { applyFatigue, healthLevel, loadLevel } from '../fatigue';

/** Load ratio at which a standing person is knocked over immediately (gust). */
const KNOCKDOWN_RATIO = 1.0;

export function knockDown(e: RuntimeEntity, ctx: SystemContext, reason: 'wind' | 'impact' | 'earthquake', impactForce?: number, dir?: [number, number, number]) {
  if (e.flags.fallen || !e.dynamic || e.body === null) return;
  e.flags.fallen = true;
  e.rev++;
  const { physics } = ctx;
  // Fall along the LOCAL wind direction (earthquake: along the inertial push of the ground).
  const v = e.localWind.velocity;
  const sp = Math.hypot(v[0], v[2]);
  const flow: [number, number, number] = dir ?? (sp > 0.5 ? [v[0] / sp, 0, v[2] / sp] : ctx.env.wind.baseSpeed > 0.5 ? ctx.env.wind.flow() : [1, 0, 0]);
  physics.setRotationsLocked(e.body, false);
  // Tip over downwind: angular impulse about the horizontal axis ⟂ flow, plus a shove.
  const m = e.source.physics.mass;
  physics.applyTorqueImpulse(e.body, vScale([flow[2], 0, -flow[0]], m * 0.55));
  physics.applyImpulse(e.body, vScale(flow, m * 0.6));
  if (reason === 'earthquake') {
    ctx.log(e.id, 'danger', { key: 'log.quake.personFell' });
    ctx.recordDamage(e, { eventType: 'FALLEN', cause: 'shaking', hazard: 'earthquake', localWindSpeed: e.localWind.speed });
    return;
  }
  ctx.log(e.id, 'danger', { key: reason === 'wind' ? 'log.human.fallen' : 'log.human.hit' });
  ctx.recordDamage(e, {
    eventType: reason === 'wind' ? 'FALLEN' : 'IMPACT',
    cause: reason === 'impact' ? 'impact' : e.loadRatio >= KNOCKDOWN_RATIO ? 'overload' : 'fatigue',
    force: impactForce,
    hazard: reason === 'impact' ? (e.lastHazard ?? 'wind') : 'wind',
  });
}

export function updateHuman(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  const p = e.source.physics;
  e.health = applyFatigue(e.health, e.loadRatio, p.durability, Infinity, dt);
  if (!e.flags.fallen && (e.loadRatio >= KNOCKDOWN_RATIO || e.health < 0.6)) knockDown(e, ctx, 'wind');

  let s = worst(loadLevel(e.loadRatio), healthLevel(e.health));
  if (e.flags.fallen) s = worst(s, DamageState.CRITICAL);
  else if (e.seismic && e.seismic.balance < 0.7) s = worst(s, DamageState.STRESSED);
  // People are never shown as "destroyed".
  e.state = Math.min(s, DamageState.CRITICAL) as DamageState;
}
