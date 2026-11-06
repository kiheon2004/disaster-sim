import type { SimulationSystem, SystemContext } from './SimulationSystem';
import type { MetricsRecorder } from '../analysis/MetricsRecorder';
import { DamageState, DAMAGE_STATE_IDS } from '../damage/DamageState';
import { hazardDamage, recordStateChange } from '../interactions/integrity';
import { HAZARDS, type Hazard } from '../analysis/DamageEvent';
import type { RuntimeEntity } from '../SimulationRuntime';

/** The hazard whose channel has done the most damage to the object (null when none has). */
function damagingHazard(e: RuntimeEntity): Hazard | null {
  const d = hazardDamage(e);
  let best: Hazard | null = null, max = 0;
  for (const h of HAZARDS) { const v = d[h] ?? 0; if (v > max) { max = v; best = h; } }
  return best;
}

/**
 * Runs last: tracks peak states (recording a state-change event when no more specific event was
 * recorded for that entity this step) and samples wind statistics.
 */
export class MetricsSystem implements SimulationSystem {
  readonly name = 'metrics';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['damage', 'water', 'structure', 'airflow'] as const;
  readonly writes = ['metrics'] as const;

  constructor(private readonly metrics: MetricsRecorder) {}

  update(ctx: SystemContext, dt: number) {
    for (const e of ctx.runtime.entities.values()) {
      if (e.def.inert || e.state <= e.peakState) continue;
      const prev = e.peakState;
      e.peakState = e.state;
      // Ordered damage history per object (Phase 15; bookkeeping only).
      if (e.state >= DamageState.STRESSED && this.metrics.recordedThisStep(e.id)) recordStateChange(e, ctx.time, e.lastHazard ?? (e.loadRatio < 0.3 ? damagingHazard(e) : null) ?? 'wind', e.state);
      if (e.state >= DamageState.DAMAGED && prev < e.state && !this.metrics.recordedThisStep(e.id)) {
        // Without a specific earlier event: the earthquake when the object shakes harder than
        // the wind loads it (wind-only runs never have seismic state → always wind).
        const quake = !e.lastHazard && e.seismic !== undefined && (e.seismic.shake > 0 || e.seismic.damage > 0) && e.loadRatio < 0.3;
        // Flood (Phase 14): the flood channel caused it when it is the damaged one (dry runs: never).
        const flood = !e.lastHazard && !quake && e.flood !== undefined && e.flood.health < 1 && e.loadRatio < 0.3;
        // Otherwise the channel that has actually done damage (Phase 22: never 'wind' by default
        // when another hazard is the only one that damaged the object).
        const hazard = e.lastHazard ?? (quake ? 'earthquake' : flood ? 'flood' : e.loadRatio < 0.3 ? damagingHazard(e) ?? 'wind' : 'wind');
        recordStateChange(e, ctx.time, hazard, e.state);
        ctx.recordDamage(e, {
          eventType: DAMAGE_STATE_IDS[e.state] as 'DAMAGED' | 'CRITICAL' | 'DESTROYED',
          cause: e.lastCause ?? (hazard === 'blast' ? 'blast' : hazard === 'earthquake' ? (e.source.type === 'building' ? 'drift' : 'shaking') : hazard === 'flood' ? 'inundation' : hazard === 'ground' ? 'foundation' : e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue'),
          hazard,
          source: hazard === 'ground' ? e.ground?.source : hazard === 'blast' ? e.blast?.source : undefined,
        });
      }
    }
    this.metrics.sample(ctx.env as never, ctx.runtime, dt);
  }
}
