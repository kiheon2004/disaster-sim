/**
 * Phase 35: vehicle geometry and mass properties (level A — rigid-body mechanics).
 *
 * Local frame of the car object (as the legacy car): +X forward (length), +Y up, +Z to the right side (width; right = forward × up), so a positive yaw about +Y turns left; origin on the
 * ground under the body centre. The body mass m (the legacy L·W·H·120 kg) is split into the chassis box (85 % of the sprung
 * part), the cabin box (15 %) and four wheels (point masses at the wheel centres, plus their own spin inertia about the axle).
 * The centre of mass and the inertia tensor about it come from the parts by the parallel-axis theorem:
 *   box (a × b × c, mass M) about its centre:  I_xx = M(b² + c²)/12,  I_yy = M(a² + c²)/12,  I_zz = M(a² + b²)/12
 *   part offset d from the COM:                I += M(|d|² 1 − d dᵀ)
 * Static axle loads follow from the COM position (statics, §71 check).
 */
import type { Vec3 } from '@/core/types';
import { VARIANTS, type Variant, type VariantSpec } from './params';

export interface CarDims { variant: Variant; length: number; width: number; height: number }

export interface Part { mass: number; centre: Vec3; size?: Vec3; spin?: number }

export interface VehicleGeometry {
  spec: VariantSpec;
  dims: CarDims;
  mass: number;
  /** Centre of mass (local, m) and the inertia tensor about it (kg·m², row-major 3×3). */
  com: Vec3;
  inertia: number[];
  /** Principal-axis approximation passed to the physics engine (the diagonal; |products| reported). */
  inertiaDiag: Vec3;
  maxProduct: number;
  wheelbase: number;
  track: number;
  /** Wheel centres at static ride height (local), order FL, FR, RL, RR. */
  wheels: Vec3[];
  /** Suspension mount (top of the strut, local) per wheel; the strut runs along −Y from it. */
  mounts: Vec3[];
  /** Free (uncompressed) strut length from the mount to the wheel centre (m), static compression (m). */
  freeLength: number[];
  staticCompression: number[];
  /** Spring stiffness (N/m), damping (N·s/m) per wheel; static wheel loads (N) at reference gravity. */
  k: number[];
  c: number[];
  staticLoad: number[];
  /** Chassis / cabin collider boxes (local centre, half extents) and the parts used for the mass properties. */
  chassis: { centre: Vec3; half: Vec3 };
  cabin: { centre: Vec3; half: Vec3 };
  parts: Part[];
  /** Height of the COM above the ground at static ride (m), static front / rear axle load shares. */
  hcg: number;
  frontShare: number;
}

export const G0 = 9.80665;

function boxInertia(M: number, s: Vec3): Vec3 {
  return [(M * (s[1] * s[1] + s[2] * s[2])) / 12, (M * (s[0] * s[0] + s[2] * s[2])) / 12, (M * (s[0] * s[0] + s[1] * s[1])) / 12];
}

/** Mass, COM and inertia tensor of a set of parts (boxes with their own central inertia, point masses with an axle spin inertia about local Z). */
export function composite(parts: Part[]): { mass: number; com: Vec3; inertia: number[] } {
  let M = 0;
  const c: Vec3 = [0, 0, 0];
  for (const p of parts) {
    M += p.mass;
    for (let i = 0; i < 3; i++) c[i] += p.mass * p.centre[i];
  }
  for (let i = 0; i < 3; i++) c[i] /= M;
  const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of parts) {
    const own: Vec3 = p.size ? boxInertia(p.mass, p.size) : [0, 0, p.spin ?? 0];
    I[0] += own[0]; I[4] += own[1]; I[8] += own[2];
    const d: Vec3 = [p.centre[0] - c[0], p.centre[1] - c[1], p.centre[2] - c[2]];
    const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[3 * i + j] += p.mass * ((i === j ? d2 : 0) - d[i] * d[j]);
  }
  return { mass: M, com: c, inertia: I };
}

export function vehicleGeometry(d: CarDims, mass: number, g = G0): VehicleGeometry {
  const spec = VARIANTS[d.variant] ?? VARIANTS.sedan;
  const L = d.length, W = d.width, H = d.height;
  const wb = spec.wheelbaseShare * L, tr = spec.trackShare * W, R = spec.wheelRadius;
  // Body boxes as the legacy colliders, the chassis raised to the clearance (it no longer reaches the ground: the wheels carry it).
  const clr = spec.clearance;
  const chassisH = (H - 0.32) * 0.5;
  const chassisTop = 0.32 + chassisH;
  const cabinH = H - chassisTop;
  const cabinL = d.variant === 'truck' ? L * 0.98 : L * 0.55;
  const chassis = { centre: [0, (clr + chassisTop) / 2, 0] as Vec3, half: [L / 2, (chassisTop - clr) / 2, W / 2] as Vec3 };
  const cabin = { centre: [d.variant === 'truck' ? 0 : -L * 0.05, chassisTop + cabinH / 2, 0] as Vec3, half: [cabinL / 2, cabinH / 2, W * 0.45] as Vec3 };
  const wheels: Vec3[] = [[wb / 2, R, -tr / 2], [wb / 2, R, tr / 2], [-wb / 2, R, -tr / 2], [-wb / 2, R, tr / 2]];
  const mw = Math.min(spec.wheelMass, mass * 0.03);
  const body = mass - 4 * mw;
  const parts: Part[] = [
    { mass: 0.85 * body, centre: chassis.centre, size: [2 * chassis.half[0], 2 * chassis.half[1], 2 * chassis.half[2]] },
    { mass: 0.15 * body, centre: cabin.centre, size: [2 * cabin.half[0], 2 * cabin.half[1], 2 * cabin.half[2]] },
    ...wheels.map((w) => ({ mass: mw, centre: w, spin: spec.wheelInertia })),
  ];
  const { com, inertia } = composite(parts);
  // Static axle loads (statics about the axles, level ground): F_front = m g (x_com − x_rear) / wb.
  const frontShare = (com[0] + wb / 2) / wb;
  const staticLoad = [0, 1, 2, 3].map((i) => (mass * g * (i < 2 ? frontShare : 1 - frontShare)) / 2);
  // Corner spring from the sprung corner mass and the ride frequency: k = m_c (2π f)²; c = 2 ζ √(k m_c).
  const k = staticLoad.map((F) => (F / g) * (2 * Math.PI * spec.rideHz) ** 2);
  const c = staticLoad.map((F, i) => 2 * spec.damping * Math.sqrt(k[i] * (F / g)));
  const staticCompression = staticLoad.map((F, i) => F / k[i]);
  // Mount: the free strut reaches rebound travel below the static wheel centre.
  const freeLength = staticCompression.map((x) => x + spec.rebound);
  const mounts = wheels.map((w, i) => [w[0], w[1] + freeLength[i] - staticCompression[i], w[2]] as Vec3);
  const maxProduct = Math.max(Math.abs(inertia[1]), Math.abs(inertia[2]), Math.abs(inertia[5]));
  return {
    spec, dims: d, mass, com, inertia, inertiaDiag: [inertia[0], inertia[4], inertia[8]], maxProduct, wheelbase: wb, track: tr, wheels, mounts,
    freeLength, staticCompression, k, c, staticLoad, chassis, cabin, parts, hcg: com[1], frontShare,
  };
}

/**
 * Level 1 ('rigid'): the legacy colliders (chassis box from the ground, cabin box; 85 / 15 % of the mass, wheels drawn only)
 * with their exact composite COM and inertia (the legacy body took Rapier's collider-density mass properties, the same
 * boxes — this makes the inertia explicit and documented).
 */
export function rigidMassProps(g: VehicleGeometry): { com: Vec3; inertia: Vec3 } {
  const { length: L, width: W, height: H, variant } = g.dims;
  const chassisH = (H - 0.32) * 0.5;
  const cabinH = H - 0.32 - chassisH;
  const cabinL = variant === 'truck' ? L * 0.98 : L * 0.55;
  const c = composite([
    { mass: 0.85 * g.mass, centre: [0, (chassisH + 0.32) / 2, 0], size: [L, chassisH + 0.32, W] },
    { mass: 0.15 * g.mass, centre: [variant === 'truck' ? 0 : -L * 0.05, 0.32 + chassisH + cabinH / 2, 0], size: [cabinL, cabinH, W * 0.9] },
  ]);
  return { com: c.com, inertia: [c.inertia[0], c.inertia[4], c.inertia[8]] };
}
