/**
 * Exact transform values typed in the Inspector (Phase 36 §12): the rules a typed number must satisfy before it reaches
 * the document, and the "relative to the ground" quantities the fields show.
 *
 *  - x / z: inside the world square (±WORLD_HALF); a value outside is clamped and reported (never stored, never NaN).
 *  - y: between the lowest terrain (MIN_ELEVATION) and a generous ceiling — before Phase 36 the field clamped y ≥ 0,
 *    so an object on ground below sea level (terrain goes down to −40 m) could not be typed into place.
 *  - height above ground = y − the seated height at (x, z) (the same seat rule placement and the gizmo use).
 *  - drop to ground = the seated pose: height and — on a slope — the tilt of the object's category (or its chosen
 *    terrain alignment); heading kept.
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { degToRad, radToDeg } from '@/core/math';
import type { WorldObject } from '@/core/model';
import { WORLD_HALF } from '@/core/units';
import { MAX_ELEVATION, MIN_ELEVATION } from '@/terrain/TerrainData';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { groundPose, reseat, yawOf } from '@/terrain/groundPlacement';

/** Highest typed origin (m): far above any terrain (MAX_ELEVATION) and any building (≤ 150 m). */
export const MAX_TYPED_Y = MAX_ELEVATION + 400;

export interface Sanitized {
  value: Vec3;
  /** Axes that were outside their range (clamped). */
  clamped: ('x' | 'y' | 'z')[];
  /** Non-finite input (NaN / ±Infinity) — the previous value was kept for that axis. */
  rejected: ('x' | 'y' | 'z')[];
}

const AX = ['x', 'y', 'z'] as const;

/** A typed position made safe: finite, inside the world square, between the lowest terrain and MAX_TYPED_Y. */
export function sanitizePosition(next: Vec3, prev: Vec3): Sanitized {
  const lo: Vec3 = [-WORLD_HALF, MIN_ELEVATION, -WORLD_HALF];
  const hi: Vec3 = [WORLD_HALF, MAX_TYPED_Y, WORLD_HALF];
  const out: Vec3 = [prev[0], prev[1], prev[2]];
  const clamped: Sanitized['clamped'] = [];
  const rejected: Sanitized['rejected'] = [];
  for (let i = 0; i < 3; i++) {
    const v = next[i];
    if (!Number.isFinite(v)) { rejected.push(AX[i]); continue; }
    const c = Math.min(hi[i], Math.max(lo[i], v));
    if (c !== v) clamped.push(AX[i]);
    out[i] = c;
  }
  return { value: out, clamped, rejected };
}

/** Typed scale made safe: finite, 0.1–10 per axis (the Inspector's range). */
export function sanitizeScale(next: Vec3, prev: Vec3): Vec3 {
  return next.map((v, i) => (Number.isFinite(v) ? Math.min(10, Math.max(0.1, v)) : prev[i])) as Vec3;
}

/** Seated height (m) of the object's origin at its x / z. */
export function seatHeight(obj: Pick<WorldObject, 'type' | 'params' | 'transform' | 'terrainAlign' | 'building'>, terrain: TerrainSampler): number {
  return reseat(obj, terrain).position[1];
}

/** Height of the origin above its seated pose (m; 0 = standing on the ground). */
export function heightAboveGround(obj: Pick<WorldObject, 'type' | 'params' | 'transform' | 'terrainAlign' | 'building'>, terrain: TerrainSampler): number {
  return obj.transform.position[1] - seatHeight(obj, terrain);
}

/** Position with the given height above the ground at the object's x / z (x / z unchanged). */
export function withHeightAboveGround(obj: Pick<WorldObject, 'type' | 'params' | 'transform' | 'terrainAlign' | 'building'>, h: number, terrain: TerrainSampler): Vec3 {
  const [x, , z] = obj.transform.position;
  return [x, seatHeight(obj, terrain) + (Number.isFinite(h) ? h : 0), z];
}

/**
 * The seated pose (drop to ground): `align` 1 = follow the slope, 0 = upright, undefined = the object's chosen
 * alignment / category rule. Heading kept.
 */
export function droppedTransform(obj: Pick<WorldObject, 'type' | 'params' | 'transform' | 'terrainAlign' | 'building'>, terrain: TerrainSampler, align?: number): { position: Vec3; rotation: Vec3 } {
  const [x, , z] = obj.transform.position;
  const pose = groundPose(obj, x, z, yawOf(obj.transform.rotation), terrain, align);
  return { position: pose.position, rotation: pose.rotation };
}

const qTmp = new THREE.Quaternion();
const eTmp = new THREE.Euler();
/** Stored rotation (XYZ Euler) shown as tilt X · heading Y · tilt Z (YXZ order): a pure heading of 120° reads (0, 120, 0), not (180, 60, 180). */
export function displayRotation(r: Vec3): Vec3 {
  qTmp.setFromEuler(eTmp.set(r[0], r[1], r[2], 'XYZ'));
  eTmp.setFromQuaternion(qTmp, 'YXZ');
  return [radToDeg(eTmp.x), radToDeg(eTmp.y), radToDeg(eTmp.z)];
}
export function storedRotation(deg: Vec3): Vec3 {
  qTmp.setFromEuler(eTmp.set(degToRad(deg[0]), degToRad(deg[1]), degToRad(deg[2]), 'YXZ'));
  eTmp.setFromQuaternion(qTmp, 'XYZ');
  return [eTmp.x, eTmp.y, eTmp.z];
}
