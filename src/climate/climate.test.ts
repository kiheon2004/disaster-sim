/**
 * Phase 30 climate library (pure): psychrometrics, profiles, solar geometry, snow relations, validation, and the
 * ClimateWorld on a Phase 26 thermal state with a Phase 14 water field — mass and energy ledgers, phase changes.
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { defaultWaterSettings } from '@/core/model';
import { WaterField } from '@/simulation/water/WaterField';
import { WaterForcing } from '@/simulation/water/WaterForcing';
import { WaterSolver } from '@/simulation/water/WaterSolver';
import { ThermalWorld, defaultThermalSettings } from '@/thermal/ThermalWorld';
import { boilingPointWater, dewPoint, esIce, esWater, humidityFromRH, qSat, relativeHumidity, saturationAdjust, vapourPressure, wetBulb } from './psychro';
import { precipIntegral, valueAt, type PrecipProfile } from './profiles';
import { airMass, clearDirect, skyTemperature, sunPosition } from './solar';
import { compact, freshSnowDensity, phaseState, snowConductivity } from './snow';
import { climateIssues, defaultClimateSpec, type ClimateSpec } from './types';
import { ClimateWorld, type ClimateWaterLink } from './ClimateWorld';
import { C_WATER, L_F, L_V, RHO_WATER, T_MELT } from './constants';
import { snowFraction, frictionFactor } from './surfaceState';
import { emptyResult, stepNode } from './cover';

const K = (c: number) => c + T_MELT;

describe('psychrometrics', () => {
  it('saturation pressures meet at the triple point and IF97 boils at 1 atm', () => {
    expect(esWater(273.16)).toBeCloseTo(611.657, 2);
    expect(esIce(273.159)).toBeCloseTo(611.65, 0);
    expect(esWater(373.15)).toBeCloseTo(101418, -1); // IAPWS-IF97: 0.101418 MPa
    expect(boilingPointWater(101325)).toBeCloseTo(373.124, 2);
    expect(boilingPointWater(50000)).toBeCloseTo(354.47, 1); // steam tables 81.3 °C
    // Supercooled water is above ice saturation (Murphy & Koop 2005: −20 °C 125.6 / 103.2 Pa).
    expect(esWater(253.15)).toBeCloseTo(125.6, 0);
    expect(esIce(253.15)).toBeCloseTo(103.2, 0);
  });

  it('humidity measures are consistent: RH, dew point, wet bulb', () => {
    const T = K(25), p = 101325;
    const q = humidityFromRH(0.5, T, p);
    expect(relativeHumidity(q, T, p)).toBeCloseTo(0.5, 10);
    expect(dewPoint(vapourPressure(q, p)) - T_MELT).toBeCloseTo(13.86, 1);
    expect(wetBulb(T, q, p) - T_MELT).toBeCloseTo(17.9, 0);
    expect(wetBulb(T, humidityFromRH(1, T, p), p)).toBeCloseTo(T, 3);
    expect(qSat(K(30), 101325)).toBeCloseTo(0.0265, 3);
  });

  it('saturation adjustment conserves energy: c·ΔT = L·Δm, and ends saturated', () => {
    const m = 1000, C = 1005 * m, p = 101325, T = K(5);
    const mv = 1.2 * qSat(T, p) * m;
    const r = saturationAdjust(T, mv, m, p, C);
    expect(r.dm).toBeGreaterThan(0);
    expect(C * (r.T - T)).toBeCloseTo(L_V * r.dm, 6);
    expect((mv - r.dm) / (m + mv - r.dm)).toBeCloseTo(qSat(r.T, p), 9);
  });
});

describe('profiles and forcing', () => {
  it('temperature paths', () => {
    const base = { duration: 3600 };
    expect(valueAt({ ...base, profile: 'linear', ramp: 1800 }, 280, 300, 900)).toBeCloseTo(290, 10);
    expect(valueAt({ ...base, profile: 'smooth', ramp: 1800 }, 280, 300, 900)).toBeCloseTo(290, 10);
    expect(valueAt({ ...base, profile: 'cyclic', period: 3600 }, 280, 300, 1800)).toBeCloseTo(300, 10);
    expect(valueAt({ ...base, profile: 'staged', stages: [[600, 270], [1200, 260]] }, 280, 300, 900)).toBe(270);
    expect(valueAt({ ...base, profile: 'scheduled', windows: [[600, 1200]] }, 280, 300, 900)).toBe(300);
    expect(valueAt({ ...base, profile: 'scheduled', windows: [[600, 1200]] }, 280, 300, 1300)).toBe(280);
  });

  it('precipitation integrals do not depend on the step', () => {
    for (const pp of [
      { profile: 'constant', start: 100, duration: 1000 }, { profile: 'rampUp', start: 0, duration: 1000, ramp: 333 },
      { profile: 'peak', start: 50, duration: 777 }, { profile: 'scheduled', start: 0, duration: 1000, windows: [[10, 200], [300, 333]] },
    ] as PrecipProfile[]) {
      const exact = precipIntegral(pp, 0, 2000);
      for (const dt of [0.1, 0.37, 1, 7.3]) {
        let s = 0;
        for (let t = 0; t < 2000; t += dt) s += precipIntegral(pp, t, t + dt);
        expect(s).toBeCloseTo(exact, 8);
      }
    }
  });
});

describe('solar, sky, snow, surfaces', () => {
  it('sun at noon on an equinox: elevation 90° − latitude; clear-sky beam at the zenith 1361·0.7', () => {
    const s = sunPosition(40, 81, 12);
    expect((s.elevation * 180) / Math.PI).toBeCloseTo(50, 0);
    expect(s.dir[2]).toBeGreaterThan(0); // northern hemisphere: the sun is to the south (+Z)
    expect(airMass(Math.PI / 2)).toBeCloseTo(1, 2);
    expect(clearDirect(Math.PI / 2)).toBeCloseTo(1361 * 0.7, -1);
    expect(sunPosition(40, 81, 0).elevation).toBeLessThan(0);
    // Brutsaert sky: a humid warm sky is warmer than a dry cold one; clouds warm it.
    expect(skyTemperature(K(25), 2000, 0)).toBeGreaterThan(skyTemperature(K(-10), 200, 0) + 20);
    expect(skyTemperature(K(0), 500, 1)).toBeGreaterThan(skyTemperature(K(0), 500, 0));
  });

  it('snow relations: new-snow density, conductivity, compaction keeps the mass, enthalpy phase states', () => {
    expect(freshSnowDensity(K(-20))).toBe(50);
    expect(freshSnowDensity(K(0))).toBeCloseTo(50 + 1.7 * 15 ** 1.5, 6);
    expect(snowConductivity(300)).toBeCloseTo(0.212, 2);
    const rho1 = compact(100, K(-2), 50, false, 86400);
    expect(rho1).toBeGreaterThan(100);
    expect(rho1).toBeLessThan(550);
    // Frozen at −10 °C, melting plateau at 0 °C, all liquid above.
    expect(phaseState(10 * (2108 * -10 - L_F), 10).T).toBeCloseTo(K(-10), 9);
    const half = phaseState(-0.5 * L_F * 10, 10);
    expect(half.T).toBe(T_MELT);
    expect(half.liquid).toBeCloseTo(5, 9);
    expect(snowFraction(K(1))).toBeCloseTo(0.5, 9);
    // Ice cuts the grip to 0.1 / 0.55 of the reference ground.
    expect(frictionFactor(1, 0, 1, 0, 0, 0.8, 0)).toBeCloseTo(0.1 / 0.55, 9);
  });

  it('rejects physically contradictory input with a reason', () => {
    const ok = defaultClimateSpec();
    expect(climateIssues(ok)).toEqual([]);
    expect(climateIssues({ ...ok, humidity: 1.2 })).toContain('climate.invalid.supersaturated');
    expect(climateIssues({ ...ok, solar: 'constant', irradiance: 1500 })).toContain('climate.invalid.aboveSolarConstant');
    expect(climateIssues({ ...ok, temperature: -5 })).toContain('climate.invalid.absoluteZero');
    expect(climateIssues({ ...ok, precipitation: 5, precipPhase: 'snow' })).toContain('climate.invalid.snowTooWarm');
    expect(climateIssues({ ...ok, precipitation: -1 })).toContain('climate.invalid.precipSign');
    expect(climateIssues({ ...ok, profile: 'linear', ramp: 99999 })).toContain('climate.invalid.ramp');
  });
});

// ── ClimateWorld on a thermal state ──────────────────────

interface Run {
  tw: ThermalWorld;
  cw: ClimateWorld;
  field: WaterField | null;
  solver: WaterSolver | null;
  step(seconds: number): void;
}

function spec(over: Partial<ClimateSpec>): ClimateSpec {
  return { ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 7200, humidity: 0.5, humidityTarget: undefined, soilMoisture: 0.2, ...over };
}

/** Build a 40 m world: thermal state at the spec's start temperature, optional water (depth per cell). */
function setup(sp: ClimateSpec, water?: (x: number, z: number) => number): Run {
  const t = createFlatTerrain(40);
  const tw = new ThermalWorld(t, { ...defaultThermalSettings(), ambient: sp.temperature }, 1.225);
  const ws = { ...defaultWaterSettings(), boundaries: { N: { type: 'closed' as const }, E: { type: 'closed' as const }, S: { type: 'closed' as const }, W: { type: 'closed' as const } } };
  let field: WaterField | null = null, solver: WaterSolver | null = null;
  const make = () => {
    field = new WaterField(new TerrainSampler(t), ws);
    solver = new WaterSolver(field, new WaterForcing(ws, t));
    field.heat = new Float64Array(field.count);
    field.infilHeat = new Float64Array(field.count);
    tw.water = { h: field.h, heat: field.heat, infilHeat: field.infilHeat, cellArea: field.cellArea, out: 0, moved: 0 };
    return field;
  };
  if (water) {
    make();
    const f = field!;
    for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) { const d = water(f.cellX(ix), f.cellZ(iz)); if (d > 0) { f.h[iz * f.nx + ix] = d; f.touch(ix, iz); } }
    f.budget.initial = f.totalVolume();
  }
  const cw = new ClimateWorld(tw, t, sp, { water: () => field as ClimateWaterLink | null, ensureWater: () => (field ?? make()) as ClimateWaterLink });
  cw.applyInitialState();
  tw.climate = cw.surf;
  tw.coverSink = (c, J) => cw.coverSink(c, J);
  // Every ground tile takes part (the climate forces the whole world).
  for (let k = 0; k < tw.terrain.ntx * tw.terrain.ntz; k++) tw.terrain.activateTile(k);
  let time = 0;
  const run: Run = {
    tw, cw, get field() { return field; }, get solver() { return solver; },
    step(seconds: number) {
      const n = Math.round(seconds / 0.1);
      for (let i = 0; i < n; i++) {
        if (solver) solver.step(0.1);
        cw.prepare(0.1, time);
        tw.step(0.1, []);
        cw.after(0.1, time);
        tw.ledger.final = tw.internalEnergy();
        time += 0.1;
      }
      cw.closeLedgers();
    },
  };
  return run;
}

function residuals(r: Run) {
  const { cw, tw } = r;
  cw.closeLedgers();
  const wScale = Math.max(1, cw.water.initial + cw.water.precipitation + cw.water.vaporIn + cw.water.floodIn);
  const water = Math.abs(cw.water.final - cw.waterExpected()) / wScale;
  const eStores = cw.energy.final - cw.energyExpected();
  const eThermal = tw.ledger.residual();
  const scale = Math.max(1, Math.abs(cw.energy.initial) + Math.abs(cw.energy.vaporIn) + Math.abs(cw.energy.toThermal) + Math.abs(tw.ledger.latent) + Math.abs(tw.ledger.climate) + tw.ledger.totalLost());
  return { water, energy: Math.abs(eStores + eThermal) / scale, thermal: tw.ledger.relativeResidual(), stores: Math.abs(eStores) / scale };
}

describe('cover node', () => {
  it('fresh ice exactly at 0 °C on 0 °C water under −20 °C air draws its loss from the water, not from its own few grams', () => {
    const M = 0.001, base = { snow: 0, ice: M, rho: 917, A: 1, Ta: T_MELT - 20, qa: 0.0005, p: 101325, u2: 6, pr: 1, Tsky: T_MELT - 55, S: 0, Tb: T_MELT, Gb: 1000, dt: 5, open: true };
    const r = stepNode({ ...base, M, U: -L_F * M }, emptyResult());
    // Strong contact with the water: the node sits just below 0 °C and the heat comes up from the water (it will freeze).
    expect(r.qBottom).toBeLessThan(0);
    const Tafter = phaseState(-L_F * M + r.dU, M).T;
    expect(Tafter).toBeGreaterThan(T_MELT - 1);
    expect(Tafter).toBeLessThanOrEqual(T_MELT);
    // With 1 g of liquid left the node first freezes it (0 °C), then cools sensibly — never below its coldest sink.
    const r2 = stepNode({ ...base, M, U: -L_F * M + 0.5 * L_F * M }, emptyResult());
    expect(phaseState(-0.5 * L_F * M + r2.dU, M).T).toBeGreaterThan(base.Tsky);
  });
});

describe('ClimateWorld: phase changes with exact ledgers', () => {
  it('snow on cold ground stays, sublimates a little into dry air; mass and energy close', () => {
    const r = setup(spec({ temperature: K(-8), target: K(-8), humidity: 0.4, initialSnow: 0.2, initialSnowDensity: 200 }));
    const m0 = r.cw.cM.reduce((s, v) => s + v, 0);
    expect(m0).toBeCloseTo(0.2 * 200 * 40 * 40, 3);
    r.step(120);
    const m1 = r.cw.cM.reduce((s, v) => s + v, 0);
    // Radiative cooling under a dry clear sky may frost it (deposition) or the dry air sublimate it — small either way.
    expect(Math.abs(m1 - m0)).toBeLessThan(1e-3 * m0);
    const res = residuals(r);
    expect(res.water).toBeLessThan(1e-9);
    expect(res.thermal).toBeLessThan(1e-8);
    expect(res.stores).toBeLessThan(1e-8);
  });

  it('warm air melts snow: meltwater enters the flood (mass ledger), the snow stays at 0 °C while melting', { timeout: 600_000 }, () => {
    const r = setup(spec({ temperature: K(1), target: K(12), profile: 'linear', ramp: 60, humidity: 0.8, initialSnow: 0.005, initialSnowDensity: 200, forcing: 'prescribed' }));
    r.step(1800);
    const melt = r.cw.totals.meltToFlood;
    expect(melt).toBeGreaterThan(0);
    expect(r.field).not.toBeNull();
    // Snow temperature at the melting point while snow remains.
    for (let c = 0; c < r.cw.n; c += 97) if (r.cw.cM[c] > 0.5) expect(r.cw.coverT(c)).toBeCloseTo(T_MELT, 6);
    expect(r.field!.budget.melt * RHO_WATER).toBeCloseTo(melt, 3);
    const res = residuals(r);
    expect(res.water).toBeLessThan(1e-9);
    expect(res.thermal).toBeLessThan(1e-8);
    expect(res.stores).toBeLessThan(1e-8);
  });

  it('warm dry air evaporates water: mass to vapour, evaporative cooling, ledgers close', { timeout: 600_000 }, () => {
    const r = setup(spec({ temperature: K(30), target: K(30), humidity: 0.2 }), (x) => (x < 0 ? 0.3 : 0));
    const v0 = r.field!.totalVolume();
    r.step(600);
    const lost = (v0 - r.field!.totalVolume()) * RHO_WATER;
    expect(r.cw.totals.evaporated).toBeGreaterThan(0);
    expect(lost).toBeGreaterThan(0);
    // Evaporative cooling: the water is colder than the air.
    expect(r.tw.waterT(20 * 40 + 5)).toBeLessThan(K(30));
    const res = residuals(r);
    expect(res.water).toBeLessThan(1e-9);
    expect(res.thermal).toBeLessThan(1e-8);
    expect(res.stores).toBeLessThan(1e-8);
  });

  it('a cold wave freezes shallow water: ice forms from the water mass, latent heat booked', { timeout: 600_000 }, () => {
    const r = setup(spec({ temperature: K(0.5), target: K(-15), forcing: 'prescribed', humidity: 0.7 }), () => 0.02);
    r.step(1800);
    const ice = r.cw.cIce.reduce((s, v) => s + v, 0);
    expect(ice).toBeGreaterThan(0);
    expect(r.field!.budget.frozen * RHO_WATER).toBeGreaterThan(0);
    expect(r.tw.ledger.latent).toBeGreaterThan(0);
    const res = residuals(r);
    expect(res.water).toBeLessThan(1e-9);
    expect(res.thermal).toBeLessThan(1e-8);
    expect(res.stores).toBeLessThan(1e-8);
  });

  it('snowfall: the water-equivalent total does not depend on the thermal step, density from the air temperature', () => {
    const r = setup(spec({ temperature: K(-5), target: K(-5), precipitation: 6, precipPhase: 'snow', humidity: 0.9 }));
    // Surface steps run every 5 s from the first second: 601 s delivers precipitation up to 601 s.
    r.step(601);
    const expected = (6 / 3600) * 601 * 40 * 40; // kg
    expect(r.cw.water.precipitation).toBeCloseTo(expected, 3);
    expect(r.cw.totals.snowfall).toBeCloseTo(expected, 3);
    const c = 20 * 40 + 20;
    expect(r.cw.snowDepth(c)).toBeGreaterThan(0.009);
    const res = residuals(r);
    expect(res.water).toBeLessThan(1e-9);
    expect(res.stores).toBeLessThan(1e-8);
  });

  it('soil water freezes in a cold wave with the latent heat holding the layer at 0 °C', { timeout: 600_000 }, () => {
    const r = setup(spec({ temperature: K(0.2), target: K(-20), forcing: 'prescribed', humidity: 0.5, soilMoisture: 0.3 }));
    r.step(1800);
    let ice = 0;
    for (let c = 0; c < r.cw.n; c++) ice += r.cw.sI[c * r.cw.nl];
    expect(ice).toBeGreaterThan(0);
    const res = residuals(r);
    expect(res.thermal).toBeLessThan(1e-8);
    expect(res.stores).toBeLessThan(1e-8);
    expect(res.water).toBeLessThan(1e-9);
  });

  it('hot water boils at the local boiling point (no water lost without energy)', () => {
    const r = setup(spec({ temperature: K(20), target: K(20), humidity: 0.5 }), () => 0.1);
    // Heat the water to 105 °C at 1 atm.
    const f = r.field!;
    for (let c = 0; c < f.count; c++) { const E = f.h[c] * RHO_WATER * f.cellArea * C_WATER * (K(105) - r.tw.Tref); r.tw.ledger.added += E - f.heat![c]; f.heat![c] = E; }
    // Every cell group passes the phase-change projection once in 5 s.
    r.step(5);
    expect(r.cw.water.transfers.boiling).toBeGreaterThan(0);
    const T = r.tw.waterT(100);
    expect(T).toBeLessThanOrEqual(boilingPointWater(101325) + 0.5);
    const res = residuals(r);
    expect(res.water).toBeLessThan(1e-9);
    expect(res.thermal).toBeLessThan(1e-8);
  });
});
