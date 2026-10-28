import type { SimulationSystem, SystemContext } from './SimulationSystem';
import type { MetricsRecorder } from '../analysis/MetricsRecorder';
import { DamageState, DAMAGE_STATE_IDS } from '../damage/DamageState';

/**
 * Runs last: tracks peak states (recording a state-change event when no more specific event was
 * recorded for that entity this step) and samples wind statistics.
 */
export class MetricsSystem implements SimulationSystem {
  readonly name = 'metrics';
  readonly phase = 'postPhysics' as const;

  constructor(private readonly metrics: MetricsRecorder) {}

  update(ctx: SystemContext, dt: number) {
    for (const e of ctx.runtime.entities.values()) {
      if (e.def.inert || e.state <= e.peakState) continue;
      const prev = e.peakState;
      e.peakState = e.state;
      if (e.state >= DamageState.DAMAGED && prev < e.state && !this.metrics.recordedThisStep(e.id)) {
        ctx.recordDamage(e, {
          eventType: DAMAGE_STATE_IDS[e.state] as 'DAMAGED' | 'CRITICAL' | 'DESTROYED',
          cause: e.lastCause ?? (e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue'),
        });
      }
    }
    this.metrics.sample(ctx.env as never, ctx.runtime, dt);
  }
}
