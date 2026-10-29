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
import { emptyRates } from '@/thermal/TerrainThermal';
import { hGround } from '@/thermal/convection';
import { boilingPointWater, dewPointChecked, esWater, humidityFromRH, qSat, saturationAdjust, specificHumidity } from './psychro';
import { ClimateForcing } from './forcing';
import { climateOutlook } from './outlook';
import { phaseState, snowAlbedo } from './snow';
import { emptyResult, stepNode } from './cover';
import { CLIMATE_SCENARIOS, climateWarnings, defaultClimateSpec, type ClimateSpec } from './types';
import { CLIMATE_PRESETS, climatePreset, scenarioDefaults } from './presets';
import { climate as climateDefinition } from '@/phenomena/climateDefinitions';
import type { EventSpec } from '@/events/specs';
import { parseCommands } from '@/commands/RuleBasedParser';
import { ClimateWorld, computeShade, STORE, type ClimateWaterLink } from './ClimateWorld';
import { CP_AIR, CROWN_BREAK, L_F, L_S, L_V, LEWIS, RHO_ICE, SIGMA, T_MELT } from './constants';

const K = (c: number) => c + 273.15;

function spec(over: Partial<ClimateSpec>): ClimateSpec {
  return { ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 7200, humidity: 0.5, humidityTarget: undefined, soilMoisture: 0.2, ...over };
}

function setup(sp: ClimateSpec, water?: (x: number, z: number) => number, pressure?: number, height?: (x: number, z: number) => number) {
  const t = createFlatTerrain(40);
  if (height) for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = height(t.originX + ix * t.cellSize, t.originZ + iz * t.cellSize);
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
  const cw = new ClimateWorld(tw, t, sp, { water: () => field as ClimateWaterLink | null, ensureWater: () => (field ?? make()) as ClimateWaterLink }, pressure ? { p0: pressure } : {});
  if (pressure) cw.pressure = () => pressure;
  cw.applyInitialState();
  tw.climate = cw.surf;
  tw.coverSink = (c, J) => cw.coverSink(c, J);
  for (let k = 0; k < tw.terrain.ntx * tw.terrain.ntz; k++) tw.terrain.activateTile(k);
  let time = 0;
  return {
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

describe('audit: bare-surface longwave of a hot surface', () => {
  it('the sky loss of a 1300 K surface layer matches the exact quartic surface balance (before: +74 %)', () => {
    const r = setup(spec({ temperature: K(15), target: K(15), humidity: 0.5, soilMoisture: 0 }));
    const tw = r.tw, tr = tw.terrain, cw = r.cw;
    const c = 20 * 40 + 20, j = c * tr.nl;
    const cx = tr.originX + 0.5 * tr.cell, cz = tr.originZ + 0.5 * tr.cell;
    const env = (acc: ReturnType<typeof emptyRates>) => ({ closed: false, u2: 0, water: null, airIndex: (ix: number, iz: number) => tw.air.index(cx + ix * tr.cell, cz + iz * tr.cell), airT: (a: number) => tw.air.T(a), toAir: () => {}, acc, climate: cw.surf });
    const sky = (T0: number) => {
      tr.E[j] = tr.C[j] * (T0 - tw.Tref);
      const acc = emptyRates();
      tr.fluxes(env(acc));
      return acc.radiationSky;
    };
    const base = sky(tw.Tref);
    const hot = sky(1300) - base;
    // Independent reference: (T0 − Ts)/r0 = h_c(Ts − Ta) + εσ(Ts⁴ − T_sky⁴), Newton on Ts.
    const r0 = (tr as unknown as { R0: Float64Array }).R0[c], eps = tr.emiss[c], Tsky = cw.surf.Tsky, Ta = tw.air.T(cw.cellAir(c));
    const hc = hGround(1300, Ta, 0);
    let Ts = 900;
    for (let k = 0; k < 50; k++) {
      const f = (1300 - Ts) / r0 - hc * (Ts - Ta) - eps * SIGMA * (Ts ** 4 - Tsky ** 4);
      const d = -1 / r0 - hc - 4 * eps * SIGMA * Ts ** 3;
      Ts -= f / d;
    }
    const exact = eps * SIGMA * (Ts ** 4 - Tsky ** 4) * tr.area;
    // The cold cell's own share in `base` is subtracted with it (≈ 0.3 % of the hot value).
    expect(Math.abs(hot / exact - 1)).toBeLessThan(0.01);
  });
});

describe('audit: boiling at low pressure', () => {
  it('water at the reference temperature boils when the local boiling point is below it (2 kPa: 17.5 °C)', () => {
    const p = 2000, Tb = boilingPointWater(p);
    expect(Tb).toBeLessThan(K(20));
    const r = setup(spec({ temperature: K(20), target: K(20), humidity: 0.3 }), () => 0.05, p);
    r.step(6);
    // Before the audit water at the reference (heat 0) was never tested for boiling: it stayed at 20 °C.
    expect(r.cw.water.transfers.boiling).toBeGreaterThan(0);
    expect(r.tw.waterT(20 * 40 + 20)).toBeLessThanOrEqual(Tb + 1e-6);
    // The boiled mass carries exactly the excess enthalpy: c·M·(T − Tb) ≈ L_v·dm (the first second's evaporation aside).
    const M = 0.05 * 1000 * 40 * 40, dmExpected = (4186 * M * (K(20) - Tb)) / 2.501e6;
    expect(r.cw.water.transfers.boiling / dmExpected).toBeGreaterThan(0.95);
    expect(r.cw.water.transfers.boiling / dmExpected).toBeLessThan(1.0001);
  });
  it('below the triple point (500 Pa) liquid water boils down to 0 °C', () => {
    const r = setup(spec({ temperature: K(10), target: K(10), humidity: 0.3 }), () => 0.05, 500);
    r.step(6);
    expect(r.tw.waterT(20 * 40 + 20)).toBeLessThanOrEqual(T_MELT + 1e-6);
  });
});

describe('audit: HUD evaporation rate', () => {
  it('is the mass evaporated per second over the last surface interval (before: a 5 s sum shown as /s)', () => {
    const r = setup(spec({ temperature: K(32), target: K(32), humidity: 0.2, solar: 'constant', irradiance: 800 } as Partial<ClimateSpec>), (x) => (x < 0 ? 0.05 : 0));
    r.step(31);
    const m1 = r.cw.totals.evaporated;
    r.step(5);
    const m2 = r.cw.totals.evaporated;
    expect(m2 - m1).toBeGreaterThan(0);
    expect(r.cw.rates.evaporation).toBeCloseTo((m2 - m1) / 5, 9);
  });
});

describe('audit: humidity paths of the editor scenarios and presets', () => {
  const rhPath = (sp: ClimateSpec) => { const f = new ClimateForcing(sp, 101325); return [0, 0.25, 0.5, 0.75, 1].map((x) => f.humidity(x * sp.duration)); };
  it('a scenario chosen in the editor runs at the humidity it shows unless it sets a humidity change', () => {
    const field = climateDefinition.fields.find((f) => f.key === 'scenario')!;
    for (const sc of CLIMATE_SCENARIOS) {
      // From the default instance (a heatwave with a drying humidity target), switch the scenario.
      const sp = field.set!(defaultClimateSpec() as unknown as EventSpec, sc) as unknown as ClimateSpec;
      const own = scenarioDefaults(sc).humidityTarget;
      const want = own ?? sp.humidity;
      // Before the audit snowfall / freezing rain / humid ran at 25 % RH from t = 0 (the leftover target).
      expect(rhPath(sp)[4]).toBeCloseTo(sc === 'custom' ? sp.humidityTarget ?? sp.humidity : want, 12);
      if (own === undefined && sc !== 'custom') for (const v of rhPath(sp)) expect(v).toBeCloseTo(sp.humidity, 12);
    }
  });
  it('presets change humidity only where they say so; the dry-snowfall warning follows the path', () => {
    for (const id of CLIMATE_PRESETS) {
      const p = climatePreset(id);
      for (const e of p.events) {
        if ((e as { event: string }).event !== 'climate') continue;
        const sp = e as unknown as ClimateSpec;
        // Presets whose assumptions describe a drying (or wetting) air: the heatwaves and the cold wave.
        const declared = ['summerHeatwave', 'extremeCold', 'heatwaveDrying'].includes(id) || sp.humidityTarget === sp.humidity;
        if (!declared) for (const v of rhPath(sp)) expect(v).toBeCloseTo(sp.humidity, 12);
        const snowing = (sp.precipitation ?? 0) > 0 && sp.precipPhase !== 'rain';
        if (snowing && !declared && sp.humidity >= 0.5) expect(climateWarnings(sp)).not.toContain('climate.warn.drySnowfall');
      }
    }
  });
});

describe('audit: ice in the flood model', () => {
  it('floating ice on a bowl lake leaves the water at rest (before: the draft capped at h drove 0.5 m/s currents)', () => {
    const bowl = (x: number, z: number) => -0.5 + 0.0006 * (x * x + z * z);
    const r = setup(spec({ temperature: K(-5), target: K(-5), forcing: 'prescribed', humidity: 0.8, initialIce: 0.1 }), (x, z) => Math.max(0, -bowl(x, z)), undefined, bowl);
    const f = r.field!;
    r.step(30);
    let uMax = 0;
    for (let i = 0; i < f.qx.length; i++) uMax = Math.max(uMax, Math.abs(f.qx[i]));
    for (let i = 0; i < f.qz.length; i++) uMax = Math.max(uMax, Math.abs(f.qz[i]));
    // Unit discharge (m²/s): still water stays still; before the audit the shallow ring drew water from the centre.
    expect(uMax).toBeLessThan(1e-4);
    expect(r.tw.ledger.relativeResidual()).toBeLessThan(1e-8);
  });

  it('water on ice frozen to the bed flows over it (before: a bed-fast strip was a wall)', () => {
    const slope = (x: number) => -0.02 * x;
    const r = setup(spec({ temperature: K(-5), target: K(-5), forcing: 'prescribed', humidity: 0.8 }), (x) => (x < -12 ? 0.03 : x >= -4 && x < -2 ? 0.002 : 0), undefined, (x) => slope(x));
    const f = r.field!, cw = r.cw;
    // A strip of 4 mm ice frozen to the bed across the slope (x ∈ [−4, −2)).
    for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) {
      const x = f.cellX(ix);
      if (x >= -4 && x < -2) { const c = iz * f.nx + ix; (cw as unknown as { addFrozen(c: number, m: number, T: number, ice: boolean, rho: number): void }).addFrozen(c, 0.004 * RHO_ICE * cw.cellArea, K(-5), true, RHO_ICE); }
    }
    cw.syncIce();
    expect(f.frozen![20 * f.nx + 17]).toBe(1);
    let below0 = 0;
    for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) if (f.cellX(ix) > 0) below0 += f.h[iz * f.nx + ix];
    // Short enough that the cold air freezes little of the moving film.
    for (let k = 0; k < 600; k++) { r.solver!.step(0.1); }
    let below1 = 0;
    for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) if (f.cellX(ix) > 0) below1 += f.h[iz * f.nx + ix];
    // Before the audit the strip held everything upstream (exactly 0 crossed).
    expect(below1).toBeGreaterThan(below0 + 1e-4);
  });

  it('a film on bare ground evaporates (before: films ≤ 1 mm were treated as soil and never left h)', () => {
    const r = setup(spec({ temperature: K(25), target: K(25), humidity: 0.3, soilMoisture: 0.0, solar: 'constant', irradiance: 800 } as Partial<ClimateSpec>), () => 0.0008);
    const v0 = r.field!.totalVolume();
    r.step(300);
    expect(r.field!.budget.evaporated).toBeGreaterThan(0);
    expect(r.field!.totalVolume()).toBeLessThan(v0);
    expect(r.tw.ledger.relativeResidual()).toBeLessThan(1e-8);
  });

  it('rain running through an ice glaze is booked as rain, not meltwater', () => {
    const r = setup(spec({ temperature: K(-1), target: K(-1), forcing: 'prescribed', humidity: 0.95, precipitation: 20, precipPhase: 'rain' } as Partial<ClimateSpec>));
    for (let c = 0; c < r.cw.n; c++) (r.cw as unknown as { addFrozen(c: number, m: number, T: number, ice: boolean, rho: number): void }).addFrozen(c, 0.003 * RHO_ICE * r.cw.cellArea, K(-1), true, RHO_ICE);
    r.cw.water.initial = r.cw.waterStorage(); r.cw.energy.initial = r.cw.storeEnergy();
    r.step(120);
    // −1 °C air cannot melt the ice: whatever drained to the flood is the rain passing through (the cover holds no liquid).
    expect(r.cw.totals.meltToFlood).toBeLessThan(1e-6 * Math.max(1, r.cw.totals.rain));
  });
});

describe('audit: text commands keep their Phase 29 meaning', () => {
  it('climate words inside a wind / earthquake / rain request no longer drop the request', () => {
    const ev = (t: string) => parseCommands(t, { direction: 'E', duration: 60, gustStrength: 0.2 } as never).commands.map((c) => (c as { command: { spec?: { event?: string } } }).command.spec?.event);
    // Phase 29 (a1a3e1e) results of the same inputs; Phase 30 returned nothing for all of them.
    expect(ev('건물 모서리 쪽으로 풍속 30m/s 바람')).toEqual(['wind']);
    expect(ev('모서리부터 규모 6.5 지진 30초')).toEqual(['earthquake']);
    expect(ev('눈에 띄게 강한 바람 25m/s')).toEqual(['wind']);
    expect(ev('태풍의 눈이 지나가며 풍속 45m/s')).toEqual(['wind']);
    expect(ev('눈과 비가 섞인 시간당 50mm 비')).toEqual(['rain']);
    expect(ev('폭우와 함께 습도 높은 바람 20m/s')).toEqual(['rain', 'wind']);
    expect(ev('humid wind 15 m/s from the south')).toEqual(['wind']);
    expect(ev('earthquake magnitude 7 with freezing wind 20 m/s')).toEqual(['wind']);
    // A climate request alone is still pointed to the experiment editor.
    const r = parseCommands('폭설', { direction: 'E', duration: 60, gustStrength: 0.2 } as never);
    expect(r.commands).toHaveLength(0);
    expect(r.unsupported.map((u) => u.event)).toContain('climate');
  });
});

describe('audit: cover node vapour flux of a thin cooling node', () => {
  it('has the sign and size of the exact flux at its surface temperature (before: deposition 24× the true sublimation)', () => {
    for (const M of [0.001, 0.01, 0.1, 10]) {
      const Ta = K(-30), p = 101325, qa = 0.9 * qSat(Ta, p, true);
      const n = { M, U: M * (2108 * -1 - L_F), snow: 0, ice: M, rho: 917, A: 1, Ta, qa, p, u2: 4, pr: 1, Tsky: K(-60), S: 0, Tb: K(-1), Gb: 0, dt: 5, open: true };
      const r = stepNode(n, emptyResult());
      const k = hGround(r.T, Ta, 4, 1, 1) / (CP_AIR * Math.pow(LEWIS, 2 / 3));
      const exact = k * (qSat(r.Ts, p, true) - qa);
      expect(r.L).toBe(L_S);
      expect(Math.sign(r.evap)).toBe(Math.sign(exact));
      expect(r.evap / exact).toBeGreaterThan(0.5);
      expect(r.evap / exact).toBeLessThan(1.5);
      // Energy of the step: dU = −(conv + rad + latent)·dt (adiabatic bottom, no sun), and the end state is physical.
      expect(r.dU).toBeCloseTo(-5 * (r.qConv + r.qRad + r.qLatent), 6);
      expect(phaseState(n.U + r.dU, M).T).toBeGreaterThan(n.Tsky - 1);
    }
  });
});

describe('audit: object stores', () => {
  it('freezing rain on a crown below 0 °C becomes glaze ice (before: stored ice only ever decreased)', () => {
    const r = setup(spec({ temperature: K(-6), target: K(-6), forcing: 'prescribed', humidity: 0.95, precipitation: 20, precipPhase: 'rain' } as Partial<ClimateSpec>));
    const k = r.cw.addStoreSlot({ kind: STORE.crown, area: 15, air: 0, body: -1, path: 0.05, cells: Int32Array.from([20 * 40 + 20]), lai: 3.5, ref: 0 });
    r.cw.sT[k] = K(-6);
    r.step(300);
    expect(r.cw.sM[k]).toBeGreaterThan(0);
    expect(r.cw.sIce[k]).toBeGreaterThan(0.5 * r.cw.sM[k]);
  });
  it('a crown never starts loaded beyond the load that breaks it', () => {
    // A run registers the stores before the initial state: register on a world without snow, then apply 1 m of
    // 60 kg/m³ snow (the interception maximum of a conifer at that density, 23.9 kg/m², is above the break load).
    const t = setup(spec({ temperature: K(-3), target: K(-3), humidity: 0.8 }));
    const k = t.cw.addStoreSlot({ kind: STORE.crown, area: 15, air: 0, body: -1, path: 0.05, cells: Int32Array.from([0]), lai: 3.5, ref: 0 });
    (t.cw.spec as { initialSnow?: number; initialSnowDensity?: number }).initialSnow = 1;
    (t.cw.spec as { initialSnow?: number; initialSnowDensity?: number }).initialSnowDensity = 60;
    t.cw.applyInitialState();
    expect(t.cw.sM[k] / 15).toBeLessThan(CROWN_BREAK);
    expect(t.cw.sM[k] / 15).toBeGreaterThan(0.9 * CROWN_BREAK);
  });
});
