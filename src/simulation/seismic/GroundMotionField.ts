/**
 * GroundMotionField: ground displacement / velocity / acceleration as a function of position
 * and time — the one source every earthquake system (structures, free bodies, damage,
 * visualization) samples, like SpatialWindField for wind.
 *
 *   EarthquakeEvent ──start()──► GroundMotionField ──sample(x, z, t)──► systems / renderers
 *
 * Spatial model (approximate):
 *  - site response: the motion at a point blends the per-soil synthetic tables with the
 *    bilinear soil weights of the terrain (soft soil amplifies / resonates, rock attenuates);
 *  - path: amplitude ∝ R_ref / R (geometric spreading of body waves) and the arrival is
 *    delayed by (R − R_ref) / Vs, R = hypocentral distance. Across a 200 m map both effects are
 *    small unless the hypocenter is very shallow and close — as in reality;
 *  - components: H1 along the principal bearing, H2 perpendicular, V vertical (+Y up).
 *
 * Time 0 of the event is the P arrival at the map center. Everything is deterministic; the
 * motion is a SYNTHETIC waveform, not a record.
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import type { ResolvedEarthquake } from '@/events/earthquake/resolveEarthquake';
import { DEFAULT_SOIL, SOIL_COUNT } from '@/terrain/SoilProfiles';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { AXIS_H1, AXIS_H2, AXIS_V, SyntheticWaveform } from './SyntheticWaveform';
import { addShock, shockWindow, type GroundShock } from '@/impact/shock';

/** P- and S-wave velocities (km/s) of a generic crust. */
export const VP_KMS = 6.0;
export const VS_KMS = 3.5;

export interface GroundMotionSample {
  /** Displacement (m), velocity (m/s), acceleration (m/s²) in world axes (y up). */
  d: Vec3;
  v: Vec3;
  a: Vec3;
  /** Horizontal acceleration magnitude of the earthquake part and of the impact-shock part (m/s²; attribution). */
  aQuake: number;
  aImpact: number;
}

export function createGroundMotionSample(): GroundMotionSample {
  return { d: [0, 0, 0], v: [0, 0, 0], a: [0, 0, 0], aQuake: 0, aImpact: 0 };
}

/** S−P time (s) at a hypocentral distance (km). */
export function sMinusP(distanceKm: number): number {
  return distanceKm / VS_KMS - distanceKm / VP_KMS;
}

/** Build the synthetic waveform of a resolved scenario (deterministic). */
export function createWaveform(q: ResolvedEarthquake): SyntheticWaveform {
  const dist = Math.hypot(q.epicenter[0] / 1000, q.epicenter[1] / 1000, q.depth);
  return new SyntheticWaveform({
    duration: q.duration,
    dominantFrequency: q.dominantFrequency,
    seed: q.seed,
    sMinusP: sMinusP(dist),
    pga: q.pga,
    verticalRatio: q.verticalRatio,
  });
}

const loc = { i: -1, f: 0 };

/** One shaking earthquake (Phase 35.5: independent instances superpose). */
interface QuakeSource {
  id: string;
  q: ResolvedEarthquake;
  wave: SyntheticWaveform;
  startTime: number;
  h1: [number, number];
  h2: [number, number];
  refDist: number;
}

export class GroundMotionField {
  /** An earthquake is shaking (between its start and end). */
  private quakeOn = false;
  /**
   * Impact ground shocks (Phase 23): pulses added to the earthquake motion (superposition) — every
   * consumer (structures, free bodies, water, Newmark slopes) feels them through this one field, so
   * no force is applied twice.
   */
  readonly shocks: GroundShock[] = [];
  private shockOn = false;

  /** True while an earthquake shakes or an impact shock is passing through the world. */
  get active(): boolean {
    return this.quakeOn || this.shockOn;
  }

  get quakeActive(): boolean {
    return this.quakeOn;
  }

  /** Re-evaluate whether a shock is passing at `time` (called every step by the impact system). */
  updateShocks(time: number, worldHalf: number) {
    let on = false;
    for (const s of this.shocks) {
      const [t0, t1] = shockWindow(s, worldHalf);
      if (time >= t0 && time <= t1) { on = true; break; }
    }
    this.shockOn = on;
  }
  /**
   * Phase 35.5: several earthquakes may shake at once (independent instances). Their motions are superposed linearly
   * (the ground is treated as a linear medium — an approximation, docs/PHASE35_5_USER_EXPERIENCE.md §9). With one
   * earthquake the field is bit-identical to the single-source field it replaces.
   */
  private readonly quakes: QuakeSource[] = [];
  /** The earthquake started last (HUD, recorder): its scenario, waveform and start. */
  scenario: ResolvedEarthquake | null = null;
  wave: SyntheticWaveform | null = null;
  startTime = 0;
  /** Unit vectors (x, z) of the H1 and H2 axes of the earthquake started last. */
  readonly h1: [number, number] = [1, 0];
  readonly h2: [number, number] = [0, 1];
  /** Point samples taken since the last reset (performance HUD / profiling). */
  samples = 0;
  private weights = new Float64Array(SOIL_COUNT);

  constructor(public terrain: TerrainSampler) {}

  /** Start an earthquake; `id` names the instance (a second start with the same id replaces it). */
  start(q: ResolvedEarthquake, wave: SyntheticWaveform, startTime: number, id = 'quake') {
    const b = (q.direction * Math.PI) / 180;
    // Bearing θ (0 = N, 90 = E) → world (x = E, z = S): (sin θ, −cos θ).
    const src: QuakeSource = {
      id, q, wave, startTime,
      h1: [Math.sin(b), -Math.cos(b)], h2: [Math.cos(b), Math.sin(b)],
      refDist: Math.max(1, Math.hypot(q.epicenter[0], q.epicenter[1], q.depth * 1000)),
    };
    const k = this.quakes.findIndex((s) => s.id === id);
    if (k >= 0) this.quakes[k] = src;
    else this.quakes.push(src);
    this.scenario = q;
    this.wave = wave;
    this.startTime = startTime;
    this.h1[0] = src.h1[0];
    this.h1[1] = src.h1[1];
    this.h2[0] = src.h2[0];
    this.h2[1] = src.h2[1];
    this.quakeOn = true;
  }

  /** Stop one earthquake (by id), or all of them. */
  stop(id?: string) {
    if (id === undefined) this.quakes.length = 0;
    else {
      const k = this.quakes.findIndex((s) => s.id === id);
      if (k >= 0) this.quakes.splice(k, 1);
    }
    this.quakeOn = this.quakes.length > 0;
  }

  /** Earthquakes shaking now (ids, in start order). */
  activeQuakes(): string[] {
    return this.quakes.map((s) => s.id);
  }

  /** Event-local time at the map center. */
  localTime(time: number): number {
    return time - this.startTime;
  }

  /**
   * Ground motion at (x, z) and absolute simulation time `time`, written into `out`.
   * Zero when no earthquake is active.
   */
  sample(x: number, z: number, time: number, out: GroundMotionSample): GroundMotionSample {
    return this.sampleAt(x, z, time, out, true);
  }

  private sampleAt(x: number, z: number, time: number, out: GroundMotionSample, siteSoil: boolean): GroundMotionSample {
    const d = out.d, v = out.v, a = out.a;
    d[0] = d[1] = d[2] = v[0] = v[1] = v[2] = a[0] = a[1] = a[2] = 0;
    out.aQuake = 0;
    out.aImpact = 0;
    this.sampleQuake(x, z, time, out, siteSoil);
    out.aQuake = Math.hypot(a[0], a[2]);
    if (this.shockOn) {
      const ax = a[0], az = a[2];
      for (const s of this.shocks) addShock(s, x, z, time, d, v, a);
      out.aImpact = Math.hypot(a[0] - ax, a[2] - az);
    }
    return out;
  }

  private sampleQuake(x: number, z: number, time: number, out: GroundMotionSample, siteSoil: boolean) {
    if (!this.quakeOn) return out;
    this.samples++;
    const w = !siteSoil || this.terrain.uniformSoil ? null : this.terrain.sampleSoilWeights(x, z, this.weights);
    let first = true;
    for (const src of this.quakes) if (this.addQuake(src, x, z, time, out, w, first)) first = false;
    return out;
  }

  /** One earthquake's motion at (x, z): written into `out` when `first`, otherwise added (superposition). */
  private addQuake(src: QuakeSource, x: number, z: number, time: number, out: GroundMotionSample, w: Float64Array | null, first: boolean): boolean {
    const d = out.d, v = out.v, a = out.a;
    const q = src.q, wave = src.wave;
    const dx = x - q.epicenter[0];
    const dz = z - q.epicenter[1];
    const R = Math.max(1, Math.sqrt(dx * dx + dz * dz + q.depth * q.depth * 1e6));
    const t = time - src.startTime - (R - src.refDist) / (VS_KMS * 1000);
    SyntheticWaveform.locate(t, wave.samples, loc);
    if (loc.i < 0) return false;
    const atten = src.refDist / R;
    let dh1 = 0, dh2 = 0, dv = 0, vh1 = 0, vh2 = 0, vv = 0, ah1 = 0, ah2 = 0, av = 0;
    const i = loc.i;
    const f = loc.f;
    const g = 1 - f;
    for (let s = 0; s < SOIL_COUNT; s++) {
      const ws = w ? w[s] : s === DEFAULT_SOIL ? 1 : 0;
      if (ws <= 0) continue;
      const tb = wave.soil(s);
      const k = ws * atten;
      const D = tb.d, V = tb.v, A = tb.a;
      dh1 += k * (D[AXIS_H1][i] * g + D[AXIS_H1][i + 1] * f);
      dh2 += k * (D[AXIS_H2][i] * g + D[AXIS_H2][i + 1] * f);
      dv += k * (D[AXIS_V][i] * g + D[AXIS_V][i + 1] * f);
      vh1 += k * (V[AXIS_H1][i] * g + V[AXIS_H1][i + 1] * f);
      vh2 += k * (V[AXIS_H2][i] * g + V[AXIS_H2][i + 1] * f);
      vv += k * (V[AXIS_V][i] * g + V[AXIS_V][i + 1] * f);
      ah1 += k * (A[AXIS_H1][i] * g + A[AXIS_H1][i + 1] * f);
      ah2 += k * (A[AXIS_H2][i] * g + A[AXIS_H2][i + 1] * f);
      av += k * (A[AXIS_V][i] * g + A[AXIS_V][i + 1] * f);
    }
    const [h1x, h1z] = src.h1;
    const [h2x, h2z] = src.h2;
    if (first) {
      d[0] = dh1 * h1x + dh2 * h2x;
      d[1] = dv;
      d[2] = dh1 * h1z + dh2 * h2z;
      v[0] = vh1 * h1x + vh2 * h2x;
      v[1] = vv;
      v[2] = vh1 * h1z + vh2 * h2z;
      a[0] = ah1 * h1x + ah2 * h2x;
      a[1] = av;
      a[2] = ah1 * h1z + ah2 * h2z;
    } else {
      d[0] += dh1 * h1x + dh2 * h2x;
      d[1] += dv;
      d[2] += dh1 * h1z + dh2 * h2z;
      v[0] += vh1 * h1x + vh2 * h2x;
      v[1] += vv;
      v[2] += vh1 * h1z + vh2 * h2z;
      a[0] += ah1 * h1x + ah2 * h2x;
      a[1] += av;
      a[2] += ah1 * h1z + ah2 * h2z;
    }
    return true;
  }

  /** Motion at the map center on the reference soil (HUD, graphs). */
  reference(time: number, out: GroundMotionSample): GroundMotionSample {
    // Map center, reference soil (ignores the soil actually painted there).
    return this.sampleAt(0, 0, time, out, false);
  }
}

/** Horizontal magnitude of a vector (m/s² → g helper below). */
export const horizontal = (v: Vec3) => Math.hypot(v[0], v[2]);
export const toG = (a: number) => a / GRAVITY;
