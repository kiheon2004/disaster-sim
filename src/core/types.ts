/** Shared primitive types. This module must not depend on anything else in the app. */

export type EntityId = string;
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export interface Transform {
  position: Vec3;
  /** Euler angles in radians (XYZ order). */
  rotation: Vec3;
  scale: Vec3;
}

export type ObjectType =
  | 'ground'
  | 'road'
  | 'building'
  | 'tree'
  | 'car'
  | 'human'
  | 'streetLight'
  | 'sign'
  | 'wall'
  | 'custom'
  // Phase 35 Level 1 passive dynamic objects (free rigid bodies with explicit mass properties).
  | 'crate'
  | 'barrel'
  | 'container'
  | 'furniture'
  | 'roadBarrier'
  | 'ball';

export type ObjectCategory =
  | 'environment'
  | 'buildings'
  | 'nature'
  | 'vehicles'
  | 'people'
  | 'infrastructure'
  // Phase 35: loose objects (crates, barrels, containers, furniture, barriers, balls).
  | 'objects';

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export function identityTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}
