/**
 * Phase 29: cost of the atmosphere in the simulation core (no rendering). Each scene is stepped one fixed
 * step at a time (worst step measured; long runs in 1 s steps, cost only) with the profiler sections
 *   atmosphere.prepare (plan, column-mass solve, layer coupling, rooms), atmosphere.after (gas, ledgers,
 *   stats), thermal.solve, fire.combustion / fire.after (smoke transport), volcano.prepare / after,
 *   sys.windForce (force transfer), sys.waterSolver, physics.
 * Windows of interest are reached by fast-forwarding (unmeasured, `skip`). Self-contained (no Phase 29
 * imports): with AB=1 every scene also runs without its atmosphere experiment, and the same file runs on
 * the Phase 28 build (the experiment is dropped there) for the A/B.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/atmosphere.bench --silent=false   (BENCH_OUT=file.json, SCENES=a,b, AB=1)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { rapierWorlds } from '@/physics/RapierEngine';
import { phenomena } from '@/phenomena/registry';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const D = (id: string) => createDesign(presetSpec(id)!, id);
type Add = { type: string; building?: ReturnType<typeof D>; params?: Record<string, unknown>; seed: number; transform: { position: Vec3; rotation: Vec3; scale: Vec3 } };
type H = (x: number, z: number) => number;
const DEG = Math.PI / 180;
const flat: H = () => 0;
const slope = (deg: number, x1 = 40): H => (x) => Math.round((x < x1 ? (x1 - Math.max(-100, x)) * Math.tan(deg * DEG) : 0) * 100) / 100;
const HAS_ATMOS = !!phenomena.implemented('atmosphere');

function world(h: H, add: Add[], fire?: Record<string, unknown>): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench29'));
  const t0 = S().doc.terrain;
  const heights = new Float32Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = h(t0.originX + ix * t0.cellSize, t0.originZ + iz * t0.cellSize);
  S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  if (add.length) S().applyEdit({ add: add.map((a) => ({ ...a, transform: { ...a.transform, position: [a.transform.position[0], h(a.transform.position[0], a.transform.position[2]), a.transform.position[2]] as Vec3 } })) as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 42;
  if (fire) (d.settings.simulation as unknown as Record<string, unknown>).fire = { foliageMoisture: 0.2, openings: 'asBuilt', heatIgnition: false, ...fire };
  return d;
}
const tf = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const tree = (x: number, z: number, seed: number): Add => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });
function houses(n: number): Add[] {
  const d = D('house'), out: Add[] = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) out.push({ type: 'building', building: d, seed: out.length + 1, transform: tf(x, z) });
  return out;
}
function street(): Add[] {
  const out: Add[] = houses(6).map((h, k) => ({ ...h, transform: tf(-40 + (k % 3) * 25, -20 + Math.floor(k / 3) * 45) }));
  for (let k = 0; k < 4; k++) out.push({ type: 'car', seed: 20 + k, transform: tf(-30 + k * 15, 5) });
  out.push(tree(-45, 30, 3), tree(35, 30, 4), { type: 'sign', seed: 2, transform: tf(-10, 12) }, { type: 'streetLight', seed: 3, transform: tf(15, 12) });
  return out;
}
const atmos = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'atmosphere', altitude: 0, boundary: 'open', thermo: 'adiabatic', removal: 'none', startTime: 0, ...p } as EventSpec);
const wind = (speed: number): EventSpec => ({ event: 'wind', speed, direction: 'W', duration: 7200 } as EventSpec);
const remove = (target: number, duration: number, p: Record<string, unknown> = {}) => atmos({ removal: 'linear', extent: 'uniform', target, duration, ...p });
const erupt = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-70, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 3600, profile: 'constant', ...p } as EventSpec);
const fireAt = (x: number, z: number, startTime = 0): EventSpec => ({ event: 'fire', position: [x, z], height: 6, radius: 2.5, duration: 900, startTime } as EventSpec);
const forest = (n: number): Add[] => Array.from({ length: n }, (_, k) => tree(-40 + (k % 10) * 8, -36 + Math.floor(k / 10) * 8, 30 + k));

interface Scene { name: string; doc: () => WorldDocument; events: () => EventSpec[]; seconds: number; skip?: number }

const SCENES: Scene[] = [
  { name: '1 basic atmosphere (rest, street)', doc: () => world(flat, street()), events: () => [atmos()], seconds: 30, skip: 5 },
  { name: '2 pressure change (prescribed path to 80 kPa)', doc: () => world(flat, street()), events: () => [atmos({ removal: 'pressure', target: 0.8, duration: 120 })], seconds: 30, skip: 30 },
  { name: '3 gradual removal (to 10 % in 120 s)', doc: () => world(flat, street()), events: () => [remove(0.1, 120)], seconds: 30, skip: 60 },
  { name: '4 restoration (reservoir, after removal to 30 %)', doc: () => world(flat, street()), events: () => [remove(0.3, 60, { restore: 'reservoir', restoreAt: 70, restoreDuration: 60, restoreTarget: 1 })], seconds: 30, skip: 80 },
  { name: '5 temperature change (heated ground, 40 °C datum)', doc: () => world(flat, street()), events: () => [atmos({ temperature: 313.15 }), { event: 'heatSource', kind: 'area', position: [0, 0], height: 0, radius: 30, input: 'power', power: 5e6, profile: 'constant', duration: 600 } as EventSpec], seconds: 30, skip: 60 },
  { name: '6 thermal plume (3 MW volume source)', doc: () => world(flat, street()), events: () => [atmos(), { event: 'heatSource', kind: 'volume', position: [0, 0], height: 5, radius: 4, input: 'power', power: 3e6, profile: 'constant', duration: 600 } as EventSpec], seconds: 30, skip: 60 },
  { name: '7 wind 25 m/s', doc: () => world(flat, street()), events: () => [atmos(), wind(25)], seconds: 30, skip: 10 },
  { name: '8 pressure-driven flow (local sink, open)', doc: () => world(flat, street()), events: () => [atmos({ removal: 'linear', extent: 'local', position: [0, 0], radius: 15, target: 0.995, duration: 300 })], seconds: 30, skip: 30 },
  { name: '9 low density + vehicles (30 kPa, 20 cars, wind)', doc: () => world(flat, Array.from({ length: 20 }, (_, k) => ({ type: 'car', seed: 40 + k, transform: tf(-60 + (k % 10) * 12, -10 + Math.floor(k / 10) * 20) }))), events: () => [atmos({ pressure: 30_000 }), wind(30)], seconds: 30, skip: 10 },
  { name: '10 low density + trees (30 kPa, 60 trees, wind)', doc: () => world(flat, forest(60)), events: () => [atmos({ pressure: 30_000 }), wind(30)], seconds: 30, skip: 10 },
  { name: '11 low density + buildings (30 kPa, 12 houses, wind)', doc: () => world(flat, houses(12)), events: () => [atmos({ pressure: 30_000 }), wind(40)], seconds: 30, skip: 10 },
  { name: '12 low pressure + fire (30 %, closed, stand)', doc: () => world(flat, forest(20), {}), events: () => [remove(0.3, 60, { boundary: 'closed' }), fireAt(-40, -36, 70)], seconds: 30, skip: 75 },
  { name: '13 smoke transport (stand fire + sink + wind)', doc: () => world(flat, forest(20), {}), events: () => [atmos({ removal: 'linear', extent: 'local', position: [30, 0], radius: 12, target: 0.997, duration: 600 }), wind(3), fireAt(-40, -36, 5)], seconds: 30, skip: 30 },
  { name: '14 ash transport (thin air, wind)', doc: () => world(slope(5), houses(6)), events: () => [remove(0.3, 60), wind(6), erupt({ ashFraction: 0.2, plumeHeight: 80, startTime: 60 })], seconds: 30, skip: 120 },
  { name: '15 volcanic plume and gas (standard air)', doc: () => world(slope(5), []), events: () => [atmos(), erupt({ ashFraction: 0.1, plumeHeight: 80 })], seconds: 30, skip: 120 },
  { name: '16 meteor atmospheric entry (opt-in, 50 kPa)', doc: () => world(flat, street()), events: () => [atmos({ pressure: 50_000, coupleMeteor: true }), { event: 'impact', target: [0, 0], material: 'stony', diameter: 2, speed: 18000, angle: 45, azimuth: 90, entry: 'atmosphere', airBlast: true, startTime: 1 } as EventSpec], seconds: 10, skip: 0 },
  { name: '17 blast compatibility (opt-in, 70 kPa)', doc: () => world(flat, street()), events: () => [atmos({ pressure: 70_000, coupleBlast: true }), { event: 'blast', position: [0, 0], height: 1, energy: 2e8, model: 'weakShock', waveform: 'nWave', startTime: 1 } as EventSpec], seconds: 6, skip: 0 },
  { name: '18 town of 100 houses (removal + wind)', doc: () => world(flat, houses(100)), events: () => [remove(0.3, 120), wind(20)], seconds: 30, skip: 30 },
  { name: '19 town of 500 houses (removal + wind)', doc: () => world(flat, houses(500)), events: () => [remove(0.3, 120), wind(20)], seconds: 30, skip: 30 },
  { name: '20 town of 1000 houses (removal + wind)', doc: () => world(flat, houses(1000)), events: () => [remove(0.3, 120), wind(20)], seconds: 30, skip: 30 },
  { name: '21 long change (1 h removal + restoration, coarse)', doc: () => world(flat, street()), events: () => [remove(0.2, 1500, { restore: 'boundary', restoreAt: 1800, restoreDuration: 1500, restoreTarget: 1 }), wind(8)], seconds: 3600 },
];

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function run(sc: Scene, withAtmos: boolean) {
  const doc = sc.doc();
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of sc.events()) if (withAtmos || e.event !== ('atmosphere' as string)) c.addEvent(e);
  if (sc.skip) c.advance(sc.skip);
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const coarse = sc.seconds > 600;
  const step = coarse ? 1 : 1 / 60;
  const steps = Math.round(sc.seconds / step);
  let worst = 0, worstAt = 0, maxIt = 0, maxChanged = 0;
  const secs = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  let worstSections: Record<string, number> = {};
  const atm = () => ((c.getEnvironment() as unknown as Any).atmosphere?.rt ?? null) as Any | null;
  const steps0 = atm()?.field.steps ?? 0, solves0 = atm()?.field.solves ?? 0;
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) {
    const before = secs();
    const a = performance.now();
    c.advance(step);
    const ms = performance.now() - a;
    if (ms > worst && !coarse) {
      worst = ms; worstAt = c.getTime();
      const after = secs();
      worstSections = Object.fromEntries(Object.entries(after).map(([n, v]) => [n, +(v - (before[n] ?? 0)).toFixed(1)]).filter(([, v]) => (v as number) >= 1).sort((x, y) => (y[1] as number) - (x[1] as number)));
    }
    const ar = atm();
    if (ar) { maxIt = Math.max(maxIt, ar.field.lastIterations); maxChanged = Math.max(maxChanged, ar.field.res?.changed?.length ?? 0); }
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const env = c.getEnvironment() as unknown as Any;
  const ar = atm(), rt = env.thermal.rt;
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const f = ar?.field;
  const out = {
    scene: sc.name, atmosphere: withAtmos && !!ar, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds, from: sc.skip ?? 0, stepping: coarse ? '1 s (cost only)' : 'fixed 1/60 s',
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: coarse ? null : +worst.toFixed(1), worstAt: coarse ? null : +worstAt.toFixed(2), worstSections,
    atmosMsPerSimS: +(per('atmosphere.prepare') + per('atmosphere.after')).toFixed(2), atmosPrepareMsPerSimS: per('atmosphere.prepare'), atmosAfterMsPerSimS: per('atmosphere.after'),
    thermalSolveMsPerSimS: per('thermal.solve'), tracerMsPerSimS: +(per('fire.after') + per('atmosphere.after')).toFixed(2), fireMsPerSimS: +(per('fire.combustion') + per('fire.after')).toFixed(2),
    volcanoMsPerSimS: +(per('volcano.prepare') + per('volcano.after')).toFixed(2), forceMsPerSimS: per('sys.windForce'), waterMsPerSimS: per('sys.waterSolver'), physicsMsPerSimS: per('physics'),
    columns: f ? f.count : 0, solvesShare: f ? +((f.solves - solves0) / Math.max(1, f.steps - steps0)).toFixed(2) : 0, maxPcgIterations: maxIt, maxChangedColumns: maxChanged,
    share: ar ? +ar.stats.share.toFixed(4) : 1, minPressurePa: ar ? +ar.stats.minPressure.toFixed(1) : 0, peakFlow: ar ? +ar.stats.peakSpeed.toFixed(3) : 0,
    massResidualRel: ar ? +ar.stats.massResidual.toExponential(2) : 0, energyResidualRel: ar ? +ar.stats.energyResidual.toExponential(2) : 0,
    thermalRelResidual: rt ? +rt.world.ledger.relativeResidual().toExponential(2) : 0, bodies: rt?.stats.bodies ?? 0, activeTiles: rt?.stats.activeTiles ?? 0, duplicates: c.duplicateForces(),
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('atmosphere benchmark', () => {
  it('scenes', { timeout: 14_400_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    const ab = !!process.env.AB || !HAS_ATMOS;
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      if (HAS_ATMOS) { const row = await run(sc, true); console.log(JSON.stringify(row)); rows.push(row); }
      if (ab) { const row = await run(sc, false); console.log(JSON.stringify(row)); rows.push(row); }
    }
    if (!only || only.includes('22')) {
      const sc = SCENES[2];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 10, skip: 20 }, HAS_ATMOS); heaps.push(r.heapMB); }
      const row = { scene: '22 repeated runs (gradual removal ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), build: HAS_ATMOS ? 'phase29' : 'phase28', rows }, null, 2));
  });
});
