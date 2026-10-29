/**
 * Shared geotechnical state of a run (Phase 22) on the terrain's vertex grid (1 m): what the
 * sinkhole and landslide models read and write, and what the deformation engine turns into
 * terrain (one non-separable DeformationSource, see GroundFailureSource).
 *
 *   per vertex                       meaning                                          unit
 *   material                         mechanical profile index (MECHANICAL_IDS)          –
 *   thickness                        soil above the slip surface / rock (available)     m
 *   water0                           initial water-table ratio m₀ (antecedent wetness)  –
 *   waterRise                        rise of m from infiltration since t = 0            –
 *   strength                         strength multiplier (seeded spatial variability)   –
 *   bed                              static ground change since t = 0 (erosion < 0)     m
 *   loose, looseMass                 deposited (already loosened) material on top       m, kg
 *   h, mass, mu                      mobile sediment: thickness (bulked), mass, basal μ m, kg, –
 *   qx, qz                           face fluxes of the mobile layer                    m²/s
 *   hfx, hfz                         flowing depth at the faces at the last flux update m
 *   fs                               last factor of safety (∞ = not evaluated / flat)   –
 *   nmV, nmD                         Newmark relative velocity / displacement           m/s, m
 *   owner                            phenomenon index that governs a vertex (−1 none)   –
 *   evaluate                         stability evaluated here (failure areas)           0/1
 *
 * Terrain contribution of the field: G = bed + h (the moving layer is part of the surface, so
 * the collider, the renderer and the water solver all see it).
 *
 * Budget (volume of BULKED material and mass, Float64): released − (mobile + deposited +
 * outflow) = residual (round-off); in-situ volume removed and the volume that went into a
 * cavity are kept separately (a sinkhole plug goes underground, not onto the surface).
 */
import type { TerrainData } from '@/core/model';
import { MECHANICAL_IDS, MECHANICAL_PROFILES, mechanicalOf, type MechanicalProfile } from './materials';

export interface SedimentBudget {
  /** In-situ volume that failed (m³) and its mass (kg). */
  releasedInSitu: number;
  releasedMass: number;
  /** Bulked volume put into motion (m³) = Σ in-situ × bulking. */
  released: number;
  /** Currently moving, deposited, out through an open edge (m³ bulked; kg). */
  mobile: number;
  deposited: number;
  outflow: number;
  mobileMass: number;
  depositedMass: number;
  outflowMass: number;
  /** In-situ volume that dropped into a cavity (sinkhole plug; m³, kg). */
  intoCavity: number;
  intoCavityMass: number;
  /** released − mobile − deposited − outflow (m³) and the same for mass (kg). */
  residual: number;
  residualMass: number;
  /** Largest mobile volume and its time (peak transport). */
  peakMobile: number;
  peakTime: number;
}

export const emptyBudget = (): SedimentBudget => ({
  releasedInSitu: 0, releasedMass: 0, released: 0, mobile: 0, deposited: 0, outflow: 0, mobileMass: 0, depositedMass: 0, outflowMass: 0,
  intoCavity: 0, intoCavityMass: 0, residual: 0, residualMass: 0, peakMobile: 0, peakTime: 0,
});

export class GeoField {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly originX: number;
  readonly originZ: number;
  readonly n: number;
  readonly material: Uint8Array;
  readonly thickness: Float32Array;
  readonly water0: Float32Array;
  readonly waterRise: Float32Array;
  readonly strength: Float32Array;
  readonly bed: Float32Array;
  readonly loose: Float32Array;
  readonly looseMass: Float64Array;
  readonly h: Float32Array;
  readonly mass: Float64Array;
  readonly mu: Float32Array;
  readonly qx: Float32Array;
  readonly qz: Float32Array;
  /** Flowing depth at each face when its flux was last computed (m). */
  readonly hfx: Float32Array;
  readonly hfz: Float32Array;
  readonly rest: Float32Array;
  readonly fs: Float32Array;
  readonly nmV: Float32Array;
  readonly nmD: Float32Array;
  readonly owner: Int16Array;
  readonly evaluate: Uint8Array;
  readonly failed: Uint8Array;
  budget: SedimentBudget = emptyBudget();
  /** Bumped whenever bed or h changed (the deformation source re-samples then). */
  rev = 0;
  /** Bounding box of vertices with mobile sediment (empty when x1 < x0). */
  active = { x0: 0, z0: 0, x1: -1, z1: -1 };
  /** Vertices whose bed + h changed since the deformation source last sampled (x1 < x0: none). */
  dirty = { x0: 0, z0: 0, x1: -1, z1: -1 };

  /** Mark a vertex box as changed (terrain contribution G = bed + h). */
  touch(x0: number, z0: number, x1 = x0, z1 = z0) {
    const d = this.dirty;
    if (d.x1 < d.x0) { d.x0 = x0; d.z0 = z0; d.x1 = x1; d.z1 = z1; return; }
    if (x0 < d.x0) d.x0 = x0;
    if (z0 < d.z0) d.z0 = z0;
    if (x1 > d.x1) d.x1 = x1;
    if (z1 > d.z1) d.z1 = z1;
  }

  private touchVertex(i: number) {
    const ix = i % this.nx;
    this.touch(ix, (i - ix) / this.nx);
  }

  constructor(t: TerrainData) {
    this.nx = t.nx;
    this.nz = t.nz;
    this.dx = t.cellSize;
    this.originX = t.originX;
    this.originZ = t.originZ;
    const n = (this.n = t.nx * t.nz);
    this.material = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.material[i] = MECHANICAL_IDS.indexOf(mechanicalOf(t.soil[i]).id);
    this.thickness = new Float32Array(n);
    this.water0 = new Float32Array(n);
    this.waterRise = new Float32Array(n);
    this.strength = new Float32Array(n).fill(1);
    this.bed = new Float32Array(n);
    this.loose = new Float32Array(n);
    this.looseMass = new Float64Array(n);
    this.h = new Float32Array(n);
    this.mass = new Float64Array(n);
    this.mu = new Float32Array(n);
    this.qx = new Float32Array((t.nx - 1) * t.nz);
    this.qz = new Float32Array(t.nx * (t.nz - 1));
    this.hfx = new Float32Array((t.nx - 1) * t.nz);
    this.hfz = new Float32Array(t.nx * (t.nz - 1));
    this.rest = new Float32Array(n);
    this.fs = new Float32Array(n).fill(Infinity);
    this.nmV = new Float32Array(n);
    this.nmD = new Float32Array(n);
    this.owner = new Int16Array(n).fill(-1);
    this.evaluate = new Uint8Array(n);
    this.failed = new Uint8Array(n);
  }

  profile(i: number): MechanicalProfile {
    return MECHANICAL_PROFILES[MECHANICAL_IDS[this.material[i]]];
  }

  /** Water-table ratio m (initial + infiltration rise), 0–1. */
  water(i: number): number {
    const m = this.water0[i] + this.waterRise[i];
    return m > 1 ? 1 : m;
  }

  index(x: number, z: number): number {
    const ix = Math.round((x - this.originX) / this.dx), iz = Math.round((z - this.originZ) / this.dx);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  /**
   * Put the top `depth` metres of vertex i into motion. Loose deposit on top goes first (already
   * loosened: no further bulking, its own density); in-situ soil below is bulked by its profile.
   * The ground drops by `depth`; returns the volume removed from the ground (m³).
   */
  release(i: number, depth: number, mu: number): number {
    const avail = this.loose[i] + this.thickness[i];
    const d = Math.min(depth, avail);
    if (d <= 0) return 0;
    const p = this.profile(i);
    const A = this.dx * this.dx;
    const fromLoose = Math.min(d, this.loose[i]);
    const fromSitu = d - fromLoose;
    let mobile = 0, m = 0;
    if (fromLoose > 0) {
      const lm = this.looseMass[i] * (fromLoose / this.loose[i]);
      this.loose[i] -= fromLoose;
      this.looseMass[i] -= lm;
      if (this.loose[i] < 1e-9) { this.loose[i] = 0; this.looseMass[i] = 0; }
      mobile += fromLoose;
      m += lm;
      // Re-mobilized deposit leaves the deposited account (it is mobile again).
      this.budget.deposited -= fromLoose * A;
      this.budget.depositedMass -= lm;
    }
    if (fromSitu > 0) {
      const sm = fromSitu * A * p.density;
      this.thickness[i] -= fromSitu;
      mobile += fromSitu * p.bulking;
      m += sm;
      const b = this.budget;
      b.releasedInSitu += fromSitu * A;
      b.releasedMass += sm;
      b.released += fromSitu * p.bulking * A;
    }
    this.bed[i] -= d;
    // Basal friction of the mixture: thickness-weighted.
    this.mu[i] = this.h[i] > 0 ? (this.mu[i] * this.h[i] + mu * mobile) / (this.h[i] + mobile) : mu;
    this.h[i] += mobile;
    this.mass[i] += m;
    this.rest[i] = 0;
    this.grow(i);
    this.touchVertex(i);
    this.rev++;
    return d * A;
  }

  /** In-situ material dropping into a cavity (the ground goes down, nothing becomes mobile). */
  dropIntoCavity(i: number, depth: number) {
    if (depth <= 0) return;
    const p = this.profile(i);
    const A = this.dx * this.dx;
    this.bed[i] -= depth;
    this.thickness[i] = Math.max(0, this.thickness[i] - depth);
    this.budget.intoCavity += depth * A;
    this.budget.intoCavityMass += depth * A * p.density;
    this.touchVertex(i);
    this.rev++;
  }

  /** Mobile sediment at rest → static (loose) deposit; the surface does not change. */
  deposit(i: number) {
    const h = this.h[i];
    if (h <= 0) return;
    const A = this.dx * this.dx;
    this.bed[i] += h;
    this.loose[i] += h;
    this.looseMass[i] += this.mass[i];
    this.budget.deposited += h * A;
    this.budget.depositedMass += this.mass[i];
    this.h[i] = 0;
    this.mass[i] = 0;
    this.rest[i] = 0;
  }

  grow(i: number) {
    const ix = i % this.nx, iz = (i - ix) / this.nx, a = this.active;
    if (a.x1 < a.x0) {
      a.x0 = a.x1 = ix;
      a.z0 = a.z1 = iz;
      return;
    }
    if (ix < a.x0) a.x0 = ix;
    if (ix > a.x1) a.x1 = ix;
    if (iz < a.z0) a.z0 = iz;
    if (iz > a.z1) a.z1 = iz;
  }

  /** Recompute the budget's derived totals (mobile, residuals) from the arrays. */
  closeBudget(time: number) {
    const b = this.budget, A = this.dx * this.dx;
    let v = 0, m = 0;
    const a = this.active;
    if (a.x1 >= a.x0) {
      for (let iz = a.z0; iz <= a.z1; iz++) for (let i = iz * this.nx + a.x0, e = iz * this.nx + a.x1; i <= e; i++) {
        v += this.h[i];
        m += this.mass[i];
      }
    }
    b.mobile = v * A;
    b.mobileMass = m;
    b.residual = b.released - b.mobile - b.deposited - b.outflow;
    b.residualMass = b.releasedMass - b.mobileMass - b.depositedMass - b.outflowMass;
    if (b.mobile > b.peakMobile) {
      b.peakMobile = b.mobile;
      b.peakTime = time;
    }
  }
}
