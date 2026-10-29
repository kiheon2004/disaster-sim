/**
 * TerrainEditor: brush operations on TerrainData (in place). Pure functions, no UI —
 * the editor tool calls them once per frame while the mouse is held ("dabs").
 *
 * Every dab returns the vertex rectangle it touched so the renderer can update just that
 * region; the stroke as a whole becomes one undo step (see worldStore.commitTerrainStroke).
 */
import type { GroundTypeId, SoilProfileId, TerrainData } from '@/core/model';
import { quantizeHeight, rectForCircle, type GridRect } from './TerrainData';
import { Rng } from '@/core/random';
import { ValueNoise } from './TerrainPresets';
import { groundMaterial } from './GroundMaterials';

export type TerrainBrushOp =
  | 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint' | 'paintSoil'
  // Phase 19 landscape brushes.
  | 'plateau' | 'ridge' | 'valley' | 'slope' | 'noise' | 'erode';

/** Brush falloff from the center (1) to the rim (0). */
export type BrushFalloff = 'smooth' | 'linear' | 'sharp' | 'flat';
export type BrushShape = 'circle' | 'square';

export interface BrushSettings {
  /** Radius (m). */
  radius: number;
  /** 0–1. */
  strength: number;
}

/** Raise/lower speed at the brush center for strength 1 (m/s). */
export const MAX_RAISE_RATE = 8;
/** Flatten/smooth relaxation rate for strength 1 (1/s). */
export const MAX_RELAX_RATE = 10;

/** Smooth bell falloff: 1 at the center, 0 at the rim (zero slope at both ends). */
export function brushFalloff(d: number, r: number, kind: BrushFalloff = 'smooth'): number {
  if (d >= r) return 0;
  const t = d / r;
  switch (kind) {
    case 'linear': return 1 - t;
    case 'sharp': return (1 - t) * (1 - t);
    case 'flat': return t < 0.8 ? 1 : 0.5 * (1 + Math.cos((Math.PI * (t - 0.8)) / 0.2));
    default: return 0.5 * (1 + Math.cos(Math.PI * t));
  }
}

/** Talus slope of the erosion brush: steeper than ~33° (Δh > 0.65 m per 1 m cell) sheds material. */
export const TALUS = 0.65;

export interface DabOptions {
  op: TerrainBrushOp;
  x: number;
  z: number;
  brush: BrushSettings;
  /** Seconds of brush time this dab represents. */
  dt: number;
  /** Target elevation for 'flatten' (picked at stroke start). */
  targetHeight?: number;
  /** Ground type for 'paint'. */
  groundType?: GroundTypeId;
  /** Soil profile for 'paintSoil'. */
  soilType?: SoilProfileId;
  // Phase 19 (all optional: absent = the Phase 12 behaviour).
  falloff?: BrushFalloff;
  shape?: BrushShape;
  /** Seed of the 'noise' brush pattern. */
  seed?: number;
  /** Height limits: raising never goes above max, lowering never below min (m). */
  minHeight?: number | null;
  maxHeight?: number | null;
  /** 'slope': the ramp from A (stroke start) to B (cursor), heights at the stroke start. */
  slope?: { ax: number; az: number; ah: number; bx: number; bz: number; bh: number };
}

/** Scratch copy of the heights used by 'smooth' so the result is independent of visit order. */
let smoothScratch = new Float32Array(0);

const noises = new Map<number, ValueNoise>();
function noiseFor(seed: number) {
  let n = noises.get(seed);
  if (!n) noises.set(seed, (n = new ValueNoise(new Rng(seed >>> 0 || 1))));
  return n;
}

export function applyDab(t: TerrainData, o: DabOptions): GridRect | null {
  const { radius } = o.brush;
  const square = o.shape === 'square';
  /** Brush distance (square brushes use the max norm). */
  const dist = (dx: number, dz: number) => (square ? Math.max(Math.abs(dx), Math.abs(dz)) : Math.hypot(dx, dz));
  const fall = (dx: number, dz: number) => brushFalloff(dist(dx, dz), radius, o.falloff);
  const lo = o.minHeight ?? -Infinity, hi = o.maxHeight ?? Infinity;
  const rect = rectForCircle(t, o.x, o.z, radius);
  if (!rect) return null;
  const { nx, cellSize: cs, originX, originZ, heights: h } = t;
  const strength = Math.max(0, Math.min(1, o.brush.strength));

  if (o.op === 'paint' || o.op === 'paintSoil') {
    const layer = o.op === 'paint' ? t.ground : t.soil;
    const type = o.op === 'paint' ? (o.groundType ?? 0) : (o.soilType ?? 1);
    // Paint the inner part of the bell so edges stay crisp; strength widens the core.
    const core = 0.35 + 0.6 * strength;
    let touched = false;
    for (let iz = rect.z0; iz <= rect.z1; iz++) {
      for (let ix = rect.x0; ix <= rect.x1; ix++) {
        const d = dist(originX + ix * cs - o.x, originZ + iz * cs - o.z);
        if (d <= radius * core) {
          layer[iz * nx + ix] = type;
          touched = true;
        }
      }
    }
    if (touched) t.revision++;
    return touched ? rect : null;
  }

  if (o.op === 'smooth') {
    // Copy the brush rectangle plus a 1-vertex border.
    const sx0 = Math.max(0, rect.x0 - 1);
    const sz0 = Math.max(0, rect.z0 - 1);
    const sx1 = Math.min(nx - 1, rect.x1 + 1);
    const sz1 = Math.min(t.nz - 1, rect.z1 + 1);
    const w = sx1 - sx0 + 1;
    const n = w * (sz1 - sz0 + 1);
    if (smoothScratch.length < n) smoothScratch = new Float32Array(n);
    for (let iz = sz0; iz <= sz1; iz++) for (let ix = sx0; ix <= sx1; ix++) smoothScratch[(iz - sz0) * w + (ix - sx0)] = h[iz * nx + ix];
    const at = (ix: number, iz: number) => smoothScratch[(iz - sz0) * w + (ix - sx0)];
    const k = Math.min(1, MAX_RELAX_RATE * strength * o.dt);
    for (let iz = rect.z0; iz <= rect.z1; iz++) {
      for (let ix = rect.x0; ix <= rect.x1; ix++) {
        const f = fall(originX + ix * cs - o.x, originZ + iz * cs - o.z);
        if (f <= 0) continue;
        let sum = 0;
        let cnt = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = iz + dz;
          if (zz < sz0 || zz > sz1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = ix + dx;
            if (xx < sx0 || xx > sx1) continue;
            sum += at(xx, zz);
            cnt++;
          }
        }
        const cur = at(ix, iz);
        h[iz * nx + ix] = quantizeHeight(cur + (sum / cnt - cur) * k * f);
      }
    }
    t.revision++;
    return rect;
  }

  if (o.op === 'erode') return erodeDab(t, o, rect, fall, strength);

  // Ridge / valley: raise / lower with a sharp (cone-like) profile unless chosen otherwise.
  const sharp = (dx: number, dz: number) => brushFalloff(dist(dx, dz), radius, o.falloff ?? 'sharp');
  const up = o.op === 'raise' || o.op === 'ridge';
  const down = o.op === 'lower' || o.op === 'valley';
  const relax = o.op === 'flatten' || o.op === 'plateau' || o.op === 'slope';
  const rate = up ? MAX_RAISE_RATE * strength * o.dt : down ? -MAX_RAISE_RATE * strength * o.dt : Math.min(1, MAX_RELAX_RATE * strength * o.dt);
  const target = o.targetHeight ?? 0;
  const sl = o.slope;
  const slLen2 = sl ? (sl.bx - sl.ax) ** 2 + (sl.bz - sl.az) ** 2 : 0;
  const noise = o.op === 'noise' ? noiseFor(o.seed ?? 1) : null;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const dx = originX + ix * cs - o.x, dz = originZ + iz * cs - o.z;
      const f = o.op === 'ridge' || o.op === 'valley' ? sharp(dx, dz) : fall(dx, dz);
      if (f <= 0) continue;
      const i = iz * nx + ix;
      const cur = h[i];
      let next: number;
      if (relax) {
        let goal = target;
        if (o.op === 'slope' && sl) {
          // Ramp: the height of the straight line A → B at this point's projection on it.
          const px = originX + ix * cs, pz = originZ + iz * cs;
          const u = slLen2 > 1e-6 ? Math.max(0, Math.min(1, ((px - sl.ax) * (sl.bx - sl.ax) + (pz - sl.az) * (sl.bz - sl.az)) / slLen2)) : 0;
          goal = sl.ah + (sl.bh - sl.ah) * u;
        }
        // Plateau only cuts what stands above the level (a flat top), never fills.
        if (o.op === 'plateau' && cur <= goal) continue;
        // 'flatten' relaxes toward the target; the quantum would otherwise stall tiny steps.
        next = Math.abs(goal - cur) < 0.02 ? (f > 0.5 ? goal : cur) : cur + (goal - cur) * rate * f;
      } else if (noise) {
        next = cur + MAX_RAISE_RATE * 0.5 * strength * o.dt * f * noise.fbm((originX + ix * cs) / 6, (originZ + iz * cs) / 6, 3);
      } else next = cur + rate * f;
      // Height limits apply to what the brush adds / removes (existing heights are not clamped).
      if (next > cur) next = Math.min(next, Math.max(cur, hi));
      if (next < cur) next = Math.max(next, Math.min(cur, lo));
      h[i] = quantizeHeight(next);
    }
  }
  t.revision++;
  return rect;
}

/**
 * Erosion-inspired brush (Phase 19): one step of THERMAL erosion inside the brush — where the
 * ground is steeper than the talus slope, part of the excess height moves to the lowest
 * neighbour, scaled by the surface's erodibility (rock barely moves, sand / mud most). Mass
 * (volume) is conserved inside the grid. It shapes plausible scree slopes and softened ridges;
 * it is NOT a hydraulic erosion / sediment transport model.
 */
function erodeDab(t: TerrainData, o: DabOptions, rect: GridRect, fall: (dx: number, dz: number) => number, strength: number): GridRect {
  const { nx, nz, cellSize: cs, originX, originZ, heights: h, ground } = t;
  const k = Math.min(0.5, 4 * strength * o.dt);
  const x0 = Math.max(0, rect.x0 - 1), x1 = Math.min(nx - 1, rect.x1 + 1), z0 = Math.max(0, rect.z0 - 1), z1 = Math.min(nz - 1, rect.z1 + 1);
  const w = x1 - x0 + 1;
  const src = new Float64Array(w * (z1 - z0 + 1));
  for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) src[(iz - z0) * w + (ix - x0)] = h[iz * nx + ix];
  const out = Float64Array.from(src);
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const f = fall(originX + ix * cs - o.x, originZ + iz * cs - o.z);
      if (f <= 0) continue;
      const here = src[(iz - z0) * w + (ix - x0)];
      let best = -1, drop = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < x0 || jx > x1 || jz < z0 || jz > z1) continue;
        const d = here - src[(jz - z0) * w + (jx - x0)];
        if (d > drop) { drop = d; best = (jz - z0) * w + (jx - x0); }
      }
      const excess = drop - TALUS * cs;
      if (best < 0 || excess <= 0) continue;
      const move = 0.5 * excess * k * f * groundMaterial(ground[iz * nx + ix]).erodibility;
      out[(iz - z0) * w + (ix - x0)] -= move;
      out[best] += move;
    }
  }
  for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) h[iz * nx + ix] = quantizeHeight(out[(iz - z0) * w + (ix - x0)]);
  t.revision++;
  return { x0, z0, x1, z1 };
}
