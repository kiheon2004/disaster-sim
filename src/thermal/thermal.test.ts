/**
 * Phase 26 thermal engine (pure): units, material data, heat capacity, conduction against the
 * semi-infinite solid, convection / radiation laws, exact profile integrals, solver stability and the
 * energy ledger.
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { SIGMA, toC, toK } from './units';
import { concreteKc, enthalpy, rebarKs, steelKE, steelKy, temperatureOf, THERMAL_MATERIALS, timberKc, TM, specificHeat } from './materials';
import { hForcedPlate, hGround, hNaturalVertical, mixed } from './convection';
import { pointFraction, projectedArea, radiativeFlux } from './radiation';
import { shapeIntegral, shapeTotal, profileIssues, type ProfileSpec } from './profiles';
import { intervalEnergy, totalEnergy } from './sources';
import { heatSourceIssues, type HeatSourceSpec } from './types';
import { ThermalWorld, TK, defaultThermalSettings, type SourceStep } from './ThermalWorld';
import { BK, type BodyInit } from './ThermalBodies';
import { beamAxialCapacity, columnFactor, restrainedForce, restraintDegree, sectionFactors, thermalStrain } from './structural';

const Tref = 288.15;
const settings = { ...defaultThermalSettings(), ambient: Tref };

function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

export function body(over: Partial<BodyInit> = {}): BodyInit {
  return {
    kind: BK.entity, mSkin: 100, mCore: 0, matSkin: TM.steel, matCore: TM.steel, Av: 4, Atop: 1, Abot: 1, Lv: 2, Lh: 0.25, Lf: 1,
    tSkin: 0.01, Asc: 0, Lsc: 1, fOut: 1, fC1: 0, fC2: 0, comp1: -1, comp2: -1, sx: 1, sy: 2, sz: 1, x: 0, y: 1, z: 0, yg: 0, ref: 0, sub: 0, ...over,
  };
}

const world = (opts: ConstructorParameters<typeof ThermalWorld>[3] = {}, size = 40) => new ThermalWorld(createFlatTerrain(size), settings, 1.225, opts);

describe('units and material data', () => {
  it('converts K ↔ °C and uses the exact Stefan–Boltzmann constant', () => {
    expect(toC(273.15)).toBe(0);
    expect(toK(100)).toBeCloseTo(373.15, 12);
    expect(SIGMA).toBe(5.670374419e-8);
  });

  it('round-trips energy ↔ temperature for every material (temperature-dependent c included)', () => {
    for (let i = 0; i < THERMAL_MATERIALS.length; i++) {
      for (const T of [250, 288.15, 373.15, 380, 1008.15, 1500]) {
        expect(temperatureOf(i, enthalpy(i, T))).toBeCloseTo(T, 6);
      }
    }
  });

  it('takes the code relations as published (EN 1993-1-2 / 1992-1-2 / 1995-1-2)', () => {
    expect(steelKy(400)).toBe(1);
    expect(steelKy(500)).toBeCloseTo(0.78, 12);
    expect(steelKy(550)).toBeCloseTo(0.625, 12);
    expect(steelKE(600)).toBeCloseTo(0.31, 12);
    expect(concreteKc(500)).toBeCloseTo(0.6, 12);
    expect(rebarKs(600)).toBeCloseTo(0.47, 12);
    expect(timberKc(100)).toBeCloseTo(0.25, 12);
    expect(timberKc(300)).toBe(0);
    // Steel's specific heat peaks at ~5000 J/(kg·K) around 735 °C (austenite transformation).
    expect(specificHeat(TM.steel, toK(735))).toBeGreaterThan(3000);
    expect(specificHeat(TM.steel, toK(20))).toBeCloseTo(440, -1);
    // Concrete λ upper limit at 20 °C ≈ 1.95 W/(m·K); free strain ≈ 0 at 20 °C.
    expect(THERMAL_MATERIALS[TM.concrete].k(20)).toBeCloseTo(1.955, 2);
    expect(THERMAL_MATERIALS[TM.steel].strain(20)).toBeCloseTo(0, 9);
  });
});

describe('heat capacity: Q = m·c·ΔT', () => {
  it('a body absorbing Q warms by Q/(m·c), heavier and higher-c bodies more slowly', () => {
    const w = world({ closed: true });
    const soil = THERMAL_MATERIALS[TM.soil];
    const a = w.bodies.add(body({ mSkin: 100, matSkin: TM.soil, fOut: 0 }));
    const b = w.bodies.add(body({ mSkin: 400, matSkin: TM.soil, fOut: 0 }));
    const c = w.bodies.add(body({ mSkin: 100, matSkin: TM.sand, fOut: 0 }));
    for (const i of [a, b, c]) w.deposit(TK.body, i, 1e6);
    expect(w.bodies.TS[a] - Tref).toBeCloseTo(1e6 / (100 * soil.constantC!), 9);
    expect(w.bodies.TS[b] - Tref).toBeCloseTo((w.bodies.TS[a] - Tref) / 4, 9);
    expect(w.bodies.TS[c]).toBeGreaterThan(w.bodies.TS[a]); // sand c 800 < soil c 1840
  });

  it('temperature-dependent c: the energy to heat steel 20 → 800 °C is ∫c dT, not c₂₀·ΔT', () => {
    const w = world({ closed: true });
    const i = w.bodies.add(body({ mSkin: 1, fOut: 0, matSkin: TM.steel }));
    const E = w.bodies.energyAt(i, false, toK(800)) - w.bodies.energyAt(i, false, toK(20));
    expect(E).toBeGreaterThan(1.3 * 440 * 780); // the 735 °C peak and the rise of c
    w.deposit(TK.body, i, w.bodies.energyAt(i, false, toK(800)));
    expect(w.bodies.TS[i]).toBeCloseTo(toK(800), 6);
  });
});

describe('conduction', () => {
  it('heat flows from hot to cold and a closed world conserves energy', () => {
    const w = world({ closed: true, insulatedGround: true });
    const g = w.terrain;
    const c = g.index(5.5 - 20, 5.5 - 20);
    w.deposit(TK.ground, c, 5e6);
    w.ledger.initial = 5e6; // deposited outside a source: the initial state of this test
    const E0 = w.internalEnergy();
    for (let k = 0; k < 600; k++) w.step(1);
    expect(g.T(c, 1)).toBeGreaterThan(Tref); // down the column
    expect(g.T(c + 1, 0)).toBeGreaterThan(Tref); // sideways
    expect(g.T(c, 0)).toBeLessThan(Tref + 5e6 / g.C[c * g.nl]);
    expect(Math.abs(w.internalEnergy() - E0) / E0).toBeLessThan(1e-12);
    expect(Math.abs(w.ledger.residual()) / 5e6).toBeLessThan(1e-9);
  });

  it('matches the semi-infinite solid under a constant surface flux and converges with finer layers', () => {
    const q = 2000; // W/m²
    const t = 3600;
    const run = (layers: readonly number[], dt: number) => {
      const w = world({ closed: true, insulatedGround: true, layers });
      const g = w.terrain;
      const cells: number[] = [];
      for (let iz = 0; iz < 10; iz++) for (let ix = 0; ix < 10; ix++) cells.push(iz * g.nx + ix);
      const src: SourceStep = { id: 'q', energy: q * g.area * cells.length * dt, deposits: cells.map((c) => ({ kind: TK.ground, index: c, w: 1 / cells.length })) };
      for (let k = 0; k < Math.round(t / dt); k++) w.step(dt, [src]);
      const c = 5 * g.nx + 5;
      return { T: g.T(c, 0) - Tref, z: layers[0] / 2, w };
    };
    const soil = THERMAL_MATERIALS[TM.soil];
    const k = soil.k(20), a = k / (soil.density * soil.constantC!);
    const exact = (z: number) => ((2 * q) / k) * (Math.sqrt((a * t) / Math.PI) * Math.exp((-z * z) / (4 * a * t)) - (z / 2) * erfc(z / (2 * Math.sqrt(a * t))));
    const coarse = run([0.02, 0.06, 0.18, 0.54], 1);
    const fine = run([0.004, 0.008, 0.016, 0.032, 0.064, 0.128, 0.256, 0.5], 0.5);
    // The node is the mean of its layer: compare with the exact mean over [0, d₀].
    const layerMean = (d: number) => { let s = 0; for (let k = 0; k < 200; k++) s += exact(((k + 0.5) / 200) * d); return s / 200; };
    const eC = Math.abs(coarse.T - layerMean(2 * coarse.z)) / layerMean(2 * coarse.z);
    const eF = Math.abs(fine.T - layerMean(2 * fine.z)) / layerMean(2 * fine.z);
    if (process.env.THERMAL_LOG) console.log("semi-infinite error coarse / fine", eC, eF);
    expect(eC).toBeLessThan(0.15);
    expect(eF).toBeLessThan(0.05);
    expect(eF).toBeLessThan(eC);
  });
});

describe('convection and radiation', () => {
  it('no net convection when surface and air have the same temperature; wind increases it', () => {
    expect(hNaturalVertical(300, 300, 2)).toBe(0);
    expect(hGround(300, 300, 0)).toBe(0);
    expect(hForcedPlate(320, 300, 5, 1)).toBeGreaterThan(hForcedPlate(320, 300, 2, 1));
    // Churchill–Chu, 1 m plate, ΔT 50 K: a few W/(m²·K).
    const h = hNaturalVertical(350, 300, 1);
    expect(h).toBeGreaterThan(3);
    expect(h).toBeLessThan(7);
    expect(mixed(3, 4)).toBeCloseTo(Math.cbrt(27 + 64), 12);
  });

  it('radiation uses absolute temperature to the fourth power', () => {
    expect(radiativeFlux(1, 1000, 0)).toBeCloseTo(SIGMA * 1e12, 6);
    expect(radiativeFlux(0.5, 1000, 0)).toBeCloseTo(radiativeFlux(1, 1000, 0) / 2, 6);
    // Doubling the absolute temperature multiplies the emission by 16.
    expect(radiativeFlux(1, 600, 0) / radiativeFlux(1, 300, 0)).toBeCloseTo(16, 9);
    expect(radiativeFlux(0.9, 300, 300)).toBe(0);
    expect(projectedArea(1, 2, 3, 1, 0, 0)).toBe(6);
    expect(pointFraction(1e9, 1)).toBeCloseTo(0.5, 12); // capped at a hemisphere
  });

  it('a hot body in still ambient air cools by convection + radiation and the ledger books both', () => {
    const w = world();
    const i = w.bodies.add(body({ mSkin: 50 }));
    w.placeBody(i, 0, 1, 0, 0);
    w.deposit(TK.body, i, w.bodies.energyAt(i, false, 700));
    const E0 = w.internalEnergy();
    for (let k = 0; k < 600; k++) w.step(0.1);
    expect(w.bodies.TS[i]).toBeLessThan(700);
    expect(w.ledger.lost.radiationSky).toBeGreaterThan(0);
    expect(w.ledger.transfers.convection).toBeGreaterThan(0);
    // Everything that left the body is in the air or lost to the surroundings.
    expect(Math.abs(w.internalEnergy() + w.ledger.totalLost() - E0) / E0).toBeLessThan(1e-9);
  });
});

describe('heat source timing', () => {
  const base: ProfileSpec = { profile: 'constant', duration: 10 };
  it('integrates each profile exactly over any interval', () => {
    expect(shapeIntegral(base, -5, 4)).toBe(4);
    expect(shapeIntegral({ profile: 'ramp', duration: 10, rampTime: 4 }, 0, 10)).toBeCloseTo(8, 12);
    expect(shapeIntegral({ profile: 'pulse', duration: 10, pulseWidth: 1, period: 3 }, 0, 10)).toBeCloseTo(4, 12);
    expect(shapeIntegral({ profile: 'schedule', duration: 10, schedule: [[1, 2], [5, 8]] }, 1.5, 6)).toBeCloseTo(1.5, 12);
    expect(shapeIntegral({ profile: 'instant', duration: 10 }, -0.1, 0.1)).toBe(1);
    expect(shapeIntegral({ profile: 'instant', duration: 10 }, 0.1, 1)).toBe(0);
    expect(shapeTotal({ profile: 'ramp', duration: 10, rampTime: 10 })).toBeCloseTo(5, 12);
  });

  it('delivers the same total whatever the step', () => {
    const s: HeatSourceSpec = { event: 'heatSource', kind: 'point', position: [0, 0], height: 1, radius: 1, input: 'energy', energy: 7.3e6, profile: 'pulse', duration: 13.7, pulseWidth: 0.9, period: 2.3 };
    for (const dt of [0.1, 0.37, 1.3, 5]) {
      let sum = 0;
      for (let t = 0; t < 20; t += dt) sum += intervalEnergy(s, t, t + dt);
      expect(sum).toBeCloseTo(7.3e6, 3);
    }
    expect(totalEnergy({ ...s, input: 'power', power: 1000, profile: 'constant' })).toBeCloseTo(13700, 6);
  });

  it('rejects physically impossible or inconsistent input with a reason', () => {
    const s: HeatSourceSpec = { event: 'heatSource', kind: 'point', position: [0, 0], height: 1, radius: 1, input: 'power', power: 1e5, profile: 'constant', duration: 60 };
    expect(heatSourceIssues(s)).toEqual([]);
    expect(heatSourceIssues({ ...s, power: -5 })).toContain('thermal.invalid.powerSign');
    expect(heatSourceIssues({ ...s, profile: 'instant' })).toContain('thermal.invalid.instantPower');
    expect(heatSourceIssues({ ...s, kind: 'temperature', temperature: -3 })).toContain('thermal.invalid.absoluteZero');
    expect(heatSourceIssues({ ...s, kind: 'temperature', temperature: 900, profile: 'instant' })).toContain('thermal.invalid.instantTemperature');
    expect(profileIssues({ profile: 'pulse', duration: 10, pulseWidth: 3, period: 2 })).toContain('thermal.invalid.pulseWidth');
    expect(profileIssues({ profile: 'schedule', duration: 10, schedule: [[5, 6], [1, 2]] })).toContain('thermal.invalid.schedule');
  });
});

describe('solver stability and the ledger', () => {
  it('splits a step that would be unstable and never overshoots the boundary temperature', () => {
    const w = world();
    const i = w.bodies.add(body({ mSkin: 0.02, Av: 0.5, Atop: 0, Abot: 0 }));
    const Ts = 1500;
    const src: SourceStep = { id: 'T', energy: 0, deposits: [], temperature: Ts, exchanges: [{ kind: TK.body, index: i, aRad: 0.5, aConv: 0.5, eps: 0.7, L: 0.5 }] };
    let peak = 0;
    for (let k = 0; k < 50; k++) {
      const info = w.step(0.5, [src]);
      peak = Math.max(peak, w.bodies.TS[i]);
      if (k === 0) expect(info.substeps).toBeGreaterThan(1);
    }
    expect(peak).toBeLessThanOrEqual(Ts + 1e-6);
    // It settles below T_s: it also loses heat to the ambient air and surroundings.
    expect(w.bodies.TS[i]).toBeGreaterThan(1100);
    expect(w.ledger.boundarySupply).toBeGreaterThan(0);
    expect(w.ledger.relativeResidual()).toBeLessThan(1e-9);
  });

  it('closes the energy balance of an open world with sources, air advection and venting', () => {
    const w = world({}, 60);
    w.u10 = 8;
    const i = w.bodies.add(body({ mSkin: 500, mCore: 2000, matSkin: TM.concrete, matCore: TM.concrete, tSkin: 0.05, Asc: 5, Lsc: 0.15 }));
    w.bodies.air[i] = w.air.index(0, 0, 1);
    const cells = [w.terrain.index(1, 1), w.terrain.index(2, 1)];
    const src: SourceStep = { id: 'p', energy: 5e5, deposits: [{ kind: TK.body, index: i, w: 0.3 }, { kind: TK.ground, index: cells[0], w: 0.2 }, { kind: TK.ground, index: cells[1], w: 0.2 }, { kind: TK.air, index: w.air.index(1, 1), w: 0.2 }] };
    for (let k = 0; k < 300; k++) w.step(0.1, [src]);
    expect(w.ledger.added).toBeCloseTo(300 * 5e5, 3);
    expect(w.ledger.lost.unresolvedRadiation).toBeCloseTo(0.1 * 300 * 5e5, 1);
    expect(w.ledger.lost.airAdvection + w.ledger.lost.atmosphere).toBeGreaterThan(0);
    expect(w.ledger.relativeResidual()).toBeLessThan(1e-10);
  });

  it('advects warm air downstream with the wind and books what leaves the world', () => {
    const w = world({ closed: false }, 60);
    const a = w.air.index(10 - 30, 0);
    w.air.E[a] = 1e7;
    const r = w.air.advect(10, 0, 3);
    expect(w.air.E[a]).toBeLessThan(1e7);
    expect(w.air.E[a + 1] + w.air.E[a + 2]).toBeGreaterThan(0);
    expect(w.air.E[a - 1]).toBe(0); // nothing upwind
    expect(w.air.energy() + r.out).toBeCloseTo(1e7, 3);
  });
});

describe('thermal effects on members', () => {
  it('distinguishes free and restrained expansion', () => {
    const eps = thermalStrain(TM.steel, toK(220), toK(20));
    expect(eps).toBeGreaterThan(2.3e-3);
    expect(restrainedForce(restraintDegree(0, 1e9), 210e9, 0.01, eps)).toBe(0);
    expect(restrainedForce(restraintDegree(Infinity, 1e9), 210e9, 0.01, eps)).toBeCloseTo(210e9 * 0.01 * eps, 3);
    expect(restraintDegree(1e9, 1e9)).toBe(0.5);
  });

  it('reduces section capacity with temperature, keeps concrete losses on cooling, recovers steel', () => {
    const hot = { Ts: toK(600), Tc: toK(600), TmaxS: toK(600), TmaxC: toK(600), wS: 1 };
    expect(sectionFactors(TM.steel, hot).axial).toBeCloseTo(0.47, 9);
    const cooled = { ...hot, Ts: toK(20), Tc: toK(20) };
    expect(sectionFactors(TM.steel, cooled).axial).toBe(1);
    expect(sectionFactors(TM.concrete, { ...cooled, wS: 0.5 }).axial).toBeCloseTo(0.45, 9);
    expect(sectionFactors(TM.masonry, hot).axial).toBe(1); // no adopted source → not reduced
    // Column: buckling governed → stiffness factor applies.
    const f = sectionFactors(TM.steel, { ...hot, Ts: toK(500), Tc: toK(500), TmaxS: toK(500), TmaxC: toK(500) });
    expect(columnFactor(f, 2e6, 1e6)).toBeCloseTo(0.6, 9);
    expect(columnFactor(f, 1e6, 2e6)).toBeCloseTo(0.78, 9);
    expect(beamAxialCapacity(355e6, 0.01, 210e9, 1e-5, 6, { axial: 1, bending: 1, stiffness: 1 })).toBeCloseTo(Math.PI ** 2 * 210e9 * 1e-5 / 36, 0);
  });
});
