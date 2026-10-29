/**
 * Thermal units and constants (Phase 26). SI throughout:
 *   temperature K (absolute; °C only for display), energy J, heat flow rate W, heat flux W/m²,
 *   heat capacity J/K, specific heat J/(kg·K), conductivity W/(m·K), heat transfer coefficient W/(m²·K).
 *
 * Temperature DIFFERENCES (convection, conduction) are the same in K and °C; radiation always uses
 * absolute temperatures. Converting a difference with toC()/toK() is a bug — use the value as is.
 */

/** Stefan–Boltzmann constant (W/(m²·K⁴)), exact since the 2019 SI (CODATA 2018). */
export const SIGMA = 5.670374419e-8;
/** 0 °C in K. */
export const ZERO_C = 273.15;
/** Standard atmosphere at sea level (ISA, the project's baseline atmosphere: 15 °C). */
export const STANDARD_AMBIENT = 288.15;
export const STANDARD_PRESSURE = 101325;
/** Specific gas constant of dry air (J/(kg·K)). */
export const R_AIR = 287.05;
/** Specific heat of air at constant pressure (J/(kg·K)), held constant (1005 at 300 K, 1075 at 900 K). */
export const CP_AIR = 1005;
/** Liquid water: density (kg/m³), specific heat (J/(kg·K)), conductivity (W/(m·K)) near 20 °C. */
export const RHO_WATER = 1000;
export const C_WATER = 4186;
export const K_WATER = 0.6;
/** Water boils at 373.15 K at the standard pressure — phase change is NOT modelled (flagged). */
export const BOILING = 373.15;

export const toC = (K: number) => K - ZERO_C;
export const toK = (C: number) => C + ZERO_C;

/**
 * Physical input range of temperatures the model accepts (K): −100 … 2000 °C. Absolute zero is
 * unreachable; above 2000 °C every material table here is far outside its data range.
 */
export const T_LIMITS = [173.15, 2273.15] as const;
/** Ambient (air reference) temperature range accepted for the world (K): −60 … +60 °C. */
export const AMBIENT_LIMITS = [213.15, 333.15] as const;

export const fmtC = (K: number, digits = 1) => `${toC(K).toFixed(digits)} °C`;

/** Energy shown with an SI prefix (J). */
export function energyText(E: number): string {
  const a = Math.abs(E);
  if (a >= 1e12) return `${(E / 1e12).toFixed(2)} TJ`;
  if (a >= 1e9) return `${(E / 1e9).toFixed(2)} GJ`;
  if (a >= 1e6) return `${(E / 1e6).toFixed(2)} MJ`;
  if (a >= 1e3) return `${(E / 1e3).toFixed(1)} kJ`;
  return `${E.toFixed(1)} J`;
}

/** Power shown with an SI prefix (W). */
export function powerText(P: number): string {
  const a = Math.abs(P);
  if (a >= 1e9) return `${(P / 1e9).toFixed(2)} GW`;
  if (a >= 1e6) return `${(P / 1e6).toFixed(2)} MW`;
  if (a >= 1e3) return `${(P / 1e3).toFixed(1)} kW`;
  return `${P.toFixed(1)} W`;
}
