/**
 * Psychrometrics (Phase 30): saturation vapour pressure, humidity measures, dew / frost point,
 * wet-bulb temperature, boiling point — pure functions, SI (K, Pa, kg/kg).
 *
 *  saturation over liquid water   T ≥ 273.15 K: IAPWS-IF97 region 4 saturation equation (exact form,
 *                                 273.15–647.096 K — includes boiling under any pressure here);
 *                                 123 K ≤ T < 273.15 K (supercooled): Murphy & Koop (2005) eq. (10)
 *  saturation over ice            Murphy & Koop (2005) eq. (7), T > 110 K
 *  outside these ranges the end value is used (callers flag it)
 *
 *  humidity state                 the CONSERVED quantity is the vapour mass. Specific humidity
 *                                 q = m_v / (m_dry + m_v); vapour pressure e = q·p / (ε + (1 − ε)·q);
 *                                 relative humidity RH = e / e_s,w(T) (WMO convention: over liquid water,
 *                                 also below 0 °C); dew point = e_s,w⁻¹(e), frost point = e_s,i⁻¹(e)
 *  wet bulb                       psychrometric equation e = e_s(T_w) − γ·p·(T − T_w), γ = c_p/(ε·L)
 *                                 (L_v above 0 °C wet-bulb, L_s below) — solved by bisection
 */
import { CP_AIR, EPSILON, L_S, L_V, P_TRIPLE, T_MELT, T_TRIPLE } from './constants';

const IF97 = [
  0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.12020824702470e5, -0.32325550322333e7,
  0.14915108613530e2, -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849, 0.65017534844798e3,
] as const;
/** Validity of the liquid saturation equations (K). */
export const SAT_RANGE_WATER = [123, 647.096] as const;
export const SAT_RANGE_ICE = [110, 273.16] as const;

/** IAPWS-IF97 saturation pressure (Pa) for 273.15 ≤ T ≤ 647.096 K. */
function if97Pressure(T: number): number {
  const n = IF97;
  const th = T + n[8] / (T - n[9]);
  const A = th * th + n[0] * th + n[1];
  const B = n[2] * th * th + n[3] * th + n[4];
  const C = n[5] * th * th + n[6] * th + n[7];
  const x = (2 * C) / (-B + Math.sqrt(B * B - 4 * A * C));
  return x * x * x * x * 1e6;
}

/** IAPWS-IF97 saturation temperature (K) for a pressure (Pa), 611.213 Pa – 22.064 MPa. */
function if97Temperature(p: number): number {
  const n = IF97;
  const beta = Math.pow(p / 1e6, 0.25);
  const E = beta * beta + n[2] * beta + n[5];
  const F = n[0] * beta * beta + n[3] * beta + n[6];
  const G = n[1] * beta * beta + n[4] * beta + n[7];
  const D = (2 * G) / (-F - Math.sqrt(F * F - 4 * E * G));
  return (n[9] + D - Math.sqrt((n[9] + D) * (n[9] + D) - 4 * (n[8] + n[9] * D))) / 2;
}

/** Saturation vapour pressure over liquid water (Pa). */
export function esWater(T: number): number {
  const t = Math.max(SAT_RANGE_WATER[0], Math.min(SAT_RANGE_WATER[1], T));
  if (t >= T_MELT) return if97Pressure(t);
  const lt = Math.log(t);
  return Math.exp(54.842763 - 6763.22 / t - 4.21 * lt + 0.000367 * t + Math.tanh(0.0415 * (t - 218.8)) * (53.878 - 1331.22 / t - 9.44523 * lt + 0.014025 * t));
}

/** Saturation vapour pressure over ice (Pa); above the triple point it is the liquid value (no ice). */
export function esIce(T: number): number {
  if (T >= T_TRIPLE) return esWater(T);
  const t = Math.max(SAT_RANGE_ICE[0], T);
  return Math.exp(9.550426 - 5723.265 / t + 3.53068 * Math.log(t) - 0.00728332 * t);
}

/** Saturation over the stable condensed phase: ice below 0 °C, water above. */
export const esSurface = (T: number, ice: boolean) => (ice && T < T_MELT ? esIce(T) : esWater(T));

/** Derivative de_s/dT (Pa/K) by a centred difference (smooth equations; used for linearizations). */
export function desdT(T: number, ice: boolean): number {
  const h = 0.01;
  return (esSurface(T + h, ice) - esSurface(T - h, ice)) / (2 * h);
}

/** Specific humidity (kg/kg) of air with vapour pressure e at total pressure p. */
export function specificHumidity(e: number, p: number): number {
  const ee = Math.min(e, p);
  return (EPSILON * ee) / (p - (1 - EPSILON) * ee);
}

/** Vapour pressure (Pa) from specific humidity at total pressure p. */
export function vapourPressure(q: number, p: number): number {
  const qq = Math.max(0, Math.min(1, q));
  return (qq * p) / (EPSILON + (1 - EPSILON) * qq);
}

/** Saturation specific humidity (kg/kg) at T, p — over ice below 0 °C when `ice`. Capped at 1 (boiling). */
export function qSat(T: number, p: number, ice = false): number {
  const e = esSurface(T, ice);
  return e >= p ? 1 : specificHumidity(e, p);
}

/** d q_sat / dT (1/K) at T, p (linearized surface balance). */
export function dqSatdT(T: number, p: number, ice = false): number {
  const e = esSurface(T, ice);
  if (e >= p) return 0;
  const d = p - (1 - EPSILON) * e;
  return ((EPSILON * p) / (d * d)) * desdT(T, ice);
}

/** Relative humidity (0–∞, WMO: over liquid water) of air with specific humidity q at T, p. */
export const relativeHumidity = (q: number, T: number, p: number) => vapourPressure(q, p) / esWater(T);

/** Specific humidity (kg/kg) of air at relative humidity RH (over liquid water), T, p. */
export const humidityFromRH = (RH: number, T: number, p: number) => specificHumidity(RH * esWater(T), p);

/** Invert a monotone saturation curve: the temperature at which es(T) = e (K). */
function invert(es: (T: number) => number, e: number, lo: number, hi: number): number {
  if (!(e > 0)) return lo;
  if (e <= es(lo)) return lo;
  if (e >= es(hi)) return hi;
  // Newton on ln es (nearly linear in 1/T), bracketed.
  let a = lo, b = hi, T = 0.5 * (lo + hi);
  const le = Math.log(e);
  for (let k = 0; k < 60; k++) {
    const f = Math.log(es(T)) - le;
    if (Math.abs(f) < 1e-12) break;
    if (f > 0) b = T; else a = T;
    const d = (Math.log(es(T + 1e-3)) - Math.log(es(T - 1e-3))) / 2e-3;
    let Tn = T - f / d;
    if (!(Tn > a && Tn < b)) Tn = 0.5 * (a + b);
    T = Tn;
  }
  return T;
}

/** Dew point (K) of vapour pressure e (over liquid water). */
export const dewPoint = (e: number) => invert(esWater, e, SAT_RANGE_WATER[0], SAT_RANGE_WATER[1]);
/** Frost point (K) of vapour pressure e (over ice) — meaningful below 0 °C. */
export const frostPoint = (e: number) => invert(esIce, e, SAT_RANGE_ICE[0], T_TRIPLE);

/**
 * Boiling point of water at pressure p (K): the temperature where e_s,w = p (IF97 backward equation —
 * consistent with esWater). Below the triple-point pressure liquid water has no equilibrium: the
 * function returns the triple-point temperature and callers treat the water as sublimating ice.
 */
export function boilingPointWater(p: number): number {
  if (!(p > P_TRIPLE)) return T_TRIPLE;
  if (p >= 22.064e6) return 647.096;
  return if97Temperature(p);
}

/**
 * Wet-bulb temperature (K) of air at T, specific humidity q, pressure p — psychrometric equation
 * e = e_s(T_w) − γ·p·(T − T_w), with γ = c_p/(ε·L) (L_v, or L_s when T_w < 0 °C over ice). Bisection
 * between the dew point and T (monotone).
 */
export function wetBulb(T: number, q: number, p: number): number {
  const e = vapourPressure(q, p);
  const f = (Tw: number) => {
    const ice = Tw < T_MELT;
    const g = CP_AIR / (EPSILON * (ice ? L_S : L_V));
    return esSurface(Tw, ice) - g * p * (T - Tw) - e;
  };
  let lo = Math.min(T, dewPoint(e)) - 1, hi = T;
  if (f(hi) <= 0) return T; // saturated (or supersaturated)
  if (f(lo) > 0) lo = SAT_RANGE_WATER[0];
  for (let k = 0; k < 80; k++) {
    const m = 0.5 * (lo + hi);
    if (f(m) > 0) hi = m; else lo = m;
    if (hi - lo < 1e-7) break;
  }
  return 0.5 * (lo + hi);
}

/**
 * Saturation adjustment of a parcel (isobaric, energy-conserving): air of heat capacity C (J/K) at T with
 * vapour m_v (kg) in a dry mass m (kg) at pressure p condenses the excess over liquid saturation; the latent
 * heat warms it. Returns the condensed mass (kg, ≥ 0) and the new temperature. Newton on the residual.
 * `L` is the latent heat booked (L_v; L_s when the condensate freezes).
 */
export function saturationAdjust(T: number, mv: number, m: number, p: number, C: number, L = L_V): { dm: number; T: number } {
  const qs0 = qSat(T, p);
  const q0 = mv / (m + mv);
  if (q0 <= qs0) return { dm: 0, T };
  let dm = 0, Tn = T;
  for (let k = 0; k < 20; k++) {
    Tn = T + (L * dm) / C;
    const r = (mv - dm) / (m + mv - dm) - qSat(Tn, p);
    if (Math.abs(r) < 1e-12) break;
    // d r / d dm ≈ −1/(m + mv) − dqs/dT·L/C
    const d = -1 / (m + mv) - dqSatdT(Tn, p) * (L / C);
    let next = dm - r / d;
    if (next < 0) next = 0;
    if (next > mv) next = mv;
    if (Math.abs(next - dm) < 1e-15 * Math.max(1, mv)) { dm = next; break; }
    dm = next;
  }
  return { dm, T: T + (L * dm) / C };
}
