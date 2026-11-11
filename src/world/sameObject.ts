import type { WorldObject } from '@/core/model';
import { sameOrientation } from '@/core/math';

/**
 * The same object VALUE (Phase 37): objects are immutable values, and an edit may hand back a new object that says
 * exactly what the old one said (locked then unlocked, aligned when already aligned, the same scale again). For "did
 * anything change" such an object is not a change. Building designs are large shared values compared by reference:
 * another design object is another design.
 */
export function sameObjectValue(a: WorldObject, b: WorldObject): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (ra[k] === rb[k]) continue;
    if (k === 'building' || JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) return false;
  }
  return true;
}

/** Below this a position (m) / orientation (quaternion component) difference is numerical noise, not a move. */
const POSE_EPS = 1e-9;

/**
 * The same POSE: the same place, size and orientation. The numbers may differ — a heading written back as −0.78 rad
 * for 5.5 rad, the other Euler form of the same orientation, or a last bit off after a quaternion round trip. The store
 * re-seats grounded objects within 40 m of a terrain change and writes their heading back that way even when the ground
 * under them did not change; such an object has not moved.
 */
export function samePose(a: WorldObject, b: WorldObject): boolean {
  if (a.transform === b.transform) return true;
  return (
    a.transform.position.every((v, i) => Math.abs(v - b.transform.position[i]) <= POSE_EPS) &&
    a.transform.scale.every((v, i) => v === b.transform.scale[i]) &&
    sameOrientation(a.transform.rotation, b.transform.rotation, POSE_EPS)
  );
}

/** The same object for a user: the same pose (whatever numbers it is written with) and the same value otherwise. */
export function sameObjectState(a: WorldObject, b: WorldObject): boolean {
  if (a === b) return true;
  return samePose(a, b) && sameObjectValue(a, a.transform === b.transform ? b : { ...b, transform: a.transform });
}
