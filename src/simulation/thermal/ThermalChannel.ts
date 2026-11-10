/**
 * Temperature channel (Phase 26): what heat sources write and the ThermalSystem reads. Dormant —
 * no arrays, no cost, results bit-identical to Phase 25 — until the first heat source starts (or an
 * impact deposits its thermal share). The thermal state itself (ThermalWorld + its adapter) is
 * created by the ThermalSystem on the run's current terrain.
 */
import type { HeatSourceSpec } from '@/thermal/types';
import { defaultThermalSettings, type ThermalSettings } from '@/thermal/ThermalWorld';

export interface SourceRecord {
  id: string;
  name: string;
  spec: HeatSourceSpec;
  /** Absolute start time (s). */
  start: number;
  /** Phase 35.5: stopped by the user at this absolute time (no heat after it). */
  stopAt?: number;
}

/** Heat deposited by an impact (Phase 23 partition, `thermalShare`) into the crater's surface. */
export interface ImpactDeposit {
  id: string;
  time: number;
  energy: number;
  x: number;
  z: number;
  radius: number;
  done: boolean;
}

export class ThermalChannel {
  readonly sources: SourceRecord[] = [];
  readonly deposits: ImpactDeposit[] = [];
  /** Adapter + world (simulation/thermal/runtime.ts), created on first activity. */
  rt: import('./runtime').ThermalRuntime | null = null;
  /** Bumped when a source is added (renderers). */
  rev = 0;

  constructor(readonly settings: ThermalSettings = defaultThermalSettings(), readonly airDensity = 1.225) {}

  get active(): boolean {
    return this.rt !== null || this.sources.length > 0 || this.deposits.length > 0;
  }

  add(spec: HeatSourceSpec, start: number, id: string) {
    this.sources.push({ id, name: spec.name ?? id, spec, start });
    this.rev++;
  }

  addDeposit(d: Omit<ImpactDeposit, 'done'>) {
    this.deposits.push({ ...d, done: false });
    this.rev++;
  }
}
