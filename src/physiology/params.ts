/**
 * Phase 34: every coefficient of the reduced physiology model with its unit, default, admissible range, source, model level
 * and uncertainty (HUMAN_PHYSIOLOGY.md §parameters). Levels: 'A' — conservation law / physics; 'B' — reduced physiology from
 * the literature, inside its stated range; 'C' — explicit educational assumption (no validated value exists for a
 * generic person). Nothing here is a property of a real individual.
 */
export type ModelLevel = 'A' | 'B' | 'C';

export interface ParamDoc {
  value: number;
  unit: string;
  range: readonly [number, number];
  level: ModelLevel;
  source: string;
  note?: string;
}

const p = (value: number, unit: string, range: readonly [number, number], level: ModelLevel, source: string, note?: string): ParamDoc => ({ value, unit, range, level, source, note });

export const PARAMS = {
  // ── body ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  specificHeat: p(3492, 'J/(kg·K)', [3300, 3600], 'B', 'Gagge et al. 1971/1986 two-node model (0.97 W·h/(kg·K))'),
  skinMassShare: p(0.1, '1', [0.05, 0.2], 'C', 'fixed skin-node share of the heat capacity (Gagge α at thermoneutrality ≈ 0.1)', 'the variable α of Gagge enters only the mean-body signal, so the energy of the two nodes is conserved exactly'),
  coreSet: p(36.8, '°C', [36.5, 37.2], 'B', 'Gagge 1986 set point (core)'),
  skinSet: p(33.7, '°C', [33, 34.5], 'B', 'Gagge 1986 set point (skin)'),
  bodySet: p(36.49, '°C', [36.2, 36.8], 'B', 'Gagge 1986 set point (mean body)'),
  coreSkinConductance: p(5.28, 'W/(m²·K)', [4, 7], 'B', 'Gagge 1986 tissue conductance'),
  bloodHeat: p(1.163, 'W·h/(L·K)', [1.1, 1.2], 'A', 'heat capacity of blood per litre (Gagge 1986)'),
  skinBloodFlowNeutral: p(6.3, 'L/(m²·h)', [5, 8], 'B', 'Gagge 1986'),
  vasodilation: p(100, 'L/(m²·h·K)', [50, 200], 'B', 'Gagge 1986 (c_dil)'),
  vasoconstriction: p(0.5, '1/K', [0.1, 1], 'B', 'Gagge 1986 (c_str)'),
  skinBloodFlowRange: p(90, 'L/(m²·h)', [0.5, 90], 'B', 'Gagge 1986 limits 0.5–90'),
  sweatGain: p(170, 'g/(m²·h·K)', [100, 250], 'B', 'Gagge 1986 (c_sw)'),
  sweatMax: p(500, 'g/(m²·h)', [300, 800], 'B', 'Gagge 1986 cap'),
  shiverGain: p(19.4, 'W/(m²·K²)', [10, 30], 'B', 'Gagge 1986'),
  shiverMax: p(250, 'W/m²', [150, 350], 'C', 'cap of shivering heat (≈ 4 met) — assumption'),
  shiverStop: p(31, '°C', [30, 33], 'C', 'core temperature below which shivering has ceased (linear fade from 33 °C) — literature order of magnitude, assumption'),
  latentHeat: p(2.43e6, 'J/kg', [2.40e6, 2.45e6], 'A', 'latent heat of vaporisation of water at skin temperature'),
  skinDiffusion: p(0.06, '1', [0.04, 0.08], 'B', 'Gagge 1986 diffusion wettedness of non-sweating skin'),
  lewis: p(16.5e-3, 'K/Pa', [16e-3, 17e-3], 'A', 'Lewis relation 16.5 K/kPa (ASHRAE)'),
  emissivity: p(0.95, '1', [0.9, 0.98], 'B', 'skin / clothing emissivity (ASHRAE)'),
  radiativeShare: p(0.73, '1', [0.65, 0.78], 'B', 'effective radiation area / body area, standing (Fanger); 0.65 seated / lying'),
  projectedShare: p(0.25, '1', [0.15, 0.35], 'B', 'projected area factor for a directed horizontal source (Fanger / Underwood & Ward)'),
  absorptivity: p(0.8, '1', [0.5, 0.95], 'C', 'absorbed share of directed (fire) radiation — depends on clothing colour / material'),
  // ── convection ─────────────────────────────────────────────────────────────────────────────────────────────────────
  hcAirStill: p(3.1, 'W/(m²·K)', [2.5, 4], 'B', 'natural convection of a standing person (ASHRAE / Gagge)'),
  hcAirForcedA: p(8.6, 'W/(m²·K)', [8, 9], 'B', 'h_c = 8.6 v^0.53 (Gagge 1986, valid ≈ 0.2–4 m/s; extrapolated beyond and flagged)'),
  hcAirForcedB: p(0.53, '1', [0.5, 0.6], 'B', 'exponent of the forced-convection relation'),
  hcAirValid: p(4, 'm/s', [2, 6], 'B', 'upper end of the validated air-speed range (flag above)'),
  hcWaterStill: p(230, 'W/(m²·K)', [100, 400], 'B', 'skin convection in still water — order of magnitude (Boutelier et al. 1977)'),
  hcWaterFlow: p(2, 's/m', [0.5, 4], 'C', 'h_w = h_still (1 + k v) — increase with relative water speed, assumption'),
  hcWaterMax: p(1000, 'W/(m²·K)', [500, 2000], 'C', 'cap of water convection'),
  wetClothingFactor: p(0.2, '1', [0.1, 0.5], 'C', 'insulation retained by wet / immersed clothing (share of dry R_cl)'),
  contactResistance: p(0.05, 'm²·K/W', [0.02, 0.15], 'C', 'skin–ground contact resistance in addition to clothing'),
  contactShareLying: p(0.2, '1', [0.1, 0.3], 'C', 'share of the body surface touching the ground when lying'),
  // ── metabolism / respiration ───────────────────────────────────────────────────────────────────────────────────────
  met: p(58.15, 'W/m²', [58.15, 58.15], 'A', '1 met (definition)'),
  metResting: p(1.2, 'met', [1, 1.4], 'B', 'standing relaxed (ISO 8996 / ASHRAE)'),
  metLight: p(2.0, 'met', [1.6, 2.4], 'B', 'light activity (ISO 8996)'),
  metModerate: p(3.5, 'met', [2.6, 4.4], 'B', 'moderate activity / brisk walking (ISO 8996)'),
  metStrenuous: p(6.5, 'met', [5, 8], 'B', 'strenuous activity / running (ISO 8996)'),
  metMax: p(12, 'met', [8, 16], 'C', 'maximal metabolic capacity of the generic adult — assumption'),
  workEfficiency: p(0, '1', [0, 0.25], 'C', 'external mechanical work share W/M (no work done on the environment by default)'),
  oxygenEnergy: p(20.2e3, 'J/L', [19.6e3, 21.1e3], 'B', 'energy equivalent of oxygen at RQ 0.85 (STPD)'),
  respiratoryQuotient: p(0.85, '1', [0.7, 1], 'B', 'mixed-diet respiratory quotient'),
  ventilatoryEquivalent: p(25, 'L/L', [20, 35], 'B', 'minute ventilation per oxygen uptake, sub-maximal'),
  ventilationMax: p(120, 'L/min', [80, 180], 'C', 'maximal voluntary ventilation of the generic adult — assumption'),
  airwayWaterPressure: p(6.27e3, 'Pa', [6.2e3, 6.3e3], 'A', 'saturated water-vapour pressure at 37 °C (inspired gas humidified)'),
  alveolarCO2: p(5.33e3, 'Pa', [4.5e3, 6e3], 'B', 'alveolar CO₂ partial pressure at sea level (40 mmHg)'),
  hypoxicVentilation: p(0.17, 'Pa/Pa', [0.1, 0.25], 'C', 'fall of alveolar CO₂ per Pa of inspired-O₂ deficit below sea level (acute hypoxic ventilatory response fitted to altitude data ≈ 3.5 kPa at 5 500 m, West) — assumption'),
  // ── fire / gases (ISO 13571 / Purser) ─────────────────────────────────────────────────────────────────────────────
  coDose: p(35000, 'ppm·min', [27000, 45000], 'B', 'ISO 13571 CO dose for FED = 1'),
  co2Hyperventilation: p(5, '% CO₂', [4, 6], 'B', 'ISO 13571 / Purser: CO uptake factor exp(%CO₂ / 5)'),
  co2Threshold: p(5, '% CO₂', [3, 7], 'B', 'Purser CO₂ FED relation applied above this concentration'),
  hypoxiaA: p(8.13, '1', [8, 8.3], 'B', 'Purser: t(O₂) = exp(8.13 − 0.54 (20.9 − %O₂)) min'),
  hypoxiaB: p(0.54, '1/%', [0.5, 0.6], 'B', 'Purser hypoxia slope'),
  convHeatA: p(5e7, 'min·°C^3.4', [4e7, 6e7], 'B', 'ISO 13571: t(conv) = 5·10⁷ T^−3.4 min (lightly clothed)'),
  convHeatMin: p(60, '°C', [50, 80], 'C', 'lower end where the convective-heat FED is applied (below: the thermoregulation model)'),
  radHeatR: p(6.9, '(kW/m²)^(4/3)·min', [4, 10], 'C', 'radiant-heat FED: t = r / q^(4/3) — ISO 13571 form, value uncertain'),
  radHeatMin: p(1.7, 'kW/m²', [1, 2.5], 'B', 'directed radiant flux tolerable without a heat dose (ISO 13571 order)'),
  smokeDeposition: p(0.3, '1', [0.1, 0.6], 'C', 'deposited share of inhaled smoke particles — assumption'),
  // ── water / fatigue / capacity ─────────────────────────────────────────────────────────────────────────────────────
  bodyWaterShare: p(0.6, '1', [0.45, 0.65], 'B', 'total body water / body mass, generic adult'),
  dehydrationCoreShift: p(0.15, 'K/%', [0.1, 0.25], 'B', 'core set-point rise per % body-mass water deficit (Sawka; Montain & Coyle 1992)'),
  dehydrationSweatLoss: p(0.1, '1/%', [0.05, 0.2], 'C', 'reduction of sweat sensitivity per % deficit above 1 % — assumption'),
  sustainable: p(0.4, '1', [0.3, 0.5], 'C', 'relative intensity sustainable without fatigue — assumption'),
  fatigueTime: p(600, 's', [300, 1800], 'C', 'time to reach the fatigue limit at maximal intensity — assumption'),
  recoveryTime: p(900, 's', [300, 3600], 'C', 'e-folding recovery time at rest — assumption'),
  breathHold: p(60, 's', [20, 120], 'C', 'reference breath-hold reserve of a resting adult in thermoneutral water — order of magnitude, assumption (shorter in cold water)'),
  coldShockHold: p(0.5, '1', [0.25, 1], 'C', 'breath-hold reserve factor in water below 15 °C (cold shock) — assumption'),
} as const;

export type ParamId = keyof typeof PARAMS;
export const P = Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.value])) as { [K in ParamId]: number };
