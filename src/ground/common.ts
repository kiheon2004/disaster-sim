/**
 * What a ground-failure model needs from the run (Phase 22), so the models stay pure and testable:
 * the ground surface WITHOUT the moving layer, infiltrated water, loads on the ground and time.
 */
import { Rng } from '@/core/random';
import { ValueNoise } from '@/terrain/TerrainPresets';
import type { GeoField } from './GeoField';
import type { GroundArea } from './types';
import { DEG, GAMMA_W, unitWeight, type MechanicalProfile } from './materials';

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
 * Basal friction of a released mass: tan φ' reduced by the pore-pressure ratio r_u = m·γw / γ
 * (effective stress on the base; saturated debris runs out farther).
 */
export function basalFriction(p: MechanicalProfile, m: number): number {
  const ru = Math.min(0.9, (m * GAMMA_W) / unitWeight(p));
  return Math.tan(p.friction * DEG) * (1 - ru);
}
