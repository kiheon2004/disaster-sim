/**
 * Point breakdown of the terrain layers (Phase 19 terrain inspector): what each layer adds at
 * a point, which water feature (if any) cuts it, the road grading on top, and the nearest
 * road / river / lake / coast.
 */
import type { TerrainData } from '@/core/model';
import type { RoadNetwork } from '@/roads/types';
import { segmentLine } from '@/roads/network';
import { nearest } from '@/roads/curve';
import { coastCarve, coastDistance, featureBounds, featureLine, lakeCarve, landformDelta, polygonDistance, riverCarve, riverProfile } from './features';
import { landformSampler } from './compose';
import { isLandform, type Landscape, type LandformFeature } from './types';

export interface LayerBreakdown {
  base: number;
  sculpt: number;
  landforms: { id: string; kind: string; dh: number }[];
  /** Landform L = base + sculpt + Σ landforms. */
  landform: number;
  /** Water / coast feature that cuts the point (null = none) and by how much. */
  carve: { id: string; kind: string; dh: number } | null;
  natural: number;
  /** Final − natural (road grading), m. */
  road: number;
  final: number;
  nearest: { road: { id: string; dist: number } | null; river: { id: string; dist: number } | null; lake: { id: string; dist: number; inside: boolean } | null; coast: { id: string; dist: number } | null };
}

function bilinear(a: Float32Array, t: TerrainData, x: number, z: number): number {
  const fx = Math.min(t.nx - 1.000001, Math.max(0, (x - t.originX) / t.cellSize));
  const fz = Math.min(t.nz - 1.000001, Math.max(0, (z - t.originZ) / t.cellSize));
  const ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz, i = iz * t.nx + ix;
  return (a[i] * (1 - ax) + a[i + 1] * ax) * (1 - az) + (a[i + t.nx] * (1 - ax) + a[i + t.nx + 1] * ax) * az;
}

export function layerBreakdown(land: Landscape, roads: RoadNetwork, t: TerrainData, x: number, z: number): LayerBreakdown {
  const base = bilinear(land.base.heights, t, x, z);
  const sculpt = bilinear(land.sculpt, t, x, z);
  const landforms: LayerBreakdown['landforms'] = [];
  for (const f of land.features) {
    if (!isLandform(f)) continue;
    const dh = landformDelta(f as LandformFeature, x, z);
    if (Math.abs(dh) > 0.005) landforms.push({ id: f.id, kind: f.kind, dh });
  }
  const L = base + sculpt + landforms.reduce((s, l) => s + l.dh, 0);
  let carve: LayerBreakdown['carve'] = null;
  const Ls = landformSampler(land, t);
  const near: LayerBreakdown['nearest'] = { road: null, river: null, lake: null, coast: null };
  const sea = t.settings.waterLevel ?? 0;
  for (const f of land.features) {
    if (isLandform(f)) continue;
    let h: number | null = null;
    if (f.kind === 'river') {
      const b = featureBounds(f);
      const d = nearest(featureLine(f), x, z).dist;
      if (!near.river || d < near.river.dist) near.river = { id: f.id, dist: Math.max(0, d - f.width / 2) };
      if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) h = riverCarve(f, riverProfile(f, Ls), x, z)?.h ?? null;
    } else if (f.kind === 'lake') {
      const pd = polygonDistance(f.points, x, z);
      if (!near.lake || (pd.inside ? 0 : pd.dist) < near.lake.dist) near.lake = { id: f.id, dist: pd.inside ? 0 : pd.dist, inside: pd.inside };
      h = lakeCarve(f, x, z)?.h ?? null;
    } else {
      const d = coastDistance(f, x, z);
      if (!near.coast || Math.abs(d) < Math.abs(near.coast.dist)) near.coast = { id: f.id, dist: d };
      h = coastCarve(f, sea, x, z)?.h ?? null;
    }
    if (h !== null && h < L && (!carve || h - L < carve.dh)) carve = { id: f.id, kind: f.kind, dh: h - L };
  }
  for (const s of Object.values(roads.segments)) {
    const d = nearest(segmentLine(roads, s), x, z).dist;
    if (!near.road || d < near.road.dist) near.road = { id: s.id, dist: Math.max(0, d - s.profile.width / 2) };
  }
  const natural = bilinear(land.natural.heights, t, x, z);
  const final = bilinear(t.heights, t, x, z);
  return { base, sculpt, landforms, landform: L, carve, natural, road: final - natural, final, nearest: near };
}
