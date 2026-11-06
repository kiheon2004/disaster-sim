/**
 * Phase 35: vehicle collision episodes (read from Rapier's contacts — the solver resolves every collision; nothing here adds a
 * force or an impulse).
 *
 * Rapier reports per step the solver's contact impulse divided by the step (`detail.F`, N, the step-mean contact force on body a),
 * so the impulse of a step is J = F·Δt; an EPISODE is the run of contact steps between the vehicle and one partner (gaps up to
 * 2 steps join, at most 30 steps — a longer contact starts a new episode). Per episode: Σ J (N·s, vector), the peak step-mean
 * force, the impulse-weighted contact point, the vehicle's velocity before (the step before the first contact) and after (the
 * step after the last), its Δv, the closing speed along the first normal, its kinetic energy (translation + rotation) before
 * and after. The kinetic energy the vehicle lost is NOT all deformation: it goes to the partner, the ground, rotation, friction,
 * vibration and the solver's restitution / numerical dissipation — reported as "kinetic energy lost by the vehicle" only.
 *
 * Damage (educational index, no crash-test data): the episode Δv as an equivalent barrier speed proxy; cumulative index
 * √(Σ Δv²) / 20 m/s with levels damaged ≥ 3, severely damaged ≥ 7, disabled ≥ 12, destroyed ≥ 20 m/s (assumed thresholds);
 * a rollover onto the roof disables, water above the engine intake stalls. Levels limit drive / steering / brakes.
 * Contacts below the body's contact-force threshold (2.5 m g) are not reported by the engine (resting contact) — a limit.
 *
 * Partners: other vehicles (their own episode with this one — momentum exchange checked by tests), people (the Phase 33
 * contact episode of the person does the injury index; nothing is added here), modular buildings and anchored structures (the
 * Phase 25 strike model with the vehicle as the striker: E = J² / 2m against the member reserve / the base moment).
 */
import type { Vec3 } from '@/core/types';
import type { BodyUserData, ContactEvent } from '@/physics/PhysicsEngine';
import type { SystemContext } from '../systems/SimulationSystem';
import type { DebrisPiece, RuntimeEntity } from '../SimulationRuntime';
import { strikeAnchored, strikeBuilding } from '../structure/secondary';
import type { CollisionEpisode, VehicleDamageLevel, VehicleEntity } from './state';

export const EPISODE_GAP_STEPS = 2;
export const EPISODE_MAX_STEPS = 30;
export const DAMAGE_DV = [3, 7, 12, 20];
export const DAMAGE_REF_DV = 20;
const ANCHORED = new Set(['streetLight', 'sign', 'wall', 'tree']);

export function kineticEnergy(v: VehicleEntity, vel: readonly number[], w: readonly number[], q: readonly number[]): number {
  // Rotation: ½ ωᵀ I ω with the principal (diagonal) inertia in body axes; ω in body axes = conj(q) ω conj(q)⁻¹.
  const [x, y, z, s] = q;
  const cx = -x, cy = -y, cz = -z;
  const ux = 2 * (cy * w[2] - cz * w[1]), uy = 2 * (cz * w[0] - cx * w[2]), uz = 2 * (cx * w[1] - cy * w[0]);
  const wb = [w[0] + s * ux + (cy * uz - cz * uy), w[1] + s * uy + (cz * ux - cx * uz), w[2] + s * uz + (cx * uy - cy * ux)];
  const I = v.geo.inertiaDiag;
  return 0.5 * v.geo.mass * (vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]) + 0.5 * (I[0] * wb[0] * wb[0] + I[1] * wb[1] * wb[1] + I[2] * wb[2] * wb[2]);
}

function partnerOf(ctx: SystemContext, other: BodyUserData | null): { id: string; kind: CollisionEpisode['partnerKind']; entity?: RuntimeEntity } {
  if (!other) return { id: 'ground', kind: 'ground' };
  if (other.debrisId) return { id: other.debrisId, kind: 'debris' };
  if (other.entityId.startsWith('rubble:')) return { id: other.entityId, kind: 'debris' };
  const o = ctx.runtime.entities.get(other.entityId);
  if (!o) return { id: other.entityId, kind: 'object' };
  const t = o.source.type;
  return { id: o.id, kind: t === 'car' ? 'vehicle' : t === 'human' ? 'human' : t === 'building' || ANCHORED.has(t) ? 'structure' : 'object', entity: o };
}

/** A contact event of a vehicle-mode car (`isA`: the car is body a of the event). Called by the DamageSystem. */
export function vehicleContact(ctx: SystemContext, e: RuntimeEntity, other: BodyUserData | null, ev: ContactEvent, isA: boolean, dt: number) {
  const v = e.vehicle!;
  const d = ev.detail;
  if (!d) return;
  const s = isA ? 1 : -1;
  const F: Vec3 = [s * d.F[0], s * d.F[1], s * d.F[2]];
  const p = partnerOf(ctx, other);
  let ep = v.open.get(p.id);
  if (!ep) {
    const n: Vec3 = [s * d.n[0], s * d.n[1], s * d.n[2]];
    let rel = 0;
    const pv = p.entity && p.entity.body !== null && ctx.physics.hasBody(p.entity.body) ? (p.entity.vehicle ? p.entity.vehicle.prevV : ctx.physics.getLinearVelocity(p.entity.body)) : [0, 0, 0];
    rel = Math.abs((v.prevV[0] - pv[0]) * n[0] + (v.prevV[1] - pv[1]) * n[1] + (v.prevV[2] - pv[2]) * n[2]);
    const pose = e.pose;
    ep = {
      partner: p.id, partnerKind: p.kind, start: ctx.time, end: ctx.time, impulse: [0, 0, 0], peakForce: 0, point: [0, 0, 0],
      vBefore: [...v.prevV] as Vec3, vAfter: [0, 0, 0], dv: 0, closing: rel,
      keBefore: kineticEnergy(v, v.prevV, v.prevW, pose.quaternion), keAfter: 0, open: true, steps: 0, recorded: false,
    };
    v.open.set(p.id, ep);
  }
  const J = Math.hypot(F[0], F[1], F[2]) * dt;
  const Jt = Math.hypot(ep.impulse[0], ep.impulse[1], ep.impulse[2]);
  for (let k = 0; k < 3; k++) {
    ep.point[k] = Jt + J > 0 ? (ep.point[k] * Jt + d.P[k] * J) / (Jt + J) : d.P[k];
    ep.impulse[k] += F[k] * dt;
  }
  ep.peakForce = Math.max(ep.peakForce, Math.hypot(F[0], F[1], F[2]));
  ep.end = ctx.time;
  (ep as CollisionEpisode & { lastStep?: number }).lastStep = ctx.step;
  ep.steps++;
  // Structures struck by the vehicle: the Phase 25 strike model with the vehicle as the striker (once per contact step).
  if (p.entity && p.kind === 'structure') {
    const striker = {
      id: `vehicle:${e.id}`, sourceId: e.id, kind: 'structure', body: e.body!, size: [v.geo.dims.length, v.geo.dims.height, v.geo.dims.width] as Vec3, color: '#000000',
      mass: v.geo.mass, plate: false, pose: { position: [d.P[0], d.P[1], d.P[2]] as Vec3, quaternion: e.pose.quaternion }, spawnTime: 0, hazard: e.lastHazard ?? 'vehicle',
    } as DebrisPiece;
    const force = Math.hypot(F[0], F[1], F[2]);
    if (p.entity.source.type === 'building') strikeBuilding(ctx, p.entity, striker, force);
    else strikeAnchored(ctx, p.entity, striker, force);
  }
}

export function damageLevel(dvEq: number): VehicleDamageLevel {
  return dvEq >= DAMAGE_DV[3] ? 'destroyed' : dvEq >= DAMAGE_DV[2] ? 'disabled' : dvEq >= DAMAGE_DV[1] ? 'severelyDamaged' : dvEq >= DAMAGE_DV[0] ? 'damaged' : 'intact';
}

/** Capability left by a damage level: drive, steering, brakes (assumed educational factors). */
export const DAMAGE_AVAIL: Record<VehicleDamageLevel, [number, number, number]> = {
  intact: [1, 1, 1], damaged: [1, 1, 1], severelyDamaged: [0.6, 0.8, 0.8], disabled: [0, 0.3, 0.5], destroyed: [0, 0, 0],
};
