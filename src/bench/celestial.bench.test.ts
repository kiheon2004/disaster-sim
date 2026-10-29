/**
 * Phase 32: cost of celestial sources in the simulation core (no rendering). Each scene is stepped one fixed step at a
 * time (worst step measured) with the profiler sections
 *   gravity.field / gravity.ledger (the Phase 31 field step and ledger, celestial runtime included),
 *   celestial.pre (probe / particle start, gradient torque), celestial.struct (storey loads, uplift check),
 *   celestial.kdk (the KDK replacement of free bodies' increments, captures), celestial.post (test particles, probe
 *   diagnostics, history), physics, sys.structuralCollapse, sys.structural (storey model), sys.waterSolver.
 * With AB=1 every scene also runs without its celestial experiment; the same file runs on the Phase 31 build (the
 * experiment is dropped there: no 'celestial' phenomenon) for the build A/B of the inactive scenes.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/celestial.bench --silent=false   (BENCH_OUT=file.json, SCENES=a,b, AB=1)
 *   long runs: BENCH=1 LONG=3600 LONG_SCENES="5 ,6 ,3 ,15 ,13 ,14 ,11 ,23 ,24 ,25 " … (1 s steps, health every 60 s)
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
const HAS = !!phenomena.implemented('celestial');
const G = 6.6743e-11;
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
type Lake = { id: string; kind: 'lake'; points: [number, number][]; surface: number; depth: number; shoreWidth: number; material: number; filled: boolean };
const LAKE: Lake = { id: 'l1', kind: 'lake', points: [[30, 10], [90, 10], [90, 60], [30, 60]], surface: -0.3, depth: 1.2, shoreWidth: 3, material: 7, filled: true };

function world(add: Add[], opts: { fire?: Record<string, unknown>; lake?: Lake } = {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench32'));
  if (opts.lake) S().setFeatures([opts.lake as never], 2);
  if (add.length) S().applyEdit({ add: add as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 42;
  if (opts.fire) (d.settings.simulation as unknown as Record<string, unknown>).fire = { foliageMoisture: 0.8, openings: 'windowsOpen', heatIgnition: false, ...opts.fire };
  return d;
}
const building = (x: number, z: number, seed: number, p = 'house'): Add => ({ type: 'building', building: D(p), seed, transform: tf(x, z) });
const conifer = (x: number, z: number, seed: number): Add => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });
/** A block: 6 houses, a warehouse, an office, 8 cars, 6 people, 4 trees. */
function town(): Add[] {
  const out: Add[] = [];
  for (let k = 0; k < 6; k++) out.push(building(-70 + k * 16, -40, k + 1));
  out.push(building(40, -40, 7, 'warehouse'), building(70, -40, 8, 'office'));
  for (let k = 0; k < 8; k++) out.push({ type: 'car', seed: 20 + k, transform: tf(-60 + k * 12, 0) });
  for (let k = 0; k < 6; k++) out.push({ type: 'human', seed: 40 + k, transform: tf(-50 + k * 10, 15) });
  for (let k = 0; k < 4; k++) out.push(conifer(-70 + k * 9, 40, 60 + k));
  return out;
}
/** n dynamic bodies (cars and people alternating) on a grid. */
function bodies(n: number): Add[] {
  const out: Add[] = [];
  const side = Math.ceil(Math.sqrt(n)), sp = Math.min(6, 190 / side);
  for (let k = 0; k < n; k++) {
    const x = -95 + (k % side) * sp, z = -95 + Math.floor(k / side) * sp;
    out.push(k % 2 ? { type: 'human', seed: 1000 + k, transform: tf(x, z, 0) } : { type: 'car', seed: 1000 + k, params: { length: Math.min(4.5, sp * 0.8) }, transform: tf(x, z, 0) });
  }
  return out;
}
/** n houses on a grid (6 m apart below 400, else tighter). */
function houses(n: number): Add[] {
  const d = createDesign({ ...presetSpec('house')!, floors: 2 }, 'house');
  const out: Add[] = [];
  const sp = n > 400 ? 6 : 9;
  for (let z = -94; z <= 94 && out.length < n; z += sp) for (let x = -94; x <= 94 && out.length < n; x += sp) out.push({ type: 'building', building: d, seed: out.length + 1, transform: tf(x, z) });
  return out;
}

const src = (p: Record<string, unknown> = {}) => ({ kind: 'blackHole', center: [0, 30, 0], mass: 5e4 / G, softening: 2, capture: 1.5, influence: 0, massPolicy: 'fixed', motion: 'fixed', ramp: 2, ...p });
const cel = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'celestial', scenario: 'custom', scale: 'educational', sources: [src()], probes: [], accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 3600, end: 'hold', tidal: true, lensing: false, limitPolicy: 'warn', startTime: 0, ...p } as unknown as EventSpec);
const zero: EventSpec = { event: 'gravity', scenario: 'zero', global: true, magnitude: 0, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: 6 * 3600, end: 'hold', sources: [], startTime: 0 } as EventSpec;
const probe = (position: number[], mode: string, factor: number, direction: number[], velocity?: number[]) => ({ position, mode, factor, direction, velocity, mass: 50, radius: 0.6 });
const LAB = [0, 60, 0];
const labSrc = (p: Record<string, unknown> = {}) => src({ center: LAB, softening: 1, capture: 1, ramp: 0, ...p });

interface Scene { name: string; doc: () => WorldDocument; events: EventSpec[]; seconds: number; coarse?: boolean }
export const SCENES: Scene[] = [
  { name: '1 Phase 31 inactive (town, no celestial)', doc: () => world(town()), events: [], seconds: 20 },
  { name: '2 weak gravity well (μ 2e3, town)', doc: () => world(town()), events: [cel({ sources: [src({ mass: 2e3 / G })] })], seconds: 20 },
  { name: '3 strong gravity well (μ 3e5, town)', doc: () => world(town()), events: [cel({ sources: [src({ mass: 3e5 / G, softening: 4, capture: 3, center: [0, 45, 0] })] })], seconds: 20 },
  { name: '4 softened source (ε 10 m)', doc: () => world(town()), events: [cel({ sources: [src({ softening: 10 })] })], seconds: 20 },
  { name: '5 circular orbit', doc: () => world([]), events: [zero, cel({ sources: [labSrc()], probes: [probe([30, 60, 0], 'circular', 1, [0, 0, 1])] })], seconds: 30 },
  { name: '6 elliptical orbit', doc: () => world([]), events: [zero, cel({ sources: [labSrc()], probes: [probe([40, 60, 0], 'circular', 0.7, [0, 0, 1])] })], seconds: 30 },
  { name: '7 escape orbit', doc: () => world([]), events: [zero, cel({ sources: [labSrc()], probes: [probe([20, 60, 0], 'escape', 1.05, [0, 0, 1])] })], seconds: 20 },
  { name: '8 hyperbolic flyby', doc: () => world([]), events: [zero, cel({ sources: [labSrc()], probes: [probe([-180, 60, 20], 'custom', 1, [1, 0, 0], [40, 0, 0])] })], seconds: 20 },
  { name: '9 tidal field (cars, zero g)', doc: () => world(town()), events: [zero, cel({ sources: [src({ center: [-10, 20, 0], mass: 3e4 / G, capture: 1, ramp: 6 })] })], seconds: 20 },
  { name: '10 tidal building (one house, lateral)', doc: () => world([building(0, 0, 1)]), events: [cel({ sources: [src({ center: [40, 6, 0], mass: 3e3 / G, ramp: 1 })] })], seconds: 20 },
  { name: '11 tidal collapse (town)', doc: () => world(town()), events: [cel({ sources: [src({ center: [0, 45, 0], mass: 3e5 / G, softening: 4, capture: 3, ramp: 20 })] })], seconds: 40 },
  { name: '12 capture (block)', doc: () => world(town()), events: [cel({ sources: [src({ center: [-30, 12, 0], capture: 2.5, ramp: 3 })] })], seconds: 20 },
  { name: '13 growing source', doc: () => world(town()), events: [cel({ sources: [src({ center: [-30, 12, 0], capture: 2.5, ramp: 3, massPolicy: 'grow' })], accretion: { visual: true, particles: 600, inner: 4, outer: 14, particleMass: 1000, spread: 0.45 } })], seconds: 20 },
  { name: '14 moving source', doc: () => world(town()), events: [cel({ sources: [src({ mass: 8e4 / G, softening: 2.5, capture: 2, motion: 'path', path: [[0, -90, 25, -20], [30, 0, 25, 0], [60, 90, 25, 20]] })] })], seconds: 40 },
  { name: '15 two sources', doc: () => world([]), events: [zero, cel({ sources: [labSrc({ center: [-25, 60, 0], mass: 3e4 / G, softening: 2, capture: 1.5 }), labSrc({ center: [25, 60, 0], mass: 3e4 / G, softening: 2, capture: 1.5 })], probes: [probe([70, 60, 0], 'custom', 1, [1, 0, 0], [0, 0, Math.sqrt(6e4 / 70)]), probe([0, 60, 0.5], 'custom', 1, [1, 0, 0], [0, 0, 5])] })], seconds: 30 },
  { name: '16 accretion (2000 particles)', doc: () => world([]), events: [zero, cel({ sources: [labSrc({ softening: 2, capture: 1.5 })], accretion: { visual: true, particles: 2000, inner: 5, outer: 25, particleMass: 1, spread: 0.3 } })], seconds: 20 },
  { name: '17 100 objects', doc: () => world(bodies(100)), events: [cel({ sources: [src({ center: [0, 20, 0], mass: 1e5 / G, softening: 3, capture: 2.5 })] })], seconds: 15 },
  { name: '18 500 objects', doc: () => world(bodies(500)), events: [cel({ sources: [src({ center: [0, 20, 0], mass: 1e5 / G, softening: 3, capture: 2.5 })] })], seconds: 15 },
  { name: '19 1000 objects', doc: () => world(bodies(1000)), events: [cel({ sources: [src({ center: [0, 20, 0], mass: 1e5 / G, softening: 3, capture: 2.5 })] })], seconds: 10 },
  { name: '20 100 buildings', doc: () => world(houses(100)), events: [cel({ sources: [src({ center: [0, 40, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 10 })] })], seconds: 15 },
  { name: '21 500 buildings', doc: () => world(houses(500)), events: [cel({ sources: [src({ center: [0, 40, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 10 })] })], seconds: 15 },
  { name: '22 1000 buildings', doc: () => world(houses(1000)), events: [cel({ sources: [src({ center: [0, 40, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 10 })] })], seconds: 15 },
  { name: '23 debris (tower collapse)', doc: () => world([building(30, 30, 9, 'tower'), ...town()]), events: [cel({ sources: [src({ center: [30, 50, 30], mass: 1.5e5 / G, softening: 3, capture: 2.5, ramp: 15 })] })], seconds: 40 },
  { name: '24 meteor + source', doc: () => world(town()), events: [cel({ sources: [src({ center: [-20, 40, -10], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 5 })] }), { event: 'impact', target: [10, 30], material: 'stony', diameter: 1, speed: 15000, angle: 60, azimuth: 45, entry: 'direct', airBlast: true, startTime: 5 } as EventSpec], seconds: 20 },
  { name: '25 multi-hazard (source + quake + rain + wind + fire)', doc: () => world(town(), { lake: LAKE, fire: {} }), events: [cel({ sources: [src({ center: [0, 50, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 10 })] }), { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 12, seed: 3, startTime: 5 } as EventSpec, { event: 'rain', intensity: 100, duration: 60 } as EventSpec, { event: 'wind', speed: 20, direction: 'E', duration: 60 } as EventSpec, { event: 'fire', position: [-70, 40], height: 6, radius: 2, duration: 300 } as EventSpec], seconds: 30 },
];

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function run(sc: Scene, withCelestial: boolean) {
  const doc = sc.doc();
  const c = new SimulationController({ headless: true });
  simProfiler.enabled = true;
  simProfiler.snapshot();
  await c.load(doc);
  for (const e of sc.events) if (e.event !== 'celestial' || (withCelestial && HAS)) c.addEvent(e);
  const steps = Math.round(sc.seconds * 60);
  let worst = 0, worstAt = 0;
  const secs = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  let worstSections: Record<string, number> = {};
  let maxSub = 0, sumMean = 0;
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) {
    const before = secs();
    const a = performance.now();
    c.advance(1 / 60);
    const ms = performance.now() - a;
    const cr = (c.getEnvironment() as unknown as Any).gravity?.rt?.celestial;
    if (cr) { maxSub = Math.max(maxSub, cr.stats.maxSubsteps); sumMean += cr.stats.meanSubsteps; }
    if (ms > worst) {
      worst = ms; worstAt = c.getTime();
      const after = secs();
      worstSections = Object.fromEntries(Object.entries(after).map(([n, v]) => [n, +(v - (before[n] ?? 0)).toFixed(1)]).filter(([, v]) => (v as number) >= 1).sort((x, y) => (y[1] as number) - (x[1] as number)).slice(0, 6));
    }
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const env = c.getEnvironment() as unknown as Any;
  const g = env.gravity?.rt ?? null;
  const cr = g?.celestial ?? null;
  const b = g ? g.balance() : null;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const out = {
    scene: sc.name, celestial: withCelestial && !!cr, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds,
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: +worst.toFixed(1), worstAt: +worstAt.toFixed(2), worstSections,
    gravityFieldMs: per('gravity.field'), gravityLedgerMs: per('gravity.ledger'),
    celestialPreMs: per('celestial.pre'), celestialStructMs: per('celestial.struct'), kdkMs: per('celestial.kdk'), celestialPostMs: per('celestial.post'),
    physicsMs: per('physics'), collapseMs: per('sys.structuralCollapse'), storeyMs: per('sys.structural'), floodMs: per('sys.waterSolver'),
    maxSubsteps: maxSub, meanSubsteps: +(sumMean / steps).toFixed(2), capped: cr ? cr.stats.capped : 0,
    bodies: g ? g.stats.bodies : 0, captured: cr ? cr.ledger.count : 0, capturedKg: cr ? +cr.ledger.mass.toFixed(1) : 0, massResidual: cr ? cr.ledger.massResidual() : null,
    failures: cr ? cr.failures : 0, uplifted: cr ? cr.structures.uplifted : 0, loadedUnits: cr ? cr.structures.loadedUnits : 0, debris: c.getRuntime()?.debris.length ?? 0,
    energyResidualJ: b && Number.isFinite(b.energyResidual) ? +b.energyResidual.toExponential(2) : null,
    energyRelGross: b && Number.isFinite(b.energyResidual) && b.workGravityGross > 0 ? +Math.abs(b.energyResidual / b.workGravityGross).toExponential(2) : null,
    integratorJ: b ? +b.integratorResidual.toExponential(2) : null, workOtherJ: b ? +b.workOther.toExponential(3) : null,
    probeMaxErr: cr ? cr.probes.map((p: Any) => +p.diag.maxErr.toExponential(2)) : [], probeLErr: cr ? cr.probes.map((p: Any) => +p.diag.lErr.toExponential(2)) : [],
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH || !!process.env.LONG)('celestial benchmark', () => {
  it('scenes', { timeout: 28_800_000 }, async () => {
    const rows = [];
    const only = process.env.SCENES?.split(',');
    const ab = !!process.env.AB || !HAS;
    for (const sc of SCENES) {
      if (only && !only.some((o) => sc.name.startsWith(o))) continue;
      if (HAS) { const row = await run(sc, true); console.log(JSON.stringify(row)); rows.push(row); }
      if (ab) { const row = await run(sc, false); console.log(JSON.stringify(row)); rows.push(row); }
    }
    if (!only || only.includes('R')) {
      const sc = SCENES[11];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 8 }, HAS); heaps.push(r.heapMB); }
      const row = { scene: 'R repeated runs (capture ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), build: HAS ? 'phase32' : 'phase31', rows }, null, 2));
  });
});

/**
 * Long runs (§54): LONG=<seconds> (≥ 3600) of the scenes in LONG_SCENES, 1 s steps (the fixed 1/60 s steps inside),
 * a health sample every 60 simulated seconds: non-finite values in the gravity and capture ledgers, the probes'
 * energy / angular-momentum errors and radius drift, captures, mass residuals, water budget, heap, bodies.
 */
describe.skipIf(!process.env.BENCH || !process.env.LONG)('celestial long runs', () => {
  it('long', { timeout: 28_800_000 }, async () => {
    const T = +process.env.LONG!;
    const only = (process.env.LONG_SCENES ?? '5 ,6 ,3 ,15 ,13 ,14 ,11 ,23 ,24 ,25 ').split(',');
    const rows: Any[] = [];
    for (const sc of SCENES) {
      if (!only.some((o) => sc.name.startsWith(o))) continue;
      const c = new SimulationController({ headless: true });
      await c.load(sc.doc());
      for (const e of sc.events) c.addEvent(e.event === 'celestial' ? ({ ...e, duration: Math.max(T, (e as Any).duration), end: 'hold' } as EventSpec) : e.event === 'gravity' ? ({ ...e, duration: Math.max(T, (e as Any).duration) } as EventSpec) : e);
      const samples: Any[] = [];
      let bad: string[] = [];
      const t0 = performance.now();
      let last = t0;
      for (let s = 1; s <= T; s++) {
        c.advance(1);
        if (s % 60 !== 0 && s !== T) continue;
        const env = c.getEnvironment() as unknown as Any;
        const g = env.gravity?.rt, cr = g?.celestial;
        const now = performance.now();
        const sample: Any = { t: s, msPerSimS: +((now - last) / 60).toFixed(1), heapMB: heapMB(), bodies: c.getPhysics()!.bodyCount(), debris: c.getRuntime()!.debris.length };
        last = now;
        if (g) {
          const b = g.balance();
          for (const [k, v] of Object.entries(b)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'number' && !Number.isFinite(x) && !['potential', 'fieldResidual', 'energyResidual', 'workField'].includes(k)) bad.push(`t${s} gravity.${k}`);
          sample.energyRelGross = Number.isFinite(b.energyResidual) && b.workGravityGross > 0 ? +Math.abs(b.energyResidual / b.workGravityGross).toExponential(2) : null;
        }
        if (cr) {
          const L = cr.ledger;
          for (const v of [L.mass, L.kinetic, L.kineticRel, L.potential, ...L.momentum, ...L.constraintImpulse]) if (!Number.isFinite(v)) bad.push(`t${s} capture ledger`);
          for (let i = 0; i < cr.px.length; i++) if (!Number.isFinite(cr.px[i])) { bad.push(`t${s} particle`); break; }
          sample.captured = L.count; sample.massResidual = L.massResidual();
          sample.particleResidual = L.particleResidual(cr.stats.particles * cr.pmass);
          sample.probes = cr.probes.map((p: Any) => ({ s: p.state, r: +p.diag.r.toFixed(3), rMin: +p.diag.rMin.toFixed(3), rMax: +p.diag.rMax.toFixed(3), dE: +p.diag.maxErr.toExponential(2), dL: +p.diag.lErr.toExponential(2), T: Number.isFinite(p.diag.period) ? +p.diag.period.toFixed(4) : null }));
          sample.capped = cr.stats.capped; sample.maxSub = cr.stats.maxSubsteps; sample.failures = cr.failures;
        }
        const f = env.flood?.field;
        if (f) {
          sample.waterErrRel = +(Math.abs(f.budget.error) / Math.max(1, f.budget.initial + f.budget.rain + f.budget.sources + f.budget.boundaryIn)).toExponential(2);
          for (let i = 0; i < f.count; i++) if (!Number.isFinite(f.h[i]) || f.h[i] < 0) { bad.push(`t${s} water.h[${i}]`); break; }
        }
        for (const e of c.getRuntime()!.entities.values()) {
          if (!e.pose.position.every(Number.isFinite)) bad.push(`t${s} pose ${e.id}`);
          const m = e.modular?.structure?.model;
          if (m && Math.abs(m.ledger.residual()) > 1e-6 * m.ledger.original) bad.push(`t${s} struct ledger ${e.id}`);
        }
        samples.push(sample);
      }
      bad = [...new Set(bad)].slice(0, 20);
      const row = { scene: sc.name, seconds: T, wallS: +((performance.now() - t0) / 1000).toFixed(1), bad, samples };
      console.log(JSON.stringify({ scene: row.scene, wallS: row.wallS, bad: row.bad, first: samples[0], last: samples[samples.length - 1] }));
      rows.push(row);
      c.unload();
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
