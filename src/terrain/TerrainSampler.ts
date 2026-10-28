/**
 * TerrainSampler: the one way simulation systems, placement and tools read the terrain.
 *
 *   TerrainData ──► TerrainSampler ──► wind field, particles, debris, placement, inspector
 *               └─► TerrainRenderer / TerrainPhysicsAdapter (same grid, same triangulation)
 *
 * Queries interpolate on the exact triangles of the heightfield (cell split along the
 * (x1,z0)–(x0,z1) diagonal, as Rapier does), so a sampled height equals the rendered surface and the physics
 * collider. Outside the grid the ground is the y = 0 surroundings, as in the renderer/physics.
 *
 * Hot-path rules: no allocation (normals are written into a caller-owned vector), and a flat
 * terrain short-circuits to 0 so the flat world costs one branch per query.
 */
import type { Vec3 } from '@/core/types';
import type { GroundTypeId, SoilProfileId, TerrainData } from '@/core/model';
import { createFlatTerrain, heightRange, isDefaultGround, isDefaultSoil, isFlat } from './TerrainData';
import { groundMaterial, type GroundMaterial } from './GroundMaterials';
import { DEFAULT_SOIL, SOIL_COUNT, soilProfile, type SoilProfile } from './SoilProfiles';

const RAD2DEG = 180 / Math.PI;

export class TerrainSampler {
  /** True when every vertex is at 0 m (fast path). */
  flat = true;
  /** True when every vertex has the default ground type. */
  uniformGround = true;
  /** True when every vertex has the default soil profile (Phase 13 fast path). */
  uniformSoil = true;
  /** Soil profiles present anywhere on the grid (index = SoilProfileId). */
  readonly soilsPresent: boolean[] = new Array(SOIL_COUNT).fill(false);
  minHeight = 0;
  maxHeight = 0;
  /** Number of height queries since the last reset (performance HUD). */
  queries = 0;
  /** NaN so the first sync() always runs, whatever the data's revision is. */
  private syncedRevision = NaN;
  private readonly x1: number;
  private readonly z1: number;
  private readonly inv: number;

  constructor(readonly data: TerrainData) {
    this.inv = 1 / data.cellSize;
    this.x1 = data.originX + (data.nx - 1) * data.cellSize;
    this.z1 = data.originZ + (data.nz - 1) * data.cellSize;
    this.sync();
  }

  /** Re-read derived values after the data changed in place (cheap when nothing changed). */
  sync() {
    if (this.data.revision === this.syncedRevision) return;
    this.syncedRevision = this.data.revision;
    this.flat = isFlat(this.data);
    this.uniformGround = isDefaultGround(this.data);
    this.uniformSoil = isDefaultSoil(this.data);
    this.soilsPresent.fill(false);
    this.soilsPresent[DEFAULT_SOIL] = true; // the surroundings outside the grid
    if (!this.uniformSoil) for (let i = 0; i < this.data.soil.length; i++) this.soilsPresent[this.data.soil[i]] = true;
    const [lo, hi] = this.flat ? [0, 0] : heightRange(this.data);
    this.minHeight = Math.min(0, lo);
    this.maxHeight = Math.max(0, hi);
  }

  inside(x: number, z: number): boolean {
    const d = this.data;
    return x >= d.originX && x <= this.x1 && z >= d.originZ && z <= this.z1;
  }

  /** Ground elevation (m) at a world point. */
  sampleHeight(x: number, z: number): number {
    this.queries++;
    if (this.flat) return 0;
    const d = this.data;
    if (x < d.originX || x > this.x1 || z < d.originZ || z > this.z1) return 0;
    const gx = (x - d.originX) * this.inv;
    const gz = (z - d.originZ) * this.inv;
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix >= d.nx - 1) ix = d.nx - 2;
    if (iz >= d.nz - 1) iz = d.nz - 2;
    const fx = gx - ix;
    const fz = gz - iz;
    const h = d.heights;
    const i = iz * d.nx + ix;
    const h10 = h[i + 1];
    const h01 = h[i + d.nx];
    if (fx + fz <= 1) {
      const h00 = h[i];
      return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    }
    const h11 = h[i + d.nx + 1];
    return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  }

  /** Height of a point above the local ground. */
  heightAboveGround(p: Readonly<Vec3>): number {
    return p[1] - this.sampleHeight(p[0], p[2]);
  }

  /**
   * Surface gradient [dh/dx, dh/dz] of the triangle under the point (written into `out`).
   * Returns false outside the grid / on a flat terrain (gradient 0).
   */
  private gradient(x: number, z: number, out: [number, number]): boolean {
    out[0] = 0;
    out[1] = 0;
    if (this.flat || !this.inside(x, z)) return false;
    const d = this.data;
    const gx = (x - d.originX) * this.inv;
    const gz = (z - d.originZ) * this.inv;
    const ix = Math.min(Math.floor(gx), d.nx - 2);
    const iz = Math.min(Math.floor(gz), d.nz - 2);
    const h = d.heights;
    const i = iz * d.nx + ix;
    const h10 = h[i + 1];
    const h01 = h[i + d.nx];
    if (gx - ix + (gz - iz) <= 1) {
      const h00 = h[i];
      out[0] = (h10 - h00) * this.inv;
      out[1] = (h01 - h00) * this.inv;
    } else {
      const h11 = h[i + d.nx + 1];
      out[0] = (h11 - h01) * this.inv;
      out[1] = (h11 - h10) * this.inv;
    }
    return true;
  }

  private grad: [number, number] = [0, 0];

  /** Unit surface normal (of the collider triangle) at a point, written into `out`. */
  sampleNormal(x: number, z: number, out: Vec3 = [0, 1, 0]): Vec3 {
    this.gradient(x, z, this.grad);
    const gx = this.grad[0];
    const gz = this.grad[1];
    const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out[0] = -gx * inv;
    out[1] = inv;
    out[2] = -gz * inv;
    return out;
  }

  /** Slope angle in degrees (0 = level). */
  sampleSlope(x: number, z: number): number {
    this.gradient(x, z, this.grad);
    return Math.atan(Math.hypot(this.grad[0], this.grad[1])) * RAD2DEG;
  }

  /** Ground type of the nearest vertex (default ground outside the grid). */
  sampleGroundType(x: number, z: number): GroundTypeId {
    const d = this.data;
    if (!this.inside(x, z)) return 0;
    const ix = Math.round((x - d.originX) * this.inv);
    const iz = Math.round((z - d.originZ) * this.inv);
    return d.ground[iz * d.nx + ix] as GroundTypeId;
  }

  /** Approximate surface parameters of the ground at a point. */
  sampleGround(x: number, z: number): GroundMaterial {
    return groundMaterial(this.sampleGroundType(x, z));
  }

  /** Soil profile of the nearest vertex (default soil outside the grid). */
  sampleSoilType(x: number, z: number): SoilProfileId {
    const d = this.data;
    if (this.uniformSoil || !this.inside(x, z)) return DEFAULT_SOIL;
    const ix = Math.round((x - d.originX) * this.inv);
    const iz = Math.round((z - d.originZ) * this.inv);
    return d.soil[iz * d.nx + ix] as SoilProfileId;
  }

  sampleSoil(x: number, z: number): SoilProfile {
    return soilProfile(this.sampleSoilType(x, z));
  }

  /**
   * Bilinear weights of each soil profile at a point (written into `out`, length SOIL_COUNT):
   * site properties blend smoothly across soil boundaries instead of jumping at a vertex.
   */
  sampleSoilWeights(x: number, z: number, out: Float64Array): Float64Array {
    out.fill(0);
    const d = this.data;
    if (this.uniformSoil || !this.inside(x, z)) {
      out[DEFAULT_SOIL] = 1;
      return out;
    }
    const gx = (x - d.originX) * this.inv;
    const gz = (z - d.originZ) * this.inv;
    const ix = Math.min(Math.floor(gx), d.nx - 2);
    const iz = Math.min(Math.floor(gz), d.nz - 2);
    const fx = gx - ix;
    const fz = gz - iz;
    const i = iz * d.nx + ix;
    const g = d.soil;
    out[g[i]] += (1 - fx) * (1 - fz);
    out[g[i + 1]] += fx * (1 - fz);
    out[g[i + d.nx]] += (1 - fx) * fz;
    out[g[i + d.nx + 1]] += fx * fz;
    return out;
  }

  /** Depth below the static reference water level (0 when dry or no water level is set). */
  sampleWaterDepth(x: number, z: number): number {
    const w = this.data.settings.waterLevel;
    if (w === null) return 0;
    return Math.max(0, w - this.sampleHeight(x, z));
  }

  /**
   * First intersection of a ray with the terrain surface (including the y = 0 surroundings).
   * Marches in sub-cell steps and refines by bisection; writes the hit into `out`.
   */
  raycast(origin: Readonly<Vec3>, dir: Readonly<Vec3>, maxDist: number, out: Vec3): boolean {
    const above = (t: number) => origin[1] + dir[1] * t - this.sampleHeight(origin[0] + dir[0] * t, origin[2] + dir[2] * t);
    if (this.flat) {
      if (dir[1] >= -1e-9) return false;
      const t = -origin[1] / dir[1];
      if (t < 0 || t > maxDist) return false;
      out[0] = origin[0] + dir[0] * t;
      out[1] = 0;
      out[2] = origin[2] + dir[2] * t;
      return true;
    }
    // Skip to where the ray enters the band between the lowest and highest ground.
    let t = 0;
    const top = this.maxHeight + 0.01;
    if (origin[1] > top) {
      if (dir[1] >= 0) return false;
      t = (top - origin[1]) / dir[1];
    }
    const horiz = Math.hypot(dir[0], dir[2]);
    const step = Math.max(0.05, (this.data.cellSize * 0.35) / Math.max(horiz, 0.25));
    let prev = above(t);
    if (prev <= 0) return false; // starts under ground
    while (t < maxDist) {
      const tn = t + step;
      const cur = above(tn);
      if (cur <= 0) {
        let a = t;
        let b = tn;
        for (let k = 0; k < 24; k++) {
          const m = (a + b) / 2;
          if (above(m) > 0) a = m;
          else b = m;
        }
        out[0] = origin[0] + dir[0] * b;
        out[2] = origin[2] + dir[2] * b;
        out[1] = this.sampleHeight(out[0], out[2]);
        return true;
      }
      // Below the band and still going down: the y = 0 plane / lowest point is next.
      if (origin[1] + dir[1] * tn < this.minHeight - 0.01 && dir[1] < 0) return false;
      prev = cur;
      t = tn;
    }
    return false;
  }
}

/** Sampler for the default flat world (systems created without a terrain). */
export function flatSampler(): TerrainSampler {
  return new TerrainSampler(createFlatTerrain(2, 2));
}

const samplers = new WeakMap<TerrainData, TerrainSampler>();

/** Shared sampler for a terrain object (re-synced on every call; cheap when unchanged). */
export function samplerFor(t: TerrainData): TerrainSampler {
  let s = samplers.get(t);
  if (!s) {
    s = new TerrainSampler(t);
    samplers.set(t, s);
  }
  s.sync();
  return s;
}
