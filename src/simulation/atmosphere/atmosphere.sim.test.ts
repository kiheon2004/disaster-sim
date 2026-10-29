/**
 * Phase 29: the atmosphere in the simulation — air mass removal / restoration through the Phase 26
 * thermal state (layer capacity, adiabatic work, convection), wind loads and drag with the local
 * density, fire O₂ supply, smoke / volcanic gas / ash transport, water, blast / meteor opt-in, terrain,
 * ledgers, determinism, object-id independence, original-world restoration, save / load.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { defaultWaterSettings, type WorldDocument } from '@/core/model';
import type { LakeFeature } from '@/landscape/types';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { createInstance } from '@/phenomena/schedule';
import type { EventSpec } from '@/events/specs';
import type { AtmosphereSpec } from '@/atmosphere/types';
import { KAPPA } from '@/atmosphere/reference';
import type { AtmosphereRuntime } from './runtime';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const house = () => createDesign(presetSpec('house')!, 'house');
const tree = (x: number, z: number, seed = 3) => ({ type: 'tree' as const, params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });

function flat() {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 42;
}
const docNow = () => structuredClone(S().doc);
const atmos = (p: Partial<AtmosphereSpec> = {}): EventSpec => ({ event: 'atmosphere', altitude: 0, boundary: 'open', removal: 'none', ...p } as EventSpec);
const wind = (speed: number): EventSpec => ({ event: 'wind', speed, direction: 'E', duration: 3600 } as unknown as EventSpec);

async function start(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const art = (c: SimulationController): AtmosphereRuntime => c.getEnvironment().atmosphere.rt!;

function expectLedgers(c: SimulationController) {
  const a = art(c), f = a.field;
  expect(Math.abs(f.massResidual()) / f.mass.initial).toBeLessThan(1e-11);
  expect(Math.abs(f.energy.final - f.energyExpected()) / f.energy.initial).toBeLessThan(1e-10);
  expect(a.trt.world.ledger.relativeResidual()).toBeLessThan(1e-9);
}

function hash(c: SimulationController) {
  const a = art(c), f = a.field, w = a.trt.world;
  const parts = [Array.from(f.sigma).join(','), Array.from(f.Ux).join(','), Array.from(f.gas).join(','), Array.from(w.air.E).join(','), JSON.stringify(f.energy), JSON.stringify(f.mass), JSON.stringify(w.ledger.snapshot())];
  const fire = c.getEnvironment().fire.rt;
  if (fire) parts.push(Array.from(fire.fw.soot).join(','), Array.from(fire.fw.o2def).join(','), JSON.stringify(fire.fw.ledger.snapshot()));
  const ents = [...c.getRuntime()!.entities.values()].map((e) => `${e.source.type}@${e.pose.position.map((v) => v.toFixed(4)).join(',')}:${e.windLoad.toFixed(6)}`).sort();
  parts.push(ents.join(';'));
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

describe('atmosphere in the simulation (Phase 29)', () => {
  it('stays dormant without an experiment: no state, no thermal activity, the wind keeps its Phase 15 path', { timeout: 120_000 }, async () => {
    flat();
    S().applyEdit({ add: [{ type: 'car', seed: 5, transform: tf(0, 0) }] });
    const c = await start(docNow(), [wind(12)]);
    c.advance(5);
    const env = c.getEnvironment();
    expect(env.atmosphere.rt).toBeNull();
    expect(env.atmosphere.active).toBe(false);
    expect(env.thermal.rt).toBeNull();
    c.unload();
  });

  it('reference state: ISA at altitude, ρ = p/RT, hydrostatic pressure falls with height, thermal reference = datum temperature', { timeout: 120_000 }, async () => {
    flat();
    const c = await start(docNow(), [atmos({ altitude: 3000 })]);
    c.advance(1);
    const a = art(c);
    expect(a.p0 / 1000).toBeCloseTo(70.1, 0);
    expect(a.T0).toBeCloseTo(268.65, 6);
    expect(a.trt.world.Tref).toBe(a.T0);
    expect(a.densityAt(0, 1, 0)).toBeCloseTo(a.pressureAt(0, 1, 0) / (287.05 * a.T0), 6);
    expect(a.pressureAt(0, 100, 0)).toBeLessThan(a.pressureAt(0, 1, 0));
    // Resting atmosphere: no flow, solver idle.
    expect(a.field.maxSpeed).toBe(0);
    expectLedgers(c);
    c.unload();
  });

  it('gradual removal: real mass leaves, pressure / density fall, the layer cools adiabatically and the ground warms it back; ledgers close', { timeout: 240_000 }, async () => {
    flat();
    const c = await start(docNow(), [atmos({ removal: 'linear', target: 0.5, duration: 60 })]);
    c.advance(30);
    const a = art(c);
    expect(a.stats.share).toBeCloseTo(0.75, 3);
    c.advance(31);
    expect(a.stats.share).toBeCloseTo(0.5, 3);
    expect(a.field.mass.removed / a.field.mass.initial).toBeCloseTo(0.5, 3);
    expect(a.stats.meanPressure / 101325).toBeCloseTo(0.5, 2);
    // Adiabatic cooling makes the thinner air denser than isothermal: ρ/ρ₀ ≈ 0.5^(1/γ) = 0.61 (the ground then warms it).
    expect(a.stats.meanDensity / 1.225).toBeLessThan(Math.pow(0.5, 1 / 1.4) + 0.005);
    expect(a.stats.meanDensity / 1.225).toBeGreaterThan(0.5);
    // Adiabatic cooling (bounded by T0·0.5^κ), the ground (still at 15 °C) heats the cooled air.
    const Tad = 288.15 * Math.pow(0.5, KAPPA);
    expect(a.stats.Tcol).toBeCloseTo(Tad, 3);
    expect(a.stats.meanLayerT).toBeLessThan(288.15 - 20);
    expect(a.stats.meanLayerT).toBeGreaterThan(Tad);
    expect(a.trt.world.ledger.airMass).toBeLessThan(0);
    expectLedgers(c);
    c.unload();
  });

  it('wind loads and drag follow the density: a house\'s load ratio and a car\'s wind load fall with the removal', { timeout: 300_000 }, async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 7, transform: tf(10, 0) }, { type: 'car', seed: 5, transform: tf(-20, 10) }] });
    const doc = docNow();
    const ref = await start(doc, [wind(15), atmos()]);
    ref.advance(40);
    const low = await start(doc, [wind(15), atmos({ removal: 'linear', target: 0.3, duration: 30 })]);
    low.advance(40);
    const pick = (c: SimulationController, type: string) => [...c.getRuntime()!.entities.values()].find((e) => e.source.type === type)!;
    const r = art(low).stats.meanDensity / art(ref).stats.meanDensity;
    expect(r).toBeLessThan(Math.pow(0.3, 1 / 1.4) + 0.005);
    expect(pick(low, 'building').loadRatio / pick(ref, 'building').loadRatio).toBeCloseTo(r, 1);
    expect(pick(low, 'car').windLoad / pick(ref, 'car').windLoad).toBeCloseTo(r, 1);
    ref.unload(); low.unload();
  });

  it('a local sink draws air in: inflow toward the sink, an open edge refills, the pressure falls little', { timeout: 240_000 }, async () => {
    flat();
    const c = await start(docNow(), [atmos({ removal: 'linear', extent: 'local', position: [0, 0], radius: 15, target: 0.999, duration: 120 })]);
    c.advance(20);
    const a = art(c);
    const out: [number, number] = [0, 0];
    a.flowAt(-25, 0, 2, out);
    expect(out[0]).toBeGreaterThan(0.2);
    a.flowAt(25, 0, 2, out);
    expect(out[0]).toBeLessThan(-0.2);
    expect(a.field.mass.boundaryIn).toBeGreaterThan(0.5 * a.field.mass.removed);
    expect(1 - a.stats.share).toBeLessThan(1e-3);
    expectLedgers(c);
    c.unload();
  });

  it('fire in thinned air: the O₂ the column holds limits outdoor burning; the fire and smoke ledgers close', { timeout: 400_000 }, async () => {
    flat();
    S().applyEdit({ add: [tree(0, 0), tree(4, 1, 4)] });
    S().doc.settings.simulation.fire = { foliageMoisture: 0.2, openings: 'asBuilt', heatIgnition: false };
    const doc = docNow();
    // The air is removed first (20 s), the crowns are lit afterwards.
    const ignite: EventSpec = { event: 'fire', position: [0, 0], height: 6, radius: 2.5, duration: 600, startTime: 25 } as EventSpec;
    const ref = await start(doc, [ignite, atmos({ boundary: 'closed' })]);
    ref.advance(40);
    const thin = await start(doc, [ignite, atmos({ removal: 'linear', target: 0.05, duration: 20, boundary: 'closed' })]);
    thin.advance(40);
    const fr = ref.getEnvironment().fire.rt!.fw, ft = thin.getEnvironment().fire.rt!.fw;
    expect(fr.o2LimitedEver).toBe(0);
    expect(ft.o2LimitedEver).toBeGreaterThan(0);
    expect(ft.ledger.fuelConsumed).toBeLessThan(0.8 * fr.ledger.fuelConsumed);
    for (const fw of [fr, ft]) {
      const L = fw.ledger;
      expect(Math.abs(L.smokeProduced - L.smokeRooms - L.smokeAir - L.smokeVented - L.smokeAdvected) / Math.max(1e-9, L.smokeProduced)).toBeLessThan(1e-9);
    }
    expectLedgers(thin);
    // The removal took air with its composition: the O₂ mass in the layer fell with the air mass.
    expect(art(thin).stats.o2Layer).toBeLessThan(0.1 * art(ref).stats.o2Layer);
    ref.unload(); thin.unload();
  });

  it('volcanic gas: the atmosphere receives exactly the volcano\'s gas; ash settles in thin air faster; ledgers close', { timeout: 400_000 }, async () => {
    flat();
    const doc = docNow();
    const erupt: EventSpec = { event: 'volcano', vents: [{ kind: 'central', position: [-40, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 1, duration: 60, profile: 'constant', ashFraction: 0.05, plumeHeight: 80 } as EventSpec;
    const c = await start(doc, [erupt, wind(5), atmos({ removal: 'linear', target: 0.2, duration: 20 })]);
    c.advance(40);
    const a = art(c), vw = c.getEnvironment().volcano.rt!.world;
    const gl = a.field.gasLedger;
    expect(gl.emitted).toBeGreaterThan(0);
    expect(Math.abs(gl.emitted - vw.ledger().mass.gas) / gl.emitted).toBeLessThan(1e-12);
    expect(Math.abs(gl.emitted - gl.airborne - gl.aloft - gl.out - gl.removed) / gl.emitted).toBeLessThan(1e-9);
    // Settling at 20 % pressure vs standard air (fine ash: Stokes ∝ 1/μ — slip makes it faster; coarse ash ∝ 1/√ρ).
    expect(a.settling(2, -40, 0, 50)).toBeGreaterThan(1.8 * 3.0);
    const L = vw.ledger();
    expect(Math.abs(L.mass.residual) / L.mass.supplied).toBeLessThan(1e-9);
    expectLedgers(c);
    c.unload();
  });

  it('opt-in couplings: a blast takes the local background state, a meteor entry the thinned column; without opt-in both unchanged', { timeout: 300_000 }, async () => {
    flat();
    const doc = docNow();
    const blast: EventSpec = { event: 'blast', position: [0, 0], height: 1, energy: 4.184e6, model: 'weakShock', waveform: 'nWave', startTime: 1 } as EventSpec;
    const a = await start(doc, [atmos({ pressure: 60_000, coupleBlast: true }), blast]);
    a.advance(2);
    const b = await start(doc, [atmos({ pressure: 60_000 }), blast]);
    b.advance(2);
    const wa = a.getEnvironment().blast.waves[0].wave, wb = b.getEnvironment().blast.waves[0].wave;
    expect(wa.init.ambient.p).toBeCloseTo(60_000, -2);
    expect(wa.init.ambient.rho).toBeCloseTo(60_000 / (287.05 * 288.15), 3);
    expect(wb.init.ambient.p).toBe(101325);
    a.unload(); b.unload();
  });

  it('same result twice, with other object ids, and after a reset; the original world is unchanged', { timeout: 400_000 }, async () => {
    flat();
    S().applyEdit({ add: [tree(-10, 5), { type: 'building', building: house(), seed: 7, transform: tf(15, -5) }, { type: 'car', seed: 5, transform: tf(-25, -10) }] });
    const doc = docNow();
    const fp = worldFingerprint(doc);
    const ev = [wind(8), atmos({ removal: 'pressure', extent: 'local', position: [5, 5], radius: 12, target: 0.99, duration: 30, restore: 'boundary', restoreAt: 40, restoreDuration: 20, restoreTarget: 1 })];
    const a = await start(doc, ev);
    a.advance(70);
    const h1 = hash(a);
    const b = await start(doc, ev);
    b.advance(70);
    expect(hash(b)).toBe(h1);
    // Other object ids (same objects, same order), and the events registered in the other order.
    const d2 = structuredClone(doc);
    const objs = Object.values(d2.objects);
    d2.objects = {};
    for (const o of objs) { const id = `zz-${o.id}`; d2.objects[id] = { ...o, id }; }
    const c2 = await start(d2, [...ev].reverse());
    c2.advance(70);
    expect(hash(c2)).toBe(h1);
    await a.reset();
    expect(a.getEnvironment().atmosphere.rt).toBeNull();
    a.advance(70);
    expect(hash(a)).toBe(h1);
    expect(worldFingerprint(doc)).toBe(fp);
    a.unload(); b.unload(); c2.unload();
  });

  it('saves the atmosphere experiment (schema v7) and loads older projects without one', { timeout: 120_000 }, async () => {
    flat();
    const d = docNow();
    const inst = createInstance('atmosphere', [], atmos({ removal: 'linear', target: 0.4, duration: 300, coupleMeteor: true }));
    d.scenario.experiment = { ...d.scenario.experiment, instances: [inst] } as never;
    const json = serializeDocument(d);
    const res = parseDocument(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(7);
    expect(res.doc.scenario.experiment?.instances[0].spec).toMatchObject({ event: 'atmosphere', removal: 'linear', target: 0.4, coupleMeteor: true });
    const old = JSON.parse(json);
    delete old.scenario.experiment;
    old.schemaVersion = 6;
    const r2 = parseDocument(JSON.stringify(old));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.doc.scenario.experiment?.instances ?? []).toEqual([]);
  });
});

describe('atmosphere: restoration, water, terrain, meteor, rooms, near vacuum, plume (Phase 29)', () => {
  it('reservoir restoration brings the air mass back; the milestones mark it; ledgers close', { timeout: 300_000 }, async () => {
    flat();
    const c = await start(docNow(), [atmos({ boundary: 'closed', removal: 'linear', target: 0.4, duration: 30, restore: 'reservoir', restoreAt: 40, restoreDuration: 30, restoreTarget: 1 })]);
    c.advance(35);
    expect(art(c).stats.share).toBeCloseTo(0.4, 3);
    c.advance(40);
    const a = art(c);
    expect(a.stats.share).toBeCloseTo(1, 3);
    expect(a.field.mass.restored).toBeCloseTo(a.field.mass.removed, -3);
    const kinds = c.getMilestones().map((m) => m.kind);
    for (const k of ['atmosStart', 'removalStart', 'pressureMilestone', 'restorationStart', 'restorationComplete'] as const) expect(kinds).toContain(k);
    expectLedgers(c);
    c.unload();
  });

  it('water: a uniform removal does not move or remove water; a local low tilts it a little; the water mass stays exact', { timeout: 300_000 }, async () => {
    flat();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[-40, -30], [40, -30], [40, 30], [-40, 30]], surface: -0.3, depth: 2, shoreWidth: 3, material: 7, filled: true };
    S().setFeatures([lake], 2);
    const d = docNow();
    d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    for (const ev of [atmos({ removal: 'linear', target: 0.2, duration: 30 }), atmos({ removal: 'linear', extent: 'local', position: [0, 0], radius: 10, target: 0.995, duration: 60 })]) {
      const c = await start(d, [ev, { event: 'rain', intensity: 0.001, duration: 1 } as EventSpec]);
      c.advance(1);
      const w = c.getEnvironment().flood.field!;
      const v0 = w.totalVolume();
      c.advance(60);
      expect(Math.abs(w.totalVolume() - v0) / v0).toBeLessThan(1e-6);
      expect(art(c).stats.waterAboveBoiling).toBe(0);
      expectLedgers(c);
      c.unload();
    }
  });

  it('terrain deformation during the experiment: the column ground heights are re-read, the flow stays bounded, ledgers close', { timeout: 300_000 }, async () => {
    flat();
    const c = await start(docNow(), [atmos({ boundary: 'closed' }), { event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 25, amount: 4, duration: 3, profile: 'smooth', falloff: 'smooth' } as EventSpec]);
    c.advance(20);
    const a = art(c);
    expect(a.terrainUpdates).toBeGreaterThan(0);
    // The hollow holds more air (the reduced pressure is equal in the rest state): flow settles.
    expect(a.stats.peakSpeed).toBeLessThan(1);
    c.advance(60);
    expect(a.field.maxSpeed).toBeLessThan(1e-3);
    expectLedgers(c);
    c.unload();
  });

  it('meteor entry (opt-in): thinner air → less drag in the entry, a faster arrival; without the opt-in the Phase 23 entry', { timeout: 300_000 }, async () => {
    flat();
    const doc = docNow();
    const meteor: EventSpec = { event: 'impact', target: [0, 0], material: 'stony', diameter: 0.5, speed: 15000, angle: 45, azimuth: 90, entry: 'atmosphere', airBlast: false } as EventSpec;
    const speed = async (ev: EventSpec[]) => { const c = await start(doc, ev); c.advance(0.2); const m = c.getEnvironment().impact.models[0]; const v = m.plan.entry!.speed; c.unload(); return v; };
    const ref = await speed([meteor]);
    const off = await speed([atmos({ pressure: 30_000 }), meteor]);
    const on = await speed([atmos({ pressure: 30_000, coupleMeteor: true }), meteor]);
    expect(off).toBe(ref);
    expect(on).toBeGreaterThan(ref);
  });

  it('rooms follow the outdoor pressure: room air leaves with its heat to the outdoor column; the thermal ledger closes', { timeout: 300_000 }, async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 7, transform: tf(0, 0) }] });
    S().doc.settings.simulation.fire = { foliageMoisture: 1.5, openings: 'asBuilt', heatIgnition: false };
    const c = await start(docNow(), [atmos({ removal: 'linear', target: 0.5, duration: 30 }), { event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 300 } as EventSpec]);
    c.advance(40);
    const a = art(c), w = a.trt.world;
    const room = w.comps.find((cp) => cp.alive)!;
    // Room heat capacity ∝ its air mass = ρ_out·V (≈ half of the start).
    const fire = c.getEnvironment().fire.rt!;
    const R = fire.fw.rooms[0];
    expect(R.gas / R.V).toBeCloseTo(w.air.rhoAt(R.air), 6);
    expect(room.C).toBeGreaterThan(0);
    expectLedgers(c);
    c.unload();
  });

  it('near vacuum: wind loads and drag vanish with the density, no NaN, the floor holds', { timeout: 300_000 }, async () => {
    flat();
    S().applyEdit({ add: [{ type: 'car', seed: 5, transform: tf(0, 0) }, tree(10, 10)] });
    const c = await start(docNow(), [atmos({ removal: 'linear', target: 0, duration: 20 }), wind(30)]);
    c.advance(30);
    const a = art(c);
    expect(a.stats.minPressure).toBeLessThan(1);
    expect(a.stats.minDensity).toBeLessThan(1e-4);
    for (const e of c.getRuntime()!.entities.values()) { expect(Number.isFinite(e.windLoad)).toBe(true); expect(e.windLoad).toBeLessThan(1); }
    expect(Math.abs(a.field.massResidual()) / a.field.mass.initial).toBeLessThan(1e-11);
    c.unload();
  });

  it('heated air rises: a volume heat source makes an updraft and draws layer air in; the plume milestone is recorded', { timeout: 300_000 }, async () => {
    flat();
    const c = await start(docNow(), [atmos({}), { event: 'heatSource', kind: 'volume', position: [0, 0], height: 5, radius: 4, input: 'power', power: 3e6, profile: 'constant', duration: 120 } as EventSpec]);
    c.advance(60);
    const a = art(c);
    expect(a.stats.maxUpdraft).toBeGreaterThan(1);
    const out: [number, number] = [0, 0];
    a.flowAt(-12, 0, 2, out);
    expect(out[0]).toBeGreaterThan(0);
    a.flowAt(12, 0, 2, out);
    expect(out[0]).toBeLessThan(0);
    expect(c.getMilestones().some((m) => m.kind === 'plumeDevelopment')).toBe(true);
    expectLedgers(c);
    c.unload();
  });
});
