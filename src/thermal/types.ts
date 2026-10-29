/**
 * Heat source spec (Phase 26) — saved in the experiment plan (schema v7, validated per instance).
 *
 * Heat OUTPUT (W, or a total energy J) and a PRESCRIBED TEMPERATURE (K) are different boundary
 * conditions and never mixed in one source:
 *  point        isotropic emitter at a height above the ground: radiativeFraction of its power leaves
 *               as thermal radiation (absorbed by the surfaces that see it — inverse square, projected
 *               areas), the rest is convected into the air around it (the air layer cell, or the room
 *               of a building when the point lies inside one)
 *  area         heat flux into the ground / water surface of a disc of `radius` (surface heating of the
 *               terrain)
 *  surface      heat flux into the surfaces of everything inside a sphere of `radius` — ground, water,
 *               structural members, objects, rubble (surface heating of objects), split by area
 *  volume       volumetric heating of the air in a sphere (air layer cells / building rooms)
 *  temperature  a black sphere held at `temperature` (prescribed-temperature boundary): it exchanges
 *               heat by radiation (view factors) and convection with what surrounds it and fully
 *               immerses what lies inside it; the energy it supplies or absorbs is booked as boundary
 *               exchange
 * No fuel, flame or combustion is modelled (Phase 27).
 */
import type { ProfileKind } from './profiles';

export type HeatSourceKind = 'point' | 'area' | 'surface' | 'volume' | 'temperature';
export const HEAT_SOURCE_KINDS: readonly HeatSourceKind[] = ['point', 'area', 'surface', 'volume', 'temperature'];
export type HeatInput = 'power' | 'energy';

export interface HeatSourceSpec {
  event: 'heatSource';
  kind: HeatSourceKind;
  /** World [x, z] (m). */
  position: [number, number];
  /** Height of the source point / sphere centre above the ground (m). */
  height: number;
  /** Disc / sphere radius (m); unused by a point source. */
  radius: number;
  /** Output given as a power (W) or as a total energy (J) — not for a prescribed temperature. */
  input: HeatInput;
  power?: number;
  energy?: number;
  /** Prescribed surface temperature (K) — temperature sources only. */
  temperature?: number;
  /** Point sources: share of the power radiated (0–1, default 0.35). */
  radiativeFraction?: number;
  profile: ProfileKind;
  /** Seconds (instant: only the timeline length). */
  duration: number;
  rampTime?: number;
  pulseWidth?: number;
  period?: number;
  /** Scheduled on / off intervals [on, off) in source-local seconds. */
  schedule?: [number, number][];
  startTime?: number;
  name?: string;
}

export const HEAT_LIMITS = {
  /** 1 W – 1 GW. */
  power: [1, 1e9],
  /** 1 J – 1 TJ. */
  energy: [1, 1e12],
  /** −100 … 2000 °C (K). */
  temperature: [173.15, 2273.15],
  radius: [0.2, 50],
  height: [0, 50],
  duration: [0.1, 21600],
  radiativeFraction: [0, 1],
} as const;

/**
 * Default radiative share of a point source: luminous flames radiate roughly 20–40 % of their heat
 * release (Tewarson, SFPE Handbook) — 0.35 is a representative value for a flame-like source, editable.
 */
export const DEFAULT_RADIATIVE_FRACTION = 0.35;

/** Smallest irradiance (W/m²) a receiver must get to be heated; what falls below it is booked as unresolved radiation. */
export const IRRADIANCE_FLOOR = 1;

/** Problems of a spec as i18n keys (empty = valid). Physical impossibility is explained, never silently fixed. */
export function heatSourceIssues(s: HeatSourceSpec): string[] {
  const out: string[] = [];
  const inRange = (v: number | undefined, [lo, hi]: readonly [number, number]) => v !== undefined && Number.isFinite(v) && v >= lo && v <= hi;
  if (s.kind === 'temperature') {
    if (!inRange(s.temperature, HEAT_LIMITS.temperature)) out.push(s.temperature !== undefined && s.temperature <= 0 ? 'thermal.invalid.absoluteZero' : 'thermal.invalid.temperature');
    if (s.profile === 'instant') out.push('thermal.invalid.instantTemperature');
  } else {
    if (s.input === 'power' && !inRange(s.power, HEAT_LIMITS.power)) out.push(s.power !== undefined && s.power <= 0 ? 'thermal.invalid.powerSign' : 'thermal.invalid.power');
    if (s.input === 'energy' && !inRange(s.energy, HEAT_LIMITS.energy)) out.push(s.energy !== undefined && s.energy <= 0 ? 'thermal.invalid.energySign' : 'thermal.invalid.energy');
    if (s.profile === 'instant' && s.input !== 'energy') out.push('thermal.invalid.instantPower');
  }
  if (s.kind !== 'point' && !inRange(s.radius, HEAT_LIMITS.radius)) out.push('thermal.invalid.radius');
  if (!inRange(s.height, HEAT_LIMITS.height)) out.push('thermal.invalid.height');
  if (!inRange(s.duration, HEAT_LIMITS.duration)) out.push('thermal.invalid.duration');
  if (s.kind === 'point' && s.radiativeFraction !== undefined && !inRange(s.radiativeFraction, HEAT_LIMITS.radiativeFraction)) out.push('thermal.invalid.radiativeFraction');
  return out;
}
