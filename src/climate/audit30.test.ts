/**
 * Regression tests of the Phase 30 audit (docs/PHASE30_AUDIT.md): each case failed on 5ec58f5 and compares with an
 * independent expectation (equilibrium, an analytic bound or the definition), not with the implementation's own numbers.
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { defaultWaterSettings } from '@/core/model';
import { WaterField } from '@/simulation/water/WaterField';
import { WaterForcing } from '@/simulation/water/WaterForcing';
import { WaterSolver } from '@/simulation/water/WaterSolver';
import { ThermalWorld, defaultThermalSettings } from '@/thermal/ThermalWorld';
import { dewPointChecked, esWater, humidityFromRH, qSat, saturationAdjust, specificHumidity } from './psychro';
import { ClimateForcing } from './forcing';
import { climateOutlook } from './outlook';
import { snowAlbedo } from './snow';
import { defaultClimateSpec, type ClimateSpec } from './types';
import { ClimateWorld, computeShade, STORE, type ClimateWaterLink } from './ClimateWorld';
import { CP_AIR, L_V, RHO_ICE, T_MELT } from './constants';

const K = (c: number) => c + 273.15;

function spec(over: Partial<ClimateSpec>): ClimateSpec {
  return { ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 7200, humidity: 0.5, humidityTarget: undefined, soilMoisture: 0.2, ...over };
}

function setup(sp: ClimateSpec, water?: (x: number, z: number) => number) {
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
  for (let k = 0; k < tw.terrain.ntx * tw.terrain.ntz; k++) tw.terrain.activateTile(k);
  let time = 0;
  return {
    tw, cw, get field() { return field; },
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
}

describe('audit: start state of a world colder than 0 °C', () => {
  it('soil water of layers below 0 °C starts frozen — the ground keeps its start temperature', () => {
    const r = setup(spec({ temperature: K(-20), target: K(-20), forcing: 'prescribed', humidity: 0.8, soilMoisture: 0.3 }));
    const c = 20 * 40 + 20, g = r.tw.terrain, nl = r.cw.nl;
    for (let l = 0; l < nl; l++) { expect(r.cw.sW[c * nl + l]).toBe(0); expect(r.cw.sI[c * nl + l]).toBeGreaterThan(0); }
    r.step(10);
    // Before the audit the freezing of liquid soil water put the whole 0.8 m column at 0 °C within 5 s.
    for (let l = 1; l < nl; l++) expect(g.T(c, l)).toBeLessThan(K(-19.9));
    expect(Math.abs(r.tw.ledger.latent)).toBeLessThan(1e6);
    expect(r.tw.ledger.relativeResidual()).toBeLessThan(1e-8);
  });

  it('a lake starts as liquid at 0 °C, then grows ice at the rate of its heat loss (no instant ice)', () => {
    const r = setup(spec({ temperature: K(-20), target: K(-20), forcing: 'prescribed', humidity: 0.8 }), () => 0.5);
    const c = 20 * 40 + 20;
    expect(r.tw.waterT(c)).toBeCloseTo(T_MELT, 9);
    r.step(6);
    // Upper bound of the ice growth: a surface loss of 600 W/m² (−20 °C air, −55 °C sky, wind) over 6 s → 600·6/(ρ_i·L_f).
    const bound = (600 * 6) / (RHO_ICE * 3.337e5);
    expect(r.cw.iceThickness(c)).toBeLessThan(bound);
    // Before the audit: 16 cm of ice in 6 s (the supercooled reference water freezing c_w·20 K/L_f of the lake at once).
    expect(r.tw.ledger.relativeResidual()).toBeLessThan(1e-8);
  });
});

describe('audit: shortwave', () => {
  it('a prescribed irradiance at night is diffuse — never more than G on flat ground', () => {
    for (const hour of [0, 19.2]) {
      const f = new ClimateForcing(spec({ solar: 'constant', irradiance: 800, latitude: 37.5, dayOfYear: 172, hour } as Partial<ClimateSpec>), 101325);
      const sun = f.sun(0);
      // Flat cell: direct·cos(incidence) + diffuse, cos = dir·up.
      const onFlat = sun.direct * Math.max(0, sun.dir[1]) + sun.diffuse;
      expect(onFlat).toBeCloseTo(800, 6);
    }
    const day = new ClimateForcing(spec({ solar: 'constant', irradiance: 800, latitude: 37.5, dayOfYear: 172, hour: 12 } as Partial<ClimateSpec>), 101325).sun(0);
    expect(day.direct * day.dir[1] + day.diffuse).toBeCloseTo(800, 6);
  });

  it('a building does not shade its own roof', () => {
    const nx = 30, nz = 30, n = nx * nz;
    const g = { nx, nz, cell: 1, groundH: new Float32Array(n), nX: new Float32Array(n), nY: new Float32Array(n).fill(1), nZ: new Float32Array(n), obstacleTop: new Float32Array(n).fill(-Infinity) };
    for (let iz = 10; iz < 20; iz++) for (let ix = 10; ix < 20; ix++) g.obstacleTop[iz * nx + ix] = 10;
    const cos = new Float32Array(n), shade = new Uint8Array(n);
    for (const el of [10, 30, 60, 80]) {
      const b = (el * Math.PI) / 180;
      computeShade(g, [Math.cos(b), Math.sin(b), 0], cos, shade);
      let roofShaded = 0;
      for (let iz = 10; iz < 20; iz++) for (let ix = 10; ix < 20; ix++) roofShaded += shade[iz * nx + ix];
      expect(roofShaded).toBe(0);
      // Analytic shadow behind the block (sun from +X, 10 m high): it reaches 10/tan β beyond the west wall, ≥ 1 row.
      expect(shade[15 * nx + 9]).toBe(1);
    }
  });

  it('a thin store cover takes only its share of the sun on its area (the body under it takes the rest)', () => {
    const r = setup(spec({ temperature: K(-2), target: K(-2), humidity: 0.6, solar: 'constant', irradiance: 800, hour: 12 } as Partial<ClimateSpec>));
    const k = r.cw.addStoreSlot({ kind: STORE.roof, area: 100, air: 0, body: -1, path: 2.5, cells: Int32Array.from([0]), ref: 0 });
    // 0.2 kg/m² of snow: a fifth of the 1 kg/m² that covers a surface.
    (r.cw as unknown as { addStore(k: number, m: number, T: number, ice: boolean, rho: number): void }).addStore(k, 20, K(-2), false, 100);
    expect(r.cw.storeCover(k)).toBeCloseTo(0.2, 12);
    const s0 = r.cw.energy.solar;
    r.step(6.1);
    const absorbed = r.cw.energy.solar - s0; // J over the surface steps that ran
    // At most the covered fifth of the area at albedo ≥ 0.5 over the 6 s of the two store updates (1 s, then 5 s).
    expect(absorbed).toBeLessThanOrEqual(0.2 * 100 * 800 * 0.5 * 6 + 1e-6);
    // Before the audit the whole area absorbed (≈ 5× this), and the first update ran in the dark.
    expect(absorbed).toBeGreaterThan(0.2 * 100 * 800 * 0.1 * 6);
    expect(absorbed).toBeGreaterThan(0);
  });
});

describe('audit: psychrometrics', () => {
  it('saturation adjustment of a heavily supersaturated parcel ends saturated with c·ΔT = L·Δm', () => {
    for (const [T, p, RH] of [[330, 101325, 3], [360, 101325, 1.5], [285, 5000, 3], [300, 101325, 1.01]] as const) {
      const m = 100, q = specificHumidity(RH * esWater(T), p), mv = (q * m) / (1 - q), C = m * CP_AIR;
      const r = saturationAdjust(T, mv, m, p, C);
      expect(r.dm).toBeGreaterThan(0);
      expect(r.T - T).toBeCloseTo((L_V * r.dm) / C, 9);
      const qe = (mv - r.dm) / (m + mv - r.dm);
      expect(Math.abs(qe - qSat(r.T, p))).toBeLessThan(1e-9);
    }
  });

  it('the reported relative humidity is the input definition e/e_s', () => {
    // Before the audit: the ratio of mixing ratios (35 °C, 30 % reported as 28.8 %; 0 wherever e_s ≥ p).
    for (const [T, RH] of [[K(35), 0.3], [K(5), 0.9], [332, 0.5]] as const) {
      const r = setup(spec({ temperature: T, target: T, humidity: RH }));
      expect(r.cw.q(0)).toBeCloseTo(humidityFromRH(RH, T, 101325), 12);
      expect(r.cw.rh(0)).toBeCloseTo(RH, 6);
    }
  });

  it('dry air has no dew point: the display value is not a range end', () => {
    expect(Number.isNaN(dewPointChecked(0))).toBe(true);
    expect(Number.isNaN(dewPointChecked(1e-12))).toBe(true);
    expect(dewPointChecked(esWater(283.15))).toBeCloseTo(283.15, 6);
    const o = climateOutlook(spec({ temperature: K(20), target: K(20), humidity: 0 }));
    expect(Number.isNaN(o.dewStart)).toBe(true);
  });

  it('fresh snow restores the share P/10 of the gap to the maximum albedo (Douville et al. 1995)', () => {
    expect(snowAlbedo(0.7, 0, false, 5)).toBeCloseTo(0.7 + 0.5 * (0.85 - 0.7), 12);
    expect(snowAlbedo(0.5, 0, false, 10)).toBeCloseTo(0.85, 12);
  });
});
