/**
 * World conventions
 * - 1 unit = 1 meter, Y is up.
 * - +X = East, -Z = North (so +Z = South, -X = West).
 * - Wind direction is expressed meteorologically: the direction the wind blows FROM.
 */

export const AIR_DENSITY = 1.225; // kg/m³ at sea level
export const GRAVITY = 9.81; // m/s²
export const FIXED_DT = 1 / 60; // physics step (s)
export const MAX_SUBSTEPS = 8;
export const WORLD_SIZE = 200; // m, square
export const WORLD_HALF = WORLD_SIZE / 2;

/** Reference height (m) for the nominal wind speed — same convention as weather stations. */
export const WIND_REFERENCE_HEIGHT = 10;
/** Power-law exponent for the atmospheric boundary layer (open terrain). */
export const WIND_SHEAR_EXPONENT = 0.14;

export const SIM_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];
