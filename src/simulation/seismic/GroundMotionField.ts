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

/** P- and S-wave velocities (km/s) of a generic crust. */
export const VP_KMS = 6.0;
export const VS_KMS = 3.5;

export interface GroundMotionSample {
  /** Displacement (m), velocity (m/s), acceleration (m/s²) in world axes (y up). */
  d: Vec3;
  v: Vec3;
  a: Vec3;
}

export function createGroundMotionSample(): GroundMotionSample {
  return { d: [0, 0, 0], v: [0, 0, 0], a: [0, 0, 0] };
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

export class GroundMotionField {
  /** True while an earthquake is shaking (between its start and end). */
  active = false;
  scenario: ResolvedEarthquake | null = null;
  wave: SyntheticWaveform | null = null;
  startTime = 0;
  /** Unit vectors (x, z) of the H1 and H2 axes. */
  readonly h1: [number, number] = [1, 0];
  readonly h2: [number, number] = [0, 1];
  /** Point samples taken since the last reset (performance HUD / profiling). */
  samples = 0;
  private refDist = 1; // m
  private weights = new Float64Array(SOIL_COUNT);

  constructor(public terrain: TerrainSampler) {}

  start(q: ResolvedEarthquake, wave: SyntheticWaveform, startTime: number) {
    this.scenario = q;
    this.wave = wave;
    this.startTime = startTime;
    this.active = true;
    const b = (q.direction * Math.PI) / 180;
    // Bearing θ (0 = N, 90 = E) → world (x = E, z = S): (sin θ, −cos θ).
    this.h1[0] = Math.sin(b);
    this.h1[1] = -Math.cos(b);
    this.h2[0] = Math.cos(b);
    this.h2[1] = Math.sin(b);
    this.refDist = Math.max(1, Math.hypot(q.epicenter[0], q.epicenter[1], q.depth * 1000));
  }

  stop() {
    this.active = false;
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
    const q = this.scenario;
    const wave = this.wave;
    if (!this.active || !q || !wave) return out;
    this.samples++;
    const dx = x - q.epicenter[0];
    const dz = z - q.epicenter[1];
    const R = Math.max(1, Math.sqrt(dx * dx + dz * dz + q.depth * q.depth * 1e6));
    const t = time - this.startTime - (R - this.refDist) / (VS_KMS * 1000);
    SyntheticWaveform.locate(t, wave.samples, loc);
    if (loc.i < 0) return out;
    const atten = this.refDist / R;
    const w = !siteSoil || this.terrain.uniformSoil ? null : this.terrain.sampleSoilWeights(x, z, this.weights);
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
    const [h1x, h1z] = this.h1;
    const [h2x, h2z] = this.h2;
    d[0] = dh1 * h1x + dh2 * h2x;
    d[1] = dv;
    d[2] = dh1 * h1z + dh2 * h2z;
    v[0] = vh1 * h1x + vh2 * h2x;
    v[1] = vv;
    v[2] = vh1 * h1z + vh2 * h2z;
    a[0] = ah1 * h1x + ah2 * h2x;
    a[1] = av;
    a[2] = ah1 * h1z + ah2 * h2z;
    return out;
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
