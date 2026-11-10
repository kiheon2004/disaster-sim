/**
 * Phase 35.5 benchmarks (spec §63–65), headless — BENCH=1 to run:
 *  - disaster instances: 1 / 5 / 10 / 25 / 50 / 100 independent instances of one type at once, in a 5 × 5 town of modular
 *    houses (structure v2), per type — ms per simulated second, profiler sections, heap. A type stops growing once one
 *    run takes longer than its wall budget (reported, not assumed: not every phenomenon supports 100 at once).
 *  - buildings: 1 / 10 / 50 / 100 / 500 / 1000 buildings under the same earthquake (0.5 g) at three structural levels —
 *    L0 legacy box buildings, L1 member model (Phase 25 engine = v1), L2 member model + structure v2 — ms per simulated
 *    second, the structural systems' share, heap.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc BENCH_OUT=docs/bench-phase35_5.json npx vitest run src/bench/ux355.bench --silent=false
 *
 * Long runs (LONG = simulated seconds, LONG_SCENES = names, LONG_BUDGET_S = wall budget per scene, default 900 — a scene over
 * budget stops and reports the simulated time it reached): 1 s steps; every 60 s NaN, speed / spin, out of world, events, heap.
 *
 *   BENCH=1 LONG=3600 NODE_OPTIONS=--expose-gc BENCH_OUT=docs/bench-phase35_5-long.json npx vitest run src/bench/ux355.bench --silent=false -t long
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { presetDesign } from '@/roads/city';
import { phenomena } from '@/phenomena/registry';
import { catalogOf } from '@/phenomena/catalog';
import { Rng } from '@/core/random';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { loadSampleTown } from '@/app/actions';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const T = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });

function town(n: number, level: 'L0' | 'L1' | 'L2'): WorldDocument {
  const d = createEmptyDocument('bench355');
  d.settings.simulation.seed = 42;
  if (level === 'L2') d.settings.simulation.structure = { model: 'v2' };
  const side = Math.ceil(Math.sqrt(n));
  const sp = Math.min(14, 188 / side);
  const h = ((side - 1) * sp) / 2;
  const design = presetDesign('house', 1)!;
  const legacy = getDefinition('building');
  for (let k = 0; k < n; k++) {
    const x = -h + sp * (k % side), z = -h + sp * Math.floor(k / side);
    const input: CreateObjectInput = level === 'L0'
      ? { type: 'building', params: { ...legacy.defaultParams, floors: 2, width: 8, depth: 7 }, seed: k + 1, transform: T(x, z) }
      : { type: 'building', building: design, seed: k + 1, transform: T(x, z) };
    const o = createWorldObject(input, nextSerial(d.objects, 'building'));
    d.objects[o.id] = o;
  }
  return d;
}

const SECTIONS = ['physics', 'structural', 'structuralCollapse', 'seismicDamage', 'damage', 'blast', 'thermal', 'groundFailure', 'deformation', 'windForce', 'impact', 'waterSolver', 'dispatch'];

async function run(doc: WorldDocument, events: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const sec = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  const tl = performance.now();
  await c.load(doc);
  const loadMs = performance.now() - tl;
  for (const e of events) c.addEvent(e);
  const s0 = sec();
  const t0 = performance.now();
  let worst = 0;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const a = performance.now();
    c.advance(1 / 60);
    worst = Math.max(worst, performance.now() - a);
  }
  const ms = performance.now() - t0;
  const s1 = sec();
  const per: Record<string, number> = {};
  for (const k of SECTIONS) per[k] = +(((s1[`sys.${k}`] ?? s1[k] ?? 0) - (s0[`sys.${k}`] ?? s0[k] ?? 0)) / seconds).toFixed(2);
  const inst = c.instances();
  const out = { msPerSimS: +(ms / seconds).toFixed(1), worstStepMs: +worst.toFixed(1), loadMs: +loadMs.toFixed(0), sections: per, instances: inst.length, active: inst.filter((i) => i.status === 'active').length, heapMB: heapMB() };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

/** n instances of a type spread over the map (deterministic), started together at t = 0.2 s. */
function instances(type: string, n: number): EventSpec[] {
  const def = phenomena.implemented(type)!;
  const pol = catalogOf(type)!.placement;
  const rng = new Rng(355 + n);
  const out: EventSpec[] = [];
  for (let k = 0; k < n; k++) {
    const p: [number, number] = [rng.range(-90, 90), rng.range(-90, 90)];
    let spec = pol.kind === 'global' || pol.kind === 'edge' ? def.defaults() : pol.set(def.defaults(), p, 100);
    if (type === 'blast') spec = { ...spec, energy: 2e6 } as EventSpec;
    if (type === 'earthquake') spec = { ...spec, pga: 0.05, duration: 10 } as EventSpec;
    out.push({ ...spec, startTime: 0.2 } as EventSpec);
  }
  return out;
}

describe.skipIf(!process.env.BENCH)('Phase 35.5 benchmarks', () => {
  it('instances and buildings', { timeout: 28_800_000 }, async () => {
    const rows: Any[] = [];
    const save = () => { if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, ncpu: os.cpus().length, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2)); };
    const COUNTS = (process.env.COUNTS ?? '1,5,10,25,50,100').split(',').map(Number);
    const TYPES = (process.env.TYPES ?? 'blast,fire,heatSource,tornado,waterSource,rain,earthquake,sinkhole,impact').split(',');
    const BUDGET = +(process.env.BUDGET_S ?? 90);
    for (const type of TYPES) {
      for (const n of COUNTS) {
        const t0 = Date.now();
        const r = await run(town(25, 'L2'), instances(type, n), 5);
        const row = { part: 'instances', type, n, ...r, wallS: +((Date.now() - t0) / 1000).toFixed(1), load: os.loadavg()[0].toFixed(1) };
        rows.push(row);
        console.log(JSON.stringify(row));
        save();
        if ((Date.now() - t0) / 1000 > BUDGET) { rows.push({ part: 'instances', type, stoppedAfter: n, reason: `run over ${BUDGET} s wall` }); console.log(`${type}: stop after ${n}`); break; }
      }
    }
    const BCOUNTS = (process.env.BCOUNTS ?? '1,10,50,100,500,1000').split(',').map(Number);
    const quake: EventSpec = { event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 3, startTime: 0.2 } as EventSpec;
    for (const n of BCOUNTS) for (const level of ['L0', 'L1', 'L2'] as const) {
      const t0 = Date.now();
      const r = await run(town(n, level), [quake], n >= 500 ? 3 : 5);
      const row = { part: 'buildings', level, n, ...r, wallS: +((Date.now() - t0) / 1000).toFixed(1), load: os.loadavg()[0].toFixed(1) };
      rows.push(row);
      console.log(JSON.stringify(row));
      save();
    }
  });
});

/** A phenomenon's defaults placed at p (catalog placement rule), with overrides. */
function placed(type: string, p: [number, number], over: Any = {}): EventSpec {
  const def = phenomena.implemented(type)!;
  const pol = catalogOf(type)!.placement;
  const spec = pol.kind === 'global' || pol.kind === 'edge' ? def.defaults() : pol.set(def.defaults(), p, 100);
  return { ...spec, ...over } as EventSpec;
}

/** Free cars among the buildings: the speed / spin / out-of-world checks need dynamic bodies (buildings have fixed ones). */
function withCars(d: WorldDocument): WorldDocument {
  const def = getDefinition('car');
  for (const [x, z] of [[-50, -50], [50, -50], [-50, 50], [50, 50], [0, -45], [0, 45]]) {
    const o = createWorldObject({ type: 'car', params: { ...def.defaultParams }, seed: 7, transform: T(x, z) }, nextSerial(d.objects, 'car'));
    d.objects[o.id] = o;
  }
  return d;
}

type Op = { t: number; key: string; op: 'pause' | 'resume' | 'stop' | 'cancel' };
type Scene = { doc: () => WorldDocument; events: EventSpec[]; ops?: Op[] };

describe.skipIf(!process.env.BENCH || !process.env.LONG)('Phase 35.5 long runs', () => {
  it('long', { timeout: 28_800_000 }, async () => {
    const SIM = +process.env.LONG!;
    const BUDGET = +(process.env.LONG_BUDGET_S ?? 900);
    const quake = (pga: number, startTime: number, seed: number, duration = 20) => ({ event: 'earthquake', magnitude: 6.2, pga, duration, seed, startTime }) as EventSpec;
    const vortex = (position: [number, number], extra: Any = {}) => ({ event: 'tornado', position, maxSpeed: 50, coreRadius: 15, outerRadius: 80, duration: SIM, rampDuration: 5, startTime: 0, ...extra }) as EventSpec;
    const scenes: Record<string, Scene> = {
      // 2 quakes + 3 blasts + 4 fires + 2 sinkholes, staggered, on a structure v2 town.
      mix: { doc: () => withCars(town(25, 'L2')), events: [
        quake(0.25, 10, 11), quake(0.2, 40, 12),
        placed('blast', [-50, -40], { energy: 2e6, startTime: 5 }), placed('blast', [45, 30], { energy: 2e6, startTime: 25 }), placed('blast', [0, 60], { energy: 2e6, startTime: 60 }),
        placed('fire', [-28, -28], { startTime: 15 }), placed('fire', [28, -14], { startTime: 30 }), placed('fire', [-14, 28], { startTime: 45 }), placed('fire', [14, 14], { startTime: 70 }),
        placed('sinkhole', [-70, 70], { startTime: 20 }), placed('sinkhole', [70, -70], { startTime: 50 }),
      ] },
      // Two vortices; the first stops at 300 s, the other lasts the run.
      vortices: { doc: () => withCars(town(9, 'L2')), events: [vortex([-20, -5]), vortex([20, 5])], ops: [{ t: 300, key: 'tornado#1', op: 'stop' }] },
      // Pause / resume / stop of running instances, a cancel before the start.
      controls: { doc: () => withCars(town(9, 'L2')), events: [
        quake(0.1, 5, 21, 200), placed('waterSource', [30, 30], { rate: 2, duration: 1800, startTime: 0 }), placed('heatSource', [-30, 30], { duration: 1200, startTime: 10 }), placed('blast', [0, -50], { energy: 2e6, startTime: 500 }),
      ], ops: [
        { t: 10, key: 'blast#1', op: 'cancel' }, { t: 30, key: 'earthquake#1', op: 'pause' }, { t: 90, key: 'earthquake#1', op: 'resume' },
        { t: 100, key: 'heatSource#1', op: 'pause' }, { t: 400, key: 'heatSource#1', op: 'resume' }, { t: 800, key: 'heatSource#1', op: 'stop' }, { t: 900, key: 'waterSource#1', op: 'stop' },
      ] },
      // Three rain cells at different places and times.
      rainCells: { doc: () => town(9, 'L2'), events: [
        { event: 'rain', intensity: 50, duration: 900, area: { center: [-50, 0], radius: 25 }, startTime: 0 } as EventSpec,
        { event: 'rain', intensity: 80, duration: 600, area: { center: [50, 20], radius: 20 }, startTime: 120 } as EventSpec,
        { event: 'rain', intensity: 30, duration: 1500, area: { center: [0, -60], radius: 30 }, startTime: 300 } as EventSpec,
      ] },
      // A sinkhole under one v2 building (town(1) puts it at the origin).
      sinkholeUnder: { doc: () => town(1, 'L2'), events: [placed('sinkhole', [0, 0], { startTime: 10 })] },
      // The default world (structure v2 from the new-project path), no hazard: must stay quiet.
      defaultWorld: { doc: () => { useWorldStore.getState().setLocked(false); loadSampleTown(); return structuredClone(useWorldStore.getState().doc); }, events: [] },
    };
    const only = process.env.LONG_SCENES?.split(',');
    const rows: Any[] = [];
    const save = () => { if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simSeconds: SIM, budgetS: BUDGET, rows }, null, 2)); };
    for (const [name, sc] of Object.entries(scenes)) {
      if (only && !only.includes(name)) continue;
      const doc = sc.doc();
      const c = new SimulationController({ headless: true });
      await c.load(doc);
      const keys = sc.events.map((e) => c.addEvent(e));
      const opLog: Any[] = [];
      const checks: Any[] = [];
      const loadStart = os.loadavg()[0];
      const t0 = performance.now();
      let reached = 0;
      let worstStep = 0;
      let winSpeed = 0;
      let winSpin = 0;
      for (let t = 0; t < SIM; t++) {
        for (const o of sc.ops ?? []) if (o.t === t) opLog.push({ ...o, ok: c.controlEvent(o.key, o.op), statusAfter: c.instances().find((i) => i.key === o.key)?.status });
        const a = performance.now();
        c.advance(1);
        worstStep = Math.max(worstStep, performance.now() - a);
        reached = t + 1;
        { // Speeds every simulated second: a 60 s sample alone misses short transients.
          const P = c.getPhysics()!;
          for (const e of c.getRuntime()!.entities.values()) if (e.body != null && P.hasBody(e.body)) {
            winSpeed = Math.max(winSpeed, Math.hypot(...P.getLinearVelocity(e.body)));
            winSpin = Math.max(winSpin, Math.hypot(...P.getAngularVelocity(e.body)));
          }
        }
        if (reached % 60 === 0) {
          const ents = [...c.getRuntime()!.entities.values()];
          const P = c.getPhysics()!;
          const live = ents.filter((e) => e.body != null && P.hasBody(e.body));
          const inst = c.instances();
          checks.push({
            t: reached,
            nonFinite: ents.some((e) => !e.pose.position.every(Number.isFinite) || !Object.values(e.pose).flat().every(Number.isFinite)),
            maxSpeed: +winSpeed.toFixed(2),
            maxSpin: +winSpin.toFixed(2),
            outside: live.some((e) => Math.abs(e.pose.position[0]) > 700 || Math.abs(e.pose.position[2]) > 700 || e.pose.position[1] < -100),
            entities: ents.length, bodies: live.length,
            events: c.getDamageEvents().length,
            active: inst.filter((i) => i.status === 'active').length,
            duplicates: c.duplicateForces(),
            heapMB: heapMB(),
          });
          winSpeed = 0;
          winSpin = 0;
        }
        if ((performance.now() - t0) / 1000 > BUDGET) break;
      }
      const ms = performance.now() - t0;
      const statuses = c.instances().map((i) => [i.key, i.status]);
      await c.reset();
      c.unload();
      const bad = checks.filter((x) => x.nonFinite || x.outside || x.maxSpeed > 100 || x.maxSpin > 50).map((x) => x.t);
      const row = {
        scene: name, simSeconds: SIM, reached, complete: reached === SIM, wallS: +(ms / 1000).toFixed(1), worstStepMs: +worstStep.toFixed(0), loadStart: +loadStart.toFixed(1), loadEnd: +os.loadavg()[0].toFixed(1),
        keys, ops: opLog, statuses, bad, peakSpeed: Math.max(0, ...checks.map((x) => x.maxSpeed)), peakSpin: Math.max(0, ...checks.map((x) => x.maxSpin)), duplicatesMax: Math.max(0, ...checks.map((x) => x.duplicates)),
        first: checks[0], last: checks[checks.length - 1], eventsAt: checks.filter((_, i) => i % 10 === 9).map((x) => x.events), activeAt: checks.filter((_, i) => i % 10 === 9).map((x) => x.active), heapAt: checks.filter((_, i) => i % 10 === 9).map((x) => x.heapMB),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      save();
    }
  });
});
