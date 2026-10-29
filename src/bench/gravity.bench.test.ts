/**
 * Phase 31: cost of variable gravity in the simulation core (no rendering). Each scene is stepped one fixed step at a
 * time (worst step measured; the long run in 1 s steps, cost only) with the profiler sections
 *   gravity.field (field preparation, Rapier gravity, field-difference forces, wakes, structural ratios),
 *   gravity.ledger (energy / momentum ledger over the bodies), physics, sys.structuralCollapse, sys.waterSolver,
 *   thermal / climate / fire / volcano / atmosphere where present.
 * With AB=1 every scene also runs without its gravity experiment; the same file runs on the Phase 30 build (the
 * experiment is dropped there: no 'gravity' phenomenon) for the build A/B.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/gravity.bench --silent=false   (BENCH_OUT=file.json, SCENES=a,b, AB=1)
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
const HAS = !!phenomena.implemented('gravity');
const G0 = 9.81;
const K = (c: number) => c + 273.15;
type Lake = { id: string; kind: 'lake'; points: [number, number][]; surface: number; depth: number; shoreWidth: number; material: number; filled: boolean };
const LAKE: Lake = { id: 'l1', kind: 'lake', points: [[30, 10], [90, 10], [90, 60], [30, 60]], surface: -0.3, depth: 1.2, shoreWidth: 3, material: 7, filled: true };
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });

function world(add: Add[], opts: { fire?: Record<string, unknown>; lake?: Lake } = {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench31'));
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
/** n dynamic bodies (cars and people alternating) on a grid, 2 m above the ground (they fall first). */
function bodies(n: number): Add[] {
  const out: Add[] = [];
  const side = Math.ceil(Math.sqrt(n)), sp = Math.min(6, 190 / side);
  for (let k = 0; k < n; k++) {
    const x = -95 + (k % side) * sp, z = -95 + Math.floor(k / side) * sp;
    out.push(k % 2 ? { type: 'human', seed: 1000 + k, transform: tf(x, z, 2) } : { type: 'car', seed: 1000 + k, params: { length: Math.min(4.5, sp * 0.8) }, transform: tf(x, z, 2) });
  }
  return out;
}
const grav = (p: Record<string, unknown>): EventSpec => ({ event: 'gravity', scenario: 'custom', global: true, magnitude: G0, direction: [0, -1, 0], transition: 'vector', profile: 'smooth', ramp: 3, duration: 3600, end: 'hold', sources: [], startTime: 0, ...p } as EventSpec);
const well = { kind: 'radial', center: [0, 2, 0], radius: 25, falloff: 'smooth', edge: 8, strength: 15, r0: 5, law: 'inverseSquare', softening: 3, followProfile: true };
const cl = (p: Record<string, unknown>): EventSpec => ({ event: 'climate', scenario: 'custom', forcing: 'flux', temperature: K(-3), target: K(-3), profile: 'constant', duration: 3600, humidity: 0.85, mixTime: 900, precipitation: 0, precipPhase: 'auto', precipProfile: 'constant', solar: 'off', soilMoisture: 0.25, blowingSnow: false, roofSnow: true, startTime: 0, ...p } as EventSpec);
const erupt = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-40, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 120, profile: 'constant', ...p } as EventSpec);

type Scene = { name: string; doc: () => WorldDocument; events: EventSpec[]; seconds: number; coarse?: boolean };
const SCENES: Scene[] = [
  { name: '1 Earth gravity (town)', doc: () => world(town()), events: [grav({ magnitude: G0, profile: 'constant' })], seconds: 20 },
  { name: '2 low gravity (Moon-like)', doc: () => world(town()), events: [grav({ magnitude: 1.62 })], seconds: 20 },
  { name: '3 high gravity (2 g)', doc: () => world(town()), events: [grav({ magnitude: 2 * G0 })], seconds: 20 },
  { name: '4 zero gravity', doc: () => world(town()), events: [grav({ magnitude: 0 })], seconds: 20 },
  { name: '5 reversed gravity', doc: () => world(town()), events: [grav({ magnitude: G0, direction: [0, 1, 0], duration: 6, end: 'restore' })], seconds: 12 },
  { name: '6 horizontal gravity', doc: () => world(town()), events: [grav({ magnitude: G0, direction: [1, 0, 0], transition: 'rotate', duration: 10, end: 'restore' })], seconds: 15 },
  { name: '7 gravity ramp (→ 3 g over 20 s)', doc: () => world(town()), events: [grav({ magnitude: 3 * G0, profile: 'linear', ramp: 20 })], seconds: 30 },
  { name: '8 gravity pulse (0 g, 10 s period)', doc: () => world(town()), events: [grav({ magnitude: 0, profile: 'pulse', period: 10, pulseWidth: 4, ramp: 0.5, duration: 30, end: 'restore' })], seconds: 30 },
  { name: '9 local gravity field (well)', doc: () => world(town()), events: [grav({ global: false, sources: [well] })], seconds: 20 },
  { name: '10 radial field', doc: () => world(town()), events: [grav({ magnitude: 0, sources: [{ ...well, center: [0, 10, 0], radius: 80, edge: 20, strength: G0, r0: 20, law: 'linear', softening: 1 }] })], seconds: 20 },
  { name: '11 100 dynamic objects', doc: () => world(bodies(100)), events: [grav({ magnitude: 1.62 })], seconds: 15 },
  { name: '12 500 dynamic objects', doc: () => world(bodies(500)), events: [grav({ magnitude: 1.62 })], seconds: 10 },
  { name: '13 1000 dynamic objects', doc: () => world(bodies(1000)), events: [grav({ magnitude: 1.62 })], seconds: 10 },
  { name: '14 structural collapse (office + tower, → 4 g)', doc: () => world([building(-20, 0, 1, 'office'), building(30, 0, 2, 'tower')]), events: [grav({ magnitude: 4 * G0, profile: 'linear', ramp: 15 })], seconds: 30 },
  { name: '15 debris field (3 frames at 4.5 g)', doc: () => world([building(-50, 0, 1, 'office'), building(0, 0, 2, 'tower'), building(50, 0, 3, 'industrial')]), events: [grav({ magnitude: 4.5 * G0, profile: 'linear', ramp: 10 })], seconds: 30 },
  { name: '16 flood (lake + rain at 2 g)', doc: () => world(town(), { lake: LAKE }), events: [grav({ magnitude: 2 * G0 }), { event: 'rain', intensity: 150, duration: 60 } as EventSpec], seconds: 30 },
  { name: '17 atmosphere (removal at Moon-like g)', doc: () => world(town()), events: [grav({ magnitude: 1.62 }), { event: 'atmosphere', altitude: 0, boundary: 'open', thermo: 'adiabatic', removal: 'linear', extent: 'uniform', target: 0.5, duration: 30, startTime: 0 } as EventSpec], seconds: 30 },
  { name: '18 snowfall at 2 g', doc: () => world(town()), events: [grav({ magnitude: 2 * G0 }), cl({ precipitation: 8, precipPhase: 'snow' })], seconds: 60 },
  { name: '19 snow-loaded buildings (→ 2.5 g)', doc: () => world([...Array.from({ length: 8 }, (_, k) => building(-80 + k * 20, -20, k + 1)), building(-40, 30, 9, 'warehouse'), building(20, 30, 10, 'warehouse')]), events: [cl({ initialSnow: 0.6, initialSnowDensity: 200 }), grav({ magnitude: 2.5 * G0, profile: 'linear', ramp: 30 })], seconds: 60 },
  { name: '20 volcano at Mars-like g', doc: () => world([building(-20, 20, 1), conifer(-30, 8, 2)]), events: [grav({ magnitude: 3.71 }), erupt({ bombFraction: 0.05, ashFraction: 0.1, plumeHeight: 60 })], seconds: 60 },
  { name: '21 meteor at Moon-like g', doc: () => world(town()), events: [grav({ magnitude: 1.62, profile: 'constant' }), { event: 'impact', target: [0, 30], material: 'stony', diameter: 1, speed: 15000, angle: 60, azimuth: 45, entry: 'direct', airBlast: true, startTime: 1 } as EventSpec], seconds: 20 },
  { name: '22 fire at 2 g', doc: () => world([building(0, 0, 1), conifer(9, 0, 2)], { fire: {} }), events: [grav({ magnitude: 2 * G0 }), { event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 900 } as EventSpec], seconds: 120 },
  { name: '23 multi-hazard city', doc: () => world(town(), { lake: LAKE, fire: {} }), events: [grav({ magnitude: 2.5 * G0, profile: 'linear', ramp: 20 }), { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 12, seed: 3, startTime: 10 } as EventSpec, { event: 'rain', intensity: 100, duration: 60 } as EventSpec, { event: 'wind', speed: 20, direction: 'E', duration: 60 } as EventSpec, { event: 'fire', position: [-70, 40], height: 6, radius: 2, duration: 300 } as EventSpec], seconds: 60 },
  { name: '24 long simulation (town, pulses, 10 min)', doc: () => world(town()), events: [grav({ magnitude: 0.5 * G0, profile: 'cyclic', period: 120, duration: 600, end: 'restore' })], seconds: 600, coarse: true },
];

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function run(sc: Scene, withGravity: boolean) {
  const doc = sc.doc();
  const c = new SimulationController({ headless: true });
  simProfiler.enabled = true;
  simProfiler.snapshot();
  await c.load(doc);
  for (const e of sc.events) if (e.event !== 'gravity' || (withGravity && HAS)) c.addEvent(e);
  const step = sc.coarse ? 1 : 1 / 60;
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
    if (ms > worst && !sc.coarse) {
      worst = ms; worstAt = c.getTime();
      const after = secs();
      worstSections = Object.fromEntries(Object.entries(after).map(([n, v]) => [n, +(v - (before[n] ?? 0)).toFixed(1)]).filter(([, v]) => (v as number) >= 1).sort((x, y) => (y[1] as number) - (x[1] as number)).slice(0, 6));
    }
  }
  const ms = performance.now() - t0;
  const sec = (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const env = c.getEnvironment() as unknown as Any;
  const g = env.gravity?.rt ?? null;
  const b = g ? g.balance() : null;
  const per = (k: string) => +((sec[k] ?? 0) / sc.seconds).toFixed(2);
  const r0 = performance.now();
  await c.reset();
  const resetMs = performance.now() - r0;
  const out = {
    scene: sc.name, gravity: withGravity && !!g, objects: Object.keys(doc.objects).length, simSeconds: sc.seconds, stepping: sc.coarse ? '1 s (cost only)' : 'fixed 1/60 s',
    msPerSimS: +(ms / sc.seconds).toFixed(1), worstStepMs: sc.coarse ? null : +worst.toFixed(1), worstAt: sc.coarse ? null : +worstAt.toFixed(2), worstSections,
    gravityMsPerSimS: +(per('gravity.field') + per('gravity.ledger')).toFixed(2), fieldMs: per('gravity.field'), ledgerMs: per('gravity.ledger'),
    physicsMsPerSimS: per('physics'), structureMsPerSimS: per('sys.structuralCollapse'), floodMsPerSimS: per('sys.waterSolver'), thermalMsPerSimS: per('sys.thermal'),
    activeBodies: g ? g.stats.bodies : 0, gravitySamples: g ? g.stats.bodies + g.stats.inSource : 0, structuresLoaded: g ? g.structures.loaded : 0, failures: g ? g.failures : 0,
    debris: c.getRuntime()?.debris.length ?? 0, fieldResidualJ: b && Number.isFinite(b.fieldResidual) ? +b.fieldResidual.toExponential(2) : null,
    workGravityJ: b ? +b.workGravity.toExponential(3) : null, residualRel: b && Number.isFinite(b.fieldResidual) && b.workGravity !== 0 ? +Math.abs(b.fieldResidual / b.workGravity).toExponential(2) : null,
    // Phase 31 audit (M4): the checks against the GROSS path work (the net work of oscillating bodies is ≈ 0), the
    // integrator's share ε, the energy check R_Φ − ε, the other work (contacts, damping) and moves outside the integrator.
    grossJ: b && 'workGravityGross' in b ? +b.workGravityGross.toExponential(3) : null,
    integratorJ: b && 'integratorResidual' in b ? +b.integratorResidual.toExponential(2) : null,
    energyResidualJ: b && 'energyResidual' in b && Number.isFinite(b.energyResidual) ? +b.energyResidual.toExponential(2) : null,
    energyRelGross: b && 'energyResidual' in b && Number.isFinite(b.energyResidual) && b.workGravityGross > 0 ? +Math.abs(b.energyResidual / b.workGravityGross).toExponential(2) : null,
    fieldRelGross: b && 'workGravityGross' in b && Number.isFinite(b.fieldResidual) && b.workGravityGross > 0 ? +Math.abs(b.fieldResidual / b.workGravityGross).toExponential(2) : null,
    workOtherJ: b ? +b.workOther.toExponential(3) : null,
    workMovedJ: b && 'workMoved' in b ? +b.workMoved.toExponential(2) : null,
    heapMB: heapMB(), resetMs: +resetMs.toFixed(0),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH)('gravity benchmark', () => {
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
      const sc = SCENES[13];
      const heaps: number[] = [];
      const live0 = rapierWorlds.live;
      for (let k = 0; k < 6; k++) { const r = await run({ ...sc, seconds: 10 }, HAS); heaps.push(r.heapMB); }
      const row = { scene: '25 repeated runs (collapse ×6)', heapMB: heaps, rapierWorldsLeft: rapierWorlds.live - live0 };
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), build: HAS ? 'phase31' : 'phase30', rows }, null, 2));
  });
});
