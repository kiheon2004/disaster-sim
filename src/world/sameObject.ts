import type { WorldObject } from '@/core/model';

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
