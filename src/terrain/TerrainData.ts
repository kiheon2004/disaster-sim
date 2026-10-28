/**
 * TerrainData helpers: construction, quantization and rectangular patches (undo/redo).
 * Pure data — no Three.js, no physics.
 */
import type { TerrainData, TerrainSettings } from '@/core/model';
import { WORLD_SIZE } from '@/core/units';
import { DEFAULT_GROUND } from './GroundMaterials';

/** Grid spacing (m). 1 m resolves building pads and car-sized slopes; 201×201 vertices. */
export const TERRAIN_CELL_SIZE = 1;
/** Elevation limits (m) enforced by every edit. */
export const MIN_ELEVATION = -40;
export const MAX_ELEVATION = 80;
/** Heights are stored in centimeters (save files use int16 cm). */
export const HEIGHT_QUANTUM = 0.01;

export function defaultTerrainSettings(): TerrainSettings {
  return { preset: 'flat', seed: 1, waterLevel: null };
}

export function createFlatTerrain(size = WORLD_SIZE, cellSize = TERRAIN_CELL_SIZE): TerrainData {
  const n = Math.round(size / cellSize) + 1;
  return {
    kind: 'heightfield',
    nx: n,
    nz: n,
    cellSize,
    originX: -size / 2,
    originZ: -size / 2,
    heights: new Float32Array(n * n),
    ground: new Uint8Array(n * n).fill(DEFAULT_GROUND),
    settings: defaultTerrainSettings(),
    revision: 0,
  };
}

/** Round to the storage quantum (1 cm) and clamp to the elevation limits. */
export function quantizeHeight(h: number): number {
  const c = h < MIN_ELEVATION ? MIN_ELEVATION : h > MAX_ELEVATION ? MAX_ELEVATION : h;
  return Math.round(c * 100) / 100 + 0; // + 0 turns -0 into 0
}

export function isFlat(t: TerrainData): boolean {
  const h = t.heights;
  for (let i = 0; i < h.length; i++) if (h[i] !== 0) return false;
  return true;
}

export function isDefaultGround(t: TerrainData): boolean {
  const g = t.ground;
  for (let i = 0; i < g.length; i++) if (g[i] !== DEFAULT_GROUND) return false;
  return true;
}

export function heightRange(t: TerrainData): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const h = t.heights;
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return h.length ? [lo, hi] : [0, 0];
}

/** Inclusive vertex-index rectangle. */
export interface GridRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export const fullRect = (t: TerrainData): GridRect => ({ x0: 0, z0: 0, x1: t.nx - 1, z1: t.nz - 1 });

export function unionRect(a: GridRect | null, b: GridRect | null): GridRect | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) };
}

/** Vertex rectangle covering a world-space circle (clamped to the grid), or null if outside. */
export function rectForCircle(t: TerrainData, x: number, z: number, r: number): GridRect | null {
  const cs = t.cellSize;
  const x0 = Math.max(0, Math.floor((x - r - t.originX) / cs));
  const z0 = Math.max(0, Math.floor((z - r - t.originZ) / cs));
  const x1 = Math.min(t.nx - 1, Math.ceil((x + r - t.originX) / cs));
  const z1 = Math.min(t.nz - 1, Math.ceil((z + r - t.originZ) / cs));
  return x0 > x1 || z0 > z1 ? null : { x0, z0, x1, z1 };
}

/**
 * A rectangular before/after copy of the terrain layers: one undo step of a brush stroke or a
 * preset. Only the touched rectangle is stored, so long editing sessions stay small.
 */
export interface TerrainPatch {
  rect: GridRect;
  heightsBefore: Float32Array;
  heightsAfter: Float32Array;
  groundBefore: Uint8Array;
  groundAfter: Uint8Array;
  settingsBefore: TerrainSettings;
  settingsAfter: TerrainSettings;
}

function copyRect<A extends Float32Array | Uint8Array>(src: A, nx: number, r: GridRect, make: (n: number) => A): A {
  const w = r.x1 - r.x0 + 1;
  const out = make(w * (r.z1 - r.z0 + 1));
  for (let z = r.z0; z <= r.z1; z++) out.set(src.subarray(z * nx + r.x0, z * nx + r.x1 + 1), (z - r.z0) * w);
  return out;
}

function writeRect(dst: Float32Array | Uint8Array, nx: number, r: GridRect, src: Float32Array | Uint8Array) {
  const w = r.x1 - r.x0 + 1;
  for (let z = r.z0; z <= r.z1; z++) dst.set(src.subarray((z - r.z0) * w, (z - r.z0 + 1) * w), z * nx + r.x0);
}

/**
 * Patch between a full copy of the layers taken before an edit and the terrain now.
 * `before` holds the arrays as they were at stroke start.
 */
export function makePatch(
  t: TerrainData,
  before: { heights: Float32Array; ground: Uint8Array; settings: TerrainSettings },
  rect: GridRect,
): TerrainPatch {
  return {
    rect,
    heightsBefore: copyRect(before.heights, t.nx, rect, (n) => new Float32Array(n)),
    heightsAfter: copyRect(t.heights, t.nx, rect, (n) => new Float32Array(n)),
    groundBefore: copyRect(before.ground, t.nx, rect, (n) => new Uint8Array(n)),
    groundAfter: copyRect(t.ground, t.nx, rect, (n) => new Uint8Array(n)),
    settingsBefore: { ...before.settings },
    settingsAfter: { ...t.settings },
  };
}

/** Write one side of a patch into the terrain (in place) and bump its revision. */
export function applyPatch(t: TerrainData, p: TerrainPatch, side: 'before' | 'after') {
  writeRect(t.heights, t.nx, p.rect, side === 'before' ? p.heightsBefore : p.heightsAfter);
  writeRect(t.ground, t.nx, p.rect, side === 'before' ? p.groundBefore : p.groundAfter);
  t.settings = { ...(side === 'before' ? p.settingsBefore : p.settingsAfter) };
  t.revision++;
}

export function snapshotLayers(t: TerrainData) {
  return { heights: t.heights.slice(), ground: t.ground.slice(), settings: { ...t.settings } };
}
