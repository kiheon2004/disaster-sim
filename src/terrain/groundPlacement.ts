/**
 * Object placement on terrain: where an object's origin goes and how it tilts on a slope,
 * by category (ObjectDefinition.terrainFit):
 *
 *   building, wall, pole, sign → level; origin on the LOWEST footprint corner (no floating
 *                                corner; the uphill side is embedded like a foundation)
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

type Placeable = Pick<WorldObject, 'type' | 'params' | 'transform'>;

/** An object counts as standing on the ground when its origin is within this distance (m). */
export const GROUNDED_TOLERANCE = 0.05;

/** Seated pose of an object at (x, z) with heading `yaw`. */
export function groundPose(obj: Placeable, x: number, z: number, yaw: number, terrain: TerrainSampler): GroundPose {
  if (terrain.flat) return { position: [x, 0, z], rotation: [0, yaw, 0] };
  const def = getDefinition(obj.type);
  const fit = def.terrainFit ?? { align: 0, base: 'center' as const };
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

  const y = fit.base === 'min' ? Math.min(hc, hpp, hpm, hmp, hmm) : fit.base === 'mean' ? (hpp + hpm + hmp + hmm) / 4 : hc;
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

/** Heading of an object (rotation about +Y), ignoring any terrain tilt. */
export function yawOf(rotation: Vec3): number {
  const v = qRotate(quatFromEuler(rotation), [1, 0, 0]);
  return Math.atan2(-v[2], v[0]);
}

/** Pose that keeps the object's heading and puts it on the ground at its current x/z. */
export function reseat(obj: Placeable, terrain: TerrainSampler, x = obj.transform.position[0], z = obj.transform.position[2]): GroundPose {
  return groundPose(obj, x, z, yawOf(obj.transform.rotation), terrain);
}

/** Whether the object currently stands on the ground (rather than being lifted on purpose). */
export function isGrounded(obj: Placeable, terrain: TerrainSampler): boolean {
  return Math.abs(obj.transform.position[1] - reseat(obj, terrain).position[1]) <= GROUNDED_TOLERANCE;
}
