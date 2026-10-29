/**
 * Terrain layer composition (Phase 19): Base + Sculpt + Σ landforms = L; min(L, water / coast
 * carves); paint → natural terrain N. See types.ts for the order. Rectangle-local and
 * deterministic: composing a rectangle gives exactly the values a full composition would.
 */
import type { TerrainData } from '@/core/model';
import { quantizeHeight, type GridRect } from '@/terrain/TerrainData';
import { coastCarve, featureBounds, lakeCarve, landformDelta, riverCarve, riverProfile, type Box, type Carve, type LandformAt, type RiverProfile } from './features';
import { isLandform, NO_PAINT, type Feature, type Landscape, type LandformFeature, type RiverFeature } from './types';

export type Grid = Pick<TerrainData, 'nx' | 'nz' | 'cellSize' | 'originX' | 'originZ'>;

/** A landscape whose base is the given terrain (no sculpt, paint or features). */
export function createLandscape(t: Pick<TerrainData, 'heights' | 'ground'>): Landscape {
  const n = t.heights.length;
  return {
    version: 1,
    base: { heights: t.heights.slice(), ground: t.ground.slice() },
    sculpt: new Float32Array(n),
    paint: new Uint8Array(n).fill(NO_PAINT),
    features: [],
    next: 1,
    natural: { heights: t.heights.slice(), ground: t.ground.slice(), culvert: new Uint8Array(n), roadBase: t.heights.slice() },
  };
}

export const fullGridRect = (g: Grid): GridRect => ({ x0: 0, z0: 0, x1: g.nx - 1, z1: g.nz - 1 });

/** Vertex rectangle of a world box (clamped to the grid; null when outside). */
export function rectOfBox(g: Grid, [x0, z0, x1, z1]: Box): GridRect | null {
  const c = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return fullGridRect(g);
  const r = {
    x0: c(Math.floor((x0 - g.originX) / g.cellSize), g.nx), z0: c(Math.floor((z0 - g.originZ) / g.cellSize), g.nz),
    x1: c(Math.ceil((x1 - g.originX) / g.cellSize), g.nx), z1: c(Math.ceil((z1 - g.originZ) / g.cellSize), g.nz),
  };
  return x1 < g.originX || z1 < g.originZ || x0 > g.originX + (g.nx - 1) * g.cellSize || z0 > g.originZ + (g.nz - 1) * g.cellSize ? null : r;
}

export const unionRects = (a: GridRect | null, b: GridRect | null): GridRect | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) };

const overlaps = (a: GridRect, b: GridRect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;

/** The landform L at any point: bilinear base + sculpt, plus every additive feature. */
export function landformSampler(land: Landscape, g: Grid): LandformAt {
  const landforms = land.features.filter(isLandform) as LandformFeature[];
  const boxes = landforms.map(featureBounds);
  const { base, sculpt } = land;
  return (x, z) => {
    const fx = Math.min(g.nx - 1.000001, Math.max(0, (x - g.originX) / g.cellSize));
    const fz = Math.min(g.nz - 1.000001, Math.max(0, (z - g.originZ) / g.cellSize));
    const ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz;
    const i = iz * g.nx + ix;
    const v = (k: number) => base.heights[k] + sculpt[k];
    let h = (v(i) * (1 - ax) + v(i + 1) * ax) * (1 - az) + (v(i + g.nx) * (1 - ax) + v(i + g.nx + 1) * ax) * az;
    for (let k = 0; k < landforms.length; k++) {
      const b = boxes[k];
      if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) h += landformDelta(landforms[k], x, z);
    }
    return h;
  };
}

/**
 * Rivers take their bed from the landform along their whole path, so a change anywhere under a
 * river changes the whole river: grow the rectangle by every river it touches (repeatedly —
 * rivers crossing rivers).
 */
export function expandForRivers(land: Landscape, g: Grid, rect: GridRect): GridRect {
  let out = rect;
  let grown = true;
  const rivers = land.features.filter((f): f is RiverFeature => f.kind === 'river').map((f) => rectOfBox(g, featureBounds(f)));
  const used = new Set<number>();
  while (grown) {
    grown = false;
    rivers.forEach((r, k) => {
      if (r && !used.has(k) && overlaps(r, out)) {
        out = unionRects(out, r)!;
        used.add(k);
        grown = true;
      }
    });
  }
  return out;
}

/** River profiles of a composition (computed once per compose call). */
function prepareCarves(land: Landscape, g: Grid, rect: GridRect, seaLevel: number) {
  const L = landformSampler(land, g);
  const carves: { box: Box; at: (x: number, z: number) => Carve | null; culvert: boolean; embankment: boolean }[] = [];
  for (const f of land.features) {
    if (isLandform(f)) continue;
    const r = rectOfBox(g, featureBounds(f));
    if (!r || !overlaps(r, rect)) continue;
    const box = featureBounds(f);
    if (f.kind === 'river') {
      const prof: RiverProfile = riverProfile(f, L);
      carves.push({ box, at: (x, z) => riverCarve(f, prof, x, z), culvert: f.crossing === 'culvert', embankment: f.crossing === 'embankment' });
    } else if (f.kind === 'lake') carves.push({ box, at: (x, z) => lakeCarve(f, x, z), culvert: false, embankment: false });
    else carves.push({ box, at: (x, z) => coastCarve(f, seaLevel, x, z), culvert: false, embankment: false });
  }
  return { L, carves };
}

/** Compose the natural terrain inside `rect` (writes land.natural in place). */
export function composeRect(land: Landscape, g: Grid, rect: GridRect, seaLevel: number) {
  const landforms = land.features.filter(isLandform) as LandformFeature[];
  const lfBoxes = landforms.map(featureBounds);
  const { carves } = prepareCarves(land, g, rect, seaLevel);
  const { base, sculpt, paint, natural } = land;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const z = g.originZ + iz * g.cellSize;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const x = g.originX + ix * g.cellSize;
      const i = iz * g.nx + ix;
      let L = base.heights[i] + sculpt[i];
      for (let k = 0; k < landforms.length; k++) {
        const b = lfBoxes[k];
        if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) L += landformDelta(landforms[k], x, z);
      }
      let h = L;
      let gc = -1, hMat = Infinity, culvert = 0, hRoad = L;
      for (const c of carves) {
        const b = c.box;
        if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
        const r = c.at(x, z);
        if (!r) continue;
        if (r.h < h) h = r.h;
        if (!c.embankment && r.h < hRoad) hRoad = r.h;
        if (r.g >= 0 && r.h <= hMat) { hMat = r.h; gc = r.g; }
        // Culvert: the channel (bed + banks lowered by ≥ 0.2 m) stays open under roads.
        if (c.culvert && r.h < L - 0.2) culvert = 1;
      }
      natural.heights[i] = quantizeHeight(h);
      natural.culvert[i] = culvert;
      natural.roadBase[i] = quantizeHeight(hRoad);
      natural.ground[i] = paint[i] !== NO_PAINT ? paint[i] : gc >= 0 ? gc : base.ground[i];
    }
  }
}

export function composeAll(land: Landscape, g: Grid, seaLevel: number) {
  composeRect(land, g, fullGridRect(g), seaLevel);
}

/** Rectangle influenced by a change of features a → b (both versions' bounds, rivers grown). */
export function featureChangeRect(land: Landscape, g: Grid, before: readonly Feature[], after: readonly Feature[]): GridRect | null {
  const ids = new Set([...before.map((f) => f.id), ...after.map((f) => f.id)]);
  const A = new Map(before.map((f) => [f.id, f])), B = new Map(after.map((f) => [f.id, f]));
  let rect: GridRect | null = null;
  for (const id of ids) {
    const a = A.get(id), b = B.get(id);
    if (a === b) continue;
    for (const f of [a, b]) if (f) rect = unionRects(rect, rectOfBox(g, featureBounds(f)));
  }
  if (!rect) return null;
  // Rivers of either version that pass through the change.
  const tmp = { ...land, features: [...before, ...after.filter((f) => !A.has(f.id) || A.get(f.id) !== f)] };
  return expandForRivers(tmp, g, rect);
}
