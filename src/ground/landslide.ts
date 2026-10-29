/**
 * Landslide model (Phase 22): slope stability in a source area and release of the failed soil.
 *
 * For every soil vertex of the area (rock excluded — its failure is not a soil-slope problem):
 *   FS = infinite-slope factor of safety (stability.ts §1) with the slope of the CURRENT ground
 *        (other phenomena — a deformation, a sinkhole, a previous slide — change it: "slope
 *        modification"), the soil thickness z, the water table m = m₀ (+ prescribed ramp) +
 *        rise from infiltrated rain (perched table, common.ts), cohesion with the apparent
 *        (suction) part lost as m → 1 and seeded variability.
 *   Earthquake: Newmark sliding block per vertex, a_c = (FS − 1)·g·sinβ, driven by the ground
 *        acceleration (GroundMotionField) projected on the downslope direction; failure when the
 *        permanent displacement exceeds `newmarkLimit` (empirical threshold, default 0.1 m).
 *   Failure: FS < 1 or D ≥ limit → the whole soil layer above the slip surface becomes mobile
 *        (bulked) with basal friction tan φ'·(1 − r_u) and runs out with the granular solver.
 *        Removing it steepens the scarp above, which may fail next (retrogression) — inside the
 *        source area only.
 * 'user' trigger: the whole area fails at the start (prescribed, labelled as such).
 *
 * Applicability: shallow translational slides (depth ≪ length). Not modelled: deep rotational
 * slides, rock falls / topples, 3-D wedges, seepage flow computation, progressive softening to
 * residual strength, entrainment along the path.
 */
import type { GeoField } from './GeoField';
import type { GroundEnv } from './common';
import { applyVariability, areaVertices, basalFriction, slopeAt, waterRiseFrom } from './common';
import { DEG, G, MECHANICAL_IDS, MECHANICAL_PROFILES, unitWeight } from './materials';
import { criticalAcceleration, infiniteSlopeFS, newmarkStep } from './stability';
import type { LandslideSpec } from './types';

export interface LandslideEvent {
  kind: 'instability' | 'initiation' | 'retrogression';
  time: number;
  value: number;
}

const dir: [number, number] = [0, 0];

export class LandslideModel {
  readonly cells: number[];
  /** Downslope unit vector and slope (rad) per area vertex (refreshed at each evaluation). */
  private dx: Float32Array;
  private dz: Float32Array;
  private beta: Float32Array;
  minFS = Infinity;
  failedCells = 0;
  maxNewmark = 0;
  /** Vertices whose FS fell below 1 or whose Newmark displacement passed the limit (by cause). */
  failedStatic = 0;
  failedSeismic = 0;
  failedUser = 0;
  readonly events: LandslideEvent[] = [];
  private userDone = false;
  readonly index: number;

  constructor(readonly id: string, readonly name: string, readonly spec: LandslideSpec, readonly startTime: number, private readonly f: GeoField, index: number, seed: number) {
    this.index = index;
    this.cells = areaVertices(f, spec.area);
    const mat = spec.material ? MECHANICAL_IDS.indexOf(spec.material) : -1;
    for (const i of this.cells) {
      if (mat >= 0) f.material[i] = mat;
      if (f.thickness[i] < spec.thickness) f.thickness[i] = spec.thickness;
      f.water0[i] = Math.max(f.water0[i], spec.saturation);
      f.owner[i] = index;
      f.evaluate[i] = 1;
    }
    applyVariability(f, this.cells, spec.variability ?? 0, spec.seed ?? seed);
    this.dx = new Float32Array(this.cells.length);
    this.dz = new Float32Array(this.cells.length);
    this.beta = new Float32Array(this.cells.length);
  }

  private ramp(tau: number) {
    const D = this.spec.duration;
    return D <= 0 ? 1 : Math.min(1, Math.max(0, tau / D));
  }

  /** Static FS of vertex k of the area (also caches its slope and downslope direction). */
  private fsAt(k: number, env: GroundEnv): number {
    const f = this.f, i = this.cells[k];
    const p = f.profile(i);
    const z = f.thickness[i] + f.loose[i];
    const b = slopeAt(f, env, i, dir);
    this.beta[k] = b; this.dx[k] = dir[0]; this.dz[k] = dir[1];
    if (!p.failureModel || z <= 0.05 || f.failed[i]) return Infinity;
    const m = f.water(i);
    return infiniteSlopeFS({ beta: b, z, c: p.cohesion * f.strength[i] + p.apparentCohesion * (1 - m), phi: p.friction * DEG, gamma: unitWeight(p), m });
  }

  /** Stability evaluation and failures at the deformation update rate. */
  update(tau: number, time: number, env: GroundEnv) {
    if (tau < 0) return;
    const f = this.f, s = this.spec;
    // Water table: antecedent m₀, prescribed ramp (saturation trigger), infiltrated rain.
    const target = s.trigger === 'saturation' ? (s.targetSaturation ?? 1) : s.saturation;
    const m0 = s.saturation + (target - s.saturation) * this.ramp(tau);
    for (const i of this.cells) {
      f.water0[i] = Math.max(f.water0[i], m0);
      f.waterRise[i] = waterRiseFrom(env.infiltrated(i), f.profile(i), Math.max(0.05, f.thickness[i]));
    }
    if (s.trigger === 'user' && !this.userDone) {
      this.userDone = true;
      for (const i of this.cells) this.fail(i, env, 'user');
      this.events.push({ kind: 'initiation', time, value: 0 });
      return;
    }
    let minFS = Infinity, failedNow = 0;
    const limit = s.newmarkLimit ?? 0.1;
    for (let k = 0; k < this.cells.length; k++) {
      const i = this.cells[k];
      if (f.failed[i]) continue;
      const fs = this.fsAt(k, env);
      f.fs[i] = fs;
      if (fs < minFS) minFS = fs;
      if (fs < 1) { this.fail(i, env, 'static'); failedNow++; }
      else if (f.nmD[i] >= limit) { this.fail(i, env, 'seismic'); failedNow++; }
    }
    if (minFS < this.minFS) this.minFS = minFS;
    if (minFS < 1.05 && !this.events.some((e) => e.kind === 'instability')) this.events.push({ kind: 'instability', time, value: minFS });
    if (failedNow) {
      const first = !this.events.some((e) => e.kind === 'initiation');
      this.events.push({ kind: first ? 'initiation' : 'retrogression', time, value: failedNow });
    }
  }

  private fail(i: number, env: GroundEnv, cause: 'static' | 'seismic' | 'user') {
    const f = this.f;
    if (f.failed[i]) return;
    const p = f.profile(i);
    if (!p.failureModel && cause !== 'user') return;
    const z = f.thickness[i] + f.loose[i];
    if (z <= 0.01) return;
    f.failed[i] = 1;
    f.release(i, z, basalFriction(p, f.water(i)));
    this.failedCells++;
    if (cause === 'static') this.failedStatic++;
    else if (cause === 'seismic') this.failedSeismic++;
    else this.failedUser++;
    void env;
  }

  /**
   * Newmark integration for one fixed step with the horizontal ground acceleration (ax, az) at
   * the area (m/s²). Uses each vertex's static FS and slope from the last evaluation.
   */
  newmark(ax: number, az: number, dt: number) {
    const f = this.f;
    let maxD = this.maxNewmark;
    for (let k = 0; k < this.cells.length; k++) {
      const i = this.cells[k];
      if (f.failed[i]) continue;
      const fs = f.fs[i];
      if (!Number.isFinite(fs)) continue;
      const b = this.beta[k];
      const ac = criticalAcceleration(fs, b);
      // Downslope component of the horizontal ground acceleration, along the slope.
      const a = (ax * this.dx[k] + az * this.dz[k]) * Math.cos(b);
      const v = newmarkStep(f.nmV[i], a, Math.max(0, ac), dt);
      f.nmV[i] = v;
      if (v > 0) {
        f.nmD[i] += v * dt;
        if (f.nmD[i] > maxD) maxD = f.nmD[i];
      }
    }
    this.maxNewmark = maxD;
  }

  /** Preview: FS of every area vertex on the current ground with the antecedent / target water. */
  static preview(spec: LandslideSpec, f: GeoField, ground: (i: number) => number) {
    const cells = areaVertices(f, spec.area);
    const env: GroundEnv = { ground, infiltrated: () => 0, surcharge: () => 0 };
    const p = spec.material ? MECHANICAL_PROFILES[spec.material] : null;
    const m = spec.trigger === 'saturation' ? spec.targetSaturation ?? 1 : spec.saturation;
    const fs = new Float32Array(cells.length);
    let unstable = 0, volume = 0, min = Infinity;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const prof = p ?? f.profile(i);
      const b = slopeAt(f, env, i, dir);
      const v = prof.failureModel || spec.trigger === 'user'
        ? infiniteSlopeFS({ beta: b, z: spec.thickness, c: prof.cohesion + prof.apparentCohesion * (1 - m), phi: prof.friction * DEG, gamma: unitWeight(prof), m })
        : Infinity;
      fs[k] = v;
      if (v < min) min = v;
      if (v < 1 || spec.trigger === 'user') { unstable++; volume += spec.thickness * f.dx * f.dx; }
    }
    return { cells, fs, unstable, volume, minFS: min, g: G };
  }
}
