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
  onStart?(ctx: EventContext): void;
  update(ctx: EventContext, localTime: number, dt: number): void;
  onEnd?(ctx: EventContext, reason: 'finished' | 'superseded'): void;
  /** Planned intensity 0–1 at a local time, for drawing on the timeline. */
  intensityAt(localTime: number): number;
  /** Optional planned signal (e.g. ground acceleration in g) sampled `n` times over the duration. */
  waveform?(n: number): number[];
  describe(): I18nMessage;
}
