/**
 * Atmospheric reference state (Phase 29) — SI throughout (Pa, K, kg/m³, m, s).
 *
 *  ideal gas            p = ρ·R·T            dry air, R = 287.05 J/(kg·K); valid for air far from
 *                                            condensation (≈ 1 Pa – 10 MPa, 150 – 2500 K here)
 *  hydrostatic          dp/dz = −ρ·g         ⇒ a column of mass σ per area has surface pressure p_s = σ·g
 *  isothermal profile   p(z) = p_s·exp(−(z − z_s)/H_s),  H_s = R·T/g       (above the resolved layer)
 *  ISA troposphere      T = T₀ − L·h, p = p₀·(T/T₀)^(g/(R·L))   (ICAO 1993, h < 11 km; used only to
 *                                            derive a default reference state for an altitude)
 *
 * The constants are the project's existing ones (thermal/units.ts) so that the atmosphere and the
 * Phase 26 air layer agree exactly in the standard state.
 */
import { GRAVITY } from '@/core/units';
import { CP_AIR, R_AIR, STANDARD_AMBIENT, STANDARD_PRESSURE } from '@/thermal/units';

export { CP_AIR, R_AIR, STANDARD_AMBIENT, STANDARD_PRESSURE };
export const G = GRAVITY;
/** Heat capacity ratio of dry air (diatomic ideal gas). */
export const GAMMA = 1.4;
export const CV_AIR = CP_AIR - R_AIR;
/** R/c_p (Poisson exponent of an adiabatic change). */
export const KAPPA = R_AIR / CP_AIR;
/** ISA tropospheric lapse rate (K/m) and its upper limit (m). */
export const ISA_LAPSE = 0.0065;
export const ISA_TOP = 11_000;
/** O₂ mass fraction of dry air (same value as the Phase 27 fire model). */
export { Y_O2_AIR } from '@/fire/materials';

/** Boltzmann constant and the effective collision diameter of an air molecule (m) — mean free path. */
const K_B = 1.380649e-23;
const D_AIR = 3.7e-10;

export const density = (p: number, T: number) => p / (R_AIR * T);
export const pressureOf = (rho: number, T: number) => rho * R_AIR * T;
export const scaleHeight = (T: number, g = G) => (R_AIR * T) / g;
/** Speed of sound (m/s) of an ideal gas — depends on T only. */
export const soundSpeed = (T: number) => Math.sqrt(GAMMA * R_AIR * T);

/** ISA temperature and pressure at a geopotential altitude h (m, 0 … 11 km). */
export function isa(h: number): { T: number; p: number; rho: number } {
  const z = Math.max(-500, Math.min(ISA_TOP, h));
  const T = STANDARD_AMBIENT - ISA_LAPSE * z;
  const p = STANDARD_PRESSURE * Math.pow(T / STANDARD_AMBIENT, G / (R_AIR * ISA_LAPSE));
  return { T, p, rho: density(p, T) };
}

/** Pressure at height dz above a surface at (p_s, T) in an isothermal column. */
export const hydrostatic = (ps: number, T: number, dz: number, g = G) => ps * Math.exp(-dz / scaleHeight(T, g));

/** Mass of air (kg/m²) between the surface and height H of an isothermal column with surface pressure p_s. */
export const layerMassPerArea = (ps: number, T: number, H: number, g = G) => (ps / g) * (1 - Math.exp(-H / scaleHeight(T, g)));

/** Mean free path of air molecules (m), kinetic theory λ = k_B·T/(√2·π·d²·p). */
export const meanFreePath = (p: number, T: number) => (p > 0 ? (K_B * T) / (Math.SQRT2 * Math.PI * D_AIR * D_AIR * p) : Infinity);

/** Knudsen number of a body / particle of size L (m). Continuum relations hold for Kn ≲ 0.01. */
export const knudsen = (p: number, T: number, L: number) => meanFreePath(p, T) / L;

/** Cunningham slip correction for a particle of diameter d (Davies 1945 coefficients). */
export function cunningham(p: number, T: number, d: number): number {
  const Kn = (2 * meanFreePath(p, T)) / d;
  if (!Number.isFinite(Kn)) return Infinity;
  return 1 + Kn * (1.257 + 0.4 * Math.exp(-1.1 / Kn));
}

/** Dynamic viscosity of air (Pa·s), Sutherland's law — independent of pressure (kinetic theory). */
export const viscosity = (T: number) => {
  const r = T / 273.15;
  return 1.716e-5 * r * Math.sqrt(r) * (273.15 + 110.4) / (T + 110.4);
};

/**
 * Boiling point of water at pressure p (K) — Clausius–Clapeyron with a constant latent heat
 * (L = 2.257 MJ/kg, through 373.15 K at 101 325 Pa): within ≈ 1 K of the steam tables for
 * 10–200 kPa. Reported only: the water model has no phase change (Phase 26 / 28 limitation).
 */
export function boilingPoint(p: number): number {
  if (!(p > 0)) return 0;
  const Lv = 2.257e6, Rv = 461.5;
  return 1 / (1 / 373.15 - (Rv / Lv) * Math.log(p / STANDARD_PRESSURE));
}

/** Dynamic pressure q = ½·ρ·v² (Pa) — incompressible, valid for Mach < 0.3. */
export const dynamicPressure = (rho: number, v: number) => 0.5 * rho * v * v;

/** A point of the diagnostic vertical profile. */
export interface ProfilePoint {
  z: number;
  p: number;
  T: number;
  rho: number;
}
