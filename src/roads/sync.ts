/**
 * Keeping roads and terrain consistent (Phase 18) when the TERRAIN is edited (brush strokes,
 * presets) rather than the roads.
 *
 * The brush works on the baked terrain. After a stroke, every road-covered vertex inside the
 * stroke rectangle takes the brush change into its natural (underlay) value — raising the hill
 * under a road raises the natural ground there — and the roads touching the rectangle are
 * re-baked over the new natural ground: a graded road is re-graded, a follow road follows, the
 * sidewalk / curb geometry is restored. The roads never silently disappear under a brush.
 */
import type { TerrainData } from '@/core/model';
import { fullRect, unionRect, type GridRect } from '@/terrain/TerrainData';
import { bakeRegion, segmentBounds } from './bake';
import type { RoadNetwork } from './types';

type Layers = { heights: Float32Array; ground: Uint8Array };

function rectOfBox(t: TerrainData, [x0, z0, x1, z1]: [number, number, number, number]): GridRect | null {
  const c = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
  const r = {
    x0: c(Math.floor((x0 - t.originX) / t.cellSize), t.nx), z0: c(Math.floor((z0 - t.originZ) / t.cellSize), t.nz),
    x1: c(Math.ceil((x1 - t.originX) / t.cellSize), t.nx), z1: c(Math.ceil((z1 - t.originZ) / t.cellSize), t.nz),
  };
  return r.x0 > r.x1 || r.z0 > r.z1 ? null : r;
}

const overlaps = (a: GridRect, b: GridRect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;

/**
 * After an in-place terrain edit of `rect` (layers `before` → current): fold the change into the
 * underlay and re-bake the affected roads. Returns the new network and the full rectangle that
 * changed (edit ∪ re-bake), or the same network when no road is affected.
 */
export function rebakeAfterTerrainEdit(t: TerrainData, roads: RoadNetwork, before: Layers, rect: GridRect): { roads: RoadNetwork; rect: GridRect } {
  if (!Object.keys(roads.segments).length) return { roads, rect };
  // Affected region: the edit plus every road whose reach overlaps it (graded profiles depend on
  // the natural ground along the whole segment), plus junctions of those roads.
  let region: GridRect | null = null;
  const nodes = new Set<string>();
  for (const s of Object.values(roads.segments)) {
    const r = rectOfBox(t, segmentBounds(roads, s));
    if (r && overlaps(r, rect)) {
      region = unionRect(region, r);
      nodes.add(s.a);
      nodes.add(s.b);
    }
  }
  // No road reaches the edit (underlay vertices only exist within a road's reach).
  if (!region) return { roads, rect };
  for (const s of Object.values(roads.segments)) {
    if (nodes.has(s.a) || nodes.has(s.b)) {
      const r = rectOfBox(t, segmentBounds(roads, s));
      if (r) region = unionRect(region, r);
    }
  }
  // Natural values under the roads take the brush delta (heights) / the painted type (ground).
  const inRect = (i: number) => {
    const ix = i % t.nx, iz = (i - ix) / t.nx;
    return ix >= rect.x0 && ix <= rect.x1 && iz >= rect.z0 && iz <= rect.z1;
  };
  const u = roads.underlay;
  const keep = { idx: [] as number[], h: [] as number[], g: [] as number[] };
  for (let k = 0; k < u.idx.length; k++) {
    const i = u.idx[k];
    if (!inRect(i)) {
      keep.idx.push(i); keep.h.push(u.h[k]); keep.g.push(u.g[k]);
      continue;
    }
    const dh = t.heights[i] - before.heights[i];
    const painted = t.ground[i] !== before.ground[i];
    // The terrain at i becomes its natural value again; the bake below re-claims it.
    t.heights[i] = Math.fround(Math.round((u.h[k] + dh) * 100) / 100);
    t.ground[i] = painted ? t.ground[i] : u.g[k];
  }
  const prev: RoadNetwork = { ...roads, underlay: keep };
  const res = bakeRegion(t, prev, roads, region!);
  t.revision++;
  return { roads: { ...roads, underlay: res.underlay }, rect: unionRect(rect, region)! };
}

/**
 * The whole terrain was replaced (preset): every vertex is natural again. Bake the roads onto
 * it from scratch.
 */
export function rebakeAll(t: TerrainData, roads: RoadNetwork): RoadNetwork {
  if (!Object.keys(roads.segments).length) return roads.underlay.idx.length ? { ...roads, underlay: { idx: [], h: [], g: [] } } : roads;
  const res = bakeRegion(t, { ...roads, underlay: { idx: [], h: [], g: [] } }, roads, fullRect(t));
  return { ...roads, underlay: res.underlay };
}
