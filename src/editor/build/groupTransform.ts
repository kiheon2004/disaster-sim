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
import { groundPose, isGrounded, reseat, yawOf } from '@/terrain/groundPlacement';
import { getDefinition } from '@/objects/registry';
import { releasePlinth } from '@/buildings/foundation';

export interface RigidDelta {
  dx: number;
  dy: number;
  dz: number;
  /** Rotation about +Y through the pivot (rad). */
  dyaw: number;
  /**
   * Uniform scale about the pivot (Phase 17; default 1): offsets from the pivot and object
   * scales grow together. Modular buildings move with the group but keep their size — their
   * dimensions are design parameters (Building Creator), not a transform.
   */
  scale?: number;
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
  const k = d.scale ?? 1;
  return objs.map((orig) => {
    const o = k !== 1 && !orig.building ? { ...orig, transform: { ...orig.transform, scale: orig.transform.scale.map((v) => Math.min(10, Math.max(0.1, v * k))) as Vec3 } } : orig;
    const [px, py, pz] = o.transform.position;
    const rx = (px - pivot.x) * k;
    const rz = (pz - pivot.z) * k;
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
/**
 * What alignment lines up (Phase 36 §14 — shown in the panel): 'origin' = the objects' origins (pivots), as since
 * Phase 16; 'bounds' = their footprints (the rotated box of each object on the ground): min = left / near edges
 * flush, center = footprint centres, max = right / far edges flush.
 */
export type AlignRef = 'origin' | 'bounds';

/** Half extent of an object's footprint along world x (k = 0) or z (k = 2), rotation included. */
export function footprintHalf(o: WorldObject, k: 0 | 2): number {
  const d = getDefinition(o.type).getDimensions(o.params);
  const hx = (d[0] * o.transform.scale[0]) / 2, hz = (d[2] * o.transform.scale[2]) / 2;
  const yaw = yawOf(o.transform.rotation);
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  return k === 0 ? c * hx + s * hz : s * hx + c * hz;
}

/** Line the objects up on one axis (to the smallest, middle or largest value of their origins or footprints). */
export function alignObjects(objs: readonly WorldObject[], axis: AlignAxis, mode: AlignMode, terrain: TerrainSampler, ref: AlignRef = 'origin'): WorldObject[] {
  if (objs.length < 2) return [...objs];
  const k = axis === 'x' ? 0 : 2;
  const half = (o: WorldObject) => (ref === 'bounds' ? footprintHalf(o, k) : 0);
  const lo = Math.min(...objs.map((o) => o.transform.position[k] - half(o)));
  const hi = Math.max(...objs.map((o) => o.transform.position[k] + half(o)));
  const mid = (lo + hi) / 2;
  return objs.map((o) => {
    const v = mode === 'min' ? lo + half(o) : mode === 'max' ? hi - half(o) : mid;
    return moveTo(o, k === 0 ? v : o.transform.position[0], k === 2 ? v : o.transform.position[2], terrain);
  });
}

/**
 * Equal GAPS between footprints along an axis (Phase 36 §14), between the first and the last object (both stay):
 * objects of different sizes end up evenly spaced edge to edge, unlike distributeObjects (equal origin steps).
 */
export function distributeGaps(objs: readonly WorldObject[], axis: AlignAxis, terrain: TerrainSampler): WorldObject[] {
  if (objs.length < 3) return [...objs];
  const k = axis === 'x' ? 0 : 2;
  const sorted = [...objs].sort((a, b) => a.transform.position[k] - b.transform.position[k] || a.id.localeCompare(b.id));
  const halves = sorted.map((o) => footprintHalf(o, k));
  const lo = sorted[0].transform.position[k] - halves[0];
  const hi = sorted[sorted.length - 1].transform.position[k] + halves[halves.length - 1];
  const gap = (hi - lo - halves.reduce((s, h) => s + 2 * h, 0)) / (sorted.length - 1);
  const target = new Map<string, number>();
  let cursor = lo;
  sorted.forEach((o, i) => { target.set(o.id, cursor + halves[i]); cursor += 2 * halves[i] + gap; });
  return objs.map((o) => {
    const v = target.get(o.id)!;
    return moveTo(o, k === 0 ? v : o.transform.position[0], k === 2 ? v : o.transform.position[2], terrain);
  });
}

export type MatchWhat = 'rotation' | 'height' | 'scale';

/**
 * Give the objects the same heading / height above the ground / scale as `ref` (Phase 36 §14 "same rotation /
 * height / size"). Objects standing on the ground stay on it (a new heading is re-seated on the slope); height copies
 * the reference's height ABOVE ITS GROUND, so objects on different terrain keep their relation to the ground.
 */
export function matchObjects(objs: readonly WorldObject[], ref: WorldObject, what: MatchWhat, terrain: TerrainSampler): WorldObject[] {
  const refYaw = yawOf(ref.transform.rotation);
  const refLift = ref.transform.position[1] - reseat(ref, terrain).position[1];
  return objs.map((o) => {
    if (o.id === ref.id) return o;
    const t = o.transform;
    if (what === 'scale') return { ...o, transform: { ...t, scale: [...ref.transform.scale] as Vec3 } };
    if (what === 'height') {
      const seat = reseat(o, terrain).position[1];
      return releasePlinth({ ...o, transform: { ...t, position: [t.position[0], seat + refLift, t.position[2]] as Vec3 } });
    }
    const turned = { ...o, transform: { ...t, rotation: yawRotate(t.rotation, refYaw - yawOf(t.rotation)) } };
    if (!isGrounded(o, terrain) || terrain.flat) return turned;
    const pose = groundPose(turned, t.position[0], t.position[2], refYaw, terrain);
    return releasePlinth({ ...turned, transform: { ...turned.transform, position: pose.position, rotation: pose.rotation } });
  });
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
