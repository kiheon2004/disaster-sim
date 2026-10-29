/**
 * Phase 21: cost of terrain deformation in the simulation core (no rendering). Every scene runs
 * twice on the same world — A: without deformation (the Phase 20 code path: the deformation
 * system is inactive), B: with it — so the difference is the deformation's own cost.
 *
 *   scenes: empty map local subsidence, wide uplift, buildings 100 / 500 / 1000, city with roads,
 *           river + lake nature, flood + deformation, multi-hazard (earthquake + rain + subsidence)
 *   metrics: wall ms per simulated second (A, B), deformation updates and their cost split
 *            (field + heights, collider rebuild, water bed, responses), max collider rebuild,
 *            objects / roads touched, water solver share, heap.
 *
 *   BENCH=1 npx vitest run src/bench/deformation --silent=false      (BENCH_OUT=file.json to save)
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
import { buildTemplate } from '@/templates/builtin';
import { phenomena } from '@/phenomena/registry';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { TerrainDeformationSpec } from '@/deformation/types';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const SIM_S = Number(process.env.BENCH_SECONDS ?? 12);

const def = (extra: Partial<TerrainDeformationSpec>): TerrainDeformationSpec => ({
  event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 40, amount: 1.5, duration: 8, profile: 'smooth', falloff: 'smooth', ...extra,
});

function buildingsWorld(n: number, roads = false): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench'));
  if (roads) {
    let net = drawRoad(S().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: defaultProfile() }).network;
    net = drawRoad(net, [[0, -96], [0, 96]], { curved: false, profile: defaultProfile() }).network;
    net = drawRoad(net, [[-96, 40], [96, 40]], { curved: false, profile: defaultProfile() }).network;
    S().applyEdit({ roads: net });
  }
  const designs = [presetDesign('house', 2)!, presetDesign('house', 1)!, presetDesign('apartment', 4)!];
  const inputs = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && inputs.length < n; z += step) for (let x = -94; x <= 94 && inputs.length < n; x += step) {
    if (roads && (Math.abs(x) < 8 || Math.abs(z) < 8 || Math.abs(z - 40) < 8)) continue;
    inputs.push({ type: 'building' as const, building: n > 100 ? designs[1] : designs[inputs.length % 3], seed: inputs.length + 1, transform: { position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } });
  }
  if (inputs.length) S().applyEdit({ add: inputs });
  return structuredClone(S().doc);
}

const quake = () => ({ ...(phenomena.implemented('earthquake')!.defaults() as object), magnitude: 6.5, duration: 20 } as EventSpec);
const rain = (mmh = 60) => ({ ...(phenomena.implemented('rain')!.defaults() as object), intensity: mmh, duration: SIM_S } as EventSpec);

interface Scene { name: string; doc: () => WorldDocument; base: () => EventSpec[]; deform: TerrainDeformationSpec[] }

const SCENES: Scene[] = [
  { name: 'empty-local-subsidence', doc: () => buildingsWorld(0), base: () => [], deform: [def({ radius: 20, amount: 2 })] },
  { name: 'empty-wide-uplift', doc: () => buildingsWorld(0), base: () => [], deform: [def({ kind: 'uplift', radius: 120, amount: 1, duration: 10 })] },
  { name: 'buildings100', doc: () => buildingsWorld(100), base: () => [], deform: [def({ radius: 60 })] },
  { name: 'buildings500', doc: () => buildingsWorld(500), base: () => [], deform: [def({ radius: 60 })] },
  { name: 'buildings1000', doc: () => buildingsWorld(1000), base: () => [], deform: [def({ radius: 60 })] },
  { name: 'city-roads', doc: () => buildingsWorld(300, true), base: () => [], deform: [def({ radius: 50, center: [10, 20] }), def({ kind: 'depression', radius: 8, amount: 1.2, center: [-40, 0], profile: 'instant' })] },
  { name: 'river-lake-nature', doc: () => { S().setLocked(false); S().replaceDocument(buildTemplate('riverValley', 3)); return structuredClone(S().doc); }, base: () => [], deform: [def({ radius: 40, amount: 1 }), def({ kind: 'uplift', radius: 30, amount: 0.8, center: [50, -40] })] },
  { name: 'flood-deformation', doc: () => buildingsWorld(100), base: () => [rain(80)], deform: [def({ radius: 50 })] },
  { name: 'multi-hazard', doc: () => buildingsWorld(300, true), base: () => [quake(), rain(60)], deform: [def({ radius: 50 }), def({ kind: 'ridge', radius: 8, length: 80, bearing: 60, amount: 1, center: [-30, -30] })] },
];

function run(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  return c.load(structuredClone(doc)).then(() => {
    for (const e of events) c.addEvent(e);
    simProfiler.enabled = true;
    simProfiler.snapshot();
    const t0 = performance.now();
    c.advance(SIM_S);
    const ms = performance.now() - t0;
    // Totals over the run (ms) by system (sections are accumulated while enabled).
    const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
    const env = c.getEnvironment();
    const st = env.deformation.stats;
    const eng = env.deformation.engine;
    const out = {
      msPerSimS: +(ms / SIM_S).toFixed(1),
      updates: st?.updates ?? 0,
      deformTotalMs: +(st?.totalMs ?? 0).toFixed(1),
      colliderTotalMs: +(st?.colliderTotalMs ?? 0).toFixed(1),
      colliderMeanMs: st && st.updates ? +(st.colliderTotalMs / st.updates).toFixed(2) : 0,
      lastFieldMs: +(st?.fieldMs ?? 0).toFixed(2),
      lastWaterBedMs: +(st?.waterMs ?? 0).toFixed(2),
      lastResponseMs: +(st?.responseMs ?? 0).toFixed(2),
      verticesPerUpdate: st?.vertices ?? 0,
      objects: st?.objects ?? 0,
      roads: st?.roads ?? 0,
      maxAbs: eng ? +eng.maxAbs.toFixed(2) : 0,
      waterCells: env.flood.field ? env.flood.field.stats.wetCells : 0,
      physicsMs: +(sec.physics ?? 0).toFixed(0),
      waterSolverMs: +(sec['sys.waterSolver'] ?? 0).toFixed(0),
      deformationSysMs: +(sec['sys.deformation'] ?? 0).toFixed(1),
      structuralMs: +(sec['sys.structural'] ?? 0).toFixed(0),
      heapMB: heapMB(),
    };
    c.unload();
    simProfiler.enabled = false;
    return out;
  });
}

describe.skipIf(!process.env.BENCH)('terrain deformation benchmark', () => {
  it('A/B per scene', { timeout: 3_600_000 }, async () => {
    const rows = [];
    for (const sc of SCENES) {
      const doc = sc.doc();
      const a = await run(doc, sc.base());
      const b = await run(doc, [...sc.base(), ...sc.deform]);
      const row = {
        scene: sc.name, objects: Object.keys(doc.objects).length, roads: Object.keys(doc.roads.segments).length,
        msPerSimS_A: a.msPerSimS, msPerSimS_B: b.msPerSimS, overheadPct: +((b.msPerSimS / Math.max(1e-6, a.msPerSimS) - 1) * 100).toFixed(1),
        // The deformation's OWN cost per simulated second vs. the consequences it causes (more
        // moving bodies, debris, deeper water → more solver substeps, structural responses).
        ownMsPerSimS: +(b.deformationSysMs / SIM_S).toFixed(1),
        A_physicsMs: a.physicsMs, A_waterSolverMs: a.waterSolverMs, A_structuralMs: a.structuralMs,
        ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'msPerSimS')),
      };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simSeconds: SIM_S, rows }, null, 2));
  });
});
