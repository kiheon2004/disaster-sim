/**
 * Phase 34: inspired gas and fire-gas exposure. Gas amounts are MOLE FRACTIONS (mol/mol) everywhere inside the model;
 * ppm and % are display conversions only, mass concentration (kg/m³) is used for smoke particles (a different quantity).
 *
 * Oxygen: inspired partial pressure P_IO₂ = x_O₂ (p − p_H₂O,37 °C) (inspired gas is humidified in the airway), alveolar
 * P_AO₂ = P_IO₂ − P_ACO₂ / RQ (simplified alveolar gas equation; inspired CO₂ raises P_ACO₂ additively — assumption).
 * Supply index = P_AO₂ / P_AO₂(reference air, sea level): a physical partial-pressure ratio, not a blood-oxygen value.
 *
 * Fractional effective doses (ISO 13571 / Purser, the fire-safety tenability method): FED = Σ Δt / t_I(C) — dimensionless,
 * 1 = the reference dose of the method (the median-incapacitation reference of a population, NOT a prediction for a person;
 * the model reports the index only). CO: Δt·ppm / 35 000 ppm·min × exp(%CO₂ / 5); O₂: t = exp(8.13 − 0.54 (20.9 − %O₂,eq))
 * min with %O₂,eq the sea-level oxygen percentage of the same inspired O₂ pressure (altitude and low O₂ alike); CO₂ above 5 %:
 * t = exp(6.1623 − 0.5189 %CO₂) min; convective heat above 60 °C: t = 5·10⁷ T^−3.4 min; directed radiation above 1.7 kW/m²:
 * t = r / q^(4/3). FEDs only accumulate (the method has no recovery) — recovery is modelled on the instantaneous indices.
 */
import { P } from './params';

export const R_GAS = 8.314462618;
export const M_CO = 0.02801;
export const M_CO2 = 0.04401;
export const M_O2 = 0.031999;
/** Reference composition of dry air (mole fractions) — an explicit, user-changeable assumption of the model. */
export const REFERENCE_AIR = { o2: 0.2095, co2: 0.0004, co: 0 } as const;
export const SEA_LEVEL = 101325;

export const toPpm = (x: number) => x * 1e6;
export const fromPpm = (ppm: number) => ppm / 1e6;
/** mol/mol → mg/m³ at (p, T): x p M / (R T). */
export const toMgM3 = (x: number, molar: number, p: number, T: number) => (x * p * molar) / (R_GAS * T) * 1e6;
export const fromMgM3 = (mg: number, molar: number, p: number, T: number) => (mg / 1e6) * (R_GAS * T) / (p * molar);

export const inspiredO2 = (xO2: number, p: number) => Math.max(0, xO2 * (p - P.airwayWaterPressure));
export const inspiredCO2 = (xCO2: number, p: number) => Math.max(0, xCO2 * (p - P.airwayWaterPressure));
export function alveolarO2(xO2: number, xCO2: number, p: number): number {
  // Hypoxic hyperventilation lowers the alveolar CO₂ as the inspired O₂ falls below its sea-level value (linear fit, §19).
  const deficit = Math.max(0, inspiredO2(REFERENCE_AIR.o2, SEA_LEVEL) - inspiredO2(xO2, p));
  const paco2 = Math.max(2.5e3, P.alveolarCO2 - P.hypoxicVentilation * deficit) + inspiredCO2(xCO2, p);
  return Math.max(0, inspiredO2(xO2, p) - paco2 / P.respiratoryQuotient);
}
export const ALVEOLAR_O2_REF = alveolarO2(REFERENCE_AIR.o2, REFERENCE_AIR.co2, SEA_LEVEL);
export const supplyIndex = (xO2: number, xCO2: number, p: number) => alveolarO2(xO2, xCO2, p) / ALVEOLAR_O2_REF;
/** Sea-level O₂ percentage giving the same inspired O₂ pressure. */
export const equivalentO2Percent = (xO2: number, p: number) => (100 * inspiredO2(xO2, p)) / (SEA_LEVEL - P.airwayWaterPressure);

/** FED rates (1/s) for one exposure state. */
export interface FedRates {
  co: number;
  o2: number;
  co2: number;
  heatConv: number;
  heatRad: number;
}
export function fedRates(o: { xO2?: number; xCO2?: number; xCO?: number; p?: number; airC?: number; qDir?: number }): FedRates {
  const co2pct = o.xCO2 !== undefined ? o.xCO2 * 100 : undefined;
  const vco2 = co2pct !== undefined ? Math.exp(co2pct / P.co2Hyperventilation) : 1;
  const co = o.xCO !== undefined ? (toPpm(o.xCO) / P.coDose) * vco2 / 60 : 0;
  let o2 = 0;
  if (o.xO2 !== undefined && o.p !== undefined) {
    const eq = equivalentO2Percent(o.xO2, o.p);
    if (eq < 20.9) o2 = 1 / (Math.exp(P.hypoxiaA - P.hypoxiaB * (20.9 - eq)) * 60);
  }
  const co2 = co2pct !== undefined && co2pct > P.co2Threshold ? 1 / (Math.exp(6.1623 - 0.5189 * co2pct) * 60) : 0;
  const heatConv = o.airC !== undefined && o.airC > P.convHeatMin ? 1 / ((P.convHeatA * Math.pow(o.airC, -3.4)) * 60) : 0;
  const qk = (o.qDir ?? 0) / 1000;
  const heatRad = qk > P.radHeatMin ? Math.pow(qk, 4 / 3) / (P.radHeatR * 60) : 0;
  return { co, o2, co2, heatConv, heatRad };
}

/** Oxygen uptake (L/s STPD) and CO₂ output from the metabolic rate (W). */
export const oxygenUptake = (M: number) => M / P.oxygenEnergy;
/** Ventilation demand (L/min) from the oxygen uptake. */
export const ventilationDemand = (vo2: number) => vo2 * 60 * P.ventilatoryEquivalent;
/** Moles per litre of an ideal gas at STP (0 °C, 101.325 kPa). */
export const MOL_PER_L_STPD = SEA_LEVEL / (R_GAS * 273.15) / 1000;
