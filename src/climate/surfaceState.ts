/**
 * Precipitation phase, internal precipitation and surface friction states (Phase 30).
 *
 *  rain / snow split    by the wet-bulb temperature T_w of the air the precipitation falls through:
 *                       all snow at T_w ≤ 0 °C, all rain at T_w ≥ 2 °C, linear between (50 % at ≈ 1 °C, the
 *                       land value of Ding et al. 2014 and Sims & Liu 2015). A precipitation is split ONCE.
 *  condensate → precip  Kessler (1969) autoconversion: rate = k·(q_c − q_c0), k = 10⁻³ s⁻¹, q_c0 = 0.5 g/kg
 *                       (exact exponential decay of the excess over a step)
 *  friction             representative tyre / shoe–surface coefficients (Wallman & Åström 2001, VTI 911A):
 *                       dry asphalt ≈ 0.7, wet ≈ 0.5, new / loose snow 0.3, packed snow 0.25, slush 0.25,
 *                       ice 0.1, wet ice (meltwater film) 0.05. They scale the Phase 14 ground-contact friction
 *                       relative to its reference ground (grass, μ = 0.55). NOT a tyre model: the simulation's
 *                       vehicles are rigid bodies with Coulomb contact friction — no braking distance is predicted.
 */
import { T_MELT } from './constants';

export const SNOW_TW = T_MELT;
export const RAIN_TW = T_MELT + 2;

/** Share of precipitation falling as snow at wet-bulb temperature Tw (K). */
export function snowFraction(Tw: number): number {
  if (Tw <= SNOW_TW) return 1;
  if (Tw >= RAIN_TW) return 0;
  return (RAIN_TW - Tw) / (RAIN_TW - SNOW_TW);
}

export const KESSLER_K = 1e-3;
export const KESSLER_QC0 = 5e-4;

/** Condensate (kg) converted to precipitation over dt from a column with condensate mc in dry mass m. */
export function autoconversion(mc: number, m: number, dt: number): number {
  const excess = mc - KESSLER_QC0 * m;
  return excess > 0 ? excess * (1 - Math.exp(-KESSLER_K * dt)) : 0;
}

/** Surface states (friction / display). */
export const SURF = { dry: 0, wet: 1, snow: 2, packed: 3, slush: 4, ice: 5, wetIce: 6, frost: 7 } as const;
export const SURFACE_STATES = ['dry', 'wet', 'snow', 'packed', 'slush', 'ice', 'wetIce', 'frost'] as const;
export const SURFACE_MU = [0.7, 0.5, 0.3, 0.25, 0.25, 0.1, 0.05, 0.3];
/** Friction coefficient of the Phase 14 reference ground (grass). */
export const REFERENCE_MU = 0.55;
/** Cover from which the surface counts as snow / ice covered (kg/m² SWE, kg/m² ice). */
export const SNOW_COVER = 1;
export const ICE_COVER = 0.3;
export const FROST_MAX = 0.3;

/**
 * Surface state of a cell from its cover: snow (kg/m² frozen), ice (kg/m²), liquid in / on the cover (kg/m²),
 * water film (m), snow density (kg/m³).
 */
export function surfaceState(snow: number, ice: number, liquid: number, water: number, rho: number): number {
  if (snow >= SNOW_COVER) return liquid > 0.02 * snow ? SURF.slush : rho >= 300 ? SURF.packed : SURF.snow;
  if (ice >= ICE_COVER) return liquid > 0.01 || water > 0.0005 ? SURF.wetIce : SURF.ice;
  if (ice > 0) return SURF.frost;
  if (water > 0.0005) return SURF.wet;
  return SURF.dry;
}

/**
 * Contact friction factor (multiplier of the object's own friction) on a cell: the cover's coefficient over the
 * reference ground, blended with the bare-ground factor by the cover share (thin covers grip partly through).
 */
export function frictionFactor(groundFactor: number, snow: number, ice: number, liquid: number, rho: number, wetGrip: number, water: number): number {
  const st = surfaceState(snow, ice, liquid, water, rho);
  if (st === SURF.dry) return groundFactor;
  if (st === SURF.wet) return groundFactor * wetGrip;
  const cover = st === SURF.frost ? Math.min(1, ice / ICE_COVER) : 1;
  const f = SURFACE_MU[st] / REFERENCE_MU;
  return groundFactor * (1 - cover) + Math.min(groundFactor, f) * cover;
}
