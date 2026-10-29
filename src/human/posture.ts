/**
 * Phase 33: posture of the reduced human model, read from the rigid body's actual pose, velocity and contacts (never from an
 * animation). "Up" is −ĝ of the local field (world +y when gravity is negligible).
 */
import type { Vec3 } from '@/core/types';

export const POSTURES = ['upright', 'leaning', 'falling', 'airborne', 'landing', 'prone', 'supine', 'sideLying', 'sliding', 'tumbling', 'resting', 'incapacitated'] as const;
export type Posture = (typeof POSTURES)[number];
export type LyingSide = 'prone' | 'supine' | 'side';

/** Thresholds of the classifier (documented in HUMAN_PHYSICS.md §7). */
export const POSTURE = {
  /** Lean (rad) of a standing person shown as "leaning". */
  lean: 0.05,
  /** Tilt (rad) of the body axis from up beyond which a released body counts as lying. */
  lying: (60 * Math.PI) / 180,
  /** Steps without any contact before a released body is "airborne". */
  airSteps: 6,
  /** Angular speed (rad/s) of tumbling. */
  tumble: 2,
  /** Speed (m/s) of sliding. */
  slide: 0.3,
  /** Still: speed and angular speed below these for `stillTime` s → resting. */
  stillV: 0.05,
  stillW: 0.1,
  stillTime: 1,
  /** A contact episode that started within this time (s) after an airborne / falling phase marks "landing". */
  landing: 0.25,
} as const;

export interface PostureInput {
  standing: boolean;
  /** Lean of a standing body (rad). */
  lean: number;
  /** Body axis (local +y) and facing (local +z) in world space (unit). */
  axis: Readonly<Vec3>;
  facing: Readonly<Vec3>;
  /** Local up (unit). */
  up: Readonly<Vec3>;
  speed: number;
  spin: number;
  /** Consecutive steps without contact. */
  freeSteps: number;
  /** Seconds the body has been still. */
  stillFor: number;
  /** Seconds since the last landing (impact after a free / falling phase); Infinity = none. */
  sinceLanding: number;
  incapacitated: boolean;
}

export function lyingSide(facing: Readonly<Vec3>, up: Readonly<Vec3>): LyingSide {
  const d = facing[0] * up[0] + facing[1] * up[1] + facing[2] * up[2];
  return d > 0.5 ? 'supine' : d < -0.5 ? 'prone' : 'side';
}

export function tiltFromUp(axis: Readonly<Vec3>, up: Readonly<Vec3>): number {
  return Math.acos(Math.max(-1, Math.min(1, axis[0] * up[0] + axis[1] * up[1] + axis[2] * up[2])));
}

export function classifyPosture(p: PostureInput): Posture {
  if (p.standing) return p.lean > POSTURE.lean ? 'leaning' : 'upright';
  if (p.freeSteps >= POSTURE.airSteps) return 'airborne';
  if (p.spin > POSTURE.tumble) return 'tumbling';
  const lying = tiltFromUp(p.axis, p.up) > POSTURE.lying;
  if (p.sinceLanding < POSTURE.landing) return 'landing';
  if (!lying) return p.spin > POSTURE.stillW || p.speed > POSTURE.stillV ? 'falling' : 'upright';
  if (p.speed > POSTURE.slide) return 'sliding';
  if (p.stillFor >= POSTURE.stillTime) return p.incapacitated ? 'incapacitated' : 'resting';
  const side = lyingSide(p.facing, p.up);
  return side === 'side' ? 'sideLying' : side;
}
