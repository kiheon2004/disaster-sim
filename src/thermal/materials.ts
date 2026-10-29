/**
 * Thermal material properties (Phase 26) — REPRESENTATIVE literature values, not certified design
 * data. Where a fire-engineering code gives temperature-dependent properties they are used as given
 * (they are design relations, not measurements of any particular product); everything else is a
 * handbook value near room temperature, held constant (the range it applies to is listed).
 *
 * Sources (see docs/THERMAL_PHYSICS.md §5 for the full table):
 *   [EN2]  EN 1992-1-2:2004 (concrete, siliceous aggregate; reinforcing steel class N, hot rolled)
 *          c_p(θ) §3.3.2 with the 1.5 % moisture peak, λ_c upper limit §3.3.3, thermal strain §3.3.1,
 *          strength f_c,θ / f_ck and strain ε_c1,θ Table 3.1, rebar k_s(θ) Table 3.2a, ε_m = 0.7 (§2.2)
 *   [EN3]  EN 1993-1-2:2005 (carbon steel) c_a(θ) §3.4.1.2, λ_a §3.4.1.3, thermal elongation
 *          §3.4.1.1, k_y,θ and k_E,θ Table 3.1, ε_m = 0.7 (§2.2)
 *   [EN5]  EN 1995-1-2:2004 Annex B (softwood, effective values calibrated for standard fire
 *          exposure, moisture plateau included): specific heat Table B.2, conductivity Fig. B.2,
 *          strength / modulus reduction parallel to grain Fig. B.3 / B.4 (compression values used)
 *   [INC]  Incropera, DeWitt, Bergman, Lavine — Fundamentals of Heat and Mass Transfer, Table A.3
 *          (300 K: brick 1920 / 0.72 / 835, concrete stone mix 2300 / 1.4 / 880, window glass
 *          2700 / 1.4 / 840, soil 2050 / 0.52 / 1840, sand 1515 / 0.27 / 800, clay 1460 / 1.3 / 880,
 *          granite 2630 / 2.79 / 775) and Table A.11 (total emissivities)
 *   [JOH]  Johansen (1975), effective conductivity of dry crushed rock k = 0.039·n^(−2.2) W/(m·K);
 *          saturated mixtures k = k_s^(1−n)·k_w^n (geometric mean), volumetric heat capacity by mass
 *   [FPL]  Wood Handbook (USDA FPL, 2010) ch. 4: specific heat of moist wood
 *          c = (c₀ + u·c_w)/(1 + u), c₀ = 0.1031 + 0.003867·T kJ/(kg·K); conductivity across the grain;
 *          linear expansion parallel to grain 3.1–4.5·10⁻⁶ /K
 *   [EN6]  EN 1996-1-1 Table 3.8: clay masonry α_t 4–8·10⁻⁶ /K (6·10⁻⁶ recommended)
 * Values with weak support are marked (asphalt conductivity, mixtures) and used only where nothing
 * better exists; no strength–temperature relation is used without a code source (masonry, glass,
 * cladding keep their strength — documented as not modelled).
 */
import { ZERO_C, C_WATER, K_WATER, RHO_WATER } from './units';

export const TM = {
  concrete: 0, steel: 1, timber: 2, masonry: 3, glass: 4, cladding: 5, pavingConcrete: 6, asphalt: 7, soil: 8, sand: 9, clay: 10,
  rock: 11, gravel: 12, mud: 13, riverbed: 14, saturatedSand: 15, water: 16, wood: 17, foliage: 18, debris: 19, vehicle: 20,
} as const;
export type ThermalMaterialId = keyof typeof TM;
export const THERMAL_MATERIAL_IDS = Object.keys(TM) as ThermalMaterialId[];

/** Piecewise-linear interpolation, clamped at both ends. */
export function pwl(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

// ── Code relations (θ in °C) ─────────────────────────────────────────────

const STEP_T = [20, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200];
/** [EN3] Table 3.1: effective yield strength and slope of the linear elastic range. */
const STEEL_KY = [1, 1, 1, 1, 1, 0.78, 0.47, 0.23, 0.11, 0.06, 0.04, 0.02, 0];
const STEEL_KE = [1, 1, 0.9, 0.8, 0.7, 0.6, 0.31, 0.13, 0.09, 0.0675, 0.045, 0.0225, 0];
/** [EN2] Table 3.1, siliceous aggregate: f_c,θ / f_ck and the strain at peak stress ε_c1,θ. */
const CONC_KC = [1, 1, 0.95, 0.85, 0.75, 0.6, 0.45, 0.3, 0.15, 0.08, 0.04, 0.01, 0];
const CONC_EC1 = [0.0025, 0.004, 0.0055, 0.007, 0.01, 0.015, 0.025, 0.025, 0.025, 0.025, 0.025, 0.025, 0.025];
/** [EN2] Table 3.2a, class N hot-rolled reinforcement (ε_s,fi ≥ 2 %). */
const REBAR_KS = [1, 1, 1, 1, 1, 0.78, 0.47, 0.23, 0.11, 0.06, 0.04, 0.02, 0];
/** [EN5] Annex B reduction parallel to grain (compression strength / modulus): 1 at 20 °C, value at 100 °C, 0 at 300 °C. */
const TIMBER_T = [20, 100, 300];
const TIMBER_KC = [1, 0.25, 0];
const TIMBER_KE = [1, 0.35, 0];

export const steelKy = (t: number) => pwl(STEP_T, STEEL_KY, t);
export const steelKE = (t: number) => pwl(STEP_T, STEEL_KE, t);
export const concreteKc = (t: number) => pwl(STEP_T, CONC_KC, t);
/** Secant stiffness ratio of concrete: (f_c,θ / ε_c1,θ) / (f_ck / ε_c1,20). */
export const concreteKE = (t: number) => concreteKc(t) * (CONC_EC1[0] / pwl(STEP_T, CONC_EC1, t));
export const rebarKs = (t: number) => pwl(STEP_T, REBAR_KS, t);
export const timberKc = (t: number) => pwl(TIMBER_T, TIMBER_KC, t);
export const timberKE = (t: number) => pwl(TIMBER_T, TIMBER_KE, t);

/** [EN3] c_a(θ), J/(kg·K) — the peak near 735 °C is the austenite transformation (latent heat). */
function steelC(t: number): number {
  const q = Math.max(20, Math.min(1200, t));
  if (q < 600) return 425 + 0.773 * q - 1.69e-3 * q * q + 2.22e-6 * q * q * q;
  if (q < 735) return 666 + 13002 / (738 - q);
  if (q < 900) return 545 + 17820 / (q - 731);
  return 650;
}
const steelK = (t: number) => { const q = Math.max(20, Math.min(1200, t)); return q < 800 ? 54 - 3.33e-2 * q : 27.3; };
/** [EN3] thermal elongation Δl/l. */
function steelStrain(t: number): number {
  const q = Math.min(1200, t);
  if (q < 20) return 1.2e-5 * (q - 20) + (1.2e-5 * 20 + 0.4e-8 * 400 - 2.416e-4);
  if (q < 750) return 1.2e-5 * q + 0.4e-8 * q * q - 2.416e-4;
  if (q <= 860) return 1.1e-2;
  return 2e-5 * q - 6.2e-3;
}

/** [EN2] c_p(θ) of siliceous / calcareous concrete with the 1.5 % moisture peak (100–115 °C). */
function concreteC(t: number): number {
  const q = Math.max(20, Math.min(1200, t));
  if (q <= 100) return 900;
  if (q <= 115) return 1470;
  if (q <= 200) return 1470 + ((q - 115) / 85) * (1000 - 1470);
  if (q <= 400) return 1000 + (q - 200) / 2;
  return 1100;
}
/** [EN2] λ_c upper limit (the EN 1994-1-2 choice). */
const concreteK = (t: number) => { const q = Math.max(20, Math.min(1200, t)) / 100; return 2 - 0.2451 * q + 0.0107 * q * q; };
/** [EN2] siliceous aggregate thermal strain. */
function concreteStrain(t: number): number {
  const q = Math.min(1200, t);
  if (q < 20) return 9e-6 * (q - 20) + (-1.8e-4 + 9e-6 * 20 + 2.3e-11 * 8000);
  if (q <= 700) return -1.8e-4 + 9e-6 * q + 2.3e-11 * q * q * q;
  return 14e-3;
}

/** [EN5] Table B.2 specific heat of softwood (effective, moisture evaporation plateau 99–120 °C). */
const TIMBER_CT = [20, 99, 99.001, 120, 120.001, 200, 250, 300, 350, 400, 600, 800, 1200];
const TIMBER_CV = [1530, 1770, 13600, 13500, 2120, 2000, 1620, 710, 850, 1000, 1400, 1650, 1650];
const TIMBER_KT = [20, 200, 350, 500, 800, 1200];
const TIMBER_KV = [0.12, 0.15, 0.07, 0.09, 0.35, 1.5];

/** [FPL] specific heat of moist biomass at moisture content u (mass of water / dry mass). */
export function moistWoodC(u: number, T: number): number {
  const c0 = (0.1031 + 0.003867 * T) * 1000;
  return (c0 + u * C_WATER) / (1 + u);
}

const linearStrain = (alpha: number) => (t: number) => alpha * (t - 20);

/** Strength / stiffness of a material at θ (°C), for the member types the structural engine checks. */
export interface StrengthModel {
  /** Axial (crushing) strength factor. */
  axial(t: number): number;
  /** Bending strength factor (governed by the tension side: reinforcement for RC). */
  bending(t: number): number;
  /** Elastic modulus factor. */
  stiffness(t: number): number;
  /** Strength recovers on cooling (steel) or keeps the loss of the hottest state (concrete, timber). */
  reversible: boolean;
  source: string;
}

export interface ThermalMaterial {
  id: ThermalMaterialId;
  /** Representative density (kg/m³) — members and objects carry their own mass; used for terrain layers and debris volumes. */
  density: number;
  /** Specific heat c(θ) (J/(kg·K)), θ in °C; constant materials return one value. */
  c: (t: number) => number;
  constantC: number | null;
  /** Conductivity λ(θ) (W/(m·K)). */
  k: (t: number) => number;
  /** Total hemispherical emissivity of the surface (= absorptivity, gray body). */
  emissivity: number;
  /** Free thermal strain ε_th(θ) (relative to 20 °C). */
  strain: (t: number) => number;
  strength: StrengthModel | null;
  /** Range of θ (°C) the property data covers; outside it the end values are held (flagged). */
  range: [number, number];
  source: string;
}

const constant = (v: number) => () => v;

function make(m: Omit<ThermalMaterial, 'constantC'> & { constantC?: number | null }): ThermalMaterial {
  return { ...m, constantC: m.constantC ?? null };
}

const handbook = (id: ThermalMaterialId, density: number, k: number, c: number, emissivity: number, alpha: number, source: string, range: [number, number] = [-40, 200]): ThermalMaterial =>
  make({ id, density, c: constant(c), constantC: c, k: constant(k), emissivity, strain: linearStrain(alpha), strength: null, range, source });

/** Saturated porous mixture (solid + water): density, specific heat by mass, geometric-mean conductivity [JOH]. */
function saturated(id: ThermalMaterialId, n: number, rhoS: number, cS: number, kS: number, emissivity: number, source: string): ThermalMaterial {
  const rho = (1 - n) * rhoS + n * RHO_WATER;
  const C = (1 - n) * rhoS * cS + n * RHO_WATER * C_WATER;
  const k = kS ** (1 - n) * K_WATER ** n;
  return handbook(id, rho, k, C / rho, emissivity, 1e-5, source, [0, 100]);
}

/** Specific heat of the foliage / trunk mixtures at the reference temperature (constant, 0–100 °C). */
const WOOD_U = 0.5;
const FOLIAGE_U = 1.5;
const T15 = ZERO_C + 15;

export const THERMAL_MATERIALS: readonly ThermalMaterial[] = [
  make({
    id: 'concrete', density: 2400, c: concreteC, k: concreteK, emissivity: 0.7, strain: concreteStrain, range: [20, 1200],
    strength: { axial: concreteKc, bending: rebarKs, stiffness: concreteKE, reversible: false, source: 'EN 1992-1-2 Tables 3.1, 3.2a' },
    source: 'EN 1992-1-2 (siliceous, moisture 1.5 %)',
  }),
  make({
    id: 'steel', density: 7850, c: steelC, k: steelK, emissivity: 0.7, strain: steelStrain, range: [20, 1200],
    strength: { axial: steelKy, bending: steelKy, stiffness: steelKE, reversible: true, source: 'EN 1993-1-2 Table 3.1' },
    source: 'EN 1993-1-2 (carbon steel)',
  }),
  make({
    id: 'timber', density: 450, c: (t) => pwl(TIMBER_CT, TIMBER_CV, t), k: (t) => pwl(TIMBER_KT, TIMBER_KV, t), emissivity: 0.8, strain: linearStrain(4e-6), range: [20, 1200],
    strength: { axial: timberKc, bending: timberKc, stiffness: timberKE, reversible: false, source: 'EN 1995-1-2 Annex B (compression parallel to grain)' },
    source: 'EN 1995-1-2 Annex B (softwood); emissivity EN 1991-1-2 default 0.8; α Wood Handbook',
  }),
  handbook('masonry', 1920, 0.72, 835, 0.93, 6e-6, 'Incropera A.3 common brick; ε A.11; α EN 1996-1-1', [-40, 600]),
  handbook('glass', 2700, 1.4, 840, 0.9, 9e-6, 'Incropera A.3 window glass; ε A.11', [-40, 500]),
  make({ id: 'cladding', density: 7850, c: steelC, k: steelK, emissivity: 0.9, strain: steelStrain, strength: null, range: [20, 1200], source: 'steel sheet (EN 1993-1-2), coated surface ε 0.9 (Incropera A.11 paints)' }),
  handbook('pavingConcrete', 2300, 1.4, 880, 0.9, 1e-5, 'Incropera A.3 concrete (stone mix); ε A.11 0.88–0.93'),
  // Asphalt concrete pavement: Incropera's "asphalt" row (k 0.062) is the binder; pavement mixes are
  // reported around 0.7–2 W/(m·K) — 1.2 is a mid value with WEAK support (flagged in the docs).
  handbook('asphalt', 2300, 1.2, 920, 0.93, 1e-5, 'pavement mix: c Incropera A.3 asphalt, k mid of reported 0.7–2 (weak), ε A.11 0.85–0.93'),
  handbook('soil', 2050, 0.52, 1840, 0.94, 1e-5, 'Incropera A.3 soil; ε A.11 0.93–0.96'),
  handbook('sand', 1515, 0.27, 800, 0.9, 1e-5, 'Incropera A.3 sand; ε A.11'),
  handbook('clay', 1460, 1.3, 880, 0.94, 1e-5, 'Incropera A.3 clay'),
  handbook('rock', 2630, 2.79, 775, 0.9, 8e-6, 'Incropera A.3 granite (Barre); ε A.11 rocks 0.88–0.95', [-40, 400]),
  // Dry crushed rock / gravel, porosity 0.35: k = 0.039·n^-2.2 (Johansen), granite solids by mass.
  handbook('gravel', 0.65 * 2630, 0.039 * 0.35 ** -2.2, 775, 0.9, 8e-6, 'Johansen 1975 dry crushed rock, n = 0.35; granite solids'),
  saturated('mud', 0.5, 2650, 800, 2.5, 0.95, 'saturated fine sediment n = 0.5 (mixture rule, Johansen geometric mean)'),
  saturated('riverbed', 0.35, 2650, 800, 3.0, 0.95, 'saturated sand–gravel n = 0.35 (mixture rule)'),
  saturated('saturatedSand', 0.4, 2650, 800, 3.0, 0.95, 'saturated sand fill n = 0.4 (mixture rule)'),
  handbook('water', RHO_WATER, K_WATER, C_WATER, 0.96, 0, 'liquid water; ε Incropera A.11 0.96', [0, 100]),
  handbook('wood', 650, 0.45 * (0.1941 + 0.004064 * 100 * WOOD_U) + 0.01864, moistWoodC(WOOD_U, T15), 0.95, 4e-6, 'green wood u = 50 % (Wood Handbook c, k across grain); ε vegetation', [0, 100]),
  handbook('foliage', 700, 0.3, moistWoodC(FOLIAGE_U, T15), 0.95, 0, 'moist biomass u = 150 % (mixture rule); ε A.11 vegetation 0.92–0.96; k assumed', [0, 100]),
  // Loose rubble: bulked 1.6 (Phase 25) → porosity 0.375, k = 0.039·n^-2.2 (Johansen crushed rock).
  handbook('debris', 2300 / 1.6, 0.039 * 0.375 ** -2.2, 880, 0.9, 1e-5, 'loose rubble, bulking 1.6 (porosity 0.375), Johansen dry crushed rock; c of concrete (heaps use the mass-weighted c of what they hold)'),
  make({ id: 'vehicle', density: 7850, c: steelC, k: steelK, emissivity: 0.9, strain: steelStrain, strength: null, range: [20, 1200], source: 'vehicle body taken as painted steel (EN 1993-1-2 c, λ)' }),
];

export const thermalMaterial = (i: number): ThermalMaterial => THERMAL_MATERIALS[i];

// ── Enthalpy tables (energy ↔ temperature) ───────────────────────────────

const H_T0 = 150; // K
const H_T1 = 2600; // K
const H_N = H_T1 - H_T0 + 1;

/**
 * Specific enthalpy table h(T) (J/kg, relative to 150 K) at 1 K steps, integrating c(θ) exactly
 * enough (20 sub-steps per kelvin). The model's enthalpy IS the piecewise-linear interpolant of this
 * table, and temperature is its exact inverse, so E → T → E round-trips to rounding.
 */
const tables: (Float64Array | null)[] = [];

function table(i: number): Float64Array {
  let h = tables[i];
  if (h) return h;
  const m = THERMAL_MATERIALS[i];
  h = new Float64Array(H_N);
  let acc = 0;
  for (let k = 1; k < H_N; k++) {
    const T0 = H_T0 + k - 1;
    let s = 0;
    for (let j = 0; j < 20; j++) s += m.c(T0 + (j + 0.5) / 20 - ZERO_C);
    acc += s / 20;
    h[k] = acc;
  }
  tables[i] = h;
  return h;
}

/** Specific enthalpy h(T) (J/kg) of a material. */
export function enthalpy(i: number, T: number): number {
  const c = THERMAL_MATERIALS[i].constantC;
  if (c !== null) return c * (T - H_T0);
  const h = table(i);
  const x = Math.max(0, Math.min(H_N - 1.000001, T - H_T0));
  const k = x | 0;
  return h[k] + (x - k) * (h[k + 1] - h[k]);
}

/** Temperature (K) at a specific enthalpy (inverse of enthalpy()). */
export function temperatureOf(i: number, h: number): number {
  const c = THERMAL_MATERIALS[i].constantC;
  if (c !== null) return H_T0 + h / c;
  const t = table(i);
  if (h <= 0) return H_T0 + h / t[1];
  if (h >= t[H_N - 1]) return H_T1 + (h - t[H_N - 1]) / (t[H_N - 1] - t[H_N - 2]);
  let lo = 0, hi = H_N - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= h) lo = mid; else hi = mid; }
  return H_T0 + lo + (h - t[lo]) / (t[hi] - t[lo]);
}

/** Apparent specific heat at T (J/(kg·K)) — the slope of the enthalpy table (stability estimates, display). */
export function specificHeat(i: number, T: number): number {
  const c = THERMAL_MATERIALS[i].constantC;
  if (c !== null) return c;
  const h = table(i);
  const k = Math.max(0, Math.min(H_N - 2, Math.floor(T - H_T0)));
  return h[k + 1] - h[k];
}

/** Lowest specific heat of a material over a temperature range (stability bound for explicit steps). */
export function minSpecificHeat(i: number, T0: number, T1: number): number {
  const c = THERMAL_MATERIALS[i].constantC;
  if (c !== null) return c;
  const h = table(i);
  let lo = Infinity;
  for (let k = Math.max(0, Math.floor(T0 - H_T0)); k <= Math.min(H_N - 2, Math.ceil(T1 - H_T0)); k++) lo = Math.min(lo, h[k + 1] - h[k]);
  return lo;
}

/** Map of the Phase 17 structural materials to thermal materials. */
export const STRUCTURAL_THERMAL: Record<string, number> = {
  reinforcedConcrete: TM.concrete, structuralSteel: TM.steel, timber: TM.timber, masonry: TM.masonry, glass: TM.glass, lightCladding: TM.cladding,
};

/** Surface layers (top two) by terrain ground type id (GroundMaterials order). */
export const GROUND_THERMAL: readonly number[] = [
  TM.soil, // grass: soil under a thin vegetation cover
  TM.soil, TM.sand, TM.asphalt, TM.pavingConcrete, TM.gravel, TM.rock, TM.mud, TM.riverbed,
];
/** Emissivity of the ground surface by ground type (grass: vegetation 0.95). */
export const GROUND_EMISSIVITY: readonly number[] = GROUND_THERMAL.map((m, g) => (g === 0 ? 0.95 : THERMAL_MATERIALS[m].emissivity));
/** Deeper layers by soil profile id (SoilProfiles order: rock, dense soil, soft soil, reclaimed). */
export const SOIL_THERMAL: readonly number[] = [TM.rock, TM.soil, TM.clay, TM.saturatedSand];
