/**
 * Phase 23: cost of meteoroid / asteroid impacts in the simulation core (no rendering). Each scene
 * runs on the same world — A: without the impact (Phase 22 code path, impact system inactive),
 * B: with it, C: a Phase 22 sinkhole of comparable size at the same point (reference cost of the
 * shared ground path) — plus the plan stages timed on their own (entry integration, crater +
 * ejecta flights, shock), and a repeated-impact stress run.
 *
 *   scenes: small / medium impact, slope, rock, loose (fill) ground, road, dense buildings,
 *           river + lake, impact + landslide, impact + flood (rain), buildings 100 / 500 / 1000,
 *           repeated impacts (6 in one run)
 *
 *   BENCH=1 npx vitest run src/bench/impact --silent=false      (BENCH_OUT=file.json to save)
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
import { planImpact } from '@/impact/plan';
import { integrateEntry } from '@/impact/entry';
import { resolveProjectile } from '@/impact/projectile';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { ImpactSpec } from '@/impact/types';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const SIM_S = Number(process.env.BENCH_SECONDS ?? 20);
const tf = (x: number, z: number) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });

const small = (x: Partial<ImpactSpec> = {}): ImpactSpec => ({ event: 'impact', target: [0, 0], material: 'stony', diameter: 0.6, speed: 6000, angle: 75, azimuth: 90, entry: 'direct', ...x });
const medium = (x: Partial<ImpactSpec> = {}): ImpactSpec => ({ event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere', ...x });
const rain = (mmh = 80) => ({ ...(phenomena.implemented('rain')!.defaults() as object), intensity: mmh, duration: SIM_S + 20 } as EventSpec);

function world(soil = 1, n = 0, roads = false, slope = 0): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench'));
  if (slope > 0) {
    const t0 = S().doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((slope * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  }
  if (soil !== 1) S().doc.terrain.soil.fill(soil);
  if (roads) {
    let net = drawRoad(S().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: defaultProfile() }).network;
    net = drawRoad(net, [[0, -96], [0, 96]], { curved: false, profile: defaultProfile() }).network;
    S().applyEdit({ roads: net });
  }
  const d = presetDesign('house', 1)!, add = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && add.length < n; z += step) for (let x = -94; x <= 94 && add.length < n; x += step) {
    if (roads && (Math.abs(x) < 6 || Math.abs(z) < 6)) continue;
    add.push({ type: 'building' as const, building: d, seed: add.length + 1, transform: tf(x, z) });
  }
  if (add.length) S().applyEdit({ add });
  return structuredClone(S().doc);
}

function template(kind: 'riverValley'): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(buildTemplate(kind, 3));
  return structuredClone(S().doc);
}

const sink = (c: [number, number], r: number): EventSpec => ({ event: 'sinkhole', center: c, cavityRadius: Math.max(0.5, r), cavityHeight: Math.max(1, r), cover: Math.max(1, r * 0.7), initiation: 'supportLoss', supportLoss: 0.95, duration: 1 } as EventSpec);

interface Scene { name: string; doc: () => WorldDocument; base: () => EventSpec[]; impacts: () => ImpactSpec[]; reference?: boolean }

const SCENES: Scene[] = [
  { name: 'small', doc: () => world(), base: () => [], impacts: () => [small()], reference: true },
  { name: 'medium', doc: () => world(), base: () => [], impacts: () => [medium()], reference: true },
  { name: 'slope', doc: () => world(1, 0, false, 28), base: () => [], impacts: () => [medium({ target: [-15, 0] })], reference: true },
  { name: 'rock', doc: () => world(0), base: () => [], impacts: () => [medium()], reference: true },
  { name: 'loose-fill', doc: () => world(3), base: () => [], impacts: () => [medium()], reference: true },
  { name: 'road', doc: () => world(1, 0, true), base: () => [], impacts: () => [medium({ target: [0, 0] })] },
  { name: 'dense-buildings', doc: () => world(1, 300, true), base: () => [], impacts: () => [medium({ target: [20, 20] })] },
  { name: 'river-lake', doc: () => template('riverValley'), base: () => [], impacts: () => [medium({ target: [10, 10] })] },
  { name: 'impact+landslide', doc: () => world(1, 0, false, 34), base: () => [{ event: 'landslide', area: { kind: 'circle', center: [-12, 0], radius: 10 }, thickness: 1.5, saturation: 0.3, trigger: 'slope', duration: 1 } as EventSpec], impacts: () => [small({ target: [-4, 0], diameter: 1.2, speed: 8000 })] },
  { name: 'impact+flood', doc: () => world(), base: () => [rain(120)], impacts: () => [medium()] },
  { name: 'buildings100', doc: () => world(1, 100), base: () => [], impacts: () => [medium()] },
  { name: 'buildings500', doc: () => world(1, 500), base: () => [], impacts: () => [medium()] },
  { name: 'buildings1000', doc: () => world(1, 1000), base: () => [], impacts: () => [medium()] },
  { name: 'repeated-6', doc: () => world(1, 100, true), base: () => [], impacts: () => [-60, -30, 0, 30, 60, 0].map((x, k) => medium({ target: [x, k === 5 ? 40 : -20], startTime: k * 4, seed: k + 1 })) },
];

function run(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  return c.load(structuredClone(doc)).then(() => {
    for (const e of events) c.addEvent(e);
    simProfiler.enabled = true;
    simProfiler.snapshot();
    const t0 = performance.now();
    // The medium impact lands after ~12 s of entry: simulate the entry plus SIM_S after it.
    const total = SIM_S + Math.max(0, ...events.map((e) => (e.event === 'impact' ? (e.startTime ?? 0) + 13 : 0)));
    c.advance(total);
    const ms = performance.now() - t0;
    const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
    const env = c.getEnvironment();
    const ist = env.impact.stats, dst = env.deformation.stats, f = env.groundFailure.field;
    const out = {
      simSeconds: +total.toFixed(1),
      msPerSimS: +(ms / total).toFixed(1),
      impactSysMs: +(sec['sys.impact'] ?? 0).toFixed(1),
      groundSysMs: +(sec['sys.groundFailure'] ?? 0).toFixed(1),
      deformationSysMs: +(sec['sys.deformation'] ?? 0).toFixed(1),
      physicsMs: +(sec.physics ?? 0).toFixed(0),
      waterSolverMs: +(sec['sys.waterSolver'] ?? 0).toFixed(0),
      structuralMs: +(sec['sys.structural'] ?? 0).toFixed(0),
      groundMotionMs: +(sec['sys.groundMotion'] ?? 0).toFixed(1),
      colliderMeanMs: dst && dst.updates ? +(dst.colliderTotalMs / dst.updates).toFixed(2) : 0,
      engineUpdates: dst?.updates ?? 0,
      landings: ist.landings,
      residual: f ? f.budget.residual : 0,
      events: c.getDamageEvents().length,
      heapMB: heapMB(),
    };
    c.unload();
    simProfiler.enabled = false;
    return out;
  });
}

describe.skipIf(!process.env.BENCH)('impact benchmark', () => {
  it('A/B/C per scene', { timeout: 7_200_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    for (const sc of SCENES) {
      if (only && !only.includes(sc.name)) continue;
      const doc = sc.doc();
      const impacts = sc.impacts();
      // Plan stages on their own (the event computes this once at its start).
      const p0 = performance.now();
      const plans = impacts.map((s) => planImpact(s, doc.terrain, s.seed ?? 1));
      const planMs = performance.now() - p0;
      const e0 = performance.now();
      for (const s of impacts) if (s.entry === 'atmosphere') integrateEntry(resolveProjectile(s), s.speed, s.angle);
      const entryMs = performance.now() - e0;
      const n0 = performance.now();
      for (const s of impacts) planImpact(s, doc.terrain, s.seed ?? 1, false);
      const noEjectaMs = performance.now() - n0;
      const a = await run(doc, sc.base());
      const b = await run(doc, [...sc.base(), ...impacts]);
      const R = plans[0].crater?.radius ?? 2;
      const cRef = sc.reference ? await run(doc, [...sc.base(), sink([plans[0].arc.point[0], plans[0].arc.point[2]], R)]) : null;
      const row = {
        scene: sc.name, objects: Object.keys(doc.objects).length, roads: Object.keys(doc.roads.segments).length,
        craterD: +(2 * R).toFixed(1), parcels: plans.reduce((s, p) => s + p.parcels.length, 0),
        // planMs = whole plan; entry = atmospheric entry integration; craterShock = arc + crater + shock
        // (plan without ejecta, minus entry); ejecta = parcel generation + flight integration.
        planMs: +planMs.toFixed(1), entryMs: +entryMs.toFixed(1), craterShockMs: +Math.max(0, noEjectaMs - entryMs).toFixed(1), ejectaMs: +Math.max(0, planMs - noEjectaMs).toFixed(1),
        msPerSimS_A: a.msPerSimS, msPerSimS_B: b.msPerSimS, msPerSimS_C_phase22: cRef?.msPerSimS ?? null,
        overheadPct: +((b.msPerSimS / Math.max(1e-6, a.msPerSimS) - 1) * 100).toFixed(1),
        impactMsPerSimS: +(b.impactSysMs / b.simSeconds).toFixed(2),
        groundMsPerSimS: +(b.groundSysMs / b.simSeconds).toFixed(2),
        engineMsPerSimS: +(b.deformationSysMs / b.simSeconds).toFixed(2),
        phase22EngineMsPerSimS: cRef ? +(cRef.deformationSysMs / cRef.simSeconds).toFixed(2) : null,
        A_physicsMs: a.physicsMs, A_waterSolverMs: a.waterSolverMs, A_structuralMs: a.structuralMs,
        ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'msPerSimS')),
      };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simSecondsAfterImpact: SIM_S, rows }, null, 2));
  });
});
