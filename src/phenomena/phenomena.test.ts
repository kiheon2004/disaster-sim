/**
 * Universal Phenomenon Engine (Phase 15).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { phenomena, PhenomenonRegistry } from './registry';
import { resolveSchedule, createInstance } from './schedule';
import { defaultScenarios, runComparison } from './experiment';
import { parseExperiment } from './experimentSchema';
import { CHANNELS } from './channels';
import { MODELS } from './models';
import type { PhenomenonInstance } from './types';
import { createEvent } from '@/events/eventRegistry';
import { SimulationController } from '@/simulation/SimulationController';
import { createDefaultSystems } from '@/simulation/systems';
import { MetricsSystem } from '@/simulation/systems/MetricsSystem';
import { MetricsRecorder } from '@/simulation/analysis/MetricsRecorder';
import { describePipeline, validatePipeline } from '@/simulation/systems/pipeline';
import { ForceLedger, forcesAt } from '@/simulation/forces/ForceLedger';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import { residualStrength, hazardDamage, STRENGTH_LOSS } from '@/simulation/interactions/integrity';
import { responses } from '@/simulation/response/responses';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { useSimStore } from '@/simulation/simStore';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField } from '@/simulation/water/WaterField';
import { captureWaterState } from '@/simulation/water/waterStateCodec';

const CTX = { seed: 7, terrain: null };
const T = (x = 0, z = 0) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });

function doc(inputs: CreateObjectInput[], interactions = true, seed = 5): WorldDocument {
  const d = createEmptyDocument('phen');
  for (const input of inputs) {
    const o = createWorldObject({ seed: 11, ...input }, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = seed;
  d.settings.simulation.interactions = { enabled: interactions };
  return d;
}

function inst(id: string, type: string, start: PhenomenonInstance['start'], spec?: Partial<EventSpec>): PhenomenonInstance {
  const def = phenomena.implemented(type)!;
  return { id, type, spec: { ...def.defaults(), ...(spec ?? {}) } as EventSpec, enabled: true, start, visualize: true };
}

describe('registration', () => {
  it('every implemented phenomenon creates its event; planned ones are recognized but never executable', () => {
    const impl = phenomena.listImplemented().map((d) => d.type);
    expect(impl).toEqual(['wind', 'earthquake', 'rain', 'risingWater', 'waterSource', 'terrainDeformation', 'sinkhole', 'landslide', 'impact', 'blast', 'heatSource', 'fire', 'volcano', 'atmosphere', 'climate', 'gravity', 'celestial']); // Phase 27: + fire, Phase 28: + volcano, Phase 29: + atmosphere, Phase 30: + climate, Phase 31: + gravity, Phase 32: + celestial
    for (const d of phenomena.listImplemented()) {
      const spec = d.defaults();
      expect(d.schema.safeParse(spec).success).toBe(true);
      const ev = createEvent(spec, 0, CTX);
      expect(ev.type).toBe(d.type);
      expect(ev.duration).toBeCloseTo(d.duration(spec, CTX), 6);
      for (const m of d.models) expect(MODELS[m]).toBeDefined();
      for (const c of d.channels) expect(CHANNELS[c].status).not.toBe('interface');
    }
    // (meteor → implemented as 'impact' since Phase 23)
    // (air removal → implemented as the atmosphere experiment 'atmosphere' since Phase 29; an O₂-fraction change stays planned)
    // (gravity change → implemented as the gravity experiment 'gravity' since Phase 31)
    // (black hole → implemented as the celestial experiment 'celestial' since Phase 32)
    expect(phenomena.get('blackHole')).toBeUndefined();
    expect(phenomena.get('celestial')?.status).toBe('implemented');
    for (const type of ['tornado', 'atmosphereLoss']) {
      const d = phenomena.get(type)!;
      expect(d.status).toBe('planned');
      expect(() => createEvent({ event: type } as unknown as EventSpec, 0, CTX)).toThrow(/Unsupported/);
    }
    expect(phenomena.matchPlanned('운석이 떨어지게 해줘')).toBeFalsy();
    expect(phenomena.get('impact')?.status).toBe('implemented');
    // (explosion → implemented as the atmospheric pressure wave 'blast' since Phase 24; fire → implemented since Phase 27)
    expect(phenomena.matchPlanned('폭발을 일으켜')).toBeFalsy();
    expect(phenomena.get('blast')?.status).toBe('implemented');
    expect(phenomena.get('fire')?.status).toBe('implemented');
    expect(phenomena.get('volcano')?.status).toBe('implemented');
    expect(phenomena.get('atmosphere')?.status).toBe('implemented');
    // (heatwave / cold wave → implemented as the 'climate' experiment since Phase 30)
    expect(phenomena.get('climate')?.status).toBe('implemented');
    expect(phenomena.matchPlanned('폭염이 오게 해줘')).toBeFalsy();
    expect(phenomena.matchPlanned('대기를 제거해')).toBeFalsy();
    expect(phenomena.matchPlanned('create a black hole')).toBeFalsy(); // Phase 32: implemented ('celestial')
  });

  it('rejects a duplicate registration; every model is marked as not validated', () => {
    const r = new PhenomenonRegistry();
    r.register(phenomena.get('wind')!);
    expect(() => r.register(phenomena.get('wind')!)).toThrow();
    expect(Object.values(MODELS).every((m) => m.validated === false)).toBe(true);
  });

  it('validates parameters and units with each phenomenon\'s own schema', () => {
    const wind = phenomena.implemented('wind')!;
    expect(wind.schema.safeParse({ ...wind.defaults(), speed: 200 }).success).toBe(false);
    const rain = phenomena.implemented('rain')!;
    expect(rain.schema.safeParse({ event: 'rain', intensity: 0, duration: 60 }).success).toBe(false);
    expect(rain.schema.safeParse({ event: 'rain', intensity: 80, duration: 60 }).success).toBe(true);
    // Rain duration is stored in seconds, edited in minutes.
    const dur = rain.fields.find((f) => f.key === 'duration')!;
    expect(dur.unit).toBe('min');
    expect(1800 * dur.scale!).toBe(30);
    const eq = phenomena.implemented('earthquake')!;
    expect(eq.schema.safeParse({ event: 'earthquake', magnitude: 12 }).success).toBe(false);
  });
});

describe('experiment schedule', () => {
  it('resolves absolute and relative start times (start / end anchors) in a stable order', () => {
    const plan = [
      inst('p1', 'wind', { at: 0 }, { duration: 40 }),
      inst('p2', 'earthquake', { after: 'p1', anchor: 'start', offset: 10 }),
      inst('p3', 'rain', { after: 'p1', anchor: 'end', offset: -10 }, { duration: 120 }),
      inst('p4', 'waterSource', { at: 10 }),
    ];
    const s = resolveSchedule(plan, CTX);
    expect(s.issues).toEqual([]);
    expect(s.items.map((r) => [r.instance.id, r.start])).toEqual([['p1', 0], ['p2', 10], ['p4', 10], ['p3', 30]]);
    expect(s.items.find((r) => r.instance.id === 'p3')!.spec.startTime).toBe(30);
    expect(resolveSchedule(plan, CTX, 100).items[1].spec.startTime).toBe(110);
  });

  it('reports cycles, missing / disabled references, invalid parameters and negative starts — and does not schedule them', () => {
    const plan = [
      inst('a', 'wind', { after: 'b', anchor: 'start', offset: 1 }),
      inst('b', 'wind', { after: 'a', anchor: 'start', offset: 1 }),
      inst('c', 'earthquake', { after: 'nope', anchor: 'start', offset: 0 }),
      { ...inst('d', 'rain', { at: 0 }), enabled: false },
      inst('e', 'rain', { after: 'd', anchor: 'start', offset: 0 }),
      inst('f', 'wind', { at: 0 }, { speed: 999 }),
      inst('g', 'wind', { at: 5 }),
      inst('h', 'earthquake', { after: 'g', anchor: 'start', offset: -20 }),
    ];
    const s = resolveSchedule(plan, CTX);
    const prob = Object.fromEntries(s.issues.map((i) => [i.id, i.problem]));
    expect(prob).toMatchObject({ a: 'cycle', b: 'cycle', c: 'missingRef', e: 'disabledRef', f: 'invalidSpec', h: 'negativeStart' });
    expect(s.items.map((r) => r.instance.id)).toEqual(['g']);
  });

  it('a seeded phenomenon takes the instance seed', () => {
    const s = resolveSchedule([{ ...inst('q', 'earthquake', { at: 0 }), seed: 42 }], CTX);
    expect((s.items[0].spec as { seed?: number }).seed).toBe(42);
  });
});

describe('scheduler and pipeline', () => {
  it('the pipeline order is declared and valid; reading a later writer without `lagged` is detected', () => {
    const systems = [...createDefaultSystems(), new MetricsSystem(new MetricsRecorder(1))];
    expect(validatePipeline(systems)).toEqual([]);
    expect(describePipeline(systems).map((s) => `${s.phase === 'prePhysics' ? 'pre' : 'post'}:${s.name}`)).toEqual([
      'pre:gravity', 'pre:impact', 'pre:groundFailure', 'pre:deformation', 'pre:windForce', 'pre:groundMotion', 'pre:blast', 'pre:waterSolver', 'pre:waterForce', 'pre:sedimentForce', 'pre:groundContact',
      'post:gravityLedger', 'post:poseSync', 'post:structural', 'post:seismicDamage', 'post:floodDamage', 'post:roads', 'post:sway', 'post:damage', 'post:thermal', 'post:structuralCollapse', 'post:debris', 'post:particles', 'post:exposure', 'post:metrics',
    ]);
    // Moving the water solver after the water forces breaks the data flow → reported.
    const bad = [...systems];
    const i = bad.findIndex((s) => s.name === 'waterSolver');
    const [ws] = bad.splice(i, 1);
    bad.splice(bad.findIndex((s) => s.name === 'groundContact') + 1, 0, ws);
    expect(validatePipeline(bad).some((x) => x.system === 'waterForce' && x.key === 'water')).toBe(true);
  });

  it('several phenomena are active at once on one clock; inactive ones cost nothing', async () => {
    const c = new SimulationController();
    await c.load(doc(sampleTown().slice(0, 25)));
    const calls: Record<string, number> = {};
    for (const s of c.getSystems()) {
      const f = s.update.bind(s);
      s.update = (ctx, dt) => {
        calls[s.name] = (calls[s.name] ?? 0) + 1;
        f(ctx, dt);
      };
    }
    // Earthquake only for the first 3 s: no wind, no water work at all.
    c.addEvent({ event: 'earthquake', magnitude: 6, pga: 0.2, duration: 30, seed: 1 });
    c.advance(3);
    expect(calls.windForce ?? 0).toBe(0);
    expect(calls.waterSolver ?? 0).toBe(0);
    expect(calls.waterForce ?? 0).toBe(0);
    expect(calls.floodDamage ?? 0).toBe(0);
    expect(calls.groundMotion).toBe(180);
    c.addEvent({ event: 'wind', speed: 30, direction: 'E', duration: 30 });
    c.addEvent({ event: 'rain', intensity: 60, duration: 30 });
    c.advance(2);
    const active = useSimStore.getState().events.filter((e) => e.status === 'active').map((e) => e.type).sort();
    expect(active).toEqual(['earthquake', 'rain', 'wind']);
    // Skipped while the ramp still sits at exactly 0 m/s (first steps), then every step.
    expect(calls.windForce).toBeGreaterThanOrEqual(115);
    expect(calls.windForce).toBeLessThanOrEqual(120);
    expect(calls.waterSolver).toBe(20); // 10 Hz
    // Lifecycle: start / end milestones in time order.
    c.addEvent({ event: 'wind', speed: 10, direction: 'N', duration: 1 });
    c.advance(2);
    const ms = c.getMilestones().filter((m) => m.kind === 'start' || m.kind === 'end');
    expect(ms.map((m) => m.time)).toEqual([...ms.map((m) => m.time)].sort((a, b) => a - b));
    expect(ms.some((m) => m.kind === 'end' && m.subject === 'wind')).toBe(true);
    c.unload();
  }, 120_000);
});

describe('forces: one path, no duplicates', () => {
  it('the ledger forwards each (body, source) once per step and rejects repeats', () => {
    const calls: string[] = [];
    const physics = { addForce: () => calls.push('f'), addForceAtPoint: () => calls.push('p') } as unknown as PhysicsEngine;
    const l = new ForceLedger(physics);
    const owner: { forces?: Float64Array } = {};
    l.beginStep(1);
    expect(l.forceAtPoint('wind', 7, [3, 0, 4], [0, 0, 0], owner)).toBe(true);
    expect(l.forceAtPoint('wind', 7, [3, 0, 4], [0, 0, 0], owner)).toBe(false);
    expect(l.force('water', 7, [0, 10, 0], owner)).toBe(true);
    expect(calls).toEqual(['p', 'f']);
    expect(l.duplicates).toBe(1);
    expect(forcesAt(owner, 1)).toMatchObject({ wind: 5, water: 10, groundMotion: -1 });
    l.beginStep(2);
    expect(l.forceAtPoint('wind', 7, [1, 0, 0], [0, 0, 0])).toBe(true);
  });

  it('wind + earthquake + flood together: every body is pushed once per source and step', async () => {
    const d = doc(sampleTown());
    const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
    f.h.fill(0.4);
    const c = new SimulationController();
    c.setInitialWaterState(captureWaterState(f, 0));
    await c.load(d);
    c.addEvent({ event: 'wind', speed: 35, direction: 'S', duration: 30 });
    c.addEvent({ event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 20, seed: 2 });
    c.addEvent({ event: 'rain', intensity: 50, duration: 30 });
    c.advance(4);
    expect(c.duplicateForces()).toBe(0);
    const car = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'car')!;
    const fs = forcesAt(car, c.getStep() - 1);
    expect(fs.wind).toBeGreaterThan(0);
    expect(fs.groundMotion).toBeGreaterThan(0);
    expect(fs.water).toBeGreaterThan(0);
    c.unload();
  }, 120_000);
});

describe('unified damage and interactions', () => {
  const fake = (d: Partial<{ eq: number; flood: number; wind: number; ground: number }>) =>
    ({
      seismic: d.eq !== undefined ? { damage: d.eq, tiltMag: 0, failureTilt: Infinity } : undefined,
      flood: d.flood !== undefined ? { damage: d.flood } : undefined,
      integrity: d.wind !== undefined ? { windHealth: 1 - d.wind, history: [] } : undefined,
      ground: d.ground !== undefined ? { damage: d.ground } : undefined,
    }) as unknown as RuntimeEntity;

  it('residual strength uses the other hazards\' damage as an envelope (max), never a sum', () => {
    expect(residualStrength(fake({}), 'wind')).toBe(1);
    expect(residualStrength(fake({ eq: 0.5 }), 'wind')).toBeCloseTo(1 - STRENGTH_LOSS * 0.5, 12);
    expect(residualStrength(fake({ eq: 0.5 }), 'earthquake')).toBe(1); // own damage is in its own model
    expect(residualStrength(fake({ eq: 0.4, flood: 0.6 }), 'wind')).toBeCloseTo(1 - STRENGTH_LOSS * 0.6, 12);
    expect(residualStrength(fake({ eq: 3 }), 'flood')).toBeCloseTo(1 - STRENGTH_LOSS, 12);
    expect(hazardDamage(fake({ wind: 0.2, eq: 0.1 }))).toEqual({ wind: expect.closeTo(0.2, 12), earthquake: 0.1, flood: 0, ground: 0, impact: 0, blast: 0, thermal: 0, fire: 0, volcano: 0, climate: 0, gravity: 0 }); // Phase 31: + gravity (0 — it acts through the collapse model), Phase 23: + impact, Phase 24: + blast, Phase 26: + thermal, Phase 27: + fire (both always 0 — heat acts through the material factor), Phase 28: + volcano (lava load index), Phase 30: + climate (crown breakage index)
    expect(residualStrength(fake({ eq: 0.2, ground: 0.5 }), 'wind')).toBeCloseTo(1 - STRENGTH_LOSS * 0.5, 12); // ground joins the envelope
  });

  it('wind + earthquake: with interactions the shaken town carries the wind load and its own wind fatigue stays separate', async () => {
    const run = async (interactions: boolean) => {
      const c = new SimulationController();
      await c.load(doc(sampleTown(), interactions, 21));
      c.addEvent({ event: 'wind', speed: 38, direction: 'S', duration: 40, gustStrength: 0.3, rampDuration: 3 });
      c.addEvent({ event: 'earthquake', magnitude: 6.8, pga: 0.45, duration: 12, seed: 3 });
      c.advance(10);
      const b = [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'building');
      const out = { events: c.getDamageEvents().length, maxDrift: Math.max(...b.map((e) => e.seismic!.peakDrift)), wind: b.map((e) => e.integrity?.windHealth ?? null) };
      c.unload();
      return out;
    };
    const legacy = await run(false);
    const coupled = await run(true);
    expect(coupled.maxDrift).toBeGreaterThan(legacy.maxDrift); // mean wind drift adds to the shaking
    // Legacy: the wind-fatigue channel is never integrated on its own (shared min() health).
    expect(legacy.wind.every((w) => w === null || w === 1)).toBe(true);
    expect(coupled.wind.every((w) => w !== null && w <= 1)).toBe(true);
    expect(coupled.events).not.toBe(legacy.events);
  }, 240_000);

  it('wind + flood: the wind drags the water surface downwind (setup); off = no effect', async () => {
    const run = async (interactions: boolean) => {
      const d = doc([], interactions);
      for (const s of ['N', 'E', 'S', 'W'] as const) d.settings.simulation.water.boundaries[s] = { type: 'closed' };
      d.settings.simulation.water.infiltration = false;
      const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
      f.h.fill(1);
      const c = new SimulationController();
      c.setInitialWaterState(captureWaterState(f, 0));
      await c.load(d);
      c.addEvent({ event: 'rain', intensity: 0.1, duration: 600 });
      c.addEvent({ event: 'wind', speed: 40, direction: 'W', duration: 600, rampDuration: 1 });
      c.advance(60);
      const w = c.getEnvironment().flood.field!;
      const east = w.h[w.indexAt(95.5, 0.5)];
      const west = w.h[w.indexAt(-95.5, 0.5)];
      c.unload();
      return east - west;
    };
    expect(await run(false)).toBeCloseTo(0, 9);
    const setup = await run(true);
    // Wind from the west blows the water east: higher on the east side.
    expect(setup).toBeGreaterThan(0.005);
    expect(setup).toBeLessThan(0.5);
  }, 240_000);

  it('earthquake + flood: shaking makes still water move (seiche); off = water stays still', async () => {
    const run = async (interactions: boolean) => {
      const d = doc([], interactions);
      const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
      f.h.fill(0.8);
      const c = new SimulationController();
      c.setInitialWaterState(captureWaterState(f, 0));
      d.settings.simulation.water.infiltration = false;
      for (const s of ['N', 'E', 'S', 'W'] as const) d.settings.simulation.water.boundaries[s] = { type: 'closed' };
      await c.load(d);
      c.addEvent({ event: 'rain', intensity: 0.1, duration: 600 });
      c.addEvent({ event: 'earthquake', magnitude: 7, pga: 0.5, duration: 15, seed: 4 });
      c.advance(10);
      const speed = c.getEnvironment().flood.field!.stats.maxSpeed;
      c.unload();
      return speed;
    };
    expect(await run(false)).toBeLessThan(1e-6);
    expect(await run(true)).toBeGreaterThan(0.01);
  }, 240_000);

  it('a part destroyed by one hazard is not destroyed again by another (no duplicate damage records)', async () => {
    const c = new SimulationController();
    await c.load(doc([{ type: 'building', transform: T(), params: { floors: 3 } }], true, 3));
    c.addEvent({ event: 'earthquake', magnitude: 7, pga: 0.9, duration: 15, seed: 3 });
    c.addEvent({ event: 'wind', speed: 55, direction: 'E', duration: 30, startTime: 8 });
    c.advance(20);
    const parts = c.getDamageEvents().filter((e) => e.componentId).map((e) => e.componentId);
    expect(new Set(parts).size).toBe(parts.length);
    const collapses = c.getDamageEvents().filter((e) => e.eventType === 'COLLAPSED');
    expect(collapses.length).toBeLessThanOrEqual(1);
    // Ordered history: times never go backwards.
    const h = [...c.getRuntime()!.entities.values()][0].integrity?.history ?? [];
    expect(h.map((x) => x.time)).toEqual([...h.map((x) => x.time)].sort((a, b) => a - b));
    c.unload();
  }, 120_000);

  it('object responses are dispatched by channel × category', () => {
    const kinds = responses.all.map((h) => `${h.channel}:${'type' in h.target ? h.target.type : h.target.category}`);
    expect(kinds).toEqual(expect.arrayContaining(['groundMotion:building', 'groundMotion:human', 'water:vehicle', 'water:road', 'water:infrastructure', 'water:tree']));
  });
});

describe('experiment comparison', () => {
  it('runs each phenomenon alone and together on the same initial world, deterministically, without touching the UI store', async () => {
    const d = doc(sampleTown().slice(0, 30));
    const plan = [inst('p1', 'wind', { at: 0 }, { speed: 45, duration: 6 }), inst('p2', 'earthquake', { after: 'p1', anchor: 'start', offset: 1 }, { duration: 5, pga: 0.4 })];
    const scenarios = defaultScenarios(plan);
    expect(scenarios.map((s) => s.id)).toEqual(['p1', 'p2', 'all']);
    const before = useSimStore.getState().time;
    const a = await runComparison(d, plan, scenarios, { duration: 8 });
    const b = await runComparison(d, plan, scenarios, { duration: 8 });
    const strip = (r: typeof a) => r.map(({ wallMs: _w, msPerSimSecond: _m, ...x }) => x);
    expect(strip(a)).toEqual(strip(b));
    expect(a.map((r) => r.simTime)).toEqual([8, 8, 8]);
    expect(a[0].eventsByHazard.earthquake).toBe(0);
    expect(a[1].eventsByHazard.wind).toBe(0);
    expect(useSimStore.getState().time).toBe(before);
    expect(createHash('sha256').update(JSON.stringify(strip(a))).digest('hex')).toHaveLength(64);
  }, 240_000);
});

describe('save / load (schema v5+)', () => {
  it('round-trips the experiment plan; invalid instances are dropped; v1–v4 files migrate with interactions off', () => {
    const d = doc(sampleTown().slice(0, 5));
    const p1 = createInstance('wind', []);
    const p2 = { ...createInstance('earthquake', [p1]), start: { after: p1.id, anchor: 'start' as const, offset: 10 }, seed: 9 };
    d.scenario.experiment = { instances: [p1, p2], notes: 'A vs B', compareDuration: 30 };
    const res = parseDocument(serializeDocument(d));
    expect(res.ok && res.doc.schemaVersion).toBe(7);
    if (!res.ok) return;
    expect(res.doc.scenario.experiment).toEqual(d.scenario.experiment);
    expect(res.doc.settings.simulation.interactions).toEqual({ enabled: true });

    const raw = JSON.parse(serializeDocument(d));
    raw.scenario.experiment.instances.push({ id: 'x', type: 'blackHole', spec: {}, enabled: true, start: { at: 0 }, visualize: true });
    raw.scenario.experiment.instances.push({ id: 'y', type: 'wind', spec: { speed: 500 }, enabled: true, start: { at: 0 }, visualize: true });
    expect(parseExperiment(raw.scenario.experiment).instances.map((i) => i.id)).toEqual([p1.id, p2.id]);

    for (const v of [4, 3, 1]) {
      const old = JSON.parse(serializeDocument(d));
      old.schemaVersion = v;
      delete old.settings.simulation.interactions;
      delete old.scenario.experiment;
      if (v === 1) old.terrain = { kind: 'flat' };
      const r = parseDocument(JSON.stringify(old));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.doc.settings.simulation.interactions).toEqual({ enabled: false });
      expect(r.doc.scenario.experiment.instances).toEqual([]);
    }
  });
});
