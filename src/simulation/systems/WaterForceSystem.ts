/**
 * WaterPhysicsAdapter (Phase 14, prePhysics): water → forces on Rapier bodies.
 *
 * For every free body (cars, people, toppled poles, snapped trees, debris) partly under water:
 *
 *   buoyancy  F_b = ρ_w · g · V_eff · s            (s = submerged fraction of the body height)
 *   drag      F_d = ½ · ρ_w · C_d · A_sub · |u − v| · (u − v)   (u water, v body velocity)
 *
 * both applied at the center of the submerged part, so lifting, tilting, sliding and being
 * carried along come out of Rapier's contact/friction solution — nothing is scripted. Reduced
 * grip in water is mostly the buoyancy itself: it takes weight off the contact, so the friction
 * force the ground can provide drops (Coulomb friction ∝ normal force).
 *
 * V_eff (displaced volume when fully under water) is approximate per object type:
 *   car     sealed body: (0.05 + 0.55·(1 − ingress)) × bounding box — floats at roughly
 *           0.3–0.5 m of water depending on its mass, sinks again as the cabin floods
 *   person  mass / 985 kg/m³ (close to neutral)
 *   debris  mass / material density (roof panels float, concrete chunks sink)
 * Drag is capped so one step never reverses the relative velocity (stiff for light debris).
 *
 * The water field is read only; nothing here changes the water (no displacement, no wakes —
 * see docs/FLOOD.md limitations). Idle until the water model is active.
 */
import type { Quat, Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { qRotateInto } from '@/core/math';
import { boxProjectedArea } from '../damage/windLoad';
import type { DebrisPiece, RuntimeEntity } from '../SimulationRuntime';
import type { WaterField } from '../water/WaterField';
import { WATER_DENSITY } from '../water/waterParams';
import { ensureFloodRuntime, type FloodEntityState } from '../flood/FloodState';
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';

/** Car: sealed fraction of the bounding box when dry, and with a flooded cabin. */
export const CAR_SEALED = 0.55;
export const CAR_SOLID = 0.05;
/** Car floor height above the bottom of the body (m) and cabin flooding time constant (s). */
export const CAR_FLOOR = 0.35;
export const CAR_INGRESS_TAU = 120;

const DEBRIS_DENSITY: Record<string, number> = {
  structure: 2300, wall: 1800, roof: 550, window: 2500, sign: 700, exterior: 1200, trunk: 650, canopy: 350,
};
const TYPE_DENSITY: Record<string, number> = { human: 985, tree: 650, streetLight: 4000, sign: 3000, wall: 1800 };
const CD: Record<string, number> = { car: 1.0, human: 1.1, tree: 0.9 };

const ux: Vec3 = [0, 0, 0];
const uy: Vec3 = [0, 0, 0];
const uz: Vec3 = [0, 0, 0];
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const vel: [number, number] = [0, 0];
const local: Vec3 = [0, 0, 0];
const dirW: Vec3 = [0, 0, 0];
const force: Vec3 = [0, 0, 0];
const point: Vec3 = [0, 0, 0];
const qc: Quat = [0, 0, 0, 1];

/** Displaced volume (m³) of a body fully under water. */
export function effectiveVolume(e: RuntimeEntity): number {
  const box = e.dims[0] * e.dims[1] * e.dims[2];
  if (e.source.type === 'car') return box * (CAR_SOLID + CAR_SEALED * (1 - (e.flood?.ingress ?? 0)));
  return e.source.physics.mass / (TYPE_DENSITY[e.source.type] ?? 2000);
}

interface BodyGeom {
  /** Center of the bounding box (world). */
  cx: number;
  cy: number;
  cz: number;
  /** Half height of the rotated box along world Y. */
  hy: number;
}
const geom: BodyGeom = { cx: 0, cy: 0, cz: 0, hy: 0 };

function boxGeom(pos: Vec3, q: Quat, dims: Vec3, centerOffsetY: number, out: BodyGeom): BodyGeom {
  qRotateInto(ux, q, X);
  qRotateInto(uy, q, Y);
  qRotateInto(uz, q, Z);
  out.cx = pos[0] + uy[0] * centerOffsetY;
  out.cy = pos[1] + uy[1] * centerOffsetY;
  out.cz = pos[2] + uy[2] * centerOffsetY;
  out.hy = 0.5 * (Math.abs(ux[1]) * dims[0] + Math.abs(uy[1]) * dims[1] + Math.abs(uz[1]) * dims[2]);
  return out;
}

/**
 * Apply buoyancy + drag to one body. Returns the submerged fraction (0 = dry). Writes the water
 * sample into `st` when given.
 */
function applyWater(
  physics: PhysicsEngine, field: WaterField, body: number, pos: Vec3, q: Quat, dims: Vec3, centerOffsetY: number,
  volume: number, cd: number, areaFactor: number, dt: number, st: FloodEntityState | null, rest: { lastEta?: number },
): number {
  const g = boxGeom(pos, q, dims, centerOffsetY, geom);
  const eta = field.sampleSurface(g.cx, g.cz);
  if (st) {
    st.surface = eta;
    field.sampleVelocity(g.cx, g.cz, st.flow);
    st.speed = Math.hypot(st.flow[0], st.flow[1]);
    st.depth = eta === -Infinity ? 0 : Math.max(0, eta - field.terrain.sampleHeight(g.cx, g.cz));
  }
  const bottom = g.cy - g.hy;
  const height = 2 * g.hy;
  const sub = eta === -Infinity ? 0 : Math.min(height, eta - bottom);
  if (sub <= 0) {
    if (st) {
      st.submerged = 0;
      st.buoyancy = 0;
      st.buoyancyRatio = 0;
      st.dominant = false;
    }
    return 0;
  }
  const frac = sub / height;
  const m = physics.getMass(body);
  const buoy = WATER_DENSITY * GRAVITY * volume * frac;
  if (st) {
    st.submerged = frac;
    st.buoyancy = buoy;
    st.buoyancyRatio = buoy / (m * GRAVITY);
  }
  const uw = st ? st.flow : field.sampleVelocity(g.cx, g.cz, vel);
  // Still water around a resting body: keep the static load without waking it.
  if (physics.isSleeping(body) && Math.abs(uw[0]) + Math.abs(uw[1]) < 0.05 && Math.abs(eta - (rest.lastEta ?? -Infinity)) < 0.01) {
    physics.addForceAtPoint(body, [0, buoy, 0], [g.cx, bottom + sub / 2, g.cz], false);
    return frac;
  }
  rest.lastEta = eta;
  const v = physics.getLinearVelocity(body);
  const rx = uw[0] - v[0];
  const ry = -v[1];
  const rz = uw[1] - v[2];
  const rel = Math.sqrt(rx * rx + ry * ry + rz * rz);
  force[0] = 0;
  force[1] = buoy;
  force[2] = 0;
  let drag = 0;
  if (rel > 0.02) {
    dirW[0] = rx / rel;
    dirW[1] = ry / rel;
    dirW[2] = rz / rel;
    qc[0] = -q[0]; qc[1] = -q[1]; qc[2] = -q[2]; qc[3] = q[3];
    const area = boxProjectedArea(dims, qRotateInto(local, qc, dirW)) * frac * areaFactor;
    drag = 0.5 * WATER_DENSITY * cd * area * rel * rel;
    // Implicit-drag cap: one step must not overshoot the water velocity.
    const cap = (0.5 * m * rel) / dt;
    if (drag > cap) drag = cap;
    force[0] += dirW[0] * drag;
    force[1] += dirW[1] * drag;
    force[2] += dirW[2] * drag;
  }
  point[0] = g.cx;
  point[1] = bottom + sub / 2;
  point[2] = g.cz;
  physics.addForceAtPoint(body, force, point);
  if (st) st.load = Math.hypot(force[0], force[2]);
  return frac;
}

export class WaterForceSystem implements SimulationSystem {
  readonly name = 'waterForce';
  readonly phase = 'prePhysics' as const;

  update(ctx: SystemContext, dt: number) {
    const field = ctx.env.flood.field;
    if (!field || !field.hasWater()) return;
    const { physics, runtime } = ctx;
    ensureFloodRuntime(runtime);
    for (const e of runtime.entities.values()) {
      if (!e.dynamic || e.body === null || e.def.inert) continue;
      const st = e.flood!;
      const type = e.source.type;
      // Cars: the cabin floods while water stands above the floor (sealed volume shrinks).
      if (type === 'car' && st.depth > CAR_FLOOR) {
        const above = Math.min(1, (st.depth - CAR_FLOOR) / Math.max(0.3, e.dims[1] - CAR_FLOOR));
        st.ingress += ((1 - st.ingress) * above * dt) / CAR_INGRESS_TAU;
      }
      // Body origin sits at the base: the box center is dims.y / 2 up the body's own axis.
      applyWater(physics, field, e.body, e.pose.position, e.pose.quaternion, e.dims, e.dims[1] / 2, effectiveVolume(e), CD[type] ?? 1.2, e.areaFactor, dt, st, st);
      // The water dominates when its drag exceeds the wind load on the body.
      st.dominant = st.submerged > 0 && st.load > Math.max(50, e.windLoad);
    }
    for (const d of runtime.debris) this.debris(physics, field, d, dt);
  }

  private debris(physics: PhysicsEngine, field: WaterField, d: DebrisPiece, dt: number) {
    // Material volume = mass / density (a box is partly hollow), at most the box itself:
    // light roof panels float, concrete chunks sink.
    const box = d.size[0] * d.size[1] * d.size[2];
    const volume = Math.min(box, d.mass / (DEBRIS_DENSITY[d.kind] ?? 2000));
    applyWater(physics, field, d.body, d.pose.position, d.pose.quaternion, d.size, 0, volume, 1.15, 1, dt, null, d);
  }
}
