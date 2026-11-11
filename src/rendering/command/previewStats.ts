/**
 * Phase 37 — what the command preview layer draws right now, for `window.__ds.command.preview()` (browser
 * verification reads it; nothing in the app does). Each mounted layer keeps its own entry current: the counts of what
 * it was given to draw, and its root group — `sceneObjects` is counted from the scene graph itself when asked, so
 * "no leftover ghosts" is a statement about the scene, not about the layer's opinion of it.
 */
import { emptyCounts, type PreviewCounts } from './previewModel';

/** The part of a three.js Object3D the count needs. */
export interface CountedRoot {
  traverse(visit: (o: unknown) => void): void;
}

export interface LayerReport {
  counts: PreviewCounts;
  /** The open plan (after Enter) is drawn — false: a draft while typing; null: no plan. */
  armed: boolean | null;
  /** Identity of the plan the GPU objects were built for (previewModel.ts `previewKey`); null: no plan. */
  key: string | null;
  /** How many times this layer built a model (a new key) since it was mounted. */
  builds: number;
  root: () => CountedRoot | null;
}

export interface PreviewStats extends PreviewCounts {
  /** three.js objects under the preview layers' roots (0 = nothing of a preview is in the scene). */
  sceneObjects: number;
  armed: boolean | null;
  key: string | null;
  builds: number;
  /** Preview layers mounted (one per scene; 0 = no scene with a preview layer). */
  layers: number;
}

const layers = new Map<object, LayerReport>();

export function reportLayer(owner: object, report: LayerReport): void {
  layers.set(owner, report);
}

export function forgetLayer(owner: object): void {
  layers.delete(owner);
}

function descendants(root: CountedRoot | null): number {
  if (!root) return 0;
  let n = -1; // (traverse visits the root itself first)
  root.traverse(() => { n++; });
  return Math.max(0, n);
}

export function previewStats(): PreviewStats {
  const out: PreviewStats = { ...emptyCounts(), sceneObjects: 0, armed: null, key: null, builds: 0, layers: layers.size };
  for (const r of layers.values()) {
    const c = r.counts;
    out.ghosts += c.ghosts; out.warned += c.warned; out.rejected += c.rejected; out.moved += c.moved; out.removed += c.removed; out.changed += c.changed;
    out.roads += c.roads; out.pins += c.pins; out.snaps += c.snaps; out.highlight += c.highlight;
    if (c.terrain) out.terrain = { ...c.terrain };
    if (r.armed !== null) out.armed = r.armed;
    if (r.key !== null) out.key = r.key;
    out.builds += r.builds;
    out.sceneObjects += descendants(r.root());
  }
  return out;
}
