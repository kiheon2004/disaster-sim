/**
 * Lava materials (Phase 28) — REPRESENTATIVE literature values, not a petrological model.
 *
 * Melt viscosity: the GRD model, Giordano, Russell & Dingwell (2008) EPSL 271:123–134 — a VFT relation
 *   log₁₀ η = A + B / (T − C),  A = −4.55,  B and C from the melt composition (mol % oxides, Table 1).
 *   Calibrated on 932 anhydrous + 842 volatile-bearing experiments (RMSE 0.40 log units). Reproduced by
 *   the test against the paper's Table 2 sample (B 7720, C 334, log η = 3.67 at 1273 K).
 * Compositions: USGS reference materials BHVO-2 (Kīlauea basalt, 1919 flow) and AGV-2 (Guano Valley
 *   andesite), recommended values; FeO(T) = 0.8998·Fe₂O₃(T); H₂O 0.05 wt % (degassed surface lava, assumed).
 * Crystals: fraction φ linear in temperature between liquidus (0) and solidus (1) — the same function that
 *   releases the latent heat in the enthalpy table (thermal/materials LAVA_THERMAL), so the energy and the
 *   rheology see the same crystallization.
 * Suspension viscosity (Einstein–Roscoe, as used by FLOWGO after Pinkerton & Stevenson 1992):
 *   η = η_melt · (1 − φ/φ_m)^−2.5,  φ_m = 0.6.
 * Yield strength (Ryerson et al. 1988 crystal-suspension relation as used by FLOWGO):
 *   τ_y = 6500 · φ^2.85 Pa  (the temperature term of Dragoni 1989 is omitted: it only matters below the
 *   lock-up temperature, where the lava no longer moves here).
 * Lock-up: at φ ≥ φ_lock = 0.55 (rheological critical crystallinity 50–60 %, Marsh 1981) the lava stops
 *   flowing and becomes a deposit (still hot and partly molten — it keeps cooling and crystallizing).
 * Valid ranges: GRD 700–1600 °C melts; FLOWGO c_p / L / ε for basalt near eruption temperatures.
 */
import { LAVA_THERMAL, TM, enthalpy, temperatureOf, type LavaThermal } from '@/thermal/materials';
import { ZERO_C } from '@/thermal/units';

export type LavaMaterialId = 'basalt' | 'andesite';
export const LAVA_MATERIAL_IDS: readonly LavaMaterialId[] = ['basalt', 'andesite'];

/** Oxide wt % in the GRD order. */
export interface Composition {
  SiO2: number; TiO2: number; Al2O3: number; FeO: number; MnO: number; MgO: number; CaO: number; Na2O: number; K2O: number; P2O5: number; H2O: number; F2O_1?: number;
}

const MW: Record<keyof Composition, number> = {
  SiO2: 60.0843, TiO2: 79.8658, Al2O3: 101.9613, FeO: 71.8444, MnO: 70.9374, MgO: 40.3044, CaO: 56.0774, Na2O: 61.9789, K2O: 94.196, P2O5: 141.9445, H2O: 18.0153, F2O_1: 37.9968,
};

/** GRD Table 1 coefficients. */
const GRD = { A: -4.55, b: [159.6, -173.3, 72.1, 75.7, -39.0, -84.1, 141.5], b11: -2.43, b12: -0.91, b13: 17.6, c: [2.75, 15.7, 8.3, 10.2, -12.3, -99.5], c11: 0.3 };

/** Mol % of each oxide (normalized to 100). */
export function molPercent(w: Composition): Record<keyof Composition, number> {
  const keys = Object.keys(MW) as (keyof Composition)[];
  let sum = 0;
  const mol = {} as Record<keyof Composition, number>;
  for (const k of keys) { mol[k] = (w[k] ?? 0) / MW[k]; sum += mol[k]; }
  for (const k of keys) mol[k] = (100 * mol[k]) / sum;
  return mol;
}

/** VFT parameters of the GRD model: log₁₀ η = A + B / (T − C) (η in Pa·s, T in K). */
export function grdVft(w: Composition): { A: number; B: number; C: number } {
  const m = molPercent(w);
  const V = m.H2O + m.F2O_1;
  const TA = m.TiO2 + m.Al2O3, FM = m.FeO + m.MnO + m.MgO, NK = m.Na2O + m.K2O;
  const b = GRD.b, c = GRD.c;
  const B = b[0] * (m.SiO2 + m.TiO2) + b[1] * m.Al2O3 + b[2] * (m.FeO + m.MnO + m.P2O5) + b[3] * m.MgO + b[4] * m.CaO + b[5] * (m.Na2O + V) + b[6] * (V + Math.log(1 + m.H2O))
    + GRD.b11 * (m.SiO2 + m.TiO2) * FM + GRD.b12 * (m.SiO2 + TA + m.P2O5) * (NK + m.H2O) + GRD.b13 * m.Al2O3 * NK;
  const C = c[0] * m.SiO2 + c[1] * TA + c[2] * FM + c[3] * m.CaO + c[4] * NK + c[5] * Math.log(1 + V) + GRD.c11 * (m.Al2O3 + FM + m.CaO - m.P2O5) * (NK + V);
  return { A: GRD.A, B, C };
}

export interface LavaMaterial {
  id: LavaMaterialId;
  /** Thermal material index (Phase 26 enthalpy tables). */
  tm: number;
  thermal: LavaThermal;
  composition: Composition;
  vft: { A: number; B: number; C: number };
  /** Maximum packing (Einstein–Roscoe) and lock-up crystal fractions. */
  phiMax: number;
  phiLock: number;
  /** Thermal diffusivity of the solid / crust k / (ρ_bulk·c_p) (m²/s). */
  kappa: number;
  /** Eruption temperature range offered (K) and the default. */
  Trange: [number, number];
  Tdefault: number;
  source: string;
}

const BHVO2: Composition = { SiO2: 49.9, TiO2: 2.73, Al2O3: 13.5, FeO: 12.3 * 0.8998, MnO: 0.17, MgO: 7.23, CaO: 11.4, Na2O: 2.22, K2O: 0.52, P2O5: 0.27, H2O: 0.05 };
const AGV2: Composition = { SiO2: 59.3, TiO2: 1.05, Al2O3: 16.91, FeO: 6.69 * 0.8998, MnO: 0.1, MgO: 1.79, CaO: 5.2, Na2O: 4.19, K2O: 2.88, P2O5: 0.48, H2O: 0.05 };

function material(id: LavaMaterialId, tm: number, th: LavaThermal, composition: Composition, Tdef: number, source: string): LavaMaterial {
  return {
    id, tm, thermal: th, composition, vft: grdVft(composition), phiMax: 0.6, phiLock: 0.55, kappa: th.k / (th.bulk * th.cp),
    Trange: [th.TS + 60, th.TL + 50], Tdefault: Tdef + ZERO_C, source,
  };
}

export const LAVA_MATERIALS: Record<LavaMaterialId, LavaMaterial> = {
  basalt: material('basalt', TM.basaltLava, LAVA_THERMAL.basaltLava, BHVO2, 1140, 'BHVO-2 composition, GRD 2008 viscosity, FLOWGO thermal properties; eruption 1140 °C (FLOWGO Kīlauea)'),
  andesite: material('andesite', TM.andesiteLava, LAVA_THERMAL.andesiteLava, AGV2, 1050, 'AGV-2 composition, GRD 2008 viscosity; thermal properties of basalt (weak); liquidus / solidus assumed'),
};

/** Crystal fraction at T (K): 0 at the liquidus, 1 at the solidus. */
export function crystalFraction(m: LavaMaterial, T: number): number {
  const { TL, TS } = m.thermal;
  return T >= TL ? 0 : T <= TS ? 1 : (TL - T) / (TL - TS);
}

/** Temperature (K) at a crystal fraction. */
export const temperatureAtCrystals = (m: LavaMaterial, phi: number) => m.thermal.TL - phi * (m.thermal.TL - m.thermal.TS);

/** Melt viscosity (Pa·s), GRD VFT. Below C + 1 K it is capped (never reached by mobile lava). */
export function meltViscosity(m: LavaMaterial, T: number): number {
  const { A, B, C } = m.vft;
  return 10 ** (A + B / Math.max(1, T - C));
}

/** Bulk viscosity of the crystal-bearing lava (Pa·s); Infinity at / beyond maximum packing. */
export function viscosity(m: LavaMaterial, T: number): number {
  const phi = crystalFraction(m, T);
  if (phi >= m.phiMax) return Infinity;
  return meltViscosity(m, T) * (1 - phi / m.phiMax) ** -2.5;
}

/** Yield strength (Pa). */
export const yieldStrength = (m: LavaMaterial, T: number) => 6500 * crystalFraction(m, T) ** 2.85;

/** The lava can flow (crystal fraction below lock-up). */
export const mobile = (m: LavaMaterial, T: number) => crystalFraction(m, T) < m.phiLock;

/** Lock-up temperature (K). */
export const lockTemperature = (m: LavaMaterial) => temperatureAtCrystals(m, m.phiLock);

/** Specific enthalpy above the reference temperature (J/kg) — Phase 26 table. */
export const specificEnergy = (m: LavaMaterial, T: number, Tref: number) => enthalpy(m.tm, T) - enthalpy(m.tm, Tref);

/** Temperature from specific energy above the reference (inverse). */
export const temperatureFromEnergy = (m: LavaMaterial, e: number, Tref: number) => temperatureOf(m.tm, e + enthalpy(m.tm, Tref));

/** Latent heat still held at T (J/kg): L·(1 − φ). */
export const latentHeld = (m: LavaMaterial, T: number) => m.thermal.latent * (1 - crystalFraction(m, T));
