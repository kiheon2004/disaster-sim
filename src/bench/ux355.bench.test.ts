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
