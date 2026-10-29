/**
 * Climate experiment (Phase 30). Like every event it only WRITES its channel: at its start the experiment is
 * registered in the climate channel; the ThermalSystem builds the climate state on the thermal state (or rejects a
 * second experiment with a reason). Its duration is the forcing path; afterwards the background keeps its end value.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { ClimateSpec } from '@/climate/types';
import { ClimateForcing } from '@/climate/forcing';
import { ZERO_C } from '@/thermal/units';

export class ClimateEvent implements SimulationEvent<ClimateSpec> {
  readonly id = createId('evt');
  readonly type = 'climate' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  private readonly forcing: ClimateForcing;

  constructor(readonly spec: ClimateSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
    this.channel = `climate:${this.id}`;
    this.forcing = new ClimateForcing(spec, 101325);
  }

  onStart({ env }: EventContext) {
    env.climate.add(this.spec, this.startTime, this.spec.name ?? this.id);
  }

  update() {}

  /** Timeline intensity: the temperature departure from the start (per 30 K) or the precipitation (per 20 mm/h). */
  intensityAt(t: number): number {
    const dT = Math.abs(this.forcing.temperature(t) - this.spec.temperature) / 30;
    return Math.min(1, Math.max(dT, this.forcing.precipRate(t) / 20));
  }

  describe(): I18nMessage {
    return describeClimate(this.spec);
  }
}

export function describeClimate(s: ClimateSpec): I18nMessage {
  return { key: `event.climate.${s.scenario}` as I18nMessage['key'], params: { T0: (s.temperature - ZERO_C).toFixed(1), T1: (s.target - ZERO_C).toFixed(1), d: (s.duration / 60).toFixed(0), P: (s.precipitation ?? 0).toFixed(1), rh: (s.humidity * 100).toFixed(0) } };
}
