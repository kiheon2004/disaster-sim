/**
 * Phase 28: cost of the volcano in the simulation core (no rendering). Each scene is stepped one fixed step
 * at a time (worst step measured; long eruptions in 1 s steps, cost only) with the profiler sections
 *   volcano.prepare (eruption, lava flow, bombs, ash, cooling, heat source steps), volcano.after (objects,
 *   roads, milestones), thermal.solve, fire.combustion / fire.after, sys.structuralCollapse, sys.deformation,
 *   physics,
 * and the volcano's own split (flow / cool / ash / bombs / heat / objects). Windows of interest are reached by
 * fast-forwarding (unmeasured, `skip`).
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/volcano.bench --silent=false   (BENCH_OUT=file.json, SCENES=a,b)
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
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { VolcanoSpec } from '@/volcano/types';
import { volcanoPreset, type VolcanoPresetId } from '@/volcano/presets';
import { rapierWorlds } from '@/physics/RapierEngine';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const D = (id: string) => createDesign(presetSpec(id)!, id);
type Add = { type: string; building?: ReturnType<typeof D>; params?: Record<string, unknown>; seed: number; transform: { position: Vec3; rotation: Vec3; scale: Vec3 } };
type H = (x: number, z: number) => number;
const DEG = Math.PI / 180;
const flat: H = () => 0;
const slope = (deg: number, x1 = 40): H => (x) => Math.round((x < x1 ? (x1 - Math.max(-100, x)) * Math.tan(deg * DEG) : 0) * 100) / 100;
/** Corner slope: highest at (−100, −100), descending toward +x and +z. */
const corner = (deg: number): H => (x, z) => Math.round(Math.max(0, (100 - (x + z) / 2) * Math.tan(deg * DEG) - 40 * Math.tan(deg * DEG)) * 100) / 100;

function world(h: H, add: Add[], roads?: [number, number][][]): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench28'));
  const t0 = S().doc.terrain;
  const heights = new Float32Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = h(t0.originX + ix * t0.cellSize, t0.originZ + iz * t0.cellSize);
  S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  if (roads) for (const r of roads) S().applyEdit({ roads: drawRoad(S().doc.roads ?? emptyNetwork(), r, { curved: false, profile: defaultProfile() }).network });
  if (add.length) S().applyEdit({ add: add.map((a) => ({ ...a, transform: { ...a.transform, position: [a.transform.position[0], h(a.transform.position[0], a.transform.position[2]), a.transform.position[2]] as Vec3 } })) as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 42;
  return d;
}
const tf = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
function houses(n: number): Add[] {
  const d = D('house'), out: Add[] = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) {
    if (x + z < -120) continue; // keep the vent corner free
    out.push({ type: 'building', building: d, seed: out.length + 1, transform: tf(x, z) });
  }
  return out;
}
const erupt = (p: Partial<VolcanoSpec> = {}): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-70, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 3, duration: 3600, profile: 'constant', ...p } as EventSpec);
function preset(id: VolcanoPresetId): { doc: () => WorldDocument; events: () => EventSpec[] } {
  const p = volcanoPreset(id);
  return {
    doc: () => { const d = world(p.height, p.objects as Add[]); if (p.lake) { S().replaceDocument(d); S().setFeatures([p.lake], 2); return structuredClone(S().doc); } return d; },
    events: () => p.events,
  };
}

interface Scene { name: string; doc: () => WorldDocument; events: () => EventSpec[]; seconds: number; skip?: number }

const SCENES: Scene[] = [
  { name: '1 single vent, empty terrain (6°)', doc: () => world(slope(6), []), events: () => [erupt()], seconds: 60, skip: 120 },
  { name: '2 flat ground flow', doc: () => world(flat, []), events: () => [erupt({ vents: [{ kind: 'central', position: [0, 0], radius: 2 }] })], seconds: 60, skip: 120 },
  { name: '3 slope flow (12°)', doc: () => world(slope(12), []), events: () => [erupt()], seconds: 60, skip: 120 },
  { name: '4 high-viscosity lava (andesite 1050 °C)', doc: () => world(slope(6), []), events: () => [erupt({ material: 'andesite', temperature: 1050 })], seconds: 60, skip: 120 },
  { name: '5 cooling and solidification (after the eruption)', doc: () => world(slope(4), []), events: () => [erupt({ temperature: 1100, rate: 1, duration: 300 })], seconds: 60, skip: 420 },
  { name: '6 diversion by solidified lava (second eruption over the first flow)', doc: () => world(slope(5), []), events: () => [erupt({ temperature: 1100, duration: 300 }), erupt({ duration: 1800, startTime: 600, vents: [{ kind: 'central', position: [-70, 6], radius: 2 }] })], seconds: 60, skip: 780 },
  { name: '7 lava + water (lake)', ...preset('lavaWater'), seconds: 60, skip: 200 },
  { name: '8 lava + forest', ...preset('vegetationFire'), seconds: 60, skip: 120 },
  { name: '9 lava + buildings', ...preset('buildings'), seconds: 60, skip: 200 },
  { name: '10 lava + road', doc: () => world(slope(6), [], [[[-45, -60], [-45, 60]]]), events: () => [erupt()], seconds: 60, skip: 150 },
  { name: '11 ash deposition (no wind)', doc: () => world(slope(4), houses(6).map((h, k) => ({ ...h, transform: tf(-40 + (k % 3) * 20, -20 + Math.floor(k / 3) * 40) }))), events: () => [erupt({ ashFraction: 0.25, bombFraction: 0.05, plumeHeight: 80 })], seconds: 60, skip: 120 },
  { name: '12 ash + wind (preset)', ...preset('ashFall'), seconds: 60, skip: 120 },
  { name: '13 multiple vents (3)', doc: () => world(slope(6), []), events: () => [erupt({ vents: [{ kind: 'central', position: [-70, -30], radius: 2 }, { kind: 'central', position: [-70, 0], radius: 2 }, { kind: 'central', position: [-70, 30], radius: 2 }], rate: 6 })], seconds: 60, skip: 120 },
  { name: '14 volcano + fire (burning stand)', ...preset('vegetationFire'), seconds: 60, skip: 300 },
  { name: '15 volcano + structural collapse (earthquake on heated houses)', doc: () => volcanoPreset('buildings') && world(volcanoPreset('buildings').height, volcanoPreset('buildings').objects as Add[]), events: () => [...volcanoPreset('buildings').events, { event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 3, startTime: 240 } as EventSpec], seconds: 60, skip: 230 },
  { name: '16 city of 100 houses, vent in a corner', doc: () => world(corner(5), houses(100)), events: () => [erupt({ vents: [{ kind: 'central', position: [-90, -90], radius: 2 }] })], seconds: 60, skip: 180 },
  { name: '17 city of 500 houses, vent in a corner', doc: () => world(corner(5), houses(500)), events: () => [erupt({ vents: [{ kind: 'central', position: [-90, -90], radius: 2 }] })], seconds: 60, skip: 180 },
  { name: '18 city of 1000 houses, vent in a corner', doc: () => world(corner(5), houses(1000)), events: () => [erupt({ vents: [{ kind: 'central', position: [-90, -90], radius: 2 }] })], seconds: 60, skip: 180 },
  { name: '19 long eruption (1 h, coarse)', doc: () => world(slope(6), []), events: () => [erupt({ rate: 2 })], seconds: 3600 },
];

async function run(sc: Scene) {
  const doc = sc.doc();
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of sc.events()) c.addEvent(e);
  if (sc.skip) c.advance(sc.skip);
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const coarse = sc.seconds > 600;
  const step = coarse ? 1 : 1 / 60;
  const steps = Math.round(sc.seconds / step);
  let worst = 0, worstAt = 0, maxActive = 0, maxHot = 0, maxSub = 0;
  const own = { flow: 0, cool: 0, ash: 0, bombs: 0, heat: 0, objects: 0 };
  const secs = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  let worstSections: Record<string, number> = {};
  const tot0 = { ...(c.getEnvironment().volcano.rt?.stats.msTotal ?? own) };
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) {
    const before = secs();
    const a = performance.now();
    const stepBefore = c.getEnvironment().volcano.rt?.world.time ?? -1;
    c.advance(step);
    const ms = performance.now() - a;
    if (ms > worst && !coarse) {
      worst = ms; worstAt = c.getTime();
      const after = secs();
      worstSections = Object.fromEntries(Object.entries(after).map(([n, v]) => [n, +(v - (before[n] ?? 0)).toFixed(1)]).filter(([, v]) => (v as number) >= 1).sort((x, y) => (y[1] as number) - (x[1] as number)));
    }
    const vr = c.getEnvironment().volcano.rt;
    if (vr && vr.world.time !== stepBefore) {
      maxActive = Math.max(maxActive, vr.stats.activeLava); maxHot = Math.max(maxHot, vr.stats.hotDeposits); maxSub = Math.max(maxSub, vr.stats.substeps);
    }
  }
  const ms = performance.now() - t0;
  const tot1 = c.getEnvironment().volcano.rt?.stats.msTotal;
  if (tot1) for (const key of Object.keys(own) as (keyof typeof own)[]) own[key] = tot1[key] - (tot0[key] ?? 0);
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const env = c.getEnvironment();
  const vr = env.volcano.rt, rt = env.thermal.rt;
  const L = vr?.world.ledger();
  let failed = 0;
  for (const e of c.getRuntime()!.structures?.all ?? []) failed += e.modular!.structure!.model.records.length;
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const out = {
    scene: sc.name, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds, from: sc.skip ?? 0, stepping: coarse ? '1 s (cost only)' : 'fixed 1/60 s',
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: coarse ? null : +worst.toFixed(1), worstAt: coarse ? null : +worstAt.toFixed(2), worstSections,
    volcanoMsPerSimS: +(per('volcano.prepare') + per('volcano.after')).toFixed(2),
    lavaFlowMsPerSimS: +(own.flow / sc.seconds).toFixed(2), coolMsPerSimS: +(own.cool / sc.seconds).toFixed(2), heatStepsMsPerSimS: +(own.heat / sc.seconds).toFixed(2),
    ashMsPerSimS: +(own.ash / sc.seconds).toFixed(2), bombsMsPerSimS: +(own.bombs / sc.seconds).toFixed(2), objectsMsPerSimS: +(own.objects / sc.seconds).toFixed(2),
    thermalSolveMsPerSimS: per('thermal.solve'), fireMsPerSimS: +(per('fire.combustion') + per('fire.after')).toFixed(2), collapseMsPerSimS: per('sys.structuralCollapse'),
    deformationMsPerSimS: per('sys.deformation'), physicsMsPerSimS: per('physics'),
    maxActiveLava: maxActive, maxHotDeposits: maxHot, maxSubsteps: maxSub, bodies: rt?.stats.bodies ?? 0, buildingsRefined: rt?.buildings.length ?? 0,
    suppliedT: L ? +(L.mass.supplied / 1000).toFixed(1) : 0, solidifiedT: L ? +(L.mass.solidified / 1000).toFixed(1) : 0, ashT: L ? +((L.mass.ashDeposited + L.mass.ashCaught) / 1000).toFixed(2) : 0,
    massResidualRel: L && L.mass.supplied > 0 ? +(Math.abs(L.mass.residual) / L.mass.supplied).toExponential(2) : 0,
    energyResidualRel: L && L.energy.supplied > 0 ? +(Math.abs(L.energy.residual) / L.energy.supplied).toExponential(2) : 0,
    thermalRelResidual: rt ? +rt.world.ledger.relativeResidual().toExponential(2) : 0, structureRecords: failed, duplicates: c.duplicateForces(),
    deformUpdates: env.deformation.stats?.updates ?? 0, colliderMsTotal: +(env.deformation.stats?.colliderTotalMs ?? 0).toFixed(0),
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('volcano benchmark', () => {
  it('scenes', { timeout: 14_400_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      const row = await run(sc);
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (!only || only.includes('20')) {
      const sc = SCENES[0];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 20, skip: 40 }); heaps.push(r.heapMB); }
      const row = { scene: '20 repeated runs (single vent ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
