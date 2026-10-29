/**
 * Gravity experiment (Phase 31). Like every event it only WRITES its channel: at its start the experiment is
 * registered in the gravity channel (the field composes it with the project gravity and any other experiment); the
 * GravitySystem and every gravity-dependent system read the field from then on. Its duration is the experiment window.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { GravitySpec } from '@/gravity/types';
import { EARTH_G } from '@/gravity/types';
import { experimentBlend, globalVector } from '@/gravity/field';

export class GravityEvent implements SimulationEvent<GravitySpec> {
  readonly id = createId('evt');
  readonly type = 'gravity' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: GravitySpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
    this.channel = `gravity:${this.id}`;
  }

  onStart({ env }: EventContext) {
    env.gravity.add(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  /** Timeline intensity: the departure of |g| from Earth gravity (per 1 g), local sources count as full. */
  intensityAt(t: number): number {
    const b = experimentBlend({ id: '', spec: this.spec, start: 0 }, t) ?? 0;
    if (!this.spec.global) return Math.min(1, Math.abs(b));
    const v = globalVector(this.spec, [0, -EARTH_G, 0], b, [0, 0, 0]);
    const dx = v[0], dy = v[1] + EARTH_G, dz = v[2];
    return Math.min(1, Math.hypot(dx, dy, dz) / EARTH_G);
  }

  describe(): I18nMessage {
    return describeGravity(this.spec);
  }
}

export function describeGravity(s: GravitySpec): I18nMessage {
  return { key: `event.gravity.${s.scenario}` as I18nMessage['key'], params: { g: s.magnitude.toFixed(2), x: (s.magnitude / EARTH_G).toFixed(2), d: s.duration.toFixed(0), n: String(s.sources.length) } };
}
