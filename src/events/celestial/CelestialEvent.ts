/**
 * Celestial-gravity experiment (Phase 32). Like every event it only WRITES its channel: at its start the experiment's
 * point sources are registered in the gravity channel's field (added after the Phase 31 composition — one field, no
 * second gravity engine); the GravitySystem and every gravity-dependent system read the field from then on.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { CelestialSpec } from '@/celestial/types';
import { G_N } from '@/celestial/constants';

export class CelestialEvent implements SimulationEvent<CelestialSpec> {
  readonly id = createId('evt');
  readonly type = 'celestial' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: CelestialSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
    this.channel = `gravity:${this.id}`;
  }

  onStart({ env }: EventContext) {
    env.gravity.addCelestial(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  /** Timeline intensity: 1 while a source is in force (ramped), 0 otherwise. */
  intensityAt(t: number): number {
    let v = 0;
    for (const s of this.spec.sources) {
      const on = s.start ?? 0, off = s.end ?? this.spec.duration;
      if (t < on || (this.spec.end === 'restore' && t >= off)) continue;
      const r = s.ramp ?? 0;
      v = Math.max(v, r > 0 ? Math.min(1, (t - on) / r) : 1);
    }
    return v;
  }

  describe(): I18nMessage {
    return describeCelestial(this.spec);
  }
}

export function describeCelestial(s: CelestialSpec): I18nMessage {
  const m = s.sources[0]?.mass ?? 0;
  return { key: `event.celestial.${s.scenario}` as I18nMessage['key'], params: { m: m.toExponential(2), mu: (G_N * m).toExponential(2), n: String(s.sources.length), d: s.duration.toFixed(0) } };
}
