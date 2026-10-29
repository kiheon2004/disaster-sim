/**
 * Removal preview of the building editor (Phase 25): what happens when members are removed
 * SUDDENLY from the original world — an alternate-path check in the spirit of the GSA (2016)
 * guidelines, run with exactly the simulation's collapse model (redistribution rounds with the
 * dynamic increase, falling blocks crushing or arrested by the floors below), without any hazard.
 * Pure: the design is never modified.
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import type { BuildingDesign } from '@/buildings/types';
import { graphOf } from './graph';
import { CollapseModel } from './collapse';
import { MS } from './types';

export interface RemovalPreview {
  removed: string[];
  /** Members that failed / fell because of the removal (ids), in order. */
  failed: { id: string; cause: string; time: number; trigger: string | null }[];
  level: ReturnType<CollapseModel['collapseLevel']>;
  /** Superstructure mass that came down (kg) and its share. */
  fallen: number;
  share: number;
  impacts: number;
  arrests: number;
  /** Simulated time until everything came to rest (s) and the computing time (ms). */
  seconds: number;
  ms: number;
}

export function removalPreview(design: BuildingDesign, ids: readonly string[], scale: Vec3 = [1, 1, 1], maxSeconds = 30): RemovalPreview {
  const t0 = performance.now();
  const g = graphOf(design, scale);
  const m = new CollapseModel(g);
  m.init();
  const idx = ids.map((id) => design.members.findIndex((x) => x.id === id)).filter((i) => i >= 0);
  m.fail(idx, 'removed', 'preview', 0);
  let t = 0;
  const dt = 1 / 60;
  while (m.active && t < maxSeconds) { m.step(dt, t, undefined, GRAVITY); t += dt; }
  const removed = new Set(idx);
  const failed = m.records.filter((r) => !removed.has(r.i)).map((r) => ({ id: design.members[r.i].id, cause: r.cause, time: r.time, trigger: r.trigger >= 0 ? design.members[r.trigger].id : null }));
  let fallen = 0;
  for (let i = 0; i < m.n; i++) if (g.level[i] >= 0 && m.state[i] > MS.SEVERE && m.state[i] !== MS.ABSENT && !removed.has(i)) fallen += g.mass[i];
  return {
    removed: idx.map((i) => design.members[i].id), failed, level: m.collapseLevel(), fallen, share: m.superMass > 0 ? fallen / m.superMass : 0,
    impacts: m.events.filter((e) => e.kind === 'impact').length, arrests: m.events.filter((e) => e.kind === 'impact' && e.arrested).length,
    seconds: t, ms: performance.now() - t0,
  };
}
