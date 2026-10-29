/**
 * Gravity channel (Phase 31): the ONE place every system asks for gravity during a gravity experiment. Dormant — no
 * field, no cost, every system on its Phase 0–30 constant (results bit-identical) — until a gravity experiment starts:
 * then `field` holds g(x, t) and each system reads its sample through the helpers below, never a constant of its own.
 *
 * Systems prepare nothing themselves: the GravitySystem prepares the field for the step's time before any other system
 * runs, so every reader of a step sees the same field (one sample time per step).
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { GravityField } from '@/gravity/field';
import type { GravitySpec } from '@/gravity/types';
import type { CelestialSpec } from '@/celestial/types';

export interface GravityRecord {
  id: string;
  name: string;
  spec: GravitySpec;
  /** Absolute start time (s). */
  start: number;
}

/** A celestial experiment (Phase 32) registered with the channel. */
export interface CelestialRecord {
  id: string;
  name: string;
  spec: CelestialSpec;
  start: number;
}

export class GravityChannel {
  readonly experiments: GravityRecord[] = [];
  /** Celestial experiments (Phase 32): their point sources are part of the same field. */
  readonly celestial: CelestialRecord[] = [];
  /** Project gravity (m/s²; the Rapier world's baseline, settings.gravity). */
  g0 = GRAVITY;
  /** The run's field, created with the first experiment (null = dormant: every system on its constant). */
  field: GravityField | null = null;
  /** Adapter (simulation/gravity/runtime.ts), created with the first experiment. */
  rt: import('./runtime').GravityRuntime | null = null;
  /** Bumped when an experiment is added (renderers, editor). */
  rev = 0;
  /** Phase 32: a celestial source's horizontal field loads the storey model this step (structural response active). */
  lateral = false;

  get active(): boolean {
    return this.field !== null;
  }

  add(spec: GravitySpec, start: number, id: string) {
    const name = spec.name ?? id;
    this.experiments.push({ id, name, spec, start });
    (this.field ??= new GravityField(this.g0)).add({ id: name, spec, start });
    this.rev++;
  }

  /** Register a celestial experiment (Phase 32): its sources join the field (created here if none yet). */
  addCelestial(spec: CelestialSpec, start: number, id: string) {
    const name = spec.name ?? id;
    this.celestial.push({ id, name, spec, start });
    (this.field ??= new GravityField(this.g0)).addCelestial({ id: name, spec, start });
    this.rev++;
  }

  /** g at a point (m/s² into out): the field, or the project gravity vector while dormant. */
  at(x: number, y: number, z: number, out: Vec3): Vec3 {
    if (this.field) return this.field.sample(x, y, z, out);
    out[0] = 0; out[1] = -this.g0; out[2] = 0;
    return out;
  }

  /** Uniform (global) vector of this step. */
  get G(): Readonly<Vec3> {
    return this.field ? this.field.G : this.baseline;
  }
  private readonly baseline: Vec3 = [0, -GRAVITY, 0];

  private readonly tmp: Vec3 = [0, 0, 0];

  /**
   * Downward (ground-normal) component g_n = −g_y at a point (m/s²; > 0 presses onto a horizontal ground) — what the
   * ground-based solvers (water, lava, air columns, snow, structures) use. `fallback` is the constant of the caller's
   * Phase 0–30 code, returned unchanged while dormant (bit-identical results).
   */
  down(x: number, y: number, z: number, fallback: number): number {
    if (!this.field) return fallback;
    return -this.field.sample(x, y, z, this.tmp)[1];
  }

  /** Down component of the uniform part (fast path of solvers that only take a global value). */
  downUniform(fallback: number): number {
    return this.field ? -this.field.G[1] : fallback;
  }

  /** Ratio of the down component to the project gravity at a point (1 while dormant) — scales Earth-calibrated weights. */
  ratio(x: number, y: number, z: number): number {
    if (!this.field) return 1;
    return -this.field.sample(x, y, z, this.tmp)[1] / this.g0;
  }

  /** |g| at a point (fallback while dormant). */
  magnitude(x: number, y: number, z: number, fallback: number): number {
    if (!this.field) return fallback;
    const g = this.field.sample(x, y, z, this.tmp);
    return Math.hypot(g[0], g[1], g[2]);
  }
}
