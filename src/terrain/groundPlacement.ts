/**
 * Object placement on terrain: where an object's origin goes and how it tilts on a slope,
 * by category (ObjectDefinition.terrainFit):
 *
 *   building                   → level; floor on the HIGHEST footprint point, the downhill side
 *                                rests on a foundation plinth down to the ground (Phase 13 —
 *                                before, the uphill side was buried in the slope)
 *   wall, pole, sign           → level; origin on the LOWEST footprint corner (no floating
 *                                corner; the uphill side is embedded like a footing)
 *   person                     → level, on the ground under its center (never leans with the hill)
 *   tree                       → on the ground at the trunk, crown tilted 30 % toward the slope
 *   vehicle                    → follows the ground plane fitted through its four wheel corners
 *
 * On a flat terrain the result is exactly (x, 0, z) with rotation (0, yaw, 0), as before terrain.
 */
import type { Quat, Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { eulerFromQuat, qRotate, quatFromBasis, quatFromEuler, vNorm } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import type { TerrainSampler } from './TerrainSampler';

export interface GroundPose {
  position: Vec3;
  rotation: Vec3;
}

type Placeable = Pick<WorldObject, 'type' | 'params' | 'transform'> & { terrainAlign?: number; building?: WorldObject['building'] };

/** An object counts as standing on the ground when its origin is within this distance (m). */
export const GROUNDED_TOLERANCE = 0.05;

/**
 * Seated pose of an object at (x, z) with heading `yaw`. `align` overrides how much the object
 * tilts with the slope (0 = level … 1 = ground plane); default = the object's stored
 * `terrainAlign` (chosen at placement), else its category rule.
 */
export function groundPose(obj: Placeable, x: number, z: number, yaw: number, terrain: TerrainSampler, align?: number): GroundPose {
  if (terrain.flat) return { position: [x, 0, z], rotation: [0, yaw, 0] };
  const def = getDefinition(obj.type);
  const base = def.terrainFit ?? { align: 0, base: 'center' as const };
  // Explicit alignment > the alignment chosen when the object was placed (Phase 17) > type rule.
  const chosen = align ?? obj.terrainAlign;
  const fit = chosen === undefined ? base : { ...base, align: chosen };
  const d = def.getDimensions(obj.params);
  const k = obj.transform.scale;
  const hx = (d[0] * k[0]) / 2;
  const hz = (d[2] * k[2]) / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Footprint corners (local ±x, ±z rotated by yaw about +Y).
  const corner = (lx: number, lz: number) => terrain.sampleHeight(x + lx * c + lz * s, z - lx * s + lz * c);
  const hpp = corner(hx, hz);
  const hpm = corner(hx, -hz);
  const hmp = corner(-hx, hz);
  const hmm = corner(-hx, -hz);
  const hc = terrain.sampleHeight(x, z);

  const y = fit.base === 'min' ? Math.min(hc, hpp, hpm, hmp, hmm)
    : fit.base === 'foundation' ? footprintMax(terrain, x, z, hx, hz, c, s)
    : fit.base === 'mean' ? (hpp + hpm + hmp + hmm) / 4 : hc;
  if (fit.align <= 0 || hx <= 0 || hz <= 0) return { position: [x, y, z], rotation: [0, yaw, 0] };

  // Plane fit in the object's yaw frame (slopes along local x and z) → world up vector.
  const sx = ((hpp + hpm - hmp - hmm) / (4 * hx)) * fit.align;
  const sz = ((hpp + hmp - hpm - hmm) / (4 * hz)) * fit.align;
  const n = vNorm([-sx * c - sz * s, 1, sx * s - sz * c]);
  // Local x keeps the heading exactly (its horizontal direction is (cos, -sin)) and is lifted
  // into the plane, so re-seating never makes an object drift in yaw.
  const X = vNorm([c, (n[2] * s - n[0] * c) / n[1], -s]);
  const Z: Vec3 = [X[1] * n[2] - X[2] * n[1], X[2] * n[0] - X[0] * n[2], X[0] * n[1] - X[1] * n[0]];
  const q: Quat = quatFromBasis(X, n, Z);
  return { position: [x, y, z], rotation: eulerFromQuat(q) };
}

/** Footprint sample grid (per side) for the foundation rule: corners alone miss ridges. */
const FOOTPRINT_SAMPLES = 5;

function footprintScan(terrain: TerrainSampler, x: number, z: number, hx: number, hz: number, c: number, s: number, max: boolean): number {
  let best = max ? -Infinity : Infinity;
  const n = FOOTPRINT_SAMPLES - 1;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const lx = -hx + (2 * hx * i) / n;
      const lz = -hz + (2 * hz * j) / n;
      const h = terrain.sampleHeight(x + lx * c + lz * s, z - lx * s + lz * c);
      best = max ? Math.max(best, h) : Math.min(best, h);
    }
  }
  return best;
}

function footprintMax(terrain: TerrainSampler, x: number, z: number, hx: number, hz: number, c: number, s: number) {
  return footprintScan(terrain, x, z, hx, hz, c, s, true);
}

/**
 * Depth (m) of the foundation plinth under an object: from its floor (origin) down to the
 * lowest ground point of its footprint. 0 on flat ground and for objects whose origin is at or
 * below the lowest point (e.g. buildings placed by the pre-Phase-13 'min' rule).
 */
export function foundationPlinth(obj: Placeable, terrain: TerrainSampler): number {
  if (terrain.flat) return 0;
  // Phase 17 'preserve' policy: the plinth keeps the depth it had before the terrain was edited.
  const opts = obj.building?.options;
  if (opts?.foundationPolicy === 'preserve' && opts.plinthDepth !== null && opts.plinthDepth !== undefined) return opts.plinthDepth > 0.02 ? opts.plinthDepth : 0;
  const def = getDefinition(obj.type);
  if (def.terrainFit?.base !== 'foundation') return 0;
  const d = def.getDimensions(obj.params);
  const k = obj.transform.scale;
  const yaw = yawOf(obj.transform.rotation);
  const [x, y, z] = obj.transform.position;
  const lo = footprintScan(terrain, x, z, (d[0] * k[0]) / 2, (d[2] * k[2]) / 2, Math.cos(yaw), Math.sin(yaw), false);
  const depth = y - lo;
  return depth > 0.02 ? depth : 0;
}

/** Heading of an object (rotation about +Y), ignoring any terrain tilt. */
export function yawOf(rotation: Vec3): number {
  const v = qRotate(quatFromEuler(rotation), [1, 0, 0]);
  return Math.atan2(-v[2], v[0]);
}

/** Pose that keeps the object's heading and puts it on the ground at its current x/z. */
export function reseat(obj: Placeable, terrain: TerrainSampler, x = obj.transform.position[0], z = obj.transform.position[2]): GroundPose {
  return groundPose(obj, x, z, yawOf(obj.transform.rotation), terrain);
}

/**
 * Ground-follow policy (Phase 36, §24): what an object does when the ground under it changes — brush release, feature
 * or preset edit, road re-bake, and their undo. Decided per object from its category and how it stands:
 *
 *   category (terrainFit)            standing on the ground before the edit        lifted (> 5 cm above its seat)
 *   building ('foundation')          follow: re-seated level, plinth regrown       keep: absolute height
 *     foundation policy 'preserve'   preserve: transform kept, plinth frozen       keep
 *   vehicle ('mean', align 1)        follow: plane through the 4 wheel corners     keep
 *   person ('center', level)         follow: on the ground under its centre        keep
 *   tree ('center', 30 % tilt)       follow: at the trunk                          keep
 *   wall / pole / sign ('min')       follow: on the lowest footprint corner        keep
 *   legacy road object ('center')    follow (draped on the terrain at render)      keep
 *
 * Heading is always kept. Nothing moves during a brush stroke, only at its release (one undo step). Disaster pins are
 * not objects: their x / z stay where the user put them and they are drawn on the ground at render.
 */
export type GroundFollow = 'follow' | 'preserve' | 'keep';

export function groundFollowOf(obj: Placeable, before: TerrainSampler): GroundFollow {
  if (!isGrounded(obj, before)) return 'keep';
  return obj.building?.options.foundationPolicy === 'preserve' ? 'preserve' : 'follow';
}

/** Whether the object currently stands on the ground (rather than being lifted on purpose). */
export function isGrounded(obj: Placeable, terrain: TerrainSampler): boolean {
  if (Math.abs(obj.transform.position[1] - reseat(obj, terrain).position[1]) <= GROUNDED_TOLERANCE) return true;
  // Buildings placed before Phase 13 sit on their lowest corner: still grounded (they follow edits).
  if (getDefinition(obj.type).terrainFit?.base !== 'foundation' || terrain.flat) return false;
  const def = getDefinition(obj.type);
  const d = def.getDimensions(obj.params);
  const k = obj.transform.scale;
  const yaw = yawOf(obj.transform.rotation);
  const [x, y, z] = obj.transform.position;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hx = (d[0] * k[0]) / 2;
  const hz = (d[2] * k[2]) / 2;
  const corner = (lx: number, lz: number) => terrain.sampleHeight(x + lx * c + lz * s, z - lx * s + lz * c);
  const legacy = Math.min(terrain.sampleHeight(x, z), corner(hx, hz), corner(hx, -hz), corner(-hx, hz), corner(-hx, -hz));
  return Math.abs(y - legacy) <= GROUNDED_TOLERANCE;
}
