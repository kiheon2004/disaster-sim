/**
 * Phase 34: independent checks of the reduced physiology (spec §59–63). Expected values come from closed-form solutions,
 * hand calculations in the test (constants written out, not the implementation's functions) or literature orders of
 * magnitude stated with their source; a check that needs the model's own function says so.
 */
import { describe, expect, it } from 'vitest';
import { esWater } from '@/climate/psychro';
import { P } from './params';
import { clothingResistance, clothingSurface, duBois, flows, type ThermalEnv } from './thermal';
import { alveolarO2, equivalentO2Percent, fedRates, toMgM3 } from './gas';
import { createPhysioState, deficitPercent, energy, heun, primePhysiology, skinColdStrain, stepPhysiology, thermalStrain, type Exposure, type PhysioConfig } from './engine';

const K = 273.15;
const SIG = 5.670374419e-8;
const MODS = { thermal: true, respiration: true, gas: true, submersion: true, hydration: true, fatigue: true };
const cfg = (o: Partial<PhysioConfig> = {}): PhysioConfig => ({ mass: 70, height: 1.75, activity: 'resting', clothing: 'normal', intake: 0, modules: MODS, ...o });
function air(tC: number, RH: number, v = 0.1, o: Partial<ThermalEnv> = {}): ThermalEnv {
  return { Ta: tC + K, Tr: tC + K, pa: RH * esWater(tC + K), vAir: v, qDir: 0, fWater: 0, Tw: NaN, vWater: 0, fContact: 0, Tsurf: NaN, breathing: true, ...o };
}
const ex = (thermal: ThermalEnv | undefined, o: Partial<Exposure> = {}): Exposure => ({ thermal, qFire: thermal?.qDir, p: 101325, xO2: 0.2095, xCO2: 0.0004, xCO: 0, lying: false, physical: { incapacitated: false, mobility: 'mobile' }, airwaySubmerged: false, ...o });
function run(c: PhysioConfig, e: Exposure | ((t: number) => Exposure), seconds: number, dt = 0.1) {
  const s = createPhysioState(c);
  primePhysiology(s, c, typeof e === 'function' ? e(0) : e);
  const n = Math.round(seconds / dt);
  for (let i = 1; i <= n; i++) stepPhysiology(s, c, typeof e === 'function' ? e(i * dt) : e, dt, i * dt);
  return s;
}

describe('integrator and heat balance (§59)', () => {
  it('lumped cooling C dT/dt = −hA(T − T_a): Heun matches T_a + (T₀ − T_a) e^(−hAt/C), error falls ≈ 4× per halved step', () => {
    const C = 2.4e4, hA = 400, Ta = 10, T0 = 34, T = 300;
    const exact = Ta + (T0 - Ta) * Math.exp((-hA * T) / C);
    const err = (dt: number) => {
      let y: [number, number] = [T0, 0];
      for (let i = 0; i < Math.round(T / dt); i++) y = heun(y, (v) => ({ d: [(-hA * (v[0] - Ta)) / C, 0] as const, f: 0 }), dt).y;
      return Math.abs(y[0] - exact);
    };
    expect(err(1)).toBeLessThan(1e-3);
    const r = err(2) / err(1);
    expect(r).toBeGreaterThan(3.5);
    expect(r).toBeLessThan(4.5);
  });

  it('constant heat input Q: ΔT = Q t / C exactly', () => {
    const C = 2.2e5, Q = 100, T = 3600;
    let y: [number, number] = [37, 0];
    for (let i = 0; i < T; i++) y = heun(y, () => ({ d: [Q / C, 0] as const, f: 0 }), 1).y;
    expect(y[0] - 37).toBeCloseTo((Q * T) / C, 10);
  });

  it('two-node exchange alone conserves the energy: C_c ΔT_c + C_s ΔT_s = 0 (core–skin conductance only)', () => {
    const Cc = 0.9 * 70 * 3492, Cs = 0.1 * 70 * 3492, k = 5.28 * 1.8;
    let y: [number, number] = [37.5, 30];
    const U0 = Cc * y[0] + Cs * y[1];
    for (let i = 0; i < 60000; i++) y = heun(y, (v) => ({ d: [(-k * (v[0] - v[1])) / Cc, (k * (v[0] - v[1])) / Cs] as const, f: 0 }), 0.5).y;
    expect(Math.abs(Cc * y[0] + Cs * y[1] - U0) / U0).toBeLessThan(1e-12);
    // Equilibrium at the capacity-weighted mean.
    expect(y[0]).toBeCloseTo(U0 / (Cc + Cs), 4);
  });

  it('the full model: ΔU equals the integrated heat ledger to rounding over 2 h in the cold, in the heat and in water', () => {
    for (const e of [ex(air(-5, 0.6, 5)), ex(air(45, 0.5, 0.3)), ex(air(15, 0.7, 0.2, { fWater: 0.8, Tw: 12 + K, vWater: 0.3 }))]) {
      const s = run(cfg({ activity: 'moderate' }), e, 7200, 0.5);
      const L = s.ledger;
      const sum = L.metabolic - L.work - L.resSens - L.resLat - (L.conv + L.rad - L.absorbed) - L.water - L.contact - L.evap + L.cond;
      expect(Math.abs(energy(s) - s.U0 - sum)).toBeLessThan(1e-6 * Math.abs(L.metabolic));
      expect(Math.abs(L.residual)).toBeLessThan(1e-3);
    }
  });

  it('the clothing surface satisfies its balance with the exact εσ(T⁴ − T_r⁴) term (hand-written check)', () => {
    const { R, fcl } = clothingResistance('insulated', 0);
    const Ts = 305, Ta = 263, Tr = 250, hc = 8.6 * Math.pow(3, 0.53), q = 120;
    const Tcl = clothingSurface(Ts, Ta, Tr, hc, R, fcl, 0.73, q);
    const lhs = (Ts - Tcl) / R + q;
    const rhs = fcl * (hc * (Tcl - Ta) + 0.95 * SIG * 0.73 * (Tcl ** 4 - Tr ** 4));
    expect(Math.abs(lhs - rhs)).toBeLessThan(1e-6);
    expect(Tcl).toBeGreaterThan(Ta);
    expect(Tcl).toBeLessThan(Ts);
  });

  it('DuBois area of a 70 kg, 1.75 m adult ≈ 1.85 m² (published 1.85)', () => {
    expect(duBois(70, 1.75)).toBeCloseTo(1.85, 2);
  });
});

describe('thermoregulation (§16–17, §59)', () => {
  it('thermoneutral room (24 °C, 50 %, still air, normal clothing, resting): core stays 36.8 ± 0.3 °C for 2 h, skin 32.5–35 °C, no strain', () => {
    const s = run(cfg(), ex(air(24, 0.5)), 7200);
    expect(Math.abs(s.Tc - K - 36.8)).toBeLessThan(0.3);
    expect(s.Ts - K).toBeGreaterThan(32.5);
    expect(s.Ts - K).toBeLessThan(35);
    expect(s.thermalState).toBe('normal');
    expect(s.capacity).toBe('normal');
  });

  it('cold air: wind removes more heat than still air at the same temperature (forced convection), shivering raises the metabolism', () => {
    const still = run(cfg({ clothing: 'light' }), ex(air(0, 0.6, 0.1)), 3600);
    const windy = run(cfg({ clothing: 'light' }), ex(air(0, 0.6, 10)), 3600);
    expect(windy.Ts).toBeLessThan(still.Ts);
    expect(windy.ledger.conv).toBeGreaterThan(still.ledger.conv);
    expect(windy.ledger.shiver).toBeGreaterThan(0);
    expect(windy.Tc).toBeLessThan(still.Tc + 1e-9);
  });

  it('cold water (10 °C, immersed to the neck, light clothing): the skin approaches the water, the water removes more heat than 10 °C air (body insulation, not the 70× larger h, limits it), the core falls, shivering — and the cooling rate is the documented finding', () => {
    const w = run(cfg({ clothing: 'light' }), ex(air(10, 0.7, 0.1, { fWater: 0.9, Tw: 10 + K })), 3600);
    const a = run(cfg({ clothing: 'light' }), ex(air(10, 0.7, 0.1)), 3600);
    expect(w.Ts - K).toBeLessThan(16);
    expect(w.ledger.water).toBeGreaterThan(1.5 * Math.abs(a.ledger.conv + a.ledger.rad));
    expect(w.Ts).toBeLessThan(a.Ts - 8);
    expect(w.Tc).toBeLessThan(a.Tc);
    expect(w.ledger.shiver / 3600).toBeGreaterThan(50);
    // Finding (HUMAN_PHYSIOLOGY.md §validation): the Gagge minimum tissue conductance (5.28 W/m²K) with maximal shivering
    // and shivering (≈ 150 W mean) nearly balance the loss — core cooling ≈ 0.1–0.5 °C/h, below the 1–3 °C/h of lean subjects (Hayward 1975, Tipton)
    // and closer to well-insulated subjects; the model has no body-fat parameter.
    const drop = 36.8 - (w.Tc - K);
    expect(drop).toBeGreaterThan(0.05);
    expect(drop).toBeLessThan(1);
    expect(['coldStress', 'severeColdStress']).toContain(w.thermalState);
  });

  it('hot air: high humidity limits evaporative cooling — at 40 °C the core rises more at 80 % than at 20 % RH, sweat drips', () => {
    const dry = run(cfg({ activity: 'light', clothing: 'light' }), ex(air(40, 0.2, 0.5)), 3600);
    const humid = run(cfg({ activity: 'light', clothing: 'light' }), ex(air(40, 0.8, 0.5)), 3600);
    expect(humid.Tc).toBeGreaterThan(dry.Tc + 0.3);
    expect(humid.ledger.drip).toBeGreaterThan(dry.ledger.drip);
    expect(dry.ledger.evap).toBeGreaterThan(humid.ledger.evap);
  });

  it('evaporation: evaporated mass × L_v = evaporative heat; produced sweat = evaporated sweat + dripped; water lost = sweat + diffusion + respiration', () => {
    const s = run(cfg({ activity: 'moderate', clothing: 'light' }), ex(air(35, 0.4, 1)), 3600);
    const L = s.ledger;
    expect(L.evapMass * 2.43e6).toBeCloseTo(L.evap, 3);
    expect(s.waterLost).toBeCloseTo(L.evapMass + L.drip + L.resMass, 9);
    expect(L.sweat).toBeGreaterThan(0.2);
    // Evaporated sweat cannot exceed what was produced plus skin diffusion.
    expect(L.evapMass).toBeLessThanOrEqual(L.sweat + 0.1);
  });

  it('saturated air hotter than the skin (sauna, 45 °C, 100 %): no evaporative cooling, vapour condenses on the skin (heat in)', () => {
    const t = flows(37 + K, 35 + K, { mass: 70, area: 1.85, clothing: 'light', wet: 0, radShare: 0.73, setShift: 0, sweatFactor: 1 }, air(45, 1, 0.2), { Mact: 70 });
    expect(t.evap).toBe(0);
    expect(t.cond).toBeGreaterThan(0);
    expect(t.drip).toBeCloseTo(t.sweat, 12);
  });

  it('directed radiation (fire, 5 kW/m²) heats more than the same air without it; the absorbed power is α q A_p of the exposed area', () => {
    const b = { mass: 70, area: 1.85, clothing: 'normal' as const, wet: 0, radShare: 0.73, setShift: 0, sweatFactor: 1 };
    const f = flows(37 + K, 34 + K, b, air(25, 0.4, 0.2, { qDir: 5000 }), { Mact: 70 });
    expect(f.absorbed).toBeCloseTo(0.8 * 5000 * 0.25 * 1.85, 6);
    const s0 = run(cfg(), ex(air(25, 0.4, 0.2)), 600);
    const s1 = run(cfg(), ex(air(25, 0.4, 0.2, { qDir: 5000 })), 600);
    expect(s1.Ts).toBeGreaterThan(s0.Ts + 0.5);
    expect(s1.dose.radiant).toBeCloseTo(600 * Math.pow(5, 4 / 3), 3);
  });

  it('cool room (15 °C, still, normal clothing, resting, 1 h): the skin cools — the state is named cold stress, never heat stress, while the core stays ≈ 36.8 °C', () => {
    const s = run(cfg(), ex(air(15, 0.5)), 3600);
    expect(['normal', 'coldStress']).toContain(s.thermalState);
    expect(Math.abs(s.Tc - K - 36.8)).toBeLessThan(0.3);
  });

  it('strain scale: heat 38 / 39 / 40 / 41 °C and cold 36 / 35 / 32 / 30 °C map to the same level bounds', () => {
    expect(thermalStrain(38)).toBeCloseTo(1.2, 9);
    expect(thermalStrain(41)).toBeCloseTo(4.2, 9);
    expect(thermalStrain(36)).toBeCloseTo(1.2, 9);
    expect(thermalStrain(35)).toBeCloseTo(2.2, 9);
    expect(thermalStrain(32)).toBeCloseTo(3.2, 9);
    expect(thermalStrain(30)).toBeCloseTo(4.2, 9);
    expect(skinColdStrain(30)).toBeCloseTo(1.2, 9);
    expect(skinColdStrain(25)).toBeCloseTo(2.2, 9);
    expect(skinColdStrain(10)).toBeCloseTo(2.2, 9);
  });
});

describe('respiration and gases (§20–27, §60)', () => {
  it('inspired / alveolar O₂ (hand calculation): sea level P_IO₂ = 0.2095 (101 325 − 6 270) Pa, P_AO₂ = P_IO₂ − 5 330 / 0.85', () => {
    const PIO2 = 0.2095 * (101325 - 6270);
    expect(alveolarO2(0.2095, 0, 101325)).toBeCloseTo(PIO2 - 5330 / 0.85, 6);
    // 5 500 m (≈ 50.5 kPa): roughly half the sea-level inspired O₂ → equivalent ≈ 10 % O₂.
    expect(equivalentO2Percent(0.2095, 50500)).toBeCloseTo((100 * 0.2095 * (50500 - 6270)) / (101325 - 6270), 9);
    expect(equivalentO2Percent(0.2095, 50500)).toBeGreaterThan(9);
    expect(equivalentO2Percent(0.2095, 50500)).toBeLessThan(10.5);
  });

  it('altitude 5 500 m (50.5 kPa): hypoxic hyperventilation lowers P_ACO₂ (fit 0.17 Pa/Pa, floor 2.5 kPa) — P_AO₂ by hand ≈ 5.2 kPa, near reported 5–6 kPa', () => {
    const PIO2 = 0.2095 * (50500 - 6270), PIO2s = 0.2095 * (101325 - 6270);
    const paco2 = Math.max(2500, 5330 - 0.17 * (PIO2s - PIO2));
    const PAO2 = PIO2 - paco2 / 0.85;
    expect(alveolarO2(0.2095, 0, 50500)).toBeCloseTo(PAO2, 6);
    expect(PAO2).toBeGreaterThan(4500);
    expect(PAO2).toBeLessThan(6000);
  });

  it('unit conversion: 1 ppm CO at 25 °C, 1 atm = 1.145 mg/m³ (published conversion)', () => {
    expect(toMgM3(1e-6, 0.02801, 101325, 298.15)).toBeCloseTo(1.145, 3);
  });

  it('CO FED: 1 000 ppm for 35 min = 1 (ISO 13571 reference dose); 5 % CO₂ multiplies the CO uptake by e', () => {
    const s = run(cfg(), ex(air(20, 0.5), { xCO: 1000e-6, xCO2: 0 }), 35 * 60, 1);
    expect(s.fed.co).toBeCloseTo(1, 6);
    expect(s.dose.co).toBeCloseTo(1000 * 35 * 60, 3);
    expect(fedRates({ xCO: 1000e-6, xCO2: 0.05 }).co / fedRates({ xCO: 1000e-6, xCO2: 0 }).co).toBeCloseTo(Math.E, 9);
  });

  it('O₂ FED at 12 % O₂: t = exp(8.13 − 0.54 · 8.9) = 27.8 min (Purser, hand calculation); reduced pressure gives the same as its equivalent O₂', () => {
    const t = Math.exp(8.13 - 0.54 * (20.9 - 12));
    expect(t).toBeCloseTo(27.8, 1);
    const xAtSea = (12 / 100) * ((101325 - 6270) / (101325 - 6270));
    expect(fedRates({ xO2: xAtSea, p: 101325 }).o2 * 60 * t).toBeCloseTo(1, 6);
    const pLow = 6270 + ((101325 - 6270) * 12) / 20.95;
    expect(fedRates({ xO2: 0.2095, p: pLow }).o2).toBeCloseTo(fedRates({ xO2: 0.12, p: 101325 }).o2, 3);
  });

  it('time-varying exposure: a linear ramp C = k t integrates exactly (trapezoid); stopping the exposure stops the dose; FED does not recover', () => {
    const k = 2e-6; // mol/mol per s
    const s = run(cfg(), (t) => ex(air(20, 0.5), { xCO: t <= 600 ? k * t : 0 }), 900, 1);
    // ∫₀⁶⁰⁰ k t dt in ppm·s, plus the last ramp-down step (trapezoid of the jump between t = 600 and 601: a sampled step).
    const exact = (k * 1e6 * 600 * 600) / 2 + 0.5 * k * 1e6 * 600;
    expect(s.dose.co).toBeCloseTo(exact, 6);
    const fedAt = s.fed.co;
    const s2 = run(cfg(), (t) => ex(air(20, 0.5), { xCO: t <= 600 ? k * t : 0 }), 1800, 1);
    expect(s2.fed.co).toBeCloseTo(fedAt, 12);
  });

  it('oxygen consumed = M t / 20.2 kJ·L⁻¹ (STPD) and CO₂ produced = RQ × O₂ (hand calculation)', () => {
    const s = run(cfg({ modules: { ...MODS, thermal: false } }), ex(undefined), 600, 1);
    const A = duBois(70, 1.75);
    const M = 1.2 * 58.15 * A;
    const molPerL = 101325 / (8.314462618 * 273.15) / 1000;
    expect(s.ledger.o2).toBeCloseTo(((M * 600) / 20200) * molPerL, 9);
    expect(s.ledger.co2 / s.ledger.o2).toBeCloseTo(0.85, 12);
  });

  it('missing gas data is not invented: no O₂ supply index and no gas FED without a composition', () => {
    const s = run(cfg(), ex(air(20, 0.5), { xO2: undefined, xCO2: undefined, xCO: undefined, p: undefined }), 60, 1);
    expect(s.resp.supply).toBeNull();
    expect(s.fed.co + s.fed.o2 + s.fed.co2).toBe(0);
  });

  it('smoke: dose ∫C dt and inhaled mass ∫C V̇_E dt (V̇_E = 25 L/L × V̇O₂) are separate quantities', () => {
    const C = 100e-6; // 100 mg/m³
    const s = run(cfg({ modules: { ...MODS, thermal: false } }), ex(undefined, { smoke: C }), 600, 1);
    expect(s.dose.smoke).toBeCloseTo(C * 600, 12);
    const A = duBois(70, 1.75), M = 1.2 * 58.15 * A;
    const VE = (M / 20200) * 60 * 25; // L/min
    expect(s.dose.smokeInhaled).toBeCloseTo(C * (VE / 60 / 1000) * 600, 12);
    expect(s.dose.smokeDeposited).toBeCloseTo(0.3 * s.dose.smokeInhaled, 12);
  });
});

describe('airway submersion, water, fatigue, capacity (§28–34, §47)', () => {
  it('airway history: first time, cumulative / continuous / longest, returns; intermittent vs continuous; head-under ≠ airway-under is decided by the sampler', () => {
    // 0–20 s clear, 20–30 s under, 30–40 s alternate 1 s, 40–100 s clear, 100–130 s under.
    const sub = (t: number) => (t > 20 && t <= 30) || (t > 30 && t <= 40 && Math.floor(t) % 2 === 0) || (t > 100 && t <= 130);
    const c = cfg({ modules: { ...MODS, thermal: false } });
    const s = createPhysioState(c);
    const seen = new Set<string>();
    for (let i = 1; i <= 1300; i++) {
      const t = i * 0.1;
      stepPhysiology(s, c, ex(undefined, { airwaySubmerged: sub(t) }), 0.1, t);
      seen.add(s.airway.state);
      if (Math.abs(t - 35) < 1e-9) expect(s.airway.state).toBe('intermittent');
      if (Math.abs(t - 60) < 1e-9) expect(s.airway.state).toBe('clear');
      if (Math.abs(t - 120) < 1e-9) expect(s.airway.state).toBe('submerged');
    }
    expect(s.airway.first).toBeCloseTo(20.1, 6);
    expect(s.airway.longest).toBeCloseTo(30, 6);
    expect(s.airway.cumulative).toBeCloseTo(10 + 5 + 30, 1);
    expect(s.airway.submersions).toBe(1 + 5 + 1);
    expect([...seen].sort()).toEqual(['clear', 'intermittent', 'submerged']);
    // While under: no ventilation, O₂ taken from body stores (debt), no inhaled dose.
    expect(s.resp.breathing).toBe(false);
    expect(s.ledger.o2Debt).toBeGreaterThan(0);
  });

  it('breath-hold reserve: used while under (twice as fast below 15 °C water), recovers when breathing; drives the respiratory level', () => {
    const c = cfg({ modules: { ...MODS, thermal: false } });
    const warm = run(c, ex(undefined, { airwaySubmerged: true, waterT: 25 + K }), 30, 0.1);
    const cold = run(c, ex(undefined, { airwaySubmerged: true, waterT: 8 + K }), 30, 0.1);
    expect(warm.airway.hold).toBeCloseTo(30 / 60, 6);
    expect(cold.airway.hold).toBeCloseTo(30 / 30, 6);
    expect(['severelyImpaired', 'unableToAct']).toContain(cold.levels.respiratory);
    const rec = run(c, (t) => ex(undefined, { airwaySubmerged: t <= 30, waterT: 8 + K }), 300, 0.1);
    expect(rec.airway.hold).toBeLessThan(0.01);
    expect(rec.levels.respiratory).toBe('normal');
  });

  it('a 3 s dip under water is not "unable to act": the breath-hold reserve (not the absent breath) drives the respiratory level', () => {
    const c = cfg({ modules: { ...MODS, thermal: false } });
    const s = run(c, (t) => ex(undefined, { airwaySubmerged: t > 10 && t <= 13, waterT: 20 + K }), 20, 0.1);
    expect(['normal', 'stressed']).toContain(s.levels.respiratory);
    expect(s.resp.supply).toBeCloseTo(1, 2);
  });

  it('body water: no intake unless given explicitly; an explicit intake offsets the deficit; deficit raises the core set point', () => {
    const e = ex(air(38, 0.3, 0.5));
    const noDrink = run(cfg({ activity: 'moderate', clothing: 'light' }), e, 7200, 0.5);
    const drink = run(cfg({ activity: 'moderate', clothing: 'light', intake: 0.8 / 3600 }), e, 7200, 0.5);
    expect(noDrink.waterIntake).toBe(0);
    expect(drink.waterIntake).toBeCloseTo(1.6, 6);
    expect(deficitPercent(noDrink, 70)).toBeGreaterThan(deficitPercent(drink, 70) + 2);
    expect(noDrink.Tc).toBeGreaterThan(drink.Tc);
  });

  it('fatigue grows with intensity, not with time alone; recovers at rest', () => {
    const rest = run(cfg(), ex(air(20, 0.5)), 3600);
    expect(rest.fatigue).toBe(0);
    const hard = run(cfg({ activity: 'strenuous', clothing: 'light' }), ex(air(15, 0.5, 2)), 1200);
    expect(hard.fatigue).toBeGreaterThan(0.1);
    const c = cfg({ activity: 'strenuous', clothing: 'light' });
    const s = createPhysioState(c);
    for (let i = 1; i <= 12000; i++) stepPhysiology(s, i <= 6000 ? c : { ...c, activity: 'resting' }, ex(air(15, 0.5, 2)), 0.1, i * 0.1);
    expect(s.fatigue).toBeLessThan(hard.fatigue);
  });

  it('hysteresis: a core temperature hovering at a level bound does not flip the level every step', () => {
    const c = cfg({ modules: { ...MODS, thermal: false } });
    const s = createPhysioState(c);
    let flips = 0, prev = s.levels.thermal;
    for (let i = 1; i <= 600; i++) {
      s.Tc = 38 + K + (i % 2 ? 0.05 : -0.05);
      stepPhysiology(s, { ...c, modules: { ...MODS } }, ex(air(24, 0.5)), 0.1, i * 0.1);
      s.Tc = 38 + K + (i % 2 ? 0.05 : -0.05);
      if (s.levels.thermal !== prev) flips++;
      prev = s.levels.thermal;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('capacity: physical and physiological limits are recorded separately; the combined level is the worse one with its causes', () => {
    const c = cfg({ modules: { ...MODS, thermal: false } });
    const s = run(c, ex(undefined, { physical: { incapacitated: false, mobility: 'immobile' } }), 1, 0.1);
    expect(s.capacity).toBe('normal');
    expect(s.combined).toBe('severelyImpaired');
    expect(s.combinedCauses).toEqual(['physical']);
    const g = run(c, ex(undefined, { xCO: 3000e-6 }), 35 * 60, 1);
    expect(g.levels.gas).toBe('unableToAct');
    expect(g.limiting).toEqual(['gas']);
  });
});

describe('time-step convergence (§63)', () => {
  it('cold water, 10 min: core / skin at dt = 1/60, 1/120, 1/240 s converge to a 1/960 s reference; the time core reaches heat stress (45 °C, 80 %, strenuous) agrees within 0.05 s', { timeout: 600_000 }, () => {
    const e = ex(air(5, 0.7, 2, { fWater: 0.9, Tw: 8 + K, vWater: 0.5 }));
    const c = cfg({ clothing: 'light' });
    const ref = run(c, e, 600, 1 / 960);
    const errs = [60, 120, 240].map((n) => {
      const s = run(c, e, 600, 1 / n);
      return Math.abs(s.Ts - ref.Ts) + Math.abs(s.Tc - ref.Tc);
    });
    expect(errs[0]).toBeLessThan(1e-4);
    expect(errs[1]).toBeLessThan(errs[0]);
    expect(errs[2]).toBeLessThan(errs[1]);
    const hot = ex(air(45, 0.8, 0.3));
    const hc = cfg({ activity: 'strenuous', clothing: 'light' });
    const changeAt = (dt: number) => {
      const s = createPhysioState(hc);
      primePhysiology(s, hc, hot);
      for (let i = 1; i <= Math.round(1800 / dt); i++) {
        stepPhysiology(s, hc, hot, dt, i * dt);
        if (s.thermalState === 'heatStress') return i * dt;
      }
      return Infinity;
    };
    const t60 = changeAt(1 / 60), t240 = changeAt(1 / 240);
    expect(Number.isFinite(t60)).toBe(true);
    expect(Math.abs(t60 - t240)).toBeLessThan(0.05);
  });
});

export { P };
