/**
 * Water in the natural features (Phase 19). A drawn river or lake is GEOMETRY (a channel / a
 * basin in the terrain); whether water is in it is a separate, explicit WATER STATE:
 *
 *   lake   filled  → at the start of a simulation every cell of the basin whose bed is below
 *                    the target surface holds water up to it
 *   river  fill    → the channel holds water up to bed + fill·depth (fill 0 = dry)
 *          inflow  → a steady water source (m³/s) at the upstream end, for the whole run
 *          downstream 'open' → the map edge at the downstream end lets the water leave (only
 *                    when that edge is 'auto' / 'closed'; a user's fixed-level edge is kept)
 *   coast          → the sea is the world's static reference level (Phase 14 boundaries)
 *
 * The water itself is computed by the Phase 14 solver (depth, velocity, mass budget): this
 * module only builds the initial depth and the forcing. Cells: the 1 m water grid (bed = mean
 * of the collider triangles, like WaterField).
 */
import type { BoundarySide, TerrainData, WaterSettings } from '@/core/model';
import type { WaterSourceEventSpec } from '@/events/specs';
import { nearest } from '@/roads/curve';
import { landformSampler, rectOfBox } from './compose';
import { featureBounds, polygonDistance, riverProfile } from './features';
import type { Landscape, LakeFeature, RiverFeature } from './types';

/** Duration of a river's inflow event: the whole run (s). */
export const RIVER_INFLOW_DURATION = 24 * 3600;
/** A river end this close to the map edge (m) is "at" that edge. */
export const EDGE_REACH = 6;

function cellBed(t: TerrainData, ix: number, iz: number): number {
  const vx = t.nx, v = iz * vx + ix, h = t.heights;
  return (h[v] + 2 * h[v + 1] + 2 * h[v + vx] + h[v + vx + 1]) / 6;
}

/** Initial water depth per water-grid cell from the water features (null = none). */
export function initialWater(land: Landscape, t: TerrainData): Float64Array | null {
  const nx = t.nx - 1, nz = t.nz - 1;
  let depth: Float64Array | null = null;
  const put = (i: number, d: number) => {
    if (d <= 0.005) return;
    depth ??= new Float64Array(nx * nz);
    if (d > depth[i]) depth[i] = d;
  };
  const L = landformSampler(land, t);
  for (const f of land.features) {
    if (f.kind === 'lake' && f.filled) fillLake(f, t, put);
    if (f.kind === 'river' && f.water.fill > 0) fillRiver(f, t, L, put);
  }
  return depth;
}

function forCells(t: TerrainData, box: [number, number, number, number], fn: (ix: number, iz: number, x: number, z: number) => void) {
  const r = rectOfBox(t, box);
  if (!r) return;
  for (let iz = r.z0; iz < Math.min(r.z1, t.nz - 1); iz++) {
    for (let ix = r.x0; ix < Math.min(r.x1, t.nx - 1); ix++) fn(ix, iz, t.originX + (ix + 0.5) * t.cellSize, t.originZ + (iz + 0.5) * t.cellSize);
  }
}

function fillLake(f: LakeFeature, t: TerrainData, put: (i: number, d: number) => void) {
  forCells(t, featureBounds(f), (ix, iz, x, z) => {
    if (!polygonDistance(f.points, x, z).inside) return;
    put(iz * (t.nx - 1) + ix, f.surface - cellBed(t, ix, iz));
  });
}

function fillRiver(f: RiverFeature, t: TerrainData, L: (x: number, z: number) => number, put: (i: number, d: number) => void) {
  const prof = riverProfile(f, L);
  const S = prof.line.samples;
  forCells(t, featureBounds(f), (ix, iz, x, z) => {
    const hit = nearest(prof.line, x, z);
    if (hit.dist > f.width / 2 + f.depth * f.bankSlope) return;
    const k = Math.min(S.length - 1, Math.max(0, Math.round((hit.s / Math.max(1e-9, prof.line.length)) * (S.length - 1))));
    const surface = prof.bed[k] + f.water.fill * f.depth;
    put(iz * (t.nx - 1) + ix, surface - cellBed(t, ix, iz));
  });
}

/** The map edge a point is at (within EDGE_REACH), or null. */
export function edgeAt(t: TerrainData, x: number, z: number): BoundarySide | null {
  const x0 = t.originX, z0 = t.originZ, x1 = x0 + (t.nx - 1) * t.cellSize, z1 = z0 + (t.nz - 1) * t.cellSize;
  const d = { W: x - x0, E: x1 - x, N: z - z0, S: z1 - z } as Record<BoundarySide, number>;
  let best: BoundarySide | null = null;
  for (const k of ['N', 'E', 'S', 'W'] as BoundarySide[]) if (d[k] <= EDGE_REACH && (!best || d[k] < d[best])) best = k;
  return best;
}

export interface HydrologyIssue {
  feature: string;
  /** i18n key suffix: nature.hydro.<code> */
  code: 'sourceAtFixedEdge' | 'noOutlet' | 'outletFixed' | 'riverSpills' | 'lakeSpills';
  value?: number;
}

export interface HydrologyPlan {
  initial: Float64Array | null;
  sources: WaterSourceEventSpec[];
  /** Edge boundary overrides for this run (never written to the document). */
  boundaries: Partial<WaterSettings['boundaries']>;
  issues: HydrologyIssue[];
}

/**
 * Forcing of a run from the water features + checks that would make water appear from nowhere
 * or pile up without limit:
 *  - an inflow at an edge held at a fixed level (water would be added and removed endlessly
 *    there) → the inflow is NOT applied
 *  - a continuous inflow with no way out (downstream closed) → warning (the water piles up)
 *  - the downstream edge is a user fixed-level edge → kept, noted
 */
export function hydrologyPlan(land: Landscape, t: TerrainData, water: WaterSettings): HydrologyPlan {
  const plan: HydrologyPlan = { initial: initialWater(land, t), sources: [], boundaries: {}, issues: [] };
  for (const f of land.features) {
    if (f.kind === 'lake' && f.filled) {
      const rim = lakeRimLow(f, t);
      if (rim < f.surface - 0.05) plan.issues.push({ feature: f.id, code: 'lakeSpills', value: f.surface - rim });
    }
    if (f.kind !== 'river') continue;
    const up = f.points[0], down = f.points[f.points.length - 1];
    const upEdge = edgeAt(t, up[0], up[1]);
    const downEdge = edgeAt(t, down[0], down[1]);
    if (f.water.inflow > 0) {
      if (upEdge && water.boundaries[upEdge]?.type === 'fixedLevel') plan.issues.push({ feature: f.id, code: 'sourceAtFixedEdge' });
      else plan.sources.push({ event: 'waterSource', position: [up[0], up[1]], rate: f.water.inflow, duration: RIVER_INFLOW_DURATION, radius: Math.max(2, f.width / 2) });
    }
    if (downEdge && f.water.downstream === 'open') {
      const cur = water.boundaries[downEdge]?.type ?? 'auto';
      if (cur === 'fixedLevel') plan.issues.push({ feature: f.id, code: 'outletFixed' });
      else plan.boundaries[downEdge] = { type: 'open' };
    } else if (f.water.inflow > 0 && (!downEdge || f.water.downstream === 'closed')) plan.issues.push({ feature: f.id, code: 'noOutlet' });
  }
  return plan;
}

/** Lowest terrain on a lake's shoreline (m) — below the target surface the lake spills over. */
export function lakeRimLow(f: LakeFeature, t: TerrainData): number {
  let low = Infinity;
  const P = f.points;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 0; k < n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n, z = a[1] + ((b[1] - a[1]) * k) / n;
      const fx = Math.round((x - t.originX) / t.cellSize), fz = Math.round((z - t.originZ) / t.cellSize);
      if (fx < 0 || fz < 0 || fx >= t.nx || fz >= t.nz) continue;
      low = Math.min(low, t.heights[fz * t.nx + fx]);
    }
  }
  return low;
}
