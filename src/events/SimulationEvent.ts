import type { I18nMessage } from '@/i18n/i18n';
import type { EnvironmentState } from '@/simulation/environment/EnvironmentState';
import type { EventSpec, EventType } from './specs';

export interface EventContext {
  /** Events only WRITE environmental fields — never objects directly. */
  env: EnvironmentState;
  time: number;
}

export interface SimulationEvent<TSpec extends EventSpec = EventSpec> {
  readonly id: string;
  readonly type: EventType;
  /** Events on the same channel replace each other (a new wind event supersedes the old one). */
  readonly channel: string;
  readonly spec: TSpec;
  readonly startTime: number;
  readonly duration: number;
  /**
   * Optional preparation when the event is scheduled (outside the simulation clock): expensive,
   * deterministic precomputation on the run's INITIAL terrain (Phase 24 residual: an impact's plan
   * used to be computed inside the step it started in). onStart reuses it only if it would get the
   * same inputs — the result is bit-identical either way.
   */
  prepare?(terrain: import('@/core/model').TerrainData): void;
  onStart?(ctx: EventContext): void;
  update(ctx: EventContext, localTime: number, dt: number): void;
  onEnd?(ctx: EventContext, reason: 'finished' | 'superseded'): void;
  /**
   * Phase 35.5 per-instance controls (optional — only sustained sources have them). `stop` ends the source early (what it
   * already did to the world stays); `pause` switches it off and `resume` back on, `shift` = total seconds paused so far
   * (the source continues from where it was). An instance released all at once (a blast wave, a meteor) has none.
   */
  stop?(ctx: EventContext): void;
  pause?(ctx: EventContext): void;
  resume?(ctx: EventContext, shift: number): void;
  /** Planned intensity 0–1 at a local time, for drawing on the timeline. */
  intensityAt(localTime: number): number;
  /** Optional planned signal (e.g. ground acceleration in g) sampled `n` times over the duration. */
  waveform?(n: number): number[];
  describe(): I18nMessage;
}
