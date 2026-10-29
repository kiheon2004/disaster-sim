/**
 * Eruption timing (Phase 28): the supply rate Q(t) = Q₀·s(t) on the eruption's local time and its EXACT
 * integral over any interval, so the erupted mass does not depend on the step length (tested).
 *
 *  constant / ramp / pulse   the Phase 26 heat-source shapes (thermal/profiles.ts) — reused
 *  staged                    equal-length stages at the given relative levels
 *  wane                      constant, then a linear decline to 0 over `declineTime` ending at the scheduled stop
 *
 * Phase of the eruption at a local time: dormant (before 0), starting (ramp-up / first stage below its
 * peak), active, declining (wane decline / stage lower than the peak after it), stopped (after the end).
 */
import { shapeAt, shapeIntegral } from '@/thermal/profiles';
import { profileOf, type VolcanoSpec } from './types';

export type EruptionPhase = 'dormant' | 'starting' | 'active' | 'declining' | 'stopped';
export const ERUPTION_PHASES: readonly EruptionPhase[] = ['dormant', 'starting', 'active', 'declining', 'stopped'];

function stagedInt(levels: readonly number[], D: number, lo: number, hi: number): number {
  const n = levels.length, L = D / n;
  let s = 0;
  for (let k = 0; k < n; k++) s += levels[k] * Math.max(0, Math.min(hi, (k + 1) * L) - Math.max(lo, k * L));
  return s;
}

/** ∫₀^x of the wane shape (1 until D − d, then linear to 0 at D). */
function waneInt(D: number, d: number, x: number): number {
  const a = D - d;
  if (x <= a) return x;
  const y = Math.min(x, D) - a;
  return a + y - (y * y) / (2 * d);
}

/** Shape s(t) ∈ [0, 1]. */
export function eruptionShape(s: VolcanoSpec, t: number): number {
  if (t < 0 || t >= s.duration) return 0;
  const p = profileOf(s);
  if (p) return shapeAt(p, t);
  if (s.profile === 'staged') {
    const st = s.stages ?? [1];
    return st[Math.min(st.length - 1, Math.floor((t / s.duration) * st.length))];
  }
  const d = s.declineTime ?? s.duration / 4;
  return t < s.duration - d ? 1 : (s.duration - t) / d;
}

/** ∫ s dt over [a, b) ∩ [0, duration) — exact. */
export function eruptionIntegral(s: VolcanoSpec, a: number, b: number): number {
  const lo = Math.max(0, a), hi = Math.min(s.duration, b);
  if (hi <= lo) return 0;
  const p = profileOf(s);
  if (p) return shapeIntegral(p, lo, hi);
  if (s.profile === 'staged') return stagedInt(s.stages ?? [1], s.duration, lo, hi);
  const d = s.declineTime ?? s.duration / 4;
  return waneInt(s.duration, d, hi) - waneInt(s.duration, d, lo);
}

/** Bulk lava volume supplied over [a, b) (m³) — all products together (lava + bombs + ash, bulk). */
export const suppliedVolume = (s: VolcanoSpec, a: number, b: number) => s.rate * eruptionIntegral(s, a, b);

/** Total bulk volume of the eruption (m³). */
export const totalVolume = (s: VolcanoSpec) => suppliedVolume(s, 0, s.duration);

/** Local time of the peak supply (first time the shape reaches its maximum). */
export function peakTime(s: VolcanoSpec): number {
  if (s.profile === 'ramp') return Math.min(s.duration, s.rampTime ?? s.duration / 4);
  if (s.profile === 'staged') {
    const st = s.stages ?? [1];
    const m = Math.max(...st);
    return (st.indexOf(m) * s.duration) / st.length;
  }
  return 0;
}

export function eruptionPhase(s: VolcanoSpec, t: number): EruptionPhase {
  if (t < 0) return 'dormant';
  if (t >= s.duration) return 'stopped';
  const v = eruptionShape(s, t);
  if (s.profile === 'ramp') return t < (s.rampTime ?? s.duration / 4) ? 'starting' : 'active';
  if (s.profile === 'wane') return t < s.duration - (s.declineTime ?? s.duration / 4) ? 'active' : 'declining';
  if (s.profile === 'staged') {
    const st = s.stages ?? [1];
    const m = Math.max(...st), tp = peakTime(s);
    if (v >= m) return 'active';
    return t < tp ? 'starting' : 'declining';
  }
  // Pulses between their bursts are still an active eruption.
  return 'active';
}
