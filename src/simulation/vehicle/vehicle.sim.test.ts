/**
 * Phase 35: the wheeled vehicle in the simulation (Rapier) against independent expectations (spec §68–77): static wheel loads,
 * free heave of the suspension, straight-line acceleration, braking distance, steady cornering, momentum in a collision,
 * determinism, sub-step convergence, the legacy car without settings. Hand formulas are written out; model parameters
 * (wheel inertia, rolling resistance, tyre μ of the ground) are the documented inputs, not computed results.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { Vec3 } from '@/core/types';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import type { VehicleCar, VehicleSettings } from '@/vehicle/settings';
import { TIRE, VARIANTS, AIR_DENSITY } from '@/vehicle/params';

const S = () => useWorldStore.getState();
const g = 9.80665;
type Car = { x: number; z: number; rotY?: number; variant?: 'sedan' | 'suv' | 'truck' };

function world(cars: Car[], vehicles: VehicleSettings | null, cfg: (ids: string[]) => Record<string, VehicleCar> = () => ({})): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 5;
  S().applyEdit({ add: cars.map((c) => ({ type: 'car', params: { variant: c.variant ?? 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#ffffff' }, transform: { position: [c.x, 0, c.z] as Vec3, rotation: [0, c.rotY ?? 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } })) as never });
  const doc = structuredClone(S().doc);
  const ids = Object.keys(doc.objects);
  if (vehicles) doc.settings.simulation.vehicles = { ...vehicles, cars: cfg(ids) };
  return doc;
}
async function load(doc: WorldDocument) {
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  return c;
}
const cars = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'car');
const vel = (c: SimulationController, e: RuntimeEntity) => c.getPhysics()!.getLinearVelocity(e.body!);
/** Start a car moving at v (m/s) along +X with free-rolling wheels. */
function launch(c: SimulationController, e: RuntimeEntity, v: number) {
  c.getPhysics()!.setVelocity(e.body!, [v, 0, 0], [0, 0, 0]);
  for (const W of e.vehicle!.dyn.wheels) W.omega = v / e.vehicle!.geo.spec.wheelRadius;
}
const DYN: VehicleSettings = { model: 'dynamics' };

describe('vehicle dynamics in the simulation', () => {
  it('without settings the car is the legacy rigid body (no vehicle state); with settings the wheels carry it', async () => {
    const a = await load(world([{ x: 0, z: 0 }], null));
    expect(cars(a)[0].vehicle).toBeUndefined();
    expect(a.getRuntime()!.vehicles).toBeUndefined();
    a.unload();
    const b = await load(world([{ x: 0, z: 0 }], DYN));
    expect(cars(b)[0].vehicle?.level).toBe('vehicle');
    b.unload();
  });

  it('first step (found by the Chrome check): the wheel rays see the ground from the first step (fresh colliders); a parked car\'s energy residual stays < 1 % of its energy', async () => {
    const c = await load(world([{ x: 0, z: 0 }], DYN));
    const e = cars(c)[0], v = e.vehicle!;
    c.advance(1 / 60);
    expect(v.dyn.touching).toBe(4);
    expect(v.dyn.springEnergy).toBeGreaterThan(0);
    c.advance(10);
    expect(Math.abs(v.energy.residual)).toBeLessThan(0.01 * Math.abs(v.energy.E0));
    c.unload();
  });

  it('static loads (§71): parked on flat ground ΣF_z = m g, each wheel the statics of the COM; no creep in 10 s', async () => {
    const c = await load(world([{ x: 0, z: 0 }], DYN));
    const e = cars(c)[0], v = e.vehicle!;
    c.advance(10);
    const Fz = v.dyn.wheels.map((w) => w.Fz);
    expect(Fz.reduce((a, b) => a + b, 0)).toBeCloseTo(v.geo.mass * g, -1);
    // Hand statics: front axle share = (x_c − x_r) / L with the composite COM x_c.
    const L = v.geo.wheelbase, front = (v.geo.com[0] + L / 2) / L;
    expect((Fz[0] + Fz[1]) / (v.geo.mass * g)).toBeCloseTo(front, 2);
    expect(Math.hypot(e.pose.position[0], e.pose.position[2])).toBeLessThan(1e-3);
    c.unload();
  });

  it('suspension (§72): a 4 cm drop oscillates at f_d = f √(1 − ζ²) and decays with the logarithmic decrement 2πζ/√(1 − ζ²)', async () => {
    const c = await load(world([{ x: 0, z: 0 }], DYN));
    const e = cars(c)[0];
    c.advance(2);
    const y0 = e.pose.position[1];
    const p = c.getPhysics()!.getPose(e.body!);
    c.getPhysics()!.setBodyPose(e.body!, [p.position[0], p.position[1] + 0.04, p.position[2]], p.quaternion);
    c.getPhysics()!.setVelocity(e.body!, [0, 0, 0], [0, 0, 0]);
    const ys: number[] = [];
    for (let i = 0; i < 180; i++) { c.advance(1 / 60); ys.push(e.pose.position[1] - y0); }
    // Upward zero crossings → period; successive maxima → decrement.
    const cross: number[] = [];
    for (let i = 1; i < ys.length; i++) if (ys[i - 1] < 0 && ys[i] >= 0) cross.push(i - ys[i] / (ys[i] - ys[i - 1]));
    const f = VARIANTS.sedan.rideHz, z = VARIANTS.sedan.damping;
    const fd = f * Math.sqrt(1 - z * z);
    expect(cross.length).toBeGreaterThanOrEqual(2);
    const T = (cross[1] - cross[0]) / 60;
    expect(1 / T).toBeGreaterThan(fd * 0.85);
    expect(1 / T).toBeLessThan(fd * 1.15);
    const peaks: number[] = [];
    for (let i = 1; i < ys.length - 1; i++) if (ys[i] > ys[i - 1] && ys[i] >= ys[i + 1] && ys[i] > 1e-4) peaks.push(ys[i]);
    const delta = Math.log(peaks[0] / peaks[1]);
    expect(delta).toBeGreaterThan(0.6 * (2 * Math.PI * z) / Math.sqrt(1 - z * z));
    expect(delta).toBeLessThan(1.4 * (2 * Math.PI * z) / Math.sqrt(1 - z * z));
    c.unload();
  });

  it('straight acceleration (§68): constant wheel torque → a = (T_w / R − C_rr m g − drag) / (m + Σ I_w / R²); v = a t, x = ½ a t²', async () => {
    const thr = 0.2;
    const c = await load(world([{ x: 0, z: 0 }], DYN, (ids) => ({ [ids[0]]: { controls: { throttle: thr, gear: 'D' } } })));
    const e = cars(c)[0], v = e.vehicle!, sp = VARIANTS.sedan;
    // Window 3 → 5 s: above v_low (2 m/s) — the low-speed tread-damping blend is outside the window (steady rolling).
    c.advance(3);
    const v1 = vel(c, e)[0], x1 = e.pose.position[0];
    c.advance(2);
    const v3 = vel(c, e)[0], x3 = e.pose.position[0];
    // Engine at full-load torque (ω_e < P/T) in first gear; grass rolling resistance; drag at the mean speed (small).
    const Tw = thr * sp.torque * sp.gears[0] * sp.final * sp.efficiency;
    const vm = (v1 + v3) / 2;
    const drag = 0.5 * AIR_DENSITY * sp.cd * 1.8 * 1.45 * sp.areaFill * vm * vm;
    const a = (Tw / sp.wheelRadius - TIRE.crrGround[0] * v.geo.mass * g - drag) / (v.geo.mass + (4 * sp.wheelInertia) / sp.wheelRadius ** 2);
    const aMeas = (v3 - v1) / 2;
    expect(v1).toBeGreaterThan(TIRE.vLow);
    expect(Math.abs(aMeas - a) / a).toBeLessThan(0.03);
    expect(Math.abs(x3 - x1 - (v1 * 2 + 0.5 * aMeas * 4)) / (x3 - x1)).toBeLessThan(0.02);
    expect(e.pose.position[2]).toBeCloseTo(0, 2);
    c.unload();
  });

  it('braking with locked wheels (§69): sliding μ g plus drag → d = m / (ρ C_d A) ln(1 + ρ C_d A v₀² / (2 μ_s m g)); ABS stops shorter or equal', async () => {
    const v0 = 15;
    const dist = async (abs: boolean) => {
      const c = await load(world([{ x: 0, z: 0 }], { model: 'dynamics', abs }, (ids) => ({ [ids[0]]: { controls: { brake: 1, gear: 'N' } } })));
      const e = cars(c)[0];
      c.advance(1);
      launch(c, e, v0);
      const x0 = e.pose.position[0];
      for (let i = 0; i < 1200 && vel(c, e)[0] > 0.05; i++) c.advance(1 / 60);
      const d = e.pose.position[0] - x0;
      const m = e.vehicle!.geo.mass;
      c.unload();
      return { d, m };
    };
    const locked = await dist(false);
    const sp = VARIANTS.sedan;
    const mus = TIRE.slideShare * TIRE.muGround[0];
    const k = AIR_DENSITY * sp.cd * 1.8 * 1.45 * sp.areaFill;
    const expected = (locked.m / k) * Math.log(1 + (k * v0 * v0) / (2 * mus * locked.m * g));
    expect(Math.abs(locked.d - expected) / expected).toBeLessThan(0.05);
    const abs = await dist(true);
    expect(abs.d).toBeLessThanOrEqual(locked.d * 1.01);
    // ABS keeps the deceleration under the peak friction: d ≥ v₀² / (2 μ_peak g) − drag share.
    expect(abs.d).toBeGreaterThan((v0 * v0) / (2 * TIRE.muGround[0] * g) * 0.9);
  }, 120_000);

  it('steady cornering (§70): a_y = v r (kinematics), Σ F_y ≈ m a_y, and a_y ≤ μ g; the car turns only through the tyres (left for steer > 0)', async () => {
    const c = await load(world([{ x: 0, z: 0 }], DYN, (ids) => ({ [ids[0]]: { autopilot: { path: [[0, 0], [400, 0]], speed: 6, avoid: false }, controls: { steer: 0.3 } } })));
    const e = cars(c)[0], v = e.vehicle!;
    c.advance(6);
    v.autopilot = null;
    v.base = { throttle: 0.12, steer: 0.35, gear: 'D' };
    c.advance(12);
    const vv = vel(c, e), w = c.getPhysics()!.getAngularVelocity(e.body!);
    const speed = Math.hypot(vv[0], vv[2]);
    const r = w[1];
    expect(r).toBeGreaterThan(0); // positive yaw about +Y = a left turn
    const ay = v.accel[2];
    // Lateral acceleration (body z = right) is to the left (negative z) with magnitude v r.
    expect(Math.abs(Math.abs(ay) - speed * r) / (speed * r)).toBeLessThan(0.1);
    const Fy = v.dyn.wheels.reduce((a, W) => a + W.Fy, 0);
    expect(Math.abs(Math.abs(Fy) - v.geo.mass * Math.abs(ay)) / (v.geo.mass * Math.abs(ay))).toBeLessThan(0.15);
    expect(Math.abs(ay)).toBeLessThanOrEqual(TIRE.muGround[0] * g * 1.02);
    c.unload();
  }, 120_000);

  it('collision (§74, §37): head-on, no drive or brakes — total momentum before ≈ after, the two episodes carry opposite impulses', async () => {
    const c = await load(world([{ x: 0, z: 0 }, { x: 12, z: 0, rotY: Math.PI }], DYN, (ids) => Object.fromEntries(ids.map((id) => [id, { controls: { gear: 'N' } }]))));
    const [a, b] = cars(c).sort((p, q) => p.pose.position[0] - q.pose.position[0]);
    c.advance(1);
    launch(c, a, 8);
    c.getPhysics()!.setVelocity(b.body!, [-4, 0, 0], [0, 0, 0]);
    for (const W of b.vehicle!.dyn.wheels) W.omega = 4 / b.vehicle!.geo.spec.wheelRadius;
    const ma = a.vehicle!.geo.mass, mb = b.vehicle!.geo.mass;
    const p0 = ma * 8 + mb * -4;
    c.advance(3);
    const epA = a.vehicle!.episodes.find((x) => x.partner === b.id)!, epB = b.vehicle!.episodes.find((x) => x.partner === a.id)!;
    expect(epA && epB).toBeTruthy();
    const pAfter = ma * epA.vAfter[0] + mb * epB.vAfter[0];
    // Tyre rolling resistance / drag over the short episode are small external impulses: within 3 % of |p₀|.
    expect(Math.abs(pAfter - p0)).toBeLessThan(0.03 * (ma * 8 + mb * 4));
    expect(epA.impulse[0] + epB.impulse[0]).toBeCloseTo(0, -1);
    expect(epA.impulse[0]).toBeLessThan(0);
    // Velocity change of each car = impulse / mass (Δv along x).
    expect(epA.vAfter[0] - epA.vBefore[0]).toBeCloseTo(epA.impulse[0] / ma, 0);
    expect(c.getDamageEvents().filter((ev) => ev.eventType === 'VEHICLE_COLLISION').length).toBeGreaterThanOrEqual(2);
    c.unload();
  }, 120_000);

  it('determinism (§58): the same run twice is bit-identical; cars created in reverse order give the same motion (to rounding)', async () => {
    const run = async (rev: boolean) => {
      const list: Car[] = [{ x: 0, z: 0 }, { x: 0, z: 8 }];
      const c = await load(world(rev ? [...list].reverse() : list, DYN, (ids) => Object.fromEntries(ids.map((id) => [id, { program: [{ t: 0, gear: 'D', throttle: 0.4 }, { t: 3, steer: 0.4 }, { t: 6, brake: 1, throttle: 0 }] }]))));
      c.advance(9);
      const out = cars(c).map((e) => ({ z0: e.source.transform.position[2], p: [...e.pose.position], w: e.vehicle!.dyn.wheels.map((W) => W.omega) })).sort((p, q) => p.z0 - q.z0);
      c.unload();
      return out;
    };
    const a = await run(false), b = await run(false), r = await run(true);
    expect(b).toEqual(a);
    for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) expect(r[i].p[k]).toBeCloseTo(a[i].p[k], 3);
  }, 120_000);

  it('sub-step convergence (§77): the braking distance with 4, 8, 16, 32 wheel sub-steps converges (differences shrink)', async () => {
    const d: number[] = [];
    for (const n of [4, 8, 16, 32]) {
      const c = await load(world([{ x: 0, z: 0 }], { model: 'dynamics', abs: true, substeps: n }, (ids) => ({ [ids[0]]: { controls: { brake: 0.7, gear: 'N' } } })));
      const e = cars(c)[0];
      c.advance(1);
      launch(c, e, 12);
      const x0 = e.pose.position[0];
      for (let i = 0; i < 1200 && vel(c, e)[0] > 0.05; i++) c.advance(1 / 60);
      d.push(e.pose.position[0] - x0);
      c.unload();
    }
    const diffs = [Math.abs(d[1] - d[0]), Math.abs(d[2] - d[1]), Math.abs(d[3] - d[2])];
    expect(diffs[2]).toBeLessThanOrEqual(diffs[0] + 1e-6);
    expect(diffs[2] / d[3]).toBeLessThan(0.02);
  }, 180_000);
});
