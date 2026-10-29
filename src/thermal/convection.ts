/**
 * Convective heat transfer coefficients (Phase 26) — textbook correlations with their stated ranges
 * (Incropera et al., Fundamentals of Heat and Mass Transfer, ch. 7 and 9). Air properties at the film
 * temperature from Sutherland's laws; c_p held constant (CP_AIR). NOT a flow solution: the flow is
 * represented only by the local wind speed (forced) and buoyancy (natural).
 *
 *  natural, vertical surface      Churchill & Chu (1975), all Ra:
 *                                 Nu = {0.825 + 0.387·Ra^(1/6) / [1 + (0.492/Pr)^(9/16)]^(8/27)}²     (L = height)
 *  natural, horizontal            heated face up / cooled face down (unstable): 0.54·Ra^(1/4) (Ra ≤ 10⁷),
 *                                 0.15·Ra^(1/3) (10⁷–10¹¹); heated face down / cooled face up (stable):
 *                                 0.52·Ra^(1/5)  (L = A/P)
 *  natural, sphere                Churchill (1983): Nu = 2 + 0.589·Ra^(1/4) / [1 + (0.469/Pr)^(9/16)]^(4/9)
 *  forced, flat surface           laminar 0.664·Re^(1/2)·Pr^(1/3) (Re ≤ 5·10⁵), mixed
 *                                 (0.037·Re^(4/5) − 871)·Pr^(1/3) (5·10⁵–10⁸)   (L = length along the wind)
 *  forced, sphere                 Whitaker (1972): Nu = 2 + (0.4·Re^(1/2) + 0.06·Re^(2/3))·Pr^0.4
 *  outdoor ground / water         wind function h = 3.0·U₂ (Watmuff, Charters & Proctor 1977; their
 *                                 still-air 2.8 W/(m²·K) is replaced by the natural-convection term),
 *                                 measured up to ≈ 7 m/s — linear above (flagged as extrapolation)
 *  mixed (natural + forced)       Churchill–Usagi, n = 3: h = (h_N³ + h_F³)^(1/3) (Incropera eq. 9.94)
 *  water side of a wet bed        natural convection of water, 0.15·Ra^(1/3) (turbulent, L-free)
 */
import { CP_AIR, R_AIR, STANDARD_PRESSURE } from './units';
import { GRAVITY } from '@/core/units';

export interface AirProps {
  rho: number;
  mu: number;
  nu: number;
  k: number;
  alpha: number;
  Pr: number;
}

/**
 * Air at temperature T (K) and pressure pr × the standard pressure (Sutherland's laws for μ and k;
 * White, Viscous Fluid Flow). Phase 29: μ, k, c_p and Pr of an ideal gas do not depend on pressure;
 * ρ ∝ p, so ν and α ∝ 1/p (Ra ∝ p², Re ∝ p). pr = 1 (default) is the Phase 26 standard state exactly.
 */
export function airProps(T: number, out: AirProps = { rho: 0, mu: 0, nu: 0, k: 0, alpha: 0, Pr: 0 }, pr = 1): AirProps {
  const t = Math.max(150, Math.min(2500, T));
  const r = t / 273.15;
  out.rho = (STANDARD_PRESSURE * pr) / (R_AIR * t);
  out.mu = 1.716e-5 * r * Math.sqrt(r) * (273.15 + 110.4) / (t + 110.4);
  out.k = 0.02414 * r * Math.sqrt(r) * (273.15 + 194) / (t + 194);
  out.nu = out.mu / out.rho;
  out.alpha = out.k / (out.rho * CP_AIR);
  out.Pr = out.nu / out.alpha;
  return out;
}

const props = airProps(300);
const CC_VERT = (Pr: number) => (1 + (0.492 / Pr) ** (9 / 16)) ** (8 / 27);
const CC_SPHERE = (Pr: number) => (1 + (0.469 / Pr) ** (9 / 16)) ** (4 / 9);

/** Rayleigh number g·β·|ΔT|·L³/(ν·α), β = 1/T_film (ideal gas). */
function rayleigh(Ts: number, Ta: number, L: number, p: AirProps): number {
  const Tf = 0.5 * (Ts + Ta);
  return (GRAVITY * Math.abs(Ts - Ta) * L * L * L) / (Tf * p.nu * p.alpha);
}

/** Natural convection on a vertical surface of height L (W/(m²·K)). */
export function hNaturalVertical(Ts: number, Ta: number, L: number, pr = 1): number {
  if (Ts === Ta) return 0;
  const p = airProps(0.5 * (Ts + Ta), props, pr);
  const Ra = rayleigh(Ts, Ta, L, p);
  const nu = 0.825 + (0.387 * Ra ** (1 / 6)) / CC_VERT(p.Pr);
  return (nu * nu * p.k) / L;
}

/** Natural convection on a horizontal surface; `up` = the surface faces up. L = A/P (W/(m²·K)). */
export function hNaturalHorizontal(Ts: number, Ta: number, L: number, up: boolean, pr = 1): number {
  if (Ts === Ta) return 0;
  const p = airProps(0.5 * (Ts + Ta), props, pr);
  const Ra = rayleigh(Ts, Ta, L, p);
  const unstable = (Ts > Ta) === up;
  const Nu = unstable ? (Ra <= 1e7 ? 0.54 * Ra ** 0.25 : 0.15 * Math.cbrt(Ra)) : 0.52 * Ra ** 0.2;
  return (Nu * p.k) / L;
}

/** Natural convection around a sphere of diameter D. */
export function hNaturalSphere(Ts: number, Ta: number, D: number, pr = 1): number {
  if (Ts === Ta) return 0;
  const p = airProps(0.5 * (Ts + Ta), props, pr);
  const Ra = rayleigh(Ts, Ta, D, p);
  return ((2 + (0.589 * Ra ** 0.25) / CC_SPHERE(p.Pr)) * p.k) / D;
}

/** Forced convection along a flat surface of length L in a stream of speed U (m/s). */
export function hForcedPlate(Ts: number, Ta: number, U: number, L: number, pr = 1): number {
  if (U <= 0) return 0;
  const p = airProps(0.5 * (Ts + Ta), props, pr);
  const Re = (U * L) / p.nu;
  const pr3 = Math.cbrt(p.Pr);
  const Nu = Re <= 5e5 ? 0.664 * Math.sqrt(Re) * pr3 : (0.037 * Re ** 0.8 - 871) * pr3;
  return (Nu * p.k) / L;
}

/** Forced convection around a sphere of diameter D. */
export function hForcedSphere(Ts: number, Ta: number, U: number, D: number, pr = 1): number {
  const p = airProps(0.5 * (Ts + Ta), props, pr);
  const Re = (Math.max(0, U) * D) / p.nu;
  return ((2 + (0.4 * Math.sqrt(Re) + 0.06 * Re ** (2 / 3)) * p.Pr ** 0.4) * p.k) / D;
}

/** Churchill–Usagi combination (n = 3) of natural and forced coefficients. */
export const mixed = (hN: number, hF: number) => Math.cbrt(hN * hN * hN + hF * hF * hF);

/** Wind function of an outdoor horizontal surface (ground, water): forced part only (W/(m²·K)). */
export const WIND_SLOPE = 3.0;
/** Upper wind speed of the measured range of the wind function (m/s). */
export const WIND_FUNCTION_MAX = 7;

/**
 * Air properties tabulated per kelvin of film temperature for the hot loops (ground cells):
 * conductivity and g/(T·ν·α), so Ra = RA·ΔT·L³ (same Sutherland relations as airProps()).
 */
const TAB0 = 150, TABN = 2351;
const TAB_K = new Float64Array(TABN), TAB_RA = new Float64Array(TABN);
for (let i = 0; i < TABN; i++) {
  const p = airProps(TAB0 + i);
  TAB_K[i] = p.k;
  TAB_RA[i] = GRAVITY / ((TAB0 + i) * p.nu * p.alpha);
}

/**
 * Outdoor ground / water surface facing up: natural (L = 1 m cell) + wind function. Phase 29: at a
 * pressure ratio pr the Rayleigh number scales with pr² and the wind function — a bulk transfer
 * ρ·c_p·C_H·U — with the density, pr (pr = 1: Phase 26 exactly).
 */
export function hGround(Ts: number, Ta: number, U2: number, L = 1, pr = 1): number {
  const hF = WIND_SLOPE * (U2 > 0 ? U2 : 0) * pr;
  const dT = Ts - Ta;
  if (dT === 0) return hF;
  const i = Math.max(0, Math.min(TABN - 1, Math.round(0.5 * (Ts + Ta)) - TAB0));
  const k = TAB_K[i];
  const Ra = TAB_RA[i] * (dT > 0 ? dT : -dT) * L * L * L * (pr * pr);
  // Heated face up: 0.54·Ra^¼ / 0.15·Ra^⅓; cooled face up (stable): 0.52·Ra^⅕.
  const Nu = dT > 0 ? (Ra <= 1e7 ? 0.54 * Math.sqrt(Math.sqrt(Ra)) : 0.15 * Math.cbrt(Ra)) : 0.52 * Math.pow(Ra, 0.2);
  const hN = (Nu * k) / L;
  return hF === 0 ? hN : Math.cbrt(hN * hN * hN + hF * hF * hF);
}

/**
 * Box-shaped body: area-weighted coefficient of its vertical faces (height Lv), its top and bottom
 * (L = Lh), each combined with forced flow along the body (Lf) — W/(m²·K) over the total area.
 */
export function hBox(Ts: number, Ta: number, U: number, Av: number, Atop: number, Abot: number, Lv: number, Lh: number, Lf: number, pr = 1): number {
  const A = Av + Atop + Abot;
  if (A <= 0 || (Ts === Ta && U <= 0)) return 0;
  const hF = hForcedPlate(Ts, Ta, U, Math.max(0.05, Lf), pr);
  let sum = 0;
  if (Av > 0) sum += Av * mixed(hNaturalVertical(Ts, Ta, Math.max(0.05, Lv), pr), hF);
  if (Atop > 0) sum += Atop * mixed(hNaturalHorizontal(Ts, Ta, Math.max(0.05, Lh), true, pr), hF);
  if (Abot > 0) sum += Abot * mixed(hNaturalHorizontal(Ts, Ta, Math.max(0.05, Lh), false, pr), hF);
  return sum / A;
}

/** Sphere (prescribed-temperature source body): natural + forced. */
export function hSphere(Ts: number, Ta: number, U: number, D: number, pr = 1): number {
  return mixed(hNaturalSphere(Ts, Ta, D, pr), U > 0 ? hForcedSphere(Ts, Ta, U, D, pr) : 0);
}

/** Water side of a wet bed / submerged surface: turbulent natural convection 0.15·Ra^(1/3) (W/(m²·K), L-free). */
export function hWaterSide(Tw: number, Ts: number): number {
  const dT = Math.abs(Tw - Ts);
  if (dT === 0) return 0;
  // Water near 20 °C: k 0.6, ν 1.0e-6, α 1.43e-7, β 2.1e-4 /K.
  return 0.15 * 0.6 * Math.cbrt((GRAVITY * 2.1e-4 * dT) / (1.0e-6 * 1.43e-7));
}
