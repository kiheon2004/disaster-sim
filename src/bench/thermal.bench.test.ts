/**
 * Phase 26: cost of thermal physics in the simulation core (no rendering). Each scene is stepped one
 * fixed step at a time (worst step measured) with the profiler sections:
 *   sys.thermal (the whole ThermalSystem), thermal.solve (ThermalWorld.step: deposits, ground step,
 *   fast exchange, advection), thermal.couple (structure coupling, exposure, statistics);
 *   sys.structuralCollapse (the Phase 25 engine it drives); physics = Rapier.
 * Long heating scenes are fast-forwarded (unmeasured) to the window of interest (`skip`).
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/thermal --silent=false   (BENCH_OUT=file.json, SCENES=a,b)
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
import { defaultWaterSettings, type WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { HeatSourceSpec } from '@/thermal/types';
import { rapierWorlds } from '@/physics/RapierEngine';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const tf = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const D = (id: string) => createDesign(presetSpec(id)!, id);

type Add = { type: string; building?: ReturnType<typeof D>; seed: number; transform: ReturnType<typeof tf> };
function world(add: Add[], opts: { slope?: number; patch?: (d: WorldDocument) => void } = {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench26'));
  if (opts.slope) {
    const t0 = S().doc.terrain, heights = new Float32Array(t0.heights.length), tb = opts.slope;
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = -(t0.originX + ix * t0.cellSize) * tb;
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  }
  if (add.length) S().applyEdit({ add: add as never });
  const d = structuredClone(S().doc);
  opts.patch?.(d);
  return d;
}

function houses(n: number): Add[] {
  const d = D('house'), out: Add[] = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) {
    if (Math.hypot(x, z) < 12) continue;
    out.push({ type: 'building', building: d, seed: out.length + 1, transform: tf(x, z) });
  }
  return out;
}
function trees(n: number): Add[] {
  const out: Add[] = [];
  for (let k = 0; out.length < n; k++) { const a = k * 2.399963, r = 6 + 3.2 * Math.sqrt(k); out.push({ type: 'tree', seed: 500 + k, transform: tf(r * Math.cos(a), r * Math.sin(a)) }); }
  return out;
}
const heat = (p: Partial<HeatSourceSpec>): EventSpec => ({ event: 'heatSource', kind: 'point', position: [0, 0], height: 2, radius: 3, input: 'power', power: 1e6, profile: 'constant', duration: 600, ...p } as EventSpec);
const quake = (pga: number): EventSpec => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed: 3 } as EventSpec);
/** A hot sphere enclosing the first ground-story column of a design (inside the building). */
function atColumn(id: string, r: number): [number, number] {
  const m = D(id).members.find((x) => x.type === 'column' && x.level === 0)!;
  void r;
  return [m.position[0] + Math.sign(-m.position[0] || 1) * 1.8, m.position[2] + Math.sign(-m.position[2] || 1) * 1.8];
}

interface Scene { name: string; doc: () => WorldDocument; events: () => EventSpec[]; seconds: number; skip?: number; water?: number }

const SCENES: Scene[] = [
  { name: 'empty terrain, point 1 MW', doc: () => world([]), events: () => [heat({})], seconds: 60 },
  { name: 'ground surface heating (area 2 MW, r 10 m)', doc: () => world([]), events: () => [heat({ kind: 'area', radius: 10, power: 2e6 })], seconds: 60 },
  {
    name: 'rock and soil (two area sources)',
    doc: () => world([], { patch: (d) => { const t = d.terrain; for (let i = 0; i < t.ground.length; i++) if (i % t.nx < t.nx / 2) { t.ground[i] = 6; t.soil[i] = 0; } } }),
    events: () => [heat({ kind: 'area', position: [-40, 0], radius: 8, power: 1e6 }), heat({ kind: 'area', position: [40, 0], radius: 8, power: 1e6 })], seconds: 60,
  },
  { name: 'water (0.5 m still water, area 2 MW)', doc: () => world([], { patch: (d) => { d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false }; } }), events: () => [{ event: 'waterSource', position: [90, 90], rate: 0.001, duration: 600, radius: 1 } as EventSpec, heat({ kind: 'area', radius: 10, power: 2e6 })], seconds: 60, water: 0.5 },
  { name: 'water reference (same water, no heat)', doc: () => world([], { patch: (d) => { d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false }; } }), events: () => [{ event: 'waterSource', position: [90, 90], rate: 0.001, duration: 600, radius: 1 } as EventSpec], seconds: 60, water: 0.5 },
  { name: 'river heat advection (slope, 3 m³/s, area 3 MW)', doc: () => world([], { slope: 0.02 }), events: () => [{ event: 'waterSource', position: [-60, 0], rate: 3, duration: 600, radius: 2 } as EventSpec, heat({ kind: 'area', position: [-60, 0], radius: 3, power: 3e6, startTime: 5 })], seconds: 90 },
  { name: 'houses100 + point 5 MW + wind 5 m/s', doc: () => world(houses(100)), events: () => [{ event: 'wind', speed: 5, direction: 'W', duration: 600, gustStrength: 0 } as EventSpec, heat({ power: 5e6, height: 3 })], seconds: 30 },
  { name: 'houses500 + point 5 MW + wind 5 m/s', doc: () => world(houses(500)), events: () => [{ event: 'wind', speed: 5, direction: 'W', duration: 600, gustStrength: 0 } as EventSpec, heat({ power: 5e6, height: 3 })], seconds: 30 },
  { name: 'houses1000 + point 5 MW + wind 5 m/s', doc: () => world(houses(1000)), events: () => [{ event: 'wind', speed: 5, direction: 'W', duration: 600, gustStrength: 0 } as EventSpec, heat({ power: 5e6, height: 3 })], seconds: 30 },
  { name: 'modular member heating (warehouse, 900 °C sphere)', doc: () => world([{ type: 'building', building: D('warehouse'), seed: 1, transform: tf(0, 0) }]), events: () => [heat({ kind: 'temperature', temperature: 1173.15, radius: 2.6, height: 4, position: atColumn('warehouse', 2.6), duration: 900 })], seconds: 120 },
  { name: 'thermal structural damage (apartment, 1100 °C, 760–900 s)', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }]), events: () => [heat({ kind: 'temperature', temperature: 1373.15, radius: 3.2, height: 4, position: atColumn('apartment', 3.2), duration: 3000 })], seconds: 140, skip: 760 },
  { name: 'debris after thermal collapse (apartment, 900–960 s)', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }]), events: () => [heat({ kind: 'temperature', temperature: 1373.15, radius: 3.2, height: 4, position: atColumn('apartment', 3.2), duration: 3000 })], seconds: 60, skip: 900 },
  { name: 'forest (300 trees) + point 3 MW', doc: () => world(trees(300)), events: () => [heat({ power: 3e6, height: 3 })], seconds: 60 },
  { name: 'wind 12 m/s + point 2 MW (20 houses)', doc: () => world(houses(100).slice(0, 20)), events: () => [{ event: 'wind', speed: 12, direction: 'W', duration: 600, gustStrength: 0.2 } as EventSpec, heat({ power: 2e6 })], seconds: 60 },
  { name: 'impact + 10 % heat share', doc: () => world(houses(100).slice(0, 30)), events: () => [{ event: 'impact', target: [6, 6], material: 'stony', diameter: 1, speed: 15000, angle: 70, azimuth: 45, entry: 'direct', thermalShare: 0.1 } as EventSpec], seconds: 25 },
  {
    name: 'multiple sources (6, all kinds) + houses100', doc: () => world(houses(100)),
    events: () => [heat({ position: [-40, -40] }), heat({ kind: 'area', position: [40, -40], radius: 6, power: 5e5 }), heat({ kind: 'surface', position: [-40, 40], radius: 5, power: 5e5 }), heat({ kind: 'volume', position: [40, 40], radius: 6, power: 5e5, height: 4 }), heat({ kind: 'temperature', position: [0, 40], radius: 2, temperature: 1073.15 }), heat({ profile: 'pulse', pulseWidth: 2, period: 5, position: [0, -40] })],
    seconds: 60,
  },
  { name: 'houses100 + earthquake 0.9 g (no heat, Phase 25 scene)', doc: () => world(houses(100)), events: () => [quake(0.9)], seconds: 12 },
  { name: 'houses500 + earthquake 0.9 g (no heat, Phase 25 scene)', doc: () => world(houses(500)), events: () => [quake(0.9)], seconds: 12 },
  { name: 'houses1000 + earthquake 0.9 g (no heat, Phase 25 scene)', doc: () => world(houses(1000)), events: () => [quake(0.9)], seconds: 12 },
];

async function run(sc: Scene) {
  const doc = sc.doc();
  const c = new SimulationController({ headless: true });
  if (sc.water) {
    const { WaterField } = await import('@/simulation/water/WaterField');
    const { captureWaterState } = await import('@/simulation/water/waterStateCodec');
    const { samplerFor } = await import('@/terrain/TerrainSampler');
    const f = new WaterField(samplerFor(doc.terrain), doc.settings.simulation.water);
    f.h.fill(sc.water);
    c.setInitialWaterState(captureWaterState(f, 0));
  }
  await c.load(structuredClone(doc));
  for (const e of sc.events()) c.addEvent(e);
  if (sc.skip) c.advance(sc.skip);
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const steps = Math.round(sc.seconds * 60);
  let worst = 0, worstAt = 0, maxSub = 0;
  const secs = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  let worstSections: Record<string, number> = {};
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) {
    const before = secs();
    const a = performance.now();
    c.advance(1 / 60);
    const ms = performance.now() - a;
    if (ms > worst) {
      worst = ms; worstAt = c.getTime();
      const after = secs();
      worstSections = Object.fromEntries(Object.entries(after).map(([n, v]) => [n, +(v - (before[n] ?? 0)).toFixed(1)]).filter(([, v]) => (v as number) >= 1).sort((x, y) => (y[1] as number) - (x[1] as number)));
    }
    const rt = c.getEnvironment().thermal.rt;
    if (rt) maxSub = Math.max(maxSub, rt.world.last.substeps);
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const rt = c.getEnvironment().thermal.rt;
  const w = rt?.world;
  let failed = 0;
  for (const e of c.getRuntime()!.structures?.all ?? []) failed += e.modular!.structure!.model.records.filter((r) => r.hazard === 'thermal').length;
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const out = {
    scene: sc.name, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds, from: sc.skip ?? 0,
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: +worst.toFixed(1), worstAt: +worstAt.toFixed(2), worstSections,
    thermalMsPerSimS: per('sys.thermal'), solveMsPerSimS: per('thermal.solve'), coupleMsPerSimS: per('thermal.couple'),
    collapseMsPerSimS: per('sys.structuralCollapse'), physicsMsPerSimS: per('physics'), waterMsPerSimS: per('sys.waterSolver'),
    maxT_C: w ? +(rt!.stats.maxT - 273.15).toFixed(1) : null, maxWhere: rt?.stats.maxWhere ?? null, heatedAreaM2: rt ? Math.round(rt.stats.heatedArea) : 0,
    activeTiles: w?.terrain.tiles.length ?? 0, activeCells: (w?.terrain.tiles.length ?? 0) * 100, bodies: rt?.stats.bodies ?? 0, buildings: rt?.buildings.length ?? 0, maxSubsteps: maxSub,
    addedJ: w ? +w.ledger.added.toExponential(3) : 0, boundaryJ: w ? +w.ledger.boundarySupply.toExponential(3) : 0, lostJ: w ? +w.ledger.totalLost().toExponential(3) : 0,
    relResidual: w ? +w.ledger.relativeResidual().toExponential(2) : 0, thermalFailures: failed, duplicates: c.duplicateForces(),
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('thermal physics benchmark', () => {
  it('scenes', { timeout: 7_200_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      const row = await run(sc);
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    // Stress: the same heat run → reset → re-run 6 times; heap, Rapier worlds.
    if (!only || only.includes('repeat')) {
      const sc = SCENES[8];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 20 }); heaps.push(r.heapMB); }
      const row = { scene: 'repeated runs (warehouse heating ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
