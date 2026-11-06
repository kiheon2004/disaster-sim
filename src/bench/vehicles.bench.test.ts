/**
 * Phase 35: cost of the vehicle dynamics (no rendering). Fleets of 1–1000 cars (20 m grid) in four models: legacy (L0, no
 * vehicle settings), rigid (L1, exact inertia, no wheels), parked (L2, gear P + handbrake) and circling (L2, throttle + steer);
 * fleets with as many extended people (100 + 100 … 1000 + 1000). Per run: ms per simulated second, profiler sections
 * (vehicle rays / step / apply, monitor, contacts, people, Rapier), p50 / p95 / worst step, heap; repeats → median and range.
 * A micro-benchmark times the parts of one vehicle step (tyre force, implicit wheel spin, the whole step with given hits).
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/vehicles.bench --silent=false   (BENCH_OUT=file.json, SIZES=…, KINDS=…, REPEATS=3)
 *   long runs: BENCH=1 LONG=3600 npx vitest run src/bench/vehicles.bench --silent=false (LONG_SCENES=…)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { SimulationController } from '@/simulation/SimulationController';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { buildWorld, car, person, type DemoObject } from '@/human/demos';
import type { VehicleCar, VehicleSettings } from '@/vehicle/settings';
import { vehicleGeometry } from '@/vehicle/geometry';
import { newVehicleState, stepVehicle, type WheelHit } from '@/vehicle/dynamics';
import { implicitSpin, tireForce } from '@/vehicle/tire';
import { neutralControls } from '@/vehicle/powertrain';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

const KINDS = ['legacy', 'rigid', 'parked', 'circle'] as const;
type Kind = (typeof KINDS)[number];

function fleet(n: number, kind: Kind, people = 0): WorldDocument {
  const side = Math.ceil(Math.sqrt(n));
  const objs: DemoObject[] = [];
  for (let k = 0; k < n; k++) objs.push(car(-side * 10 + 20 * (k % side), -side * 10 + 20 * Math.floor(k / side), k + 1));
  for (let k = 0; k < people; k++) objs.push(person(-side * 10 + 20 * (k % side) + 10, -side * 10 + 20 * Math.floor(k / side) + 10, 5000 + k));
  const doc = buildWorld({ objects: objs, seed: 42, name: 'bench35' });
  if (!people) delete doc.settings.simulation.humans;
  if (kind !== 'legacy') {
    const cars: Record<string, VehicleCar> = {};
    for (const o of Object.values(doc.objects)) if (o.type === 'car') cars[o.id] = kind === 'rigid' ? { level: 'rigid' } : kind === 'parked' ? {} : { controls: { gear: 'D', throttle: 0.25, steer: 0.7 } };
    doc.settings.simulation.vehicles = { model: 'dynamics', cars } as VehicleSettings;
  }
  return doc;
}

const SECTIONS = ['physics', 'vehicles', 'vehicle.rays', 'vehicle.step', 'vehicle.apply', 'vehicleMonitor', 'damage.impacts', 'humans', 'windForce', 'dispatch'];

async function run(doc: WorldDocument, seconds: number) {
  const c = new SimulationController({ headless: true });
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const sec = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  await c.load(doc);
  c.advance(1); // settle (not timed)
  const s0 = sec();
  const steps = Math.round(seconds * 60);
  const frames: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    const a = performance.now();
    c.advance(1 / 60);
    frames.push(performance.now() - a);
  }
  const ms = performance.now() - t0;
  const s1 = sec();
  frames.sort((x, y) => x - y);
  const per: Record<string, number> = {};
  for (const k of SECTIONS) per[k] = +(((s1[`sys.${k}`] ?? s1[k] ?? 0) - (s0[`sys.${k}`] ?? s0[k] ?? 0)) / seconds).toFixed(3);
  const cars = [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'car');
  const out = {
    msPerSimS: ms / seconds, p50: frames[Math.floor(steps * 0.5)], p95: frames[Math.floor(steps * 0.95)], worst: frames[steps - 1], sections: per,
    nonFinite: cars.some((e) => !e.pose.position.every(Number.isFinite)), collisions: c.getDamageEvents().filter((d) => d.eventType === 'VEHICLE_COLLISION').length,
    duplicates: c.duplicateForces(), heapMB: heapMB(),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH || !!process.env.LONG)('vehicle benchmark', () => {
  it('fleets', { timeout: 28_800_000 }, async () => {
    const sizes = (process.env.SIZES ?? '1,10,50,100,250,500,1000').split(',').map(Number);
    const kinds = (process.env.KINDS ?? KINDS.join(',')).split(',') as Kind[];
    const mixed = (process.env.MIXED ?? '100,250,500,1000').split(',').filter(Boolean).map(Number);
    const repeats = +(process.env.REPEATS ?? 3);
    const rows: Any[] = [];
    const agg = (rs: Any[]) => {
      const pick = (f: (r: Any) => number) => ({ median: +median(rs.map(f)).toFixed(3), min: +Math.min(...rs.map(f)).toFixed(3), max: +Math.max(...rs.map(f)).toFixed(3) });
      return { msPerSimS: pick((r) => r.msPerSimS), p95: pick((r) => r.p95), worst: pick((r) => r.worst), ...Object.fromEntries(SECTIONS.map((k) => [k, pick((r) => r.sections[k])])), nonFinite: rs.some((r) => r.nonFinite), collisions: rs[0].collisions, duplicates: rs[0].duplicates, heapMB: rs[rs.length - 1].heapMB };
    };
    for (const n of sizes) for (const kind of kinds) {
      const seconds = n >= 500 ? 3 : 5;
      const reps = n >= 1000 ? 1 : repeats;
      const rs: Any[] = [];
      for (let r = 0; r < reps; r++) rs.push(await run(fleet(n, kind), seconds));
      const row = { n, kind, people: 0, seconds, repeats: reps, ...agg(rs), load: os.loadavg().map((v) => +v.toFixed(1)) };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    for (const n of mixed) {
      const reps = n >= 1000 ? 1 : Math.min(2, repeats);
      const rs: Any[] = [];
      for (let r = 0; r < reps; r++) rs.push(await run(fleet(n, 'circle', n), 3));
      const row = { n, kind: 'circle+people', people: n, seconds: 3, repeats: reps, ...agg(rs), load: os.loadavg().map((v) => +v.toFixed(1)) };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    // Micro-benchmark of the parts of one vehicle step.
    const geo = vehicleGeometry({ variant: 'sedan', length: 4.5, width: 1.8, height: 1.45 }, 1409);
    const st = newVehicleState();
    const hits: WheelHit[] = geo.mounts.map((m) => ({ toi: geo.freeLength[0] + 0.31 - 0.12, point: [m[0], 0, m[2]] as Vec3, normal: [0, 1, 0] as Vec3, surfaceVel: [0, 0, 0] as Vec3, mu: 0.9, crr: 0.012 }));
    const kin = { pos: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as const, v: [15, 0, 0.3] as Vec3, w: [0, 0.05, 0] as Vec3, com: geo.com };
    const ctl = { ...neutralControls(), throttle: 0.5, steer: 0.2 };
    const N = 20000;
    const time = (f: () => void) => { const t0 = performance.now(); for (let i = 0; i < N; i++) f(); return +(((performance.now() - t0) / N) * 1e6).toFixed(0); };
    const tf = { fx: 0, fy: 0, sliding: false, phi: 0 };
    const tire = { k: 0.02, a: 0.01 };
    const micro = {
      micro: true,
      tireForceNs: time(() => tireForce('saturating', 2000, -1500, 3500, 0.9, tf)),
      implicitSpinNs: time(() => { tire.k = 0.02; implicitSpin(tire, 48, 15, 0.31, 0.9, 300, 56000, 0, 1 / 480); }),
      vehicleStepNs: time(() => stepVehicle(geo, st, kin, hits, ctl, { model: 'saturating', drive: 'fwd', substeps: 8, abs: true, g: 9.81, driveAvail: 1, steerAvail: 1, brakeAvail: 1 }, 1 / 60)),
    };
    rows.push(micro);
    console.log(JSON.stringify(micro));
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, ncpu: os.cpus().length, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});

/** Long runs (spec §82): 1 s steps; every 60 s: NaN, extreme speed / spin, energy residual, episodes / events growth, heap. */
describe.skipIf(!process.env.BENCH || !process.env.LONG)('vehicle long runs', () => {
  it('long', { timeout: 28_800_000 }, async () => {
    const T = +process.env.LONG!;
    const loopPath: [number, number][] = [[0, 0], [60, 0], [60, 40], [0, 40], [0, 0]];
    const shore = (_x: number, z: number) => Math.min(4, Math.max(0, (85 - z) * 0.1));
    const slope = (x: number) => Math.max(0, Math.min(6, (20 - x) * Math.tan((8 * Math.PI) / 180)));
    // Repeated braking that stays in the world: 5 s forward, brake, 5 s in reverse, brake (a 20 s cycle about the start).
    const brakes: { t: number; throttle?: number; brake?: number; gear?: 'D' | 'R' }[] = [];
    for (let t = 0; t < T && brakes.length < 990; t += 20) brakes.push({ t, gear: 'D', throttle: 0.5, brake: 0 }, { t: t + 5, throttle: 0, brake: 0.8 }, { t: t + 10, gear: 'R', throttle: 0.5, brake: 0 }, { t: t + 15, throttle: 0, brake: 0.8 });
    const scenes: Record<string, () => { doc: WorldDocument; events: EventSpec[] }> = {
      stationary: () => ({ doc: mk([car(0, 0, 1), car(10, 0, 2)], () => ({})), events: [] }),
      straight: () => ({ doc: mk([car(0, 0, 1)], () => ({ autopilot: { path: loopPath, speed: 12, loop: true, avoid: false } })), events: [] }),
      braking: () => ({ doc: mk([car(-100, 0, 1)], () => ({ program: brakes.slice(0, 1000) })), events: [] }),
      circle: () => ({ doc: mk([car(0, 0, 1)], () => ({ controls: { gear: 'D', throttle: 0.2, steer: 0.5 } })), events: [] }),
      slope: () => ({ doc: mk([car(0, 0, 1), car(8, 6, 2)], (i) => (i === 0 ? {} : { program: [{ t: 0, gear: 'D' }, { t: 5, throttle: 0.3 }, { t: 30, throttle: 0, brake: 1 }] }), slope), events: [] }),
      wind: () => ({ doc: mk([car(0, 0, 1)], () => ({ autopilot: { path: loopPath, speed: 10, loop: true, avoid: false } })), events: [{ event: 'wind', speed: 28, direction: 'E', duration: T, gustStrength: 0.3, rampDuration: 10, startTime: 0 } as EventSpec] }),
      flood: () => ({ doc: mk([car(0, 95, 1), car(10, 92, 2)], () => ({}), shore), events: [{ event: 'risingWater', boundary: 'S', level: 1.2, riseRate: 1, duration: T, startTime: 0 } as EventSpec] }),
      earthquake: () => ({ doc: mk([car(0, 0, 1), car(10, 0, 2)], (i) => (i === 0 ? {} : { controls: { gear: 'D', throttle: 0.2, steer: 0.5 } })), events: [{ event: 'earthquake', magnitude: 7, pga: 0.6, duration: 30, seed: 4, startTime: 5 } as unknown as EventSpec] }),
      crashDebris: () => ({ doc: mk([car(0, 0, 1), car(30, 0, 2, Math.PI)], () => ({ controls: { gear: 'D', throttle: 0.8 } })), events: [] }),
      combined: () => ({ doc: mk([car(0, 0, 1), car(10, -30, 2), person(5, -25, 3)], (i) => (i === 0 ? { autopilot: { path: loopPath, speed: 10, loop: true, avoid: true } } : {})), events: [
        { event: 'wind', speed: 20, direction: 'E', duration: T, gustStrength: 0.3, rampDuration: 10, startTime: 0 } as EventSpec,
        { event: 'earthquake', magnitude: 6.5, pga: 0.4, duration: 20, seed: 5, startTime: 60 } as unknown as EventSpec,
      ] }),
    };
    function mk(objs: DemoObject[], cfg: (i: number) => VehicleCar, height?: (x: number, z: number) => number): WorldDocument {
      const doc = buildWorld({ objects: objs, seed: 3510, name: 'long35', height });
      const ids = Object.values(doc.objects).filter((o) => o.type === 'car').map((o) => o.id);
      doc.settings.simulation.vehicles = { model: 'dynamics', cars: Object.fromEntries(ids.map((id, i) => [id, cfg(i)])) };
      return doc;
    }
    const only = process.env.LONG_SCENES?.split(',');
    const rows: Any[] = [];
    for (const [name, mkScene] of Object.entries(scenes)) {
      if (only && !only.includes(name)) continue;
      const { doc, events } = mkScene();
      const c = new SimulationController({ headless: true });
      await c.load(doc);
      for (const e of events) c.addEvent(e);
      const checks: Any[] = [];
      const t0 = performance.now();
      for (let t = 0; t < T; t++) {
        c.advance(1);
        if ((t + 1) % 60 === 0) {
          const cars = [...c.getRuntime()!.entities.values()].filter((e) => e.vehicle);
          const P = c.getPhysics()!;
          const live = cars.filter((e) => e.body !== null && P.hasBody(e.body));
          checks.push({
            t: t + 1,
            nonFinite: live.some((e) => !e.pose.position.every(Number.isFinite) || !e.vehicle!.dyn.wheels.every((w) => Number.isFinite(w.omega) && Number.isFinite(w.Fz))),
            maxSpeed: +Math.max(0, ...live.map((e) => Math.hypot(...P.getLinearVelocity(e.body!)))).toFixed(2),
            maxSpin: +Math.max(0, ...live.map((e) => Math.hypot(...P.getAngularVelocity(e.body!)))).toFixed(2),
            maxWheel: +Math.max(0, ...live.map((e) => Math.max(...e.vehicle!.dyn.wheels.map((w) => Math.abs(w.omega))))).toFixed(1),
            residual: +Math.max(0, ...live.map((e) => Math.abs(e.vehicle!.energy.residual))).toExponential(2),
            // Residual relative to the work done on the car (drive + |losses|) — the ledger's closure in relative terms.
            residualShare: +Math.max(0, ...live.map((e) => { const L = e.vehicle!.dyn.ledger; const scale = L.drive + L.brake + L.rolling + L.slip + L.damper + L.aero + e.vehicle!.energy.collision; return scale > 1e3 ? Math.abs(e.vehicle!.energy.residual) / scale : 0; })).toExponential(2),
            outside: live.some((e) => Math.abs(e.pose.position[0]) > 700 || Math.abs(e.pose.position[2]) > 700),
            episodes: cars.reduce((a, e) => a + e.vehicle!.episodes.length + e.vehicle!.open.size, 0),
            events: c.getDamageEvents().length,
            series: cars.reduce((a, e) => a + (e.vehicle!.series?.t.length ?? 0), 0),
            duplicates: c.duplicateForces(),
            heapMB: heapMB(),
          });
        }
      }
      const ms = performance.now() - t0;
      await c.reset();
      c.unload();
      const bad = checks.filter((x) => x.nonFinite || x.outside || x.maxSpeed > 100 || x.maxSpin > 50 || x.maxWheel > 400).map((x) => x.t);
      const row = { scene: name, seconds: T, wallS: +(ms / 1000).toFixed(1), bad, first: checks[0], last: checks[checks.length - 1], eventsAt: checks.map((x) => x.events).filter((_, i) => i % 10 === 9), heapAt: checks.map((x) => x.heapMB).filter((_, i) => i % 10 === 9) };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
