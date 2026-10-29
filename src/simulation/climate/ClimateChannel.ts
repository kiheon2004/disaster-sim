/**
 * Climate channel (Phase 30): what the climate experiment writes and the ThermalSystem reads. Dormant — no arrays,
 * no cost, results bit-identical to Phase 29 — until a climate experiment starts. The state itself (ClimateWorld +
 * its adapter) is created by the ThermalSystem on the run's thermal state (the owner of temperatures).
 */
import type { ClimateSpec } from '@/climate/types';

export interface ClimateRecord {
  id: string;
  name: string;
  spec: ClimateSpec;
  /** Absolute start time (s). */
  start: number;
  done: boolean;
  reason: string | null;
}

export class ClimateChannel {
  readonly experiments: ClimateRecord[] = [];
  /** Adapter (simulation/climate/runtime.ts), created with the first experiment. */
  rt: import('./runtime').ClimateRuntime | null = null;
  /** Bumped when an experiment is added (renderers). */
  rev = 0;

  get active(): boolean {
    return this.rt !== null || this.experiments.length > 0;
  }

  add(spec: ClimateSpec, start: number, id: string) {
    this.experiments.push({ id, name: spec.name ?? id, spec, start, done: false, reason: null });
    this.rev++;
  }
}
