/**
 * Pressure–time history of one wave at one point (Phase 24) and its EXACT time integrals.
 *
 * A wave arriving at time t_a with overpressure Δp and positive duration T is piecewise linear:
 *   'positive':  p(τ) = Δp·(1 − τ/T)       0 ≤ τ < T,   0 otherwise          (τ = t − t_a)
 *   'nWave':     p(τ) = Δp·(1 − τ/T)       0 ≤ τ < 2T  (negative phase down to −Δp, then a rear shock)
 *
 * Every load in the simulation is the integral of p (or of p times a linear factor) over the step,
 * computed in closed form — the impulse delivered in a step is exact wherever the shock falls inside
 * it, so the total impulse is the same for any step size (tested).
 *
 * Front faces see the reflected pressure p·C (C = 1 + (C_r − 1)·cos θ, C_r = Rankine–Hugoniot normal
 * reflection factor 2…8), relieved to the side-on value over the clearing time t_c = 3S/c (S = the
 * smaller of the face height and half-width — the usual simplified clearing idealization of blast-load
 * engineering, approximate):  p_face = p·(1 + (C − 1)·max(0, 1 − τ/t_c)).
 */
import type { BlastWaveform } from './types';

export interface Arrival {
  /** Arrival time (s), peak overpressure (Pa), positive duration (s). */
  t: number;
  dp: number;
  T: number;
  waveform: BlastWaveform;
}

/** Duration of the linear part (positive phase, or both phases of an N-wave). */
export const span = (a: Arrival) => (a.waveform === 'nWave' ? 2 * a.T : a.T);

/** Overpressure at time t (Pa). At the shock (τ = 0) the value after the jump. */
export function pressure(a: Arrival, t: number): number {
  const tau = t - a.t;
  if (tau < 0 || tau >= span(a)) return 0;
  return a.dp * (1 - tau / a.T);
}

/** ∫ p dt from the arrival to time t (Pa·s). */
export function impulseTo(a: Arrival, t: number): number {
  const tau = Math.min(t - a.t, span(a));
  if (tau <= 0) return 0;
  return a.dp * (tau - (tau * tau) / (2 * a.T));
}

/** ∫ p dt over [t0, t1] (Pa·s), exact. */
export function impulse(a: Arrival, t0: number, t1: number): number {
  return impulseTo(a, t1) - impulseTo(a, t0);
}

/** Positive-phase impulse I₊ = ½·Δp·T (Pa·s). */
export const positiveImpulse = (a: Arrival) => 0.5 * a.dp * a.T;

/** ∫ p·max(0, 1 − τ/tc) dt from the arrival to t (the reflected part that clears over tc). */
function clearingTo(a: Arrival, tc: number, t: number): number {
  const tau = Math.min(t - a.t, tc, span(a));
  if (tau <= 0 || tc <= 0) return 0;
  // ∫₀^τ Δp(1 − s/T)(1 − s/tc) ds
  return a.dp * (tau - 0.5 * tau * tau * (1 / a.T + 1 / tc) + (tau * tau * tau) / (3 * a.T * tc));
}

/**
 * ∫ p_face dt over [t0, t1] for a face with reflection factor C (1 = side-on) and clearing time tc.
 */
export function faceImpulse(a: Arrival, C: number, tc: number, t0: number, t1: number): number {
  let I = impulseTo(a, t1) - impulseTo(a, t0);
  if (C !== 1) I += (C - 1) * (clearingTo(a, tc, t1) - clearingTo(a, tc, t0));
  return I;
}

/** Face pressure at time t (Pa). */
export function facePressure(a: Arrival, C: number, tc: number, t: number): number {
  const p = pressure(a, t);
  if (p === 0 || C === 1) return p;
  const tau = t - a.t;
  return p * (1 + (C - 1) * Math.max(0, 1 - tau / Math.max(1e-9, tc)));
}

/** Breakpoints of a wave (shock, clearing end, zero crossing, rear shock) — for piecewise integration. */
export function breakpoints(a: Arrival, tc: number, out: number[]) {
  out.push(a.t, a.t + a.T);
  if (tc > 0) out.push(a.t + tc);
  if (a.waveform === 'nWave') out.push(a.t + 2 * a.T);
}

/**
 * ∫ f(t) dt over [t0, t1] for a function that is polynomial of degree ≤ 3 between the given
 * breakpoints (two-point Gauss–Legendre per segment — exact for cubics, and never evaluates f at a
 * discontinuity). Used for the drag of the blast wind (∝ u·|u|, quadratic between breakpoints).
 */
export function integratePiecewise(f: (t: number) => number, t0: number, t1: number, bps: number[]): number {
  if (t1 <= t0) return 0;
  const pts = [t0];
  for (const b of bps) if (b > t0 && b < t1) pts.push(b);
  pts.push(t1);
  pts.sort((x, y) => x - y);
  const g = 0.5 / Math.sqrt(3);
  let s = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1], h = b - a;
    if (h <= 0) continue;
    const m = 0.5 * (a + b);
    s += 0.5 * h * (f(m - g * h) + f(m + g * h));
  }
  return s;
}

/** Peak of the superposed pressure of several waves at one point (max over the shock fronts). */
export function peakOf(waves: readonly Arrival[]): number {
  let best = 0;
  for (const w of waves) {
    let p = 0;
    for (const v of waves) p += pressure(v, w.t);
    if (p > best) best = p;
  }
  return best;
}

/** Positive impulse ∫ max(0, Σp) dt of superposed waves (Pa·s), exact (linear pieces, roots split). */
export function positiveImpulseOf(waves: readonly Arrival[]): number {
  if (waves.length === 1) return positiveImpulse(waves[0]);
  const pts: number[] = [];
  for (const w of waves) breakpoints(w, 0, pts);
  pts.sort((x, y) => x - y);
  let s = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    if (b <= a) continue;
    // Linear between breakpoints: evaluate just inside the ends.
    const e = (b - a) * 1e-9;
    let pa = 0, pb = 0;
    for (const w of waves) { pa += pressure(w, a + e); pb += pressure(w, b - e); }
    if (pa >= 0 && pb >= 0) s += 0.5 * (pa + pb) * (b - a);
    else if (pa > 0 || pb > 0) {
      const r = a + ((b - a) * pa) / (pa - pb);
      s += pa > 0 ? 0.5 * pa * (r - a) : 0.5 * pb * (b - r);
    }
  }
  return s;
}
