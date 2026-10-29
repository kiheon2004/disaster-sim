/**
 * Rigid transforms of several objects as one (Phase 16): move / rotate about a common pivot
 * keeping their relative layout, plus align / distribute. Objects that stood on the ground are
 * re-seated on the terrain at their new spot (category rules); lifted ones keep their height.
 * Each object stays its own physics body — a group is an editing convenience only.
 */
import type { Quat, Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { eulerFromQuat, qMul, quatFromAxisAngle, quatFromEuler } from '@/core/math';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { groundPose, isGrounded, yawOf } from '@/terrain/groundPlacement';
import { releasePlinth } from '@/buildings/foundation';

export interface RigidDelta {
  dx: number;
  dy: number;
  dz: number;
  /** Rotation about +Y through the pivot (rad). */
  dyaw: number;
}

/** Center of the objects' positions on the ground plane (bounds center). */
export function selectionPivot(objs: readonly WorldObject[]): { x: number; z: number; y: number } {
  if (!objs.length) return { x: 0, z: 0, y: 0 };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity;
  for (const o of objs) {
    const p = o.transform.position;
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
    y0 = Math.min(y0, p[1]);
  }
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, y: y0 };
}

/** Rotate a rotation (Euler XYZ) by `dyaw` about world +Y. */
export function yawRotate(rotation: Vec3, dyaw: number): Vec3 {
  if (dyaw === 0) return rotation;
  const q: Quat = qMul(quatFromAxisAngle([0, 1, 0], dyaw), quatFromEuler(rotation));
  return eulerFromQuat(q);
}

/**
 * New objects after a rigid move / rotation of all of them about `pivot`. Pure: the inputs
 * are not modified.
 */
export function transformObjects(objs: readonly WorldObject[], pivot: { x: number; z: number }, d: RigidDelta, terrain: TerrainSampler): WorldObject[] {
  const c = Math.cos(d.dyaw);
  const s = Math.sin(d.dyaw);
  return objs.map((o) => {
    const [px, py, pz] = o.transform.position;
    const rx = px - pivot.x;
    const rz = pz - pivot.z;
    // Rotation about +Y by dyaw: x' = x cos + z sin, z' = −x sin + z cos (three.js convention).
    const x = pivot.x + rx * c + rz * s + d.dx;
    const z = pivot.z - rx * s + rz * c + d.dz;
    const grounded = d.dy === 0 && isGrounded(o, terrain);
    if (grounded) {
      const pose = groundPose(o, x, z, yawOf(o.transform.rotation) + d.dyaw, terrain);
      // Keep any extra tilt the user gave on flat ground (groundPose returns pure yaw there).
      const rotation = terrain.flat ? yawRotate(o.transform.rotation, d.dyaw) : pose.rotation;
      return releasePlinth({ ...o, transform: { ...o.transform, position: pose.position, rotation } });
    }
    const y = py + d.dy;
    return releasePlinth({ ...o, transform: { ...o.transform, position: [x, y, z] as Vec3, rotation: yawRotate(o.transform.rotation, d.dyaw) } });
  });
}

export type AlignAxis = 'x' | 'z';
export type AlignMode = 'min' | 'center' | 'max';

/** Line the objects' positions up on one axis (to the smallest, middle or largest value). */
export function alignObjects(objs: readonly WorldObject[], axis: AlignAxis, mode: AlignMode, terrain: TerrainSampler): WorldObject[] {
  if (objs.length < 2) return [...objs];
  const k = axis === 'x' ? 0 : 2;
  const vals = objs.map((o) => o.transform.position[k]);
  const target = mode === 'min' ? Math.min(...vals) : mode === 'max' ? Math.max(...vals) : (Math.min(...vals) + Math.max(...vals)) / 2;
  return objs.map((o) => moveTo(o, k === 0 ? target : o.transform.position[0], k === 2 ? target : o.transform.position[2], terrain));
}

/** Spread the objects evenly between the first and last along an axis (order kept). */
export function distributeObjects(objs: readonly WorldObject[], axis: AlignAxis, terrain: TerrainSampler): WorldObject[] {
  if (objs.length < 3) return [...objs];
  const k = axis === 'x' ? 0 : 2;
  const sorted = [...objs].sort((a, b) => a.transform.position[k] - b.transform.position[k] || a.id.localeCompare(b.id));
  const lo = sorted[0].transform.position[k];
  const hi = sorted[sorted.length - 1].transform.position[k];
  const step = (hi - lo) / (sorted.length - 1);
  const target = new Map(sorted.map((o, i) => [o.id, lo + step * i]));
  return objs.map((o) => {
    const v = target.get(o.id)!;
    return moveTo(o, k === 0 ? v : o.transform.position[0], k === 2 ? v : o.transform.position[2], terrain);
  });
}

function moveTo(o: WorldObject, x: number, z: number, terrain: TerrainSampler): WorldObject {
  const p = o.transform.position;
  if (x === p[0] && z === p[2]) return o;
  if (isGrounded(o, terrain)) {
    const pose = groundPose(o, x, z, yawOf(o.transform.rotation), terrain);
    return releasePlinth({ ...o, transform: { ...o.transform, position: pose.position, rotation: terrain.flat ? o.transform.rotation : pose.rotation } });
  }
  return releasePlinth({ ...o, transform: { ...o.transform, position: [x, p[1], z] } });
}
