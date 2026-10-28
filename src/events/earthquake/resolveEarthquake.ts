/**
 * EarthquakeEventSpec → fully specified scenario, plus the list of assumptions that were made.
 *
 * Magnitude and ground-motion intensity are different things: magnitude describes the source,
 * PGA the shaking at a site (it also depends on distance, depth, path and soil). When the user
 * gives no PGA we still need a number to run, so we fill it with a deliberately rough
 * attenuation-style estimate and flag it as an ASSUMPTION — never as a prediction. Every other
 * default (duration, frequency, depth, epicenter, direction) is flagged the same way.
 */
import { clamp } from '@/core/math';
import type { I18nMessage } from '@/i18n/i18n';
import type { EarthquakeEventSpec } from '../specs';

export interface ResolvedEarthquake {
  magnitude: number;
  /** World [x, z] (m). */
  epicenter: [number, number];
  /** Hypocenter depth (km). */
  depth: number;
  duration: number;
  /** Peak horizontal ground acceleration on the reference site at the map center (g). */
  pga: number;
  /** True when `pga` was not given and comes from the rough magnitude/distance assumption. */
  pgaAssumed: boolean;
  dominantFrequency: number;
  /** Bearing (deg) of the principal horizontal shaking axis. */
  direction: number;
  verticalRatio: number;
  seed: number;
  /** Defaults applied (shown next to the parsed command / in the form). */
  assumptions: I18nMessage[];
}

export const EQ_LIMITS = {
  magnitude: [3, 9.5],
  pga: [0.01, 2],
  duration: [5, 180],
  frequency: [0.3, 10],
  depth: [0, 700],
  verticalRatio: [0, 1.5],
} as const;

export const DEFAULT_DEPTH_KM = 10;
export const DEFAULT_VERTICAL_RATIO = 0.5;

/** Event length grows with magnitude (longer rupture): ≈ 16 s at M6.5, 32 s at M7.5. */
export function defaultDuration(m: number): number {
  return Math.round(clamp(10 ** (0.3 * m - 0.75), 8, 120));
}

/** Larger earthquakes radiate relatively more long-period energy: ≈ 1.8 Hz at M6.5. */
export function defaultFrequency(m: number): number {
  return Math.round(clamp(10 ** (1.1 - 0.13 * m), 0.4, 6) * 10) / 10;
}

/**
 * ROUGH illustrative PGA (g) for a magnitude at a hypocentral distance — an assumption so the
 * scenario can run, with order-of-magnitude behavior only (≈ 0.25 g for M6.5 at 10 km).
 * Not a ground-motion prediction equation; real PGA scatters by a factor of 2–3 or more.
 */
export function assumedPga(m: number, hypocentralKm: number): number {
  const log = -0.47 + 0.3 * m - 1.6 * Math.log10(hypocentralKm + 10);
  return Math.round(clamp(10 ** log, 0.01, 1.0) * 100) / 100;
}

/** Hypocentral distance (km) from the hypocenter to the map center. */
export function hypocentralDistanceKm(epicenter: [number, number], depthKm: number): number {
  return Math.hypot(epicenter[0] / 1000, epicenter[1] / 1000, depthKm);
}

/** Bearing (deg) of the line from the epicenter toward the map center (radial shaking). */
export function radialBearing(epicenter: [number, number]): number {
  const dx = -epicenter[0];
  const dz = -epicenter[1];
  if (Math.hypot(dx, dz) < 1) return 90; // epicenter under the map: E–W by convention
  // +X = East, −Z = North: bearing = atan2(east, north).
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

export function resolveEarthquake(spec: EarthquakeEventSpec, defaultSeed: number): ResolvedEarthquake {
  const assumptions: I18nMessage[] = [];
  const magnitude = clamp(spec.magnitude, EQ_LIMITS.magnitude[0], EQ_LIMITS.magnitude[1]);
  const epicenter: [number, number] = spec.epicenter ? [spec.epicenter[0], spec.epicenter[1]] : [0, 0];
  if (!spec.epicenter) assumptions.push({ key: 'eq.assume.epicenter' });
  const depth = clamp(spec.depth ?? DEFAULT_DEPTH_KM, EQ_LIMITS.depth[0], EQ_LIMITS.depth[1]);
  if (spec.depth === undefined) assumptions.push({ key: 'eq.assume.depth', params: { km: depth } });
  const duration = clamp(spec.duration ?? defaultDuration(magnitude), EQ_LIMITS.duration[0], EQ_LIMITS.duration[1]);
  if (spec.duration === undefined) assumptions.push({ key: 'eq.assume.duration', params: { s: duration } });
  const dist = hypocentralDistanceKm(epicenter, depth);
  const pgaAssumed = spec.pga === undefined;
  const pga = clamp(spec.pga ?? assumedPga(magnitude, dist), EQ_LIMITS.pga[0], EQ_LIMITS.pga[1]);
  if (pgaAssumed) assumptions.push({ key: 'eq.assume.pga', params: { g: pga, km: Math.round(dist) } });
  const dominantFrequency = clamp(spec.dominantFrequency ?? defaultFrequency(magnitude), EQ_LIMITS.frequency[0], EQ_LIMITS.frequency[1]);
  if (spec.dominantFrequency === undefined) assumptions.push({ key: 'eq.assume.frequency', params: { hz: dominantFrequency } });
  const direction = (((spec.direction ?? radialBearing(epicenter)) % 360) + 360) % 360;
  if (spec.direction === undefined) assumptions.push({ key: 'eq.assume.direction', params: { deg: Math.round(direction) } });
  const verticalRatio = clamp(spec.verticalRatio ?? DEFAULT_VERTICAL_RATIO, EQ_LIMITS.verticalRatio[0], EQ_LIMITS.verticalRatio[1]);
  const seed = (spec.seed ?? defaultSeed) >>> 0;
  return { magnitude, epicenter, depth, duration, pga, pgaAssumed, dominantFrequency, direction, verticalRatio, seed, assumptions };
}
