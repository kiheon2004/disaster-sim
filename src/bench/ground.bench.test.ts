/**
 * Phase 22: cost of sinkholes and landslides in the simulation core (no rendering). Every scene
 * runs on the same world — A: without ground failure (the Phase 21 code path: the ground-failure
 * systems are inactive), B: with it; scenes that have a Phase 21 counterpart also run C: a
 * prescribed Phase 21 subsidence of the same footprint, as the reference cost of moving the same
 * ground with the deformation engine alone.
 *
 *   scenes: empty sinkhole, sinkhole under a building, sinkhole under a road, small / large
 *           landslide, landslide + river, landslide + flood (rain), 100 / 500 / 1000 buildings at
 *           the toe of a landslide, mountain village (city-mountain world)
 *   metrics: wall ms per simulated second (A, B, C), ground-failure updates and their split
 *            (stability, sinkhole, runout, Newmark, objects), runout substeps, the deformation
 *            engine (collider) share, sediment budget and its residual, heap.
 *
 *   BENCH=1 npx vitest run src/bench/ground --silent=false      (BENCH_OUT=file.json to save)
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
import type { LandslideSpec, SinkholeSpec } from '@/ground/types';
import type { TerrainDeformationSpec } from '@/deformation/types';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const SIM_S = Number(process.env.BENCH_SECONDS ?? 20);
const tf = (x: number, z: number) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });

const sink = (x: Partial<SinkholeSpec> = {}): SinkholeSpec => ({ event: 'sinkhole', center: [0, 0], cavityRadius: 5, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 2, ...x });
const slide = (x: Partial<LandslideSpec> = {}): LandslideSpec => ({ event: 'landslide', area: { kind: 'circle', center: [-30, 0], radius: 12 }, thickness: 1.5, saturation: 1, trigger: 'user', duration: 0, ...x });
const sub = (center: [number, number], radius: number, amount: number): TerrainDeformationSpec => ({ event: 'terrainDeformation', kind: 'subsidence', center, radius, amount, duration: 3, profile: 'smooth', falloff: 'smooth' });
const rain = (mmh = 80) => ({ ...(phenomena.implemented('rain')!.defaults() as object), intensity: mmh, duration: SIM_S } as EventSpec);

/** Plane descending toward +x at `deg` from x = −90 to 0, flat beyond; `n` buildings on the flat. */
function slopeWorld(deg: number, n = 0, roads = false): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench'));
  const t0 = S().doc.terrain;
  const heights = new Float32Array(t0.heights.length);
  const tb = Math.tan((deg * Math.PI) / 180);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
  S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  if (roads) S().applyEdit({ roads: drawRoad(S().doc.roads, [[3, -96], [3, 96]], { curved: false, profile: defaultProfile() }).network });
  const inputs = [];
  const step = n <= 100 ? 9 : n <= 500 ? 5 : 3.6;
  const d = presetDesign('house', 1)!;
  for (let x = 8; x <= 96 && inputs.length < n; x += step) for (let z = -96; z <= 96 && inputs.length < n; z += step) inputs.push({ type: 'building' as const, building: d, seed: inputs.length + 1, transform: tf(x, z) });
  if (inputs.length) S().applyEdit({ add: inputs });
  return structuredClone(S().doc);
}

function flatWorld(add: (doc: WorldDocument) => void = () => {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench'));
  add(S().doc);
  return structuredClone(S().doc);
}

function template(kind: 'riverValley' | 'mountainVillage'): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(buildTemplate(kind, 3));
  return structuredClone(S().doc);
}

/** Centre of the steepest 20 m neighbourhood of a world (where a landslide is plausible). */
function steepest(doc: WorldDocument): [number, number] {
  const t = doc.terrain;
  let best = -1, bx = 0, bz = 0;
  for (let iz = 12; iz < t.nz - 12; iz += 4) for (let ix = 12; ix < t.nx - 12; ix += 4) {
    const i = iz * t.nx + ix;
    const g = Math.hypot(t.heights[i + 10] - t.heights[i - 10], t.heights[i + 10 * t.nx] - t.heights[i - 10 * t.nx]);
    if (g > best) { best = g; bx = t.originX + ix * t.cellSize; bz = t.originZ + iz * t.cellSize; }
  }
  return [bx, bz];
}

interface Scene { name: string; doc: () => WorldDocument; base: () => EventSpec[]; ground: (doc: WorldDocument) => EventSpec[]; phase21?: (doc: WorldDocument) => EventSpec[] }

const SCENES: Scene[] = [
  { name: 'empty-sinkhole', doc: () => flatWorld(), base: () => [], ground: () => [sink()], phase21: () => [sub([0, 0], 8, 3)] },
  {
    name: 'sinkhole-under-building', doc: () => flatWorld(() => S().applyEdit({ add: [{ type: 'building', building: presetDesign('house', 2)!, seed: 1, transform: tf(0, 0) }, { type: 'building', building: presetDesign('apartment', 4)!, seed: 2, transform: tf(14, 4) }] })),
    base: () => [], ground: () => [sink()], phase21: () => [sub([0, 0], 8, 3)],
  },
  {
    name: 'sinkhole-under-road', doc: () => flatWorld(() => S().applyEdit({ roads: drawRoad(S().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: defaultProfile() }).network })),
    base: () => [], ground: () => [sink()], phase21: () => [sub([0, 0], 8, 3)],
  },
  { name: 'landslide-small', doc: () => slopeWorld(30), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 8 } })], phase21: () => [sub([-20, 0], 8, 1.5)] },
  { name: 'landslide-large', doc: () => slopeWorld(32), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-45, 0], radius: 35 }, thickness: 2.5 })], phase21: () => [sub([-45, 0], 35, 2.5)] },
  { name: 'landslide-river', doc: () => template('riverValley'), base: () => [], ground: (d) => [slide({ area: { kind: 'circle', center: steepest(d), radius: 15 }, boundary: 'open' })] },
  { name: 'landslide-flood', doc: () => slopeWorld(30), base: () => [rain(80)], ground: () => [slide({ area: { kind: 'circle', center: [-25, 0], radius: 12 } })] },
  { name: 'buildings100-toe', doc: () => slopeWorld(32, 100, true), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 15 } })] },
  { name: 'buildings500-toe', doc: () => slopeWorld(32, 500, true), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 15 } })] },
  { name: 'buildings1000-toe', doc: () => slopeWorld(32, 1000, true), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 15 } })] },
  {
    name: 'mountain-village', doc: () => template('mountainVillage'), base: () => [rain(60)],
    ground: (d) => { const c = steepest(d); return [slide({ area: { kind: 'circle', center: c, radius: 18 }, trigger: 'saturation', saturation: 0.5, targetSaturation: 1, duration: 8 }), sink({ center: [c[0] + 40, c[1]] })]; },
  },
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
    const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
    const env = c.getEnvironment();
    const g = env.groundFailure;
    const st = g.stats;
    const dst = env.deformation.stats;
    const b = g.field?.budget;
    const out = {
      msPerSimS: +(ms / SIM_S).toFixed(1),
      groundUpdates: st.updates,
      groundSysMs: +(sec['sys.groundFailure'] ?? 0).toFixed(1),
      sedimentForceMs: +(sec['sys.sedimentForce'] ?? 0).toFixed(1),
      deformationSysMs: +(sec['sys.deformation'] ?? 0).toFixed(1),
      lastStabilityMs: +st.stabilityMs.toFixed(2), lastSinkholeMs: +st.sinkholeMs.toFixed(2), lastFlowMs: +st.flowMs.toFixed(2),
      lastNewmarkMs: +st.newmarkMs.toFixed(3), lastObjectsMs: +st.objectsMs.toFixed(2),
      flowSubsteps: st.flowSubsteps, maxSpeed: +st.maxSpeed.toFixed(1),
      colliderMeanMs: dst && dst.updates ? +(dst.colliderTotalMs / dst.updates).toFixed(2) : 0,
      deformUpdates: dst?.updates ?? 0,
      released: b ? +b.released.toFixed(1) : 0, deposited: b ? +b.deposited.toFixed(1) : 0, mobile: b ? +b.mobile.toFixed(1) : 0,
      intoCavity: b ? +b.intoCavity.toFixed(1) : 0, residual: b ? b.residual : 0,
      physicsMs: +(sec.physics ?? 0).toFixed(0),
      waterSolverMs: +(sec['sys.waterSolver'] ?? 0).toFixed(0),
      heapMB: heapMB(),
    };
    c.unload();
    simProfiler.enabled = false;
    return out;
  });
}

describe.skipIf(!process.env.BENCH)('ground failure benchmark', () => {
  it('A/B(/C) per scene', { timeout: 3_600_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.includes(sc.name)) continue;
      const doc = sc.doc();
      const a = await run(doc, sc.base());
      const b = await run(doc, [...sc.base(), ...sc.ground(doc)]);
      const c = sc.phase21 ? await run(doc, [...sc.base(), ...sc.phase21(doc)]) : null;
      const row = {
        scene: sc.name, objects: Object.keys(doc.objects).length, roads: Object.keys(doc.roads.segments).length,
        msPerSimS_A: a.msPerSimS, msPerSimS_B: b.msPerSimS, msPerSimS_C_phase21: c?.msPerSimS ?? null,
        overheadPct: +((b.msPerSimS / Math.max(1e-6, a.msPerSimS) - 1) * 100).toFixed(1),
        // The ground failure's OWN cost per simulated second (models + runout + object responses + sediment drag).
        ownMsPerSimS: +((b.groundSysMs + b.sedimentForceMs) / SIM_S).toFixed(1),
        engineMsPerSimS: +(b.deformationSysMs / SIM_S).toFixed(1),
        phase21EngineMsPerSimS: c ? +(c.deformationSysMs / SIM_S).toFixed(1) : null,
        A_physicsMs: a.physicsMs, A_waterSolverMs: a.waterSolverMs,
        ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'msPerSimS')),
      };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simSeconds: SIM_S, rows }, null, 2));
  });
});
