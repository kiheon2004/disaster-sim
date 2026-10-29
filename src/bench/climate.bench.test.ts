/**
 * Phase 30: cost of the climate in the simulation core (no rendering). Each scene is stepped one fixed step at a time
 * (worst step measured; long runs in 1 s steps, cost only) with the profiler sections
 *   climate.prepare (forcing, surface coupling), climate.after → climate.evap / precip / covers / water / soil / stores /
 *   shortwave (surface step, 1 s), climate.air (vapour transport, condensation), climate.objects (loads, roads),
 *   climate.stats, thermal.solve (ground step with the climate surface balance), sys.waterSolver (flood coupling),
 *   sys.structuralCollapse (structural updates), physics.
 * With AB=1 every scene also runs without its climate experiment, and the same file runs on the Phase 29 build (the
 * experiment is dropped there) for the A/B.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/climate.bench --silent=false   (BENCH_OUT=file.json, SCENES=a,b, AB=1)
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
const valley: H = (x, z) => Math.round(Math.min(18, Math.abs(z) * 0.25 + Math.max(0, x + 20) * 0.05) * 100) / 100;
const HAS = !!phenomena.implemented('climate');
const K = (c: number) => c + 273.15;
type Lake = { id: string; kind: 'lake'; points: [number, number][]; surface: number; depth: number; shoreWidth: number; material: number; filled: boolean };
const LAKE: Lake = { id: 'l1', kind: 'lake', points: [[-60, -40], [20, -40], [20, 40], [-60, 40]], surface: -0.3, depth: 0.8, shoreWidth: 3, material: 7, filled: true };

function world(h: H, add: Add[], opts: { fire?: Record<string, unknown>; lake?: Lake; ground?: (x: number, z: number) => number } = {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench30'));
  const t0 = S().doc.terrain;
  const heights = new Float32Array(t0.heights.length), ground = new Uint8Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) {
    const x = t0.originX + ix * t0.cellSize, z = t0.originZ + iz * t0.cellSize;
    heights[iz * t0.nx + ix] = h(x, z);
    ground[iz * t0.nx + ix] = opts.ground ? opts.ground(x, z) : 0;
  }
  S().applyEdit({ landscape: { base: { heights, ground } } });
  if (opts.lake) S().setFeatures([opts.lake as never], 2);
  if (add.length) S().applyEdit({ add: add.map((a) => ({ ...a, transform: { ...a.transform, position: [a.transform.position[0], h(a.transform.position[0], a.transform.position[2]), a.transform.position[2]] as Vec3 } })) as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 42;
  if (opts.fire) (d.settings.simulation as unknown as Record<string, unknown>).fire = { foliageMoisture: 0.8, openings: 'asBuilt', heatIgnition: false, ...opts.fire };
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
  out.push(tree(-45, 30, 3), tree(35, 30, 4), { type: 'human', seed: 9, transform: tf(0, 10) });
  return out;
}
const forest = (n: number): Add[] => Array.from({ length: n }, (_, k) => tree(-40 + (k % 10) * 8, -36 + Math.floor(k / 10) * 8, 30 + k));
const base = { event: 'climate', scenario: 'custom', forcing: 'flux', profile: 'constant', humidity: 0.6, soilMoisture: 0.25, solar: 'off', precipitation: 0, mixTime: 900, startTime: 0 };
const cl = (p: Record<string, unknown>): EventSpec => ({ ...base, duration: 7200, temperature: K(15), target: K(15), ...p } as EventSpec);
const wind = (speed: number): EventSpec => ({ event: 'wind', speed, direction: 'W', duration: 7200 } as EventSpec);
const erupt = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-70, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 3600, profile: 'constant', ...p } as EventSpec);
const snowTown = (n: number): Scene => ({ name: `${n === 100 ? 21 : n === 500 ? 22 : 23} town of ${n} houses (snowfall + initial snow)`, doc: () => world(flat, houses(n)), events: () => [cl({ temperature: K(-3), target: K(-3), humidity: 0.9, precipitation: 10, precipPhase: 'snow', initialSnow: 0.3, initialSnowDensity: 250 })], seconds: 30, skip: 30 });

interface Scene { name: string; doc: () => WorldDocument; events: () => EventSpec[]; seconds: number; skip?: number }

const SCENES: Scene[] = [
  { name: '1 basic climate (street, 15 °C, clear sun)', doc: () => world(flat, street()), events: () => [cl({ solar: 'clearSky', hour: 11, dayOfYear: 120 })], seconds: 30, skip: 5 },
  { name: '2 heatwave (26 → 38 °C, sun)', doc: () => world(flat, street()), events: () => [cl({ scenario: 'heatwave', temperature: K(26), target: K(38), profile: 'linear', ramp: 600, humidity: 0.4, humidityTarget: 0.25, solar: 'clearSky', hour: 12, dayOfYear: 200 })], seconds: 30, skip: 120 },
  { name: '3 cold wave (2 → −20 °C, night)', doc: () => world(flat, street()), events: () => [cl({ scenario: 'coldWave', temperature: K(2), target: K(-20), profile: 'linear', ramp: 300, humidity: 0.7 })], seconds: 30, skip: 120 },
  { name: '4 high humidity (95 %, 28 °C, cooling)', doc: () => world(flat, street(), { lake: LAKE }), events: () => [cl({ scenario: 'humid', temperature: K(28), target: K(20), profile: 'linear', ramp: 300, humidity: 0.95 })], seconds: 30, skip: 120 },
  { name: '5 evaporation (lake, 35 °C, 20 %)', doc: () => world(flat, [], { lake: LAKE }), events: () => [cl({ scenario: 'drying', temperature: K(35), target: K(35), humidity: 0.2, solar: 'clearSky', hour: 13, dayOfYear: 200 }), wind(5)], seconds: 30, skip: 60 },
  { name: '6 condensation (humid air over a cold lake)', doc: () => world(flat, [], { lake: LAKE }), events: () => [cl({ forcing: 'prescribed', temperature: K(8), target: K(1), profile: 'linear', ramp: 60, humidity: 0.98 })], seconds: 30, skip: 90 },
  { name: '7 snowfall (10 mm/h, −3 °C)', doc: () => world(flat, street()), events: () => [cl({ scenario: 'snowfall', temperature: K(-3), target: K(-3), humidity: 0.9, precipitation: 10, precipPhase: 'auto' })], seconds: 30, skip: 30 },
  { name: '8 large snowpack (1 m, street)', doc: () => world(flat, street()), events: () => [cl({ temperature: K(-5), target: K(-5), humidity: 0.8, initialSnow: 1, initialSnowDensity: 300 })], seconds: 30, skip: 30 },
  { name: '9 snow compaction (30 cm, 1 h, coarse)', doc: () => world(flat, []), events: () => [cl({ temperature: K(-1), target: K(-1), humidity: 0.85, initialSnow: 0.3, initialSnowDensity: 120 })], seconds: 3600 },
  { name: '10 snowmelt (20 cm, warming to 12 °C, sun)', doc: () => world(flat, street()), events: () => [cl({ scenario: 'snowmelt', temperature: K(1), target: K(12), profile: 'linear', ramp: 300, humidity: 0.8, initialSnow: 0.2, initialSnowDensity: 300, solar: 'clearSky', hour: 12, dayOfYear: 100 })], seconds: 30, skip: 300 },
  { name: '11 snowmelt flood (valley, rain on snow)', doc: () => world(valley, []), events: () => [cl({ temperature: K(6), target: K(12), profile: 'linear', ramp: 300, humidity: 0.95, initialSnow: 0.6, initialSnowDensity: 350, precipitation: 15, precipPhase: 'rain' }), wind(6)], seconds: 30, skip: 600 },
  { name: '12 road icing (asphalt, rain then −6 °C)', doc: () => world(flat, [{ type: 'car', seed: 5, transform: tf(-20, 0) }, { type: 'car', seed: 6, transform: tf(10, 2) }], { ground: (_x, z) => (Math.abs(z) <= 5 ? 3 : 0) }), events: () => [cl({ scenario: 'roadIcing', temperature: K(2), target: K(-6), profile: 'linear', ramp: 600, humidity: 0.9, precipitation: 2, precipPhase: 'rain', precipStart: 0, precipDuration: 400 })], seconds: 30, skip: 600 },
  { name: '13 lake freezing (−20 °C, wind)', doc: () => world(flat, [], { lake: LAKE }), events: () => [cl({ scenario: 'lakeFreezing', forcing: 'prescribed', temperature: K(0.3), target: K(-20), humidity: 0.7 }), wind(5)], seconds: 30, skip: 600 },
  { name: '14 freeze–thaw (−6 … +6 °C, 20 min cycle)', doc: () => world(flat, houses(6)), events: () => [cl({ temperature: K(-6), target: K(6), profile: 'cyclic', period: 1200, humidity: 0.85, soilMoisture: 0.3 })], seconds: 30, skip: 300 },
  { name: '15 solar radiation (solstice noon)', doc: () => world(slope(8), street()), events: () => [cl({ temperature: K(25), target: K(25), humidity: 0.4, solar: 'clearSky', hour: 12, dayOfYear: 172 })], seconds: 30, skip: 120 },
  { name: '16 heatwave + fire (dry stand)', doc: () => world(flat, forest(20), { fire: {} }), events: () => [cl({ scenario: 'heatwave', temperature: K(32), target: K(40), profile: 'linear', ramp: 300, humidity: 0.2, soilMoisture: 0.05, solar: 'clearSky', hour: 12, dayOfYear: 200 }), { event: 'fire', position: [-40, -36], height: 6, radius: 2.5, duration: 900, startTime: 120 } as EventSpec], seconds: 30, skip: 130 },
  { name: '17 cold wave + buildings (12 houses)', doc: () => world(flat, houses(12)), events: () => [cl({ scenario: 'coldWave', temperature: K(0), target: K(-25), profile: 'linear', ramp: 300, humidity: 0.7, initialSnow: 0.2 })], seconds: 30, skip: 120 },
  { name: '18 snowfall + wind (blowing snow)', doc: () => world(flat, street()), events: () => [cl({ temperature: K(-8), target: K(-8), humidity: 0.85, precipitation: 6, precipPhase: 'snow', initialSnow: 0.2, initialSnowDensity: 100 }), wind(16)], seconds: 30, skip: 30 },
  { name: '19 volcano + snow', doc: () => world(slope(5), [], {}), events: () => [cl({ temperature: K(-4), target: K(-4), humidity: 0.8, initialSnow: 0.5, initialSnowDensity: 300 }), erupt({ startTime: 10 })], seconds: 30, skip: 120 },
  { name: '20 low pressure + evaporation (removal to 20 %, lake)', doc: () => world(flat, [], { lake: LAKE }), events: () => [{ event: 'atmosphere', altitude: 0, boundary: 'closed', thermo: 'adiabatic', removal: 'linear', extent: 'uniform', target: 0.2, duration: 120, startTime: 0 } as EventSpec, cl({ temperature: K(15), target: K(15), humidity: 0.5 })], seconds: 30, skip: 120 },
  snowTown(100), snowTown(500), snowTown(1000),
  { name: '24 long climate change (cyclic 1 h, coarse)', doc: () => world(flat, street(), { lake: LAKE }), events: () => [cl({ temperature: K(-4), target: K(10), profile: 'cyclic', period: 3600, humidity: 0.75, solar: 'clearSky', hour: 9, dayOfYear: 80, precipitation: 3, precipPhase: 'auto', precipStart: 600, precipDuration: 1200 })], seconds: 3600 },
];

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function run(sc: Scene, withClimate: boolean) {
  const doc = sc.doc();
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of sc.events()) if (withClimate || e.event !== ('climate' as string)) c.addEvent(e);
  if (sc.skip) c.advance(sc.skip);
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const coarse = sc.seconds > 600;
  const step = coarse ? 1 : 1 / 60;
  const steps = Math.round(sc.seconds / step);
  let worst = 0, worstAt = 0;
  const secs = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  let worstSections: Record<string, number> = {};
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
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const env = c.getEnvironment() as unknown as Any;
  const cr = env.climate?.rt ?? null, rt = env.thermal.rt;
  const st = cr ? cr.stats : null;
  let activeCovers = 0;
  if (cr) for (let i = 0; i < cr.cw.n; i++) if (cr.cw.cM[i] > 0) activeCovers++;
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const out = {
    scene: sc.name, climate: withClimate && !!cr, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds, from: sc.skip ?? 0, stepping: coarse ? '1 s (cost only)' : 'fixed 1/60 s',
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: coarse ? null : +worst.toFixed(1), worstAt: coarse ? null : +worstAt.toFixed(2), worstSections,
    climateMsPerSimS: +(per('climate.prepare') + per('climate.after')).toFixed(2), prepare: per('climate.prepare'), evap: per('climate.evap'), precip: per('climate.precip'), covers: per('climate.covers'),
    water: per('climate.water'), soil: per('climate.soil'), stores: per('climate.stores'), shortwave: per('climate.shortwave'), air: per('climate.air'), objectsMs: per('climate.objects'), stats: per('climate.stats'),
    thermalSolveMsPerSimS: per('thermal.solve'), floodMsPerSimS: per('sys.waterSolver'), structureMsPerSimS: per('sys.structuralCollapse'), fireMsPerSimS: +(per('fire.combustion') + per('fire.after')).toFixed(2),
    volcanoMsPerSimS: +(per('volcano.prepare') + per('volcano.after')).toFixed(2), atmosMsPerSimS: +(per('atmosphere.prepare') + per('atmosphere.after')).toFixed(2), physicsMsPerSimS: per('physics'),
    activeCovers, activeTiles: rt?.stats.activeTiles ?? 0, bodies: rt?.stats.bodies ?? 0,
    snowKg: st ? +st.snowMass.toFixed(1) : 0, iceKg: st ? +st.iceMass.toFixed(1) : 0, meltKg: st ? +st.meltwater.toFixed(1) : 0, evapKg: st ? +st.evaporation.toFixed(2) : 0, maxRoofKPa: st ? +st.maxRoofLoad.toFixed(3) : 0,
    waterResidualRel: st ? +st.waterResidual.toExponential(2) : 0, energyResidualRel: st ? +st.energyResidual.toExponential(2) : 0, thermalRelResidual: rt ? +rt.world.ledger.relativeResidual().toExponential(2) : 0,
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('climate benchmark', () => {
  it('scenes', { timeout: 28_800_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    const ab = !!process.env.AB || !HAS;
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      if (HAS) { const row = await run(sc, true); console.log(JSON.stringify(row)); rows.push(row); }
      if (ab) { const row = await run(sc, false); console.log(JSON.stringify(row)); rows.push(row); }
    }
    if (!only || only.includes('25')) {
      const sc = SCENES[6];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 10, skip: 10 }, HAS); heaps.push(r.heapMB); }
      const row = { scene: '25 repeated runs (snowfall ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), build: HAS ? 'phase30' : 'phase29', rows }, null, 2));
  });
});
