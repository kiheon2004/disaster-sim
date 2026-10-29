/**
 * What a ground-failure model needs from the run (Phase 22), so the models stay pure and testable:
 * the ground surface WITHOUT the moving layer, infiltrated water, loads on the ground and time.
 */
import { Rng } from '@/core/random';
import { ValueNoise } from '@/terrain/TerrainPresets';
import type { GeoField } from './GeoField';
import type { GroundArea } from './types';
import { DEG, gammaW, REPOSE_HYSTERESIS, unitWeight, type MechanicalProfile } from './materials';
import { stableCutAngle } from './stability';

export interface GroundEnv {
  /** Ground height at vertex i (terrain without the mobile layer; includes the field's bed). */
  ground(i: number): number;
  /** Water infiltrated into the soil under vertex i since t = 0 (m of water). */
  infiltrated(i: number): number;
  /** Surcharge on the ground at vertex i (kPa): structures, standing water, deposits. */
  surcharge(i: number): number;
}

/** Vertex indices inside an area (circle or polygon). */
export function areaVertices(f: GeoField, area: GroundArea): number[] {
  const out: number[] = [];
  if (area.kind === 'circle') {
    const [cx, cz] = area.center, r = area.radius;
    const ix0 = Math.max(0, Math.floor((cx - r - f.originX) / f.dx)), ix1 = Math.min(f.nx - 1, Math.ceil((cx + r - f.originX) / f.dx));
    const iz0 = Math.max(0, Math.floor((cz - r - f.originZ) / f.dx)), iz1 = Math.min(f.nz - 1, Math.ceil((cz + r - f.originZ) / f.dx));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const x = f.originX + ix * f.dx, z = f.originZ + iz * f.dx;
      if (Math.hypot(x - cx, z - cz) <= r) out.push(iz * f.nx + ix);
    }
    return out;
  }
  const pts = area.points;
  if (pts.length < 3) return out;
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const ix0 = Math.max(0, Math.floor((Math.min(...xs) - f.originX) / f.dx)), ix1 = Math.min(f.nx - 1, Math.ceil((Math.max(...xs) - f.originX) / f.dx));
  const iz0 = Math.max(0, Math.floor((Math.min(...zs) - f.originZ) / f.dx)), iz1 = Math.min(f.nz - 1, Math.ceil((Math.max(...zs) - f.originZ) / f.dx));
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
    const x = f.originX + ix * f.dx, z = f.originZ + iz * f.dx;
    if (insidePolygon(pts, x, z)) out.push(iz * f.nx + ix);
  }
  return out;
}

export function insidePolygon(pts: readonly [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function areaCentroid(area: GroundArea): [number, number] {
  if (area.kind === 'circle') return area.center;
  const n = area.points.length || 1;
  return [area.points.reduce((a, p) => a + p[0], 0) / n, area.points.reduce((a, p) => a + p[1], 0) / n];
}

/** Seeded strength variability: multiplier 1 + v·n(x, z), n ∈ [−1, 1] (8 m scale), ≥ 0.2. */
export function applyVariability(f: GeoField, cells: readonly number[], v: number, seed: number) {
  if (!(v > 0)) return;
  const noise = new ValueNoise(new Rng(seed ^ 0x5eed));
  for (const i of cells) {
    const ix = i % f.nx, iz = (i - ix) / f.nx;
    f.strength[i] = Math.max(0.2, 1 + v * noise.fbm(ix / 8, iz / 8, 3));
  }
}

/** Ground slope at vertex i: angle (rad) and downslope unit vector (x, z), central differences. */
export function slopeAt(f: GeoField, env: GroundEnv, i: number, out: [number, number]): number {
  const ix = i % f.nx, iz = (i - ix) / f.nx;
  const l = ix > 0 ? i - 1 : i, r = ix < f.nx - 1 ? i + 1 : i;
  const d = iz > 0 ? i - f.nx : i, u = iz < f.nz - 1 ? i + f.nx : i;
  const gx = (env.ground(r) - env.ground(l)) / (((r === i ? 0 : 1) + (l === i ? 0 : 1)) * f.dx || 1);
  const gz = (env.ground(u) - env.ground(d)) / (((u === i ? 0 : 1) + (d === i ? 0 : 1)) * f.dx || 1);
  const g = Math.hypot(gx, gz);
  if (g < 1e-9) {
    out[0] = 0; out[1] = 0;
    return 0;
  }
  out[0] = -gx / g;
  out[1] = -gz / g;
  return Math.atan(g);
}

/**
 * Water-table ratio from infiltration: infiltrated water fills the drainable pore space above the
 * slip surface (perched water table): Δh_w = I / (n·drainable), Δm = Δh_w / z.
 */
export function waterRiseFrom(infiltrated: number, p: MechanicalProfile, z: number): number {
  if (z <= 0 || infiltrated <= 0) return 0;
  return infiltrated / (p.porosity * p.drainable) / z;
}

/**
 * Basal friction of a released (moving) mass: tan φ'cv — the critical-state friction of sheared
 * soil, not the peak φ' of the ground in place — reduced by the pore-pressure ratio
 * r_u = m·γw / γ (effective stress on the base; saturated debris runs out farther).
 */
export function basalFriction(p: MechanicalProfile, m: number): number {
  return Math.tan(p.frictionCv * DEG) * (1 - poreRatio(p, m));
}

/** Friction a layer AT REST must exceed to start moving again: tan(φ'cv + REPOSE_HYSTERESIS)·(1 − r_u). */
export function restartFriction(p: MechanicalProfile, m: number): number {
  return Math.tan((p.frictionCv + REPOSE_HYSTERESIS) * DEG) * (1 - poreRatio(p, m));
}

const poreRatio = (p: MechanicalProfile, m: number) => Math.min(0.9, (m * gammaW()) / unitWeight(p));

const NEIGHBOURS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/**
 * Wall stability of pits (sinkholes, Phase 22) and craters (Phase 23): every vertex is checked
 * with Culmann's cut-height criterion against its steepest descent; material above the stable
 * inclination for the wall height (half the excess per check — sand-pile toppling rule) falls in
 * and runs out with the granular solver. With `rockStands` (craters), rock walls are not checked
 * (rock-slope failure is not a soil problem); sinkholes keep their Phase 22 behaviour.
 */
export function wallFailure(f: GeoField, cells: readonly number[], env: GroundEnv, profileOf: (i: number) => MechanicalProfile, rockStands = false) {
  for (const i of cells) {
    if (f.h[i] > 0.05) continue;
    const p = profileOf(i);
    if (rockStands && !p.failureModel) continue;
    const gamma = unitWeight(p), phi = p.friction * DEG;
    const avail = f.thickness[i] + f.loose[i];
    if (avail <= 1e-3) continue;
    const ix = i % f.nx, iz = (i - ix) / f.nx;
    const gi = env.ground(i);
    // Steepest descent neighbour.
    let best = -1, drop = 0, dist = 1;
    for (const [ox, oz, d] of NEIGHBOURS) {
      const jx = ix + ox, jz = iz + oz;
      if (jx < 0 || jz < 0 || jx >= f.nx || jz >= f.nz) continue;
      const j = jz * f.nx + jx;
      const dd = gi - (env.ground(j) + f.h[j]);
      if (dd / d > drop / dist) { best = j; drop = dd; dist = d; }
    }
    if (best < 0 || drop <= 0) continue;
    const tanb = drop / (dist * f.dx);
    if (tanb <= Math.tan(phi)) continue;
    // Wall height: follow the descent while it keeps going down (up to 8 cells).
    let hw = drop, cur = best, cx = best % f.nx, cz = (best - cx) / f.nx;
    const sx = Math.sign(cx - ix), sz = Math.sign(cz - iz);
    for (let k = 0; k < 8; k++) {
      const nx = cx + sx, nz = cz + sz;
      if (nx < 0 || nz < 0 || nx >= f.nx || nz >= f.nz) break;
      const n = nz * f.nx + nx;
      const dn = env.ground(cur) - env.ground(n);
      if (dn <= 0.01) break;
      hw += dn; cur = n; cx = nx; cz = nz;
    }
    const m = f.water(i);
    const c = p.cohesion * f.strength[i] + p.apparentCohesion * (1 - m);
    const bs = stableCutAngle(c, gamma, phi, hw);
    const tanS = Math.tan(Math.min(bs, 89.9 * DEG));
    if (tanb <= tanS * (1 + 1e-3)) continue;
    const excess = 0.5 * (drop - dist * f.dx * tanS);
    if (excess > 1e-3) f.release(i, excess, basalFriction(p, m), restartFriction(p, m));
  }
}
