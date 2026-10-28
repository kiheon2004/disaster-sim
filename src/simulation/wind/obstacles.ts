import type { EntityId } from '@/core/types';
import { qRotate } from '@/core/math';
import type { RuntimeEntity } from '../SimulationRuntime';

/** Oriented box (footprint + height) that blocks the wind. */
export interface WindObstacle {
  id: EntityId;
  cx: number;
  cz: number;
  /** Half extents of the footprint in the obstacle's local frame. */
  hx: number;
  hz: number;
  /** World-space unit vectors of the local x and z axes (horizontal). */
  ax: [number, number];
  az: [number, number];
  height: number;
  /** Ground elevation of the obstacle's base; heights in the wake model are measured from here. */
  baseY: number;
  active: boolean;
}

/** Obstacles shorter than this do not cast a meaningful wake. */
export const MIN_OBSTACLE_HEIGHT = 1.5;

/** Buildings and walls block the wind; everything else is treated as porous/small. */
export function obstacleFromEntity(e: RuntimeEntity): WindObstacle | null {
  if (e.source.type !== 'building' && e.source.type !== 'wall') return null;
  const [w, h, d] = e.dims;
  if (h < MIN_OBSTACLE_HEIGHT) return null;
  const x = qRotate(e.initialPose.quaternion, [1, 0, 0]);
  const z = qRotate(e.initialPose.quaternion, [0, 0, 1]);
  const nx = Math.hypot(x[0], x[2]) || 1;
  const nz = Math.hypot(z[0], z[2]) || 1;
  // Buildings include the parapet in dims; the core height is what matters for the wake.
  const height = e.source.type === 'building' ? h - 0.7 * e.source.transform.scale[1] : h;
  return {
    id: e.id,
    cx: e.initialPose.position[0],
    cz: e.initialPose.position[2],
    hx: w / 2,
    hz: d / 2,
    ax: [x[0] / nx, x[2] / nx],
    az: [z[0] / nz, z[2] / nz],
    height,
    baseY: e.initialPose.position[1],
    active: true,
  };
}
