/**
 * Sinkholes and landslides in a running simulation (Phase 22): initiation against closed forms,
 * progression and emergent pit geometry, foundations, stability with / without triggers, the
 * order of rain and earthquake, transport, sediment / terrain budget, water displacement,
 * roads, attribution, determinism, restoration, save / load, collider = render.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import { defaultWaterSettings } from '@/core/model';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { SCHEMA_VERSION } from '@/world/WorldDocument';
import { worldFingerprint } from '@/world/fingerprint';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import type { EventSpec } from '@/events/specs';
import type { LandslideSpec, SinkholeSpec } from '@/ground/types';
import type { LakeFeature } from '@/landscape/types';
import { MECHANICAL_PROFILES, DEG, unitWeight, GAMMA_W } from '@/ground/materials';
import { criticalCavityRadius, infiniteSlopeFS } from '@/ground/stability';
import { ROAD_BLOCK_DEPTH } from '../systems/GroundFailureSystem';
import { SYNC_TOLERANCE } from './GroundFailureChannel';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const house = () => createDesign(presetSpec('house')!, 'house');
const physicsOf = (c: SimulationController) => (c as unknown as { physics: PhysicsEngine }).physics;
const gf = (c: SimulationController) => c.getEnvironment().groundFailure;

const sink = (x: Partial<SinkholeSpec> = {}): SinkholeSpec => ({ event: 'sinkhole', center: [0, 0], cavityRadius: 2, cavityHeight: 6, cover: 6, initiation: 'growth', growthRate: 0.1, duration: 60, ...x });
const slide = (x: Partial<LandslideSpec> = {}): LandslideSpec => ({ event: 'landslide', area: { kind: 'circle', center: [-30, 0], radius: 12 }, thickness: 1.5, saturation: 0.2, trigger: 'saturation', targetSaturation: 1, duration: 10, ...x });

/** A plane descending toward +x at `deg` from x = -90 to x = 0, flat beyond (surface material `ground`). */
function slopeWorld(deg: number, ground = 0, soil = 1) {
  S().setLocked(false);
  S().newDocument();
  const t0 = S().doc.terrain;
  const heights = new Float32Array(t0.heights.length);
  const tb = Math.tan(deg * DEG);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) {
    const x = t0.originX + ix * t0.cellSize;
    heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0;
  }
  S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length).fill(ground) } } });
  if (soil !== 1) {
    // Soil profile map (Phase 13) — selects the default mechanical profile.
    const t = S().doc.terrain;
    t.soil.fill(soil);
  }
  return structuredClone(S().doc);
}

async function start(doc: ReturnType<typeof slopeWorld>, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}

/** Terrain change ΣG·A must equal the sediment budget (cavity, in situ, bulked, outflow). */
function terrainBudgetError(c: SimulationController) {
  const f = gf(c).field!;
  const b = f.budget;
  let g = 0;
  for (let i = 0; i < f.n; i++) g += f.bed[i] + f.h[i];
  g *= f.dx * f.dx;
  const expected = -b.intoCavity - b.releasedInSitu + b.released - b.outflow;
  return Math.abs(g - expected) / Math.max(1, Math.abs(b.released) + b.intoCavity);
}

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('sinkhole', { timeout: 300_000 }, () => {
  const dense = MECHANICAL_PROFILES.denseGranular;
  const roof = { H: 6, c: dense.cohesion + dense.apparentCohesion, phi: dense.friction * DEG, gamma: unitWeight(dense), m: 0, q: 0 };

  it('growth: the roof fails when the cavity reaches the critical radius of the plug model (within one update)', async () => {
    S().newDocument();
    const ac = criticalCavityRadius(roof);
    const rate = 0.05;
    const c = await start(structuredClone(S().doc), [sink({ cavityRadius: 1, growthRate: rate, duration: 200 })]);
    const expected = (ac - 1) / rate;
    c.advance(expected - 1);
    expect(gf(c).sinkholes[0].phase).toBe('stable');
    expect(gf(c).sinkholes[0].fs).toBeGreaterThan(1);
    c.advance(1.5);
    const m = gf(c).sinkholes[0];
    expect(m.phase).not.toBe('stable');
    expect(m.a).toBeCloseTo(ac, 1);
    c.unload();
  });

  it('support loss / water / load: each fails exactly when its input crosses FS = 1; dry, unloaded, intact roofs hold', async () => {
    S().newDocument();
    const doc = structuredClone(S().doc);
    // Prescribed loss: FS(t) = FS0·(1 − L·t/D) = 1 at t = D·(1 − 1/FS0)/L.
    const a = 1.5;
    const fs0 = (2 * Math.PI * a * 6 * ((roof.c) + (1 - Math.sin(roof.phi)) * roof.gamma * 3 * Math.tan(roof.phi))) / (Math.PI * a * a * roof.gamma * 6);
    const tFail = (40 * (1 - 1 / fs0)) / 0.9;
    const cl = await start(doc, [sink({ cavityRadius: a, initiation: 'supportLoss', supportLoss: 0.9, duration: 40 })]);
    cl.advance(tFail - 0.5);
    expect(gf(cl).sinkholes[0].phase).toBe('stable');
    cl.advance(1);
    expect(gf(cl).sinkholes[0].phase).not.toBe('stable');
    cl.unload();
    // Water: saturating the cover lowers FS below 1 for a near-critical cavity; a dry one holds.
    const aw = criticalCavityRadius(roof) * 0.9;
    const wet = await start(doc, [sink({ cavityRadius: aw, initiation: 'water', saturation: 1, duration: 20 })]);
    wet.advance(25);
    expect(gf(wet).sinkholes[0].phase).not.toBe('stable');
    wet.unload();
    const dry = await start(doc, [sink({ cavityRadius: aw, initiation: 'water', saturation: 0, duration: 20 })]);
    dry.advance(25);
    expect(gf(dry).sinkholes[0].phase).toBe('stable');
    expect(gf(dry).sinkholes[0].fs).toBeGreaterThan(1);
    dry.unload();
    // Load: a surcharge ramp.
    const load = await start(doc, [sink({ cavityRadius: aw, initiation: 'load', surcharge: 60, duration: 20 })]);
    load.advance(25);
    expect(gf(load).sinkholes[0].phase).not.toBe('stable');
    load.unload();
  });

  it('a building on the plug adds surcharge: the same cavity fails sooner under it', async () => {
    const t = async (withHouse: boolean) => {
      S().newDocument();
      if (withHouse) S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(0, 0) }] });
      const c = await start(structuredClone(S().doc), [sink({ cavityRadius: 1, growthRate: 0.05, duration: 200 })]);
      c.advance(0.1);
      let tt = 0.1;
      while (gf(c).sinkholes[0].phase === 'stable' && tt < 80) { c.advance(0.5); tt += 0.5; }
      c.unload();
      return tt;
    };
    expect(await t(true)).toBeLessThan(await t(false));
  });

  it('a settled pit comes to rest within 40 s (critical-state friction, granular hysteresis, rest by own faces): the terrain stops updating and stays within 1 mm of the field', async () => {
    const c = await start(structuredClone(S().doc), [sink({ cavityRadius: 5, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 2, growthRate: undefined })]);
    c.advance(40);
    const env = c.getEnvironment(), f = gf(c).field!, eng = env.deformation.engine!;
    const u0 = eng.updates;
    c.advance(20);
    // Settled within 40 s and no further terrain update (Phase 22 first version: 200 updates in
    // these 20 s — creep at the repose slope; rest is now decided by the cell's own faces and a
    // settled layer needs the angle of maximum stability to restart).
    expect(eng.updates - u0).toBe(0);
    expect(f.budget.mobile).toBeLessThan(0.01 * f.budget.released);
    const src = gf(c).source!;
    let drift = 0;
    for (let i = 0; i < f.n; i++) drift = Math.max(drift, Math.abs(f.bed[i] + f.h[i] - src.applied[i]));
    expect(drift).toBeLessThanOrEqual(SYNC_TOLERANCE);
    expect(terrainBudgetError(c)).toBeLessThan(1e-6);
    c.unload();
  });

  it('bulking can choke the cavity: no surface collapse; a shallow cover collapses with drop h_c − (B − 1)·H', async () => {
    S().newDocument();
    const doc = structuredClone(S().doc);
    const choked = await start(doc, [sink({ cavityRadius: 9, cavityHeight: 1, cover: 20, growthRate: 0 })]);
    choked.advance(3);
    const m = gf(choked).sinkholes[0];
    expect(m.phase).toBe('choked');
    expect(choked.getEnvironment().terrain.sampleHeight(0, 0)).toBe(0);
    expect(choked.getRuntime()!.log.some((l) => l.message.key === 'log.ground.sinkholeChoked')).toBe(true);
    choked.unload();
    const open = await start(doc, [sink({ cavityRadius: 4, cavityHeight: 6, cover: 4, growthRate: 0 })]);
    open.advance(4);
    const o = gf(open).sinkholes[0];
    expect(o.drop).toBeCloseTo(6 - (MECHANICAL_PROFILES.denseGranular.bulking - 1) * 4, 6);
    expect(gf(open).field!.budget.intoCavity).toBeGreaterThan(0);
    expect(terrainBudgetError(open)).toBeLessThan(1e-6);
    open.unload();
  });

  it('geometry emerges from the material: cohesive covers stay steep, granular covers relax to a wider bowl', async () => {
    const pit = async (soil: number) => {
      S().newDocument();
      S().doc.terrain.soil.fill(soil);
      const c = await start(structuredClone(S().doc), [sink({ cavityRadius: 4, cavityHeight: 8, cover: 5, growthRate: 0 })]);
      c.advance(25);
      const s = gf(c).sinkholes[0];
      const t = c.getEnvironment().terrain;
      let steep = 0;
      for (let x = -12; x <= 12; x++) steep = Math.max(steep, Math.abs(t.sampleHeight(x + 1, 0) - t.sampleHeight(x, 0)));
      const r = { radius: s.pitRadius, steep, depth: -t.sampleHeight(0, 0), events: s.events.map((e) => e.kind) };
      expect(terrainBudgetError(c)).toBeLessThan(1e-6);
      c.unload();
      return r;
    };
    const cohesive = await pit(2), granular = await pit(1);
    expect(cohesive.steep).toBeGreaterThan(granular.steep);
    expect(granular.radius).toBeGreaterThan(cohesive.radius);
    // (Granular walls stand steeper than φ when damp: 2 kPa of apparent cohesion holds a 6 m
    // Culmann wall at ~55° — the model's own result, not a tuning.)
    expect(granular.events).toContain('expansion');
  });

  it('foundations: a house over the pit edge loses contact (foundation failure, ground hazard); a far one is untouched', async () => {
    S().newDocument();
    S().applyEdit({ add: [
      { type: 'building', building: house(), seed: 1, transform: tf(4, 0) },
      { type: 'building', building: house(), seed: 2, transform: tf(60, 60) },
    ] });
    const c = await start(structuredClone(S().doc), [sink({ cavityRadius: 4, cavityHeight: 6, cover: 4, growthRate: 0 })]);
    c.advance(15);
    const [near, far] = [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'building').sort((a, b) => a.initialPose.position[0] - b.initialPose.position[0]);
    expect(near.ground).toBeDefined();
    // Half its footprint is over the plug: the angular distortion passes 1/50 while the plug is
    // still dropping → destroyed (a collapsed building is not refitted afterwards).
    expect(near.state === 4 || near.ground!.minContact < 1).toBe(true);
    expect(near.ground!.peakBeta).toBeGreaterThan(1 / 150);
    expect(c.getMilestones().some((m) => m.kind === 'foundationFailure')).toBe(true);
    expect(far.ground).toBeUndefined();
    expect(far.state).toBe(0);
    expect(c.getMilestones().some((m) => m.kind === 'sinkholeInit')).toBe(true);
    const hz = new Set(c.getDamageEvents().map((e) => e.hazard));
    expect([...hz]).toEqual(['ground']);
    c.unload();
  });
});

describe('landslide stability and triggers', { timeout: 600_000 }, () => {
  const dense = MECHANICAL_PROFILES.denseGranular;
  const fsOf = (deg: number, m: number, z = 1.5) => infiniteSlopeFS({ beta: deg * DEG, z, c: dense.cohesion + dense.apparentCohesion * (1 - m), phi: dense.friction * DEG, gamma: unitWeight(dense), m });

  it('a stable slope does not fail on its own; the same slope fails when saturated (FS crosses 1 as predicted)', async () => {
    const doc = slopeWorld(30);
    expect(fsOf(30, 0.2)).toBeGreaterThan(1);
    expect(fsOf(30, 1)).toBeLessThan(1);
    const still = await start(doc, [slide({ trigger: 'rain', saturation: 0.2 })]);
    still.advance(20);
    expect(gf(still).field!.budget.released).toBe(0);
    expect(gf(still).landslides[0].minFS).toBeGreaterThan(1);
    still.unload();
    const wet = await start(doc, [slide({ trigger: 'saturation', saturation: 0.2, targetSaturation: 1, duration: 10 })]);
    // m at which FS = 1 (bisection on the closed form) → the failure time on the ramp.
    let lo = 0.2, hi = 1;
    for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (fsOf(30, mid) > 1) lo = mid; else hi = mid; }
    const tFail = ((lo - 0.2) / 0.8) * 10;
    wet.advance(Math.max(0, tFail - 0.4));
    expect(gf(wet).field!.budget.released).toBe(0);
    wet.advance(0.8);
    expect(gf(wet).field!.budget.released).toBeGreaterThan(0);
    expect(wet.getMilestones().some((m) => m.kind === 'landslideInit')).toBe(true);
    wet.unload();
  });

  it('rain infiltration raises the water table and triggers a near-critical slope; without rain it stands', async () => {
    // Sand surface (permeable) and a 10× infiltration setting so the test runs in minutes of simulated time.
    const doc = slopeWorld(30, 2);
    doc.settings.simulation.water = { ...defaultWaterSettings(), infiltrationScale: 10 };
    let mc = 0.2;
    for (let k = 0; k < 60; k++) if (fsOf(30, mc + 0.01) > 1) mc += 0.01;
    const m0 = Math.max(0, mc - 0.04);
    const rain: EventSpec = { event: 'rain', intensity: 300, duration: 600 } as EventSpec;
    const dry = await start(doc, [slide({ trigger: 'rain', saturation: m0 })]);
    dry.advance(60);
    expect(gf(dry).field!.budget.released).toBe(0);
    dry.unload();
    const wet = await start(doc, [rain, slide({ trigger: 'rain', saturation: m0 })]);
    wet.advance(300);
    const f = gf(wet).field!;
    expect(f.budget.released).toBeGreaterThan(0);
    // Water stays exact while the bed moves under it.
    const wf = wet.getEnvironment().flood.field!;
    expect(Math.abs(wf.budget.error)).toBeLessThan(1e-6 * Math.max(1, wf.totalVolume()));
    wet.unload();
  });

  it('earthquake: Newmark sliding fails a marginal slope only when it is wet — the order of rain and shaking matters', async () => {
    const doc = slopeWorld(28);
    const quake = (t: number): EventSpec => ({ event: 'earthquake', magnitude: 7, pga: 0.45, duration: 15, seed: 3, startTime: t } as EventSpec);
    // Saturation 0.2 → m₁ between t = 0 and 10 s, m₁ chosen so the slope stays statically stable (FS ≈ 1.06).
    let m1 = 0.2;
    while (fsOf(28, m1 + 0.01) > 1.06) m1 += 0.01;
    expect(fsOf(28, m1)).toBeGreaterThan(1);
    const spec = slide({ area: { kind: 'circle', center: [-40, 0], radius: 15 }, saturation: 0.2, targetSaturation: m1, duration: 10, trigger: 'earthquake' });
    const run = async (quakeAt: number) => {
      const c = await start(doc, [{ ...spec, trigger: 'saturation' } as EventSpec, quake(quakeAt)]);
      c.advance(quakeAt + 18);
      const r = { released: gf(c).field!.budget.released, maxD: gf(c).landslides[0].maxNewmark, seismic: gf(c).landslides[0].failedSeismic };
      c.unload();
      return r;
    };
    const early = await run(0.1); // shaking while still dry
    const late = await run(12); // shaking after the wetting
    expect(late.maxD).toBeGreaterThan(early.maxD);
    expect(late.seismic).toBeGreaterThan(0);
    expect(late.released).toBeGreaterThan(early.released);
  });
});

describe('sediment transport', { timeout: 600_000 }, () => {
  it('moves downhill, deposits at the toe, comes to rest; the budget and the terrain change agree', async () => {
    const doc = slopeWorld(30);
    const c = await start(doc, [slide({ trigger: 'user', saturation: 1, area: { kind: 'circle', center: [-25, 0], radius: 10 } })]);
    c.advance(1);
    const f = gf(c).field!;
    const com = () => {
      let m = 0, x = 0;
      for (let i = 0; i < f.n; i++) { const v = f.h[i] + f.loose[i]; if (v > 0) { m += v; x += v * (f.originX + (i % f.nx) * f.dx); } }
      return x / m;
    };
    const x0 = com();
    c.advance(40);
    expect(com()).toBeGreaterThan(x0 + 3); // downslope = +x
    expect(f.budget.mobile).toBeLessThan(0.05 * f.budget.released); // at rest
    expect(Math.abs(f.budget.residual)).toBeLessThan(1e-6 * f.budget.released);
    expect(Math.abs(f.budget.residualMass)).toBeLessThan(1e-6 * f.budget.releasedMass);
    expect(terrainBudgetError(c)).toBeLessThan(1e-6);
    // Mass differs from volume × in-situ density by the bulking (volume grew, mass did not).
    expect(f.budget.released).toBeGreaterThan(f.budget.releasedInSitu);
    // Collider = render on the changed ground.
    const ph = physicsOf(c), t = c.getEnvironment().terrain;
    let worst = 0;
    for (let x = -40; x <= 20; x += 2.3) for (let z = -15; z <= 15; z += 2.9) worst = Math.max(worst, Math.abs(50 - ph.castGroundRay([x, 50, z], [0, -1, 0], 200)! - t.sampleHeight(x, z)));
    expect(worst).toBeLessThan(1e-3);
    expect(c.getMilestones().some((m) => m.kind === 'peakSediment')).toBe(true);
    c.unload();
  });

  it('open edges: sediment leaving the world is recorded and the budget still closes', async () => {
    const doc = slopeWorld(35);
    const c = await start(doc, [slide({ trigger: 'user', saturation: 1, boundary: 'open', area: { kind: 'circle', center: [-85, 0], radius: 12 } })]);
    c.advance(30);
    const b = gf(c).field!.budget;
    expect(b.released).toBeGreaterThan(0);
    expect(Math.abs(b.residual)).toBeLessThan(1e-6 * b.released);
    c.unload();
  });

  it('into a lake: water displaced by the deposit raises the level; water mass exact', async () => {
    S().setLocked(false);
    S().newDocument();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[0, -40], [60, -40], [60, 40], [0, 40]], surface: -0.3, depth: 3, shoreWidth: 4, material: 7, filled: true };
    const t0 = S().doc.terrain;
    const heights = new Float32Array(t0.heights.length);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * Math.tan(32 * DEG) : 0; }
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
    S().setFeatures([lake], 2);
    const doc = structuredClone(S().doc);
    doc.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    const c = await start(doc, []);
    c.advance(1);
    const w = c.getEnvironment().flood.field!;
    const meanEta = () => { let s = 0, n = 0; for (let x = 20; x <= 56; x += 4) for (let z = -32; z <= 32; z += 4) { s += w.sampleSurface(x, z); n++; } return s / n; };
    const v0 = w.totalVolume(), eta0 = meanEta();
    c.addEvent(slide({ trigger: 'user', saturation: 1, area: { kind: 'circle', center: [-12, 0], radius: 10 } }));
    c.advance(60);
    let eta = 0;
    for (let k = 0; k < 20; k++) { c.advance(1); eta += meanEta() / 20; }
    expect(Math.abs(w.totalVolume() - v0) / v0).toBeLessThan(1e-6);
    // The deposit below the water line displaces its volume: the (time-averaged) level rises.
    const f = c.getEnvironment().groundFailure.field!;
    let sub = 0;
    for (let i = 0; i < f.n; i++) {
      const x = f.originX + (i % f.nx) * f.dx;
      if (x > 1 && f.loose[i] + f.h[i] > 0) sub += f.loose[i] + f.h[i];
    }
    expect(sub).toBeGreaterThan(0);
    expect(eta).toBeGreaterThan(eta0);
    c.unload();
  });
});

describe('roads, objects, attribution', { timeout: 600_000 }, () => {
  it('a road at the toe is blocked by the deposit; the network is never edited; damage is ground / landslide only', async () => {
    S().setLocked(false);
    S().newDocument();
    const doc0 = slopeWorld(32);
    S().replaceDocument(doc0);
    S().applyEdit({ roads: drawRoad(emptyNetwork(), [[3, -60], [3, 60]], { curved: false, profile: defaultProfile() }).network });
    S().applyEdit({ add: [{ type: 'car', seed: 3, transform: tf(6, 4) }, { type: 'streetLight', seed: 4, transform: tf(2, -3) }] });
    const roads = JSON.stringify(S().doc.roads);
    const c = await start(structuredClone(S().doc), [slide({ trigger: 'user', saturation: 1, thickness: 2.5, area: { kind: 'circle', center: [-14, 0], radius: 12 } })]);
    c.advance(40);
    const rs = c.getRuntime()!.roads!.segments;
    const blocked = rs.filter((s) => s.deform && !s.deform.passable);
    expect(blocked.length).toBeGreaterThan(0);
    expect(Math.max(...rs.map((s) => s.deform?.debris ?? 0))).toBeGreaterThanOrEqual(ROAD_BLOCK_DEPTH);
    expect(c.getMilestones().some((m) => m.kind === 'roadBlocked')).toBe(true);
    expect(JSON.stringify(S().doc.roads)).toBe(roads);
    const ev = c.getDamageEvents();
    expect(ev.length).toBeGreaterThan(0);
    expect(new Set(ev.map((e) => e.hazard))).toEqual(new Set(['ground']));
    expect(ev.filter((e) => e.source).every((e) => e.source!.startsWith('landslide:'))).toBe(true);
    c.unload();
  });

  it('subsidence + landslide (no wind): nothing is attributed to wind', async () => {
    const doc = slopeWorld(30);
    S().replaceDocument(doc);
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(10, 0) }, { type: 'building', building: house(), seed: 2, transform: tf(-10, 25) }] });
    const c = await start(structuredClone(S().doc), [
      { event: 'terrainDeformation', kind: 'subsidence', center: [-10, 25], radius: 15, amount: 1.2, duration: 3, profile: 'smooth' } as EventSpec,
      slide({ trigger: 'user', saturation: 1, area: { kind: 'circle', center: [-12, 0], radius: 10 } }),
    ]);
    c.advance(30);
    const ev = c.getDamageEvents();
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.some((e) => e.hazard === 'wind')).toBe(false);
    c.unload();
  });

  it('buildings in the runout are loaded by the sediment and damaged by the ground hazard', async () => {
    const doc = slopeWorld(34);
    S().replaceDocument(doc);
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(6, 0) }] });
    const c = await start(structuredClone(S().doc), [slide({ trigger: 'user', saturation: 1, thickness: 3, area: { kind: 'circle', center: [-16, 0], radius: 14 } })]);
    c.advance(40);
    const b = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'building')!;
    expect(b.ground?.debrisRatio ?? 0).toBeGreaterThan(0);
    expect(b.ground!.overburden).toBeGreaterThan(0);
    expect(b.state).toBeGreaterThanOrEqual(1);
    c.unload();
  });
});

describe('determinism, restoration, save / load', { timeout: 600_000 }, () => {
  it('two identical multi-hazard runs are identical; chunking of advance() does not matter', async () => {
    const doc = slopeWorld(30);
    S().replaceDocument(doc);
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(10, 0) }, { type: 'car', seed: 2, transform: tf(15, 8) }] });
    const d = structuredClone(S().doc);
    const events: EventSpec[] = [
      slide({ trigger: 'saturation', saturation: 0.3, targetSaturation: 1, duration: 8, variability: 0.3 }),
      sink({ center: [40, 40], cavityRadius: 1.5, growthRate: 0.1, variability: 0.2 }),
      { event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 8, seed: 4 } as EventSpec,
    ];
    const snap = (c: SimulationController) => ({
      h: Array.from(c.getEnvironment().terrain.data.heights),
      p: [...c.getRuntime()!.entities.values()].map((e) => [...e.pose.position].map((v) => v.toFixed(5))),
      b: JSON.stringify(gf(c).field!.budget),
      ev: c.getDamageEvents().map((e) => `${e.time.toFixed(4)}:${e.eventType}:${e.hazard}`),
    });
    const a = await start(d, events);
    a.advance(20);
    const sa = snap(a);
    a.unload();
    const b = await start(d, events);
    for (let k = 0; k < 40; k++) b.advance(0.5);
    const sb = snap(b);
    b.unload();
    expect(sb.h).toEqual(sa.h);
    expect(sb.p).toEqual(sa.p);
    expect(sb.b).toEqual(sa.b);
    expect(sb.ev).toEqual(sa.ev);
  });

  it('the document is never changed; a reset restores the original ground and a re-run reproduces the result', async () => {
    const doc = slopeWorld(30);
    S().replaceDocument(doc);
    const fp = worldFingerprint(S().doc);
    const h0 = Array.from(S().doc.terrain.heights);
    const ev: EventSpec[] = [slide({ trigger: 'user', saturation: 1 }), sink({ center: [40, 0] })];
    const c = await start(structuredClone(S().doc), ev);
    c.advance(15);
    const after = Array.from(c.getEnvironment().terrain.data.heights);
    expect(worldFingerprint(S().doc)).toBe(fp);
    expect(Array.from(S().doc.terrain.heights)).toEqual(h0);
    await c.reset();
    expect(c.getEnvironment().groundFailure.field).toBeNull();
    expect(Array.from(c.getEnvironment().terrain.data.heights)).toEqual(h0);
    // The reset keeps the run's scenario: the same events run again from t = 0.
    c.advance(15);
    expect(Array.from(c.getEnvironment().terrain.data.heights)).toEqual(after);
    c.unload();
  });

  it('sinkholes and landslides (polygon area) are saved in the experiment; invalid ones are dropped; schema unchanged', () => {
    S().setExperiment({ instances: [
      { id: 'p1', type: 'sinkhole', spec: sink({ material: 'cohesive', initiation: 'water', saturation: 0.8, variability: 0.2 }), enabled: true, start: { at: 0 }, visualize: true, seed: 7 },
      { id: 'p2', type: 'landslide', spec: slide({ area: { kind: 'polygon', points: [[-40, -10], [-20, -10], [-20, 10], [-40, 10]] }, trigger: 'earthquake', newmarkLimit: 0.05, boundary: 'open', material: 'fill' }), enabled: true, start: { at: 2 }, visualize: true },
      { id: 'p3', type: 'sinkhole', spec: sink({ cover: 500 }), enabled: true, start: { at: 0 }, visualize: true },
    ] });
    const text = serializeDocument(S().doc);
    expect(JSON.parse(text).schemaVersion).toBe(SCHEMA_VERSION);
    const r = parseDocument(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = r.doc.scenario.experiment!.instances;
    expect(inst.map((i) => i.id)).toEqual(['p1', 'p2']);
    expect(inst[0].spec).toMatchObject({ material: 'cohesive', initiation: 'water', saturation: 0.8 });
    expect(inst[1].spec).toMatchObject({ trigger: 'earthquake', newmarkLimit: 0.05, boundary: 'open', area: { kind: 'polygon' } });
    expect(text).not.toContain('"releasedInSitu"');
  });

  it('runtime-state manifest: what a mid-run snapshot would need (ground field is state, deformation is derived); the document stays the original', async () => {
    const doc = slopeWorld(35);
    const c = await start(doc, [slide({ trigger: 'user' }), sink({ center: [40, 0], cavityRadius: 4, growthRate: 0, initiation: 'supportLoss', supportLoss: 0.9, duration: 1 })]);
    c.advance(5);
    const m = c.runtimeState();
    const by = new Map(m.map((x) => [x.id, x]));
    expect(by.get('groundFailure')!.kind).toBe('state');
    expect(by.get('groundFailure')!.present).toBe(true);
    expect(by.get('groundFailure')!.bytes).toBeGreaterThan(gf(c).field!.n * 20);
    expect(by.get('deformation')!.kind).toBe('derived');
    expect(by.get('bodies')!.kind).toBe('external');
    expect(by.get('document')!.kind).toBe('document');
    // Saving mid-run serializes the document only: no runtime arrays, the original terrain.
    const text = serializeDocument(S().doc);
    const r = parseDocument(text);
    expect(r.ok && worldFingerprint(r.doc)).toBe(worldFingerprint(doc));
  });
});

void GAMMA_W;
