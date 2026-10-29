/**
 * From the experiment plan to one step's forcing (Phase 29, pure). The removal paths are closed forms
 * (schedule.ts), so the mass a planned removal takes over [t₀, t₁) is M₀·(f(t₀) − f(t₁)) whatever the
 * step; `pressure` removal and `reservoir` restoration are feedback on the measured mean reduced
 * pressure (the mass they move is what the path requires, p = σ·g); `boundary` restoration only
 * raises the background pressure at an open edge — the air comes in through the solved flow.
 */
import type { AtmosphereField, StepForcing } from './AtmosphereField';
import { removalShare, restoreProgress } from './schedule';
import type { AtmosphereSpec } from './types';

export interface PlanState {
  /** Measured share when the restoration began (null before). */
  restoreFrom: number | null;
  /** Local disc columns and weights (sum 1). */
  cols: number[];
  w: number[];
}

/** Columns whose centres lie in the disc (at least the one containing the centre), equal weights. */
export function discColumns(f: AtmosphereField, x: number, z: number, r: number): { cols: number[]; w: number[] } {
  const cols: number[] = [];
  for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) {
    const cx = f.originX + (ix + 0.5) * f.dx, cz = f.originZ + (iz + 0.5) * f.dx;
    if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) cols.push(iz * f.nx + ix);
  }
  if (!cols.length) { const a = f.index(x, z); if (a >= 0) cols.push(a); }
  return { cols, w: cols.map(() => 1 / Math.max(1, cols.length)) };
}

export function initPlan(spec: AtmosphereSpec, f: AtmosphereField): PlanState {
  const local = spec.extent === 'local' && spec.position ? discColumns(f, spec.position[0], spec.position[1], spec.radius ?? 25) : { cols: [], w: [] };
  return { restoreFrom: null, ...local };
}

/**
 * Forcing for instance-local [t0, t1). `layerT` / `updraft` / `Tin` / `gas` are filled by the caller.
 * Before the instance starts (t1 ≤ 0) nothing changes.
 */
export function planForcing(spec: AtmosphereSpec, f: AtmosphereField, st: PlanState, t0: number, t1: number): Omit<StepForcing, 'layerT' | 'updraft' | 'Tin'> {
  const out: Omit<StepForcing, 'layerT' | 'updraft' | 'Tin'> = { bgShare: 1 };
  const M0 = f.mass.initial;
  const local = spec.extent === 'local' && st.cols.length > 0;
  const uniform = !local;
  const M = f.totalMass();
  const now = f.share();
  // Removal.
  if (spec.removal !== 'none' && t1 > 0 && t0 < (spec.duration ?? 0)) {
    let dm = 0;
    if (spec.removal === 'pressure') {
      const target = removalShare(spec, Math.max(0, t1));
      if (now > target) dm = M * (1 - target / now);
    } else dm = M0 * (removalShare(spec, Math.max(0, t0)) - removalShare(spec, t1));
    if (dm > 0) {
      if (uniform) out.removeShare = Math.min(1, dm / M);
      else out.local = { cols: st.cols, w: st.w, kg: -dm };
    }
  }
  // Restoration.
  const r1 = restoreProgress(spec, t1);
  if (r1 > 0 && spec.restore && spec.restore !== 'none') {
    if (st.restoreFrom === null) st.restoreFrom = now;
    const from = st.restoreFrom, to = spec.restoreTarget ?? 1;
    const target = from + (to - from) * r1;
    if (spec.restore === 'reservoir') {
      const need = now < target ? M * (target / now - 1) : 0;
      if (need > 0) {
        if (uniform) out.addMass = need;
        else out.local = { cols: st.cols, w: st.w, kg: need };
      }
    } else out.bgShare = target;
  }
  // Background state at an open edge: a uniform change is the surroundings' too.
  if (!(r1 > 0 && spec.restore === 'boundary')) {
    if (uniform && spec.removal !== 'none') {
      out.bgShare = spec.removal === 'pressure' ? removalShare(spec, Math.max(0, t1)) : removalShare(spec, Math.max(0, t1));
      if (r1 > 0 && st.restoreFrom !== null) {
        const from = st.restoreFrom, to = spec.restoreTarget ?? 1;
        out.bgShare = from + (to - from) * r1;
      }
    }
  }
  return out;
}
