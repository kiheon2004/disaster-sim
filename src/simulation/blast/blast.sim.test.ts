/**
 * Air-pressure waves in a running simulation (Phase 24): arrival before any force, ForceLedger
 * path (no duplicates, force = impulse / Δt), preview = run, multiple waves, terrain shielding,
 * facade vs structural building damage, infrastructure, vehicles, people, the impact coupling
 * (energy taken once, ground shock unchanged, damage separated by cause), water conservation,
 * airburst arrival, determinism, restoration and save / load.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { defaultWaterSettings } from '@/core/model';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { SCHEMA_VERSION } from '@/world/WorldDocument';
import { worldFingerprint } from '@/world/fingerprint';
import type { EventSpec } from '@/events/specs';
import type { BlastSpec } from '@/blast/types';
import type { ImpactSpec } from '@/impact/types';
import type { LakeFeature } from '@/landscape/types';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { planBlast } from '@/blast/plan';
import { planImpact } from '@/impact/plan';
import { FORCE_SOURCES, forcesAt } from '@/simulation/forces/ForceLedger';
import { townDoc } from '@/bench/scenes';
import { peakOf } from '@/blast/pulse';
import { NO_SHIELD } from '@/blast/wave';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, yaw = 0) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, yaw, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const house = () => createDesign(presetSpec('house')!, 'house');
const blast = (x: Partial<BlastSpec> = {}): BlastSpec => ({ event: 'blast', position: [0, 0], height: 1, energy: 1e8, model: 'weakShock', waveform: 'nWave', startTime: 0.5, ...x });

async function start(doc: ReturnType<typeof structuredClone<ReturnType<typeof S>['doc']>>, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}

function flat() {
  S().setLocked(false);
  S().newDocument();
  return structuredClone(S().doc);
}

function byType(c: SimulationController, type: string): RuntimeEntity[] {
  return [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === type);
}

const BLAST_INDEX = FORCE_SOURCES.indexOf('blast');

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('arrival, force path, preview = run', { timeout: 600_000 }, () => {
  it('no force before the computed arrival; the blast force is the step impulse through the ledger, never duplicated', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(30, 0) }, { type: 'human', seed: 2, transform: tf(-25, 10) }, { type: 'car', seed: 3, transform: tf(80, 40) }] });
    const doc = structuredClone(S().doc);
    const c = await start(doc, [blast({ energy: 3e8 })]);
    const wave = () => c.getEnvironment().blast.waves[0]?.wave;
    const first = new Map<string, number>();
    for (let k = 0; k < 120; k++) {
      c.advance(1 / 60);
      for (const e of [...byType(c, 'car'), ...byType(c, 'human')]) {
        const f = e.forces![BLAST_INDEX];
        if (f > 0 && !first.has(e.id)) first.set(e.id, c.getTime() - 1 / 60);
      }
    }
    expect(first.size).toBe(3);
    for (const e of [...byType(c, 'car'), ...byType(c, 'human')]) {
      // Earliest arrival anywhere on the body (face nearest the source) — the step containing it.
      const p = e.initialPose.position;
      const r = Math.hypot(p[0], p[2]) - Math.hypot(...e.dims) / 2;
      const ta = wave()!.init.time + wave()!.main.at(r, { dp: 0, T: 0, t: 0, p: 0, zone: 'weak', energyLeft: 1 }).t;
      expect(first.get(e.id)!).toBeGreaterThanOrEqual(ta - 1 / 60 - 1e-9);
      expect(first.get(e.id)!).toBeLessThan(ta + 0.1);
    }
    expect(c.duplicateForces()).toBe(0);
    c.unload();
  });

  it('the preview plan is the run\'s wave: same tables, same arrival and overpressure at a point', async () => {
    const doc = flat();
    const spec = blast({ energy: 5e8, position: [10, -5], height: 3 });
    const plan = planBlast(spec, doc.terrain, doc.settings.airDensity);
    const c = await start(doc, [spec]);
    c.advance(0.6);
    const w = c.getEnvironment().blast.waves[0].wave;
    for (const p of [[40, 1.5, 20], [-60, 1.5, 0], [10, 20, -5]] as const) {
      const a = plan.wave.contributions([...p], NO_SHIELD, []), b = w.contributions([...p], NO_SHIELD, []);
      expect(b.map((x) => x.dp)).toEqual(a.map((x) => x.dp));
      b.forEach((x, k) => expect(x.t - 0.5).toBeCloseTo(a[k].t, 12));
    }
    c.unload();
  });

  it('the energy ledger of the run closes; after the front left the world nothing is in transit', async () => {
    const doc = flat();
    const c = await start(doc, [blast()]);
    for (const t of [0.55, 0.7, 1.5]) {
      c.advance(t - c.getTime());
      const L = c.getEnvironment().blast.ledger(c.getTime())[0];
      expect(Math.abs(L.residual)).toBeLessThan(1e-9 * L.input);
    }
    const L = c.getEnvironment().blast.ledger(c.getTime())[0];
    expect(L.inTransit).toBe(0);
    expect(L.nearSource + L.dissipated + L.leftWorld).toBeCloseTo(L.input, 0);
    expect(c.getMilestones().map((m) => m.kind)).toEqual(expect.arrayContaining(['blastSource']));
    c.unload();
  });
});

describe('objects', { timeout: 600_000 }, () => {
  it('buildings: exterior (windows, panels) and structural damage are separate records, all attributed to the blast; graded with energy', async () => {
    const doc = townDoc(7, 12);
    const run = async (E: number) => {
      const c = await start(doc, [blast({ energy: E, position: [6, 6] })]);
      c.advance(7);
      const ev = c.getDamageEvents();
      const out = {
        exterior: ev.filter((e) => (e.eventType === 'BROKEN' || e.eventType === 'DETACHED') && e.componentKind).length,
        walls: ev.filter((e) => e.eventType === 'FAILED' && e.memberType === 'wall').length,
        collapsed: byType(c, 'building').filter((e) => e.flags.collapsed).length,
        hazards: new Set(ev.map((e) => e.hazard)),
        sources: new Set(ev.map((e) => e.source)),
        wind: ev.filter((e) => e.hazard === 'wind').length,
      };
      c.unload();
      return out;
    };
    const weak = await run(2e7), strong = await run(2e9);
    expect(weak.exterior).toBeGreaterThan(0);
    expect(strong.exterior).toBeGreaterThan(weak.exterior);
    expect(strong.walls).toBeGreaterThan(weak.walls);
    expect(strong.collapsed).toBeGreaterThan(weak.collapsed);
    expect([...strong.hazards]).toEqual(['blast']);
    expect(strong.wind).toBe(0);
    expect([...strong.sources].every((s) => s?.startsWith('blast:'))).toBe(true);
  });

  it('the structural model receives the computed lateral load: peak equivalent acceleration = peak force / mass, drift follows', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(25, 0) }] });
    const c = await start(structuredClone(S().doc), [blast({ energy: 5e8 })]);
    c.advance(5);
    const b = byType(c, 'building')[0];
    expect(b.blast!.peakForce).toBeGreaterThan(0);
    expect(b.seismic!.pgaBlast).toBeCloseTo(b.blast!.aEq, 9);
    expect(b.seismic!.peakDrift).toBeGreaterThan(0);
    expect(b.seismic!.pgaQuake).toBe(0);
    c.unload();
  });

  it('infrastructure near the source topples, far away it stands; the road surface is not lifted by the air', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'streetLight', seed: 1, transform: tf(8, 0) }, { type: 'sign', seed: 2, transform: tf(0, 9, Math.PI / 2) }, { type: 'wall', seed: 3, transform: tf(-9, 0, Math.PI / 2) }, { type: 'streetLight', seed: 4, transform: tf(95, 95) }] });
    const doc = structuredClone(S().doc);
    const h0 = Array.from(doc.terrain.heights);
    const c = await start(doc, [blast({ energy: 2e9 })]);
    c.advance(6);
    const fallen = [...c.getRuntime()!.entities.values()].filter((e) => e.flags.toppled || e.flags.collapsed);
    expect(fallen.length).toBeGreaterThanOrEqual(2);
    expect(fallen.some((e) => Math.hypot(e.initialPose.position[0], e.initialPose.position[2]) > 100)).toBe(false);
    expect(c.getDamageEvents().filter((e) => e.eventType === 'TOPPLED' || e.eventType === 'COLLAPSED').every((e) => e.hazard === 'blast')).toBe(true);
    expect(Array.from(c.getEnvironment().terrain.data.heights)).toEqual(h0);
    c.unload();
  });

  it('a car is pushed away from the source only after the arrival; a person near the source falls, one far away stands', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(12, 0) }, { type: 'human', seed: 2, transform: tf(0, 10) }, { type: 'human', seed: 3, transform: tf(-90, -90) }] });
    const c = await start(structuredClone(S().doc), [blast({ energy: 1e9 })]);
    c.advance(0.5);
    const car = byType(c, 'car')[0];
    const x0 = car.pose.position[0];
    c.advance(4);
    expect(car.pose.position[0] - x0).toBeGreaterThan(0.05);
    const [near, far] = byType(c, 'human').sort((a, b) => Math.hypot(...a.initialPose.position) - Math.hypot(...b.initialPose.position));
    expect(near.flags.fallen).toBe(true);
    expect(far.flags.fallen).toBeFalsy();
    expect(c.getDamageEvents().find((e) => e.objectId === near.id && e.eventType === 'FALLEN')?.hazard).toBe('blast');
    c.unload();
  });

  it('a ridge shields the object behind it — less, later, never zero; exposure is reported', async () => {
    S().setLocked(false);
    S().newDocument();
    const t0 = S().doc.terrain;
    const heights = new Float32Array(t0.heights.length);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = Math.abs(x - 30) < 6 ? 12 * (1 - Math.abs(x - 30) / 6) : 0; }
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(50, 0) }, { type: 'car', seed: 2, transform: tf(-50, 0) }] });
    const c = await start(structuredClone(S().doc), [blast({ energy: 3e8 })]);
    c.advance(2);
    const [behind, open] = byType(c, 'car').sort((a, b) => b.initialPose.position[0] - a.initialPose.position[0]);
    expect(behind.blast!.exposure).toBe('terrain');
    expect(open.blast!.exposure).toBe('direct');
    expect(behind.blast!.peak).toBeLessThan(0.8 * open.blast!.peak);
    expect(behind.blast!.peak).toBeGreaterThan(0.05 * open.blast!.peak);
    expect(behind.blast!.arrival).toBeGreaterThan(open.blast!.arrival);
    c.unload();
  });

  it('two waves overlap deterministically: the same run twice is identical, and the object sees the superposed peak', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(0, 0) }, { type: 'car', seed: 2, transform: tf(0, 20) }] });
    const doc = structuredClone(S().doc);
    const two = [blast({ position: [-40, 0], energy: 3e8 }), blast({ position: [40, 0], energy: 3e8, startTime: 0.52 })];
    const run = async () => {
      const c = await start(doc, two);
      c.advance(6);
      const car = byType(c, 'car')[0];
      const out = { pose: [...car.pose.position], ev: c.getDamageEvents().map((e) => `${e.objectId}:${e.eventType}:${e.componentId}:${e.time.toFixed(4)}`), peak: car.blast!.peak, waves: car.blast!.waves.length, centre: car.blast!.waves.flatMap((w) => w.center) };
      c.unload();
      return out;
    };
    const a = await run(), b = await run();
    expect(a.pose).toEqual(b.pose);
    expect(a.ev).toEqual(b.ev);
    expect(a.waves).toBe(2);
    expect(a.peak).toBeCloseTo(peakOf(a.centre), 6);
  });
});

describe('impact coupling, water, airburst', { timeout: 600_000 }, () => {
  const hit = (x: Partial<ImpactSpec> = {}): ImpactSpec => ({ event: 'impact', target: [0, 0], material: 'stony', diameter: 0.6, speed: 6000, angle: 75, azimuth: 90, entry: 'direct', ...x });

  it('a ground impact hands exactly its air-coupled share to one wave; the ground shock is unchanged; damage is separated by cause', async () => {
    flat();
    S().applyEdit({ add: [{ type: 'building', building: house(), seed: 1, transform: tf(18, 0) }, { type: 'car', seed: 2, transform: tf(-15, 4) }] });
    const doc = structuredClone(S().doc);
    const on = planImpact(hit({ airBlast: true }), doc.terrain, 1), off = planImpact(hit(), doc.terrain, 1);
    const q = on.partition;
    expect(q.blast).toBeCloseTo(0.02 * on.energy, 3);
    expect((q.seismic + q.ejectaKinetic + q.unresolved + q.blast) / q.impact).toBeCloseTo(1, 12);
    expect(on.shock!.seismicEnergy).toBe(off.shock!.seismicEnergy);
    expect(off.partition.blast).toBe(0);
    const c = await start(doc, [hit({ airBlast: true })]);
    c.advance(6);
    const ch = c.getEnvironment().blast;
    expect(ch.waves).toHaveLength(1);
    expect(ch.waves[0].wave.init.energy).toBe(c.getEnvironment().impact.blasts[0].energy);
    expect(ch.waves[0].wave.init.source.startsWith('impact:')).toBe(true);
    const ev = c.getDamageEvents();
    const b = byType(c, 'building')[0];
    expect(b.seismic!.pgaImpact).toBeGreaterThan(0);
    expect(b.seismic!.pgaBlast).toBeGreaterThan(0);
    expect(ev.filter((e) => e.hazard === 'wind')).toHaveLength(0);
    expect(ev.filter((e) => e.hazard === 'blast').every((e) => e.source?.startsWith('impact:'))).toBe(true);
    // Without the air blast the impact run is the Phase 23 run (no wave, no blast record).
    const c2 = await start(doc, [hit()]);
    c2.advance(6);
    expect(c2.getEnvironment().blast.waves).toHaveLength(0);
    expect(c2.getDamageEvents().some((e) => e.hazard === 'blast')).toBe(false);
    c.unload();
    c2.unload();
  });

  it('water over which the wave passes keeps its mass exactly (pressure gradient changes momentum only, a tiny response)', async () => {
    S().setLocked(false);
    S().newDocument();
    const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[-40, -40], [40, -40], [40, 40], [-40, 40]], surface: -0.3, depth: 3, shoreWidth: 4, material: 7, filled: true };
    S().setFeatures([lake], 2);
    const doc = structuredClone(S().doc);
    doc.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    const c = await start(doc, []);
    c.advance(1);
    const w = c.getEnvironment().flood.field!;
    const v0 = w.totalVolume();
    c.addEvent(blast({ energy: 1e9, startTime: c.getTime() + 0.1 }));
    c.advance(3);
    expect(Math.abs(w.totalVolume() - v0) / v0).toBeLessThan(1e-9);
    let umax = 0;
    for (let i = 0; i < w.count; i++) umax = Math.max(umax, Math.abs(w.u[i]), Math.abs(w.v[i]));
    // Momentum impulse per mass of a passing pulse ~ Δp/(ρ_w c) — centimetres per second.
    expect(umax).toBeGreaterThan(0);
    expect(umax).toBeLessThan(1);
    c.unload();
  });

  it('an airburst with the air blast on arrives at the ground after ≈ altitude / c; the run waits for it', async () => {
    const doc = flat();
    const spec: ImpactSpec = { event: 'impact', target: [0, 0], material: 'stony', diameter: 10, speed: 18000, angle: 45, azimuth: 0, entry: 'atmosphere', airBlast: true };
    const plan = planImpact(spec, doc.terrain, 1);
    expect(plan.airburst).toBe(true);
    const c = await start(doc, [spec]);
    c.advance(plan.timeToImpact + 1);
    const w = c.getEnvironment().blast.waves[0].wave;
    expect(w.init.kind).toBe('airburst');
    expect(w.init.energy).toBe(plan.entry!.airburst!.energy);
    const h = w.height;
    const ta = w.init.time + w.main.at(h, { dp: 0, T: 0, t: 0, p: 0, zone: 'weak', energyLeft: 1 }).t;
    expect(ta - w.init.time).toBeGreaterThan(0.8 * h / w.sourceAmbient.c);
    expect(ta - w.init.time).toBeLessThan(1.05 * h / w.sourceAmbient.c);
    expect(c.getEnvironment().blast.pending(c.getTime())).toBe(true);
    c.unload();
  });
});

describe('determinism, restoration, save / load', { timeout: 600_000 }, () => {
  it('reset restores the original world; the same conditions reproduce the same result; the document is never written', async () => {
    const doc = townDoc(5, 14);
    S().replaceDocument(structuredClone(doc));
    const fp = worldFingerprint(S().doc);
    const c = await start(doc, [blast({ energy: 1e9, position: [3, 3] })]);
    const snap = () => {
      const rt = c.getRuntime()!;
      return { ev: c.getDamageEvents().map((e) => `${e.objectId}:${e.eventType}:${e.componentId}:${e.memberType}:${e.time.toFixed(4)}`), poses: [...rt.entities.values()].map((e) => e.pose.position.join(',')), debris: rt.debris.length };
    };
    c.advance(5);
    const a = snap();
    expect(a.ev.length).toBeGreaterThan(0);
    await c.reset();
    expect(c.getEnvironment().blast.waves).toHaveLength(0);
    expect(c.getDamageEvents()).toHaveLength(0);
    expect([...c.getRuntime()!.entities.values()].every((e) => !e.blast && !e.flags.collapsed)).toBe(true);
    c.advance(5);
    expect(snap()).toEqual(a);
    expect(worldFingerprint(S().doc)).toBe(fp);
    c.unload();
  });

  it('air-blast experiments are saved in schema v7; impacts saved before Phase 24 (no airBlast) load with the air blast off', () => {
    flat();
    S().setExperiment({ instances: [
      { id: 'p1', type: 'blast', spec: blast({ startTime: undefined, ambientPressure: 90000 }), enabled: true, start: { at: 1 }, visualize: true },
      { id: 'p2', type: 'impact', spec: { event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere' } as ImpactSpec, enabled: true, start: { at: 0 }, visualize: true },
      { id: 'p3', type: 'blast', spec: blast({ energy: 1e20 }), enabled: true, start: { at: 0 }, visualize: true },
    ] });
    const text = serializeDocument(S().doc);
    expect(JSON.parse(text).schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(7);
    const r = parseDocument(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = r.doc.scenario.experiment!.instances;
    expect(inst.map((i) => i.id)).toEqual(['p1', 'p2']); // out-of-range energy dropped, never "fixed"
    expect(inst[0].spec).toMatchObject({ event: 'blast', energy: 1e8, ambientPressure: 90000, model: 'weakShock' });
    expect((inst[1].spec as ImpactSpec).airBlast).toBeUndefined();
  });
});

void forcesAt;
