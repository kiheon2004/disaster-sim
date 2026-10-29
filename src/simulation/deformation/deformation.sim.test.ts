/**
 * Terrain deformation in a running simulation (Phase 21): document isolation and restoration,
 * collider = render surface, object contact, foundations, roads, water bed (mass), lakes,
 * multi-hazard, determinism, step-size independence, save / load.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController, runtimeTerrain } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import { defaultWaterSettings } from '@/core/model';
import { phenomena } from '@/phenomena/registry';
import { defaultScenarios, runComparison } from '@/phenomena/experiment';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { SCHEMA_VERSION } from '@/world/WorldDocument';
import { worldFingerprint } from '@/world/fingerprint';
import { captureBlueprint } from '@/blueprints/capture';
import { heightfieldDesc } from '@/terrain/TerrainPhysicsAdapter';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import { WaterField } from '@/simulation/water/WaterField';
import { captureWaterState } from '@/simulation/water/waterStateCodec';
import { samplerFor } from '@/terrain/TerrainSampler';
import type { LakeFeature } from '@/landscape/types';
import type { TerrainDeformationSpec } from '@/deformation/types';
import type { EventSpec } from '@/events/specs';
import { BETA } from './response';

const S = () => useWorldStore.getState();
const def = (extra: Partial<TerrainDeformationSpec> = {}): TerrainDeformationSpec => ({
  event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 25, amount: 1.5, duration: 3, profile: 'smooth', falloff: 'smooth', ...extra,
});
const tf = (x: number, z: number, rotY = 0) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, rotY, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const house = () => createDesign(presetSpec('house')!, 'house');
const physicsOf = (c: SimulationController) => (c as unknown as { physics: PhysicsEngine }).physics;
const fieldOf = (c: SimulationController) => c.getEnvironment().flood.field as WaterField;
const byType = (c: SimulationController, type: string) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === type);

async function start(events: EventSpec[], doc = S().doc) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('runtime layer vs. the document', { timeout: 120_000 }, () => {
  it('the document, its fingerprint and blueprints are never changed; a reset restores the original ground exactly', async () => {
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(10, 0) }] });
    const h0 = S().doc.terrain.heights.slice();
    const fp = worldFingerprint(S().doc);
    const ids = Object.keys(S().doc.objects);
    const bp = JSON.stringify(captureBlueprint(S().doc, { objects: ids } as never).blueprint.objects);
    const c = await start([def()]);
    c.advance(5);
    const env = c.getEnvironment();
    expect(env.deformation.engine!.maxAbs).toBeCloseTo(1.5, 4);
    expect(env.terrain.sampleHeight(0, 0)).toBeCloseTo(-1.5, 3);
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(h0));
    expect(worldFingerprint(S().doc)).toBe(fp);
    expect(JSON.stringify(captureBlueprint(S().doc, { objects: ids } as never).blueprint.objects)).toBe(bp);
    await c.reset();
    expect(c.getEnvironment().deformation.engine).toBeNull();
    expect(Array.from(c.getEnvironment().terrain.data.heights)).toEqual(Array.from(h0));
    expect(c.getEnvironment().terrain.data.heights).not.toBe(S().doc.terrain.heights); // own copy
    c.unload();
  });

  it('collider = render surface: ground rays hit the deformed heights everywhere', async () => {
    const c = await start([def({ kind: 'uplift', radius: 30, amount: 2, center: [5, -3] }), def({ center: [-20, 15], radius: 12, amount: 1 })]);
    c.advance(4);
    const env = c.getEnvironment();
    const ph = physicsOf(c);
    let worst = 0;
    for (let x = -40; x <= 40; x += 3.7) for (let z = -40; z <= 40; z += 4.3) {
      const d = ph.castGroundRay([x, 50, z], [0, -1, 0], 200)!;
      worst = Math.max(worst, Math.abs(50 - d - env.terrain.sampleHeight(x, z)));
    }
    expect(worst).toBeLessThan(1e-3);
    // The render mesh reads the same array (heightfieldDesc shares it).
    expect(heightfieldDesc(env.deformation.engine!.terrain).heights).toBe(env.terrain.data.heights);
    c.unload();
  });
});

describe('objects on moving ground', { timeout: 120_000 }, () => {
  it('a car falls onto subsiding ground and rests there; uplift lifts a resting car without launching it', async () => {
    S().applyEdit({ add: [{ type: 'car', seed: 2, transform: tf(0, 0) }] });
    const down = await start([def()]);
    down.advance(6);
    const car = byType(down, 'car')[0];
    const g = down.getEnvironment().terrain.sampleHeight(0, 0);
    expect(g).toBeCloseTo(-1.5, 2);
    expect(Math.abs(car.pose.position[1] - g)).toBeLessThan(1.2); // on the new ground (body origin ≈ ground + half height)
    expect(Math.hypot(...physicsOf(down).getLinearVelocity(car.body!))).toBeLessThan(0.2);
    down.unload();
    const up = await start([def({ kind: 'uplift', amount: 1.5 })]);
    let vmax = 0;
    for (let i = 0; i < 60; i++) {
      up.advance(0.1);
      vmax = Math.max(vmax, Math.hypot(...physicsOf(up).getLinearVelocity(byType(up, 'car')[0].body!)));
    }
    const car2 = byType(up, 'car')[0];
    expect(car2.pose.position[1]).toBeGreaterThan(1.5 - 0.1);
    expect(vmax).toBeLessThan(3); // carried, not launched
    up.unload();
  });

  it('fixed objects follow the ground; a pole on a steep flank topples, a tree on gentle ground does not', async () => {
    S().applyEdit({ add: [
      { type: 'streetLight', seed: 1, transform: tf(8, 0) },
      { type: 'tree', seed: 2, transform: tf(-40, 30) },
    ] });
    const c = await start([def({ kind: 'depression', radius: 14, amount: 6, profile: 'linear' }), def({ center: [-40, 30], radius: 60, amount: 0.3 })]);
    c.advance(5);
    const pole = byType(c, 'streetLight')[0], tree = byType(c, 'tree')[0];
    expect(pole.ground!.tilt).toBeGreaterThan(0.26);
    expect(pole.dynamic).toBe(true);
    expect(pole.flags.toppled).toBe(true);
    expect(tree.dynamic).toBe(false);
    expect(tree.pose.position[1] - tree.initialPose.position[1]).toBeCloseTo(-0.3, 2);
    c.unload();
  });
});

describe('building foundations', { timeout: 120_000 }, () => {
  it('uniform settlement moves a building rigidly (no differential damage); a bowl edge distorts it', async () => {
    S().applyEdit({ add: [
      { type: 'building', building: house(), seed: 1, transform: tf(0, 0) },
      { type: 'building', building: house(), seed: 2, transform: tf(-60, 50) },
    ] });
    // A very wide flat-floored settlement under the first; the second stands on the rim of a small bowl.
    const c = await start([def({ falloff: 'steep', radius: 150, amount: 0.4, center: [0, 0] }), def({ center: [-60 + 9, 50], radius: 14, amount: 0.8, profile: 'linear' })]);
    c.advance(5);
    const [a, b] = byType(c, 'building').sort((p, q) => q.initialPose.position[0] - p.initialPose.position[0]);
    expect(a.ground!.settlement).toBeCloseTo(-0.4, 2);
    expect(a.ground!.beta).toBeLessThan(BETA.safe);
    expect(a.ground!.contact).toBe(1);
    expect(a.ground!.damage).toBe(0);
    expect(a.pose.position[1] - a.initialPose.position[1]).toBeCloseTo(-0.4, 2);
    expect(b.ground!.peakBeta).toBeGreaterThan(BETA.safe);
    expect(b.ground!.tilt).toBeGreaterThan(0);
    expect(b.ground!.damage).toBeGreaterThan(0);
    // Damage is attributed to the ground hazard, once per kind.
    const ev = c.getDamageEvents().filter((e) => e.objectId === b.id && e.hazard === 'ground');
    expect(ev.length).toBeGreaterThan(0);
    // Once per kind (member failures of a collapse — Phase 25 — once per member).
    expect(new Set(ev.map((e) => `${e.eventType}|${e.componentId ?? ''}`)).size).toBe(ev.length);
    c.unload();
  });

  it('a building destroyed by differential settlement is attributed to the ground, never to wind (no wind blowing)', async () => {
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(5, 0) }] });
    const c = await start([def({ radius: 22, amount: 1.6, duration: 4 })]);
    c.advance(8);
    const b = byType(c, 'building')[0];
    expect(b.state).toBeGreaterThanOrEqual(3);
    const ev = c.getDamageEvents().filter((e) => e.objectId === b.id);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.filter((e) => e.hazard === 'wind')).toEqual([]);
    expect(ev.some((e) => e.hazard === 'ground' && (e.eventType === 'COLLAPSED' || e.eventType === 'STORY_COLLAPSED' || e.eventType === 'DESTROYED'))).toBe(true);
    c.unload();
  });

  it('explicit support loss raises the bearing ratio; displacement alone does not', async () => {
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(0, 0) }] });
    const plain = await start([def({ falloff: 'steep', radius: 100, amount: 0.3 })]);
    plain.advance(4);
    const p = byType(plain, 'building')[0].ground!;
    expect(p.support).toBe(1);
    expect(p.bearingRatio).toBeCloseTo(p.bearing0, 6);
    plain.unload();
    const lost = await start([def({ falloff: 'steep', radius: 100, amount: 0.3, supportLoss: 0.5 })]);
    lost.advance(4);
    const l = byType(lost, 'building')[0].ground!;
    expect(l.support).toBeCloseTo(0.5, 2);
    expect(l.bearingRatio).toBeCloseTo(l.bearing0 / 0.5, 2);
    lost.unload();
  });
});

describe('roads', { timeout: 120_000 }, () => {
  it('a road across a step becomes impassable; the network is never edited', async () => {
    const roads = drawRoad(emptyNetwork(), [[-80, 0], [80, 0]], { curved: false, profile: defaultProfile() }).network;
    S().applyEdit({ roads });
    const before = JSON.stringify(S().doc.roads);
    const c = await start([def({ kind: 'depression', radius: 10, amount: 1.2, profile: 'instant' })]);
    c.advance(2);
    const rt = c.getRuntime()!.roads!;
    expect(rt.segments.length).toBe(Object.keys(S().doc.roads.segments).length);
    const st = rt.segments.find((s) => s.deform)!;
    expect(st.deform!.passable).toBe(false);
    expect(st.deform!.offset).toBeGreaterThan(0.3);
    expect(rt.summary().cut).toBeGreaterThan(0);
    expect(c.getMilestones().some((m) => m.kind === 'roadCut')).toBe(true);
    expect(JSON.stringify(S().doc.roads)).toBe(before);
    c.unload();
  });

  it('gentle wide settlement: grade changes are measured, the road stays passable', async () => {
    S().applyEdit({ roads: drawRoad(emptyNetwork(), [[-80, 0], [80, 0]], { curved: false, profile: defaultProfile() }).network });
    const c = await start([def({ radius: 80, amount: 0.5 })]);
    c.advance(4);
    const st = c.getRuntime()!.roads!.segments.find((s) => s.deform)!;
    expect(st.deform!.passable).toBe(true);
    expect(st.deform!.grade).toBeGreaterThan(st.deform!.grade0);
    // Steepest grade of a smooth bowl: A·π/(2R).
    expect(st.deform!.grade).toBeLessThan((0.5 * Math.PI) / 160 + 0.01);
    c.unload();
  });
});

describe('water and the moving bed', { timeout: 300_000 }, () => {
  const lake = (extra: Partial<LakeFeature> = {}): LakeFeature => ({ id: 'f1', kind: 'lake', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]], surface: -0.3, depth: 2.5, shoreWidth: 6, material: 7, filled: true, ...extra });
  const lakeDoc = () => {
    S().setFeatures([lake()], 2);
    const d = structuredClone(S().doc);
    d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    return d;
  };

  it('subsidence under a lake: depth preserved at the update, water mass exact, surface follows; designs untouched', async () => {
    const d = lakeDoc();
    const features = JSON.stringify(S().doc.landscape);
    const c = await start([], d);
    c.advance(1);
    const f = fieldOf(c);
    const v0 = f.totalVolume();
    const cell = f.sampleCell(0, 0)!.index;
    const h0 = f.h[cell], bed0 = f.bed[cell];
    c.addEvent(def({ radius: 20, amount: 1, profile: 'instant' }));
    c.advance(1 / 60);
    // Right after the update: the column moved down with the bed — same depth, bed −1 m.
    // (The cell bed is the weighted mean of its corners: slightly less than the −1 m peak.)
    expect(f.bed[cell] - bed0).toBeLessThan(-0.99);
    expect(f.bed[cell] - bed0).toBeGreaterThan(-1.0001);
    expect(Math.abs(f.h[cell] - h0)).toBeLessThan(0.02); // (the solver also ran in this step)
    expect(f.bedMotion.displacedVolume).toBeGreaterThan(0);
    // The instant drop starts a slosh (seiche, period ≈ 2L/√(gh) ≈ 20 s). Time-averaged, the
    // surface is level at one elevation below the original (no water was created to fill the
    // bowl), and the slosh amplitude decays.
    const eta = (x: number, z: number) => f.sampleSurface(x, z);
    const window = (seconds: number) => {
      let a = 0, b = 0, amp = 0, n = 0;
      for (let k = 0; k < seconds * 2; k++) {
        c.advance(0.5);
        const p = eta(0, 0), q = eta(-22, 0);
        a += p; b += q; n++;
        amp = Math.max(amp, Math.abs(p - q));
      }
      return { center: a / n, side: b / n, amp };
    };
    const early = window(40);
    const late = window(80);
    expect(Math.abs(f.totalVolume() - v0) / v0).toBeLessThan(1e-6);
    expect(late.amp).toBeLessThan(early.amp);
    expect(Math.abs(late.center - late.side)).toBeLessThan(0.03);
    expect(late.side).toBeLessThan(-0.3);
    expect(JSON.stringify(S().doc.landscape)).toBe(features);
    c.unload();
  });

  it('bed update alone: depths unchanged exactly, volume unchanged exactly, moved volume and work recorded', () => {
    const t = runtimeTerrain(S().doc.terrain);
    const sampler = samplerFor(t);
    const f = new WaterField(sampler, { ...defaultWaterSettings(), infiltration: false });
    f.h.fill(0.5);
    const h = f.h.slice(), v0 = f.totalVolume();
    for (let iz = 90; iz <= 110; iz++) for (let ix = 90; ix <= 110; ix++) t.heights[iz * t.nx + ix] -= 0.7;
    t.revision++;
    sampler.sync();
    const n = f.applyBedChange({ x0: 90, z0: 90, x1: 110, z1: 110 });
    expect(n).toBeGreaterThan(0);
    expect(Array.from(f.h)).toEqual(Array.from(h));
    expect(f.totalVolume()).toBe(v0);
    expect(f.bedMotion.maxDrop).toBeCloseTo(0.7, 5);
    expect(f.bedMotion.displacedVolume).toBeGreaterThan(0);
    expect(f.bedMotion.work).toBeLessThan(0); // the column lost potential energy
  });

  it('uplift under a lake raises the bed and the water; mass is conserved', async () => {
    const c = await start([], lakeDoc());
    c.advance(1);
    const f = fieldOf(c);
    const v0 = f.totalVolume();
    const etaBefore = f.sampleSurface(0, 0);
    c.addEvent(def({ kind: 'uplift', radius: 60, amount: 0.5, profile: 'linear', duration: 2, falloff: 'steep' }));
    c.advance(10);
    expect(f.sampleSurface(0, 0)).toBeGreaterThan(etaBefore + 0.3);
    expect(Math.abs(f.totalVolume() - v0) / v0).toBeLessThan(1e-6);
    expect(f.bedMotion.maxRise).toBeGreaterThan(0);
    c.unload();
  });

  it('flood + deformation: standing water drains into a subsiding bowl; the volume stays exact', async () => {
    const doc = structuredClone(S().doc);
    const w = defaultWaterSettings();
    for (const side of ['N', 'E', 'S', 'W'] as const) w.boundaries[side] = { type: 'closed' };
    doc.settings.simulation.water = { ...w, infiltration: false, drainageCapacity: 0 };
    // A 0.2 m sheet of water everywhere (saved water state on the original ground) + light rain to start the model.
    const sheet = new WaterField(samplerFor(doc.terrain), doc.settings.simulation.water);
    sheet.h.fill(0.2);
    const c = new SimulationController({ headless: true });
    c.setInitialWaterState(captureWaterState(sheet, 0));
    await c.load(doc);
    const rain = { ...(phenomena.implemented('rain')!.defaults() as EventSpec), intensity: 1, duration: 1 } as EventSpec;
    c.addEvent(rain);
    c.addEvent(def({ radius: 30, amount: 1, profile: 'linear', duration: 10 }));
    c.advance(1);
    const f = fieldOf(c);
    const v1 = f.totalVolume();
    c.advance(59);
    expect(f.sampleDepth(0, 0)).toBeGreaterThan(0.2 + 0.5);
    expect(f.sampleDepth(80, 80)).toBeLessThan(0.2);
    // Only the 1 s of 1 mm/h rain enters after t = 1 (≈ 0.01 m³): the bed motion adds or removes no water.
    expect(Math.abs(f.totalVolume() - v1 - (f.budget.rain - 0))).toBeLessThan(Math.max(1e-6 * v1, f.budget.rain + 1e-6));
    expect(Math.abs(f.budget.error)).toBeLessThan(1e-6 * f.totalVolume());
    c.unload();
  });
});

describe('multi-hazard, determinism, step size', { timeout: 300_000 }, () => {
  it('earthquake + subsidence: damage keeps its hazard, the residual strength is an envelope (no double count)', async () => {
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(12, 0) }] });
    const quake = phenomena.implemented('earthquake')!.defaults() as EventSpec;
    const c = await start([quake, def({ radius: 25, amount: 1 })]);
    c.advance(12);
    const ev = c.getDamageEvents();
    const hazards = new Set(ev.map((e) => e.hazard));
    expect(hazards.has('ground')).toBe(true);
    const b = byType(c, 'building')[0];
    // One state per entity, the worst of its hazards; ground damage stays in its own record.
    expect(b.ground!.damage).toBeGreaterThan(0);
    expect(b.ground!.damage).toBeLessThanOrEqual(1);
    c.unload();
  });

  it('two identical runs are identical (heights, poses, events); chunking of advance() does not matter', async () => {
    S().applyEdit({ add: [
      { type: 'building', building: house(), seed: 1, transform: tf(10, 0) },
      { type: 'car', seed: 2, transform: tf(-5, 3) },
      { type: 'tree', seed: 3, transform: tf(0, -9) },
    ] });
    const specs = [def({ kind: 'settlement', radius: 40, variability: 0.5, amount: 1 }), def({ kind: 'ridge', center: [0, 20], radius: 6, length: 50, bearing: 70, amount: 0.8 })];
    const snap = (c: SimulationController) => ({
      h: Array.from(c.getEnvironment().terrain.data.heights),
      p: [...c.getRuntime()!.entities.values()].map((e) => [...e.pose.position, ...e.pose.quaternion].map((v) => v.toFixed(6))),
      ev: c.getDamageEvents().map((e) => `${e.time.toFixed(4)}:${e.objectType}:${e.eventType}`),
    });
    const a = await start(specs);
    a.advance(5);
    const sa = snap(a);
    a.unload();
    const b = await start(specs);
    for (let i = 0; i < 50; i++) b.advance(0.1);
    const sb = snap(b);
    b.unload();
    expect(sb.h).toEqual(sa.h);
    expect(sb.p).toEqual(sa.p);
    expect(sb.ev).toEqual(sa.ev);
  });

  it('the comparison runner reports ground damage separately from the other hazards', async () => {
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(10, 0) }] });
    const inst = [{ id: 'p1', type: 'terrainDeformation', spec: def({ radius: 22, amount: 1.2 }), enabled: true, start: { at: 0 }, visualize: true }];
    const res = await runComparison(S().doc, inst, defaultScenarios(inst), { duration: 6 });
    expect(res).toHaveLength(1);
    expect(res[0].eventsByHazard.ground).toBeGreaterThan(0);
    expect(res[0].eventsByHazard.flood).toBe(0);
  });
});

describe('save / load', () => {
  it('the experiment keeps its deformation (schema unchanged); invalid specs are dropped with the file still loading', () => {
    S().setExperiment({ instances: [
      { id: 'p1', type: 'terrainDeformation', spec: def({ kind: 'ridge', length: 40, bearing: 30, supportLoss: 0.2 }), enabled: true, start: { at: 2 }, visualize: true, seed: 5 },
      { id: 'p2', type: 'terrainDeformation', spec: def({ radius: 1 }), enabled: true, start: { at: 0 }, visualize: true },
    ] });
    const text = serializeDocument(S().doc);
    expect(JSON.parse(text).schemaVersion).toBe(SCHEMA_VERSION);
    const r = parseDocument(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = r.doc.scenario.experiment!.instances;
    expect(inst.map((i) => i.id)).toEqual(['p1']);
    expect(inst[0].spec).toMatchObject({ kind: 'ridge', length: 40, bearing: 30, supportLoss: 0.2, radius: 25 });
    expect(inst[0].seed).toBe(5);
    // Nothing of a run is in the file: no runtime field, no deformed heights.
    expect(text).not.toContain('deformation"');
  });
});
