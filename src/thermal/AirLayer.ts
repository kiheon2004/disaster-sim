/**
 * Near-surface air (Phase 26): a COARSE spatial temperature field of the air layer next to the
 * ground — not a flow solution. The layer of height H (default 10 m) is split into 5 m columns; each
 * column is one well-mixed node (ρ·c_p·H·A at the ambient density, Boussinesq: the heat capacity does
 * not change with temperature). Its heat:
 *
 *  - comes from the surfaces below / inside it (convection, computed by those surfaces) and from
 *    point / volume sources;
 *  - is carried by the mean wind (uniform over the layer, the 10 m wind at mid-layer height with the
 *    project's power-law profile): conservative donor-cell (upwind) advection with CFL sub-steps; air
 *    entering at the world's edge is at the ambient temperature, what leaves is booked as lost;
 *  - leaves to the free atmosphere above when the column is warmer than ambient: buoyant overturning at
 *    the velocity scale w = √(g·H·ΔT/T_ref) (a dimensional estimate with coefficient 1 — the order of
 *    magnitude of thermal plume velocities, not a calibrated entrainment law). Colder air stays
 *    (stable stratification).
 * The temperature field is the air TEMPERATURE; surfaces have their own (they are never confused).
 * No 3-D flow, no compressibility, no stratification inside the layer, no horizontal eddy diffusion
 * beyond the numerical diffusion of the upwind scheme.
 *
 * Phase 29 (atmosphere experiments only — all null otherwise, so every Phase 26–28 path is unchanged):
 * the layer's mass, hence its heat capacity, follows the atmosphere's column mass per column (`Ca`),
 * with its density (`rhoA`) and pressure ratio to the standard pressure (`prA`, convection); buoyant
 * venting compares the layer with the free atmosphere above it (`ventRef`, cooled by an atmospheric
 * removal), and the transport uses the atmosphere's face velocities (advectFaces). The temperature
 * field stays owned here.
 */
import { GRAVITY } from '@/core/units';
import { advectFaces, courant, substepsFor } from '@/atmosphere/grid';
import { CP_AIR } from './units';

export const AIR_CELL = 5;
export const DEFAULT_LAYER_HEIGHT = 10;

export class AirLayer {
  readonly nx: number;
  readonly nz: number;
  readonly count: number;
  readonly cellArea: number;
  /** Heat capacity of one column (J/K). */
  readonly C: number;
  readonly E: Float64Array;
  readonly dE: Float64Array;
  /** Σ conductance coupled to each column this evaluation (W/K) — stability. */
  readonly gS: Float64Array;
  private readonly tmp: Float64Array;
  /** Peak temperature per column (K). */
  readonly Tpeak: Float64Array;
  /** Phase 29: per-column heat capacity (J/K), density (kg/m³), pressure ratio — null without an atmosphere. */
  Ca: Float64Array | null = null;
  rhoA: Float64Array | null = null;
  prA: Float64Array | null = null;
  /** Phase 29: mean pressure ratio (columns outside the layer / world). */
  prMean = 1;
  /** Phase 29: temperature of the free atmosphere above the layer (buoyant venting), null = Tref. */
  ventRef: number | null = null;
  /** Phase 29: temperature excess (K) of the background air entering through the edges (null = ambient = 0). */
  inflowExcess: number | null = null;

  constructor(
    readonly originX: number, readonly originZ: number, width: number, depth: number, readonly H: number,
    readonly Tref: number, readonly rho: number,
  ) {
    this.nx = Math.max(1, Math.ceil(width / AIR_CELL - 1e-9));
    this.nz = Math.max(1, Math.ceil(depth / AIR_CELL - 1e-9));
    this.count = this.nx * this.nz;
    this.cellArea = AIR_CELL * AIR_CELL;
    this.C = rho * CP_AIR * H * this.cellArea;
    this.E = new Float64Array(this.count);
    this.dE = new Float64Array(this.count);
    this.gS = new Float64Array(this.count);
    this.tmp = new Float64Array(this.count);
    this.Tpeak = new Float64Array(this.count).fill(Tref);
  }

  /** Column at a world point (−1 outside or above the layer). */
  index(x: number, z: number, heightAboveGround = 0): number {
    if (heightAboveGround > this.H) return -1;
    const ix = Math.floor((x - this.originX) / AIR_CELL), iz = Math.floor((z - this.originZ) / AIR_CELL);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  T(a: number): number {
    return a < 0 ? this.Tref : this.Tref + this.E[a] / (this.Ca ? this.Ca[a] : this.C);
  }

  /** Heat capacity of a column (J/K). */
  cap(a: number): number {
    return this.Ca ? this.Ca[a] : this.C;
  }

  /** Air density of a column (kg/m³) — the constructor's density without an atmosphere. */
  rhoAt(a: number): number {
    return this.rhoA && a >= 0 ? this.rhoA[a] : this.rho;
  }

  /** Pressure ratio to the standard pressure at a column (convection), 1 without an atmosphere. */
  prAt(a: number): number {
    return this.prA ? (a >= 0 ? this.prA[a] : this.prMean) : 1;
  }

  /** Temperature excess over the air the layer vents into (buoyancy), K. */
  excess(a: number): number {
    return this.T(a) - (this.ventRef ?? this.Tref);
  }

  /**
   * Buoyant venting to the free atmosphere (W, booked by the caller) into the rate accumulators;
   * returns the largest rate of the columns including what their surfaces couple (1/s).
   */
  vent(closed: boolean): { lost: number; maxRate: number } {
    if (this.Ca) return this.ventAtmos(closed);
    let lost = 0, maxRate = 0;
    const A = this.cellArea, k = this.rho * CP_AIR * A, gH = GRAVITY * this.H / this.Tref;
    for (let a = 0; a < this.count; a++) {
      const dT = this.E[a] / this.C;
      if (!closed && dT > 0) {
        const w = Math.sqrt(gH * dT);
        const q = k * w * dT;
        this.dE[a] -= q;
        lost += q;
        this.gS[a] += 1.5 * k * w;
      }
      const r = this.gS[a] / this.C;
      if (r > maxRate) maxRate = r;
      this.gS[a] = 0;
    }
    return { lost, maxRate };
  }

  /** Phase 29 venting: per-column density and capacity, relative to the free atmosphere above. */
  private ventAtmos(closed: boolean): { lost: number; maxRate: number } {
    let lost = 0, maxRate = 0;
    const A = this.cellArea, gH = GRAVITY * this.H / this.Tref, Ca = this.Ca!, rho = this.rhoA!;
    const ref = (this.ventRef ?? this.Tref) - this.Tref;
    for (let a = 0; a < this.count; a++) {
      const dT = this.E[a] / Ca[a] - ref;
      if (!closed && dT > 0) {
        const k = rho[a] * CP_AIR * A;
        const w = Math.sqrt(gH * dT);
        const q = k * w * dT;
        this.dE[a] -= q;
        lost += q;
        this.gS[a] += 1.5 * k * w;
      }
      const r = this.gS[a] / Ca[a];
      if (r > maxRate) maxRate = r;
      this.gS[a] = 0;
    }
    return { lost, maxRate };
  }

  /** Buoyant updraft velocity of a column (m/s, 0 when not warmer than the air above) — the venting's w. */
  updraft(a: number): number {
    const dT = this.excess(a);
    return dT > 0 ? Math.sqrt((GRAVITY * this.H * dT) / this.Tref) : 0;
  }

  /**
   * Phase 29: donor-cell transport by the atmosphere's face velocities (m/s; x-faces (nx+1)·nz,
   * z-faces nx·(nz+1)) with CFL sub-steps. Inflow is ambient air (no perturbation); returns the
   * energy that left through the edges (J).
   */
  advectFaces(fx: Float64Array, fz: Float64Array, dt: number): { out: number; moved: number; substeps: number } {
    const g = { nx: this.nx, nz: this.nz, dx: AIR_CELL };
    const n = substepsFor(courant(g, fx, fz, dt));
    const ex = this.inflowExcess, Ca = this.Ca;
    const r = advectFaces(g, this.E, fx, fz, dt, n, this.tmp, ex && Ca ? (a) => Ca[a] * ex : undefined);
    return { ...r, substeps: n };
  }

  apply(dt: number) {
    for (let a = 0; a < this.count; a++) { this.E[a] += this.dE[a] * dt; this.dE[a] = 0; }
  }

  /**
   * Donor-cell advection by a uniform velocity (u along +x, w along +z, m/s) over dt, with CFL
   * sub-steps (Courant ≤ 0.9). Returns the energy that crossed the world edge (J, out − in; inflow
   * is ambient air, so it carries no energy relative to the reference).
   */
  advect(u: number, w: number, dt: number): { out: number; moved: number; substeps: number } {
    const cx = Math.abs(u) / AIR_CELL, cz = Math.abs(w) / AIR_CELL;
    const rate = cx + cz;
    if (rate <= 0 || dt <= 0) return { out: 0, moved: 0, substeps: 0 };
    const n = Math.max(1, Math.ceil((rate * dt) / 0.9));
    const h = dt / n;
    const fx = cx * h, fz = cz * h;
    const { nx, nz, E, tmp } = this;
    let out = 0, moved = 0;
    for (let s = 0; s < n; s++) {
      tmp.set(E);
      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          const a = iz * nx + ix;
          const e = tmp[a];
          if (e === 0) continue;
          const ox = e * fx, oz = e * fz;
          E[a] -= ox + oz;
          moved += Math.abs(ox) + Math.abs(oz);
          const tx = ix + (u > 0 ? 1 : -1), tz = iz + (w > 0 ? 1 : -1);
          if (ox !== 0) { if (tx >= 0 && tx < nx) E[iz * nx + tx] += ox; else out += ox; }
          if (oz !== 0) { if (tz >= 0 && tz < nz) E[tz * nx + ix] += oz; else out += oz; }
        }
      }
    }
    return { out, moved, substeps: n };
  }

  energy(): number {
    let s = 0;
    for (let a = 0; a < this.count; a++) s += this.E[a];
    return s;
  }
}
