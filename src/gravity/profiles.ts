/**
 * Time profiles of a gravity experiment (Phase 31): the blend s(t) between the project gravity (s = 0) and the
 * experiment's target (s = 1) on the instance's local time t (s, 0 = start). Inside [0, duration):
 *
 *   constant    1 from t = 0 (a step change)
 *   linear      0 → 1 linearly over `ramp`, then 1
 *   smooth      0 → 1 along the quintic smootherstep 6s⁵ − 15s⁴ + 10s³ over `ramp` (zero slope AND curvature at both
 *               ends: the jerk of the field stays finite — no kick to resting bodies)
 *   staged      piecewise constant: 0 until the first stage, then each stage's blend (any real value: 0.5 = halfway,
 *               2 = twice the change)
 *   cyclic      (1 − cos 2πt/P)/2 — from 0 at t = 0 to 1 at P/2 and back
 *   pulse       1 for `pulseWidth` at the start of every period, with quintic edges of ramp (0 = square pulses)
 *   scheduled   1 inside the listed [on, off) windows, 0 outside
 *
 * The profile is a pure function of t — every step size samples the same field (tested); what a step does with it
 * (mid-step sampling in the solvers) is the integrator's business.
 */
export type GravityProfileKind = 'constant' | 'linear' | 'smooth' | 'staged' | 'cyclic' | 'pulse' | 'scheduled';
export const GRAVITY_PROFILES: readonly GravityProfileKind[] = ['constant', 'linear', 'smooth', 'staged', 'cyclic', 'pulse', 'scheduled'];

export interface BlendProfile {
  profile: GravityProfileKind;
  duration: number;
  ramp?: number;
  stages?: [number, number][];
  period?: number;
  pulseWidth?: number;
  windows?: [number, number][];
}

/** Quintic smootherstep on [0, 1]. */
export const smoother = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10));

/** Blend at local time t inside the window (t clamped to [0, duration]; the caller handles the end mode). */
export function blendAt(p: BlendProfile, t: number): number {
  const tt = Math.min(Math.max(0, t), p.duration);
  switch (p.profile) {
    case 'constant': return 1;
    case 'linear': { const r = p.ramp ?? 0; return r > 0 ? Math.min(1, tt / r) : 1; }
    case 'smooth': { const r = p.ramp ?? 0; return r > 0 ? smoother(tt / r) : 1; }
    case 'staged': {
      let v = 0;
      for (const [at, val] of p.stages ?? []) if (tt >= at) v = val;
      return v;
    }
    case 'cyclic': {
      const P = p.period ?? p.duration;
      return 0.5 * (1 - Math.cos((2 * Math.PI * tt) / P));
    }
    case 'pulse': {
      const P = p.period ?? p.duration, w = Math.min(p.pulseWidth ?? P, P), r = Math.min(p.ramp ?? 0, w / 2);
      const x = tt % P;
      if (x >= w) return 0;
      if (r <= 0) return 1;
      return Math.min(smoother(x / r), smoother((w - x) / r));
    }
    case 'scheduled': {
      const at = t >= p.duration ? p.duration - 1e-9 : tt;
      return (p.windows ?? []).some(([a, b]) => at >= a && at < b) ? 1 : 0;
    }
  }
}

/** Validation problems of a blend profile (i18n keys). */
export function profileIssues(p: BlendProfile): string[] {
  const out: string[] = [];
  const D = p.duration;
  if ((p.profile === 'linear' || p.profile === 'smooth') && !(p.ramp !== undefined && p.ramp > 0 && p.ramp <= D)) out.push('gravity.invalid.ramp');
  if (p.profile === 'cyclic' && !(p.period !== undefined && p.period > 0)) out.push('gravity.invalid.period');
  if (p.profile === 'pulse') {
    if (!(p.period !== undefined && p.period > 0)) out.push('gravity.invalid.period');
    if (!(p.pulseWidth !== undefined && p.pulseWidth > 0 && p.pulseWidth <= (p.period ?? 0))) out.push('gravity.invalid.pulseWidth');
    if (p.ramp !== undefined && !(p.ramp >= 0)) out.push('gravity.invalid.ramp');
  }
  if (p.profile === 'staged') {
    const st = p.stages ?? [];
    let last = -Infinity;
    const ok = st.length > 0 && st.length <= 24 && st.every(([a, v]) => { const good = a >= 0 && a > last && a < D && Number.isFinite(v) && Math.abs(v) <= 10; last = a; return good; });
    if (!ok) out.push('gravity.invalid.stages');
  }
  if (p.profile === 'scheduled') {
    const w = p.windows ?? [];
    let last = 0;
    const ok = w.length > 0 && w.length <= 24 && w.every(([a, b]) => { const good = a >= last && b > a && b <= D; last = b; return good; });
    if (!ok) out.push('gravity.invalid.windows');
  }
  return out;
}
