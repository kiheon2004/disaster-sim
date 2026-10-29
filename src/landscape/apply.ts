/**
 * Keeping the layers, the roads and the final terrain consistent (Phase 19).
 *
 * Every change of a layer (sculpt stroke, paint, feature add / edit / delete, preset, sea level)
 * goes through `recompose`: the natural terrain is recomposed in the affected rectangle (grown
 * by the rivers passing through it), then the roads overlapping that rectangle are baked on
 * the NEW natural terrain. The final terrain therefore always equals
 * bake(roads, compose(layers)) — deleting a road shows the current natural ground (with every
 * later sculpt / feature), and editing nature under a road re-grades the road.
 */
import type { TerrainData } from '@/core/model';
import type { GridRect } from '@/terrain/TerrainData';
import { bakeRegion, reach, segmentBounds, type Natural } from '@/roads/bake';
import { intersectionsOf } from '@/roads/intersections';
import type { RoadNetwork } from '@/roads/types';
import { composeRect, createLandscape, expandForRivers, rectOfBox, unionRects } from './compose';
import type { Landscape } from './types';

export function naturalProvider(land: Landscape): Natural {
  const { heights, ground } = land.natural;
  return { height: (i) => heights[i], ground: (i) => ground[i] };
}

const overlaps = (a: GridRect, b: GridRect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;

/**
 * `rect` grown by every road whose influence overlaps it (whole segments: graded profiles
 * depend on the natural ground along the whole segment) and the junction areas at their ends.
 */
export function roadInfluence(t: TerrainData, roads: RoadNetwork, rect: GridRect): GridRect {
  let out = rect;
  const nodes = new Set<string>();
  for (const s of Object.values(roads.segments)) {
    const r = rectOfBox(t, segmentBounds(roads, s));
    if (r && overlaps(r, rect)) {
      out = unionRects(out, r)!;
      nodes.add(s.a);
      nodes.add(s.b);
    }
  }
  if (!nodes.size) return out;
  const ints = intersectionsOf(roads);
  for (const id of nodes) {
    const ix = ints.get(id);
    if (!ix) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, r = 0;
    for (const poly of [ix.surface, ...ix.corners.map((c) => c.poly)]) for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    for (const road of ix.roads) r = Math.max(r, reach(road.segment));
    out = unionRects(out, rectOfBox(t, [x0 - r, z0 - r, x1 + r, z1 + r]))!;
  }
  return out;
}

/**
 * Recompose the natural terrain in `rect` (grown by rivers) and re-bake the final terrain there
 * (grown by the roads). Writes terrain / landscape arrays in place. Returns the final
 * rectangle that may have changed (natural ⊆ final) and the roads with their refreshed underlay.
 */
export function recompose(t: TerrainData, land: Landscape, roads: RoadNetwork, rect: GridRect, seaLevel: number): { natural: GridRect; final: GridRect; roads: RoadNetwork } {
  const nat = expandForRivers(land, t, rect);
  composeRect(land, t, nat, seaLevel);
  const fin = roadInfluence(t, roads, nat);
  const res = bakeRegion(t, roads, roads, fin, naturalProvider(land));
  t.revision++;
  return { natural: nat, final: fin, roads: { ...roads, underlay: res.underlay } };
}

// ── Layer patches (undo / redo of the per-vertex layers) ─────────────────────────────

type LayerName = 'baseHeights' | 'baseGround' | 'sculpt' | 'paint' | 'naturalHeights' | 'naturalGround';

function layer(land: Landscape, name: LayerName): Float32Array | Uint8Array {
  switch (name) {
    case 'baseHeights': return land.base.heights;
    case 'baseGround': return land.base.ground;
    case 'sculpt': return land.sculpt;
    case 'paint': return land.paint;
    case 'naturalHeights': return land.natural.heights;
    case 'naturalGround': return land.natural.ground;
  }
}

export type LayerSnapshot = Partial<Record<LayerName, Float32Array | Uint8Array>>;

/** Full copies of the named layers (taken before an edit). */
export function snapshotLandscape(land: Landscape, names: LayerName[] = ['sculpt', 'paint', 'naturalHeights', 'naturalGround']): LayerSnapshot {
  const out: LayerSnapshot = {};
  for (const n of names) out[n] = layer(land, n).slice();
  return out;
}

export interface LayerPatch {
  rect: GridRect;
  layers: { name: LayerName; before: Float32Array | Uint8Array; after: Float32Array | Uint8Array }[];
}

function copyRect<A extends Float32Array | Uint8Array>(src: A, nx: number, r: GridRect): A {
  const w = r.x1 - r.x0 + 1;
  const out = new (src.constructor as { new (n: number): A })(w * (r.z1 - r.z0 + 1));
  for (let z = r.z0; z <= r.z1; z++) out.set(src.subarray(z * nx + r.x0, z * nx + r.x1 + 1), (z - r.z0) * w);
  return out;
}

export function makeLayerPatch(land: Landscape, nx: number, before: LayerSnapshot, rect: GridRect): LayerPatch {
  return {
    rect,
    layers: (Object.keys(before) as LayerName[]).map((name) => ({ name, before: copyRect(before[name]!, nx, rect), after: copyRect(layer(land, name), nx, rect) })),
  };
}

export function applyLayerPatch(land: Landscape, nx: number, p: LayerPatch, side: 'before' | 'after') {
  const w = p.rect.x1 - p.rect.x0 + 1;
  for (const l of p.layers) {
    const dst = layer(land, l.name);
    const src = side === 'before' ? l.before : l.after;
    for (let z = p.rect.z0; z <= p.rect.z1; z++) dst.set(src.subarray((z - p.rect.z0) * w, (z - p.rect.z0 + 1) * w), z * nx + p.rect.x0);
  }
}

/**
 * A document whose terrain was written directly (older code paths, tools, tests) may carry layers
 * that no longer compose to it. Rebuild the landscape from the terrain in that case (natural =
 * terrain with the road underlay put back, as the base; no sculpt / paint / features). Returns
 * the same landscape when it is consistent.
 */
export function adoptTerrain(t: TerrainData, roads: RoadNetwork, land: Landscape | undefined): Landscape {
  const nat = { heights: t.heights.slice(), ground: t.ground.slice() };
  roads.underlay.idx.forEach((i, k) => { nat.heights[i] = roads.underlay.h[k]; nat.ground[i] = roads.underlay.g[k]; });
  if (land && land.natural.heights.length === nat.heights.length) {
    let same = true;
    for (let i = 0; i < nat.heights.length && same; i++) same = land.natural.heights[i] === nat.heights[i] && land.natural.ground[i] === nat.ground[i];
    if (same) return land;
  }
  return createLandscape(nat);
}
