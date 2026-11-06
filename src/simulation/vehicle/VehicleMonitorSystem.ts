/**
 * Phase 35: vehicle state after the physics step (postPhysics, right after the DamageSystem drained the contacts).
 *
 * Per vehicle (id order): accelerations (body axes) from the step's velocity change, collision episodes closed (Δv, KE lost,
 * damage index / level, events), rollover state from the body attitude against the local gravity and the wheel loads (with
 * the lateral load-transfer ratio LTR = |ΣF_z,left − ΣF_z,right| / ΣF_z), engine stall when the water reaches the intake (half
 * the body height — assumed) or the vehicle floats, the mechanical-energy ledger, the occupants (seated: carried with the seat,
 * out of the collision world; ejected: back into it with the seat's velocity), the chart series. Reads physics, never pushes.
 */
import type { Vec3 } from '@/core/types';
import type { SimulationSystem, SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { simProfiler } from '../profiling/SimProfiler';
import { rotate } from '@/vehicle/dynamics';
import { DAMAGE_AVAIL, DAMAGE_REF_DV, damageLevel, EPISODE_GAP_STEPS, EPISODE_MAX_STEPS, kineticEnergy } from './collisions';
import { VEHICLE_DAMAGE, VEHICLE_SERIES_KEYS, VEHICLE_SERIES_MAX, type CollisionEpisode, type RolloverState, type VehicleEntity } from './state';
import type { Seat } from '@/vehicle/settings';

/** Air-intake height as a share of the body height above its base (assumption). */
export const INTAKE_SHARE = 0.5;
/** Unrestrained occupant thrown out: rollover onto side / roof, or a collision episode with Δv ≥ this (m/s) — assumed rule. */
export const EJECT_DV = 8;
const ROLL_EVENT: RolloverState[] = ['onSide', 'onRoof'];
/** A rollover state must hold this long (s) before it replaces the current one. */
export const ROLL_HOLD = 0.5;

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Seat point (vehicle local, m): floor height under the occupant's hips. */
export function seatLocal(v: VehicleEntity, seat: Seat): Vec3 {
  const d = v.geo.dims, c = v.geo.cabin.centre;
  const x = c[0] + (seat === 'driver' || seat === 'front' ? 0.25 : -0.6) * Math.min(1, d.length / 4.5);
  const z = (seat === 'driver' || seat === 'rearLeft' ? -0.25 : 0.25) * d.width;
  return [x, v.geo.chassis.centre[1] + v.geo.chassis.half[1] * 0.2, z];
}

export class VehicleMonitorSystem implements SimulationSystem {
  readonly name = 'vehicleMonitor';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['poses', 'damage', 'water'] as const;
  readonly writes = ['damage'] as const;
  /** People's injury state (HumanSystem, later in the step) is read as of the previous step (the driver's capacity). */
  readonly lagged = ['damage'] as const;

  isActive(ctx: SystemContext) {
    return !!ctx.runtime.vehicles;
  }

  update(ctx: SystemContext, dt: number) {
    const t0 = simProfiler.now();
    const rt = ctx.runtime.vehicles!;
    const t = ctx.time + dt;
    for (const id of rt.order) {
      const e = ctx.runtime.entities.get(id)!;
      const v = e.vehicle!;
      if (e.body === null || !ctx.physics.hasBody(e.body)) { v.frozen = true; this.releaseOccupants(ctx, v); continue; }
      const h = e.body;
      const pose = ctx.physics.getPose(h);
      const vel = ctx.physics.getLinearVelocity(h), w = ctx.physics.getAngularVelocity(h);
      // Acceleration in body axes (x forward, y up, z right).
      const a: Vec3 = [(vel[0] - v.prevV[0]) / dt, (vel[1] - v.prevV[1]) / dt, (vel[2] - v.prevV[2]) / dt];
      const x = rotate(pose.quaternion, [1, 0, 0]), y = rotate(pose.quaternion, [0, 1, 0]), z = rotate(pose.quaternion, [0, 0, 1]);
      v.accel = [dot(a, x), dot(a, y), dot(a, z)];
      this.episodes(ctx, e, v, vel, w, pose.quaternion, t);
      this.rollover(ctx, e, v, y, dt, v.level === 'vehicle');
      this.stall(ctx, e, v, dt);
      this.energy(ctx, v, vel, w, pose);
      this.occupants(ctx, e, v, pose);
      if (v.series) this.seriesPush(v, vel, w, x, z, t);
      // Damage → capability, the legacy health (one damage owner: the vehicle model sets it).
      const av = DAMAGE_AVAIL[v.damage.level];
      const roof = v.rollover === 'onRoof';
      v.avail.drive = roof || v.stalled ? 0 : av[0];
      v.avail.steer = av[1];
      v.avail.brake = av[2];
      e.health = Math.min(e.health, 1 - v.damage.index);
    }
    simProfiler.add('vehicleMonitor', t0);
  }

  private episodes(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, vel: Vec3, w: Vec3, q: readonly number[], t: number) {
    for (const [k, ep] of v.open) {
      const last = (ep as CollisionEpisode & { lastStep?: number }).lastStep ?? ctx.step;
      if (ctx.step - last < EPISODE_GAP_STEPS && ep.steps < EPISODE_MAX_STEPS) continue;
      v.open.delete(k);
      ep.open = false;
      ep.vAfter = [vel[0], vel[1], vel[2]];
      ep.dv = Math.hypot(vel[0] - ep.vBefore[0], vel[1] - ep.vBefore[1], vel[2] - ep.vBefore[2]);
      ep.keAfter = kineticEnergy(v, vel, w, q);
      v.episodes.push(ep);
      if (v.episodes.length > 500) v.episodes.shift();
      if (ep.keBefore > ep.keAfter) v.energy.collision += ep.keBefore - ep.keAfter;
      // Resting / rolling contact with the ground is not a collision unless it changed the velocity noticeably.
      if (ep.dv < (ep.partnerKind === 'ground' ? 1.5 : 0.5)) continue;
      ep.recorded = true;
      v.damage.peakDv = Math.max(v.damage.peakDv, ep.dv);
      const before = v.damage.level;
      const eq = Math.sqrt((v.damage.index * DAMAGE_REF_DV) ** 2 + ep.dv * ep.dv);
      v.damage.index = Math.min(1, eq / DAMAGE_REF_DV);
      v.damage.level = damageLevel(eq);
      const J = Math.hypot(ep.impulse[0], ep.impulse[1], ep.impulse[2]);
      const lost = Math.max(0, ep.keBefore - ep.keAfter);
      const hazard = e.lastHazard ?? 'vehicle';
      ctx.recordDamage(e, {
        eventType: 'VEHICLE_COLLISION', cause: 'collision', hazard, force: ep.peakForce, worldPosition: [...ep.point] as Vec3,
        damageBefore: VEHICLE_DAMAGE.indexOf(before) / 4, damageAfter: VEHICLE_DAMAGE.indexOf(v.damage.level) / 4, response: ep.dv,
        vehicle: { kind: 'collision', partner: ep.partner, partnerKind: ep.partnerKind, dv: ep.dv, closing: ep.closing, impulse: J, energy: lost, level: v.damage.level },
      });
      ctx.log(e.id, ep.dv >= 7 ? 'danger' : 'warn', { key: 'log.vehicle.collision', params: { partner: ep.partner, dv: ep.dv.toFixed(1) } });
      if (v.damage.level !== before) {
        ctx.recordDamage(e, { eventType: 'VEHICLE_DAMAGED', cause: 'collision', hazard, vehicle: { kind: 'damage', level: v.damage.level }, response: v.damage.index });
        ctx.log(e.id, 'danger', { key: 'log.vehicle.damage', params: { level: v.damage.level } });
      }
      // Occupant loads of the reduced model (Level A): the seat follows the vehicle — the episode's Δv, peak acceleration ≈ Δv / duration.
      const dur = Math.max(ep.end - ep.start + 1 / 60, 1 / 60);
      for (const o of v.occupants) if (o.state === 'seated') {
        o.peakDv = Math.max(o.peakDv, ep.dv);
        o.peakAccel = Math.max(o.peakAccel, ep.dv / dur);
        if (!o.restrained && ep.dv >= EJECT_DV) this.eject(ctx, e, v, o, t);
      }
    }
  }

  /** `wheels` false (Level 1 'rigid'): no wheel loads — the state from the attitude only, LTR not computed (NaN). */
  private rollover(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, up: Vec3, dt: number, wheels: boolean) {
    const p = e.pose.position;
    const g = ctx.env.gravity.at(p[0], p[1], p[2], [0, 0, 0]);
    const gm = Math.hypot(g[0], g[1], g[2]);
    // Attitude against the local "up" (−g): cos of the tilt.
    const c = gm > 1e-6 ? -dot(up, g) / gm : up[1];
    const W = v.dyn.wheels;
    const left = W[0].Fz + W[2].Fz, right = W[1].Fz + W[3].Fz, sum = left + right;
    // LTR only while the wheels carry load (airborne / floating: undefined → kept, not counted in the peak).
    if (!wheels) v.ltr = NaN;
    else if (sum > 0) {
      v.ltr = Math.abs(left - right) / sum;
      if (v.ltr > v.peakLtr) v.peakLtr = v.ltr;
    }
    const leftOff = !W[0].contact && !W[2].contact, rightOff = !W[1].contact && !W[3].contact;
    const st: RolloverState = c < -0.5 ? 'onRoof' : c < 0.45 ? 'onSide' : wheels && c < 0.97 && leftOff !== rightOff ? 'twoWheels' : 'upright';
    // A new state counts once it has held for ROLL_HOLD s (a floating or rocking body does not flip the state every step).
    if (st === v.rollover) { v.rollCand = st; v.rollTime = 0; return; }
    if (st !== v.rollCand) { v.rollCand = st; v.rollTime = 0; }
    v.rollTime += dt;
    if (v.rollTime < ROLL_HOLD) return;
    const prev = v.rollover;
    v.rollover = st;
    if (ROLL_EVENT.includes(st) || ROLL_EVENT.includes(prev)) {
      ctx.recordDamage(e, { eventType: 'VEHICLE_ROLLOVER', cause: 'rollover', hazard: e.lastHazard ?? 'vehicle', vehicle: { kind: 'rollover', level: st }, response: v.ltr });
      ctx.log(e.id, 'danger', { key: 'log.vehicle.rollover', params: { state: st } });
      if (ROLL_EVENT.includes(st)) for (const o of v.occupants) if (o.state === 'seated' && !o.restrained) this.eject(ctx, e, v, o, ctx.time);
    }
  }

  /**
   * Engine stopped by water (assumed rule): the water surface reaches the air intake (half the body height above the body base)
   * or the vehicle floats (buoyancy ≥ 90 % of the weight with no wheel on the ground) for 1 s — the intake then takes water.
   */
  private stall(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, dt: number) {
    const f = e.flood;
    if (v.stalled || !f) return;
    const intake = e.pose.position[1] + INTAKE_SHARE * v.geo.dims.height;
    const floating = v.dyn.touching === 0 && f.buoyancyRatio >= 0.9;
    v.floatTime = floating ? v.floatTime + dt : 0;
    if (!(f.surface >= intake || v.floatTime >= 1)) return;
    v.stalled = true;
    ctx.recordDamage(e, { eventType: 'VEHICLE_STALLED', cause: 'stall', hazard: 'flood', vehicle: { kind: floating ? 'stallFloating' : 'stall' }, response: f.buoyancyRatio });
    ctx.log(e.id, 'danger', { key: 'log.vehicle.stalled' });
  }

  /** Mechanical energy: translation + rotation + wheel spin + potential (uniform local g at the COM) + spring energy. */
  private energy(ctx: SystemContext, v: VehicleEntity, vel: Vec3, w: Vec3, pose: { position: Vec3; quaternion: readonly number[] }) {
    const com = rotate(pose.quaternion as [number, number, number, number], v.geo.com);
    com[0] += pose.position[0]; com[1] += pose.position[1]; com[2] += pose.position[2];
    const g = ctx.env.gravity.at(com[0], com[1], com[2], [0, 0, 0]);
    let wheel = 0;
    for (const W of v.dyn.wheels) wheel += 0.5 * v.geo.spec.wheelInertia * W.omega * W.omega;
    v.energy.ke = kineticEnergy(v, vel, w, pose.quaternion) + wheel;
    v.energy.pe = -v.geo.mass * (g[0] * com[0] + g[1] * com[1] + g[2] * com[2]);
    v.energy.E = v.energy.ke + v.energy.pe + v.dyn.springEnergy;
    if (Number.isNaN(v.energy.E0)) v.energy.E0 = v.energy.E;
    const L = v.dyn.ledger;
    // ΔE = drive − brake − rolling − tyre slip − damper − aero − collision losses + (other forces: hazards, Rapier contacts, numerics).
    v.energy.residual = v.energy.E - v.energy.E0 - (L.drive - L.brake - L.rolling - L.slip - L.damper - L.aero - v.energy.collision);
  }

  private occupants(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, pose: { position: Vec3; quaternion: readonly number[] }) {
    for (const o of v.occupants) {
      if (o.state !== 'seated') continue;
      const he = ctx.runtime.entities.get(o.human);
      if (!he || he.body === null) { o.state = 'outside'; continue; }
      if (!he.occupant) {
        he.occupant = { vehicle: e.id, seat: o.seat };
        ctx.physics.setBodyEnabled(he.body, false);
      }
      const s = rotate(pose.quaternion as [number, number, number, number], seatLocal(v, o.seat));
      he.pose.position[0] = pose.position[0] + s[0];
      he.pose.position[1] = pose.position[1] + s[1];
      he.pose.position[2] = pose.position[2] + s[2];
      for (let k = 0; k < 4; k++) he.pose.quaternion[k] = pose.quaternion[k];
      // Seat acceleration magnitude (the occupant follows the seat — Level A).
      const am = Math.hypot(v.accel[0], v.accel[1], v.accel[2]);
      if (am > o.peakAccel) o.peakAccel = am;
    }
  }

  private eject(ctx: SystemContext, e: RuntimeEntity, v: VehicleEntity, o: VehicleEntity['occupants'][number], t: number) {
    const he = ctx.runtime.entities.get(o.human);
    o.state = 'ejected';
    o.ejectedAt = t;
    if (!he || he.body === null) return;
    const pose = ctx.physics.getPose(e.body!);
    const s = rotate(pose.quaternion, seatLocal(v, o.seat));
    const side = rotate(pose.quaternion, [0, 1.2, o.seat === 'driver' || o.seat === 'rearLeft' ? -0.8 * v.geo.dims.width : 0.8 * v.geo.dims.width]);
    const p: Vec3 = [pose.position[0] + s[0] + side[0], pose.position[1] + s[1] + side[1], pose.position[2] + s[2] + side[2]];
    const vel = ctx.physics.getLinearVelocity(e.body!), w = ctx.physics.getAngularVelocity(e.body!);
    const com = rotate(pose.quaternion, v.geo.com);
    const r: Vec3 = [p[0] - pose.position[0] - com[0], p[1] - pose.position[1] - com[1], p[2] - pose.position[2] - com[2]];
    const vp: Vec3 = [vel[0] + w[1] * r[2] - w[2] * r[1], vel[1] + w[2] * r[0] - w[0] * r[2], vel[2] + w[0] * r[1] - w[1] * r[0]];
    ctx.physics.setBodyEnabled(he.body, true);
    ctx.physics.setBodyPose(he.body, p, [0, 0, 0, 1]);
    ctx.physics.setVelocity(he.body, vp, [0, 0, 0]);
    he.occupant = undefined;
    ctx.recordDamage(he, { eventType: 'OCCUPANT_EJECTED', cause: v.rollover === 'upright' ? 'collision' : 'rollover', hazard: e.lastHazard ?? 'vehicle', vehicle: { kind: 'ejected', partner: e.id } });
    ctx.log(e.id, 'danger', { key: 'log.vehicle.ejected', params: { human: he.id } });
  }

  /** The vehicle's body is gone (captured, removed): seated occupants are put back into the world where they are. */
  private releaseOccupants(ctx: SystemContext, v: VehicleEntity) {
    for (const o of v.occupants) if (o.state === 'seated') {
      const he = ctx.runtime.entities.get(o.human);
      o.state = 'outside';
      if (!he) continue;
      he.occupant = undefined;
      if (he.body !== null && ctx.physics.hasBody(he.body)) ctx.physics.setBodyEnabled(he.body, true);
    }
  }

  private seriesPush(v: VehicleEntity, vel: Vec3, w: Vec3, x: Vec3, z: Vec3, t: number) {
    const s = v.series!;
    const last = s.t.length ? s.t[s.t.length - 1] : -Infinity;
    if (t - last < s.dt - 1e-9) return;
    const W = v.dyn.wheels;
    const roll = Math.asin(Math.max(-1, Math.min(1, z[1]))), pitch = Math.asin(Math.max(-1, Math.min(1, x[1])));
    const vals: Record<(typeof VEHICLE_SERIES_KEYS)[number], number> = {
      speed: dot(vel, x), accelLong: v.accel[0], accelLat: v.accel[2], yawRate: w[1], roll, pitch,
      wheelSpeed: W.reduce((a, b) => a + b.omega, 0) / 4 * v.geo.spec.wheelRadius,
      slip: Math.max(...W.map((b) => Math.abs(b.kappa))), load: v.ltr,
      drive: W.reduce((a, b) => a + b.driveT, 0), brake: W.reduce((a, b) => a + b.brakeT, 0),
      damage: v.damage.index, energy: v.energy.residual,
    };
    s.t.push(t);
    for (const k of VEHICLE_SERIES_KEYS) s.v[k].push(vals[k]);
    if (s.t.length >= VEHICLE_SERIES_MAX) {
      const keep = (a: number[]) => a.filter((_, i) => i % 2 === 0);
      s.t = keep(s.t);
      for (const k of VEHICLE_SERIES_KEYS) s.v[k] = keep(s.v[k]);
      s.dt *= 2;
    }
  }
}

