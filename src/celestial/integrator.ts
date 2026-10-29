/**
 * Orbit integrator of the celestial experiments (Phase 32): kick–drift–kick leapfrog (velocity Verlet) with
 * deterministic substeps — second order, symplectic and time-reversible for a fixed substep, so the energy error of a
 * bound orbit oscillates instead of drifting (the semi-implicit Euler of the physics step is first order: its energy
 * error ε grows with g²·dt² per step, docs/PHASE31_AUDIT.md §22).
 *
 * Per substep h (g frozen in time for the step, as the field):
 *   v½ = v + ½h·g(x);   x′ = x + h·v½;   v′ = v½ + ½h·g(x′)
 * Path work per unit mass: Σ ½(g(x) + g(x′))·(x′ − x) (trapezoid on the drifted segment — for a conservative field it
 * equals −ΔΦ to O(h³) per substep; the difference is reported, not removed).
 *
 * Substeps: n = 2^k, the smallest power of two with dt/n ≤ η·τ, τ the shortest dynamical time on the step's straight
 * segment (PointField.timescale at the start, the end and the closest approach to each source) — a pure function of
 * the body's state and the field, so the same state always takes the same subdivision (determinism, object-order
 * independence). Above the cap the step runs with the cap and says so (`capped`); nothing is silently clipped.
 */
import type { Vec3 } from '@/core/types';
import { CELESTIAL_LIMITS } from './types';

export interface StepField {
  /** Total g at a point (m/s², into out). */
  accel(x: number, y: number, z: number, out: Vec3): Vec3;
  /** Shortest dynamical time along the straight segment x₀ + v·s, s ∈ [0, dt] (s). */
  segmentTimescale(x: number, y: number, z: number, vx: number, vy: number, vz: number, dt: number): number;
  /** Capture sphere containing the point (−1 = none). */
  captureAt(x: number, y: number, z: number): number;
}

export interface KdkResult {
  /** Substeps used, the count the step size rule asked for (> cap when capped). */
  n: number;
  wanted: number;
  capped: boolean;
  /** Path work of gravity per unit mass (J/kg). */
  work: number;
  /** Capture: live index of the source (−1 = none) and the fraction of dt at which it happened. */
  captured: number;
  at: number;
}

/** Substep count for a step dt at time scale τ: the power of two with dt/n ≤ η·τ (1 for an infinite τ). */
export function substepCount(tau: number, dt: number, eta: number = CELESTIAL_LIMITS.eta): number {
  if (!(tau < Infinity)) return 1;
  if (!(tau > 0)) return Infinity;
  const want = dt / (eta * tau);
  if (want <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(want) - 1e-12);
}

const ga: Vec3 = [0, 0, 0];
const gb: Vec3 = [0, 0, 0];

/**
 * One step dt of a free body: x, v updated in place (Float64 arrays or Vec3). `cap` substeps at most. Stops at the
 * first substep ending inside a capture sphere (x, v at that point).
 */
export function kdk(f: StepField, x: Vec3 | Float64Array, v: Vec3 | Float64Array, dt: number, res: KdkResult, cap: number = CELESTIAL_LIMITS.substeps, eta: number = CELESTIAL_LIMITS.eta): KdkResult {
  const tau = f.segmentTimescale(x[0], x[1], x[2], v[0], v[1], v[2], dt);
  const wanted = substepCount(tau, dt, eta);
  const n = Math.min(wanted, cap);
  res.n = n; res.wanted = wanted; res.capped = wanted > cap; res.work = 0; res.captured = -1; res.at = 1;
  const h = dt / n, hh = 0.5 * h;
  f.accel(x[0], x[1], x[2], ga);
  let w = 0;
  for (let i = 0; i < n; i++) {
    v[0] += hh * ga[0]; v[1] += hh * ga[1]; v[2] += hh * ga[2];
    const dx = h * v[0], dy = h * v[1], dz = h * v[2];
    x[0] += dx; x[1] += dy; x[2] += dz;
    f.accel(x[0], x[1], x[2], gb);
    v[0] += hh * gb[0]; v[1] += hh * gb[1]; v[2] += hh * gb[2];
    w += 0.5 * ((ga[0] + gb[0]) * dx + (ga[1] + gb[1]) * dy + (ga[2] + gb[2]) * dz);
    ga[0] = gb[0]; ga[1] = gb[1]; ga[2] = gb[2];
    const c = f.captureAt(x[0], x[1], x[2]);
    if (c >= 0) { res.captured = c; res.at = (i + 1) / n; break; }
  }
  res.work = w;
  return res;
}

export const newKdkResult = (): KdkResult => ({ n: 0, wanted: 0, capped: false, work: 0, captured: -1, at: 1 });
