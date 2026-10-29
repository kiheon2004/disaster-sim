/**
 * Fire scenario (Phase 27). Like every event it only WRITES its channel: at its start the ignition is
 * registered in the fire channel; the ThermalSystem applies it (lights the fuel in the ignition
 * sphere, or rejects it with a reason) and the combustion model does the rest.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { FireSpec } from '@/fire/types';

export class FireEvent implements SimulationEvent<FireSpec> {
  readonly id = createId('evt');
  readonly type = 'fire' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: FireSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
    // Several ignitions coexist (each its own channel).
    this.channel = `fire:${this.id}`;
  }

  onStart({ env }: EventContext) {
    env.fire.add(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  intensityAt(t: number): number {
    return t >= 0 && t < this.duration ? 1 : 0;
  }

  describe(): I18nMessage {
    return describeFire(this.spec);
  }
}

export function describeFire(s: FireSpec): I18nMessage {
  return { key: s.target ? 'event.fire.describeTarget' : 'event.fire.describe', params: { x: s.position[0].toFixed(0), z: s.position[1].toFixed(0), h: s.height.toFixed(1), r: s.radius.toFixed(1), d: s.duration } };
}
