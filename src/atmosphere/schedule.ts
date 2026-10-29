/**
 * Planned air-mass path of an atmosphere experiment (Phase 29), as a share of the initial mass f(t) at
 * instance-local time t. Closed forms — the mass a removal takes over any step is f(t₀) − f(t₁) of the
 * initial mass, so the total removed does not depend on the step (tested).
 *
 *  linear       f = 1 − (1 − target)·min(1, t/D)
 *  exponential  f = target^min(1, t/D)            (rate ∝ remaining mass: a leak)
 *  scheduled    f = 1 − (1 − target)·on(t)/on(D)   (constant rate inside the [on, off) intervals)
 *  pressure     the same path as linear, but used as a pressure TARGET (feedback on the mean pressure)
 *  restoration  linear from the share at its start to restoreTarget over restoreDuration
 */
import type { AtmosphereSpec } from './types';

/** Time spent inside the schedule's intervals up to t. */
function onTime(sch: readonly [number, number][], t: number): number {
  let s = 0;
  for (const [a, b] of sch) if (t > a) s += Math.min(t, b) - a;
  return s;
}

/** Planned share of the initial mass by the removal alone (1 before it starts). */
export function removalShare(s: AtmosphereSpec, t: number): number {
  if (s.removal === 'none' || t <= 0) return 1;
  const D = s.duration ?? 1, tg = s.target ?? 1;
  const x = Math.min(1, t / D);
  switch (s.removal) {
    case 'linear':
    case 'pressure': return 1 - (1 - tg) * x;
    // A leak never empties a vessel in finite time: a zero target decays like 10⁻⁶ and ends at 0.
    case 'exponential': return x >= 1 ? tg : Math.pow(Math.max(tg, 1e-6), x);
    case 'scheduled': {
      const sch = s.schedule ?? [];
      const total = onTime(sch, D);
      return total > 0 ? 1 - (1 - tg) * (onTime(sch, Math.min(t, D)) / total) : 1;
    }
  }
}

/** Share at the end of the removal (the restoration starts from the measured share; this is the plan's). */
export const removalFinal = (s: AtmosphereSpec) => (s.removal === 'none' ? 1 : s.target ?? 1);

/** Restoration progress (0 before, 1 after) at instance-local time t. */
export function restoreProgress(s: AtmosphereSpec, t: number): number {
  if (!s.restore || s.restore === 'none') return 0;
  const a = s.restoreAt ?? 0, d = s.restoreDuration ?? 1;
  return t <= a ? 0 : Math.min(1, (t - a) / d);
}

/** Planned share of the initial mass (removal, then restoration from the plan's end share). */
export function plannedShare(s: AtmosphereSpec, t: number): number {
  const r = restoreProgress(s, t);
  const f = removalShare(s, t);
  if (r <= 0) return f;
  const from = removalShare(s, s.restoreAt ?? 0);
  return from + ((s.restoreTarget ?? 1) - from) * r;
}

/** Samples of the planned path for the preview chart: [t, share]. */
export function plannedPath(s: AtmosphereSpec, n = 64): [number, number][] {
  const end = Math.max(s.removal === 'none' ? 0 : s.duration ?? 0, s.restore && s.restore !== 'none' ? (s.restoreAt ?? 0) + (s.restoreDuration ?? 0) : 0, 60);
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (end * i) / n;
    out.push([t, plannedShare(s, t)]);
  }
  return out;
}

/** Length of the experiment's scheduled changes (s) — the instance's timeline duration. */
export function atmosphereDuration(s: AtmosphereSpec): number {
  const r = s.restore && s.restore !== 'none' ? (s.restoreAt ?? 0) + (s.restoreDuration ?? 0) : 0;
  return Math.max(removalEnd(s), r, 60);
}

const removalEnd = (s: AtmosphereSpec) => (s.removal === 'none' ? 0 : s.duration ?? 0);
