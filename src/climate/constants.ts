/**
 * Constants of the climate model (Phase 30) — SI throughout (K, Pa, kg, J, m, s).
 *
 * Latent heats are held at their 0 °C values (one consistent set, so that every phase change books
 * exactly the energy it moves): L_v(0 °C) = 2.501 MJ/kg, L_f = 0.3337 MJ/kg, L_s = L_v + L_f. The real
 * L_v falls by ≈ 0.1 %/K (−3 % at 30 °C) — not represented (stated in the documentation).
 *
 * The water reference of the energy bookkeeping is LIQUID WATER AT THE THERMAL REFERENCE TEMPERATURE
 * (0 J/kg), the same reference the Phase 26 water heat uses.
 */
export { CP_AIR, C_WATER, RHO_WATER, R_AIR, SIGMA, ZERO_C, STANDARD_PRESSURE } from '@/thermal/units';

/** Melting point of ice at standard pressure (K) — pressure dependence (−7.4·10⁻⁸ K/Pa) neglected. */
export const T_MELT = 273.15;
/** Triple point of water: 273.16 K, 611.657 Pa (IAPWS). */
export const T_TRIPLE = 273.16;
export const P_TRIPLE = 611.657;
/** Latent heats (J/kg) at 0 °C. */
export const L_V = 2.501e6;
export const L_F = 3.337e5;
export const L_S = L_V + L_F;
/** Specific heat of ice (J/(kg·K), near −10 °C) and of water vapour at constant pressure. */
export const C_ICE = 2108;
export const CP_VAPOR = 1870;
/** Density of ice (kg/m³) and its thermal conductivity (W/(m·K)) near 0 °C. */
export const RHO_ICE = 917;
export const K_ICE = 2.22;
/** Gas constant of water vapour (J/(kg·K)) and the ratio of the gas constants R_d/R_v. */
export const R_VAPOR = 461.5;
export const EPSILON = 0.622;
/** Lewis number of water vapour in air (Chilton–Colburn analogy uses Le^(2/3)). */
export const LEWIS = 0.85;
/** Solar "constant" (W/m², total solar irradiance, Kopp & Lean 2011). */
export const SOLAR_CONSTANT = 1361;
/** Emissivity of snow, ice and water surfaces (thermal infrared). */
export const EPS_SNOW = 0.98;
export const EPS_ICE = 0.97;
export const EPS_WATER = 0.96;
/** Liquid water a snowpack holds against gravity (share of its mass; 3–5 % in models such as SNOW-17, 5 % used). */
export const SNOW_HOLDING = 0.05;
/** Densities of new snow bounds, the firn transition (kg/m³). */
export const RHO_SNOW_MIN = 50;
export const RHO_SNOW_MAX = 550;

/**
 * Shortwave albedo of the ground types (ids of terrain/GroundMaterials: grass, soil, sand, asphalt, concrete,
 * gravel, rock, mud, riverbed) — representative values of the usual tables (e.g. Oke 1987: grass 0.16–0.26,
 * dry sand 0.35, asphalt 0.05–0.10, concrete 0.25–0.35, wet soil 0.1).
 */
export const GROUND_ALBEDO = [0.23, 0.17, 0.35, 0.08, 0.3, 0.2, 0.25, 0.12, 0.2] as const;
export const WATER_ALBEDO = 0.06;
export const ICE_ALBEDO = 0.35;
export const SNOW_ALBEDO_MAX = 0.85;
export const SNOW_ALBEDO_MIN = 0.5;
export const ASH_ALBEDO = 0.1;

/**
 * A soil layer counts as frozen once a quarter of its water is ice: its infiltration factor 10^(−7·0.25) ≈ 0.02 makes
 * it effectively impermeable (Lundin 1990), which is what "frozen ground" means for runoff.
 */
export const FROZEN_ICE_FRACTION = 0.25;

/** Water depth the storm drains leave on paved cells during a climate experiment (m): pavement depression storage. */
export const PAVEMENT_FILM = 0.0005;

/** Snow + ice on a crown (kg per m² of crown projection) from which stems / large branches break — indicative (Nykänen et al. 1997: ≈ 20–30 kg/m²). */
export const CROWN_BREAK = 20;
