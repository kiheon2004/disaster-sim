/**
 * Heat source (Phase 26). Like every event it only WRITES its channel: at its start the source is
 * registered in the temperature channel; the ThermalSystem integrates its output exactly over each
 * thermal step (profiles.ts) and the event itself has nothing to update.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { HeatSourceSpec } from '@/thermal/types';
import { shapeAt } from '@/thermal/profiles';
import { energyText, powerText, toC } from '@/thermal/units';
import { totalEnergy } from '@/thermal/sources';

export class HeatSourceEvent implements SimulationEvent<HeatSourceSpec> {
  readonly id = createId('evt');
  readonly type = 'heatSource' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: HeatSourceSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    // An instant deposit still occupies a short slot on the timeline.
    this.duration = Math.max(spec.profile === 'instant' ? 1 : 0.1, spec.duration);
    // Several sources coexist: each has its own channel (they never supersede each other).
    this.channel = `heat:${this.id}`;
  }

  onStart({ env }: EventContext) {
    env.thermal.add(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  intensityAt(t: number): number {
    if (this.spec.profile === 'instant') return t < 0.5 ? 1 : 0;
    return shapeAt(this.spec, t);
  }

  describe(): I18nMessage {
    return describeHeatSource(this.spec);
  }
}

export function describeHeatSource(s: HeatSourceSpec): I18nMessage {
  const what = s.kind === 'temperature' ? `${toC(s.temperature ?? 0).toFixed(0)} °C`
    : s.input === 'energy' ? energyText(s.energy ?? 0) : `${powerText(s.power ?? 0)} · ${energyText(totalEnergy(s))}`;
  return { key: `event.heatSource.describe.${s.kind}` as const, params: { what, x: s.position[0].toFixed(0), z: s.position[1].toFixed(0), d: s.duration } };
}
