/**
 * The last part of the flight, inside the world (Phase 23): a ballistic arc under gravity from the
 * hand-over point until it meets the TERRAIN. The hand-over point is solved so that the arc would
 * reach the aim point on level ground at the aim point's height (the way one aims a ballistic
 * shot); a hill or a valley on the way moves the real impact — the actual impact point is wherever
 * the arc meets the ground, never moved to the click. The difference is reported.
 *
 * Air drag inside the last 1.5 km is neglected (for the bodies that reach the ground intact it
 * changes the speed by well under 1 %; the entry stage carries the drag history).
 */
import { GRAVITY } from '@/core/units';

export interface ArcInput {
  /** Aim point (x, z) and the ground height there. */
  aim: [number, number];
  aimHeight: number;
  /** Speed at hand-over (m/s), angle above horizontal (deg), bearing of travel (deg, 0 = N, 90 = E). */
  speed: number;
  angle: number;
  azimuth: number;
  /** Height of the hand-over point above the aim point (m). */
  handover: number;
}

export interface ArcResult {
  start: [number, number, number];
  velocity0: [number, number, number];
  /** Impact point (x, y, z), velocity there, flight time from hand-over (s). */
  point: [number, number, number];
  velocity: [number, number, number];
  time: number;
  /** Horizontal distance between aim point and impact point (m). */
  miss: number;
  /** Impact angle above the local horizontal of the arc (deg) and speed (m/s). */
  angle: number;
  speed: number;
  hit: boolean;
}

/** World direction of a bearing (x = east, z = south): (sin b, −cos b). */
export function bearingDir(deg: number): [number, number] {
  const b = (deg * Math.PI) / 180;
  return [Math.sin(b), -Math.cos(b)];
}

/** Integrate the arc (exact parabola, terrain met by stepping + bisection). */
export function flyArc(a: ArcInput, ground: (x: number, z: number) => number): ArcResult {
  const th = (a.angle * Math.PI) / 180;
  const [dx, dz] = bearingDir(a.azimuth);
  // Back-solve the hand-over point: the ballistic arc from it meets the aim point on LEVEL ground at
  // the aim height (h = v·sinθ·t + ½·g·t²); the terrain then decides where it really lands.
  const vs = a.speed * Math.sin(th), vh = a.speed * Math.cos(th);
  const tLevel = (-vs + Math.sqrt(vs * vs + 2 * GRAVITY * a.handover)) / GRAVITY;
  const horiz = vh * tLevel;
  const start: [number, number, number] = [a.aim[0] - dx * horiz, a.aimHeight + a.handover, a.aim[1] - dz * horiz];
  const v0: [number, number, number] = [dx * vh, -vs, dz * vh];
  const at = (t: number): [number, number, number] => [start[0] + v0[0] * t, start[1] + v0[1] * t - 0.5 * GRAVITY * t * t, start[2] + v0[2] * t];
  const above = (t: number) => { const p = at(t); return p[1] - ground(p[0], p[2]); };
  // Step ≤ 0.25 m along the path, until below ground (or a generous time limit).
  const step = 0.25 / a.speed;
  const tMax = (4 * a.handover) / Math.max(1, a.speed * Math.sin(th)) + 10;
  let t0 = 0, hit = false, t1 = 0;
  for (let t = step; t <= tMax; t += step) {
    if (above(t) <= 0) { t1 = t; hit = true; break; }
    t0 = t;
  }
  if (!hit) t1 = tMax;
  for (let k = 0; hit && k < 40; k++) {
    const m = (t0 + t1) / 2;
    if (above(m) > 0) t0 = m; else t1 = m;
  }
  const t = t1;
  const p = at(t);
  const vel: [number, number, number] = [v0[0], v0[1] - GRAVITY * t, v0[2]];
  const vHit = Math.hypot(vel[0], vel[2]);
  return {
    start, velocity0: v0, point: p, velocity: vel, time: t,
    miss: Math.hypot(p[0] - a.aim[0], p[2] - a.aim[1]),
    angle: (Math.atan2(-vel[1], vHit) * 180) / Math.PI,
    speed: Math.hypot(vHit, vel[1]),
    hit,
  };
}
