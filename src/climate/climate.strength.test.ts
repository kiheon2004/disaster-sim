/**
 * Physical-state tests of the climate (Phase 30 audit §17): each compares WHERE the water / energy is, or a rate, with an
 * independent expectation (a bulk formula, the Stefan problem, the wet-bulb split, the latent heat of the phase). The
 * ledger tests elsewhere cannot see an error that moves mass or energy consistently to the wrong place; these can.
 * Mutations that survived the original suite (audit): sublimation with L_v, meltwater in the wrong cell, no soil thaw,
 * no air-condensation heating, shifted rain / snow split, evaporation from the wrong cell — each fails one test here.
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { defaultWaterSettings } from '@/core/model';
import { WaterField } from '@/simulation/water/WaterField';
import { WaterForcing } from '@/simulation/water/WaterForcing';
import { WaterSolver } from '@/simulation/water/WaterSolver';
import { ThermalWorld, defaultThermalSettings } from '@/thermal/ThermalWorld';
import { hGround } from '@/thermal/convection';
import { qSat, humidityFromRH, wetBulb } from './psychro';
import { freshSnowDensity } from './snow';
import { snowFraction } from './surfaceState';
import { emptyResult, stepNode } from './cover';
import { defaultClimateSpec, type ClimateSpec } from './types';
import { ClimateWorld, type ClimateWaterLink } from './ClimateWorld';
import { CP_AIR, K_ICE, L_F, L_S, L_V, LEWIS, RHO_ICE, RHO_WATER, SIGMA, T_MELT } from './constants';

const K = (c: number) => c + 273.15;
const spec = (over: Partial<ClimateSpec>): ClimateSpec => ({ ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 7200, humidity: 0.5, humidityTarget: undefined, soilMoisture: 0.2, ...over });

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
const addFrozen = (cw: ClimateWorld, c: number, m: number, T: number, ice: boolean, rho: number) => (cw as unknown as { addFrozen(c: number, m: number, T: number, ice: boolean, rho: number): void }).addFrozen(c, m, T, ice, rho);

describe('climate physical state', () => {
  it('sublimation takes L_s and follows the bulk transfer k·(q_s,ice(T_s) − q_a)', () => {
    const T = K(-10), p = 101325, qa = 0.5 * qSat(T, p, true), M = 50;
    const n = { M, U: M * (2108 * -10 - L_F), snow: M, ice: 0, rho: 300, A: 1, Ta: T, qa, p, u2: 3, pr: 1, Tsky: T, S: 0, Tb: T, Gb: 0, dt: 5, open: true };
    const r = stepNode(n, emptyResult());
    const k = hGround(r.Ts, T, 3, 1, 1) / (CP_AIR * Math.pow(LEWIS, 2 / 3));
    expect(r.L).toBe(L_S);
    expect(r.qLatent).toBeCloseTo(L_S * r.evap, 9);
    expect(r.evap / (k * (qSat(r.Ts, p, true) - qa))).toBeGreaterThan(0.95);
    expect(r.evap / (k * (qSat(r.Ts, p, true) - qa))).toBeLessThan(1.05);
  });

  it('meltwater appears under the snow that melted (location, not only the ledger)', () => {
    const r = setup(spec({ temperature: K(8), target: K(8), forcing: 'prescribed', humidity: 0.9, soilMoisture: 0, solar: 'constant', irradiance: 700 } as Partial<ClimateSpec>));
    const cells: number[] = [];
    for (let iz = 5; iz < 10; iz++) for (let ix = 5; ix < 10; ix++) { const c = iz * 40 + ix; cells.push(c); addFrozen(r.cw, c, 0.5, T_MELT, false, 100); }
    r.cw.water.initial = r.cw.waterStorage(); r.cw.energy.initial = r.cw.storeEnergy();
    r.step(120);
    const f = r.field!;
    expect(r.cw.totals.meltToFlood).toBeGreaterThan(1);
    let inBlock = 0;
    for (const c of cells) inBlock += (f.h[c] + f.infiltrated[c]) * RHO_WATER * f.cellArea;
    // A flat closed world: in 2 min the water spreads at most a cell or two — most of it is still under the block.
    let ring = 0;
    for (let iz = 3; iz < 12; iz++) for (let ix = 3; ix < 12; ix++) { const c = iz * 40 + ix; ring += (f.h[c] + f.infiltrated[c]) * RHO_WATER * f.cellArea; }
    expect(ring).toBeGreaterThan(0.999 * r.cw.totals.meltToFlood - r.cw.totals.evaporated - 1e-6);
    expect(inBlock).toBeGreaterThan(0.5 * r.cw.totals.meltToFlood);
  });

  it('soil water freezes at 0 °C (the layer is held there while water remains) and thaws back', { timeout: 600_000 }, () => {
    const r = setup(spec({ temperature: K(0.3), target: K(-20), forcing: 'prescribed', profile: 'staged', stages: [[1200, K(-20)], [1800, K(12)]], humidity: 0.6, soilMoisture: 0.3 } as Partial<ClimateSpec>));
    const c = 20 * 40 + 20, nl = r.cw.nl, g = r.tw.terrain;
    let peak = 0;
    for (let k = 0; k < 18; k++) {
      r.step(100);
      peak = Math.max(peak, r.cw.sI[c * nl]);
      // While a layer holds both water and ice it is at the melting point (latent heat, projected enthalpy).
      for (let l = 0; l < nl; l++) { const j = c * nl + l; if (r.cw.sW[j] > 1e-6 && r.cw.sI[j] > 1e-6) expect(Math.abs(g.T(c, l) - T_MELT)).toBeLessThan(0.05); }
    }
    expect(r.cw.water.transfers.soilFreezing).toBeGreaterThan(0);
    const frozen = r.cw.water.transfers.soilFreezing;
    // The warm phase with a 6 m/s wind (a calm clear night at +12 °C still loses heat to the sky at a 0 °C surface).
    r.tw.u10 = 6; r.cw.u2 = 6 * Math.pow(0.2, 0.14);
    r.step(1800);
    expect(r.cw.water.transfers.soilThaw).toBeGreaterThan(0.5 * frozen);
    // The surface layer is (almost) ice-free again — the last grams thaw at the melting point.
    expect(r.cw.sI[c * nl]).toBeLessThan(0.05 * peak);
  });

  it('condensation in the air warms it by L_v·Δm/C', () => {
    const r = setup(spec({ temperature: K(10), target: K(10), humidity: 0.5 }));
    const cw = r.cw, air = r.tw.air, a = 0;
    const m = cw.layerMass(a), q = qSat(air.T(a), 101325) * 1.2;
    cw.vap[a] = (q * m) / (1 - q);
    const E0 = air.E[a], c0 = cw.water.transfers.airCondensation;
    (cw as unknown as { airStep(dt: number): void }).airStep(0.1);
    const dm = cw.water.transfers.airCondensation - c0;
    expect(dm).toBeGreaterThan(0);
    // The boundary mixing of the same step changes E by much less (mix time 900 s, 0.1 s step).
    expect((air.E[a] - E0) / (L_V * dm)).toBeGreaterThan(0.99);
    expect((air.E[a] - E0) / (L_V * dm)).toBeLessThan(1.01);
  });

  it('precipitation is split by the wet-bulb temperature of the air it falls through', () => {
    const T = K(2.5), RH = 0.45;
    const r = setup(spec({ temperature: T, target: T, forcing: 'prescribed', humidity: RH, precipitation: 6, precipPhase: 'auto' } as Partial<ClimateSpec>));
    r.step(6.1);
    const want = snowFraction(wetBulb(T, humidityFromRH(RH, T, 101325), 101325));
    // Wet bulb ≈ −1 °C at 2.5 °C / 45 % — mostly snow, although the air is above 0 °C.
    expect(want).toBeGreaterThan(0.5);
    expect(r.cw.totals.snowfall / r.cw.water.precipitation).toBeCloseTo(want, 3);
  });

  it('open-water evaporation: the mass the pond lost is what evaporated, at the bulk rate of its own cells', () => {
    // A pond over the whole (closed, flat) world: no flow, every loss is evaporation.
    const r = setup(spec({ temperature: K(30), target: K(30), forcing: 'prescribed', humidity: 0.2 }), () => 0.2);
    const f = r.field!;
    const v0 = f.totalVolume();
    r.step(60);
    const Tw = r.tw.waterT(20 * 40 + 5), qa = r.cw.q(r.cw.cellAir(20 * 40 + 5));
    // Soil infiltration is the other way the pond loses water (the flood budget).
    const lost = (v0 - f.totalVolume() - f.budget.infiltration) * RHO_WATER;
    expect(lost).toBeCloseTo(r.cw.totals.evaporated, 6);
    const e60 = r.cw.totals.evaporated;
    r.step(10);
    const rate = (r.cw.totals.evaporated - e60) / 10 / (40 * 40);
    const bulk = ClimateWorld.openWaterEvaporation(Tw, r.tw.air.T(0), qa, 101325, 0);
    expect(rate / bulk).toBeGreaterThan(0.75);
    expect(rate / bulk).toBeLessThan(1.25);
  });

  it('lake ice grows as the Stefan problem with a surface conductance predicts', { timeout: 900_000 }, () => {
    const Ta = K(-20);
    const r = setup(spec({ temperature: T_MELT, target: Ta, forcing: 'prescribed', humidity: 0.7 }), () => 0.5);
    r.step(3600);
    const H = r.cw.iceThickness(20 * 40 + 20);
    // Reference: H²/(2k_i) + H/h_eff = ΔT·t/(ρ_i·L_f), h_eff = h_c + h_r at the mean surface (≈ −10 °C), sky ≈ T_sky.
    const Ts = K(-10), Tsky = r.cw.surf.Tsky;
    const hEff = hGround(Ts, Ta, 0) + 0.98 * SIGMA * (Ts * Ts + Tsky * Tsky) * (Ts + Tsky) * ((Ts - Tsky) / (Ts - Ta));
    const rhs = (20 * 3600) / (RHO_ICE * L_F);
    const Hs = (-1 / hEff + Math.sqrt(1 / (hEff * hEff) + (2 * rhs) / K_ICE)) * K_ICE;
    expect(H / Hs).toBeGreaterThan(0.6);
    expect(H / Hs).toBeLessThan(1.4);
  });

  it('a tiny node never gives off more vapour in a step than half its mass', () => {
    const M = 0.001, T = K(45), p = 101325;
    // A 60 s surface interval in a 10 m/s dry wind: the uncapped flux would take 5× the node's mass.
    const n = { M, U: 0, snow: 0, ice: M, rho: 917, A: 1, Ta: T, qa: 0.05 * qSat(T, p), p, u2: 10, pr: 1, Tsky: K(10), S: 900, Tb: T, Gb: 50, dt: 60, open: true };
    const r = stepNode({ ...n, U: M * (2108 * -0.5 - L_F) }, emptyResult());
    expect(r.evap * 60).toBeLessThanOrEqual(0.5 * M + 1e-15);
  });

  it('heat through a snow pack follows the Calonne conductivity over its half depth', () => {
    const rho = 250, d = 0.3, M = rho * d, Tb = T_MELT;
    const n = { M, U: M * (2108 * -10 - L_F), snow: M, ice: 0, rho, A: 1, Ta: K(-10), qa: 0, p: 101325, u2: 0, pr: 1, Tsky: K(-10), S: 0, Tb, Gb: 1e9, dt: 1, open: false };
    const r = stepNode(n, emptyResult());
    // Independent: Calonne et al. (2011) k(ρ) = 2.5e-6 ρ² − 1.23e-4 ρ + 0.024, conduction over d/2 to the bed.
    const k = 2.5e-6 * rho * rho - 1.23e-4 * rho + 0.024;
    expect(r.qBottom / ((k / (d / 2)) * (r.T - Tb))).toBeGreaterThan(0.97);
    expect(r.qBottom / ((k / (d / 2)) * (r.T - Tb))).toBeLessThan(1.03);
  });

  it('fresh snow has the Anderson density of the air it fell through', () => {
    for (const Tc of [-12, -4]) {
      const r = setup(spec({ temperature: K(Tc), target: K(Tc), forcing: 'prescribed', humidity: 0.9, precipitation: 8, precipPhase: 'snow' } as Partial<ClimateSpec>));
      r.step(6.1);
      // Independent: Anderson (1976) ρ = 50 + 1.7·(T − T_f + 15)^1.5.
      const want = 50 + 1.7 * Math.pow(Tc + 15, 1.5);
      expect(r.cw.cRho[20 * 40 + 20]).toBeCloseTo(want, 0);
      expect(freshSnowDensity(K(Tc))).toBeCloseTo(want, 9);
    }
  });

  it('an atmosphere removal takes the vapour and condensate of a column in the same share as its air', () => {
    const r = setup(spec({ temperature: K(15), target: K(15), humidity: 0.7 }));
    const cw = r.cw, a = 3;
    cw.cond[a] = 0.5;
    const v0 = cw.vap[a], c0 = cw.cond[a];
    cw.removeWithAir(a, 0.3);
    expect(cw.vap[a]).toBeCloseTo(0.7 * v0, 12);
    expect(cw.cond[a]).toBeCloseTo(0.7 * c0, 12);
    expect(cw.water.removed).toBeCloseTo(0.3 * (v0 + c0), 12);
  });
});

