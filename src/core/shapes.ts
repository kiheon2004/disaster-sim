import type { Vec3 } from './types';

/**
 * Engine-agnostic collision shapes in object local space (origin at the base center).
 * `massFraction` distributes the object's mass across shapes (defaults to volume-free equal split).
 */
interface ShapeBase {
  offset?: Vec3;
  massFraction?: number;
}

export type ShapeSpec =
  | (ShapeBase & { type: 'box'; halfExtents: Vec3 })
  | (ShapeBase & { type: 'capsule'; halfHeight: number; radius: number })
  | (ShapeBase & { type: 'cylinder'; halfHeight: number; radius: number })
  | (ShapeBase & { type: 'ball'; radius: number });
