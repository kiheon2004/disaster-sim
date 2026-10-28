/**
 * CPU profile of the simulation core on the stress scenes (no rendering).
 *
 *   BENCH=1 npx vitest run src/bench --silent=false
 *   BENCH=1 BENCH_TERRAIN=gentleHills npx vitest run src/bench --silent=false   (same scenes on relief)
 *   BENCH=1 BENCH_HAZARD=earthquake npx vitest run src/bench --silent=false     (earthquake; or `both`)
 *   BENCH=1 BENCH_HAZARD=flood npx vitest run src/bench --silent=false          (flood; or `all` = wind + earthquake + flood)
 *
 * Instrumentation is attached from the outside (method wrapping), so the same harness can be run
 * against older revisions for before/after comparisons. Skipped in the normal test run.
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { stressScene } from '@/world/stressScene';
import type { TerrainPresetId, WorldDocument } from '@/core/model';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { reseat } from '@/terrain/groundPlacement';
import { WaterField } from '@/simulation/water/WaterField';
import { captureWaterState } from '@/simulation/water/waterStateCodec';

const COUNTS = (process.env.BENCH_COUNTS ?? '100,500,1000').split(',').map(Number);
const WARM_S = 4;
const MEASURE_S = 4;
const STEP_HZ = 60;

const TERRAIN = process.env.BENCH_TERRAIN as TerrainPresetId | undefined;
/**
 * wind (default) | earthquake | both | flood | all. Earthquake: M6.8, PGA 0.3 g, 90 s, seed 7 (strong
 * shaking for the whole window). Flood (Phase 14): starts from 0.5 m of water over the whole map
 * (every cell active), 100 mm/h rain and the south edge rising to 1.2 m — the worst case for the
 * solver (40 000 wet cells) and for the water forces (every free body in water).
 */
const HAZARD = process.env.BENCH_HAZARD ?? 'wind';
const WIND = HAZARD === 'wind' || HAZARD === 'both' || HAZARD === 'all';
const QUAKE = HAZARD === 'earthquake' || HAZARD === 'both' || HAZARD === 'all';
const FLOOD = HAZARD === 'flood' || HAZARD === 'all';

function floodStart(doc: WorldDocument) {
  const f = new WaterField(new TerrainSampler(doc.terrain), doc.settings.simulation.water);
  f.h.fill(0.5);
  return captureWaterState(f, 0);
}

function stressDoc(n: number): WorldDocument {
  const doc = createEmptyDocument(`Stress ${n}`);
  if (TERRAIN) doc.terrain = generateTerrain(TERRAIN, 1);
  const terrain = new TerrainSampler(doc.terrain);
  for (const input of stressScene(n)) {
    const o = createWorldObject(input, nextSerial(doc.objects, input.type));
    if (TERRAIN) o.transform = { ...o.transform, ...reseat(o, terrain) };
    doc.objects[o.id] = o;
  }
  return doc;
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Acc {
  ms: Record<string, number>;
  calls: Record<string, number>;
  current: string;
}

function wrap(obj: Any, key: string, name: string, acc: Acc, setCurrent = false) {
  const f = obj[key];
  if (typeof f !== 'function') return;
  obj[key] = function (this: unknown, ...args: unknown[]) {
    const prev = acc.current;
    if (setCurrent) acc.current = name;
    const s = performance.now();
    try {
      return f.apply(this, args);
    } finally {
      acc.ms[name] = (acc.ms[name] ?? 0) + performance.now() - s;
      acc.calls[name] = (acc.calls[name] ?? 0) + 1;
      if (setCurrent) acc.current = prev;
    }
  };
}

/** Counts (not times) wind samples per calling system. */
function countSamples(field: Any, acc: Acc) {
  const f = field.sample;
  field.sample = function (this: unknown, ...args: unknown[]) {
    const k = `samples.${acc.current}`;
    acc.calls[k] = (acc.calls[k] ?? 0) + 1;
    return f.apply(this, args);
  };
}

async function profile(n: number) {
  const c = new SimulationController() as unknown as Any;
  const doc = stressDoc(n);
  if (FLOOD) c.setInitialWaterState(floodStart(doc));
  await c.load(doc);
  if (WIND) c.addEvent({ event: 'wind', speed: 42, direction: 'E', duration: 120, gustStrength: 0.25, rampDuration: 4 });
  if (QUAKE) c.addEvent({ event: 'earthquake', magnitude: 6.8, pga: 0.3, duration: 90, epicenter: [40, -30], depth: 10, seed: 7 });
  if (FLOOD) {
    c.addEvent({ event: 'rain', intensity: 100, duration: 600 });
    c.addEvent({ event: 'risingWater', boundary: 'S', level: 1.2, riseRate: 2, duration: 600 });
  }
  c.advance(WARM_S);

  const rt = c.runtime as Any;
  const entities = [...rt.entities.values()] as Any[];
  const facade = entities.reduce((a, e) => a + (e.source.type === 'building' ? e.components.length : 0), 0);
  const dynamic = entities.filter((e) => e.dynamic).length;

  // Pass 1: coarse (system-level) timing — low overhead, used for the totals.
  const acc: Acc = { ms: {}, calls: {}, current: '' };
  wrap(c.physics, 'step', 'physics', acc);
  for (const s of c.systems as Any[]) wrap(s, 'update', `sys.${s.name}`, acc, true);
  wrap(c, 'step', 'step', acc);
  const rawSample = c.env.windField.sample;
  countSamples(c.env.windField, acc);
  const steps = MEASURE_S * STEP_HZ;
  let gcMs = 0;
  const gcObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcMs += e.duration; });
  gcObs.observe({ entryTypes: ['gc'] });
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  c.advance(MEASURE_S);
  const wall = performance.now() - t0;
  const heapDelta = process.memoryUsage().heapUsed - heap0;
  await new Promise((r) => setTimeout(r, 0)); // flush gc entries
  gcObs.disconnect();

  // Pass 2: replay one step's worth of wind samples in a tight loop (accurate per-call cost).
  const field = c.env.windField as Any;
  const recorded: { args: unknown[]; who: string }[] = [];
  const counting = field.sample;
  const orig = rawSample;
  let rec = true;
  field.sample = function (this: unknown, ...args: unknown[]) {
    if (rec) recorded.push({ args: [[...(args[0] as number[])], ...args.slice(1)], who: acc.current });
    return counting.apply(this, args);
  };
  c.advance(1 / STEP_HZ);
  rec = false;
  field.sample = counting;
  const reps = 50;
  const byWho: Record<string, number> = {};
  for (const who of new Set(recorded.map((r) => r.who))) {
    const list = recorded.filter((r) => r.who === who);
    const s = performance.now();
    for (let k = 0; k < reps; k++) for (const r of list) orig.apply(field, r.args);
    byWho[who] = (performance.now() - s) / reps;
  }
  const effect = field.obstacleEffect;
  const sh = performance.now();
  for (let k = 0; k < reps; k++) for (const r of recorded) effect.call(field, r.args[0], r.args[2]);
  const shadowMs = (performance.now() - sh) / reps;

  const per = (k: string) => (acc.ms[k] ?? 0) / steps;
  const row: Record<string, string | number> = {
    objects: entities.length,
    dynamic,
    facade,
    obstacles: (field.getObstacles() as unknown[]).length,
    'step ms': (wall / steps).toFixed(2),
    'realtime ×': ((MEASURE_S * 1000) / wall).toFixed(2),
    'physics ms': per('physics').toFixed(2),
    'gc ms': (gcMs / steps).toFixed(3),
    'heap growth KB/step': (heapDelta / 1024 / steps).toFixed(1),
  };
  for (const k of Object.keys(acc.ms).filter((x) => x.startsWith('sys.'))) row[k.slice(4)] = per(k).toFixed(2);
  row['other ms'] = (per('step') - Object.keys(acc.ms).filter((k) => k !== 'step').reduce((a, k) => a + per(k), 0)).toFixed(2);
  const sampleCalls = Object.entries(acc.calls).filter(([k]) => k.startsWith('samples.'));
  row['samples/step'] = (sampleCalls.reduce((a, [, v]) => a + v, 0) / (steps + 1)).toFixed(0);
  row['wind ms (replay)'] = Object.values(byWho).reduce((a, b) => a + b, 0).toFixed(2);
  row['shadow-query ms (replay, uncached)'] = shadowMs.toFixed(2);
  for (const [k, v] of sampleCalls) row[`samples ${k.slice(12)}`] = (v / (steps + 1)).toFixed(0);
  for (const [k, v] of Object.entries(byWho)) row[`wind ms ${k.slice(4)}`] = v.toFixed(3);
  const water = c.env.flood.field as WaterField | null;
  if (water) {
    row['water wet cells'] = water.stats.wetCells;
    row['water substeps/call'] = water.stats.substeps;
    row['water ms/call'] = ((acc.ms['sys.waterSolver'] ?? 0) / Math.max(1, acc.calls['sys.waterSolver'] ?? 1)).toFixed(2);
  }
  c.unload();
  return row;
}

describe.skipIf(!process.env.BENCH)('simulation CPU profile', () => {
  it('stress scenes', async () => {
    console.log(`hazard: ${HAZARD}`);
    const rows = [];
    for (const n of COUNTS) rows.push(await profile(n));
    console.log(JSON.stringify(rows, null, 1));
  }, 600_000);
});
