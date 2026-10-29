/**
 * Volcano scenario (Phase 28). Like every event it only WRITES its channel: at its start the eruption is
 * registered in the volcano channel; the ThermalSystem starts it in the volcano world (or rejects it with a
 * reason) and the lava, bomb, ash and heat models do the rest. Its duration is the eruption's — the lava
 * keeps flowing and cooling afterwards (the timeline's observation window adds the cooling time).
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { VolcanoSpec } from '@/volcano/types';
import { eruptionShape } from '@/volcano/eruption';

export class VolcanoEvent implements SimulationEvent<VolcanoSpec> {
  readonly id = createId('evt');
  readonly type = 'volcano' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: VolcanoSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
    this.channel = `volcano:${this.id}`;
  }

  onStart({ env }: EventContext) {
    env.volcano.add(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  intensityAt(t: number): number {
    return eruptionShape(this.spec, t);
  }

  describe(): I18nMessage {
    return describeVolcano(this.spec);
  }
}

export function describeVolcano(s: VolcanoSpec): I18nMessage {
  const v = s.vents[0];
  return {
    key: s.vents.length > 1 ? 'event.volcano.describeMulti' : v?.kind === 'fissure' ? 'event.volcano.describeFissure' : 'event.volcano.describe',
    params: { x: (v?.position[0] ?? 0).toFixed(0), z: (v?.position[1] ?? 0).toFixed(0), n: s.vents.length, rate: s.rate, T: s.temperature.toFixed(0), d: s.duration, mat: s.material },
  };
}
