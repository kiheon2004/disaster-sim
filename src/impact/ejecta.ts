/**
 * Ejecta as AGGREGATED PARCELS (Phase 23) — never one rigid body per fragment.
 *
 * The excavated material that leaves the crater is split into parcels by launch radius x (rings,
 * HH11 mass and speed at x, see crater.ts) and azimuth. Each parcel carries a mass and a
 * representative fragment size and flies a ballistic path with gravity and air drag until it meets
 * the ground (or leaves the world — recorded as outflow); there it is deposited as loose material
 * spread over its landing footprint. The flight is integrated once at launch (deterministic) and
 * the deposit happens at the computed landing time.
 *
 * Assumptions (labelled):
 *  - launch angle 45° from the horizontal (the value used with HH11; lab ejecta curtains are
 *    ~40–50°);
 *  - representative fragment diameter decreases with launch speed, d ∝ 1/v (the trend reported for
 *    secondary-crater fragments, Vickery 1986/87), anchored at d_ref for 10 m/s and clamped to
 *    [2 mm, 1 m]; d_ref = 0.3 m for rock, 0.03 m for soils (clods) — an assumption, not a measured
 *    distribution. Drag a = 3·C_d·ρ_a·v² / (4·ρ_s·d), C_d = 1, on single fragments (the ejecta
 *    curtain's collective shielding is not modelled, so drag is an upper estimate);
 *  - oblique impacts: mass is shifted downrange below 45° and an uprange zone is left empty below
 *    25° (qualitative Gault & Wedekind 1978 observations, simple cosine weighting — labelled);
 *  - seeded azimuthal irregularity of ±15 % in mass and ±4° in direction.
 * Fine dust that stays suspended in the air is NOT part of this budget: dust in the view is a
 * visual effect only.
 */
import { GRAVITY } from '@/core/units';
import { Rng } from '@/core/random';
import { RHO0 } from './entry';
import type { CraterResult } from './crater';
import { ejectedMass, launchSpeed } from './crater';

export const LAUNCH_ANGLE = 45;
export const RINGS = 16;
export const SECTORS = 24;
const CD_FRAG = 1;
const FLIGHT_DT = 0.01;

export interface Parcel {
  id: number;
  ring: number;
  /** Launch time after impact (s), position (world x, y, z), velocity (m/s). */
  t0: number;
  p0: [number, number, number];
  v0: [number, number, number];
  /** Mass (kg), in-situ volume (m³), representative fragment diameter (m), launch speed (m/s). */
  mass: number;
  volume: number;
  size: number;
  speed: number;
  /** Footprint half-widths at landing: radial / tangential (m). */
  spreadR: number;
  spreadT: number;
  /** Filled by fly(): landing time after impact, landing point, landing speed; or outflow. */
  t1: number;
  p1: [number, number, number];
  v1: number;
  outflow: boolean;
  /** Path samples every 0.05 s (for rendering): x, y, z triples. */
  path: Float32Array;
}

export interface EjectaInput {
  crater: CraterResult;
  center: [number, number, number];
  /** Projectile density (kg/m³), target density (kg/m³), target is rock (fragment size anchor). */
  delta: number;
  rho: number;
  rock: boolean;
  /** Impact angle (deg) and bearing of travel (deg). */
  angle: number;
  azimuth: number;
  seed: number;
}

/** Mass weight of an azimuth (radians from downrange) for an oblique impact; normalized later. */
export function azimuthWeight(phi: number, angleDeg: number): number {
  if (angleDeg >= 45) return 1;
  const A = Math.min(0.8, ((45 - angleDeg) / 30) * 0.8);
  let w = 1 + A * Math.cos(phi);
  // Uprange "forbidden zone" below 25°: ±(25 − θ)·3° around uprange.
  if (angleDeg < 25) {
    const half = ((25 - angleDeg) * 3 * Math.PI) / 180;
    const fromUp = Math.abs(Math.atan2(Math.sin(phi - Math.PI), Math.cos(phi - Math.PI)));
    if (fromUp < half) w = 0;
  }
  return w;
}

export function generateParcels(i: EjectaInput): Parcel[] {
  const c = i.crater, set = c.set, R = c.radius;
  const rng = new Rng(i.seed ^ 0xe1ec7a);
  const xMax = Math.min(set.n2, 1) * R;
  const x0 = Math.max(set.n1 * c.a, 0.05 * R);
  if (!(xMax > x0) || c.ejectedVolume <= 0) return [];
  const total = ejectedMass(set, xMax, c.a, i.rho);
  // Cap: never more than the excavated bowl (crater.ejectedVolume already capped).
  const scale = Math.min(1, (c.ejectedVolume * i.rho) / Math.max(1e-9, total));
  const [dx, dz] = [Math.sin((i.azimuth * Math.PI) / 180), -Math.cos((i.azimuth * Math.PI) / 180)];
  const down = Math.atan2(dz, dx);
  const weights = Array.from({ length: SECTORS }, (_, s) => azimuthWeight(((s + 0.5) / SECTORS) * 2 * Math.PI, i.angle));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const parcels: Parcel[] = [];
  const th = (LAUNCH_ANGLE * Math.PI) / 180;
  const dRef = i.rock ? 0.3 : 0.03;
  let id = 0;
  for (let r = 0; r < RINGS; r++) {
    const xa = x0 * (xMax / x0) ** (r / RINGS), xb = x0 * (xMax / x0) ** ((r + 1) / RINGS);
    const xm = Math.sqrt(xa * xb);
    const ringMass = (ejectedMass(set, xb, c.a, i.rho) - ejectedMass(set, xa, c.a, i.rho)) * scale;
    const v = launchSpeed(set, xm, c.a, c.U, i.rho, i.delta, R);
    const v00 = launchSpeed(set, xm, c.a, c.U, i.rho, i.delta, R, false);
    if (!(v > 0) || ringMass <= 0) continue;
    const t0 = ((set.mu / (1 + set.mu)) * xm) / v00;
    const size = Math.min(1, Math.max(0.002, dRef * (10 / v)));
    for (let s = 0; s < SECTORS; s++) {
      if (weights[s] <= 0) continue;
      const phi = down + ((s + 0.5) / SECTORS) * 2 * Math.PI + ((rng.next() - 0.5) * 8 * Math.PI) / 180;
      const mass = ringMass * (weights[s] / wSum) * (1 + 0.3 * (rng.next() - 0.5));
      const ux = Math.cos(phi), uz = Math.sin(phi);
      const p0: [number, number, number] = [i.center[0] + ux * xm, i.center[1], i.center[2] + uz * xm];
      parcels.push({
        id: id++, ring: r, t0, p0, v0: [ux * v * Math.cos(th), v * Math.sin(th), uz * v * Math.cos(th)],
        mass, volume: mass / i.rho, size, speed: v,
        spreadR: 0, spreadT: 0, t1: 0, p1: [0, 0, 0], v1: 0, outflow: false, path: new Float32Array(0),
      });
    }
  }
  // Renormalize the seeded mass jitter so the total is exact.
  const m = parcels.reduce((a, p) => a + p.mass, 0);
  const target = Math.min(total * scale, c.ejectedVolume * i.rho);
  for (const p of parcels) { p.mass *= target / m; p.volume = p.mass / i.rho; }
  return parcels;
}

export interface WorldBox { x0: number; z0: number; x1: number; z1: number }

/**
 * Integrate a parcel's flight (gravity + drag on its fragment size) until it meets the ground or leaves
 * the world. `rhoAir`: air density of the flight (Phase 29 atmosphere; default the sea-level value).
 */
export function fly(p: Parcel, ground: (x: number, z: number) => number, box: WorldBox, fragmentDensity: number, rhoAir = RHO0, gv?: readonly [number, number, number]) {
  let [x, y, z] = p.p0;
  let [vx, vy, vz] = p.v0;
  const kd = (3 * CD_FRAG * rhoAir) / (4 * fragmentDensity * p.size);
  const path: number[] = [x, y, z];
  let t = 0, sinceSample = 0;
  for (let k = 0; k < 200_000; k++) {
    // Semi-implicit drag (stable for small fragments), explicit gravity.
    const sp = Math.hypot(vx, vy, vz);
    const damp = 1 / (1 + kd * sp * FLIGHT_DT);
    // Phase 31: a gravity vector of the world at launch (constant over the flight; a field changing mid-flight is not
    // followed — documented); without one the Phase 23 vertical g exactly.
    if (gv) { vx = (vx + gv[0] * FLIGHT_DT) * damp; vy = (vy + gv[1] * FLIGHT_DT) * damp; vz = (vz + gv[2] * FLIGHT_DT) * damp; }
    else { vx *= damp; vy = (vy - GRAVITY * FLIGHT_DT) * damp; vz *= damp; }
    x += vx * FLIGHT_DT; y += vy * FLIGHT_DT; z += vz * FLIGHT_DT;
    t += FLIGHT_DT;
    sinceSample += FLIGHT_DT;
    if (sinceSample >= 0.05 - 1e-9) { path.push(x, y, z); sinceSample = 0; }
    const outside = x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1;
    if (outside && y <= 0) { p.outflow = true; break; }
    if (vy < 0 && y <= ground(x, z)) break;
    // Phase 31: a parcel rising out of the world (upward / no gravity) leaves it — never lands.
    if (gv && (y > 2000 || (outside && !(gv[1] < 0)))) { p.outflow = true; break; }
  }
  // Phase 31: still airborne after the longest flight (no downward gravity): it never lands in the world.
  if (gv && !p.outflow && y > ground(x, z) + 0.01) p.outflow = true;
  path.push(x, y, z);
  p.t1 = p.t0 + t;
  p.p1 = [x, y, z];
  p.v1 = Math.hypot(vx, vy, vz);
  p.path = new Float32Array(path);
}

/**
 * Landing footprints from the neighbours: radial half-width = half the distance between the
 * landing ranges of adjacent rings, tangential half-width = half the sector arc at the landing
 * range (≥ 0.5 m, one grid cell) — the parcel's mass is spread over that ellipse.
 */
export function assignFootprints(parcels: Parcel[], center: [number, number, number]) {
  const range = (p: Parcel) => Math.hypot(p.p1[0] - center[0], p.p1[2] - center[2]);
  const byRing = new Map<number, number>();
  for (const p of parcels) byRing.set(p.ring, Math.max(byRing.get(p.ring) ?? 0, range(p)));
  const rings = [...byRing.keys()].sort((a, b) => a - b);
  for (const p of parcels) {
    const k = rings.indexOf(p.ring);
    const lo = k > 0 ? byRing.get(rings[k - 1])! : 0, hi = k < rings.length - 1 ? byRing.get(rings[k + 1])! : range(p) * 1.2;
    p.spreadR = Math.max(0.5, Math.abs(hi - lo) / 4);
    p.spreadT = Math.max(0.5, (range(p) * Math.PI) / SECTORS);
  }
}
