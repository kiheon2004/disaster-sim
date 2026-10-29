/**
 * Phase 25: cost of structural destruction in the simulation core (no rendering). Each scene runs
 * stepped one fixed step at a time (worst step measured) with the profiler sections of the engine:
 *   struct.model (redistribution rounds, falling blocks, impacts), struct.events (records, fragments,
 *   rubble, Phase 17 sync), struct.fragments (settling, LOD, rubble effects); physics = Rapier.
 *
 *   BENCH=1 npx vitest run src/bench/structure --silent=false      (BENCH_OUT=file.json, SCENES=a,b)
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
import { rapierWorlds } from '@/physics/RapierEngine';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const tf = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const D = (id: string) => createDesign(presetSpec(id)!, id);

type Add = { type: string; building?: ReturnType<typeof D>; seed: number; transform: ReturnType<typeof tf> };
function world(add: Add[], slope = 0): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench25'));
  if (slope) {
    const t0 = S().doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((slope * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  }
  if (add.length) S().applyEdit({ add: add as never });
  return structuredClone(S().doc);
}

/** Houses on a grid like the Phase 24 benchmark (same spacing). */
function houses(n: number): Add[] {
  const d = D('house'), out: Add[] = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) {
    if (Math.hypot(x, z) < 12) continue;
    out.push({ type: 'building', building: d, seed: out.length + 1, transform: tf(x, z) });
  }
  return out;
}
const cars = (n: number, z = 10): Add[] => Array.from({ length: n }, (_, k) => ({ type: 'car', seed: 100 + k, transform: tf(-12 + k * 6, z) }));
const quake = (pga: number): EventSpec => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed: 3 } as EventSpec);
const blast = (x: Partial<{ position: [number, number]; energy: number }> = {}): EventSpec => ({ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5, ...x } as EventSpec);

interface Scene { name: string; doc: () => WorldDocument; events: () => EventSpec[]; seconds: number; water?: number }

const SCENES: Scene[] = [
  { name: 'house-partial (blast 2 GJ @10 m)', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(10, 0) }]), events: () => [blast()], seconds: 8 },
  { name: 'midrise column failures (apartment, 0.7 g)', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }]), events: () => [quake(0.7)], seconds: 20 },
  { name: 'high-rise floors (office 10 st., 1.0 g)', doc: () => world([{ type: 'building', building: D('office'), seed: 1, transform: tf(0, 0) }]), events: () => [quake(1.0)], seconds: 20 },
  { name: 'tower (30 st., 1.0 g)', doc: () => world([{ type: 'building', building: D('tower'), seed: 1, transform: tf(0, 0) }]), events: () => [quake(1.0)], seconds: 20 },
  { name: 'cladding detachment (office, wind 48 m/s)', doc: () => world([{ type: 'building', building: D('office'), seed: 1, transform: tf(0, 0) }]), events: () => [{ event: 'wind', speed: 48, direction: 'E', duration: 40 } as EventSpec], seconds: 30 },
  { name: 'earthquake chain collapse (street, 1.1 g)', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }, { type: 'building', building: D('house'), seed: 2, transform: tf(18, 0) }, ...cars(5)]), events: () => [quake(1.1)], seconds: 24 },
  { name: 'blast exterior walls (12 houses)', doc: () => world(houses(12).map((h, k) => ({ ...h, transform: tf(-30 + (k % 6) * 12, k < 6 ? 12 : -12) }))), events: () => [blast()], seconds: 8 },
  { name: 'sinkhole foundation (industrial)', doc: () => world([{ type: 'building', building: D('industrial'), seed: 1, transform: tf(0, 0) }]), events: () => [{ event: 'terrainDeformation', kind: 'subsidence', center: [-15, -10], radius: 4, amount: 0.08, supportLoss: 0.9, duration: 1, profile: 'smooth', falloff: 'steep' } as EventSpec], seconds: 6 },
  { name: 'landslide structural damage (house at toe)', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(7, 0) }], 32), events: () => [{ event: 'landslide', area: { kind: 'circle', center: [-14, 0], radius: 12 }, thickness: 2.5, saturation: 1, trigger: 'user', targetSaturation: 1, duration: 10 } as EventSpec], seconds: 30 },
  { name: 'impact ejecta secondary damage', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(30, 0) }, { type: 'building', building: D('apartment'), seed: 2, transform: tf(-40, 10) }, ...cars(6, 30)]), events: () => [{ event: 'impact', target: [6, 6], material: 'stony', diameter: 2, speed: 15000, angle: 70, azimuth: 45, entry: 'direct' } as EventSpec], seconds: 25 },
  { name: 'flood collapse (6 buildings, 2.5 m water)', doc: () => world([0, 1, 2, 3, 4, 5].map((k) => ({ type: 'building', building: D(k % 2 ? 'apartment' : 'house'), seed: k + 1, transform: tf(-30 + k * 12, 0) }))), events: () => [{ event: 'risingWater', boundary: 'S', level: 3.5, riseRate: 0.5 } as EventSpec], seconds: 40, water: 2.5 },
  { name: 'multiple collapses (9 apartments, 1.1 g)', doc: () => world([0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ type: 'building', building: D('apartment'), seed: k + 1, transform: tf(-36 + (k % 3) * 36, -30 + Math.floor(k / 3) * 30) }))), events: () => [quake(1.1)], seconds: 24 },
  { name: 'houses100 + earthquake 0.9 g', doc: () => world(houses(100)), events: () => [quake(0.9)], seconds: 12 },
  { name: 'houses500 + earthquake 0.9 g', doc: () => world(houses(500)), events: () => [quake(0.9)], seconds: 12 },
  { name: 'houses1000 + earthquake 0.9 g', doc: () => world(houses(1000)), events: () => [quake(0.9)], seconds: 12 },
  { name: 'houses1000 + earthquake 1.3 g (collapses)', doc: () => world(houses(1000)), events: () => [quake(1.3)], seconds: 12 },
  { name: 'houses1000 + blast 1 GJ (Phase 24 scene)', doc: () => world(houses(1000)), events: () => [blast({ energy: 1e9 })], seconds: 8 },
];

async function run(sc: Scene) {
  const doc = sc.doc();
  if (sc.water) doc.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false };
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
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const steps = Math.round(sc.seconds * 60);
  let worst = 0, worstAt = 0, maxMoving = 0, maxBlocks = 0;
  const t0 = performance.now();
  const secs = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  let worstSections: Record<string, number> = {};
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
    const St = c.getRuntime()!.structures;
    if (St) {
      let m = 0;
      for (const f of St.fragments) if (!f.structural!.settled) m++;
      maxMoving = Math.max(maxMoving, m);
      let b = 0;
      for (const e of St.active) for (const bl of e.modular!.structure!.model.blocks) if (bl.active) b++;
      maxBlocks = Math.max(maxBlocks, b);
    }
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const rt = c.getRuntime()!;
  const St = rt.structures;
  const classes = { damaged: 0, local: 0, partial: 0, global: 0 };
  let failed = 0, residual = 0, bodies = 0, rubble = 0;
  for (const e of St?.all ?? []) {
    const m = e.modular!.structure!.model;
    const l = m.collapseLevel();
    if (l in classes) classes[l as keyof typeof classes]++;
    failed += m.records.filter((r) => r.cause !== 'facade').length;
    residual = Math.max(residual, Math.abs(m.ledger.residual()));
    bodies += m.ledger.mass.bodies;
    rubble += m.ledger.mass.rubble;
  }
  const events = c.getDamageEvents().length, duplicates = c.duplicateForces();
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const out = {
    scene: sc.name, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds,
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: +worst.toFixed(1), worstAt: +worstAt.toFixed(2), worstSections,
    structModelMsPerSimS: +((sec['struct.model'] ?? 0) / sc.seconds).toFixed(2), structEventsMsPerSimS: +((sec['struct.events'] ?? 0) / sc.seconds).toFixed(2),
    structFragmentsMsPerSimS: +((sec['struct.fragments'] ?? 0) / sc.seconds).toFixed(2), collapseSystemMsPerSimS: +((sec['sys.structuralCollapse'] ?? 0) / sc.seconds).toFixed(2),
    physicsMsPerSimS: +((sec.physics ?? 0) / sc.seconds).toFixed(1), damageSystemMsPerSimS: +((sec['sys.damage'] ?? 0) / sc.seconds).toFixed(2),
    models: St?.all.length ?? 0, ...classes, failedMembers: failed, maxFallingBlocks: maxBlocks, maxMovingFragments: maxMoving, fragments: St?.fragments.length ?? 0,
    aggregatedKg: Math.round(St?.aggregated ?? 0), bodiesT: +(bodies / 1000).toFixed(1), rubbleT: +(rubble / 1000).toFixed(1), heaps: St?.rubble.heaps.length ?? 0,
    roadsBlocked: rt.roads?.summary().rubble ?? 0, secondary: St?.secondary ?? 0, residualKg: residual, events,
    duplicates, heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('structural destruction benchmark', () => {
  it('scenes', { timeout: 7_200_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      const row = await run(sc);
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    // Stress: the same collapse run → reset → re-run 6 times; heap, Rapier worlds.
    if (!only || only.includes('repeat')) {
      const sc = SCENES[5];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run(sc); heaps.push(r.heapMB); }
      const row = { scene: 'repeated runs (street collapse ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
