/**
 * Placed vortex wind (Phase 35.5) — a tornado-scale whirlwind at a point of the map, saved in the experiment plan.
 *
 * Scale note: a typhoon's core (radius of maximum wind) is tens of kilometres wide, so over this 200 m map a typhoon is
 * the uniform global wind (the 'wind' phenomenon). A vortex whose core fits on the map is tornado / whirlwind scale;
 * several of them can be placed independently and their winds add to the global wind and to each other.
 */
export interface TornadoSpec {
  event: 'tornado';
  /** Initial centre, world [x, z] (m). */
  position: [number, number];
  /** Peak tangential wind at 10 m height (m/s), reached at `coreRadius`. */
  maxSpeed: number;
  /** Radius of maximum wind (m). */
  coreRadius: number;
  /** Radius beyond which the vortex adds no wind (m) — tapered to zero from 0.8 of it. */
  outerRadius: number;
  /** Holland profile shape B (1 = the classic profile; larger = sharper peak). Default 1. */
  shape?: number;
  /** Surface inflow angle (deg): the near-ground air spirals inward. Default 20. */
  inflowAngle?: number;
  /** Rotation seen from above: counter-clockwise (cyclonic in the northern hemisphere, default) or clockwise. */
  rotation?: 'ccw' | 'cw';
  /** Translation speed of the centre (m/s), default 0. */
  trackSpeed?: number;
  /** Bearing the centre moves TOWARD (deg, 0 = N, 90 = E). */
  trackBearing?: number;
  /** Seconds, including the ramps. */
  duration: number;
  /** Seconds to spin up (and to die down at the end). Default 5. */
  rampDuration?: number;
  startTime?: number;
  name?: string;
}

export const TORNADO_LIMITS = {
  maxSpeed: [5, 140],
  coreRadius: [3, 200],
  outerRadius: [10, 1000],
  shape: [0.5, 2.5],
  inflowAngle: [0, 45],
  trackSpeed: [0, 40],
  duration: [5, 3600],
  rampDuration: [0.5, 120],
} as const;

export const TORNADO_DEFAULTS = { shape: 1, inflowAngle: 20, rotation: 'ccw' as const, trackSpeed: 0, trackBearing: 90, rampDuration: 5 };
