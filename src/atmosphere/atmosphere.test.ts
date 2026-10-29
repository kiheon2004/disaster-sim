import { describe, expect, it } from 'vitest';
import { AtmosphereField, type FieldInit } from './AtmosphereField';
import { initPlan, planForcing } from './plan';
import { CP_AIR, G, KAPPA, R_AIR, boilingPoint, cunningham, density, isa, knudsen, layerMassPerArea, scaleHeight, soundSpeed } from './reference';
import { plannedShare, removalShare } from './schedule';
import { atmosphereIssues, atmosphereWarnings, defaultAtmosphereSpec, type AtmosphereSpec } from './types';

let Tl0: (f: AtmosphereField) => number = () => 0;
const flat = (n = 20) => new Float64Array(n * n);
const mk = (o: Partial<FieldInit> = {}, n = 20): AtmosphereField =>
  new AtmosphereField({ originX: -50, originZ: -50, nx: n, nz: n, dx: 5, H: 10, ground: flat(n), p0: 101325, T0: 288.15, boundary: 'closed', thermo: 'adiabatic', ...o });

/** Minimal stand-in for the thermal layer: absolute temperature per column, updated like the adapter does. */
function run(f: AtmosphereField, spec: AtmosphereSpec, T: number, dt: number, Tl = new Float64Array(f.count).fill(f.T0), updraft: Float64Array | null = null) {
  const st = initPlan(spec, f);
  let t = 0;
  const layerE = () => { let s = 0; for (let a = 0; a < f.count; a++) s += CP_AIR * f.layerMass(a) * Tl[a]; return s; };
  while (t < T - 1e-9) {
    const F = planForcing(spec, f, st, t, t + dt);
    const r = f.step(dt, { ...F, layerT: Tl, updraft, Tin: f.T0 });
    for (const a of r.changed) Tl[a] = r.T2[a];
    t += dt;
  }
  f.closeEnergy(layerE());
  return Tl;
}

describe('reference state', () => {
  it('ISA, equation of state, hydrostatics and derived quantities', () => {
    const s = isa(0);
    expect(s.p).toBeCloseTo(101325, 6);
    expect(s.T).toBe(288.15);
    expect(s.rho).toBeCloseTo(1.2250, 3);
    const h3 = isa(3000);
    expect(h3.T).toBeCloseTo(268.65, 6);
    expect(h3.p).toBeGreaterThan(70_000);
    expect(h3.p).toBeLessThan(70_250); // ICAO table 70 121 Pa
    expect(density(h3.p, h3.T) * R_AIR * h3.T).toBeCloseTo(h3.p, 6);
    expect(soundSpeed(288.15)).toBeCloseTo(340.3, 1);
    expect(scaleHeight(288.15)).toBeCloseTo(8432, 0);
    // Column of the standard state: σ = p/g.
    expect(layerMassPerArea(101325, 288.15, 10)).toBeCloseTo(1.2243 * 10, 1);
    expect(boilingPoint(101325)).toBeCloseTo(373.15, 6);
    expect(boilingPoint(70_121) - 273.15).toBeGreaterThan(89);
    expect(boilingPoint(70_121) - 273.15).toBeLessThan(91);
    expect(knudsen(101325, 288.15, 1)).toBeLessThan(1e-7);
    expect(cunningham(101325, 288.15, 63e-6)).toBeLessThan(1.01);
    expect(cunningham(1000, 288.15, 63e-6)).toBeGreaterThan(1.2);
  });

  it('rejects inconsistent / impossible input with a reason and warns about the model range', () => {
    const ok = defaultAtmosphereSpec();
    expect(atmosphereIssues(ok)).toEqual([]);
    expect(atmosphereIssues({ ...ok, pressure: -5 })).toContain('atmos.invalid.pressureSign');
    expect(atmosphereIssues({ ...ok, temperature: 0 })).toContain('atmos.invalid.absoluteZero');
    expect(atmosphereIssues({ ...ok, removal: 'linear', target: 1.2 })).toContain('atmos.invalid.target');
    expect(atmosphereIssues({ ...ok, removal: 'linear', target: 0.5, duration: 600, restore: 'reservoir', restoreAt: 300 })).toContain('atmos.invalid.restoreOverlap');
    expect(atmosphereIssues({ ...ok, boundary: 'closed', restore: 'boundary' })).toContain('atmos.invalid.restoreClosed');
    expect(atmosphereIssues({ ...ok, removal: 'scheduled', schedule: [[50, 20]] })).toContain('atmos.invalid.schedule');
    expect(atmosphereIssues({ ...ok, removal: 'linear', target: 0.5, extent: 'local', radius: 500 })).toContain('atmos.invalid.radius');
    expect(atmosphereWarnings({ ...ok, removal: 'linear', target: 0.2, duration: 5 }, 101325)).toEqual(expect.arrayContaining(['atmos.warn.fastRemoval', 'atmos.warn.fireRange']));
  });

  it('planned paths are exact and independent of the step', () => {
    const s: AtmosphereSpec = { ...defaultAtmosphereSpec(), removal: 'linear', target: 0.25, duration: 100 };
    expect(removalShare(s, 50)).toBeCloseTo(0.625, 12);
    expect(removalShare(s, 200)).toBe(0.25);
    const e: AtmosphereSpec = { ...s, removal: 'exponential' };
    expect(removalShare(e, 50)).toBeCloseTo(0.5, 12);
    const sc: AtmosphereSpec = { ...s, removal: 'scheduled', schedule: [[0, 10], [50, 60]] };
    expect(removalShare(sc, 10)).toBeCloseTo(0.625, 12);
    expect(removalShare(sc, 30)).toBeCloseTo(0.625, 12);
    const rs: AtmosphereSpec = { ...s, restore: 'reservoir', restoreAt: 150, restoreDuration: 50, restoreTarget: 1 };
    expect(plannedShare(rs, 175)).toBeCloseTo(0.625, 12);
  });
});

describe('column mass, pressure and flow', () => {
  it('hydrostatic rest state over terrain: pressure falls with height, no flow, solver idle', () => {
    const g = flat();
    for (let a = 0; a < g.length; a++) g[a] = (a % 20) * 2; // 0 … 38 m slope
    const f = mk({ ground: g });
    const low = f.surfacePressure(0), high = f.surfacePressure(19);
    expect(high).toBeLessThan(low);
    expect(high / low).toBeCloseTo(Math.exp(-38 / scaleHeight(288.15)), 10);
    expect(f.pressureAt(0, 100)).toBeLessThan(f.pressureAt(0, 10));
    const r = f.step(0.1, { bgShare: 1, layerT: new Float64Array(f.count).fill(288.15), updraft: null, Tin: 288.15 });
    expect(r.iterations).toBe(-1);
    expect(f.maxSpeed).toBe(0);
  });

  it('closed boundary conserves air mass exactly; a local sink draws air towards it; the flow settles', () => {
    const f = mk();
    const spec: AtmosphereSpec = { ...defaultAtmosphereSpec(), boundary: 'closed', removal: 'linear', extent: 'local', position: [0, 0], radius: 12, target: 0.999, duration: 20 };
    run(f, spec, 20, 0.1);
    const m = f.mass;
    expect(m.removed).toBeGreaterThan(0);
    expect(m.boundaryIn + m.boundaryOut).toBe(0);
    expect(Math.abs(f.massResidual()) / m.initial).toBeLessThan(1e-12);
    // Layer flow converges on the disc: the face west of the centre points east (+x).
    const ix = 9, iz = 10;
    expect(f.ulx[iz * 21 + ix]).toBeGreaterThan(0.05);
    expect(f.ulx[iz * 21 + 12]).toBeLessThan(-0.05);
    // Column flow also into the low.
    expect(f.ubx[iz * 21 + 5]).toBeGreaterThan(0);
    // Pressure lowest at the sink.
    expect(f.surfacePressure(iz * 20 + 10)).toBeLessThan(f.surfacePressure(iz * 20 + 1));
    // After the sink stops the flow decays and the pressure evens out.
    run(f, { ...spec, removal: 'none' }, 300, 0.5);
    expect(f.maxSpeed).toBeLessThan(1e-4);
    expect(f.maxLayerSpeed).toBe(0);
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < f.count; a++) { lo = Math.min(lo, f.surfacePressure(a)); hi = Math.max(hi, f.surfacePressure(a)); }
    expect(hi - lo).toBeLessThan(1e-3);
  });

  it('open boundary refills a local removal; inflow is booked and the mass ledger closes', () => {
    const f = mk({ boundary: 'open' });
    const spec: AtmosphereSpec = { ...defaultAtmosphereSpec(), boundary: 'open', removal: 'linear', extent: 'local', position: [0, 0], radius: 12, target: 0.999, duration: 30 };
    const T = run(f, spec, 60, 0.1);
    Tl0 = () => T[10 * 20 + 10];
    expect(f.mass.boundaryIn).toBeGreaterThan(0.5 * f.mass.removed);
    expect(Math.abs(f.massResidual()) / f.mass.initial).toBeLessThan(1e-12);
    expect(f.oxygen.boundaryIn).toBeCloseTo(0.232 * f.mass.boundaryIn, 6);
    // Refilled from the edges: the pressure barely changes, so the sink hardly cools the air (< 0.01 K).
    expect(Math.abs(Tl0(f) - 288.15)).toBeLessThan(0.01);
    expect(Math.abs(f.energy.final - f.energyExpected()) / f.energy.initial).toBeLessThan(1e-12);
  });

  it('time-step independence of the planned removal and stability for large steps', () => {
    const spec: AtmosphereSpec = { ...defaultAtmosphereSpec(), removal: 'linear', target: 0.4, duration: 60 };
    const a = mk(), b = mk();
    run(a, spec, 60, 0.1);
    run(b, spec, 60, 2);
    expect(a.mass.removed).toBeCloseTo(b.mass.removed, 0);
    expect(a.mass.removed / a.mass.initial).toBeCloseTo(0.6, 10);
    // Local sink with 10 s steps: positive, finite.
    const c = mk({ boundary: 'open' });
    run(c, { ...spec, extent: 'local', position: [10, -10], radius: 8, target: 0.99, duration: 100 }, 100, 10);
    for (let k = 0; k < c.count; k++) { expect(c.sigma[k]).toBeGreaterThan(0); expect(Number.isFinite(c.sigma[k])).toBe(true); }
  });
});

describe('removal, near vacuum and restoration', () => {
  it('uniform removal: real mass leaves, pressure and density fall, the air left behind cools adiabatically, energy closes', () => {
    const f = mk({ boundary: 'open' });
    const spec: AtmosphereSpec = { ...defaultAtmosphereSpec(), boundary: 'open', removal: 'linear', target: 0.5, duration: 120 };
    const Tl = run(f, spec, 120, 0.1);
    expect(f.totalMass() / f.mass.initial).toBeCloseTo(0.5, 10);
    expect(f.surfacePressure(0)).toBeCloseTo(101325 / 2, 4);
    // Uniform removal with the surroundings following: no exchange at the edge.
    expect(f.mass.boundaryIn + f.mass.boundaryOut).toBeLessThan(1e-6 * f.mass.initial);
    // Adiabatic: T = T0·(p/p0)^(R/cp) for every step's expansion.
    expect(Tl[0]).toBeCloseTo(288.15 * Math.pow(0.5, KAPPA), 6);
    expect(f.Tcol).toBeCloseTo(288.15 * Math.pow(0.5, KAPPA), 6);
    const rho = f.densityAt(0, 2, Tl[0]);
    expect(rho).toBeCloseTo(density(101325 / 2 * Math.exp(-2 / scaleHeight(Tl[0])), Tl[0]), 9);
    expect(rho / 1.225).toBeLessThan(0.62);
    // Removed air carries its enthalpy ∫c_p·T dm; the expansion work of the air left behind equals the
    // flow work ∫R·T dm it carried out (to the discretisation of the integral).
    const e = f.energy;
    // Mass-weighted mean temperature of the removed air: T = T0·f^κ, f from 1 to ½ linearly in mass.
    const Tmean = (288.15 * (1 - Math.pow(0.5, 1 + KAPPA))) / ((1 + KAPPA) * 0.5);
    expect(e.removed / (CP_AIR * 0.5 * f.mass.initial * Tmean)).toBeCloseTo(1, 3);
    expect(-e.pressureWork / (R_AIR * 0.5 * f.mass.initial * Tmean)).toBeCloseTo(1, 2);
    expect(Math.abs(f.energy.final - f.energyExpected()) / e.initial).toBeLessThan(1e-12);
  });

  it('isothermal mode books the pressure work as external heat', () => {
    const f = mk();
    const Tl = run(f, { ...defaultAtmosphereSpec(), removal: 'linear', target: 0.5, duration: 60, thermo: 'adiabatic' }, 60, 0.5);
    const g = new AtmosphereField({ originX: -50, originZ: -50, nx: 20, nz: 20, dx: 5, H: 10, ground: flat(), p0: 101325, T0: 288.15, boundary: 'closed', thermo: 'isothermal' });
    const Ti = run(g, { ...defaultAtmosphereSpec(), removal: 'linear', target: 0.5, duration: 60, thermo: 'isothermal' }, 60, 0.5);
    expect(Ti[0]).toBe(288.15);
    expect(Tl[0]).toBeLessThan(240);
    expect(g.energy.isothermalHeat).toBeGreaterThan(0);
    // Warmer air is removed in the isothermal run: more energy leaves with the same mass.
    expect(g.energy.removed).toBeGreaterThan(f.energy.removed);
    expect(Math.abs(g.energy.final - g.energyExpected()) / g.energy.initial).toBeLessThan(1e-12);
  });

  it('near vacuum: never negative or NaN; the floor is kept and the shortfall booked', () => {
    const f = mk({ boundary: 'closed' });
    const Tl = run(f, { ...defaultAtmosphereSpec(), removal: 'linear', target: 0, duration: 30 }, 40, 0.1);
    for (let a = 0; a < f.count; a++) {
      expect(f.sigma[a]).toBeGreaterThan(0);
      expect(Number.isFinite(Tl[a])).toBe(true);
      expect(Tl[a]).toBeGreaterThan(0);
    }
    expect(f.surfacePressure(0)).toBeLessThan(1);
    expect(f.densityAt(0, 1, Tl[0])).toBeLessThan(1e-4);
    expect(f.mass.shortfall).toBeGreaterThan(0);
    expect(Math.abs(f.massResidual()) / f.mass.initial).toBeLessThan(1e-12);
  });

  it('restoration from a reservoir brings the mass back with its energy booked; boundary restoration flows in', () => {
    const f = mk({ boundary: 'closed' });
    const spec: AtmosphereSpec = { ...defaultAtmosphereSpec(), boundary: 'closed', removal: 'linear', target: 0.5, duration: 60, restore: 'reservoir', restoreAt: 60, restoreDuration: 60, restoreTarget: 1 };
    const Tl = run(f, spec, 120, 0.1);
    expect(f.totalMass() / f.mass.initial).toBeCloseTo(1, 6);
    expect(f.mass.restored).toBeCloseTo(f.mass.removed, -2);
    // Compression of the cooled air + reservoir air at T0: back near (not above) the start.
    expect(Tl[0]).toBeGreaterThan(260);
    expect(Math.abs(f.energy.final - f.energyExpected()) / f.energy.initial).toBeLessThan(1e-12);
    const g = mk({ boundary: 'open' });
    run(g, { ...spec, boundary: 'open', restore: 'boundary' }, 120, 0.1);
    expect(g.mass.restored).toBe(0);
    expect(g.mass.boundaryIn).toBeGreaterThan(0.4 * g.mass.initial);
    expect(g.totalMass() / g.mass.initial).toBeGreaterThan(0.95);
    expect(Math.abs(g.massResidual()) / g.mass.initial).toBeLessThan(1e-11);
  });
});

describe('buoyancy, tracers, determinism', () => {
  it('a warm column draws layer air in (continuity: inflow volume = updraft volume)', () => {
    const f = mk({ boundary: 'open' });
    const up = new Float64Array(f.count);
    const c = 10 * 20 + 10;
    up[c] = 3;
    f.step(0.1, { bgShare: 1, layerT: new Float64Array(f.count).fill(288.15), updraft: up, Tin: 288.15 });
    const fw = 10 * 21 + 10;
    const inflow = (f.ulx[fw] - f.ulx[fw + 1] + f.ulz[c] - f.ulz[c + 20]) * f.dx * f.H;
    expect(inflow).toBeCloseTo(3 * f.area, 6);
    expect(f.ulx[fw]).toBeGreaterThan(0);
    // Closed world: the same updraft is fed by uniform subsidence (no edge flux).
    const g = mk({ boundary: 'closed' });
    g.step(0.1, { bgShare: 1, layerT: new Float64Array(g.count).fill(288.15), updraft: up, Tin: 288.15 });
    expect(g.ulx[10 * 21]).toBe(0);
    expect(g.ulx[fw]).toBeGreaterThan(0);
  });

  it('volcanic gas: emitted = airborne + vented + out + removed; added to the air mass', () => {
    const f = mk({ boundary: 'open' });
    const fx = new Float64Array(f.Ux.length), fz = new Float64Array(f.Uz.length), tmp = new Float64Array(f.count);
    const Tl = new Float64Array(f.count).fill(288.15);
    const vent = new Float64Array(f.count).fill(0.01);
    let vented = 0, out = 0;
    for (let k = 0; k < 200; k++) {
      f.step(0.1, { bgShare: 1, layerT: Tl, updraft: null, Tin: 288.15, gas: [{ a: 210, kg: 2 }] });
      f.layerFaces(3, 0, fx, fz);
      const r = f.transportLayer(f.gas, 0.1, vent, fx, fz, tmp);
      vented += r.vented; out += r.out;
    }
    let air = 0;
    for (let a = 0; a < f.count; a++) air += f.gas[a];
    expect(f.gasLedger.emitted).toBe(400);
    expect(air + vented + out).toBeCloseTo(400, 9);
    expect(out).toBeGreaterThan(0);
    expect(f.mass.source).toBe(400);
    expect(Math.abs(f.massResidual()) / f.mass.initial).toBeLessThan(1e-12);
  });

  it('determinism: identical runs give identical state', () => {
    const spec: AtmosphereSpec = { ...defaultAtmosphereSpec(), boundary: 'open', removal: 'pressure', extent: 'local', position: [-20, 15], radius: 10, target: 0.95, duration: 40 };
    const a = mk({ boundary: 'open' }), b = mk({ boundary: 'open' });
    run(a, spec, 40, 0.1);
    run(b, spec, 40, 0.1);
    expect(Array.from(a.sigma)).toEqual(Array.from(b.sigma));
    expect(Array.from(a.Ux)).toEqual(Array.from(b.Ux));
    expect(a.energy).toEqual(b.energy);
    expect(G).toBe(9.81);
  });
});
