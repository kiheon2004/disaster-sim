/**
 * Phase 34: the reduced physiology of one person, advanced by `stepPhysiology` over a step of simulated time from one
 * exposure sample. Owns body temperature (two nodes), body water, airway history, inhaled-gas / heat doses, fatigue and the
 * physiological capacity; it never touches the Phase 33 physical state (falls, contacts, injury index, health) — the
 * capacity resolver combines both into one action state with the limiting causes recorded separately.
 *
 * Integration: Heun (explicit trapezoid) on the two temperature nodes with the regulation evaluated at both ends; every
 * ledger term is integrated with the same weights, so ΔU = Σ ledger holds to rounding (the residual is recorded).
 * Exposure doses use the trapezoid rule between the previous and the current sample (exact for piecewise-linear exposure).
 * Body water, clothing wetness and fatigue use the step-start rates (first order; clamped ≥ 0 / ≤ 1, a clamp is a flag).
 */
import { ZERO_C } from '@/thermal/units';
import { P } from './params';
import { ACTIVITY_MET, capacities, derivatives, duBois, flows, netHeat, type Activity, type Clothing, type Flows, type ThermalEnv } from './thermal';
import { fedRates, MOL_PER_L_STPD, oxygenUptake, supplyIndex, ventilationDemand, type FedRates } from './gas';

export const CAPACITY_LEVELS = ['normal', 'stressed', 'impaired', 'severelyImpaired', 'unableToAct'] as const;
export type CapacityLevel = (typeof CAPACITY_LEVELS)[number];
export const THERMAL_STATES = ['normal', 'coldStress', 'severeColdStress', 'heatStress', 'severeHeatStress', 'thermoregulationFailure'] as const;
export type ThermalStateName = (typeof THERMAL_STATES)[number];
export const AIRWAY_STATES = ['clear', 'intermittent', 'submerged', 'unknown'] as const;
export type AirwayState = (typeof AIRWAY_STATES)[number];
export const COMPONENTS = ['thermal', 'respiratory', 'gas', 'heatDose', 'hydration', 'fatigue'] as const;
export type Component = (typeof COMPONENTS)[number];

/** One exposure sample (sampler output, all resolved; undefined = not available → that part is not computed). */
export interface Exposure {
  thermal?: ThermalEnv;
  /** Ambient pressure (Pa), gas mole fractions (mol/mol), smoke particle mass concentration (kg/m³) at the airway. */
  p?: number;
  xO2?: number;
  xCO2?: number;
  xCO?: number;
  smoke?: number;
  /** Directed radiant flux of fires / heat sources (W/m², without the sun) — radiant heat dose. */
  qFire?: number;
  /** Air temperature at the airway (K) — convective heat dose. */
  airwayT?: number;
  /** Airway under the water surface; undefined = unknown (e.g. buried, no information). */
  airwaySubmerged?: boolean;
  /** Water temperature at the airway when submerged (K) — cold-shock reserve factor. */
  waterT?: number;
  /** Posture context from Phase 33: lying (radiation share, contact), physical capacity. */
  lying: boolean;
  physical: { incapacitated: boolean; mobility: 'mobile' | 'impaired' | 'immobile' };
}

export interface PhysioConfig {
  mass: number;
  height: number;
  activity: Activity;
  clothing: Clothing;
  /** Explicit water intake (kg/s) — never assumed. */
  intake: number;
  modules: { thermal: boolean; respiration: boolean; gas: boolean; submersion: boolean; hydration: boolean; fatigue: boolean };
}

export interface Ledger {
  /** Heat (J): metabolic (incl. shivering), shivering part, external work, core→skin, respiration sensible / latent, convection,
   * radiation, absorbed directed radiation (in), water, contact, evaporation, condensation (in). */
  metabolic: number; shiver: number; work: number; coreSkin: number; resSens: number; resLat: number; conv: number; rad: number;
  absorbed: number; water: number; contact: number; evap: number; cond: number;
  /** Initial energy content reference (J) and residual ΔU − Σ (J). */
  residual: number;
  /** Water (kg): sweat produced, evaporated (sweat + diffusion), dripped, respiratory, intake. */
  sweat: number; evapMass: number; drip: number; resMass: number; intake: number;
  /** Gases (mol): O₂ consumed, CO₂ produced, O₂ consumed while not breathing (taken from body stores). */
  o2: number; co2: number; o2Debt: number;
}

export interface PhysioState {
  Tc: number;
  Ts: number;
  Cc: number;
  Cs: number;
  area: number;
  wet: number;
  /** Body water lost / gained (kg) and the generic total body water (kg). */
  waterLost: number;
  waterIntake: number;
  bodyWater: number;
  fatigue: number;
  fed: FedRates;
  /** Doses: CO (ppm·s), CO₂ (mol/mol·s), O₂ deficit (mol/mol·s below the reference), smoke (kg·s/m³), inhaled / deposited smoke (kg), radiant heat ((kW/m²)^(4/3)·s). */
  dose: { co: number; co2: number; o2Deficit: number; smoke: number; smokeInhaled: number; smokeDeposited: number; radiant: number };
  /** history: submersion onset times within the last 10 s. */
  airway: { state: AirwayState; first: number | null; cumulative: number; continuous: number; longest: number; submersions: number; returns: number; hold: number; history: number[]; submerged: boolean };
  resp: { demand: number; actual: number; supply: number | null; load: number; breathing: boolean };
  /** Last flows (W / kg/s) — inspector / series; null before the first step. */
  last: Flows | null;
  thermalState: ThermalStateName;
  /** Side of the current thermal strain (kept while the level recovers through the hysteresis). */
  thermalCold: boolean;
  levels: Record<Component, CapacityLevel>;
  capacity: CapacityLevel;
  limiting: Component[];
  /** Combined with the Phase 33 physical capacity. */
  combined: CapacityLevel;
  combinedCauses: string[];
  /** Effective activity after limits, and its metabolic rate (W/m²). */
  activity: Activity | 'reclining';
  ledger: Ledger;
  U0: number;
  /** Previous dose rates (trapezoid). */
  prev: { co: number; co2: number; o2: number; smoke: number; inhaled: number; radiant: number; fed: FedRates } | null;
  /** Time of the last downgrade request per component (hysteresis dwell). */
  since: Record<Component, number>;
  flags: Set<string>;
  time: number;
}

/** Heun (explicit trapezoid, 2nd order) for a 2-state system; returns both stage payloads (ledger weights dt/2 each). */
export function heun<F>(y: readonly [number, number], rhs: (y: readonly [number, number]) => { d: readonly [number, number]; f: F }, dt: number): { y: [number, number]; f1: F; f2: F } {
  const a = rhs(y);
  const y1: [number, number] = [y[0] + dt * a.d[0], y[1] + dt * a.d[1]];
  const b = rhs(y1);
  return { y: [y[0] + (dt / 2) * (a.d[0] + b.d[0]), y[1] + (dt / 2) * (a.d[1] + b.d[1])], f1: a.f, f2: b.f };
}

const zeroFed = (): FedRates => ({ co: 0, o2: 0, co2: 0, heatConv: 0, heatRad: 0 });

export function createPhysioState(cfg: PhysioConfig, Tc0 = P.coreSet + ZERO_C, Ts0 = 34.0 + ZERO_C): PhysioState {
  const { Cc, Cs } = capacities(cfg.mass);
  const comp = () => Object.fromEntries(COMPONENTS.map((c) => [c, 'normal'])) as Record<Component, CapacityLevel>;
  return {
    Tc: Tc0, Ts: Ts0, Cc, Cs, area: duBois(cfg.mass, cfg.height), wet: 0,
    waterLost: 0, waterIntake: 0, bodyWater: P.bodyWaterShare * cfg.mass, fatigue: 0, fed: zeroFed(),
    dose: { co: 0, co2: 0, o2Deficit: 0, smoke: 0, smokeInhaled: 0, smokeDeposited: 0, radiant: 0 },
    airway: { state: 'clear', first: null, cumulative: 0, continuous: 0, longest: 0, submersions: 0, returns: 0, hold: 0, history: [], submerged: false },
    resp: { demand: 0, actual: 0, supply: null, load: 0, breathing: true },
    last: null, thermalState: 'normal', thermalCold: false, levels: comp(), capacity: 'normal', limiting: [], combined: 'normal', combinedCauses: [],
    activity: cfg.activity,
    ledger: { metabolic: 0, shiver: 0, work: 0, coreSkin: 0, resSens: 0, resLat: 0, conv: 0, rad: 0, absorbed: 0, water: 0, contact: 0, evap: 0, cond: 0, residual: 0, sweat: 0, evapMass: 0, drip: 0, resMass: 0, intake: 0, o2: 0, co2: 0, o2Debt: 0 },
    U0: Cc * Tc0 + Cs * Ts0, prev: null, since: Object.fromEntries(COMPONENTS.map((c) => [c, -Infinity])) as Record<Component, number>, flags: new Set(), time: 0,
  };
}

/** Body energy content (J, relative to 0 K) — the conserved quantity of the ledger. */
export const energy = (s: PhysioState) => s.Cc * s.Tc + s.Cs * s.Ts;
export const deficitPercent = (s: PhysioState, mass: number) => (100 * (s.waterLost - s.waterIntake)) / mass;

// ── capacity levels with hysteresis ─────────────────────────────────────────────────────────────────────────────────
/** Entry thresholds per level 1…4 of a scalar (rising = worse) and the recovery margin; recovery needs DWELL s below. */
export const THRESHOLDS: Record<Component, { enter: readonly number[]; margin: number; note: string }> = {
  // thermal: strain in K away from the core set point (heat positive, cold handled by the sign below)
  thermal: { enter: [1.2, 2.2, 3.2, 4.2], margin: 0.2, note: 'core 38.0 / 39.0 / 40.0 / 41.0 °C (heat), 36.0 / 35.0 / 32.0 / 30.0 °C (cold) — educational bounds, ISO 7933 38 °C limit, shivering ceases ≈ 32 °C' },
  respiratory: { enter: [0.25, 0.5, 0.65, 0.8], margin: 0.05, note: '1 − O₂ supply index (supply 0.75 / 0.5 / 0.35 / 0.2) or the breath-hold reserve used — assumption' },
  gas: { enter: [0.1, 0.3, 0.7, 1], margin: 0, note: 'asphyxiant FED (ISO 13571; 0.3 = sensitive-population criterion, 1 = reference)' },
  heatDose: { enter: [0.1, 0.3, 0.7, 1], margin: 0, note: 'heat FED (convective + radiant, ISO 13571 form)' },
  hydration: { enter: [2, 4, 6, 10], margin: 0.2, note: 'water deficit % body mass (2 % = common performance-decrement reference)' },
  fatigue: { enter: [0.5, 0.8, 1, Infinity], margin: 0.05, note: 'fatigue index (model)' },
};
export const DWELL = 10;
/** Mean skin temperature (°C) → cold strain: 30 °C → 1.2 (cold stress), 25 °C → 2.2 (severe), capped there — the skin alone
 * never makes a thermoregulation failure (educational assumption; cold-water skin approaches the water temperature). */
export function skinColdStrain(ts: number): number {
  if (ts >= 32) return 0;
  if (ts >= 30) return ((32 - ts) / 2) * 1.2;
  return Math.min(2.2, 1.2 + (30 - ts) / 5);
}
/** Core temperature (°C) → strain on the heat scale: heat 38 / 39 / 40 / 41 °C and cold 36 / 35 / 32 / 30 °C both map to 1.2 / 2.2 / 3.2 / 4.2. */
const COLD_POINTS: readonly [number, number][] = [[36.8, 0], [36, 1.2], [35, 2.2], [32, 3.2], [30, 4.2]];
export function thermalStrain(tc: number): number {
  if (tc >= P.coreSet) return tc - P.coreSet;
  for (let i = 1; i < COLD_POINTS.length; i++) {
    const [t0, x0] = COLD_POINTS[i - 1], [t1, x1] = COLD_POINTS[i];
    if (tc >= t1) return x0 + ((t0 - tc) / (t0 - t1)) * (x1 - x0);
  }
  return 4.2 + (30 - tc) * 0.5;
}

function levelFor(x: number, enter: readonly number[]): number {
  let k = 0;
  for (let i = 0; i < enter.length; i++) if (x >= enter[i]) k = i + 1;
  return k;
}

function resolve(s: PhysioState, c: Component, x: number, t: number) {
  const th = THRESHOLDS[c];
  const cur = CAPACITY_LEVELS.indexOf(s.levels[c]);
  const up = levelFor(x, th.enter);
  if (up >= cur) {
    s.levels[c] = CAPACITY_LEVELS[up];
    s.since[c] = t;
    return;
  }
  // Recovery: below the entry threshold of the current level by the margin, for DWELL s.
  const down = levelFor(x + th.margin, th.enter);
  if (down < cur) {
    if (t - s.since[c] >= DWELL) {
      s.levels[c] = CAPACITY_LEVELS[down];
      s.since[c] = t;
    }
  } else s.since[c] = t;
}

const worst = (a: CapacityLevel, b: CapacityLevel) => (CAPACITY_LEVELS.indexOf(a) >= CAPACITY_LEVELS.indexOf(b) ? a : b);

export interface Transition {
  kind: 'thermal' | 'airway' | 'capacity' | 'gas' | 'hydration' | 'fatigue' | 'respiratory';
  from: string;
  to: string;
}

type Rates = NonNullable<PhysioState['prev']>;
/** Dose rates of one exposure sample (ppm, mol/mol, kg/m³, kg/s, (kW/m²)^(4/3), FED 1/s); inhaled terms only while breathing. */
function doseRates(cfg: PhysioConfig, ex: Exposure, breathing: boolean, ventLmin: number): Rates {
  const airC = ex.airwayT !== undefined ? ex.airwayT - ZERO_C : undefined;
  const qDir = ex.qFire ?? 0;
  const inh = breathing && cfg.modules.gas;
  return {
    co: inh && ex.xCO !== undefined ? ex.xCO * 1e6 : 0,
    co2: inh && ex.xCO2 !== undefined ? ex.xCO2 : 0,
    o2: inh && ex.xO2 !== undefined ? Math.max(0, 0.2095 - ex.xO2) : 0,
    smoke: cfg.modules.gas && ex.smoke !== undefined ? ex.smoke : 0,
    inhaled: inh && ex.smoke !== undefined ? ex.smoke * (ventLmin / 60 / 1000) : 0, // kg/s = kg/m³ · m³/s
    radiant: cfg.modules.thermal && qDir / 1000 > P.radHeatMin ? Math.pow(qDir / 1000, 4 / 3) : 0,
    fed: fedRates({ xO2: inh ? ex.xO2 : undefined, xCO2: inh ? ex.xCO2 : undefined, xCO: inh ? ex.xCO : undefined, p: ex.p, airC: cfg.modules.thermal ? airC : undefined, qDir: cfg.modules.thermal ? qDir : 0 }),
  };
}

/** The exposure at the start time (t₀): the first step's trapezoid then spans [t₀, t₀ + dt] correctly. */
export function primePhysiology(s: PhysioState, cfg: PhysioConfig, ex: Exposure) {
  const breathing = !(cfg.modules.submersion && ex.airwaySubmerged === true);
  const vent = breathing ? ventilationDemand(oxygenUptake((ex.lying ? 0.8 : ACTIVITY_MET[cfg.activity]) * P.met * s.area)) : 0;
  s.prev = doseRates(cfg, ex, breathing, vent);
}

/** Advance one person by dt (s) at simulated time t (s, end of the step). Returns the state transitions of the step. */
export function stepPhysiology(s: PhysioState, cfg: PhysioConfig, ex: Exposure, dt: number, t: number): Transition[] {
  const out: Transition[] = [];
  const m = cfg.mass;
  s.time = t;
  // ── airway ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const aw = s.airway;
  const prevAirway = aw.state;
  if (cfg.modules.submersion) {
    if (ex.airwaySubmerged === undefined) {
      aw.state = 'unknown';
      if (aw.submerged) aw.continuous = 0;
      aw.submerged = false;
    } else {
      const sub = ex.airwaySubmerged;
      if (sub && !aw.submerged) {
        aw.submersions++;
        if (aw.first === null) aw.first = t;
        aw.history.push(t);
      } else if (!sub && aw.submerged) aw.returns++;
      aw.submerged = sub;
      if (sub) {
        aw.cumulative += dt;
        aw.continuous += dt;
        if (aw.continuous > aw.longest) aw.longest = aw.continuous;
        const cold = ex.waterT !== undefined && ex.waterT < 15 + ZERO_C ? P.coldShockHold : 1;
        aw.hold += dt / (P.breathHold * cold);
      } else {
        aw.continuous = 0;
        // Recovery of the reserve once breathing again (time constant 30 s — assumption).
        aw.hold *= Math.exp(-dt / 30);
      }
      while (aw.history.length && aw.history[0] < t - 10) aw.history.shift();
      // Under continuously ≥ 2 s → submerged; two or more submersion onsets within the last 10 s → intermittent; just under → submerged; else clear.
      aw.state = sub && aw.continuous >= 2 ? 'submerged' : aw.history.length >= 2 ? 'intermittent' : sub ? 'submerged' : 'clear';
    }
  }
  if (aw.state !== prevAirway) out.push({ kind: 'airway', from: prevAirway, to: aw.state });
  const breathing = !(cfg.modules.submersion && aw.submerged);
  s.resp.breathing = breathing;

  // ── effective activity (capacity limits from the previous step; a lying person reclines) ────────────────────────
  let act: Activity | 'reclining' = cfg.activity;
  const capIdx = CAPACITY_LEVELS.indexOf(s.combined);
  if (ex.physical.incapacitated || ex.physical.mobility === 'immobile' || capIdx >= 3 || s.fatigue >= 1) act = ex.lying ? 'reclining' : 'resting';
  else if (ex.lying) act = 'reclining';
  else if (capIdx === 2 && act === 'strenuous') act = 'moderate';
  s.activity = act;
  const Mact = (act === 'reclining' ? 0.8 : ACTIVITY_MET[act]) * P.met;

  // ── hydration effects ───────────────────────────────────────────────────────────────────────────────────────────
  const def = cfg.modules.hydration ? Math.max(0, deficitPercent(s, m)) : 0;
  const setShift = P.dehydrationCoreShift * def;
  const sweatFactor = 1 / (1 + P.dehydrationSweatLoss * Math.max(0, def - 1));

  // ── thermal (Heun) ──────────────────────────────────────────────────────────────────────────────────────────────
  let f1: Flows | null = null;
  if (cfg.modules.thermal && ex.thermal) {
    const env: ThermalEnv = { ...ex.thermal, breathing };
    const body = { mass: m, area: s.area, clothing: cfg.clothing, wet: s.wet, radShare: ex.lying ? 0.65 : P.radiativeShare, setShift, sweatFactor, tclGuess: s.last?.Tcl };
    const U = energy(s);
    const step = heun([s.Tc, s.Ts], (y) => {
      const f = flows(y[0], y[1], body, env, { Mact });
      return { d: derivatives(f, s.Cc, s.Cs), f };
    }, dt);
    f1 = step.f1;
    const f2 = step.f2;
    [s.Tc, s.Ts] = step.y;
    const h = dt / 2, L = s.ledger;
    const add = (k: keyof Flows) => h * ((f1![k] as number) + (f2[k] as number));
    L.metabolic += add('M'); L.shiver += add('shiver'); L.work += add('W'); L.coreSkin += add('cs'); L.resSens += add('resSens'); L.resLat += add('resLat');
    L.conv += add('conv'); L.rad += add('rad'); L.absorbed += add('absorbed'); L.water += add('water'); L.contact += add('contact');
    L.evap += add('evap'); L.cond += add('cond');
    const dU = energy(s) - U;
    L.residual += dU - h * (netHeat(f1) + netHeat(f2));
    // Water masses with the same weights (evaporated mass × L_v = evaporative heat exactly).
    const sw = add('sweat'), ev = add('evapMass'), dr = add('drip'), rm = add('resMass');
    L.sweat += sw; L.evapMass += ev; L.drip += dr; L.resMass += rm;
    if (cfg.modules.hydration) s.waterLost += ev + dr + rm;
    if (f1.outOfRange || f2.outOfRange) s.flags.add('thermalOutOfRange');
    s.last = f2;
    // Clothing wetness: soaked while immersed, drying with a 30 min time constant (assumption).
    s.wet = ex.thermal.fWater > 0.05 ? Math.max(s.wet, Math.min(1, ex.thermal.fWater * 2)) : s.wet * Math.exp(-dt / 1800);
    if (!Number.isFinite(s.Tc) || !Number.isFinite(s.Ts)) s.flags.add('nonFinite');
  } else if (cfg.modules.thermal) s.flags.add('thermalUnsupported');
  if (cfg.modules.hydration && cfg.intake > 0) {
    s.waterIntake += cfg.intake * dt;
    s.ledger.intake += cfg.intake * dt;
  }

  // ── respiration / oxygen ────────────────────────────────────────────────────────────────────────────────────────
  const Mtot = f1 ? f1.M : Mact * s.area;
  const vo2 = oxygenUptake(Mtot); // L/s STPD
  const o2mol = vo2 * MOL_PER_L_STPD * dt;
  s.ledger.o2 += o2mol;
  s.ledger.co2 += o2mol * P.respiratoryQuotient;
  if (!breathing) s.ledger.o2Debt += o2mol;
  const demand = ventilationDemand(vo2);
  s.resp.demand = demand;
  s.resp.actual = breathing ? demand : 0;
  s.resp.load = demand / P.ventilationMax;
  const gasKnown = ex.p !== undefined && ex.xO2 !== undefined;
  // While the airway is under water the supply index keeps its last breathed value; the breath-hold reserve then drives the level.
  if (!(cfg.modules.respiration && gasKnown)) s.resp.supply = null;
  else if (breathing) s.resp.supply = supplyIndex(ex.xO2!, ex.xCO2 ?? 0, ex.p!);

  // ── gas / heat doses (trapezoid between samples; only while breathing for inhaled terms) ────────────────────────
  const cur = doseRates(cfg, ex, breathing, s.resp.actual);
  const pv = s.prev ?? cur;
  const tr = (a: number, b: number) => (dt / 2) * (a + b);
  s.dose.co += tr(pv.co, cur.co);
  s.dose.co2 += tr(pv.co2, cur.co2);
  s.dose.o2Deficit += tr(pv.o2, cur.o2);
  s.dose.smoke += tr(pv.smoke, cur.smoke);
  const inhaled = tr(pv.inhaled, cur.inhaled);
  s.dose.smokeInhaled += inhaled;
  s.dose.smokeDeposited += P.smokeDeposition * inhaled;
  s.dose.radiant += tr(pv.radiant, cur.radiant);
  for (const k of ['co', 'o2', 'co2', 'heatConv', 'heatRad'] as const) s.fed[k] += tr(pv.fed[k], cur.fed[k]);
  s.prev = cur;

  // ── fatigue (relative intensity against a capacity reduced by heat, water deficit and oxygen supply) ───────────
  if (cfg.modules.fatigue) {
    const heat = Math.max(0, s.Tc - ZERO_C - 38);
    const cap = Math.max(0.1, (1 - 0.1 * heat) * (1 - 0.02 * def) * Math.min(1, s.resp.supply ?? 1));
    const r = Mact / (P.metMax * P.met * cap);
    const rs = P.sustainable;
    const before = s.fatigue;
    if (r > rs) s.fatigue += (dt * (r - rs)) / (P.fatigueTime * (1 - rs));
    else s.fatigue *= Math.exp((-dt * (rs - r)) / (rs * P.recoveryTime));
    s.fatigue = Math.min(1, Math.max(0, s.fatigue));
    if (before < 1 && s.fatigue >= 1) out.push({ kind: 'fatigue', from: 'below', to: 'limit' });
  }

  // ── component levels ────────────────────────────────────────────────────────────────────────────────────────────
  const prevThermal = s.thermalState;
  if (cfg.modules.thermal && ex.thermal) {
    const tc = s.Tc - ZERO_C;
    // Heat strain (core above its set point) and cold strain (core below it, or a cold skin) — the larger one names the state.
    const heatX = Math.max(0, tc - P.coreSet), coldX = Math.max(tc < P.coreSet ? thermalStrain(tc) : 0, skinColdStrain(s.Ts - ZERO_C));
    resolve(s, 'thermal', Math.max(heatX, coldX), t);
    const lv = CAPACITY_LEVELS.indexOf(s.levels.thermal);
    if (lv > 0) s.thermalCold = coldX > heatX;
    const cold = s.thermalCold;
    s.thermalState = lv === 0 ? 'normal' : lv >= 3 ? 'thermoregulationFailure' : cold ? (lv === 1 ? 'coldStress' : 'severeColdStress') : lv === 1 ? 'heatStress' : 'severeHeatStress';
  }
  if (s.thermalState !== prevThermal) out.push({ kind: 'thermal', from: prevThermal, to: s.thermalState });
  const respX = Math.max(s.resp.supply !== null ? 1 - s.resp.supply : 0, cfg.modules.submersion ? aw.hold : 0);
  const prevResp = s.levels.respiratory;
  resolve(s, 'respiratory', respX, t);
  if (s.levels.respiratory !== prevResp && CAPACITY_LEVELS.indexOf(prevResp) === 0) out.push({ kind: 'respiratory', from: prevResp, to: s.levels.respiratory });
  const prevGas = s.levels.gas;
  resolve(s, 'gas', s.fed.co + s.fed.o2 + s.fed.co2, t);
  if (prevGas === 'normal' && s.levels.gas !== 'normal') out.push({ kind: 'gas', from: prevGas, to: s.levels.gas });
  resolve(s, 'heatDose', s.fed.heatConv + s.fed.heatRad, t);
  const prevHyd = s.levels.hydration;
  if (cfg.modules.hydration) resolve(s, 'hydration', def, t);
  if (prevHyd === 'normal' && s.levels.hydration !== 'normal') out.push({ kind: 'hydration', from: prevHyd, to: s.levels.hydration });
  if (cfg.modules.fatigue) resolve(s, 'fatigue', s.fatigue, t);

  // ── capacity: physiological (worst component) and combined with the Phase 33 physical capacity ────────────────
  let cap: CapacityLevel = 'normal';
  for (const c of COMPONENTS) cap = worst(cap, s.levels[c]);
  s.limiting = cap === 'normal' ? [] : COMPONENTS.filter((c) => s.levels[c] === cap);
  const prevCombined = s.combined;
  s.capacity = cap;
  const phys: CapacityLevel = ex.physical.incapacitated ? 'unableToAct' : ex.physical.mobility === 'immobile' ? 'severelyImpaired' : ex.physical.mobility === 'impaired' ? 'impaired' : 'normal';
  s.combined = worst(cap, phys);
  s.combinedCauses = [...(phys !== 'normal' && phys === s.combined ? ['physical'] : []), ...(cap === s.combined && cap !== 'normal' ? s.limiting : [])];
  if (s.combined !== prevCombined) out.push({ kind: 'capacity', from: prevCombined, to: s.combined });
  if (s.Tc < 10 + ZERO_C || s.Tc > 46 + ZERO_C) s.flags.add('temperatureOutOfModelRange');
  return out;
}
