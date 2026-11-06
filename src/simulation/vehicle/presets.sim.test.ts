/**
 * Phase 35: the 32 vehicle presets run headless. Every preset builds its own world (vehicle dynamics on, fixed seed), runs
 * step by step (1/60 s), stays finite (body poses / velocities / angular velocities, wheel states, people), is deterministic
 * (a second run of the same document gives bit-identical cars at a check time), records its events once per transition (no
 * duplicate object / time / type, rollover and collision events bounded per car, no duplicate force paths) and shows its
 * expected phenomenon. The bounds come from hand formulas (braking distance with drag, d = v₀² / 2a on a slope, circle
 * a_y = v² / R, Ackermann radius, traction-limited acceleration μ_s ΣF_z,driven, tan θ vs μ, ΣF_z = m g, momentum) whose
 * inputs are the documented model parameters (params.ts: tyre μ per ground type, C_rr, C_d, wheel inertia) — not the
 * numbers of a previous run.
 *
 * Known core defects (src/vehicle, src/simulation/vehicle) found with these presets are written as `it.fails` tests at the
 * end (they pass while the defect is present and will flag when it is fixed): D1 ABS stops longer than locked wheels on dry
 * asphalt; D2 a locked-wheel stop rebounds backwards; D3 a braked car creeps down a slope it should hold; D4 a car slid
 * sideways is pulled back by its stored tyre deflection. See ~/projects/disaster-sim-work/phase35/helperC-report.md.
 *
 * Run time: most presets cost ≈ 0.02–0.3 s of wall time per simulated second; the climate presets (icy / snowy road) and the
 * earthquake / wind presets more. Determinism is checked over the first DET s (8 s; 10 s for the icy road).
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { SimulationController } from '@/simulation/SimulationController';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { Vec3 } from '@/core/types';
import { forcesAt } from '@/simulation/forces/ForceLedger';
import { VEHICLE_PRESETS, VEHICLE_PRESET_FIELDS, VEHICLE_SECONDS, vehiclePreset, type VehiclePresetId } from '@/vehicle/presets';
import {
  BLAST, CIRCLE_R, CIRCLE_V, FLOOD_LEVEL, ICE_RAIN, MOON_G, ROLL_SHARE, SLALOM, SLOPE, SNOW_DEPTH, T_BRAKE, WET_FILM, slalomGates, tipAngleSedan,
} from '@/vehicle/demos';
import { AIR_DENSITY, TIRE, VARIANTS } from '@/vehicle/params';
import { tireMu, WET_DEPTH } from '@/vehicle/surface';
import { rotate } from '@/vehicle/dynamics';
import { SURF } from '@/climate/surfaceState';
import { EJECT_DV, ROLL_HOLD } from './VehicleMonitorSystem';
import type { CollisionEpisode } from './state';
import { koVehiclePresets } from '@/i18n/locales/ko.vehiclePresets';
import { enVehiclePresets } from '@/i18n/locales/en.vehiclePresets';

const g = 9.80665;
const DT = 1 / 60;
const DEG = Math.PI / 180;
const MU = { asphalt: TIRE.muGround[3], mud: TIRE.muGround[7] };
const slide = (mu: number) => TIRE.slideShare * mu;

interface CarSample { p: Vec3; v: Vec3; w: Vec3; up: Vec3; fwd: Vec3; Fz: number[]; touching: number; kappa: number[]; locked: boolean[]; accel: Vec3; roll: string; F: Record<string, number> }
interface Sample { t: number; cars: CarSample[] }
interface Run {
  id: VehiclePresetId;
  c: SimulationController;
  cars: RuntimeEntity[];
  people: RuntimeEntity[];
  samples: Sample[];
  episodes: CollisionEpisode[][];
  snap: string;
  T: number;
}

const DET: Partial<Record<VehiclePresetId, number>> = { icyRoad: 10 };
const detTime = (id: VehiclePresetId, T: number) => Math.min(T, DET[id] ?? 8);
const v3 = (a: readonly number[]): Vec3 => [a[0], a[1], a[2]];
const finite = (xs: readonly number[]) => xs.every(Number.isFinite);
const hyp = (a: readonly number[]) => Math.hypot(a[0], a[2]);
const sumFz = (s: CarSample) => s.Fz.reduce((a, b) => a + b, 0);

async function load(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const ofType = (c: SimulationController, type: string) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === type);
const snapOf = (c: SimulationController, cars: RuntimeEntity[], people: RuntimeEntity[]) => JSON.stringify([
  cars.map((e) => [e.pose.position, c.getPhysics()!.getLinearVelocity(e.body!), c.getPhysics()!.getAngularVelocity(e.body!), e.vehicle!.dyn.wheels.map((w) => [w.omega, w.Fz, w.Fx, w.Fy])]),
  people.map((e) => e.pose.position),
]);

function sampleCar(c: SimulationController, e: RuntimeEntity): CarSample {
  const ph = c.getPhysics()!, v = e.vehicle!;
  const alive = e.body !== null && ph.hasBody(e.body);
  const q = alive ? ph.getPose(e.body!).quaternion : e.pose.quaternion;
  const f = forcesAt(e, c.getStep() - 1) as unknown as Record<string, number>;
  return {
    p: v3(e.pose.position), v: alive ? v3(ph.getLinearVelocity(e.body!)) : [0, 0, 0], w: alive ? v3(ph.getAngularVelocity(e.body!)) : [0, 0, 0],
    up: rotate(q, [0, 1, 0]), fwd: rotate(q, [1, 0, 0]),
    Fz: v.dyn.wheels.map((W) => W.Fz), touching: v.dyn.touching, kappa: v.dyn.wheels.map((W) => W.kappa), locked: v.dyn.wheels.map((W) => W.locked),
    accel: v3(v.accel), roll: v.rollover, F: { ...f },
  };
}

function checkFinite(id: string, r: { c: SimulationController; cars: RuntimeEntity[]; people: RuntimeEntity[] }, s: Sample) {
  for (const [k, cs] of s.cars.entries()) {
    const W = r.cars[k].vehicle!.dyn.wheels;
    const vals = [...cs.p, ...cs.v, ...cs.w, ...cs.accel, ...W.flatMap((w) => [w.omega, w.Fz, w.Fx, w.Fy, w.kappa, w.alpha, w.compression, w.rate, ...w.force])];
    expect(finite(vals), `${id} car ${k} finite at t=${s.t.toFixed(3)}`).toBe(true);
  }
  for (const h of r.people) expect(finite(h.pose.position), `${id} person finite at t=${s.t.toFixed(3)}`).toBe(true);
}

async function run(id: VehiclePresetId): Promise<Run> {
  const p = vehiclePreset(id)!;
  const { doc, events } = p.build();
  const c = await load(doc, events);
  const cars = ofType(c, 'car').sort((a, b) => a.id.localeCompare(b.id));
  // Cars in the order of the scene's objects (the k-th car of the preset = the k-th car object of the document).
  const order = Object.values(doc.objects).filter((o) => o.type === 'car').map((o) => o.id);
  cars.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const people = ofType(c, 'human');
  const T = p.seconds, D = detTime(id, T);
  const samples: Sample[] = [];
  let snap = '';
  const n = Math.round(T / DT);
  for (let i = 1; i <= n; i++) {
    c.advance(DT);
    const s: Sample = { t: c.getTime(), cars: cars.map((e) => sampleCar(c, e)) };
    samples.push(s);
    if (i % 30 === 0 || i === n) checkFinite(id, { c, cars, people }, s);
    if (i === Math.round(D / DT)) snap = snapOf(c, cars, people);
  }
  return { id, c, cars, people, samples, episodes: cars.map((e) => structuredClone(e.vehicle!.episodes)), snap, T };
}

async function deterministic(r: Run) {
  const { doc, events } = vehiclePreset(r.id)!.build();
  const c = await load(doc, events);
  const order = Object.values(doc.objects).filter((o) => o.type === 'car').map((o) => o.id);
  const cars = ofType(c, 'car').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const D = detTime(r.id, r.T);
  for (let i = 1; i <= Math.round(D / DT); i++) c.advance(DT);
  expect(snapOf(c, cars, ofType(c, 'human')), `${r.id} deterministic at ${D} s`).toBe(r.snap);
  c.unload();
}

// ── helpers for the expectations ──
const at = (r: Run, t: number) => r.samples.find((s) => s.t >= t - 1e-9)!;
const between = (r: Run, t0: number, t1: number) => r.samples.filter((s) => s.t >= t0 - 1e-9 && s.t <= t1 + 1e-9);
const peak = (r: Run, k: number, src: string) => Math.max(0, ...r.samples.map((s) => s.cars[k].F[src] ?? 0));
const evs = (r: Run, type?: string, obj?: string) => r.c.getDamageEvents().filter((d) => (!type || d.eventType === type) && (!obj || d.objectId === obj));
const mass = (r: Run, k: number) => r.cars[k].vehicle!.geo.mass;
const dragK = (r: Run, k: number) => { const v = r.cars[k].vehicle!, s = v.geo.spec, d = v.geo.dims; return AIR_DENSITY * s.cd * d.width * d.height * s.areaFill; };
/** Locked-wheel stopping distance with air drag (flat): m / (ρ C_d A) ln(1 + ρ C_d A v₀² / (2 μ_s m g)). */
const lockedDistance = (m: number, k: number, v0: number, mus: number) => (m / k) * Math.log(1 + (k * v0 * v0) / (2 * mus * m * g));
/** Braking from tB: initial speed (m/s) and distance (m) along the initial velocity until the velocity along it first reaches 0. */
function stop(r: Run, k: number, tB: number) {
  const s0 = at(r, tB).cars[k];
  const v0 = Math.hypot(...s0.v);
  const d = s0.v.map((x) => x / v0);
  let dist = 0, tStop = NaN;
  for (const s of r.samples) {
    if (s.t <= tB + 1e-9) continue;
    const cs = s.cars[k];
    dist = Math.max(dist, (cs.p[0] - s0.p[0]) * d[0] + (cs.p[1] - s0.p[1]) * d[1] + (cs.p[2] - s0.p[2]) * d[2]);
    if (cs.v[0] * d[0] + cs.v[1] * d[1] + cs.v[2] * d[2] <= 0) { tStop = s.t; break; }
  }
  return { v0, d: dist, tStop, dir: d, p0: s0.p };
}
const decel = (x: { v0: number; d: number }) => (x.v0 * x.v0) / (2 * x.d);
/** Mean acceleration along +X between t0 and t1 (from the velocity samples). */
const accelX = (r: Run, k: number, t0: number, t1: number) => (at(r, t1).cars[k].v[0] - at(r, t0).cars[k].v[0]) / (t1 - t0);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Measured values for the report (written only when VEHICLE_PRESET_NOTES names a file). */
const note = (id: string, v: Record<string, unknown>) => { if (process.env.VEHICLE_PRESET_NOTES) appendFileSync(process.env.VEHICLE_PRESET_NOTES, JSON.stringify({ id, ...v }) + '\n'); };

const cache: Partial<Record<VehiclePresetId, Run>> = {};
const LANE_TOL = Number(process.env.LANE_TOL ?? 6);
const stops: Partial<Record<'dry' | 'wet' | 'ice' | 'snow', number>> = {};
const accels: Partial<Record<'fwd' | 'rwd' | 'awd', number>> = {};

/** Traction-limited acceleration with the driven wheels spinning (window means of the measured wheel loads). */
function tractionAccel(r: Run, driven: number[], t0: number, t1: number) {
  const W = between(r, t0, t1);
  const Fz = [0, 1, 2, 3].map((i) => mean(W.map((s) => s.cars[0].Fz[i])));
  const vm = mean(W.map((s) => s.cars[0].v[0]));
  const free = [0, 1, 2, 3].filter((i) => !driven.includes(i));
  const sp = r.cars[0].vehicle!.geo.spec;
  const F = slide(MU.mud) * driven.reduce((a, i) => a + Fz[i], 0) - TIRE.crrGround[7] * free.reduce((a, i) => a + Fz[i], 0) - 0.5 * dragK(r, 0) * vm * vm;
  return F / (mass(r, 0) + (free.length * sp.wheelInertia) / sp.wheelRadius ** 2);
}

const EXPECT: Record<VehiclePresetId, (r: Run) => void> = {
  stationary: (r) => {
    const e = r.cars[0], s = r.samples[r.samples.length - 1].cars[0];
    expect(Math.abs(sumFz(s) - mass(r, 0) * g) / (mass(r, 0) * g)).toBeLessThan(0.005);
    const L = e.vehicle!.geo.wheelbase, front = (e.vehicle!.geo.com[0] + L / 2) / L;
    expect((s.Fz[0] + s.Fz[1]) / sumFz(s)).toBeCloseTo(front, 2);
    expect(Math.hypot(s.p[0], s.p[2])).toBeLessThan(1e-3);
    expect(r.c.getDamageEvents()).toHaveLength(0);
    note('stationary', { sumFz_mg: sumFz(s) / (mass(r, 0) * g), front: (s.Fz[0] + s.Fz[1]) / sumFz(s), frontHand: front, disp: Math.hypot(s.p[0], s.p[2]) });
  },
  suspensionDrop: (r) => {
    const v = r.cars[0].vehicle!, sp = VARIANTS.sedan;
    const yEnd = r.samples[r.samples.length - 1].cars[0].p[1];
    const land = r.samples.findIndex((s) => s.cars[0].touching > 0);
    const ys = r.samples.slice(land).map((s) => ({ t: s.t, y: s.cars[0].p[1] - yEnd }));
    const cross: number[] = [];
    for (let i = 1; i < ys.length; i++) if (Math.sign(ys[i].y) !== Math.sign(ys[i - 1].y) && ys[i - 1].y !== 0) cross.push(ys[i - 1].t + (ys[i].t - ys[i - 1].t) * (ys[i - 1].y / (ys[i - 1].y - ys[i].y)));
    expect(cross.length).toBeGreaterThanOrEqual(3);
    const half = 1 / (2 * sp.rideHz * Math.sqrt(1 - sp.damping ** 2));
    note('suspensionDrop', { half: cross[2] - cross[1], halfHand: half });
    expect(Math.abs(cross[2] - cross[1] - half) / half).toBeLessThan(0.2);
    const s = r.samples[r.samples.length - 1].cars[0];
    expect(Math.abs(sumFz(s) - v.geo.mass * g) / (v.geo.mass * g)).toBeLessThan(0.01);
    const comp = mean(v.dyn.wheels.map((w) => w.compression)), stat = mean([...v.geo.staticCompression]);
    expect(Math.abs(comp - stat) / stat).toBeLessThan(0.05);
  },
  constantThrottle: (r) => {
    const v = r.cars[0].vehicle!, sp = VARIANTS.sedan, thr = 0.2;
    const a = at(r, 3).cars[0], b = at(r, 5).cars[0];
    const Tw = thr * sp.torque * sp.gears[0] * sp.final * sp.efficiency;
    const vm = (a.v[0] + b.v[0]) / 2;
    const ah = (Tw / sp.wheelRadius - TIRE.crrGround[3] * v.geo.mass * g - 0.5 * dragK(r, 0) * vm * vm) / (v.geo.mass + (4 * sp.wheelInertia) / sp.wheelRadius ** 2);
    const am = (b.v[0] - a.v[0]) / 2;
    note('constantThrottle', { a: am, aHand: ah });
    expect(Math.abs(am - ah) / ah).toBeLessThan(0.03);
    expect(Math.abs(b.p[0] - a.p[0] - (a.v[0] * 2 + 0.5 * am * 4)) / (b.p[0] - a.p[0])).toBeLessThan(0.02);
  },
  constantSpeed: (r) => {
    note('constantSpeed', { vMin: Math.min(...between(r, 6, 12).map((s) => hyp(s.cars[0].v))), vMax: Math.max(...between(r, 6, 12).map((s) => hyp(s.cars[0].v))), zMax: Math.max(...between(r, 6, 12).map((s) => Math.abs(s.cars[0].p[2]))) });
    for (const s of between(r, 6, 12)) {
      expect(Math.abs(hyp(s.cars[0].v) - 12)).toBeLessThan(0.3);
      expect(Math.abs(s.cars[0].p[2])).toBeLessThan(0.1);
    }
  },
  hardBraking: (r) => {
    const abs = stop(r, 0, T_BRAKE.hard), lock = stop(r, 1, T_BRAKE.hard);
    expect(lock.v0).toBeGreaterThan(9);
    const exp = lockedDistance(mass(r, 1), dragK(r, 1), lock.v0, slide(MU.asphalt));
    note('hardBraking', { v0: lock.v0, dLocked: lock.d, dHand: exp, dAbs: abs.d, dAbsMin: (0.95 * abs.v0 * abs.v0) / (2 * MU.asphalt * g) });
    expect(Math.abs(lock.d - exp) / exp).toBeLessThan(0.07);
    // ABS cannot beat the peak friction; its wheels keep turning while the locked car's do not.
    expect(abs.d).toBeGreaterThanOrEqual((0.95 * abs.v0 * abs.v0) / (2 * MU.asphalt * g));
    const allLocked = (k: number, tS: number) => { const W = between(r, T_BRAKE.hard + 0.2, tS).filter((s) => hyp(s.cars[k].v) > 1); return W.filter((s) => s.cars[k].locked.every(Boolean)).length / W.length; };
    expect(allLocked(0, abs.tStop)).toBeLessThan(0.2);
    expect(allLocked(1, lock.tStop)).toBeGreaterThan(0.8);
  },
  lowSpeedSteer: (r) => {
    const geo = r.cars[0].vehicle!.geo, delta = 0.5 * VARIANTS.sedan.steerMax;
    const b = geo.com[0] + geo.wheelbase / 2;
    const R = Math.hypot(geo.wheelbase / Math.tan(delta), b);
    const W = between(r, 8, 15);
    for (const s of W) expect(s.cars[0].w[1]).toBeGreaterThan(0);
    const Rm = mean(W.map((s) => hyp(s.cars[0].v) / s.cars[0].w[1]));
    expect(hyp(W[0].cars[0].v)).toBeLessThan(12);
    note('lowSpeedSteer', { R: Rm, RHand: R });
    expect(Math.abs(Rm - R) / R).toBeLessThan(0.05);
  },
  highSpeedSteer: (r) => {
    const geo = r.cars[0].vehicle!.geo;
    expect(geo.track / (2 * geo.hcg)).toBeGreaterThan(MU.asphalt);
    const after = between(r, 4.5, r.T);
    expect(Math.max(...after.map((s) => Math.abs(s.cars[0].accel[2])))).toBeLessThanOrEqual(1.05 * MU.asphalt * g);
    const Rm = mean(between(r, 7, 10).map((s) => hyp(s.cars[0].v) / Math.abs(s.cars[0].w[1])));
    const vm = mean(between(r, 7, 10).map((s) => hyp(s.cars[0].v)));
    const delta = 0.5 * VARIANTS.sedan.steerMax * Math.min(1, 12 / vm);
    note('highSpeedSteer', { R: Rm, RKin: geo.wheelbase / Math.tan(delta), ayMax: Math.max(...after.map((s) => Math.abs(s.cars[0].accel[2]))), muG: MU.asphalt * g });
    expect(Rm).toBeGreaterThan((1.3 * geo.wheelbase) / Math.tan(delta));
    for (const s of r.samples) expect(s.cars[0].roll).toBe('upright');
  },
  circle: (r) => {
    const W = between(r, 10, r.T);
    // Window means: a_y = v r (kinematics of the steady turn) within 5 %; per sample within 10 % (polygon path corners).
    const ayM = mean(W.map((s) => Math.abs(s.cars[0].accel[2]))), vrM = mean(W.map((s) => hyp(s.cars[0].v) * Math.abs(s.cars[0].w[1])));
    expect(Math.abs(ayM - vrM) / ayM).toBeLessThan(0.05);
    note('circle', { ay: ayM, v2R: mean(W.map((s) => hyp(s.cars[0].v) ** 2 / CIRCLE_R)), vr: vrM });
    for (const s of W) {
      const cs = s.cars[0], v = hyp(cs.v), ay = Math.abs(cs.accel[2]);
      expect(Math.abs(ay - (v * v) / CIRCLE_R) / ((v * v) / CIRCLE_R)).toBeLessThan(0.1);
      expect(Math.abs(ay - v * Math.abs(cs.w[1])) / ay).toBeLessThan(0.1);
      expect(ay).toBeLessThan(MU.asphalt * g);
      expect(Math.abs(hyp(cs.p) - CIRCLE_R)).toBeLessThan(1.5);
      expect(Math.abs(v - CIRCLE_V)).toBeLessThan(0.5);
    }
  },
  slalom: (r) => {
    const miss: number[] = [];
    for (const [gx, gz] of slalomGates()) {
      const i = r.samples.findIndex((s) => s.cars[0].p[0] >= gx);
      expect(i, `gate ${gx}`).toBeGreaterThan(0);
      const a = r.samples[i - 1].cars[0].p, b = r.samples[i].cars[0].p;
      const z = a[2] + ((b[2] - a[2]) * (gx - a[0])) / (b[0] - a[0]);
      miss.push(Math.abs(z - gz));
      expect(Math.abs(z - gz), `gate ${gx}`).toBeLessThan(1.2);
    }
    note('slalom', { maxGateMiss: Math.max(...miss), ayMax: Math.max(...r.samples.map((s) => Math.abs(s.cars[0].accel[2]))) });
    for (const s of r.samples) {
      expect(Math.abs(s.cars[0].accel[2])).toBeLessThanOrEqual(MU.asphalt * g);
      expect(s.cars[0].roll).toBe('upright');
    }
    expect(SLALOM.n).toBe(slalomGates().length);
  },
  fwd: (r) => {
    const a = accelX(r, 0, 2, 6), ah = tractionAccel(r, [0, 1], 2, 6);
    expect(Math.abs(a - ah) / ah).toBeLessThan(0.1);
    const W = between(r, 2, 6);
    expect(mean(W.map((s) => s.cars[0].kappa[0]))).toBeGreaterThan(0.3);
    expect(Math.abs(mean(W.map((s) => s.cars[0].kappa[2])))).toBeLessThan(0.1);
    accels.fwd = a;
    note('fwd', { a, aHand: ah });
  },
  rwd: (r) => {
    const a = accelX(r, 0, 2, 6), ah = tractionAccel(r, [2, 3], 2, 6);
    expect(Math.abs(a - ah) / ah).toBeLessThan(0.1);
    const W = between(r, 2, 6);
    expect(mean(W.map((s) => s.cars[0].kappa[2]))).toBeGreaterThan(0.3);
    expect(Math.abs(mean(W.map((s) => s.cars[0].kappa[0])))).toBeLessThan(0.1);
    accels.rwd = a;
    note('rwd', { a, aHand: ah });
    if (accels.fwd !== undefined) expect(a).toBeGreaterThan(accels.fwd);
  },
  awd: (r) => {
    const a = accelX(r, 0, 2, 6);
    expect(a).toBeLessThanOrEqual(MU.mud * g);
    accels.awd = a;
    note('awd', { a, muG: MU.mud * g });
    if (accels.rwd !== undefined) expect(a).toBeGreaterThan(accels.rwd);
    if (accels.fwd !== undefined) expect(a).toBeGreaterThan(accels.fwd);
  },
  dryAsphalt: (r) => {
    const s = stop(r, 0, T_BRAKE.dry);
    const exp = lockedDistance(mass(r, 0), dragK(r, 0), s.v0, slide(tireMu(3, null, 0)));
    expect(Math.abs(s.d - exp) / exp).toBeLessThan(0.07);
    stops.dry = decel(s);
    note('dryAsphalt', { v0: s.v0, d: s.d, dHand: exp });
  },
  wetRoad: (r) => {
    const s = stop(r, 0, T_BRAKE.wet);
    const depth = r.c.getEnvironment().flood.field!.sampleDepth(s.p0[0], s.p0[2]);
    expect(depth).toBeGreaterThanOrEqual(WET_DEPTH);
    expect(depth).toBeLessThan(2 * WET_FILM);
    const mu = tireMu(3, null, depth);
    expect(mu).toBeCloseTo(MU.asphalt * 0.5 / 0.7, 6);
    const exp = lockedDistance(mass(r, 0), dragK(r, 0), s.v0, slide(mu));
    expect(Math.abs(s.d - exp) / exp).toBeLessThan(0.07);
    stops.wet = decel(s);
    note('wetRoad', { v0: s.v0, d: s.d, dHand: exp, depth, mu });
    if (stops.dry !== undefined) expect(stops.wet).toBeLessThan(stops.dry);
  },
  icyRoad: (r) => {
    const tB = ICE_RAIN + T_BRAKE.ice;
    const s = stop(r, 0, tB);
    const cover = r.c.getEnvironment().climate.rt!.coverAt(s.p0[0], s.p0[2], 0)!;
    expect([SURF.ice, SURF.wetIce]).toContain(cover.state);
    const exp = lockedDistance(mass(r, 0), dragK(r, 0), s.v0, slide(tireMu(3, cover, 0)));
    expect(Math.abs(s.d - exp) / exp).toBeLessThan(0.08);
    stops.ice = decel(s);
    note('icyRoad', { v0: s.v0, d: s.d, dHand: exp, state: cover.state, ice: cover.ice, mu: tireMu(3, cover, 0) });
    if (stops.wet !== undefined) expect(stops.ice).toBeLessThan(stops.wet);
  },
  snowyRoad: (r) => {
    const s = stop(r, 0, T_BRAKE.snow);
    const cover = r.c.getEnvironment().climate.rt!.coverAt(s.p0[0], s.p0[2], 0)!;
    expect([SURF.snow, SURF.packed]).toContain(cover.state);
    expect(cover.snowDepth).toBeGreaterThan(0.5 * SNOW_DEPTH);
    const exp = lockedDistance(mass(r, 0), dragK(r, 0), s.v0, slide(tireMu(3, cover, 0)));
    expect(Math.abs(s.d - exp) / exp).toBeLessThan(0.08);
    stops.snow = decel(s);
    note('snowyRoad', { v0: s.v0, d: s.d, dHand: exp, state: cover.state, depth: cover.snowDepth, mu: tireMu(3, cover, 0) });
    // Deceleration order of the four surfaces: dry > wet > snow > ice.
    if (stops.dry && stops.wet && stops.ice) {
      expect(stops.dry).toBeGreaterThan(stops.wet);
      expect(stops.wet).toBeGreaterThan(stops.snow);
      expect(stops.snow).toBeGreaterThan(stops.ice);
    }
  },
  slopeHold: (r) => {
    const th = SLOPE.hold * DEG;
    expect(Math.tan(th)).toBeLessThan(MU.asphalt);
    expect(Math.tan(th)).toBeGreaterThan(MU.mud);
    // Mud: slides at g (sin θ − μ_s cos θ).
    const aMud = (Math.hypot(...at(r, 10).cars[1].v) - Math.hypot(...at(r, 4).cars[1].v)) / 6;
    const ah = g * (Math.sin(th) - slide(MU.mud) * Math.cos(th));
    expect(Math.abs(aMud - ah) / ah).toBeLessThan(0.1);
    // Asphalt: the friction balances the slope (no acceleration) — the creep itself is defect D3 (below).
    const aAsp = (Math.hypot(...at(r, 12).cars[0].v) - Math.hypot(...at(r, 4).cars[0].v)) / 8;
    expect(Math.abs(aAsp)).toBeLessThan(0.05);
    note('slopeHold', { aMud, aHand: ah, aAsphalt: aAsp, creepAsphalt: hyp(at(r, 12).cars[0].v) });
  },
  slopeStart: (r) => {
    const th = SLOPE.start * DEG, geo = r.cars[1].vehicle!.geo;
    const x0 = r.samples[0].cars.map((c) => c.p[0]), x1 = r.samples[r.samples.length - 1].cars.map((c) => c.p[0]);
    // Uphill is −X: asphalt climbs, mud slides back (hand check: μ_peak × front share × cos θ < sin θ).
    expect((x0[0] - x1[0]) / Math.cos(th)).toBeGreaterThan(10);
    expect(MU.mud * geo.frontShare * Math.cos(th)).toBeLessThan(Math.sin(th));
    expect(MU.asphalt * geo.frontShare * Math.cos(th)).toBeGreaterThan(Math.sin(th));
    expect(x1[1]).toBeGreaterThan(x0[1]);
    note('slopeStart', { climbAsphalt: (x0[0] - x1[0]) / Math.cos(th), mudBack: (x1[1] - x0[1]) / Math.cos(th) });
  },
  slopeBrake: (r) => {
    const th = SLOPE.brake * DEG;
    const s = stop(r, 0, 7);
    expect(s.v0).toBeGreaterThan(8);
    const exp = (s.v0 * s.v0) / (2 * g * (slide(MU.asphalt) * Math.cos(th) - Math.sin(th)));
    note('slopeBrake', { v0: s.v0, d: s.d, dHand: exp });
    expect(Math.abs(s.d - exp) / exp).toBeLessThan(0.07);
  },
  rollover: (r) => {
    const v = r.cars[0].vehicle!;
    // Static reference: the tilt is below the static tip angle (rigid LTR 2h tan θ / t < 1); the tip is dynamic.
    const th = ROLL_SHARE * tipAngleSedan();
    expect((2 * v.geo.hcg * Math.tan(th)) / v.geo.track).toBeLessThan(1);
    const roll = evs(r, 'VEHICLE_ROLLOVER', r.cars[0].id);
    note('rollover', { events: roll.map((e) => [e.time, (e as { vehicle?: { level?: string } }).vehicle?.level]), ltrRigid: (2 * v.geo.hcg * Math.tan(th)) / v.geo.track });
    expect(roll.some((e) => e.time >= 1 && e.time <= 5 && ['onSide', 'onRoof'].includes((e as { vehicle?: { level?: string } }).vehicle?.level ?? ''))).toBe(true);
  },
  frontalCrash: (r) => {
    const v = r.cars[0].vehicle!;
    const ep = r.episodes[0].find((x) => x.partnerKind === 'structure')!;
    expect(ep).toBeTruthy();
    expect(ep.closing).toBeGreaterThan(7);
    expect(ep.dv).toBeGreaterThan(0.6 * ep.closing);
    expect(ep.dv).toBeLessThan(2 * ep.closing);
    expect(v.damage.level).not.toBe('intact');
    const [drv, pas] = v.occupants;
    expect(drv.state).toBe('seated');
    const hard = r.episodes[0].some((x) => x.dv >= EJECT_DV);
    note('frontalCrash', { closing: ep.closing, dv: ep.dv, damage: v.damage.level, passenger: pas.state });
    expect(pas.state === 'ejected').toBe(hard);
    expect(evs(r, 'OCCUPANT_EJECTED').length).toBeLessThanOrEqual(1);
  },
  sideCrash: (r) => {
    const [A, B] = r.cars;
    const a = r.episodes[0].find((x) => x.partner === B.id)!, b = r.episodes[1].find((x) => x.partner === A.id)!;
    expect(a && b).toBeTruthy();
    const J = Math.hypot(...a.impulse);
    expect(Math.hypot(a.impulse[0] + b.impulse[0], a.impulse[1] + b.impulse[1], a.impulse[2] + b.impulse[2])).toBeLessThan(0.05 * J);
    const mA = mass(r, 0), mB = mass(r, 1);
    const dp = mA * (a.vAfter[0] - a.vBefore[0]) + mB * (b.vAfter[0] - b.vBefore[0]);
    expect(Math.abs(dp)).toBeLessThan(0.1 * mA * Math.abs(a.vBefore[0]));
    expect(b.vAfter[0] - b.vBefore[0]).toBeGreaterThan(0.5);
    note('sideCrash', { J, Jsum: Math.hypot(a.impulse[0] + b.impulse[0], a.impulse[2] + b.impulse[2]), dp, pA: mA * a.vBefore[0], dvB: b.vAfter[0] - b.vBefore[0] });
  },
  carToCar: (r) => {
    const [A, B] = r.cars;
    const a = r.episodes[0].find((x) => x.partner === B.id)!, b = r.episodes[1].find((x) => x.partner === A.id)!;
    expect(a && b).toBeTruthy();
    const mA = mass(r, 0), mB = mass(r, 1);
    expect(mA).toBeGreaterThan(mB);
    const p0 = mA * a.vBefore[0] + mB * b.vBefore[0], p1 = mA * a.vAfter[0] + mB * b.vAfter[0];
    expect(Math.abs(p1 - p0)).toBeLessThan(0.05 * (mA * Math.abs(a.vBefore[0]) + mB * Math.abs(b.vBefore[0])));
    const ratio = Math.abs(b.vAfter[0] - b.vBefore[0]) / Math.abs(a.vAfter[0] - a.vBefore[0]);
    note('carToCar', { p0, p1, ratio, massRatio: mA / mB });
    expect(Math.abs(ratio - mA / mB) / (mA / mB)).toBeLessThan(0.1);
  },
  carToWall: (r) => {
    const ep = r.episodes[0].find((x) => x.partnerKind === 'structure')!;
    expect(ep).toBeTruthy();
    // The wall runs along Z: its normal is X.
    expect(Math.abs(ep.impulse[0])).toBeGreaterThan(Math.abs(ep.impulse[2]));
    expect(ep.vBefore[2]).toBeGreaterThan(1);
    expect(ep.vAfter[2]).toBeGreaterThan(0.3 * ep.vBefore[2]);
    note('carToWall', { J: ep.impulse, vBefore: ep.vBefore, vAfter: ep.vAfter });
  },
  carToPerson: (r) => {
    const [h0, h1] = r.people;
    const hit = r.c.getDamageEvents().filter((e) => e.objectId === h0.id && (e.eventType === 'IMPACT' || e.eventType === 'INJURED'));
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.some((e) => e.hazard === 'vehicle' || (e as { human?: { partner?: string } }).human?.partner === r.cars[0].id)).toBe(true);
    expect(r.c.getDamageEvents().filter((e) => e.objectId === h1.id && (e.eventType === 'IMPACT' || e.eventType === 'INJURED'))).toHaveLength(0);
    const keys = r.c.getDamageEvents().filter((e) => e.objectType === 'human').map((e) => `${e.objectId}|${e.time}|${e.eventType}|${e.componentId ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    note('carToPerson', { events: hit.map((e) => [e.time, e.eventType, e.hazard]) });
  },
  crosswind: (r) => {
    const e = r.cars[1], s = at(r, 8).cars[1];
    const w = e.localWind.velocity, d = e.vehicle!.geo.dims, sp = VARIANTS.sedan, W = Math.hypot(w[0], w[1], w[2]);
    // Parked (v ≈ 0): front / side components of the local wind on the frontal / side areas.
    const fx = 0.5 * AIR_DENSITY * sp.cd * d.width * d.height * sp.areaFill * W * w[0];
    const fz = 0.5 * AIR_DENSITY * sp.cy * d.length * d.height * sp.areaFill * W * w[2];
    expect(Math.abs(s.F.wind - Math.hypot(fx, fz)) / Math.hypot(fx, fz)).toBeLessThan(0.05);
    expect(Math.hypot(s.p[0], s.p[2] + 20)).toBeLessThan(0.05);
    // The moving car drifts downwind (sign of the wind's z component).
    const dz = r.samples[r.samples.length - 1].cars[0].p[2] - r.samples[0].cars[0].p[2];
    expect(Math.sign(dz)).toBe(Math.sign(w[2]));
    expect(Math.abs(dz)).toBeGreaterThan(1);
    note('crosswind', { F: s.F.wind, FHand: Math.hypot(fx, fz), drift: dz });
  },
  earthquake: (r) => {
    note('earthquake', { gm: [peak(r, 0, 'groundMotion'), peak(r, 1, 'groundMotion')], m: mass(r, 0), laneMax: Math.max(...r.samples.map((s) => Math.abs(s.cars[1].p[2] - 10))) });
    for (const k of [0, 1]) expect(peak(r, k, 'groundMotion')).toBeGreaterThan(0);
    // The d'Alembert force is m |a_g|: on the scale of m g × PGA (0.35 g horizontal, vertical ½ of it) — the event's pga is in g.
    for (const k of [0, 1]) expect(peak(r, k, 'groundMotion')).toBeLessThan(0.6 * mass(r, k) * g);
    for (const s of r.samples) {
      for (const cs of s.cars) expect(cs.roll).toBe('upright');
      expect(Math.abs(s.cars[1].p[2] - 10)).toBeLessThan(LANE_TOL);
    }
  },
  flood: (r) => {
    const mg = (k: number) => mass(r, k) * g;
    // Deep car while it still stands: wheels + water carry the weight.
    const stand = r.samples.filter((s) => s.cars[0].touching === 4 && (s.cars[0].F.water ?? 0) > 0.1 * mg(0));
    expect(stand.length).toBeGreaterThan(0);
    for (const s of stand) expect(Math.abs(sumFz(s.cars[0]) + s.cars[0].F.water - mg(0)) / mg(0)).toBeLessThan(0.05);
    // It floats (no wheel touches) and the engine stalls.
    expect(r.samples.some((s) => s.t > 10 && s.cars[0].touching === 0)).toBe(true);
    expect(evs(r, 'VEHICLE_STALLED', r.cars[0].id).length).toBe(1);
    // The bank car stands in shallower water: smaller buoyancy share, still on its wheels.
    const last = r.samples[r.samples.length - 1].cars;
    expect(last[1].touching).toBe(4);
    expect(Math.abs(sumFz(last[1]) + (last[1].F.water ?? 0) - mg(1)) / mg(1)).toBeLessThan(0.05);
    expect(peak(r, 1, 'water') / mg(1)).toBeLessThan(peak(r, 0, 'water') / mg(0));
    expect(FLOOD_LEVEL).toBeGreaterThan(1);
    note('flood', { standMaxErr: Math.max(...stand.map((s) => Math.abs(sumFz(s.cars[0]) + s.cars[0].F.water - mg(0)) / mg(0))), floatAt: r.samples.find((s) => s.t > 10 && s.cars[0].touching === 0)?.t, stall: evs(r, 'VEHICLE_STALLED', r.cars[0].id)[0]?.time, share: [peak(r, 0, 'water') / mg(0), peak(r, 1, 'water') / mg(1)] });
  },
  debrisFlow: (r) => {
    expect(peak(r, 0, 'sediment')).toBeGreaterThan(0);
    expect(peak(r, 1, 'sediment')).toBe(0);
    const a = r.samples[0].cars[0].p, b = r.samples[r.samples.length - 1].cars[0].p;
    expect(Math.hypot(b[0] - a[0], b[2] - a[2])).toBeGreaterThan(0.5);
    note('debrisFlow', { sediment: peak(r, 0, 'sediment'), moved: Math.hypot(b[0] - a[0], b[2] - a[2]) });
    const f = r.samples[r.samples.length - 1].cars[1].p;
    expect(Math.hypot(f[0] - 8, f[2] - 40)).toBeLessThan(0.05);
  },
  blast: (r) => {
    for (const k of [0, 1]) expect(peak(r, k, 'blast')).toBeGreaterThan(0);
    const vmax = (k: number) => Math.max(...between(r, 1, r.T).map((s) => hyp(s.cars[k].v)));
    expect(vmax(0)).toBeGreaterThan(vmax(1));
    note('blast', { F: [peak(r, 0, 'blast'), peak(r, 1, 'blast')], vmax: [vmax(0), vmax(1)] });
    expect(peak(r, 0, 'blast')).toBeGreaterThan(peak(r, 1, 'blast'));
    expect(BLAST.near).toBeLessThan(BLAST.far);
  },
  lowGravity: (r) => {
    const v = r.cars[0].vehicle!, s = r.samples[r.samples.length - 1].cars[0];
    expect(Math.abs(sumFz(s) - v.geo.mass * MOON_G) / (v.geo.mass * MOON_G)).toBeLessThan(0.02);
    const w = 2 * Math.PI * VARIANTS.sedan.rideHz;
    const comp = mean(v.dyn.wheels.map((x) => x.compression));
    expect(Math.abs(comp - MOON_G / (w * w)) / (MOON_G / (w * w))).toBeLessThan(0.1);
    note('lowGravity', { sumFz_mgm: sumFz(s) / (v.geo.mass * MOON_G), comp, compHand: MOON_G / (w * w) });
  },
  combined: (r) => {
    note('combined', Object.fromEntries(['groundMotion', 'wind', 'blast'].map((src) => [src, Math.max(peak(r, 0, src), peak(r, 1, src))])));
    for (const src of ['groundMotion', 'wind', 'blast']) expect(Math.max(peak(r, 0, src), peak(r, 1, src)), src).toBeGreaterThan(0);
  },
};

describe('vehicle presets', () => {
  it('32 presets, documented in both languages, own worlds with vehicle dynamics', () => {
    expect(VEHICLE_PRESETS.length).toBeGreaterThanOrEqual(30);
    expect(VEHICLE_PRESETS.map((p) => p.seed)).toEqual(VEHICLE_PRESETS.map((_, k) => 3501 + k));
    const ko = koVehiclePresets as Record<string, string>, en = enVehiclePresets as Record<string, string>;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const f of ['name', ...VEHICLE_PRESET_FIELDS]) {
      expect(ko[`vehiclePresets.field.${f}`]).toMatch(/\S/);
      expect(en[`vehiclePresets.field.${f}`]).toMatch(/\S/);
    }
    for (const p of VEHICLE_PRESETS) {
      expect(p.seconds).toBe(VEHICLE_SECONDS[p.id]);
      for (const f of ['name', ...VEHICLE_PRESET_FIELDS] as const) {
        expect(ko[p.keys[f]], `${p.id}.${f} ko`).toMatch(/\S/);
        expect(en[p.keys[f]], `${p.id}.${f} en`).toMatch(/\S/);
      }
      const { doc } = p.build();
      expect(doc.settings.simulation.vehicles?.model).toBe('dynamics');
      expect(doc.settings.simulation.seed).toBe(p.seed);
      const cars = Object.values(doc.objects).filter((o) => o.type === 'car');
      expect(cars.length).toBeGreaterThan(0);
      expect(Object.keys(doc.settings.simulation.vehicles!.cars!).sort()).toEqual(cars.map((o) => o.id).sort());
    }
    // A preset resting on a boundary condition says so (wet film) / names its time compression (icy road).
    expect(en['vehiclePresets.wetRoad.scene']).toMatch(/boundary condition/i);
    expect(ko['vehiclePresets.wetRoad.scene']).toMatch(/경계 조건/);
    expect(en['vehiclePresets.icyRoad.scene']).toMatch(/time-compressed/i);
  });

  for (const p of VEHICLE_PRESETS) {
    it(`${p.id}: finite, deterministic, events once per transition, expected behaviour`, async () => {
      const r = await run(p.id);
      await deterministic(r);
      const vehEv = r.c.getDamageEvents().filter((d) => d.eventType.startsWith('VEHICLE_') || d.eventType === 'OCCUPANT_EJECTED');
      const keys = vehEv.map((d) => `${d.objectId}|${d.time}|${d.eventType}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const e of r.cars) {
        const roll = vehEv.filter((d) => d.objectId === e.id && d.eventType === 'VEHICLE_ROLLOVER');
        expect(roll.length).toBeLessThanOrEqual(6);
        for (let i = 1; i < roll.length; i++) expect(roll[i].time - roll[i - 1].time).toBeGreaterThanOrEqual(ROLL_HOLD - 1e-9);
        expect(vehEv.filter((d) => d.objectId === e.id && d.eventType === 'VEHICLE_COLLISION').length).toBeLessThanOrEqual(15);
      }
      expect(r.c.duplicateForces()).toBe(0);
      EXPECT[p.id](r);
      cache[p.id] = r;
      r.c.unload();
    }, 600_000);
  }
});

/** A cached run, or a fresh one (when the file is filtered to these tests). */
async function getRun(id: VehiclePresetId) {
  if (cache[id]) return cache[id]!;
  const r = await run(id);
  r.c.unload();
  return (cache[id] = r);
}

describe('known core defects (it.fails: the expectation of real physics fails while the defect is present)', () => {
  it('D1: ABS stops no longer than locked wheels on dry asphalt', async () => {
    const r = await getRun('hardBraking');
    expect(stop(r, 0, T_BRAKE.hard).d).toBeLessThanOrEqual(stop(r, 1, T_BRAKE.hard).d * 1.01);
  }, 300_000);

  it('D2: after a locked-wheel stop the car does not slide back (< 5 cm) — icy road', async () => {
    const r = await getRun('icyRoad');
    const s = stop(r, 0, ICE_RAIN + T_BRAKE.ice);
    const far = Math.max(...r.samples.filter((x) => x.t <= s.tStop).map((x) => (x.cars[0].p[0] - s.p0[0]) * s.dir[0] + (x.cars[0].p[2] - s.p0[2]) * s.dir[2]));
    const end = r.samples[r.samples.length - 1].cars[0].p;
    expect(far - ((end[0] - s.p0[0]) * s.dir[0] + (end[2] - s.p0[2]) * s.dir[2])).toBeLessThan(0.05);
  }, 600_000);

  it('D3: a fully braked car holds on a 20° asphalt slope (tan θ = 0.36 < μ = 0.9): moves < 5 cm', async () => {
    const r = await getRun('slopeHold');
    const a = r.samples[0].cars[0].p, b = r.samples[r.samples.length - 1].cars[0].p;
    expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeLessThan(0.05);
  }, 300_000);

  it('D4: a car pushed sideways does not spring back (struck car keeps ≥ 70 % of its peak displacement)', async () => {
    const r = await getRun('sideCrash');
    const xs = r.samples.map((s) => s.cars[1].p[0]);
    const peakX = Math.max(...xs), x0 = xs[0];
    expect(xs[xs.length - 1] - x0).toBeGreaterThan(0.7 * (peakX - x0));
  }, 300_000);
});
