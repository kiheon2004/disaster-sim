/**
 * Atmosphere channel (Phase 29): what the atmosphere experiment writes and the ThermalSystem reads.
 * Dormant — no arrays, no cost, results bit-identical to Phase 28 — until an atmosphere experiment
 * starts. The state itself (AtmosphereField + its adapter) is created by the ThermalSystem on the run's
 * current terrain, with the thermal state whose air temperature it shares.
 */
import type { AtmosphereSpec } from '@/atmosphere/types';

export interface AtmosphereRecord {
  id: string;
  name: string;
  spec: AtmosphereSpec;
  /** Absolute start time (s). */
  start: number;
  /** Taken by the runtime (the first) or rejected with a reason (later ones). */
  done: boolean;
  reason: string | null;
}

export class AtmosphereChannel {
  readonly experiments: AtmosphereRecord[] = [];
  /** Adapter (simulation/atmosphere/runtime.ts), created with the first experiment. */
  rt: import('./runtime').AtmosphereRuntime | null = null;
  /** Bumped when an experiment is added (renderers). */
  rev = 0;

  get active(): boolean {
    return this.rt !== null || this.experiments.length > 0;
  }

  add(spec: AtmosphereSpec, start: number, id: string) {
    this.experiments.push({ id, name: spec.name ?? id, spec, start, done: false, reason: null });
    this.rev++;
  }
}
