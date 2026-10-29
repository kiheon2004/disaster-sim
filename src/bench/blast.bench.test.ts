/**
 * Phase 24: cost of atmospheric pressure waves in the simulation core (no rendering). Each scene runs
 * on the same world — A: without the wave (the Phase 23 code path; the blast system is inactive),
 * B: with it — stepped one fixed step at a time so the worst step is measured too.
 *
 *   scenes: empty ground, vehicles + people, infrastructure, buildings 100 / 500 / 1000, road city,
 *           mountain, multiple waves, impact + air blast (A = the Phase 23 impact), blast + flood,
 *           blast + earthquake, repeated waves (6)
 *   split:  blast system = activation (shielding, face loads, parts — "pressure field evaluation")
 *           + responses (face impulses, drag, ForceLedger, part SDOF — "force integration");
 *           structural = the structural model the lateral loads drive; physics = Rapier
 *
 *   BENCH=1 npx vitest run src/bench/blast --silent=false      (BENCH_OUT=file.json, SCENES=a,b)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { presetDesign } from '@/roads/city';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { phenomena } from '@/phenomena/registry';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { BlastSpec } from '@/blast/types';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const SIM_S = Number(process.env.BENCH_SECONDS ?? 8);
const tf = (x: number, z: number, yaw = 0) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, yaw, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const blast = (x: Partial<BlastSpec> = {}): EventSpec => ({ event: 'blast', position: [0, 0], height: 1, energy: 1e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5, ...x } as EventSpec);

interface Opts { buildings?: number; roads?: boolean; slope?: number; cars?: number; people?: number; infra?: number }

function world(o: Opts = {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench'));
  if (o.slope) {
    const t0 = S().doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((o.slope * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x > 30 ? Math.min(60, (x - 30) * tb) : 0; }
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  }
  if (o.roads) {
    let net = drawRoad(S().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: defaultProfile() }).network;
    net = drawRoad(net, [[0, -96], [0, 96]], { curved: false, profile: defaultProfile() }).network;
    S().applyEdit({ roads: net });
  }
  const d = presetDesign('house', 1)!, add = [];
  const n = o.buildings ?? 0;
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && add.length < n; z += step) for (let x = -94; x <= 94 && add.length < n; x += step) {
    if (Math.hypot(x, z) < 12) continue;
    if (o.roads && (Math.abs(x) < 6 || Math.abs(z) < 6)) continue;
    add.push({ type: 'building' as const, building: d, seed: add.length + 1, transform: tf(x, z) });
  }
  for (let k = 0; k < (o.cars ?? 0); k++) add.push({ type: 'car' as const, seed: 1000 + k, transform: tf(-80 + (k % 10) * 16, -30 + Math.floor(k / 10) * 60) });
  for (let k = 0; k < (o.people ?? 0); k++) add.push({ type: 'human' as const, seed: 2000 + k, transform: tf(-85 + (k % 12) * 15, 20 + Math.floor(k / 12) * 10) });
  const types = ['streetLight', 'sign', 'wall'] as const;
  for (let k = 0; k < (o.infra ?? 0); k++) add.push({ type: types[k % 3], seed: 3000 + k, transform: tf(-90 + (k % 15) * 12, -60 + Math.floor(k / 15) * 30, k % 2 ? Math.PI / 2 : 0) });
  if (add.length) S().applyEdit({ add });
  return structuredClone(S().doc);
}

interface Scene { name: string; doc: () => WorldDocument; base: () => EventSpec[]; blasts: () => EventSpec[]; seconds?: number }

const rain = (): EventSpec => ({ ...(phenomena.implemented('rain')!.defaults() as object), intensity: 100, duration: 30 } as EventSpec);
const quake = (): EventSpec => ({ event: 'earthquake', magnitude: 6.5, pga: 0.25, duration: 10 } as EventSpec);
const impact = (air: boolean): EventSpec => ({ event: 'impact', target: [6, 6], material: 'stony', diameter: 1, speed: 8000, angle: 70, azimuth: 45, entry: 'direct', ...(air ? { airBlast: true } : {}) } as EventSpec);

const SCENES: Scene[] = [
  { name: 'empty', doc: () => world(), base: () => [], blasts: () => [blast()] },
  { name: 'vehicles+people', doc: () => world({ cars: 30, people: 36 }), base: () => [], blasts: () => [blast()] },
  { name: 'infrastructure', doc: () => world({ infra: 75 }), base: () => [], blasts: () => [blast()] },
  { name: 'buildings100', doc: () => world({ buildings: 100 }), base: () => [], blasts: () => [blast()] },
  { name: 'buildings500', doc: () => world({ buildings: 500 }), base: () => [], blasts: () => [blast()] },
  { name: 'buildings1000', doc: () => world({ buildings: 1000 }), base: () => [], blasts: () => [blast()] },
  { name: 'road-city', doc: () => world({ buildings: 300, roads: true, cars: 20, infra: 30 }), base: () => [], blasts: () => [blast({ position: [20, 20] })] },
  { name: 'mountain', doc: () => world({ buildings: 100, slope: 30 }), base: () => [], blasts: () => [blast({ position: [-20, 0] })] },
  { name: 'multiple-3', doc: () => world({ buildings: 100, cars: 20 }), base: () => [], blasts: () => [blast(), blast({ position: [-60, 50], energy: 3e8, startTime: 0.8 }), blast({ position: [70, -40], energy: 3e8, height: 20, startTime: 1.1 })] },
  { name: 'impact+airBlast', doc: () => world({ buildings: 100, cars: 10 }), base: () => [impact(false)], blasts: () => [] },
  { name: 'blast+flood', doc: () => world({ buildings: 100 }), base: () => [rain()], blasts: () => [blast({ startTime: 3 })] },
  { name: 'blast+earthquake', doc: () => world({ buildings: 100 }), base: () => [quake()], blasts: () => [blast({ startTime: 3 })] },
  { name: 'repeated-6', doc: () => world({ buildings: 100, cars: 10 }), base: () => [], blasts: () => [-60, -30, 0, 30, 60, 0].map((x, k) => blast({ position: [x, k === 5 ? 40 : -20], energy: 3e8, startTime: 0.5 + k * 1.5 })), seconds: 14 },
];

async function run(doc: WorldDocument, events: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const steps = Math.round(seconds * 60);
  let worst = 0, worstAt = 0;
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) {
    const a = performance.now();
    c.advance(1 / 60);
    const ms = performance.now() - a;
    if (ms > worst) { worst = ms; worstAt = c.getTime(); }
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const env = c.getEnvironment();
  const st = env.blast.stats;
  const L = env.blast.ledger(c.getTime());
  const rt = c.getRuntime()!;
  const out = {
    msPerSimS: +(ms / seconds).toFixed(1),
    worstStepMs: +worst.toFixed(1),
    worstAt: +worstAt.toFixed(2),
    blastMs: +(sec['sys.blast'] ?? 0).toFixed(1),
    activationMs: +st.fieldTotalMs.toFixed(1),
    responseMs: +st.forceTotalMs.toFixed(1),
    structuralMs: +(sec['sys.structural'] ?? 0).toFixed(1),
    seismicDamageMs: +(sec['sys.seismicDamage'] ?? 0).toFixed(1),
    physicsMs: +(sec.physics ?? 0).toFixed(0),
    waterMs: +(sec['sys.waterSolver'] ?? 0).toFixed(0),
    waves: env.blast.waves.length,
    events: c.getDamageEvents().length,
    blastEvents: c.getDamageEvents().filter((e) => e.hazard === 'blast').length,
    collapsed: [...rt.entities.values()].filter((e) => e.flags.collapsed).length,
    debris: rt.debris.length,
    duplicates: c.duplicateForces(),
    ledgerResidual: L.length ? Math.max(...L.map((l) => Math.abs(l.residual))) : 0,
    heapMB: heapMB(),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('blast benchmark', () => {
  it('A/B per scene', { timeout: 7_200_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.includes(sc.name)) continue;
      const doc = sc.doc();
      const secs = sc.seconds ?? SIM_S;
      const air = sc.name === 'impact+airBlast';
      const a = await run(doc, sc.base(), secs);
      const b = await run(doc, air ? [impact(true)] : [...sc.base(), ...sc.blasts()], secs);
      const row = {
        scene: sc.name, objects: Object.keys(doc.objects).length, simSeconds: secs,
        msPerSimS_A: a.msPerSimS, msPerSimS_B: b.msPerSimS, worstStep_A: a.worstStepMs, worstStep_B: b.worstStepMs, worstAt_B: b.worstAt,
        blastMsPerSimS: +(b.blastMs / secs).toFixed(2), activationMs: b.activationMs, responseMs: b.responseMs, structuralMsPerSimS_A: +(a.structuralMs / secs).toFixed(2), structuralMsPerSimS_B: +(b.structuralMs / secs).toFixed(2),
        physicsMs_A: a.physicsMs, physicsMs_B: b.physicsMs, waterMs_B: b.waterMs,
        waves: b.waves, events_B: b.events, blastEvents: b.blastEvents, collapsed: b.collapsed, debris: b.debris, duplicates: b.duplicates,
        ledgerResidualJ: b.ledgerResidual, heapMB_A: a.heapMB, heapMB_B: b.heapMB,
      };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
