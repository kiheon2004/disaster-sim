/**
 * Phase 30: the climate in the simulation — snowfall on ground / roofs / crowns, snowmelt into the flood, lake ice,
 * evaporation and soil drying, crown water and the fire model, contact friction on ice, roof snow loads and collapse,
 * the atmosphere coupling (vapour removed with air), ledgers, determinism, object-id independence, original-world
 * restoration, save / load, dormancy.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { WorldDocument } from '@/core/model';
import type { LakeFeature } from '@/landscape/types';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { createInstance } from '@/phenomena/schedule';
import type { EventSpec } from '@/events/specs';
import { defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import { RHO_WATER, T_MELT } from '@/climate/constants';
import type { ClimateRuntime } from './runtime';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const design = (id: string) => createDesign(presetSpec(id)!, id);
const tree = (x: number, z: number, seed = 3) => ({ type: 'tree' as const, params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });
const K = (c: number) => c + T_MELT;

function flat() {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 42;
}
const docNow = () => structuredClone(S().doc);
const climate = (p: Partial<ClimateSpec> = {}): EventSpec => ({ ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 3600, humidityTarget: undefined, ...p } as EventSpec);
const wind = (speed: number): EventSpec => ({ event: 'wind', speed, direction: 'E', duration: 3600 } as unknown as EventSpec);

async function start(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const crt = (c: SimulationController): ClimateRuntime => c.getEnvironment().climate.rt!;

function expectLedgers(c: SimulationController) {
  const s = crt(c).stats;
  expect(s.waterResidual).toBeLessThan(1e-8);
  expect(s.energyResidual).toBeLessThan(1e-8);
  expect(s.thermalResidual).toBeLessThan(1e-8);
}

function hash(c: SimulationController) {
  const r = crt(c), cw = r.cw, w = r.trt.world;
  const parts = [Array.from(cw.cM).join(','), Array.from(cw.cU).join(','), Array.from(cw.vap).join(','), Array.from(cw.sM).join(','), Array.from(w.air.E).join(','), JSON.stringify(cw.water), JSON.stringify(w.ledger.snapshot())];
  const f = c.getEnvironment().flood.field;
  if (f) parts.push(Array.from(f.h).join(','), JSON.stringify(f.budget));
  const ents = [...c.getRuntime()!.entities.values()].map((e) => `${e.source.type}@${e.pose.position.map((v) => v.toFixed(4)).join(',')}:${e.state}`).sort();
  parts.push(ents.join(';'));
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

describe('climate in the simulation (Phase 30)', () => {
  it('stays dormant without an experiment: no state, the flood budget phase terms stay zero', { timeout: 120_000 }, async () => {
    flat();
    const c = await start(docNow(), [{ event: 'rain', intensity: 50, duration: 20 } as EventSpec]);
    c.advance(5);
    const env = c.getEnvironment();
    expect(env.climate.rt).toBeNull();
    expect(env.climate.active).toBe(false);
    expect(env.thermal.rt).toBeNull();
    const b = env.flood.field!.budget;
    expect(b.melt + b.frozen + b.evaporated + b.condensed).toBe(0);
    expect(env.flood.field!.iceLoad).toBeNull();
    c.unload();
  });

  it('snowfall covers ground, roofs and crowns; masses and energy close; the second experiment is rejected', { timeout: 400_000 }, async () => {
    flat();
    S().applyEdit({ add: [tree(-10, 5), { type: 'building', building: design('house'), seed: 7, transform: tf(15, -5) }, { type: 'car', seed: 5, transform: tf(-25, -10) }] });
    const c = await start(docNow(), [climate({ temperature: K(-4), target: K(-4), humidity: 0.9, precipitation: 15, precipPhase: 'snow' }), climate({ temperature: K(20), target: K(20) })]);
    c.advance(240);
    const r = crt(c), cw = r.cw;
    expect(c.getEnvironment().climate.experiments[1].reason).toBe('climate.reject.second');
    const P = (15 / 3600) * cw.precipTime; // kg/m² delivered up to the last precipitation step (every 5 s)
    expect(cw.precipTime).toBeGreaterThan(234);
    expect(cw.water.precipitation).toBeCloseTo(P * cw.n * cw.cellArea, 0);
    // Ground away from objects: about the snowfall (a little sublimation / deposition).
    const g = r.trt.world.terrain;
    const cOpen = g.index(-40, 40);
    expect(cw.swe(cOpen)).toBeGreaterThan(0.9 * P);
    expect(cw.snowDepth(cOpen)).toBeGreaterThan(0.005);
    // Roof and crown stores hold snow; the roof load is the mass × g over the roof.
    const roof = r.stores.find((s) => s.e.source.type === 'building')!;
    expect(cw.sM[roof.k]).toBeGreaterThan(0.8 * P * cw.stores[roof.k].area);
    const crown = r.stores.find((s) => s.e.source.type === 'tree')!;
    expect(cw.sM[crown.k]).toBeGreaterThan(0);
    expect(r.stats.maxRoofLoad).toBeGreaterThan(0);
    expectLedgers(c);
    c.unload();
  });

  it('warming melts snow into the flood model: meltwater on the budget, snowmelt milestone sequence', { timeout: 400_000 }, async () => {
    flat();
    const c = await start(docNow(), [climate({ temperature: K(2), target: K(15), profile: 'linear', ramp: 120, humidity: 0.85, initialSnow: 0.02, initialSnowDensity: 250, forcing: 'prescribed', solar: 'constant', irradiance: 600, hour: 12 })]);
    c.advance(900);
    const r = crt(c), f = c.getEnvironment().flood.field!;
    expect(f).not.toBeNull();
    expect(r.cw.totals.meltToFlood).toBeGreaterThan(0);
    expect(f.budget.melt * RHO_WATER).toBeCloseTo(r.cw.totals.meltToFlood + 0, -1);
    expect(Math.abs(f.budget.error)).toBeLessThan(1e-6 * Math.max(1, f.budget.melt));
    const kinds = c.getMilestones().map((m) => m.kind);
    expect(kinds).toContain('climateStart');
    expect(kinds).toContain('thawStart');
    expectLedgers(c);
    c.unload();
  });

  it('a cold wave freezes a lake: ice from the lake water, floating-ice arrays in the flood model', { timeout: 600_000 }, async () => {
    flat();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[-40, -30], [40, -30], [40, 30], [-40, 30]], surface: -0.3, depth: 0.5, shoreWidth: 3, material: 7, filled: true };
    S().setFeatures([lake], 2);
    const c = await start(docNow(), [climate({ temperature: K(0.05), target: K(-20), forcing: 'prescribed', humidity: 0.7 }), wind(6)]);
    c.advance(1500);
    const r = crt(c), f = c.getEnvironment().flood.field!;
    expect(r.stats.iceMass).toBeGreaterThan(0);
    expect(f.budget.frozen).toBeGreaterThan(0);
    expect(f.iceLoad).not.toBeNull();
    const cl = r.trt.world.terrain.index(0, 0);
    expect(r.cw.iceThickness(cl)).toBeGreaterThan(0.001);
    // Energy bound: the ice cannot outgrow the heat the surface can lose (≤ ~600 W/m² here: convection + longwave).
    expect(r.cw.iceThickness(cl)).toBeLessThan((600 * 1500) / (917 * 334_000));
    expect(r.cw.floorClamps).toBe(0);
    expect(c.getMilestones().map((m) => m.kind)).toContain('lakeIce');
    expectLedgers(c);
    c.unload();
  });

  it('warm dry air evaporates a pond and dries the soil; crowns lose water when the soil is dry', { timeout: 600_000 }, async () => {
    flat();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[-60, -20], [-20, -20], [-20, 20], [-60, 20]], surface: -0.2, depth: 0.3, shoreWidth: 2, material: 7, filled: true };
    S().setFeatures([lake], 2);
    S().applyEdit({ add: [tree(30, 0), tree(40, 10, 4)] });
    const c = await start(docNow(), [climate({ temperature: K(34), target: K(40), profile: 'linear', ramp: 300, humidity: 0.2, soilMoisture: 0.04, solar: 'clearSky', hour: 12, dayOfYear: 200 })]);
    const r0 = c.getEnvironment();
    void r0;
    c.advance(900);
    const r = crt(c);
    expect(r.cw.totals.evaporated).toBeGreaterThan(0);
    expect(r.stats.vapour).toBeGreaterThan(0);
    const cr = r.crowns[0];
    expect(cr.u).toBeLessThan(c.getEnvironment().fire.settings.foliageMoisture);
    expect(cr.u).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expectLedgers(c);
    c.unload();
  });

  it('ice under a car lowers its contact friction (Phase 14 contact path)', { timeout: 300_000 }, async () => {
    flat();
    S().applyEdit({ add: [{ type: 'car', seed: 5, transform: tf(0, 0) }] });
    const c = await start(docNow(), [climate({ temperature: K(-5), target: K(-5), precipitation: 6, precipPhase: 'rain', humidity: 0.95 })]);
    c.advance(300);
    const car = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'car')!;
    const r = crt(c);
    // The ground beside the car is glazed (the cell under it is sheltered by the car's own store).
    const cell = r.trt.world.terrain.index(car.pose.position[0], car.pose.position[2] + 1.6);
    expect(r.cw.cIce[cell]).toBeGreaterThan(0);
    // Two of the four contact points are sheltered by the car itself (dry), two are glazed: the mean grip drops; on open
    // ground the glaze (only part of the rain freezes on contact — the rest ponds / runs off first) cuts it further.
    expect(car.groundFriction).toBeLessThan(0.95);
    expect(r.frictionAt(30, 30, 1, 0)).toBeLessThan(car.groundFriction);
    expectLedgers(c);
    c.unload();
  });

  it('roof snow loads the structural model of a modular building; a collapse moves the roof snow to the ground', { timeout: 900_000 }, async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: design('warehouse'), seed: 7, transform: tf(0, 0) }] });
    const c = await start(docNow(), [climate({ temperature: K(-1), target: K(-1), humidity: 0.95, initialSnow: 1.5, initialSnowDensity: 450, precipitation: 25, precipPhase: 'snow' })]);
    c.advance(30);
    const r = crt(c);
    const b = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'building')!;
    expect(b.climate?.applied).toBe(true);
    expect(b.modular?.structure).toBeDefined();
    // Phase 31 (R1): ≈ 6.6 kPa of snow is far beyond the warehouse's roof panels (≈ 2.6 kPa): they fail in bending
    // under the climate load and take their snow with them (R2) — the roof store is (almost) empty.
    const fails = c.getDamageEvents().filter((d) => d.eventType === 'FAILED' && d.memberType === 'roof');
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0].hazard).toBe('climate');
    const roofStore = r.stores.find((x) => x.e === b)!;
    expect(r.cw.sGone[roofStore.k] ? 0 : r.cw.sM[roofStore.k]).toBeLessThan(0.05 * 1.5 * 450 * r.cw.stores[roofStore.k].area);
    const total0 = r.cw.waterStorage();
    c.advance(270);
    // Whatever the structure did, no snow mass is lost (dropped or still on the roof).
    const s = r.stores.find((x) => x.e === b)!;
    if (r.cw.sGone[s.k]) expect(r.cw.sM[s.k]).toBe(0);
    expect(r.stats.waterResidual).toBeLessThan(1e-8);
    expect(r.cw.waterStorage()).toBeGreaterThan(total0);
    c.unload();
  });

  it('with an atmosphere removal the vapour leaves with the air (same share), ledgers close', { timeout: 400_000 }, async () => {
    flat();
    const c = await start(docNow(), [{ event: 'atmosphere', altitude: 0, boundary: 'closed', removal: 'linear', target: 0.5, duration: 60 } as EventSpec, climate({ temperature: K(15), target: K(15), humidity: 0.6 })]);
    c.advance(90);
    const r = crt(c);
    expect(r.cw.water.removed).toBeGreaterThan(0);
    expectLedgers(c);
    c.unload();
  });

  it('same result twice, with other object ids, and after a reset; the original world is unchanged', { timeout: 900_000 }, async () => {
    flat();
    S().applyEdit({ add: [tree(-10, 5), { type: 'building', building: design('house'), seed: 7, transform: tf(15, -5) }, { type: 'car', seed: 5, transform: tf(-25, -10) }] });
    const doc = docNow();
    const fp = worldFingerprint(doc);
    const ev = [wind(6), climate({ temperature: K(-2), target: K(3), profile: 'linear', ramp: 60, humidity: 0.9, precipitation: 10, precipPhase: 'auto', initialSnow: 0.05 })];
    const a = await start(doc, ev);
    a.advance(90);
    const h1 = hash(a);
    const b = await start(doc, ev);
    b.advance(90);
    expect(hash(b)).toBe(h1);
    const d2 = structuredClone(doc);
    const objs = Object.values(d2.objects);
    d2.objects = {};
    for (const o of objs) { const id = `zz-${o.id}`; d2.objects[id] = { ...o, id }; }
    const c2 = await start(d2, [...ev].reverse());
    c2.advance(90);
    expect(hash(c2)).toBe(h1);
    await a.reset();
    expect(a.getEnvironment().climate.rt).toBeNull();
    a.advance(90);
    expect(hash(a)).toBe(h1);
    expect(worldFingerprint(doc)).toBe(fp);
    a.unload(); b.unload(); c2.unload();
  });

  it('saves the climate experiment (schema v7) and loads older projects without one', { timeout: 120_000 }, async () => {
    flat();
    const d = docNow();
    const inst = createInstance('climate', [], climate({ scenario: 'coldWave', temperature: K(2), target: K(-15), profile: 'smooth', ramp: 600, initialSnow: 0.3 }));
    d.scenario.experiment = { ...d.scenario.experiment, instances: [inst] } as never;
    const json = serializeDocument(d);
    const res = parseDocument(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(7);
    expect(res.doc.scenario.experiment?.instances[0].spec).toMatchObject({ event: 'climate', scenario: 'coldWave', profile: 'smooth', initialSnow: 0.3 });
    const old = JSON.parse(json);
    delete old.scenario.experiment;
    old.schemaVersion = 6;
    const r2 = parseDocument(JSON.stringify(old));
    expect(r2.ok).toBe(true);
  });
});
