/**
 * Fire channel (Phase 27): what fire scenarios write and the ThermalSystem reads. Dormant — no
 * arrays, no cost, results bit-identical to Phase 26 — until the first ignition is due. The fire
 * state itself (FireWorld + its adapter) lives on top of the run's thermal state.
 */
import type { FireSettings, FireSpec } from '@/fire/types';
import { defaultFireSettings } from '@/fire/types';

export interface IgnitionRecord {
  id: string;
  name: string;
  spec: FireSpec;
  /** Absolute start time (s). */
  start: number;
  /** Applied (or rejected) — with the number of fuel items lit / the reason. */
  done: boolean;
  lit: number;
  reason: string | null;
}

export class FireChannel {
  readonly ignitions: IgnitionRecord[] = [];
  /** Adapter (simulation/fire/runtime.ts), created with the first ignition. */
  rt: import('./runtime').FireRuntime | null = null;
  /** Bumped when an ignition is added (renderers). */
  rev = 0;

  constructor(readonly settings: FireSettings = defaultFireSettings()) {}

  /** A fire scenario exists (the thermal system must run for it). */
  get active(): boolean {
    return this.rt !== null || this.ignitions.length > 0;
  }

  /** The combustion model runs in this thermal run: a fire scenario, or heat may ignite fuel. */
  wanted(): boolean {
    return this.ignitions.length > 0 || this.settings.heatIgnition;
  }

  add(spec: FireSpec, start: number, id: string) {
    this.ignitions.push({ id, name: spec.name ?? id, spec, start, done: false, lit: 0, reason: null });
    this.rev++;
  }
}
