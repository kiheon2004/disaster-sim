/** Member geometry helpers (building-local space, object scale applied). */
import type { Vec3 } from '@/core/types';
import type { BuildingMember } from './types';

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/** Rotate a local vector by Euler XYZ angles (same convention as three.js / quatFromEuler). */
export function rotateEuler(v: Vec3, r: Vec3): Vec3 {
  // R = Rz · Ry · Rx applied as intrinsic X then Y then Z (three.js 'XYZ').
  let [x, y, z] = v;
  // three.js XYZ: matrix = Rx · Ry · Rz → applied to v: Rx(Ry(Rz v)).
  const [a, b, c] = r;
  if (c !== 0) {
    const cs = Math.cos(c), sn = Math.sin(c);
    [x, y] = [x * cs - y * sn, x * sn + y * cs];
  }
  if (b !== 0) {
    const cs = Math.cos(b), sn = Math.sin(b);
    [x, z] = [x * cs + z * sn, -x * sn + z * cs];
  }
  if (a !== 0) {
    const cs = Math.cos(a), sn = Math.sin(a);
    [y, z] = [y * cs - z * sn, y * sn + z * cs];
  }
  return [x, y, z];
}

/** Axis-aligned bounds of a member (rotated box), scaled by the object scale. */
export function memberBounds(m: BuildingMember, k: Vec3 = [1, 1, 1]): Box3 {
  const hx = m.size[0] / 2, hy = m.size[1] / 2, hz = m.size[2] / 2;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const plain = m.rotation[0] === 0 && m.rotation[1] === 0 && m.rotation[2] === 0;
  if (plain) {
    for (let a = 0; a < 3; a++) {
      const h = a === 0 ? hx : a === 1 ? hy : hz;
      min[a] = (m.position[a] - h) * k[a];
      max[a] = (m.position[a] + h) * k[a];
    }
    return { min, max };
  }
  for (let i = 0; i < 8; i++) {
    const c = rotateEuler([i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz], m.rotation);
    for (let a = 0; a < 3; a++) {
      const v = (m.position[a] + c[a]) * k[a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/** Do two boxes overlap or touch within `tol` on every axis? */
export function touches(a: Box3, b: Box3, tol: number): boolean {
  return a.min[0] - tol <= b.max[0] && b.min[0] - tol <= a.max[0]
    && a.min[1] - tol <= b.max[1] && b.min[1] - tol <= a.max[1]
    && a.min[2] - tol <= b.max[2] && b.min[2] - tol <= a.max[2];
}

/** Horizontal (x/z) overlap area of two boxes (0 when disjoint). */
export function planOverlap(a: Box3, b: Box3, tol = 0): number {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]) + tol;
  const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]) + tol;
  return ox > 0 && oz > 0 ? ox * oz : 0;
}

/**
 * Member dimensions in its own axes after the object scale (yaw-aware: a member turned 90°
 * takes the object's z scale along its length).
 */
export function scaledSize(m: BuildingMember, k: Vec3 = [1, 1, 1]): Vec3 {
  const turned = Math.abs(Math.sin(m.rotation[1])) > 0.7071;
  return turned ? [m.size[0] * k[2], m.size[1] * k[1], m.size[2] * k[0]] : [m.size[0] * k[0], m.size[1] * k[1], m.size[2] * k[2]];
}

/** Unit vector (x, z) of a member's length axis (its local +x after yaw). */
export function lengthAxis(m: BuildingMember): [number, number] {
  const y = m.rotation[1];
  return [Math.cos(y), -Math.sin(y)];
}

/** Volume of the member box (m³, scaled). */
export function boxVolume(m: BuildingMember, k: Vec3 = [1, 1, 1]): number {
  return m.size[0] * m.size[1] * m.size[2] * k[0] * k[1] * k[2];
}
