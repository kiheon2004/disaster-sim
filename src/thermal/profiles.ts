/**
 * Time profiles of heat sources (Phase 26). A profile is a dimensionless shape s(t) ∈ [0, 1] on the
 * source's local time [0, duration); its EXACT integral over any interval is what the solver adds,
 * so the total heat delivered does not depend on the thermal time step (tested).
 *
 *  instant    all of the energy at t = 0 (Dirac: ∫ over [a, b) is 1 when a ≤ 0 < b)
 *  constant   1 for the whole duration
 *  ramp       linear 0 → 1 over rampTime, then 1
 *  pulse      1 for pulseWidth at the start of every period (a single pulse when period ≥ duration)
 *  schedule   1 inside the listed [on, off) intervals (scheduled on / off)
 */
export type ProfileKind = 'instant' | 'constant' | 'ramp' | 'pulse' | 'schedule';
export const PROFILE_KINDS: readonly ProfileKind[] = ['instant', 'constant', 'ramp', 'pulse', 'schedule'];

export interface ProfileSpec {
  profile: ProfileKind;
  duration: number;
  rampTime?: number;
  pulseWidth?: number;
  period?: number;
  schedule?: [number, number][];
}

/** Value of the shape at local time t (instant: 0 — it has no finite value). */
export function shapeAt(p: ProfileSpec, t: number): number {
  if (t < 0 || t >= p.duration) return 0;
  switch (p.profile) {
    case 'instant': return 0;
    case 'constant': return 1;
    case 'ramp': { const r = p.rampTime ?? 0; return r > 0 ? Math.min(1, t / r) : 1; }
    case 'pulse': { const P = p.period ?? p.duration, w = p.pulseWidth ?? P; return t % P < w ? 1 : 0; }
    case 'schedule': return (p.schedule ?? []).some(([a, b]) => t >= a && t < b) ? 1 : 0;
  }
}

/** ∫₀^x of a ramp shape (no clipping to the duration). */
const rampInt = (r: number, x: number) => (x <= 0 ? 0 : r <= 0 ? x : x <= r ? (x * x) / (2 * r) : r / 2 + (x - r));
/** ∫₀^x of a pulse train. */
function pulseInt(P: number, w: number, x: number): number {
  if (x <= 0) return 0;
  const n = Math.floor(x / P);
  return n * Math.min(w, P) + Math.min(w, x - n * P);
}

/** ∫ s(t) dt over [a, b) ∩ [0, duration) — exact. Instant: 1 when the interval contains t = 0. */
export function shapeIntegral(p: ProfileSpec, a: number, b: number): number {
  if (p.profile === 'instant') return a <= 0 && 0 < b ? 1 : 0;
  const lo = Math.max(0, a), hi = Math.min(p.duration, b);
  if (hi <= lo) return 0;
  switch (p.profile) {
    case 'constant': return hi - lo;
    case 'ramp': { const r = p.rampTime ?? 0; return rampInt(r, hi) - rampInt(r, lo); }
    case 'pulse': { const P = p.period ?? p.duration, w = p.pulseWidth ?? P; return pulseInt(P, w, hi) - pulseInt(P, w, lo); }
    case 'schedule': {
      let s = 0;
      for (const [on, off] of p.schedule ?? []) s += Math.max(0, Math.min(hi, off) - Math.max(lo, on));
      return s;
    }
  }
}

/** Integral of the shape over the whole profile (s·s for time-based shapes; 1 for instant). */
export const shapeTotal = (p: ProfileSpec) => (p.profile === 'instant' ? 1 : shapeIntegral(p, 0, p.duration));

/** Validation problems of a profile (i18n keys), empty when valid. */
export function profileIssues(p: ProfileSpec): string[] {
  const out: string[] = [];
  if (!(p.duration > 0)) out.push('thermal.invalid.duration');
  if (p.profile === 'ramp' && !(p.rampTime !== undefined && p.rampTime > 0 && p.rampTime <= p.duration)) out.push('thermal.invalid.ramp');
  if (p.profile === 'pulse') {
    if (!(p.period !== undefined && p.period > 0)) out.push('thermal.invalid.period');
    if (!(p.pulseWidth !== undefined && p.pulseWidth > 0 && p.pulseWidth < (p.period ?? 0))) out.push('thermal.invalid.pulseWidth');
  }
  if (p.profile === 'schedule') {
    const s = p.schedule ?? [];
    let last = 0;
    const ok = s.length > 0 && s.every(([a, b]) => { const good = a >= last && b > a && b <= p.duration; last = b; return good; });
    if (!ok) out.push('thermal.invalid.schedule');
  }
  return out;
}
