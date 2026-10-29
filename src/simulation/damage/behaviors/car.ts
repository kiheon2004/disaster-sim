import { qRotate } from '@/core/math';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { healthLevel, loadLevel } from '../fatigue';
import { floodLevel } from '../floodLevels';
import { pushHazard } from '../../flood/FloodState';
import { pushedByBlast, pushedByImpact, pushedBySediment } from '../../forces/ForceLedger';
import type { DamageCause } from '../../analysis/DamageEvent';

export function updateCar(e: RuntimeEntity, ctx: SystemContext) {
  // Flood (Phase 14): when the water dominated the push, blame it (undefined in dry runs).
  // Ground failure (Phase 22): carried by sediment (or on moving ground) with no stronger wind.
  // Impact (Phase 23): thrown by ejecta.
  const hit = !pushHazard(e) && pushedByImpact(e, ctx.forces.step) ? 'impact' as const : undefined;
  // Air-pressure wave (Phase 24): pushed by the wave's net load.
  const blast = !hit && !pushHazard(e) && pushedByBlast(e, ctx.forces.step) ? 'blast' as const : undefined;
  const ground = !hit && !blast && !pushHazard(e) && (pushedBySediment(e, ctx.forces.step) || (e.ground !== undefined && e.localWind.speed < 1)) ? 'ground' as const : undefined;
  // Shaking (Phase 23): moved by the ground motion (earthquake or impact shock — the recorder maps
  // it to the impact where the impact's peak governs), never by a calm wind.
  const shaken = !hit && !blast && !ground && !pushHazard(e) && e.localWind.speed < 1 && (e.seismic?.pga ?? 0) > 0 ? 'earthquake' as const : undefined;
  const flood = pushHazard(e) ?? hit ?? blast ?? ground ?? shaken;
  const pushCause: DamageCause = e.lastCause === 'impact' ? 'impact' : hit ? 'ejecta' : blast ? 'blast' : ground ? 'debris' : shaken ? 'shaking' : flood ? (e.flood!.buoyancyRatio >= 1 ? 'buoyancy' : 'hydrodynamic') : 'push';
  const up = qRotate(e.pose.quaternion, [0, 1, 0]);
  if (!e.flags.overturned && up[1] < 0.35) {
    e.flags.overturned = true;
    e.rev++;
    ctx.log(e.id, 'danger', { key: 'log.car.overturned' });
    ctx.recordDamage(e, { eventType: 'OVERTURNED', cause: pushCause, hazard: flood });
  }
  if (e.displacement > 1 && !e.counters.movedLogged) {
    e.counters.movedLogged = 1;
    ctx.log(e.id, 'warn', { key: hit ? 'log.impact.carMoved' : blast ? 'log.blast.carMoved' : ground ? 'log.ground.carMoved' : shaken ? 'log.car.moved' : flood ? 'log.flood.carMoved' : 'log.car.moved' });
    ctx.recordDamage(e, { eventType: 'MOVED', cause: pushCause, hazard: flood });
  }
  let s = worst(loadLevel(e.loadRatio), healthLevel(e.health));
  if (e.displacement > 1) s = worst(s, DamageState.DAMAGED);
  if (e.flags.overturned) s = worst(s, DamageState.CRITICAL);
  if (e.flood) s = worst(s, floodLevel(e.flood));
  e.state = s;
}
