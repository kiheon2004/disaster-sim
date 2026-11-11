/**
 * Phase 37 — "here" and "there" for commands (audit U4 / U5), as pure maths: the ground point under the pointer
 * (`cursor`) and the point where the middle of the view meets the ground (`view`). The viewport components
 * (CursorTracker, CameraRig) feed these with a camera ray; nothing here knows three.js, the stores or the DOM.
 *
 * Both points are rounded to 0.1 m — the same step a mouse placement of a disaster uses (PlacementLayer `round1`,
 * catalog `pt`) — so "disaster … at=cursor" stores the value a click at that spot would store.
 */
import type { Vec3 } from '@/core/types';

export type XZ = [number, number];

/** The part of a TerrainSampler these functions need. */
export interface GroundRay {
  raycast(origin: Readonly<Vec3>, dir: Readonly<Vec3>, maxDist: number, out: Vec3): boolean;
}

/** Farthest ground a pointer / view ray is followed to (m) — as the disaster placement layer. */
export const RAY_REACH = 4000;

/** 0.1 m steps; −0 is written as 0 (the point is shown and compared as text). */
export function round1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}

export const roundPoint = (x: number, z: number): XZ => [round1(x), round1(z)];

export function samePoint(a: readonly [number, number] | null, b: readonly [number, number] | null): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
}

/**
 * Pointer position in normalized device coordinates (−1 … 1, y up) of a canvas rectangle; null when the rectangle has
 * no size (a hidden canvas) or the pointer is outside it.
 */
export function ndcOf(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): XZ | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;
  return Math.abs(x) <= 1 && Math.abs(y) <= 1 ? [x, y] : null;
}

/**
 * The cursor's ground point: where the ray meets the ground, on the map (|x|, |z| ≤ `half`) — a point a command can
 * place something at. null = the ray meets no ground (sky) or meets it outside the map; the caller then keeps the
 * point it had.
 */
export function groundPoint(ground: GroundRay, origin: Readonly<Vec3>, dir: Readonly<Vec3>, half: number, reach = RAY_REACH): XZ | null {
  const hit: Vec3 = [0, 0, 0];
  if (!ground.raycast(origin, dir, reach, hit)) return null;
  if (!Number.isFinite(hit[0]) || !Number.isFinite(hit[2])) return null;
  // (compared after rounding: a ray aimed at the map edge must not fall off it by a float's last digit)
  const p = roundPoint(hit[0], hit[2]);
  return Math.abs(p[0]) <= half && Math.abs(p[1]) <= half ? p : null;
}

/**
 * The view point: where the ray through the middle of the screen meets the ground; when it meets none (looking over
 * the horizon), the orbit target's (x, z); null when there is neither.
 */
export function viewPoint(ground: GroundRay, origin: Readonly<Vec3>, dir: Readonly<Vec3>, target: readonly [number, number] | null, reach = RAY_REACH): XZ | null {
  const hit: Vec3 = [0, 0, 0];
  if (ground.raycast(origin, dir, reach, hit) && Number.isFinite(hit[0]) && Number.isFinite(hit[2])) return roundPoint(hit[0], hit[2]);
  return target && Number.isFinite(target[0]) && Number.isFinite(target[1]) ? roundPoint(target[0], target[1]) : null;
}

/** What the tracker remembers between frames. */
export interface PointerState {
  /** Last pointer position over the canvas (client px). */
  x: number;
  y: number;
  /** The pointer is over the canvas right now. */
  inside: boolean;
  /** A button is down (camera drag, a tool's gesture): the ground under the pointer is not "here" meanwhile. */
  held: boolean;
  /** The pointer moved (or a drag ended) since the last look. */
  dirty: boolean;
}

export const newPointerState = (): PointerState => ({ x: 0, y: 0, inside: false, held: false, dirty: false });

/**
 * Whether the tracker should look up the ground point this frame: the pointer is over the canvas with no button down,
 * and it moved or the camera did. At most one look-up (and so one store write) per frame; a pointer that left the
 * canvas — to type in the command bar — keeps the last point.
 */
export function shouldSample(s: PointerState, cameraMoved: boolean): boolean {
  return s.inside && !s.held && (s.dirty || cameraMoved);
}
