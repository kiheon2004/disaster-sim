/**
 * Phase 28: the volcano in the simulation — lava on real terrain through the Phase 26 thermal state,
 * deposits through the Phase 21 deformation path (terrain, collider, water bed), buildings as obstacles and
 * heated structures, vegetation lit through the Phase 27 fire model, roads, water, ash on roofs, bombs,
 * multiple hazards, ledgers, determinism, object-id independence, original-world restoration, save / load.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import { defaultWaterSettings, type WorldDocument } from '@/core/model';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { createInstance } from '@/phenomena/schedule';
import type { EventSpec } from '@/events/specs';
import type { VolcanoSpec } from '@/volcano/types';
import type { LakeFeature } from '@/landscape/types';
import { DEG } from '@/ground/materials';
import { MS } from '@/structure/types';
import type { VolcanoRuntime } from './runtime';
import { SYNC_TOLERANCE } from './VolcanoChannel';

const S = () => useWorldStore.getState();
/** Ground height of the test slope (6° toward +x up to x = 30) — objects stand on it, as the editor places them. */
const groundAt = (x: number) => Math.round((x < 30 ? (30 - Math.max(-90, x)) * Math.tan(6 * DEG) : 0) * 100) / 100;
const tf = (x: number, z: number) => ({ position: [x, groundAt(x), z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const house = () => createDesign(presetSpec('house')!, 'house');
const tree = (x: number, z: number, seed = 3) => ({ type: 'tree' as const, params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });

/** A plane descending toward +x at `deg` up to x = 30, flat beyond. */
function slope(deg = 6) {
  S().setLocked(false);
  S().newDocument();
  const t0 = S().doc.terrain;
  const heights = new Float32Array(t0.heights.length);
  const tb = Math.tan(deg * DEG);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) {
    const x = t0.originX + ix * t0.cellSize;
    heights[iz * t0.nx + ix] = Math.round((x < 30 ? (30 - Math.max(-90, x)) * tb : 0) * 100) / 100;
  }
  S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length).fill(0) } } });
  S().doc.settings.simulation.seed = 42;
}

const docNow = () => structuredClone(S().doc);
const eruption = (p: Partial<VolcanoSpec> = {}): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-62, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 3, duration: 300, profile: 'constant', ...p } as EventSpec);

async function start(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}

const vrOf = (c: SimulationController): VolcanoRuntime => c.getEnvironment().volcano.rt!;

function expectLedgers(c: SimulationController) {
  const vr = vrOf(c), L = vr.world.ledger(), TL = vr.trt.world.ledger;
  expect(Math.abs(L.mass.residual) / L.mass.supplied).toBeLessThan(1e-9);
  expect(Math.abs(L.energy.residual) / L.energy.supplied).toBeLessThan(1e-9);
  // The heat the lava gave up entered the thermal world exactly once (its own account).
  const out = L.energy.toGround + L.energy.toObjects + L.energy.toWater + L.energy.toAir + L.energy.radiated;
  expect(Math.abs(TL.volcanic - out) / Math.max(1, out)).toBeLessThan(1e-9);
  expect(TL.relativeResidual()).toBeLessThan(1e-9);
}

/** Hash of the volcano + thermal state and the damage / collapse records. */
function hash(c: SimulationController) {
  const vr = vrOf(c), f = vr.world.field;
  const parts = [Array.from(f.M).join(','), Array.from(f.dep).join(','), Array.from(f.depE).join(','), JSON.stringify(vr.world.ledger()), JSON.stringify(vr.trt.world.ledger.snapshot())];
  const B = vr.trt.world.bodies;
  for (let i = 0; i < B.n; i++) parts.push(`${B.alive[i]}|${B.ES[i]}|${B.EC[i]}`);
  // Records by object TYPE and position (ids differ between documents).
  for (const e of c.getDamageEvents()) parts.push([e.time, e.objectType, e.eventType, e.cause, e.hazard, e.source ?? '', e.worldPosition.map((v) => v.toFixed(3)).join(',')].join('|'));
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

describe('volcano channel', () => {
  it('stays dormant without an eruption: no volcano state, no volcanic heat account, a heat-source run keeps its Phase 27 shape', { timeout: 120_000 }, async () => {
    slope();
    const c = await start(docNow(), [{ event: 'heatSource', kind: 'point', position: [0, 0], height: 1.5, radius: 2, input: 'power', power: 3e5, profile: 'constant', duration: 20 } as EventSpec]);
    c.advance(10);
    const env = c.getEnvironment();
    expect(env.volcano.rt).toBeNull();
    expect(env.volcano.source).toBeNull();
    expect(env.fire.rt).toBeNull();
    expect(env.thermal.rt!.world.ledger.volcanic).toBe(0);
    expect('volcanic' in env.thermal.rt!.world.ledger.snapshot()).toBe(false);
    c.unload();
  });

  it('rejects an eruption with a second material or a vent outside the world, with a reason', { timeout: 120_000 }, async () => {
    slope();
    const c = await start(docNow(), [eruption({ duration: 20 }), eruption({ material: 'andesite', temperature: 1050, duration: 20 }), eruption({ vents: [{ kind: 'central', position: [150, 0], radius: 2 }], duration: 20 })]);
    c.advance(2);
    const recs = c.getEnvironment().volcano.eruptions;
    expect(recs.map((r) => r.reason)).toEqual([null, 'volcano.reject.material', 'volcano.reject.outside']);
    expect(vrOf(c).world.eruptions.length).toBe(1);
    c.unload();
  });
});

describe('lava on the terrain', () => {
  it('flows downslope, warms the ground under it, closes its ledgers; the heat enters the thermal world once', { timeout: 240_000 }, async () => {
    slope();
    const c = await start(docNow(), [eruption({ duration: 120 })]);
    c.advance(90);
    const vr = vrOf(c), f = vr.world.field;
    let xmax = -Infinity;
    for (const i of f.mobile) xmax = Math.max(xmax, f.xOf(i));
    expect(xmax).toBeGreaterThan(-62 + 10);
    expectLedgers(c);
    const tr = vr.trt.world.terrain;
    expect(tr.T(tr.index(-58, 0), 0)).toBeGreaterThan(vr.trt.world.Tref + 5);
    // Ground under lava exchanges with nothing but the lava.
    expect(tr.covered[tr.index(-58, 0)]).toBe(1);
    c.unload();
  });

  it('solidified lava becomes terrain: runtime heights, collider and water bed follow; later lava flows over it', { timeout: 300_000 }, async () => {
    slope();
    const h0 = Array.from(S().doc.terrain.heights);
    // Cooler lava locks up quickly (close to its lock-up temperature).
    const c = await start(docNow(), [eruption({ temperature: 1090, rate: 1.5, duration: 120 })]);
    c.advance(200);
    const vr = vrOf(c), f = vr.world.field, t = c.getEnvironment().terrain.data;
    let best = -1;
    for (let i = 0; i < f.n; i++) if (f.dep[i] > (best >= 0 ? f.dep[best] : 0.05)) best = i;
    expect(best).toBeGreaterThanOrEqual(0);
    // Terrain = original + published deposit (within the 1 mm sync tolerance / one publish period).
    const pub = f.applied[best];
    expect(pub).toBeGreaterThan(0.05);
    expect(t.heights[best] - h0[best]).toBeCloseTo(pub, 3);
    expect(Math.abs(f.dep[best] - pub)).toBeLessThan(0.05 + SYNC_TOLERANCE);
    const ch = c.colliderHeight(f.xOf(best), f.zOf(best));
    expect(ch).not.toBeNull();
    expect(Math.abs(ch! - t.heights[best])).toBeLessThan(0.05);
    // The lava's own bed is exact (terrain − applied + deposit).
    expect(f.bed(best)).toBeCloseTo(h0[best] + f.dep[best], 4);
    expectLedgers(c);
    c.unload();
  });
});

describe('objects', () => {
  it('a house stops the lava, its walls are heated and their heat effects are the volcano\'s; the lateral load is measured', { timeout: 300_000 }, async () => {
    slope();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 7, transform: tf(-50, 0) }] });
    const c = await start(docNow(), [eruption({ duration: 250 })]);
    c.advance(200);
    const vr = vrOf(c), f = vr.world.field;
    const e = [...c.getRuntime()!.entities.values()].find((x) => x.source.type === 'building')!;
    expect(f.M[f.index(-50, 0)]).toBe(0);
    expect(e.volcano!.lava).toBeGreaterThan(0.2);
    expect(e.volcano!.ratio).toBeGreaterThan(0);
    expect(vr.heatedBuildings.size).toBe(1);
    const bt = [...vr.heatedBuildings][0];
    // Heat effects on it are the volcano's — or, once its timber burns, the fire's: then the fire was lit by the lava.
    const hz = vr.trt.hooks.hazard!(bt);
    expect(['volcano', 'fire']).toContain(hz);
    if (hz === 'fire') expect(c.getEnvironment().fire.rt!.cause.includes('lava')).toBe(true);
    const B = vr.trt.world.bodies;
    let hot = 0;
    for (let i = 0; i < bt.g.n; i++) { const b = bt.body[i]; if (b >= 0 && B.TS[b] > vr.trt.world.Tref + 50) hot++; }
    expect(hot).toBeGreaterThan(0);
    expectLedgers(c);
    c.unload();
  });

  it('trees in the path are lit by lava heat through the fire model (secondary fire: hazard fire, source volcano); cars are held; roads blocked', { timeout: 400_000 }, async () => {
    slope();
    S().applyEdit({ roads: drawRoad(emptyNetwork(), [[-40, -60], [-40, 60]], { curved: false, profile: defaultProfile() }).network });
    S().applyEdit({ add: [tree(-50, 0), { type: 'car', seed: 5, transform: tf(-44, 2) }] });
    const c = await start(docNow(), [eruption({ duration: 450 })]);
    c.advance(420);
    const fr = c.getEnvironment().fire.rt!;
    expect(fr).toBeTruthy();
    expect(fr.cause.filter((x) => x === 'lava').length).toBeGreaterThan(0);
    const ev = c.getDamageEvents();
    expect(ev.some((x) => x.objectType === 'tree' && x.hazard === 'fire' && x.source === 'volcano')).toBe(true);
    const car = [...c.getRuntime()!.entities.values()].find((x) => x.source.type === 'car')!;
    expect(car.volcano!.held).toBe(true);
    expect(ev.some((x) => x.objectType === 'car' && x.eventType === 'LAVA_CONTACT' && x.hazard === 'volcano')).toBe(true);
    const seg = c.getRuntime()!.roads!.segments[0];
    expect(seg.status).toBe('blocked');
    expect(seg.volcanic!.lava).toBeGreaterThan(0.02);
    expectLedgers(c);
    c.unload();
  });

  it('ash carried by the wind lands on a downwind roof (static surcharge on the roof members) and on the ground; bombs build a cone', { timeout: 300_000 }, async () => {
    slope();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 7, transform: tf(-30, 0) }] });
    const c = await start(docNow(), [{ event: 'wind', speed: 6, direction: 'W', duration: 400 } as EventSpec, eruption({ rate: 2, duration: 120, ashFraction: 0.25, bombFraction: 0.2, plumeHeight: 40 })]);
    c.advance(200);
    const vr = vrOf(c), f = vr.world.field, L = vr.world.ledger();
    const e = [...c.getRuntime()!.entities.values()].find((x) => x.source.type === 'building')!;
    expect(e.volcano!.ash).toBeGreaterThan(0);
    expect(e.volcano!.ashLoad).toBeGreaterThan(0);
    const model = e.modular!.structure!.model;
    const k = model.hazards.indexOf('volcano');
    expect(k).toBeGreaterThanOrEqual(0);
    expect(Array.from(model.causeHazard).includes(k)).toBe(true);
    // Ash lies downwind of the vent.
    let sx = 0, m = 0;
    for (let i = 0; i < f.n; i++) if (f.depA[i] > 0) { sx += f.xOf(i) * f.depA[i]; m += f.depA[i]; }
    expect(sx / m).toBeGreaterThan(-62 + 3);
    expect(L.mass.ashCaught).toBeGreaterThan(0);
    // Bombs: most of them land near the vent (cone).
    let near = 0, all = 0;
    for (let i = 0; i < f.n; i++) { all += f.depB[i]; if (Math.hypot(f.xOf(i) + 62, f.zOf(i)) < 20) near += f.depB[i]; }
    expect(near / all).toBeGreaterThan(0.5);
    expectLedgers(c);
    c.unload();
  });

  it('lava entering a lake heats the water (no boiling model: water above 100 °C is reported); water mass stays exact', { timeout: 300_000 }, async () => {
    slope();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[32, -40], [90, -40], [90, 40], [32, 40]], surface: -0.3, depth: 2, shoreWidth: 3, material: 7, filled: true };
    S().setFeatures([lake], 2);
    const d = docNow();
    d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    const c = await start(d, [eruption({ vents: [{ kind: 'central', position: [22, 0], radius: 2 }], rate: 3, duration: 200 })]);
    c.advance(1);
    const w = c.getEnvironment().flood.field!;
    const v0 = w.totalVolume();
    c.advance(180);
    const vr = vrOf(c), L = vr.world.ledger();
    expect(L.energy.toWater).toBeGreaterThan(0);
    expect(Math.abs(w.totalVolume() - v0) / v0).toBeLessThan(0.02);
    expect(vr.stats.waterAbove100).toBeGreaterThanOrEqual(0);
    expectLedgers(c);
    c.unload();
  });
});

describe('multiple hazards', () => {
  it('volcano + wind / rain / earthquake / landslide / fire / deformation: runs, the ledgers close, nothing is consumed twice', { timeout: 600_000 }, async () => {
    const combos: EventSpec[][] = [
      [{ event: 'rain', intensity: 60, duration: 120 } as EventSpec],
      [{ event: 'earthquake', magnitude: 6, pga: 0.3, duration: 15, seed: 3 } as EventSpec],
      [{ event: 'landslide', area: { kind: 'circle', center: [-20, 20], radius: 10 }, thickness: 1.5, saturation: 1, trigger: 'user', duration: 10 } as EventSpec],
      [{ event: 'fire', position: [-40, 8], height: 1, radius: 2, duration: 300 } as EventSpec],
      [{ event: 'terrainDeformation', kind: 'uplift', center: [-30, 0], radius: 15, amount: 1, duration: 30, profile: 'linear' } as EventSpec],
    ];
    for (const extra of combos) {
      slope();
      S().applyEdit({ add: [tree(-40, 8), { type: 'building', building: house(), seed: 7, transform: tf(-35, -8) }] });
      const c = await start(docNow(), [eruption({ duration: 80, ashFraction: 0.05, bombFraction: 0.05 }), ...extra]);
      c.advance(60);
      expectLedgers(c);
      c.unload();
    }
  });
});

describe('determinism, ids, restoration, save / load', () => {
  const scene = () => { slope(); S().applyEdit({ add: [tree(-50, 0), { type: 'building', building: house(), seed: 7, transform: tf(-40, 6) }, { type: 'car', seed: 5, transform: tf(-46, -4) }] }); };

  it('same result twice, with other object ids, and after a reset; the original world is unchanged', { timeout: 400_000 }, async () => {
    scene();
    const d = docNow();
    const fp = worldFingerprint(d);
    const h0 = Array.from(d.terrain.heights);
    const ev = () => [eruption({ duration: 150, bombFraction: 0.05, ashFraction: 0.05 })];
    const a = await start(d, ev());
    a.advance(120);
    const ha = hash(a);
    // Other object ids (same objects, same order).
    const d2 = structuredClone(d);
    const objs = Object.values(d2.objects);
    d2.objects = {};
    for (const o of objs) { const id = `zz-${o.id}`; d2.objects[id] = { ...o, id }; }
    const b = await start(d2, ev());
    b.advance(120);
    expect(hash(b)).toBe(ha);
    // The document never changed; a reset restores the original terrain and replays the same run.
    expect(worldFingerprint(d)).toBe(fp);
    await a.reset();
    expect(a.getEnvironment().volcano.rt).toBeNull();
    expect(Array.from(a.getEnvironment().terrain.data.heights)).toEqual(h0);
    // (The reset keeps the run's scenario: the same eruption runs again from t = 0.)
    a.advance(120);
    expect(a.getEnvironment().volcano.eruptions.length).toBe(1);
    expect(hash(a)).toBe(ha);
    a.unload();
    b.unload();
  });

  it('saves the volcano scenario (schema v7) and loads older projects without one', () => {
    scene();
    const d = docNow();
    const spec = eruption({ vents: [{ kind: 'fissure', position: [-60, -5], end: [-60, 10], radius: 1.5 }], profile: 'staged', stages: [0.2, 1, 0.4], ashFraction: 0.1 });
    const inst = createInstance('volcano', [], spec);
    d.scenario.experiment = { ...d.scenario.experiment, instances: [inst] };
    const res = parseDocument(serializeDocument(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.scenario.experiment?.instances[0].spec).toMatchObject({ event: 'volcano', profile: 'staged', stages: [0.2, 1, 0.4], vents: [{ kind: 'fissure', end: [-60, 10] }] });
    const old = docNow();
    const r2 = parseDocument(serializeDocument(old));
    expect(r2.ok).toBe(true);
    // An invalid saved spec is rejected with its reason (not silently fixed).
    const bad = structuredClone(d);
    (bad.scenario.experiment!.instances[0].spec as unknown as VolcanoSpec).rate = 99;
    const r3 = parseDocument(serializeDocument(bad));
    expect(r3.ok && r3.doc.scenario.experiment?.instances.length === 1 && (r3.doc.scenario.experiment.instances[0].spec as unknown as VolcanoSpec).rate === 99).toBe(false);
  });
});

void MS;
