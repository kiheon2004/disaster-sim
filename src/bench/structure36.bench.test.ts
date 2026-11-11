/**
 * Phase 36 fair structure benchmark (spec §62), headless — BENCH=1 to run (skipped otherwise):
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc BENCH_OUT=docs/bench-phase36-structure.json npx vitest run src/bench/structure36.bench --silent=false
 *
 * What is compared: the SAME building at three structural levels under the same earthquake —
 *   L0 = legacy box building with designParams(design) (same width, depth, storeys, materials as the design),
 *   L1 = the member-model design (structure v1 engine), L2 = the same design with structure v2.
 * Fairness rules:
 *   - no overlap: buildings on a grid with spacing = max(width, depth) + 1 m; the 200 m map (188 m usable) holds at most
 *     `capacity` of them, larger counts are CAPPED to it and reported (`capped`, `capacity`) — the editor's world size
 *     is fixed, so 1000 do not fit a 2-storey house grid (a larger map would change the terrain / water grids too);
 *   - the same simulated window for every level: from t = 0 to WINDOW_S (default: start + 0.6 × duration, which covers
 *     the envelope peak at S−P + 0.28 × (duration − S−P), SyntheticWaveform);
 *   - a discarded warm-up run of each cell (WARMUP_S simulated seconds) before its measured repeats;
 *   - REPEATS (≥ 5 by default) repeats with the level order rotated each repeat (L0 L1 L2, L1 L2 L0, L2 L0 L1, …);
 *   - global.gc() between cells (needs NODE_OPTIONS=--expose-gc), and per run os.loadavg() and process.cpuUsage();
 *   - statistics per cell: mean / median / IQR / stdev of ms per simulated second (+ worst 1/60 s step).
 *
 * Env: COUNTS (default 1,10,50,100,250,1000), REPEATS (5), PRESET (house), FLOORS (2), PGA (0.5), DURATION (12),
 * WINDOW_S, WARMUP_S (1), SMOKE=1 (COUNTS=2, REPEATS=1, WINDOW_S=0.5, WARMUP_S=0.2: a quick check that it runs),
 * BENCH_OUT (JSON file, rewritten after every cell).
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { presetDesign } from '@/roads/city';
import { designParams } from '@/buildings/design';

type Level = 'L0' | 'L1' | 'L2';
const LEVELS: Level[] = ['L0', 'L1', 'L2'];
const SMOKE = !!process.env.SMOKE;
const env = (k: string, d: string) => process.env[k] ?? d;
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const T = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });

/** The building every level uses, its grid spacing and how many fit the map. */
function building() {
  const design = presetDesign(env('PRESET', 'house'), +env('FLOORS', '2'))!;
  const spacing = Math.max(design.spec.width, design.spec.depth) + 1;
  const side = Math.floor(188 / spacing) + 1;
  return { design, legacy: designParams(design), spacing, capacity: side * side };
}

function town(n: number, level: Level, b: ReturnType<typeof building>): WorldDocument {
  const d = createEmptyDocument('bench36');
  d.settings.simulation.seed = 42;
  if (level === 'L2') d.settings.simulation.structure = { model: 'v2' };
  const side = Math.ceil(Math.sqrt(n));
  const h = ((side - 1) * b.spacing) / 2;
  for (let k = 0; k < n; k++) {
    const x = -h + b.spacing * (k % side), z = -h + b.spacing * Math.floor(k / side);
    const input: CreateObjectInput = level === 'L0'
      ? { type: 'building', params: { ...b.legacy }, seed: k + 1, transform: T(x, z) }
      : { type: 'building', building: b.design, seed: k + 1, transform: T(x, z) };
    const o = createWorldObject(input, nextSerial(d.objects, 'building'));
    d.objects[o.id] = o;
  }
  return d;
}

const SECTIONS = ['physics', 'structural', 'structuralCollapse', 'seismicDamage', 'damage', 'dispatch'];

async function runCell(doc: WorldDocument, quake: EventSpec, seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  c.addEvent(quake);
  simProfiler.enabled = true;
  const sec = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  const s0 = sec();
  const load0 = os.loadavg()[0];
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let worst = 0;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const a = performance.now();
    c.advance(1 / 60);
    worst = Math.max(worst, performance.now() - a);
  }
  const ms = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const s1 = sec();
  const sections: Record<string, number> = {};
  for (const k of SECTIONS) sections[k] = +(((s1[`sys.${k}`] ?? s1[k] ?? 0) - (s0[`sys.${k}`] ?? s0[k] ?? 0)) / seconds).toFixed(2);
  const events = c.getDamageEvents().length;
  c.unload();
  simProfiler.enabled = false;
  return {
    msPerSimS: ms / seconds, worstStepMs: worst, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    load1Start: load0, load1End: os.loadavg()[0], sections, events, heapMB: process.memoryUsage().heapUsed / 1048576,
  };
}

/** mean / median / IQR / stdev of a sample. */
export function stats(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
  const r = (x: number) => +x.toFixed(2);
  return { n: s.length, mean: r(mean), median: r(q(0.5)), iqr: r(q(0.75) - q(0.25)), stdev: r(sd), min: r(s[0] ?? NaN), max: r(s[s.length - 1] ?? NaN) };
}

describe('bench helpers', () => {
  it('statistics of a sample', () => {
    expect(stats([1, 2, 3, 4, 5])).toMatchObject({ mean: 3, median: 3, iqr: 2, min: 1, max: 5 });
    expect(stats([2, 4]).stdev).toBeCloseTo(1.41, 2);
  });
});

describe.skipIf(!process.env.BENCH)('Phase 36 fair structure benchmark', () => {
  it('L0 / L1 / L2, same building, same window', { timeout: 28_800_000 }, async () => {
    const b = building();
    const COUNTS = env('COUNTS', SMOKE ? '2' : '1,10,50,100,250,1000').split(',').map(Number);
    const REPEATS = +env('REPEATS', SMOKE ? '1' : '5');
    const duration = +env('DURATION', '12');
    const quake: EventSpec = { event: 'earthquake', magnitude: 6.8, pga: +env('PGA', '0.5'), duration, seed: 3, startTime: 0.2 } as EventSpec;
    const WINDOW = +env('WINDOW_S', SMOKE ? '0.5' : String(+(0.2 + 0.6 * duration).toFixed(1)));
    const WARMUP = +env('WARMUP_S', SMOKE ? '0.2' : '1');
    const out = {
      date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, ncpu: os.cpus().length, gcExposed: typeof (globalThis as { gc?: unknown }).gc === 'function',
      building: { preset: env('PRESET', 'house'), floors: +env('FLOORS', '2'), width: b.design.spec.width, depth: b.design.spec.depth, spacing: b.spacing, capacity: b.capacity },
      quake, windowS: WINDOW, warmupS: WARMUP, repeats: REPEATS, runs: [] as Record<string, unknown>[], cells: [] as Record<string, unknown>[],
    };
    const save = () => { if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2)); };
    for (const asked of COUNTS) {
      const n = Math.min(asked, b.capacity);
      const docs = Object.fromEntries(LEVELS.map((l) => [l, () => town(n, l, b)])) as Record<Level, () => WorldDocument>;
      // Discarded warm-up of each cell (JIT, caches, Rapier pools) before the measured repeats.
      for (const l of LEVELS) { gc(); await runCell(docs[l](), quake, WARMUP); }
      const samples: Record<Level, Awaited<ReturnType<typeof runCell>>[]> = { L0: [], L1: [], L2: [] };
      for (let r = 0; r < REPEATS; r++) {
        const order = LEVELS.map((_, k) => LEVELS[(k + r) % LEVELS.length]);
        for (const level of order) {
          gc();
          const res = await runCell(docs[level](), quake, WINDOW);
          samples[level].push(res);
          out.runs.push({ asked, n, level, repeat: r, order: order.join(' '), ...res });
          save();
        }
      }
      for (const level of LEVELS) {
        const s = samples[level];
        out.cells.push({
          asked, n, capped: n < asked, capacity: b.capacity, level,
          msPerSimS: stats(s.map((x) => x.msPerSimS)), worstStepMs: stats(s.map((x) => x.worstStepMs)), cpuMs: stats(s.map((x) => x.cpuUserMs + x.cpuSystemMs)),
          load1: stats(s.map((x) => x.load1Start)), heapMB: stats(s.map((x) => x.heapMB)),
        });
      }
      console.log(JSON.stringify(out.cells.slice(-3)));
      save();
    }
    expect(out.cells.length).toBe(COUNTS.length * LEVELS.length);
  });
});
