import { qRotate } from '@/core/math';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { healthLevel, loadLevel } from '../fatigue';
import { floodLevel } from '../floodLevels';
import { pushHazard } from '../../flood/FloodState';
import type { DamageCause } from '../../analysis/DamageEvent';

export function updateCar(e: RuntimeEntity, ctx: SystemContext) {
  // Flood (Phase 14): when the water dominated the push, blame it (undefined in dry runs).
  const flood = pushHazard(e);
  const pushCause: DamageCause = e.lastCause === 'impact' ? 'impact' : flood ? (e.flood!.buoyancyRatio >= 1 ? 'buoyancy' : 'hydrodynamic') : 'push';
  const up = qRotate(e.pose.quaternion, [0, 1, 0]);
  if (!e.flags.overturned && up[1] < 0.35) {
    e.flags.overturned = true;
    e.rev++;
    ctx.log(e.id, 'danger', { key: 'log.car.overturned' });
    ctx.recordDamage(e, { eventType: 'OVERTURNED', cause: pushCause, hazard: flood });
  }
  if (e.displacement > 1 && !e.counters.movedLogged) {
    e.counters.movedLogged = 1;
    ctx.log(e.id, 'warn', { key: flood ? 'log.flood.carMoved' : 'log.car.moved' });
    ctx.recordDamage(e, { eventType: 'MOVED', cause: pushCause, hazard: flood });
  }
  let s = worst(loadLevel(e.loadRatio), healthLevel(e.health));
  if (e.displacement > 1) s = worst(s, DamageState.DAMAGED);
  if (e.flags.overturned) s = worst(s, DamageState.CRITICAL);
  if (e.flood) s = worst(s, floodLevel(e.flood));
  e.state = s;
}
