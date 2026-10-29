/**
 * Physical constants of the celestial-gravity experiments (Phase 32), SI (CODATA 2018 G, exact c). Never scaled for
 * convenience: the educational mode chooses a different MASS, not a different G.
 */

/** Newtonian constant of gravitation (m³·kg⁻¹·s⁻²). */
export const G_N = 6.6743e-11;
/** Speed of light in vacuum (m/s, exact). */
export const C_LIGHT = 299_792_458;
/** Nominal solar mass (kg, IAU 2015 GM☉ / G) and Earth mass (kg), for unit display only. */
export const M_SUN = 1.98847e30;
export const M_EARTH = 5.9722e24;

/** Gravitational parameter μ = G·M (m³/s²). */
export const muOf = (mass: number) => G_N * mass;
/** Mass of a gravitational parameter (kg). */
export const massOf = (mu: number) => mu / G_N;
/**
 * Schwarzschild radius r_s = 2GM/c² (m) — the general-relativistic horizon radius of a non-rotating, uncharged black
 * hole of that mass. A reference value only: the Newtonian solver neither computes nor simulates a horizon.
 */
export const schwarzschildRadius = (mass: number) => (2 * G_N * mass) / (C_LIGHT * C_LIGHT);
