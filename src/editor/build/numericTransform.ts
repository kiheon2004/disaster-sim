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
import { groundPose, isGrounded, reseat, yawOf } from '@/terrain/groundPlacement';
import { releasePlinth } from '@/buildings/foundation';
import { moveTo } from './groupTransform';

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

// ── Common fields of a multi-selection (Phase 37 §17) ───────────────────────────────────────────────────────────────

/**
 * One value for a field of EVERY object ("X of all of them = 12"). Fields that are absent are left alone.
 *   x, y, z   world position of the origin (m)
 *   lift      height above the ground under each object (m; 0 = standing on it) — the Inspector's "height above ground"
 *   heading   the Y heading (°) as the Inspector shows it (the middle value of tilt X · heading Y · tilt Z)
 *   scale     uniform scale (×): the same factor on all three axes
 */
export interface CommonTransformPatch {
  x?: number;
  y?: number;
  z?: number;
  lift?: number;
  heading?: number;
  scale?: number;
}
export type CommonField = keyof CommonTransformPatch;
export const COMMON_FIELDS: readonly CommonField[] = ['x', 'y', 'z', 'lift', 'heading', 'scale'];

export interface CommonTransformResult {
  /** The objects that changed (unchanged ones are left out) — the caller commits them with ONE `applyEdit({ update })`. */
  objects: WorldObject[];
  /** Locked objects that were skipped (the caller reports the count). */
  locked: number;
  /** Fields whose value was outside its range and was limited (x / z: the world square; y / lift: the elevation range; scale: 0.1–10). */
  clamped: CommonField[];
  /** Fields whose value was not a finite number: ignored. */
  rejected: CommonField[];
  /** Modular buildings that kept their size under `scale` (their dimensions are design parameters, not a transform). */
  keptSize: number;
}

/** Headings equal up to whole turns (°). */
const sameHeading = (a: number, b: number, eps: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180) <= eps;

/**
 * Write the same value into a transform field of every object — the multi-selection form of the Inspector's numeric
 * fields, shared by `MultiInspector` and the Phase 37 command `set <target> x=…` (pure: no stores).
 *
 * The rules are those of the single-object fields (above), plus the group-move rule for x / z:
 *  - x / z / y pass `sanitizePosition` (inside the world square and the elevation range, never NaN);
 *  - x / z changed: an object that stood on the ground is re-seated at its new spot (height, and tilt on a slope) —
 *    as in a group move (`moveTo`, groupTransform.ts); a lifted object keeps its height (Phase 37 audit §6, E20);
 *  - y: the absolute height, for every object; lift: `withHeightAboveGround` at the object's (new) x / z. Either one
 *    overrides the seated height; given together, lift wins (it is applied last);
 *  - heading: each object keeps its own tilt (`displayRotation` / `storedRotation`), only the Y heading is replaced —
 *    the field reads back exactly the typed value. Like the single-object field it does not seat the object again:
 *    on a slope a turned object keeps the tilt it had ("same heading" in the Match section re-seats);
 *  - scale: 0.1–10 (`sanitizeScale`), all three axes; modular buildings keep their size (as in a group scale);
 *  - a changed object lets go of a frozen foundation plinth (`releasePlinth`, as `updateTransform` does). Road links
 *    are re-measured by the store when the update is applied.
 * Locked objects are skipped. Order inside one patch: heading and scale, then x / z (a re-seat uses the new heading
 * and scale), then y, then lift.
 */
export function setCommonTransform(objs: readonly WorldObject[], patch: CommonTransformPatch, terrain: TerrainSampler): CommonTransformResult {
  const rejected = COMMON_FIELDS.filter((k) => patch[k] !== undefined && !Number.isFinite(patch[k]));
  const has = (k: CommonField) => patch[k] !== undefined && Number.isFinite(patch[k]);
  const clamped = new Set<CommonField>();
  const out: WorldObject[] = [];
  let locked = 0, keptSize = 0;
  for (const o of objs) {
    if (o.locked) { locked++; continue; }
    const t = o.transform;
    const grounded = isGrounded(o, terrain);
    let next = o;
    if (has('heading')) {
      const d = displayRotation(t.rotation);
      if (!sameHeading(d[1], patch.heading!, 1e-9)) next = { ...next, transform: { ...next.transform, rotation: storedRotation([d[0], patch.heading!, d[2]]) } };
    }
    if (has('scale')) {
      if (o.building) keptSize++;
      else {
        const k = patch.scale!;
        const scale = sanitizeScale([k, k, k], t.scale);
        if (scale[0] !== k) clamped.add('scale');
        if (scale.some((v, i) => v !== t.scale[i])) next = { ...next, transform: { ...next.transform, scale } };
      }
    }
    if (has('x') || has('z')) {
      const s = sanitizePosition([patch.x ?? NaN, t.position[1], patch.z ?? NaN], t.position);
      for (const a of s.clamped) if (a !== 'y') clamped.add(a);
      next = moveTo(next, s.value[0], s.value[2], terrain, grounded);
    }
    if (has('y') || has('lift')) {
      const p = next.transform.position;
      const y = has('lift') ? withHeightAboveGround(next, patch.lift!, terrain)[1] : patch.y!;
      const s = sanitizePosition([p[0], y, p[2]], p);
      if (s.clamped.length) clamped.add(has('lift') ? 'lift' : 'y');
      if (s.value[1] !== p[1]) next = { ...next, transform: { ...next.transform, position: s.value } };
    }
    if (next !== o) out.push(releasePlinth(next));
  }
  return { objects: out, locked, clamped: COMMON_FIELDS.filter((k) => clamped.has(k)), rejected, keptSize };
}

/**
 * The value each common field shows for a selection: the value when every object agrees (within `eps`; headings up to
 * whole turns), null when they differ ("mixed") or the selection is empty. `scale` is a value only when every object
 * is scaled uniformly by the same factor. A field stops reading at the first object that differs.
 */
export function commonTransform(objs: readonly WorldObject[], terrain: TerrainSampler, eps = 1e-4): Record<CommonField, number | null> {
  const agree = (read: (o: WorldObject) => number, same = (a: number, b: number) => Math.abs(a - b) <= eps): number | null => {
    if (!objs.length) return null;
    const first = read(objs[0]);
    if (!Number.isFinite(first)) return null;
    for (let i = 1; i < objs.length; i++) {
      const v = read(objs[i]);
      if (!Number.isFinite(v) || !same(v, first)) return null;
    }
    return first;
  };
  return {
    x: agree((o) => o.transform.position[0]),
    y: agree((o) => o.transform.position[1]),
    z: agree((o) => o.transform.position[2]),
    lift: agree((o) => heightAboveGround(o, terrain)),
    heading: agree((o) => displayRotation(o.transform.rotation)[1], (a, b) => sameHeading(a, b, eps)),
    scale: agree((o) => { const s = o.transform.scale; return Math.abs(s[0] - s[1]) <= eps && Math.abs(s[0] - s[2]) <= eps ? s[0] : NaN; }),
  };
}
