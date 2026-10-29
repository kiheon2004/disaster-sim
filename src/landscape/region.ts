/**
 * Nature regions (Phase 19 → Phase 20 blueprint library): a rectangle of the landscape as a
 * self-contained, JSON-serializable value — the natural features lying inside it (coordinates
 * relative to the region anchor, local ids) plus the user sculpt / paint layers under it.
 * Placing a region creates NEW feature ids and ADDS its sculpt to the destination (paint
 * replaces where it is set); the base terrain and the roads of the destination are untouched.
 * Coastlines are map-scale (they extend to the map edges) and are not part of regions.
 */
import { z } from 'zod';
import type { GridRect } from '@/terrain/TerrainData';
import { decodeElevation, decodeGround, encodeElevation, encodeGround } from '@/terrain/terrainCodec';
import type { Box } from './features';
import type { Grid } from './compose';
import { NO_PAINT, type Feature, type Landscape, type P2 } from './types';

export const NATURE_REGION_FORMAT = 'disaster-sim/nature-region';

export interface NatureRegion {
  format: typeof NATURE_REGION_FORMAT;
  version: 1;
  /** Size of the region (m) and its vertex grid (cell size of the source terrain). */
  size: [number, number];
  grid: { nx: number; nz: number; cell: number };
  features: Feature[];
  sculpt: string | null;
  paint: string | null;
}

const shiftPts = (pts: readonly P2[], dx: number, dz: number): P2[] => pts.map(([x, z]) => [Math.round((x + dx) * 100) / 100, Math.round((z + dz) * 100) / 100]);

function shiftFeature(f: Feature, dx: number, dz: number, id: string): Feature {
  if (f.kind === 'mountain' || f.kind === 'hill') return { ...f, id, x: Math.round((f.x + dx) * 100) / 100, z: Math.round((f.z + dz) * 100) / 100 };
  return { ...f, id, points: shiftPts((f as Exclude<Feature, { kind: 'mountain' | 'hill' }>).points, dx, dz) } as Feature;
}

/** A feature belongs to a region when its defining geometry (center / every point) lies in it. */
function within(f: Feature, r: Box): boolean {
  const pts: P2[] = f.kind === 'mountain' || f.kind === 'hill' ? [[f.x, f.z]] : (f as Exclude<Feature, { kind: 'mountain' | 'hill' }>).points;
  return pts.every(([x, z]) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]);
}

/** Capture the region [x0, z0]–[x1, z1] (world m). Anchor = its center. */
export function captureRegion(land: Landscape, g: Grid, box: Box): NatureRegion {
  const [x0, z0, x1, z1] = box;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const features = land.features
    .filter((f) => f.kind !== 'coast' && within(f, box))
    .map((f, i) => shiftFeature(f, -cx, -cz, `r${i + 1}`));
  const ix0 = Math.max(0, Math.round((x0 - g.originX) / g.cellSize)), iz0 = Math.max(0, Math.round((z0 - g.originZ) / g.cellSize));
  const ix1 = Math.min(g.nx - 1, Math.round((x1 - g.originX) / g.cellSize)), iz1 = Math.min(g.nz - 1, Math.round((z1 - g.originZ) / g.cellSize));
  const nx = ix1 - ix0 + 1, nz = iz1 - iz0 + 1;
  const sculpt = new Float32Array(nx * nz), paint = new Uint8Array(nx * nz);
  let usedS = false, usedP = false;
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const i = (iz0 + iz) * g.nx + ix0 + ix;
    sculpt[iz * nx + ix] = land.sculpt[i];
    paint[iz * nx + ix] = land.paint[i];
    usedS ||= land.sculpt[i] !== 0;
    usedP ||= land.paint[i] !== NO_PAINT;
  }
  return {
    format: NATURE_REGION_FORMAT, version: 1, size: [x1 - x0, z1 - z0], grid: { nx, nz, cell: g.cellSize },
    features, sculpt: usedS ? encodeElevation(sculpt, nx) : null, paint: usedP ? encodeGround(paint) : null,
  };
}

export interface PlacedRegion {
  features: Feature[];
  next: number;
  /** Vertex rectangle of the destination and the layers to add / set there. */
  layers: { rect: GridRect; sculpt: Float32Array | null; paint: Uint8Array | null } | null;
}

/** Place a region with its anchor at (x, z) into `land` (fresh feature ids). */
export function placeRegion(land: Landscape, g: Grid, r: NatureRegion, x: number, z: number): PlacedRegion {
  let next = land.next;
  const features = [...land.features, ...r.features.map((f) => shiftFeature(f, x, z, `f${next++}`))];
  let layers: PlacedRegion['layers'] = null;
  if (r.sculpt || r.paint) {
    const n = r.grid.nx * r.grid.nz;
    const ix0 = Math.round((x - r.size[0] / 2 - g.originX) / g.cellSize), iz0 = Math.round((z - r.size[1] / 2 - g.originZ) / g.cellSize);
    const rect = { x0: Math.max(0, ix0), z0: Math.max(0, iz0), x1: Math.min(g.nx - 1, ix0 + r.grid.nx - 1), z1: Math.min(g.nz - 1, iz0 + r.grid.nz - 1) };
    const src = { s: r.sculpt ? new Float32Array(n) : null, p: r.paint ? new Uint8Array(n) : null };
    if (src.s && r.sculpt) decodeElevation(r.sculpt, src.s, r.grid.nx);
    if (src.p && r.paint) decodeGround(r.paint, src.p);
    const w = rect.x1 - rect.x0 + 1, h = rect.z1 - rect.z0 + 1;
    const sculpt = src.s ? new Float32Array(w * h) : null, paint = src.p ? new Uint8Array(w * h).fill(NO_PAINT) : null;
    for (let iz = 0; iz < h; iz++) for (let ix = 0; ix < w; ix++) {
      const k = (rect.z0 + iz - iz0) * r.grid.nx + (rect.x0 + ix - ix0);
      if (sculpt && src.s) sculpt[iz * w + ix] = src.s[k];
      if (paint && src.p) paint[iz * w + ix] = src.p[k];
    }
    if (w > 0 && h > 0) layers = { rect, sculpt, paint };
  }
  return { features, next, layers };
}

const regionSchema = z.object({
  format: z.literal(NATURE_REGION_FORMAT),
  version: z.literal(1),
  size: z.tuple([z.number().positive(), z.number().positive()]),
  grid: z.object({ nx: z.number().int().min(1).max(2001), nz: z.number().int().min(1).max(2001), cell: z.number().positive() }),
  features: z.array(z.unknown()),
  sculpt: z.string().nullable(),
  paint: z.string().nullable(),
});

/** Validate a region (features are validated when placed through the landscape schema). */
export function parseRegion(raw: unknown): NatureRegion | null {
  const r = regionSchema.safeParse(raw);
  return r.success ? (r.data as NatureRegion) : null;
}
