import type { Vec3 } from '@/core/types';
import { WORLD_HALF } from '@/core/units';

/** Snap a ground point to the grid (1 m for large objects, 0.5 m for small ones). */
export function snapPoint(p: Vec3, enabled: boolean, footprint: number): Vec3 {
  if (!enabled) return [p[0], 0, p[2]];
  const step = footprint >= 3 ? 1 : 0.5;
  return [Math.round(p[0] / step) * step, 0, Math.round(p[2] / step) * step];
}

/** Whether an object with the given footprint at position/yaw lies inside the world bounds. */
export function isInsideWorld(pos: Vec3, dims: Vec3, yaw: number): boolean {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (dims[0] * c + dims[2] * s) / 2;
  const hz = (dims[0] * s + dims[2] * c) / 2;
  return Math.abs(pos[0]) + hx <= WORLD_HALF && Math.abs(pos[2]) + hz <= WORLD_HALF;
}
