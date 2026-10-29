/**
 * Time profiles of the climate forcing (Phase 30), on the instance's local time t (s, 0 = start).
 *
 * Temperature (and with it the background humidity, which follows the same shape):
 *   constant    the target value from t = 0 (a step change)
 *   linear      start → target linearly over `ramp`, then the target
 *   smooth      start → target along a cubic smoothstep 3s² − 2s³ over `ramp` (no kink at either end)
 *   staged      piecewise constant: the start value until the first stage, then each stage's value
 *   cyclic      a daily-type cycle between start (minimum, at t = 0) and target (maximum, at P/2):
 *               start + (target − start)·(1 − cos 2πt/P)/2
 *   scheduled   the target inside the listed [on, off) windows, the start value outside (scheduled events)
 * After the duration every value holds its end value (the forcing does not snap back); precipitation stops.
 *
 * Precipitation intensity (rate × shape, shape ∈ [0, 1]) inside its window [start, start + duration):
 *   constant · rampUp (linear 0 → 1 over `ramp`, then 1) · peak (triangle, maximum mid-window) ·
 *   scheduled (1 inside windows). Its integral over ANY interval is exact (closed forms), so the
 *   precipitation total does not depend on the step (tested).
 */
export type ClimateProfileKind = 'constant' | 'linear' | 'smooth' | 'staged' | 'cyclic' | 'scheduled';
export const CLIMATE_PROFILES: readonly ClimateProfileKind[] = ['constant', 'linear', 'smooth', 'staged', 'cyclic', 'scheduled'];
export type PrecipProfileKind = 'constant' | 'rampUp' | 'peak' | 'scheduled';
export const PRECIP_PROFILES: readonly PrecipProfileKind[] = ['constant', 'rampUp', 'peak', 'scheduled'];

export interface ValueProfile {
  profile: ClimateProfileKind;
  duration: number;
  ramp?: number;
  /** staged: [local time s, value] sorted by time. */
  stages?: [number, number][];
  /** cyclic period (s). */
  period?: number;
  /** scheduled windows [on, off) (local s). */
  windows?: [number, number][];
}

/** Value of a profile between `from` and `to` at local time t. */
export function valueAt(p: ValueProfile, from: number, to: number, t: number): number {
  const tt = Math.min(Math.max(0, t), p.duration);
  switch (p.profile) {
    case 'constant': return to;
    case 'linear': { const r = p.ramp ?? 0; return r > 0 ? from + (to - from) * Math.min(1, tt / r) : to; }
    case 'smooth': {
      const r = p.ramp ?? 0;
      if (!(r > 0)) return to;
      const s = Math.min(1, tt / r);
      return from + (to - from) * s * s * (3 - 2 * s);
    }
    case 'staged': {
      let v = from;
      for (const [at, val] of p.stages ?? []) if (tt >= at) v = val;
      return v;
    }
    case 'cyclic': {
      const P = p.period ?? 86400;
      return from + (to - from) * 0.5 * (1 - Math.cos((2 * Math.PI * tt) / P));
    }
    case 'scheduled': {
      // Inside a window the target; at / after the duration the value at the last instant before it.
      const at = t >= p.duration ? p.duration - 1e-9 : tt;
      return (p.windows ?? []).some(([a, b]) => at >= a && at < b) ? to : from;
    }
  }
}

/** Shape s ∈ [0, 1] of a value profile ((v − from)/(to − from); staged uses its stage values). */
export function shapeOf(p: ValueProfile, from: number, to: number, t: number): number {
  const v = valueAt(p, from, to, t);
  if (p.profile === 'staged') {
    const st = p.stages ?? [];
    const last = st.length ? st[st.length - 1][1] : from;
    return last === from ? 0 : Math.max(0, Math.min(1, (v - from) / (last - from)));
  }
  return to === from ? (p.profile === 'constant' ? 1 : 0) : Math.max(0, Math.min(1, (v - from) / (to - from)));
}

/** Last value of a staged profile, or the target. */
export const endValue = (p: ValueProfile, from: number, to: number) => valueAt(p, from, to, p.duration);

export interface PrecipProfile {
  profile: PrecipProfileKind;
  /** Window start and length (local s). */
  start: number;
  duration: number;
  ramp?: number;
  windows?: [number, number][];
}

/** Precipitation shape at local time t (window-relative). */
export function precipShape(p: PrecipProfile, t: number): number {
  const x = t - p.start;
  if (x < 0 || x >= p.duration) return 0;
  switch (p.profile) {
    case 'constant': return 1;
    case 'rampUp': { const r = p.ramp ?? 0; return r > 0 ? Math.min(1, x / r) : 1; }
    case 'peak': { const h = p.duration / 2; return x <= h ? x / h : (p.duration - x) / h; }
    case 'scheduled': return (p.windows ?? []).some(([a, b]) => x >= a && x < b) ? 1 : 0;
  }
}

/** ∫₀^x of the shape on window time (exact, no clipping). */
function cumulative(p: PrecipProfile, x: number): number {
  if (x <= 0) return 0;
  const D = p.duration;
  const xx = Math.min(x, D);
  switch (p.profile) {
    case 'constant': return xx;
    case 'rampUp': { const r = p.ramp ?? 0; if (!(r > 0)) return xx; return xx <= r ? (xx * xx) / (2 * r) : r / 2 + (xx - r); }
    case 'peak': {
      const h = D / 2;
      if (xx <= h) return (xx * xx) / (2 * h);
      const y = D - xx;
      return D / 2 - (y * y) / (2 * h);
    }
    case 'scheduled': {
      let s = 0;
      for (const [a, b] of p.windows ?? []) s += Math.max(0, Math.min(xx, b) - Math.max(0, a));
      return s;
    }
  }
}

/** ∫ shape dt over local [a, b) — exact for any interval (the step never changes the total). */
export const precipIntegral = (p: PrecipProfile, a: number, b: number) => (b <= a ? 0 : cumulative(p, b - p.start) - cumulative(p, a - p.start));

/** Whole-window integral of the shape (s). */
export const precipTotalShape = (p: PrecipProfile) => cumulative(p, p.duration);
