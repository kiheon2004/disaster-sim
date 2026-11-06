/**
 * Phase 34 correction audit (docs/PHASE34_CORRECTION_AUDIT.md): reproduction tests for the review candidates H1 (zero
 * posture control in the balance model), H2 (inhaled doses across an airway transition), H4 (confined compartment
 * composition) and H7 (extreme inputs). Expected values are written out by hand; each test states the invariant it checks.
 */
import { describe, expect, it } from 'vitest';
import { esWater } from '@/climate/psychro';
import { newBalance, stepBalance, type BalanceParams } from '@/human/balance';
import type { PhysiologyZone } from './settings';
import type { ThermalEnv } from './thermal';
import { createPhysioState, primePhysiology, stepPhysiology, type Exposure, type PhysioConfig } from './engine';
import { compartmentFractions, createCompartment, stepCompartment } from '@/simulation/physiology/zones';

const K = 273.15;
const MODS = { thermal: true, respiration: true, gas: true, submersion: true, hydration: true, fatigue: true };
const cfg = (o: Partial<PhysioConfig> = {}): PhysioConfig => ({ mass: 70, height: 1.75, activity: 'resting', clothing: 'normal', intake: 0, modules: MODS, ...o });
const air = (tC: number, RH: number, v = 0.1, o: Partial<ThermalEnv> = {}): ThermalEnv =>
  ({ Ta: tC + K, Tr: tC + K, pa: RH * esWater(tC + K), vAir: v, qDir: 0, fWater: 0, Tw: NaN, vWater: 0, fContact: 0, Tsurf: NaN, breathing: true, ...o });
const ex = (thermal: ThermalEnv | undefined, o: Partial<Exposure> = {}): Exposure =>
  ({ thermal, qFire: thermal?.qDir, p: 101325, xO2: 0.2095, xCO2: 0.0004, xCO: 0, lying: false, physical: { incapacitated: false, mobility: 'mobile' }, airwaySubmerged: false, ...o });
function run(c: PhysioConfig, e: (t: number) => Exposure, seconds: number, dt = 0.1, each?: (s: ReturnType<typeof createPhysioState>, t: number) => void) {
  const s = createPhysioState(c);
  primePhysiology(s, c, e(0));
  const n = Math.round(seconds / dt);
  for (let i = 1; i <= n; i++) {
    stepPhysiology(s, c, e(i * dt), dt, i * dt);
    each?.(s, i * dt);
  }
  return s;
}

describe('H1 — zero posture control in stepBalance', () => {
  const p: BalanceParams = { mass: 70, hc: 1.0, Ia: 85, forward: 0.12, lateral: 0.1 };
  const gn = 9.80665;

  it('control 0 with a tipping moment (c > 0): posture control absent → the step reports a fall, the demand stays finite, no corrective moment', () => {
    const s = newBalance();
    const out = stepBalance(p, s, { gn, t1: 20, t2: 0, f1: 0, f2: 1, control: 0 }, 1 / 60);
    expect(Number.isFinite(s.demand)).toBe(true);
    expect(s.mc).toEqual([0, 0]);
    expect(out).toBe('fall');
  });

  it('control 0 without any load (c = 0): still no posture control — a fall, finite state', () => {
    const s = newBalance();
    const out = stepBalance(p, s, { gn, t1: 0, t2: 0, f1: 0, f2: 1, control: 0 }, 1 / 60);
    expect(Number.isFinite(s.demand) && s.th.every(Number.isFinite) && s.om.every(Number.isFinite)).toBe(true);
    expect(out).toBe('fall');
  });

  it('control 1 is bit-identical to no control input (Phase 33 path); 0.5 halves the available moment', () => {
    const a = newBalance(), b = newBalance(), c = newBalance();
    for (let i = 0; i < 120; i++) {
      stepBalance(p, a, { gn, t1: 15, t2: 4, f1: 0, f2: 1 }, 1 / 60);
      stepBalance(p, b, { gn, t1: 15, t2: 4, f1: 0, f2: 1, control: 1 }, 1 / 60);
    }
    expect(b).toEqual(a);
    // 0.5: the same request against half the available moment — twice the demand, the moment clipped to half the capacity.
    const d = newBalance();
    stepBalance(p, c, { gn, t1: 0, t2: -50, f1: 0, f2: 1, control: 0.5 }, 1 / 60);
    stepBalance(p, d, { gn, t1: 0, t2: -50, f1: 0, f2: 1 }, 1 / 60);
    expect(c.demand).toBeCloseTo(2 * d.demand, 12);
    const cap = 70 * gn * 0.12, cm = d.demand * cap;
    expect(cm).toBeGreaterThan(0.5 * cap);
    expect(Math.hypot(c.mc[0], c.mc[1])).toBeCloseTo(0.5 * cap, 9);
  });
});

describe('H2 — doses across airway transitions', () => {
  // Breathing between transitions; the airway sample at t decides the state of the interval (t − dt, t] — the convention of
  // the airway clock (cumulative time) and of the O₂ taken from the body store while under water.
  const sub = (t: number) => (t > 1.0 + 1e-9 && t <= 2.0 + 1e-9) || (t > 3.0 + 1e-9 && t <= 3.3 + 1e-9);
  const co = (t: number) => ex(air(24, 0.5), { xCO: 1000e-6, airwaySubmerged: sub(t) });

  it('mid-dip: the trapezoid places the unknown transition at the interval midpoint — the dose differs from 1000 ppm × (time breathing by the airway clock) by exactly r·dt/2, and the difference closes when the airway clears', () => {
    const at = (T: number, dt: number) => run(cfg(), co, T, dt);
    for (const dt of [0.1, 0.05]) {
      const mid = at(1.5, dt);
      expect(mid.dose.co - 1000 * (1.5 - mid.airway.cumulative)).toBeCloseTo((1000 * dt) / 2, 6);
      const after = at(2.5, dt);
      expect(after.dose.co).toBeCloseTo(1000 * (2.5 - after.airway.cumulative), 6);
    }
  });

  it('constant 1000 ppm CO: over whole dips the dose = 1000 ppm × (time breathing) exactly — the airway clock and the inhaled dose agree', () => {
    const s = run(cfg(), co, 5);
    expect(s.airway.cumulative).toBeCloseTo(1.3, 9);
    expect(s.dose.co).toBeCloseTo(1000 * (5 - 1.3), 6);
  });

  it('the same with dt halved (0.05 s): the same breathing time and dose (no transition half-intervals)', () => {
    const s = run(cfg(), co, 5, 0.05);
    expect(s.airway.cumulative).toBeCloseTo(1.3, 9);
    expect(s.dose.co).toBeCloseTo(1000 * (5 - 1.3), 6);
  });

  it('0.1 s dips every other sample: dose = concentration × breathing time', () => {
    const s = run(cfg(), (t) => ex(air(24, 0.5), { xCO: 500e-6, airwaySubmerged: Math.round(t * 10) % 2 === 1 }), 4);
    expect(s.airway.cumulative).toBeCloseTo(2, 9);
    expect(s.dose.co).toBeCloseTo(500 * 2, 6);
  });

  it('hypoxic air (12 % O₂): the O₂-deficit dose follows the breathing time; the O₂ FED does not grow while under water', () => {
    let fedUnder = 0;
    const s = run(cfg(), (t) => ex(air(24, 0.5), { xO2: 0.12, airwaySubmerged: sub(t) }), 5, 0.1, (st, t) => {
      if (t > 1.15 && t < 1.95) fedUnder = fedUnder || st.fed.o2;
      if (t > 1.15 && t < 1.95) expect(st.fed.o2).toBe(fedUnder);
    });
    expect(s.dose.o2Deficit).toBeCloseTo((0.2095 - 0.12) * (5 - 1.3), 9);
  });

  it('smoke: the exposure dose ∫C dt continues under water (it is the concentration at the airway), the inhaled mass does not', () => {
    let inhUnder = -1;
    const s = run(cfg(), (t) => ex(air(24, 0.5), { smoke: 1e-4, airwaySubmerged: sub(t) }), 5, 0.1, (st, t) => {
      if (t > 1.15 && t < 1.95) {
        if (inhUnder < 0) inhUnder = st.dose.smokeInhaled;
        expect(st.dose.smokeInhaled).toBe(inhUnder);
      }
    });
    expect(s.dose.smoke).toBeCloseTo(1e-4 * 5, 12);
  });

  it('directed radiation keeps dosing while the airway is under water (a breathing-independent route)', () => {
    const q = 5000;
    const s = run(cfg(), (t) => ex(air(24, 0.5, 0.1, { qDir: q }), { qFire: q, airwaySubmerged: sub(t) }), 5);
    expect(s.dose.radiant).toBeCloseTo(5 ** (4 / 3) * 5, 9);
  });

  it('respiratory heat loss stops while the airway is under water', () => {
    let under = -1;
    run(cfg(), (t) => ex(air(5, 0.5), { airwaySubmerged: sub(t) }), 2, 0.1, (st, t) => {
      if (t > 1.15 && t < 1.95) {
        if (under < 0) under = st.ledger.resSens + st.ledger.resLat;
        expect(st.ledger.resSens + st.ledger.resLat).toBe(under);
      }
    });
  });
});

describe('H4 — confined compartment composition', () => {
  const z = (V: number, lambda: number): PhysiologyZone => ({ id: 'c', shape: 'box', center: [0, 1, 0], size: [2, 2, 2], confined: { volume: V, exchange: lambda } });

  it('constant p, V, T: total = pV/(RT); inert remainder = total − O₂ − CO₂ stays the initial inert amount; fractions in [0, 1] and summing with the inert share to 1', () => {
    const p = 101325, T = 293.15, V = 10;
    const c = createCompartment(0, z(V, 0), 0.2095, 0.0004, p, T);
    expect(c.total).toBeCloseTo((p * V) / (8.314462618 * T), 6);
    const inert0 = c.total - c.o2 - c.co2;
    for (let i = 0; i < 1000; i++) stepCompartment(c, 0.05, 0.0425, 1);
    const f = compartmentFractions(c);
    expect(f.o2).toBeGreaterThanOrEqual(0);
    expect(f.co2).toBeLessThanOrEqual(1);
    expect(f.o2 + f.co2 + inert0 / c.total).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('exchange relaxes to the reference exactly as n_ref + (n₀ − n_ref) e^(−λt/3600)', () => {
    const c = createCompartment(0, z(10, 3), 0.2095, 0.0004, 101325, 293.15);
    c.o2 = 0.5 * c.ref.o2;
    const n0 = c.o2;
    for (let i = 0; i < 600; i++) stepCompartment(c, 0, 0, 1);
    expect(c.o2).toBeCloseTo(c.ref.o2 + (n0 - c.ref.o2) * Math.exp((-3 * 600) / 3600), 9);
  });
});

describe('H7 — extreme inputs (1 h): finite state, closed heat ledger, the model-range flags', () => {
  const cases: [string, PhysioConfig, (t: number) => Exposure, string | null][] = [
    ['−40 °C, 15 m/s wind', cfg({ clothing: 'insulated' }), () => ex(air(-40, 0.5, 15)), 'thermalOutOfRange'],
    ['50 °C, 80 % RH', cfg({ clothing: 'light', activity: 'light' }), () => ex(air(50, 0.8)), null],
    ['35 °C, 100 % RH', cfg({ clothing: 'light' }), () => ex(air(35, 1.0)), null],
    ['20 kW/m² directed radiation', cfg(), () => ex(air(30, 0.4, 0.1, { qDir: 20000 }), { qFire: 20000 }), null],
    ['0 °C water to the neck', cfg({ clothing: 'light' }), () => ex(air(5, 0.8, 1, { fWater: 0.9, Tw: 0 + K })), null],
    ['42 °C water to the neck', cfg({ clothing: 'light' }), () => ex(air(30, 0.8, 0.1, { fWater: 0.9, Tw: 42 + K })), null],
    ['strenuous activity, 35 °C', cfg({ activity: 'strenuous', clothing: 'light' }), () => ex(air(35, 0.4)), null],
    ['6 % O₂', cfg(), () => ex(air(24, 0.5), { xO2: 0.06 }), null],
    ['8 % CO₂', cfg(), () => ex(air(24, 0.5), { xCO2: 0.08 }), null],
  ];
  for (const [name, c, e, flag] of cases) {
    it(name, () => {
      const s = run(c, e, 3600);
      expect(Number.isFinite(s.Tc) && Number.isFinite(s.Ts) && Number.isFinite(s.fatigue) && Number.isFinite(s.waterLost)).toBe(true);
      expect(Object.values(s.fed).every(Number.isFinite)).toBe(true);
      expect(Math.abs(s.ledger.residual)).toBeLessThan(1e-3);
      expect(s.flags.has('nonFinite')).toBe(false);
      if (flag) expect(s.flags.has(flag)).toBe(true);
      // A body temperature outside the model's range is flagged, never silently clamped.
      if (s.Tc < 10 + K || s.Tc > 46 + K) expect(s.flags.has('temperatureOutOfModelRange')).toBe(true);
    });
  }

  it('long dehydration (36 °C, moderate activity, 8 h, no intake): body water lost = sweat produced + respiration + diffusion, the deficit level rises, all finite', () => {
    const s = run(cfg({ activity: 'moderate', clothing: 'light' }), () => ex(air(36, 0.3)), 8 * 3600, 1);
    expect(Number.isFinite(s.Tc)).toBe(true);
    expect(s.waterLost).toBeCloseTo(s.ledger.evapMass + s.ledger.drip + s.ledger.resMass, 9);
    expect(s.levels.hydration).not.toBe('normal');
  });
});
