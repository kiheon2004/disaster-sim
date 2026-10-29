/**
 * Fire scenario spec (Phase 27) — saved in the experiment plan (schema v7, validated per instance).
 *
 * The scenario places an IGNITION: at its start time the combustible fuel inside a sphere of
 * `radius` around the point (optionally only the fuel of one target object) is lit by a pilot flame —
 * room contents start their design fire, solids a small burning spot. Nothing else is prescribed:
 * how the fire grows, spreads, is limited by oxygen and goes out follows from the fuel, the heat
 * transfer and the ventilation. `duration` is the observation window on the timeline (the fire
 * itself lasts as long as its fuel). Ignition where nothing can burn is rejected with a reason.
 * No fuel recipe, ignition device or anything that makes a fire bigger is part of the spec.
 */
export interface FireSpec {
  event: 'fire';
  /** World [x, z] (m). */
  position: [number, number];
  /** Height of the ignition point above the ground (m). */
  height: number;
  /** Ignition sphere radius (m). */
  radius: number;
  /** Only this object's fuel is lit (object id), optional. */
  target?: string;
  /** Observation window (s). */
  duration: number;
  startTime?: number;
  name?: string;
}

export const FIRE_LIMITS = {
  height: [0, 60],
  radius: [0.2, 10],
  duration: [10, 21600],
} as const;

/** Opening state of building rooms at the start (world setting). */
export type OpeningMode = 'asBuilt' | 'windowsOpen' | 'closed';
export const OPENING_MODES: readonly OpeningMode[] = ['asBuilt', 'windowsOpen', 'closed'];

/** World fire settings (settings.simulation.fire, optional — defaults below). */
export interface FireSettings {
  /** Live foliage moisture content (kg water / kg dry fuel). */
  foliageMoisture: number;
  /** Windows and doors at the start: as built (closed, leakage only), all windows open, sealed (no leakage). */
  openings: OpeningMode;
  /**
   * Heat of other phenomena (heat sources, impact heat) may ignite fuel. Off (and absent in older
   * projects): the fire model only runs with a fire scenario — runs without one are bit-identical to
   * Phase 26. On: the combustion model also runs with heat sources / impact heat.
   */
  heatIgnition: boolean;
}

export const defaultFireSettings = (): FireSettings => ({ foliageMoisture: 1.5, openings: 'asBuilt', heatIgnition: false });
export const MOISTURE_LIMITS = [0.05, 2.5] as const;

/** Problems of a spec as i18n keys (empty = valid). */
export function fireIssues(s: FireSpec): string[] {
  const out: string[] = [];
  const inRange = (v: number | undefined, [lo, hi]: readonly [number, number]) => v !== undefined && Number.isFinite(v) && v >= lo && v <= hi;
  if (!s.position || !Number.isFinite(s.position[0]) || !Number.isFinite(s.position[1])) out.push('fire.invalid.position');
  if (!inRange(s.height, FIRE_LIMITS.height)) out.push('fire.invalid.height');
  if (!inRange(s.radius, FIRE_LIMITS.radius)) out.push('fire.invalid.radius');
  if (!inRange(s.duration, FIRE_LIMITS.duration)) out.push('fire.invalid.duration');
  return out;
}

export function fireSettingsIssues(f: FireSettings): string[] {
  const out: string[] = [];
  if (!(f.foliageMoisture >= MOISTURE_LIMITS[0] && f.foliageMoisture <= MOISTURE_LIMITS[1])) out.push('fire.invalid.moisture');
  if (!OPENING_MODES.includes(f.openings)) out.push('fire.invalid.openings');
  return out;
}
