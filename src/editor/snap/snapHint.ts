/** What the cursor is snapped to right now (Phase 36 §13) — shown in the viewport hint and as a 3D marker; UI state only. */
import type { SnapKind } from './snapEngine';

let current: SnapKind | null = null;
let point: [number, number] | null = null;
const listeners = new Set<() => void>();

export const snapHint = {
  get: (): SnapKind | null => current,
  /** Ground point (x, z) of the current snap target, or null. */
  point: (): [number, number] | null => point,
  set: (k: SnapKind | null, at?: [number, number]) => {
    const p = k && at ? at : null;
    if (k === current && (p?.[0] ?? NaN) === (point?.[0] ?? NaN) && (p?.[1] ?? NaN) === (point?.[1] ?? NaN)) return;
    current = k;
    point = p;
    for (const l of listeners) l();
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
