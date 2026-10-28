import { qRotate } from '@/core/math';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { healthLevel, loadLevel } from '../fatigue';

export function updateCar(e: RuntimeEntity, ctx: SystemContext) {
  const up = qRotate(e.pose.quaternion, [0, 1, 0]);
  if (!e.flags.overturned && up[1] < 0.35) {
    e.flags.overturned = true;
    e.rev++;
    ctx.log(e.id, 'danger', { key: 'log.car.overturned' });
    ctx.recordDamage(e, { eventType: 'OVERTURNED', cause: e.lastCause === 'impact' ? 'impact' : 'push' });
  }
  if (e.displacement > 1 && !e.counters.movedLogged) {
    e.counters.movedLogged = 1;
    ctx.log(e.id, 'warn', { key: 'log.car.moved' });
    ctx.recordDamage(e, { eventType: 'MOVED', cause: e.lastCause === 'impact' ? 'impact' : 'push' });
  }
  let s = worst(loadLevel(e.loadRatio), healthLevel(e.health));
  if (e.displacement > 1) s = worst(s, DamageState.DAMAGED);
  if (e.flags.overturned) s = worst(s, DamageState.CRITICAL);
  e.state = s;
}
