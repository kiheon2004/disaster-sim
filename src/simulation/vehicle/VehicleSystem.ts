/**
 * Phase 35: wheeled vehicles (prePhysics, after every hazard's force system of the step).
 *
 * Per vehicle-mode car (deterministic id order): controls (constant → timed program → autopilot → live input, then limited by the
 * vehicle's damage and its driver's capacity) → one ray per wheel against the world (own body, people and occupants excluded) →
 * surface friction / rolling resistance at the contact (ground type, climate cover, water film) → `stepVehicle` (suspension,
 * wheel spin, tyres) → the wheel contact forces through the ForceLedger's 'wheels' channel (one claim, four points), their
 * reactions on a dynamic body under a wheel ('wheelReaction'), and the vehicle's air drag through the 'wind' source (the wind
 * system skips vehicle-mode cars, so the source is claimed once). Gravity is Rapier's + the Phase 31 field: no weight force here;
 * the local field sizes the brakes only. Level 1 ('rigid') cars and captured / removed bodies are skipped.
 */
import type { Vec3 } from '@/core/types';
import type { SimulationSystem, SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { simProfiler } from '../profiling/SimProfiler';
import { mountWorld, rotate, stepVehicle, type BodyKinematics, type WheelHit } from '@/vehicle/dynamics';
import { aeroForce } from '@/vehicle/aero';
import { tireCrr, tireMu } from '@/vehicle/surface';
import { AIR_DENSITY } from '@/vehicle/params';
import { G0 } from '@/vehicle/geometry';
import type { Controls } from '@/vehicle/powertrain';
import type { BodyUserData } from '@/physics/PhysicsEngine';
import { physiologySnapshot } from '../physiology/interface';
import type { VehicleEntity } from './state';

const BODY_MU = 0.7;
const BODY_CRR = 0.015;
const CAP_INPUT: Record<string, number> = { normal: 1, stressed: 1, impaired: 0.8, severelyImpaired: 0.4, unableToAct: 0 };

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Effective inputs at time t from the car's sources (later wins), before the capability limits. */
export function resolveControls(v: VehicleEntity, t: number, out: Controls): Controls {
  const b = v.base;
  out.throttle = b.throttle ?? 0;
  out.brake = b.brake ?? 0;
  out.steer = b.steer ?? 0;
  out.handbrake = b.handbrake ?? false;
  out.gear = b.gear ?? 'D';
  const p = v.program;
  while (v.programIdx < p.length && p[v.programIdx].t <= t + 1e-9) {
    const k = p[v.programIdx++];
    if (k.throttle !== undefined) b.throttle = k.throttle;
    if (k.brake !== undefined) b.brake = k.brake;
    if (k.steer !== undefined) b.steer = k.steer;
    if (k.handbrake !== undefined) b.handbrake = k.handbrake;
    if (k.gear !== undefined) b.gear = k.gear;
    out.throttle = b.throttle ?? 0; out.brake = b.brake ?? 0; out.steer = b.steer ?? 0; out.handbrake = b.handbrake ?? false; out.gear = b.gear ?? 'D';
  }
  const l = v.live;
  if (l) {
    if (l.throttle !== undefined) out.throttle = l.throttle;
    if (l.brake !== undefined) out.brake = l.brake;
    if (l.steer !== undefined) out.steer = l.steer;
    if (l.handbrake !== undefined) out.handbrake = l.handbrake;
    if (l.gear !== undefined) out.gear = l.gear;
  }
  return out;
}

export class VehicleSystem implements SimulationSystem {
  readonly name = 'vehicles';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['poses', 'airflow', 'water', 'damage'] as const;
  readonly writes = ['forces'] as const;
  readonly lagged = ['poses', 'damage'] as const;
  private readonly hits: WheelHit[] = [0, 1, 2, 3].map(() => ({ toi: null, point: [0, 0, 0] as Vec3, normal: [0, 1, 0] as Vec3, surfaceVel: [0, 0, 0] as Vec3, mu: 0, crr: 0 }));
  private readonly hitBody: (number | null)[] = [null, null, null, null];

  isActive(ctx: SystemContext) {
    return !!ctx.runtime.vehicles;
  }

  update(ctx: SystemContext, dt: number) {
    const t0 = simProfiler.now();
    const rt = ctx.runtime.vehicles!;
    const t = ctx.time;
    const skip = (u: BodyUserData) => {
      const o = ctx.runtime.entities.get(u.entityId);
      return !!o && (o.source.type === 'human' || o.occupant !== undefined);
    };
    for (const id of rt.order) {
      const e = ctx.runtime.entities.get(id)!;
      const v = e.vehicle!;
      if (e.body === null || e.flags.captured) { v.frozen = e.flags.captured === true; continue; }
      const h = e.body;
      const vel = ctx.physics.getLinearVelocity(h), w = ctx.physics.getAngularVelocity(h);
      // The step's starting velocity (accelerations, collision Δv) — for Level 1 ('rigid') cars too.
      v.prevV = [vel[0], vel[1], vel[2]];
      v.prevW = [w[0], w[1], w[2]];
      if (v.level !== 'vehicle') continue;
      const pose = ctx.physics.getPose(h);
      const com = rotate(pose.quaternion, v.geo.com);
      com[0] += pose.position[0]; com[1] += pose.position[1]; com[2] += pose.position[2];
      const kin: BodyKinematics = { pos: pose.position, q: pose.quaternion, v: vel, w, com };
      // Controls and what limits them.
      const c = resolveControls(v, t, v.controls);
      // The autopilot writes the inputs unless a live input (keyboard / UI) overrides it.
      if (v.autopilot && !v.live) this.autopilot(ctx, e, v, kin, c);
      this.driver(ctx, v, c);
      // Under its own power: what this car strikes is the vehicle's doing (attribution of collisions, injuries, structure strikes).
      if (c.throttle > 0 && v.avail.drive * v.avail.driver > 0 && c.gear !== 'N' && c.gear !== 'P') e.lastHazard = 'vehicle';
      // Wheel rays (along −up from each strut mount).
      const ts = simProfiler.now();
      const up = rotate(pose.quaternion, [0, 1, 0]);
      const down: Vec3 = [-up[0], -up[1], -up[2]];
      const mount: Vec3 = [0, 0, 0];
      for (let i = 0; i < 4; i++) {
        mountWorld(v.geo, kin, i, mount);
        const hit = ctx.physics.castRay(mount, down, v.geo.freeLength[i] + v.geo.spec.wheelRadius, h, skip);
        const H = this.hits[i];
        this.hitBody[i] = null;
        if (!hit) { H.toi = null; continue; }
        H.toi = hit.toi;
        H.point[0] = hit.point[0]; H.point[1] = hit.point[1]; H.point[2] = hit.point[2];
        H.normal[0] = hit.normal[0]; H.normal[1] = hit.normal[1]; H.normal[2] = hit.normal[2];
        H.surfaceVel[0] = H.surfaceVel[1] = H.surfaceVel[2] = 0;
        if (hit.body === null) {
          const x = hit.point[0], z = hit.point[2];
          const g = ctx.env.terrain.sampleGroundType(x, z);
          const water = ctx.env.flood.field ? Math.max(0, ctx.env.flood.field.sampleDepth(x, z)) : 0;
          const cover = ctx.env.climate.rt ? ctx.env.climate.rt.coverAt(x, z, water) : null;
          H.mu = tireMu(g, cover, water);
          H.crr = tireCrr(g, cover);
        } else {
          H.mu = BODY_MU;
          H.crr = BODY_CRR;
          if (ctx.physics.isDynamic(hit.body)) {
            const bv = ctx.physics.getLinearVelocity(hit.body), bw = ctx.physics.getAngularVelocity(hit.body), bp = ctx.physics.getPose(hit.body).position;
            const r = [hit.point[0] - bp[0], hit.point[1] - bp[1], hit.point[2] - bp[2]];
            H.surfaceVel[0] = bv[0] + bw[1] * r[2] - bw[2] * r[1];
            H.surfaceVel[1] = bv[1] + bw[2] * r[0] - bw[0] * r[2];
            H.surfaceVel[2] = bv[2] + bw[0] * r[1] - bw[1] * r[0];
            this.hitBody[i] = hit.body;
          }
        }
      }
      simProfiler.add('vehicle.rays', ts);
      // Local gravity along −up (brake sizing).
      const gv = ctx.env.gravity.at(com[0], com[1], com[2], [0, 0, 0]);
      const gDown = Math.max(0, -dot(gv, up)) || G0;
      const tv = simProfiler.now();
      stepVehicle(v.geo, v.dyn, kin, this.hits, c, {
        model: v.model, drive: v.drive, substeps: v.substeps, abs: v.abs, g: gDown,
        driveAvail: v.avail.drive * v.avail.driver, steerAvail: v.avail.steer * Math.max(v.avail.driver, 0), brakeAvail: v.avail.brake * v.avail.driver,
      }, dt);
      simProfiler.add('vehicle.step', tv);
      // Apply: wheels (one claim), reactions on dynamic bodies under the wheels (grouped per body), air drag.
      const ta = simProfiler.now();
      const fs: Vec3[] = [], ps: Vec3[] = [];
      for (const W of v.dyn.wheels) if (W.contact) { fs.push(W.force); ps.push(W.point); }
      if (fs.length) ctx.forces.contactForces('wheels', h, fs, ps);
      const react = new Map<number, { f: Vec3[]; p: Vec3[] }>();
      for (let i = 0; i < 4; i++) {
        const b = this.hitBody[i], W = v.dyn.wheels[i];
        if (b === null || !W.contact) continue;
        const r = react.get(b) ?? { f: [], p: [] };
        r.f.push([-W.force[0], -W.force[1], -W.force[2]]);
        r.p.push([W.point[0], W.point[1], W.point[2]]);
        react.set(b, r);
      }
      for (const [b, r] of react) ctx.forces.contactForces('wheelReaction', b, r.f, r.p);
      this.aero(ctx, e, v, kin, dt);
      simProfiler.add('vehicle.apply', ta);
    }
    simProfiler.add('vehicles', t0);
  }

  /** Air drag of the body (replaces the legacy wind drag of the car). */
  private aero(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, kin: BodyKinematics, dt: number) {
    const cop = rotate(kin.q, e.copLocal);
    const r: Vec3 = [kin.pos[0] + cop[0] - kin.com[0], kin.pos[1] + cop[1] - kin.com[1], kin.pos[2] + cop[2] - kin.com[2]];
    const vCop: Vec3 = [kin.v[0] + kin.w[1] * r[2] - kin.w[2] * r[1], kin.v[1] + kin.w[2] * r[0] - kin.w[0] * r[2], kin.v[2] + kin.w[0] * r[1] - kin.w[1] * r[0]];
    const p: Vec3 = [kin.pos[0] + cop[0], kin.pos[1] + cop[1], kin.pos[2] + cop[2]];
    const atm = ctx.env.atmosphere.rt;
    const rho = atm ? atm.densityAt(p[0], p[1], p[2]) : ctx.env.airDensity || AIR_DENSITY;
    const d = v.geo.dims, s = v.geo.spec;
    const F = aeroForce({ q: kin.q, vCop, wind: e.localWind.velocity, rho, cd: s.cd, cy: s.cy, frontal: d.width * d.height * s.areaFill, side: d.length * d.height * s.areaFill, dryShare: 1 - (e.flood?.submerged ?? 0) });
    if (F[0] === 0 && F[1] === 0 && F[2] === 0) return;
    if (ctx.forces.forceAtPoint('wind', e.body!, F, p, e)) v.dyn.ledger.aero -= (F[0] * vCop[0] + F[1] * vCop[1] + F[2] * vCop[2]) * dt;
  }

  /** Driver capability (Phase 33 / 34 of the occupant in the driver's seat): scales the inputs, never the vehicle's motion. */
  private driver(ctx: SystemContext, v: VehicleEntity, c: Controls) {
    const d = v.occupants.find((o) => o.seat === 'driver');
    if (!d) { v.avail.driver = 1; v.avail.driverCause = null; return; }
    const he = ctx.runtime.entities.get(d.human);
    let a = 1, cause: string | null = null;
    if (!he || d.state !== 'seated') { a = 0; cause = 'noDriver'; }
    else {
      const ps = physiologySnapshot(he);
      if (ps) { a = CAP_INPUT[ps.combined] ?? 1; if (a < 1) cause = ps.causes.join('+') || ps.combined; }
      else if (he.human?.incapacitated) { a = 0; cause = 'physical'; }
      else if (he.human && he.human.mobility !== 'mobile') { a = he.human.mobility === 'immobile' ? 0.4 : 0.8; cause = 'physical'; }
    }
    v.avail.driver = a;
    v.avail.driverCause = cause;
    // An incapacitated driver releases the pedals; the steering stays where it was (not driven to centre).
    if (a === 0) { c.throttle = 0; c.brake = 0; }
  }

  /**
   * Path following (inputs only — never moves the car): pure pursuit on the path (look-ahead max(4 m, 0.6 s × v)), a
   * proportional speed controller, a stop before the path end, and a forward ray that brakes for an obstacle within the
   * stopping distance v² / (2 · 0.5 g) + 3 m.
   */
  private autopilot(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, kin: BodyKinematics, c: Controls) {
    const ap = v.autopilot!;
    const path = ap.path;
    const fwd = rotate(kin.q, [1, 0, 0]);
    const speed = dot(kin.v, fwd);
    const px = kin.pos[0], pz = kin.pos[2];
    // Advance the target index past points already reached.
    while (ap.target < path.length - 1 && Math.hypot(path[ap.target][0] - px, path[ap.target][1] - pz) < 3) {
      ap.target++;
      if (ap.loop && ap.target === path.length - 1) ap.target = 0;
    }
    const look = Math.max(4, 0.6 * Math.abs(speed));
    let k = ap.target;
    while (k < path.length - 1 && Math.hypot(path[k][0] - px, path[k][1] - pz) < look) k++;
    const [tx, tz] = path[k];
    const dx = tx - px, dz = tz - pz;
    // Heading angle to the target (left positive): yaw of fwd vs the target direction about +Y.
    const hx = fwd[0], hz = fwd[2];
    const alpha = Math.atan2(hx * dz - hz * dx, hx * dx + hz * dz) * -1;
    const Ld = Math.max(1, Math.hypot(dx, dz));
    const delta = Math.atan((2 * v.geo.wheelbase * Math.sin(alpha)) / Ld);
    c.steer = Math.max(-1, Math.min(1, delta / v.geo.spec.steerMax));
    // Speed target: stop at the end of an open path.
    let vt = ap.speed;
    const last = path[path.length - 1];
    const toEnd = Math.hypot(last[0] - px, last[1] - pz);
    if (!ap.loop && (ap.stopAtEnd ?? true)) vt = Math.min(vt, Math.sqrt(2 * 2.5 * Math.max(0, toEnd - 2)));
    ap.done = !ap.loop && toEnd < 2.5 && Math.abs(speed) < 0.3;
    // Obstacle ahead (forward ray at half height from the front).
    ap.obstacle = null;
    if (ap.avoid ?? true) {
      const d = v.geo.dims;
      const o: Vec3 = rotate(kin.q, [d.length / 2 + 0.05, d.height * 0.45, 0]);
      o[0] += kin.pos[0]; o[1] += kin.pos[1]; o[2] += kin.pos[2];
      const range = (speed * speed) / (2 * 0.5 * G0) + 3;
      const hit = ctx.physics.castRay(o, fwd, range, e.body, (u) => u.entityId === e.id);
      if (hit && hit.body !== null) { ap.obstacle = hit.toi; vt = 0; }
    }
    const err = vt - speed;
    c.gear = 'D';
    c.handbrake = false;
    c.throttle = Math.max(0, Math.min(1, 0.4 * err));
    c.brake = Math.max(0, Math.min(1, -0.5 * err));
    if (vt === 0 && Math.abs(speed) < 0.5) { c.brake = 1; c.throttle = 0; }
  }
}
