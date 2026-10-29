/**
 * Atmosphere experiment (Phase 29). Like every event it only WRITES its channel: at its start the
 * experiment is registered in the atmosphere channel; the ThermalSystem builds the atmosphere state
 * (or rejects a second experiment with a reason) and the column-mass model does the rest. Its duration
 * covers the scheduled removal / restoration.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { AtmosphereSpec } from '@/atmosphere/types';
import { atmosphereDuration, plannedShare } from '@/atmosphere/schedule';
import { isa } from '@/atmosphere/reference';

export class AtmosphereEvent implements SimulationEvent<AtmosphereSpec> {
  readonly id = createId('evt');
  readonly type = 'atmosphere' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: AtmosphereSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = atmosphereDuration(spec);
    this.channel = `atmosphere:${this.id}`;
  }

  onStart({ env }: EventContext) {
    env.atmosphere.add(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  /** Planned share of the initial air mass removed (0 … 1) — the timeline's intensity. */
  intensityAt(t: number): number {
    return 1 - plannedShare(this.spec, t);
  }

  describe(): I18nMessage {
    return describeAtmosphere(this.spec);
  }
}

/** Datum state of a spec (Pa, K): the given values or the ISA at its altitude. */
export function datumState(s: AtmosphereSpec): { p: number; T: number } {
  const ref = isa(s.altitude);
  return { p: s.pressure ?? ref.p, T: s.temperature ?? ref.T };
}

export function describeAtmosphere(s: AtmosphereSpec): I18nMessage {
  const { p, T } = datumState(s);
  const params = { p: (p / 1000).toFixed(1), T: (T - 273.15).toFixed(1), h: s.altitude.toFixed(0), tg: ((s.target ?? 1) * 100).toFixed(0), d: (s.duration ?? 0).toFixed(0) };
  if (s.removal === 'none') return { key: s.restore && s.restore !== 'none' ? 'event.atmosphere.describeRestore' : 'event.atmosphere.describe', params };
  return { key: s.extent === 'local' ? 'event.atmosphere.describeLocal' : 'event.atmosphere.describeRemoval', params };
}
