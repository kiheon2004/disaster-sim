/**
 * Phase 27: cost of fire in the simulation core (no rendering). Each scene is stepped one fixed step
 * at a time (worst step measured) with the profiler sections:
 *   fire.combustion (ignition, openings, incident fluxes, burning, combustion source steps),
 *   fire.after (room gas, smoke / O₂ transport, flashover, glass, char sections, trees, statistics),
 *   thermal.solve (the Phase 26 step incl. the combustion heat), sys.structuralCollapse, physics.
 * Long fires are fast-forwarded (unmeasured) to the window of interest (`skip`).
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/fire.bench --silent=false   (BENCH_OUT=file.json, SCENES=a,b)
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
import type { FireSettings } from '@/fire/types';
import { firePreset, type FirePresetId } from '@/fire/presets';
import { rapierWorlds } from '@/physics/RapierEngine';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const tf = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const D = (id: string) => createDesign(presetSpec(id)!, id);
type Add = { type: string; building?: ReturnType<typeof D>; params?: Record<string, unknown>; seed: number; transform: ReturnType<typeof tf> };
const fireSet = (p: Partial<FireSettings> = {}): FireSettings => ({ foliageMoisture: 1.5, openings: 'windowsOpen', heatIgnition: false, ...p });

function world(add: Add[], fire: FireSettings): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench27'));
  if (add.length) S().applyEdit({ add: add as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.fire = fire;
  return d;
}
function houses(n: number, center = true): Add[] {
  const d = D('house'), out: Add[] = [];
  if (center) out.push({ type: 'building', building: d, seed: 1, transform: tf(0, 0) });
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) {
    if (Math.hypot(x, z) < 12) continue;
    out.push({ type: 'building', building: d, seed: out.length + 1, transform: tf(x, z) });
  }
  return out;
}
const conifer = (x: number, z: number, seed: number): Add => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });
function forest(n: number, spacing: number): Add[] {
  const out: Add[] = [];
  const side = Math.ceil(Math.sqrt(n));
  for (let k = 0; k < n; k++) out.push(conifer(-((side - 1) * spacing) / 2 + (k % side) * spacing, -((side - 1) * spacing) / 2 + Math.floor(k / side) * spacing, 100 + k));
  return out;
}
const fire = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 3600, ...p } as EventSpec);
const wind = (u: number): EventSpec => ({ event: 'wind', speed: u, direction: 'W', duration: 3600, gustStrength: 0 } as EventSpec);
function preset(id: FirePresetId): { doc: () => WorldDocument; events: () => EventSpec[] } {
  const p = firePreset(id);
  return { doc: () => world(p.objects as Add[], p.settings), events: () => p.events };
}

interface Scene { name: string; doc: () => WorldDocument; events: () => EventSpec[]; seconds: number; skip?: number }

const SCENES: Scene[] = [
  { name: 'single fuel object (dry conifer)', doc: () => world([conifer(0, 0, 1)], fireSet({ foliageMoisture: 0.2 })), events: () => [fire({ height: 8, radius: 2 })], seconds: 60 },
  { name: 'single compartment (house, closed, growth)', doc: () => world(houses(1), fireSet({ openings: 'asBuilt' })), events: () => [fire()], seconds: 60, skip: 300 },
  { name: 'multi-compartment building (apartment RC, windows open, flashover window)', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }], fireSet()), events: () => [fire({ position: [-4, -2] })], seconds: 60, skip: 700 },
  { name: 'houses100 + house fire (flashover window) + wind 5', doc: () => world(houses(100), fireSet()), events: () => [wind(5), fire()], seconds: 60, skip: 760 },
  { name: 'houses500 + house fire (flashover window) + wind 5', doc: () => world(houses(500), fireSet()), events: () => [wind(5), fire()], seconds: 60, skip: 760 },
  { name: 'houses1000 + house fire (flashover window) + wind 5', doc: () => world(houses(1000), fireSet()), events: () => [wind(5), fire()], seconds: 60, skip: 760 },
  { name: 'small forest (12 dry conifers, 5 m)', ...preset('vegetation'), seconds: 60 },
  { name: 'large forest (400 dry conifers, 5 m)', doc: () => world(forest(400, 5), fireSet({ foliageMoisture: 0.2 })), events: () => [fire({ position: [-47.5, -47.5], height: 8, radius: 2 })], seconds: 120 },
  { name: 'wind and fire (18 conifers, 7 m, 10 m/s)', ...preset('windFire'), seconds: 90 },
  { name: 'water and fire (rain on a burning stand)', ...preset('waterCooling'), seconds: 90 },
  { name: 'fire and collapse (house, 1850–2150 s)', doc: () => world(houses(1), fireSet()), events: () => [fire()], seconds: 300, skip: 1850 },
  { name: 'fire and debris (house + trees, 2900–3200 s)', ...preset('burningDebris'), seconds: 300, skip: 2900 },
  { name: 'multiple building fires (5 houses lit)', doc: () => world(houses(100), fireSet()), events: () => [0, 1, 2, 3, 4].map((k) => fire({ position: [-94 + k * 16, -94] })), seconds: 60, skip: 760 },
  { name: 'long burning (house, 0–3600 s, coarse)', doc: () => world(houses(1), fireSet()), events: () => [fire()], seconds: 3600 },
  { name: 'post-fire settling (house, 4200–4500 s)', doc: () => world(houses(1), fireSet()), events: () => [fire({ duration: 5000 })], seconds: 300, skip: 4200 },
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
  let worst = 0, worstAt = 0, maxItems = 0, maxBurning = 0, maxRooms = 0;
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
    const fr = c.getEnvironment().fire.rt;
    if (fr) { maxItems = Math.max(maxItems, fr.fw.n); maxBurning = Math.max(maxBurning, fr.stats.burningItems); maxRooms = Math.max(maxRooms, fr.stats.roomsBurning); }
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const fr = c.getEnvironment().fire.rt;
  const rt = c.getEnvironment().thermal.rt;
  const L = fr?.fw.ledger;
  let failed = 0;
  for (const e of c.getRuntime()!.structures?.all ?? []) failed += e.modular!.structure!.model.records.filter((r) => r.hazard === 'fire' && r.cause !== 'facade').length;
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const out = {
    scene: sc.name, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds, from: sc.skip ?? 0, stepping: coarse ? '1 s (cost only)' : 'fixed 1/60 s',
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: coarse ? null : +worst.toFixed(1), worstAt: coarse ? null : +worstAt.toFixed(2), worstSections,
    fireMsPerSimS: +(per('fire.combustion') + per('fire.after')).toFixed(2), combustionMsPerSimS: per('fire.combustion'), afterMsPerSimS: per('fire.after'),
    thermalMsPerSimS: per('sys.thermal'), solveMsPerSimS: per('thermal.solve'), collapseMsPerSimS: per('sys.structuralCollapse'), physicsMsPerSimS: per('physics'),
    fuelItems: maxItems, maxBurningItems: maxBurning, maxBurningRooms: maxRooms, bodies: rt?.stats.bodies ?? 0, buildingsRefined: rt?.buildings.length ?? 0,
    peakHrrMW: fr ? +(fr.fw.peakHrr / 1e6).toFixed(2) : 0, releasedGJ: L ? +(L.released / 1e9).toFixed(3) : 0, smokeKg: L ? +L.smokeProduced.toFixed(1) : 0,
    chemResidualRel: L && L.chemRegistered > 0 ? +(Math.abs(L.chemResidual()) / L.chemRegistered).toExponential(2) : 0,
    thermalRelResidual: rt ? +rt.world.ledger.relativeResidual().toExponential(2) : 0, fireFailures: failed, duplicates: c.duplicateForces(),
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('fire benchmark', () => {
  it('scenes', { timeout: 14_400_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      const row = await run(sc);
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (!only || only.includes('repeat')) {
      const sc = SCENES[6];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 20 }); heaps.push(r.heapMB); }
      const row = { scene: 'repeated runs (small forest ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
