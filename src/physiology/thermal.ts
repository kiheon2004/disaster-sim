/**
 * Phase 34: two-node (core / skin) thermoregulation after Gagge et al. (1971, 1986) with an explicit heat balance
 *
 *   C_c dT_c/dt = M − W − Q_cs − Q_res
 *   C_s dT_s/dt = Q_cs − Q_dry − Q_water − Q_contact − E_sk + Q_cond
 *
 * (W; + leaves the node). Q_dry is the heat leaving the skin through the clothing of the air-exposed area; it equals the
 * convection + long-wave radiation leaving the clothing surface minus the absorbed directed (fire) radiation — the
 * clothing surface temperature is solved from that balance with the exact εσ(T⁴ − T_r⁴) term (Kelvin), the clothing has no
 * heat capacity. Water-immersed and ground-contact areas exchange heat by conduction / water convection instead.
 * Evaporation: sweat PRODUCED and sweat EVAPORATED are separate (E_max from the vapour-pressure difference and the
 * evaporative resistances); dripping sweat does not cool. The capacities are fixed (skin share 0.1) so the energy of the
 * two nodes is exactly U = c m (α₀ T_s + (1 − α₀) T_c); Gagge's blood-flow-dependent α enters the mean-body signal only.
 *
 * Temperatures in kelvin at the interface, °C inside the regulation relations (their set points are in °C).
 */
import { esWater } from '@/climate/psychro';
import { SIGMA, ZERO_C } from '@/thermal/units';
import { P } from './params';

export const ACTIVITIES = ['resting', 'light', 'moderate', 'strenuous'] as const;
export type Activity = (typeof ACTIVITIES)[number];
export const ACTIVITY_MET: Record<Activity, number> = { resting: P.metResting, light: P.metLight, moderate: P.metModerate, strenuous: P.metStrenuous };

export const CLOTHING = ['light', 'normal', 'insulated', 'protective'] as const;
export type Clothing = (typeof CLOTHING)[number];
/** Ensemble values: intrinsic insulation (clo; 1 clo = 0.155 m²K/W), permeability index i_cl, covered share of the skin. */
export const CLOTHING_DATA: Record<Clothing, { clo: number; icl: number; cover: number; source: string }> = {
  light: { clo: 0.3, icl: 0.45, cover: 0.4, source: 'shorts + T-shirt (ISO 9920 table order)' },
  normal: { clo: 0.7, icl: 0.38, cover: 0.8, source: 'trousers + long-sleeved shirt (ISO 9920 order)' },
  insulated: { clo: 1.6, icl: 0.34, cover: 0.92, source: 'winter outdoor ensemble (ISO 9920 order)' },
  protective: { clo: 2.0, icl: 0.2, cover: 0.97, source: 'fire-fighter turnout gear order — not a flame barrier in this model' },
};
export const CLO = 0.155;

/** DuBois body surface area (m²). */
export const duBois = (mass: number, height: number) => 0.007184 * Math.pow(mass, 0.425) * Math.pow(height * 100, 0.725);

/** Surface shares of the Phase 33 segments (rule of nines; head 7 %, neck 2 %, torso 26 %, pelvis incl. perineum 11 %). */
export const SURFACE_SHARE = { head: 0.07, neck: 0.02, torso: 0.26, pelvis: 0.11, leftArm: 0.09, rightArm: 0.09, leftLeg: 0.18, rightLeg: 0.18 } as const;

export interface ThermalBody {
  mass: number;
  area: number;
  clothing: Clothing;
  /** Clothing wetness 0 (dry) … 1 (soaked). */
  wet: number;
  /** Radiation area share (standing 0.73, lying 0.65). */
  radShare: number;
  /** Core set-point shift (K) — hypohydration. */
  setShift: number;
  /** Sweat sensitivity factor 0…1 — hypohydration. */
  sweatFactor: number;
  /** Newton start for the clothing surface temperature (the previous step's value; K). */
  tclGuess?: number;
}

/** Environment of one person for one physiology step (all optional parts already resolved by the sampler). */
export interface ThermalEnv {
  /** Air temperature (K), mean radiant temperature of the surroundings (K, excluding the directed flux). */
  Ta: number;
  Tr: number;
  /** Water-vapour partial pressure of the air (Pa). */
  pa: number;
  /** Air speed relative to the body (m/s). */
  vAir: number;
  /** Directed incident radiant flux on the projected area (W/m²), e.g. from a fire. */
  qDir: number;
  /** Immersed share of the body surface, water temperature (K) and relative speed (m/s). */
  fWater: number;
  Tw: number;
  vWater: number;
  /** Share of the surface touching a solid surface of temperature Ts (K) — NaN: unknown (that area exchanges with the air). */
  fContact: number;
  Tsurf: number;
  /** Breathing (airway clear) — no respiratory exchange otherwise. */
  breathing: boolean;
}

export interface Control {
  /** Metabolic rate of the activity (W/m², without shivering). */
  Mact: number;
}

export interface Flows {
  /** Metabolic heat incl. shivering (W), shivering part (W), external work (W). */
  M: number;
  shiver: number;
  W: number;
  /** Core → skin (W). */
  cs: number;
  /** Respiration: sensible + latent (W, out of the core). */
  resSens: number;
  resLat: number;
  /** Air-exposed area: convection and radiation leaving the clothing surface, absorbed directed radiation (W, in). */
  conv: number;
  rad: number;
  absorbed: number;
  /** Water-immersed area (W out), ground contact (W out). */
  water: number;
  contact: number;
  /** Evaporation from the skin: regulatory sweat + diffusion (W out); condensation onto the skin (W in). */
  evap: number;
  cond: number;
  /** Water masses (kg/s): sweat produced, sweat + diffusion evaporated, dripped, respiratory loss. */
  sweat: number;
  evapMass: number;
  drip: number;
  resMass: number;
  /** Skin blood flow (L/(m²h)), skin wettedness, clothing surface temperature (K). */
  skbf: number;
  wettedness: number;
  Tcl: number;
  /** Relation used outside its validated range. */
  outOfRange: boolean;
}

export const capacities = (mass: number) => ({ Cc: (1 - P.skinMassShare) * mass * P.specificHeat, Cs: P.skinMassShare * mass * P.specificHeat });

export function hcAir(v: number): number {
  return Math.max(P.hcAirStill, P.hcAirForcedA * Math.pow(Math.max(0, v), P.hcAirForcedB));
}
export const hcWater = (v: number) => Math.min(P.hcWaterMax, P.hcWaterStill * (1 + P.hcWaterFlow * Math.max(0, v)));

/** Effective dry clothing resistance (m²K/W) and permeability with wetness. */
export function clothingResistance(c: Clothing, wet: number) {
  const d = CLOTHING_DATA[c];
  const R = d.clo * CLO * (1 - wet * (1 - P.wetClothingFactor));
  return { R, icl: d.icl, fcl: 1 + 0.31 * d.clo };
}

/**
 * Clothing surface temperature from (T_s − T_cl)/R_cl + q_abs = f_cl [h_c (T_cl − T_a) + ε σ (A_r/A)(T_cl⁴ − T_r⁴)] (per m² of
 * skin, kelvin). The right side minus the left is strictly increasing in T_cl, so the root is unique (Newton, bracketed).
 */
export function clothingSurface(Ts: number, Ta: number, Tr: number, hc: number, R: number, fcl: number, radShare: number, qAbs: number, guess = Ts): number {
  const k = P.emissivity * SIGMA * radShare;
  if (R < 1e-6) {
    // Nude: the skin is the surface — the caller uses T_s directly.
    return Ts;
  }
  let lo = Math.min(Ts, Ta, Tr) - 50, hi = Math.max(Ts, Ta, Tr) + qAbs * R + 50;
  let T = guess > lo && guess < hi ? guess : Ts;
  const Tr4 = Tr * Tr * Tr * Tr;
  for (let i = 0; i < 40; i++) {
    const T3 = T * T * T;
    const f = (Ts - T) / R + qAbs - fcl * (hc * (T - Ta) + k * (T3 * T - Tr4));
    const d = -1 / R - fcl * (hc + 4 * k * T3);
    const step = f / d;
    // Converged: stop before the bracket test (at the root the bracket closes on T and would force a bisection).
    if (Math.abs(step) < 1e-9) return T - step;
    if (f > 0) lo = T; else hi = T;
    let next = T - step;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    T = next;
  }
  return T;
}

/** All heat flows of the two-node body at (T_c, T_s) (kelvin). */
export function flows(Tc: number, Ts: number, b: ThermalBody, env: ThermalEnv, ctl: Control): Flows {
  const A = b.area;
  const tc = Tc - ZERO_C, ts = Ts - ZERO_C;
  // ── regulation signals (Gagge 1986) ──
  const coreSet = P.coreSet + b.setShift, bodySet = P.bodySet + b.setShift;
  const warmSk = Math.max(0, ts - P.skinSet), coldSk = Math.max(0, P.skinSet - ts);
  const warmCr = Math.max(0, tc - coreSet), coldCr = Math.max(0, coreSet - tc);
  let skbf = (P.skinBloodFlowNeutral + P.vasodilation * warmCr) / (1 + P.vasoconstriction * coldSk);
  skbf = Math.min(P.skinBloodFlowRange, Math.max(0.5, skbf));
  const alpha = 0.0417737 + 0.7451833 / (skbf + 0.585417);
  const tb = alpha * ts + (1 - alpha) * tc;
  const warmB = Math.max(0, tb - bodySet);
  const regSw = Math.min(P.sweatMax, P.sweatGain * warmB * Math.exp(warmSk / 10.7)) * b.sweatFactor; // g/(m²h)
  const shiverFade = Math.min(1, Math.max(0, (tc - P.shiverStop) / 2));
  const shiver = Math.min(P.shiverMax, P.shiverGain * coldSk * coldCr) * shiverFade * A;
  const Mact = ctl.Mact * A;
  const M = Mact + shiver;
  const W = P.workEfficiency * Math.max(0, Mact - P.metResting * P.met * A);
  const cs = (P.coreSkinConductance + P.bloodHeat * skbf) * (tc - ts) * A;
  // ── respiration (ASHRAE: sensible 0.0014 M (34 − t_a), latent 0.0173 M (5.87 − p_a/kPa); M in W/m²) ──
  const mArea = M / A;
  const ta = env.Ta - ZERO_C;
  let outOfRange = false;
  const resSens = env.breathing ? 0.0014 * mArea * (34 - ta) * A : 0;
  const resLat = env.breathing ? 0.0173 * mArea * (5.87 - env.pa / 1000) * A : 0;
  if (env.breathing && (ta > 50 || ta < -40)) outOfRange = true;
  // ── surface split ──
  const fW = Math.min(1, Math.max(0, env.fWater));
  const contactKnown = Number.isFinite(env.Tsurf);
  const fC = contactKnown ? Math.min(1 - fW, Math.max(0, env.fContact)) : 0;
  const fAir = Math.max(0, 1 - fW - fC);
  // Immersed clothing is soaked; the air-exposed / contact part keeps the current wetness.
  const Rwet = clothingResistance(b.clothing, 1).R;
  const { R: Rdry, icl, fcl } = clothingResistance(b.clothing, b.wet);
  const hc = hcAir(env.vAir);
  if (env.vAir > P.hcAirValid) outOfRange = true;
  // Directed radiation lands on the projected area; on the air-exposed part only (absorbed by the clothing surface).
  const absorbed = P.absorptivity * env.qDir * P.projectedShare * A * fAir;
  const Aair = A * fAir;
  let conv = 0, rad = 0, Tcl = Ts;
  if (Aair > 0) {
    const qAbs = absorbed / Aair;
    Tcl = Rdry < 1e-6 ? Ts : clothingSurface(Ts, env.Ta, env.Tr, hc, Rdry, fcl, b.radShare, qAbs, b.tclGuess);
    const f = Rdry < 1e-6 ? 1 : fcl;
    conv = f * hc * (Tcl - env.Ta) * Aair;
    rad = f * P.emissivity * SIGMA * b.radShare * (Tcl ** 4 - env.Tr ** 4) * Aair;
  }
  // Nude skin: (T_s − T_cl)/R does not exist; the skin balance takes conv + rad − absorbed directly (same expression).
  const water = fW > 0 ? ((Ts - env.Tw) / (Rwet + 1 / hcWater(env.vWater))) * A * fW : 0;
  const contact = fC > 0 ? ((Ts - env.Tsurf) / (Rdry + P.contactResistance)) * A * fC : 0;
  // ── evaporation from the air-exposed skin ──
  const pss = esWater(Ts);
  const he = P.lewis * hc;
  const Recl = Rdry / (P.lewis * icl);
  const Emax = Aair > 0 ? ((pss - env.pa) / (Recl + 1 / (fcl * he))) : 0; // W/m² of exposed skin
  const L = P.latentHeat;
  const ErswProd = (regSw / 3.6e6) * L; // W/m²
  let evap = 0, cond = 0, evapMass = 0, drip = 0, wettedness = 0;
  const sweat = (regSw / 3.6e6) * A; // kg/s produced over the whole skin
  if (Emax > 0 && Aair > 0) {
    const wRsw = Math.min(1, ErswProd / Emax);
    const Ersw = wRsw * Emax;
    const Edif = P.skinDiffusion * (1 - wRsw) * Emax;
    evap = (Ersw + Edif) * Aair;
    evapMass = evap / L;
    // Sweat produced on the exposed skin beyond what evaporates drips; sweat of the immersed / contact skin is lost too.
    drip = sweat - (Ersw * Aair) / L;
    wettedness = wRsw + P.skinDiffusion * (1 - wRsw);
  } else {
    drip = sweat;
    if (Emax < 0) cond = -Emax * Aair;
    wettedness = Aair > 0 ? 1 : 0;
  }
  const resMass = resLat / L;
  return { M, shiver, W, cs, resSens, resLat, conv, rad, absorbed, water, contact, evap, cond, sweat, evapMass, drip: Math.max(0, drip), resMass, skbf, wettedness, Tcl, outOfRange };
}

/** Node derivatives (K/s) from the flows. */
export function derivatives(f: Flows, Cc: number, Cs: number): [number, number] {
  const dTc = (f.M - f.W - f.cs - f.resSens - f.resLat) / Cc;
  const dTs = (f.cs - (f.conv + f.rad - f.absorbed) - f.water - f.contact - f.evap + f.cond) / Cs;
  return [dTc, dTs];
}

/** Net heat into the body (W) — the energy-balance identity checked by the ledger. */
export const netHeat = (f: Flows) => f.M - f.W - f.resSens - f.resLat - (f.conv + f.rad - f.absorbed) - f.water - f.contact - f.evap + f.cond;
