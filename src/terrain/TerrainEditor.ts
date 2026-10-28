/**
 * TerrainEditor: brush operations on TerrainData (in place). Pure functions, no UI —
 * the editor tool calls them once per frame while the mouse is held ("dabs").
 *
 * Every dab returns the vertex rectangle it touched so the renderer can update just that
 * region; the stroke as a whole becomes one undo step (see worldStore.commitTerrainStroke).
 */
import type { GroundTypeId, SoilProfileId, TerrainData } from '@/core/model';
import { quantizeHeight, rectForCircle, type GridRect } from './TerrainData';

export type TerrainBrushOp = 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint' | 'paintSoil';

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
export function brushFalloff(d: number, r: number): number {
  if (d >= r) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / r));
}

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
}

/** Scratch copy of the heights used by 'smooth' so the result is independent of visit order. */
let smoothScratch = new Float32Array(0);

export function applyDab(t: TerrainData, o: DabOptions): GridRect | null {
  const { radius } = o.brush;
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
        const d = Math.hypot(originX + ix * cs - o.x, originZ + iz * cs - o.z);
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
        const f = brushFalloff(Math.hypot(originX + ix * cs - o.x, originZ + iz * cs - o.z), radius);
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

  const rate =
    o.op === 'raise' ? MAX_RAISE_RATE * strength * o.dt
    : o.op === 'lower' ? -MAX_RAISE_RATE * strength * o.dt
    : Math.min(1, MAX_RELAX_RATE * strength * o.dt);
  const target = o.targetHeight ?? 0;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const f = brushFalloff(Math.hypot(originX + ix * cs - o.x, originZ + iz * cs - o.z), radius);
      if (f <= 0) continue;
      const i = iz * nx + ix;
      // 'flatten' relaxes toward the target; the quantum would otherwise stall tiny steps.
      h[i] = o.op === 'flatten'
        ? quantizeHeight(Math.abs(target - h[i]) < 0.02 ? (f > 0.5 ? target : h[i]) : h[i] + (target - h[i]) * rate * f)
        : quantizeHeight(h[i] + rate * f);
    }
  }
  t.revision++;
  return rect;
}
