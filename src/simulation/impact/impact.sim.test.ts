/**
 * Meteoroid / asteroid impacts in a running simulation (Phase 23): crater on the runtime ground at
 * the planned time and size (the same plan as the preview), exact excavation / ejecta / terrain
 * budget, crater walls by material, ejecta deposits on the ground, the ground shock felt through the
 * ground-motion field (superposed with an earthquake, never doubled), damage attributed to the
 * impact (no wind), roads, water, landslides on the modified slope, determinism, restoration,
 * save / load, airburst (no crater, blast source recorded for Phase 24).
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
import type { ImpactSpec } from '@/impact/types';
import type { LakeFeature } from '@/landscape/types';
import { planImpact, shockAt } from '@/impact/plan';
import { DEG } from '@/ground/materials';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const house = () => createDesign(presetSpec('house')!, 'house');
const physicsOf = (c: SimulationController) => (c as unknown as { physics: PhysicsEngine }).physics;
const gf = (c: SimulationController) => c.getEnvironment().groundFailure;
/** A small, fast "what if" impact (no atmosphere): crater of a few metres in ~0.3 s. */
const hit = (x: Partial<ImpactSpec> = {}): ImpactSpec => ({ event: 'impact', target: [0, 0], material: 'stony', diameter: 0.6, speed: 6000, angle: 75, azimuth: 90, entry: 'direct', ...x });

async function start(doc: ReturnType<typeof structuredClone<ReturnType<typeof S>['doc']>>, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}

function flat(soil = 1) {
  S().setLocked(false);
  S().newDocument();
  if (soil !== 1) S().doc.terrain.soil.fill(soil);
  return structuredClone(S().doc);
}

/** Terrain change ΣG·A against the ledgers (sediment + impact), relative. */
function budgetError(c: SimulationController) {
  const f = gf(c).field!;
  let g = 0;
  for (let i = 0; i < f.n; i++) g += f.bed[i] + f.h[i];
  g *= f.dx * f.dx;
  return Math.abs(g - f.expectedTerrainChange()) / Math.max(1, f.budget.excavated);
}

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('crater and ejecta', { timeout: 600_000 }, () => {
  it('the crater forms on the runtime ground at the planned time with the planned size; budgets close; the document is untouched', async () => {
    const doc = flat();
    const fp = worldFingerprint(doc);
    const plan = planImpact(hit(), doc.terrain, 1);
    const c = await start(doc, [hit()]);
    c.advance(plan.timeToImpact - 0.05);
    expect(c.getEnvironment().terrain.sampleHeight(0, 0)).toBe(0);
    c.advance(15);
    const m = gf(c).impacts[0];
    expect(m.formed).toBe(true);
    // Centre lowered by about the transient depth (wall slumping may fill it partly).
    const h0 = c.getEnvironment().terrain.sampleHeight(plan.arc.point[0], plan.arc.point[2]);
    expect(h0).toBeLessThan(-0.4 * plan.crater!.depth);
    const f = gf(c).field!, b = f.budget;
    // Exact balance: cut − rim uplift = ejected (in place), and the ledgers match the terrain.
    expect(Math.abs(b.excavated - b.uplifted - b.ejectedInSitu) / b.excavated).toBeLessThan(1e-9);
    expect(budgetError(c)).toBeLessThan(1e-6);
    expect(Math.abs(b.residual)).toBeLessThan(1e-6 * Math.max(1, b.released));
    expect(Math.abs(b.residualMass)).toBeLessThan(1e-6 * Math.max(1, b.releasedMass));
    // All ejecta landed: deposited + out of the world = launched (nothing left in the air).
    expect(b.airborne).toBeLessThan(1e-9 * Math.max(1, b.released));
    expect(b.deposited + b.outflow).toBeGreaterThan(0);
    // Ejecta deposit outside the rim; the document never changed.
    let outside = 0;
    for (let i = 0; i < f.n; i++) {
      const x = f.originX + (i % f.nx) * f.dx, z = f.originZ + Math.floor(i / f.nx) * f.dx;
      if (Math.hypot(x - plan.arc.point[0], z - plan.arc.point[2]) > plan.crater!.radius * 1.2) outside += f.loose[i];
    }
    expect(outside).toBeGreaterThan(0);
    expect(worldFingerprint(S().doc)).toBe(fp);
    expect(c.getMilestones().map((x) => x.kind)).toEqual(expect.arrayContaining(['impactEntry', 'impact', 'craterFormed', 'ejectaLanding']));
    // Collider = render on the crater.
    const ph = physicsOf(c), t = c.getEnvironment().terrain;
    let worst = 0;
    for (let x = -6; x <= 6; x += 1.3) for (let z = -6; z <= 6; z += 1.7) worst = Math.max(worst, Math.abs(50 - ph.castGroundRay([x, 50, z], [0, -1, 0], 200)! - t.sampleHeight(x, z)));
    expect(worst).toBeLessThan(1e-3);
    c.unload();
  });

  it('crater walls follow the material: saturated sand (no suction) slumps to its repose angle; damp sand and rock stand at the bowl slope', async () => {
    const steepest = async (soil: number, wet: boolean) => {
      const doc = flat(soil);
      const c = await start(doc, [hit({ diameter: 1, speed: 6000, angle: 90 })]);
      c.advance(0.01);
      if (wet) gf(c).field ?? gf(c).ensure();
      if (wet) gf(c).field!.water0.fill(1);
      c.advance(40);
      const t = c.getEnvironment().terrain;
      let s = 0;
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) for (let r = 0.5; r < 8; r += 0.5) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        s = Math.max(s, Math.abs(t.sampleHeight(x + Math.cos(a) * 0.5, z + Math.sin(a) * 0.5) - t.sampleHeight(x - Math.cos(a) * 0.5, z - Math.sin(a) * 0.5)));
      }
      c.unload();
      return Math.atan(s) / DEG;
    };
    const wet = await steepest(1, true), damp = await steepest(1, false), rock = await steepest(0, false);
    // Saturated dense sand: no apparent cohesion, settled debris at ≤ φcv + hysteresis (+ one-cell discretization).
    expect(wet).toBeLessThan(40);
    // Damp sand (2 kPa suction) stands: Culmann critical height > crater depth; rock is never checked.
    expect(damp).toBeGreaterThan(wet);
    expect(rock).toBeGreaterThan(wet);
  });
});

describe('ground shock and objects', { timeout: 600_000 }, () => {
  it('the shock reaches objects through the ground-motion field with the planned peak; damage is the impact\'s, never wind', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(14, 0) }, { type: 'building', building: house(), seed: 2, transform: tf(40, 10) }, { type: 'car', seed: 3, transform: tf(9, -8) }, { type: 'human', seed: 4, transform: tf(-7, 6) }, { type: 'streetLight', seed: 5, transform: tf(-10, -6) }] });
    const doc = structuredClone(S().doc);
    const spec = hit({ diameter: 1.5, speed: 8000 });
    const plan = planImpact(spec, doc.terrain, 1);
    const c = await start(doc, [spec]);
    c.advance(plan.timeToImpact + 3);
    const rt = c.getRuntime()!;
    const far = [...rt.entities.values()].find((e) => e.source.type === 'building' && e.initialPose.position[0] === 40)!;
    const r = Math.hypot(40 - plan.arc.point[0], 10 - plan.arc.point[2]);
    const expected = shockAt(plan, r).pgaApplied;
    expect(far.seismic!.pgaImpact).toBeGreaterThan(0.8 * expected);
    expect(far.seismic!.pgaImpact).toBeLessThan(1.25 * expected);
    expect(far.seismic!.pgaQuake).toBe(0);
    c.advance(10);
    const ev = c.getDamageEvents();
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.some((e) => e.hazard === 'wind')).toBe(false);
    expect(ev.some((e) => e.hazard === 'impact')).toBe(true);
    expect(ev.filter((e) => e.hazard === 'impact').every((e) => !e.source || e.source.startsWith('impact:'))).toBe(true);
    c.unload();
  });

  it('impact + earthquake: both shake the same field (superposition, recorded separately); shaking damage goes to the governing source', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(60, 0) }, { type: 'building', building: house(), seed: 2, transform: tf(12, 0) }] });
    const doc = structuredClone(S().doc);
    const c = await start(doc, [{ event: 'earthquake', magnitude: 6, pga: 0.15, duration: 12, seed: 3 } as EventSpec, hit({ diameter: 1.5, speed: 8000, startTime: 3 })]);
    c.advance(10);
    const rt = c.getRuntime()!;
    for (const e of rt.entities.values()) {
      if (e.source.type !== 'building') continue;
      expect(e.seismic!.pgaQuake).toBeGreaterThan(0);
      expect(e.seismic!.pgaImpact).toBeGreaterThan(0);
      // Total peak never exceeds the sum of the parts (no doubling).
      expect(e.seismic!.pga).toBeLessThanOrEqual(e.seismic!.pgaQuake + e.seismic!.pgaImpact + 1e-9);
    }
    const near = [...rt.entities.values()].find((e) => e.initialPose.position[0] === 12)!;
    expect(near.seismic!.pgaImpact).toBeGreaterThan(near.seismic!.pgaQuake);
    c.unload();
  });

  it('a road across the crater: cut and / or blocked by ejecta (impassable), the network itself unchanged', async () => {
    flat();
    S().applyEdit({ roads: drawRoad(emptyNetwork(), [[-80, 0], [80, 0]], { curved: false, profile: defaultProfile() }).network });
    const doc = structuredClone(S().doc);
    const roads = JSON.stringify(doc.roads);
    const c = await start(doc, [hit({ diameter: 1.2, speed: 8000 })]);
    c.advance(15);
    const segs = c.getRuntime()!.roads!.segments;
    expect(segs.some((s) => s.deform && !s.deform.passable)).toBe(true);
    expect(JSON.stringify(S().doc.roads)).toBe(roads);
    c.unload();
  });
});

describe('water, slopes, multi-hazard', { timeout: 600_000 }, () => {
  it('impact into a lake bed: the water follows the bed and its mass stays exact', async () => {
    S().setLocked(false);
    S().newDocument();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]], surface: -0.3, depth: 3, shoreWidth: 4, material: 7, filled: true };
    S().setFeatures([lake], 2);
    const doc = structuredClone(S().doc);
    doc.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    const c = await start(doc, []);
    c.advance(1);
    const w = c.getEnvironment().flood.field!;
    const v0 = w.totalVolume();
    c.addEvent(hit({ diameter: 1, speed: 8000, startTime: c.getTime() }));
    c.advance(20);
    expect(gf(c).impacts[0].formed).toBe(true);
    expect(Math.abs(w.totalVolume() - v0) / v0).toBeLessThan(1e-6);
    c.unload();
  });

  it('a crater cut into the foot of a marginal slope lowers its stability: the slope fails only with the impact', async () => {
    // 28° slope of dense sand, saturation chosen so the slope stands (FS slightly above 1).
    const world = () => {
      S().setLocked(false);
      S().newDocument();
      const t0 = S().doc.terrain;
      const heights = new Float32Array(t0.heights.length);
      for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * Math.tan(34 * DEG) : 0; }
      S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
      return structuredClone(S().doc);
    };
    const slide: EventSpec = { event: 'landslide', area: { kind: 'circle', center: [-12, 0], radius: 10 }, thickness: 1.5, saturation: 0.3, trigger: 'slope', duration: 1 } as EventSpec;
    const run = async (withImpact: boolean) => {
      const c = await start(world(), withImpact ? [slide, hit({ target: [-4, 0], diameter: 1.2, speed: 8000, startTime: 1 })] : [slide]);
      c.advance(25);
      const r = gf(c).landslides[0];
      const out = { failed: r.failedCells, minFS: r.minFS };
      c.unload();
      return out;
    };
    const without = await run(false), withIt = await run(true);
    expect(without.failed).toBe(0);
    expect(withIt.minFS).toBeLessThan(without.minFS);
    expect(withIt.failed).toBeGreaterThan(0);
  });
});

describe('determinism, restoration, save / load, airburst', { timeout: 600_000 }, () => {
  it('two identical runs are identical; chunking of advance() does not matter', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(12, 4) }, { type: 'car', seed: 2, transform: tf(-9, 5) }] });
    const doc = structuredClone(S().doc);
    const run = async (chunks: number[]) => {
      const c = await start(doc, [hit({ diameter: 1.2, speed: 8000 })]);
      for (const k of chunks) c.advance(k);
      const f = gf(c).field!;
      const out = { h: Array.from(c.getEnvironment().terrain.data.heights.slice(19000, 21500)), loose: f.budget.deposited, ev: c.getDamageEvents().map((e) => `${e.objectId}:${e.eventType}:${e.time.toFixed(3)}`) };
      c.unload();
      return out;
    };
    const a = await run([12]), b = await run([3, 4.5, 4.5]);
    expect(a.h).toEqual(b.h);
    expect(a.loose).toBe(b.loose);
    expect(a.ev).toEqual(b.ev);
  });

  it('a reset restores the original ground exactly; a re-run reproduces the crater', async () => {
    const doc = flat();
    const c = await start(doc, [hit()]);
    c.advance(8);
    const h1 = Array.from(c.getEnvironment().terrain.data.heights);
    await c.reset();
    expect(c.getEnvironment().terrain.data.heights.every((v) => v === 0)).toBe(true);
    expect(gf(c).active).toBe(false);
    c.advance(8);
    expect(Array.from(c.getEnvironment().terrain.data.heights)).toEqual(h1);
    c.unload();
  });

  it('impacts are saved in the experiment (schema unchanged); an inconsistent mass is dropped on load', () => {
    flat();
    S().setExperiment({ instances: [
      { id: 'p1', type: 'impact', spec: hit(), enabled: true, start: { at: 2 }, visualize: true },
      { id: 'p2', type: 'impact', spec: hit({ mass: 1 }), enabled: true, start: { at: 0 }, visualize: true },
    ] });
    const text = serializeDocument(S().doc);
    expect(JSON.parse(text).schemaVersion).toBe(SCHEMA_VERSION);
    const r = parseDocument(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = r.doc.scenario.experiment!.instances;
    expect(inst.map((i) => i.id)).toEqual(['p1']);
    expect(inst[0].spec).toMatchObject({ event: 'impact', material: 'stony', entry: 'direct' });
  });

  it('an airburst changes no ground; its energy is recorded as a blast source for Phase 24 (not applied)', async () => {
    const doc = flat();
    const spec: ImpactSpec = { event: 'impact', target: [0, 0], material: 'stony', diameter: 10, speed: 18000, angle: 45, azimuth: 0, entry: 'atmosphere' };
    const plan = planImpact(spec, doc.terrain, 1);
    expect(plan.airburst).toBe(true);
    const c = await start(doc, [spec]);
    c.advance(plan.timeToImpact + 3);
    expect(c.getEnvironment().terrain.data.heights.every((v) => v === 0)).toBe(true);
    const blasts = c.getEnvironment().impact.blasts;
    expect(blasts).toHaveLength(1);
    expect(blasts[0].kind).toBe('airburst');
    expect(blasts[0].energy).toBeGreaterThan(0);
    expect(c.getMilestones().some((m) => m.kind === 'airburst')).toBe(true);
    expect(c.getDamageEvents()).toHaveLength(0);
    c.unload();
  });
});
