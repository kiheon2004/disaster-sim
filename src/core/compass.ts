import type { Vec3 } from './types';
import { degToRad } from './math';

export const COMPASS_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassDir = (typeof COMPASS_DIRS)[number];

/** Bearing in degrees, clockwise from North. */
export const COMPASS_BEARING: Record<CompassDir, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
};

export function bearingOf(dir: CompassDir | number): number {
  return typeof dir === 'number' ? ((dir % 360) + 360) % 360 : COMPASS_BEARING[dir];
}

/** Horizontal unit vector pointing TOWARD the given bearing (+X = East, -Z = North). */
export function bearingToVector(bearingDeg: number): Vec3 {
  const r = degToRad(bearingDeg);
  return [Math.sin(r), 0, -Math.cos(r)];
}

/**
 * Wind "from" bearing → unit vector of the direction the air actually moves.
 * e.g. wind from East (90°) moves toward West: [-1, 0, 0].
 */
export function windFlowVector(fromBearingDeg: number): Vec3 {
  const v = bearingToVector(fromBearingDeg);
  return [-v[0], 0, -v[2]];
}

export function nearestCompass(bearingDeg: number): CompassDir {
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_DIRS[idx];
}
