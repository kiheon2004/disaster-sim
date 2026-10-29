/**
 * AtmosphereField (Phase 29) — the air MASS, pressure and flow of the world's atmosphere on the Phase
 * 26 air-layer columns (5 m). Pure: no simulation types; the adapter (simulation/atmosphere) gives it
 * the layer temperatures it reads from the thermal state and applies what it returns.
 *
 * State per column a: σ_a = mass of the whole air column above the ground per area (kg/m²). Surface
 * pressure p_s = σ·g (hydrostatic, exact for any temperature profile). Face mass fluxes U (kg/(m·s),
 * column-integrated) on a staggered grid. One scalar temperature of the free atmosphere above the
 * resolved layer, T_col (the layer temperature itself belongs to the Phase 26 AirLayer).
 *
 * Barotropic redistribution (one step of dt, semi-implicit — backward Euler):
 *   U' = β·U − β·dt·H_s·∂p* / ∂x,   β = 1/(1 + dt/τ)        (vertically integrated pressure force; τ damping)
 *   σ' = σ* − dt·∇·U'                                        (flux form: mass exact to round-off)
 * with the terrain-reduced pressure p* = p_s·exp((z_g − z₀)/H_ref) (no flow in the hydrostatic rest
 * state over any terrain). Substituting gives an SPD system for s = σ·red (PCG). Its wave speed is
 * √(R·T) ≈ 290 m/s (the Lamb wave): backward Euler at 0.1 s damps and filters these acoustic transients
 * — the model resolves slow adjustment (≳ 1 s), never sound or shocks (Phase 24).
 *
 * Near-surface layer convergence: where air leaves the resolved layer vertically (buoyant updraft of a
 * warm column, a near-surface sink) or enters it (a near-surface source), the layer flow satisfies
 * continuity ∇·u_L = −s/H — a potential flow u_L = ∇φ, ∇²φ = −s/H (open edges φ = 0; a closed world
 * returns the updraft as uniform subsidence). Its magnitude follows from continuity alone.
 *
 * Mass changes (removal / restoration / sources) act on the whole column in proportion to its mass
 * (the layer holds the share ℓ = 1 − exp(−H/H_ref), Boussinesq at the reference temperature) at
 * constant temperature: removed air carries its enthalpy c_p·T·dm out, added air mixes in at its
 * temperature. Then the air of every column expands / is compressed adiabatically by its ACTUAL
 * pressure change over the step, T' = T·(p'/p)^(R/c_p) — a uniform removal cools what is left
 * (pressure work = the flow work R·T·dm the removed air carried), a local sink that the surroundings
 * refill hardly changes the temperature. Energy: c_p·Σ m·T (internal + potential energy of a
 * hydrostatic column), every change booked. Isothermal mode books the work as external heat.
 */
import { advectFaces, courant, faceCountX, faceCountZ, pcg, substepsFor, velocityAt, type Grid } from './grid';
import { CP_AIR, G, KAPPA, STANDARD_PRESSURE, density, scaleHeight, soundSpeed } from './reference';
import { MASS_FLOOR, type BoundaryMode, type ThermoMode } from './types';

export interface FieldInit {
  originX: number;
  originZ: number;
  nx: number;
  nz: number;
  dx: number;
  /** Resolved layer height (m) — the Phase 26 air layer's. */
  H: number;
  /** Mean ground height of each column (world y, m). */
  ground: Float64Array;
  /** Datum (y = 0) pressure (Pa) and temperature (K, = the thermal reference). */
  p0: number;
  T0: number;
  boundary: BoundaryMode;
  thermo: ThermoMode;
  /** Damping time of the barotropic flux (s). */
  tau?: number;
}

/** Damping time of the column flux (s): a closure for surface friction and the adjustment leaving the 200 m domain — not calibrated. */
export const TAU = 30;

export interface MassLedger {
  initial: number;
  boundaryIn: number;
  boundaryOut: number;
  source: number;
  removed: number;
  restored: number;
  /** Removal requested but not available (columns at the floor) — not removed. */
  shortfall: number;
  final: number;
}

export interface OxygenLedger {
  initial: number;
  removed: number;
  restored: number;
  boundaryIn: number;
  boundaryOut: number;
  /** O₂ burned (from the fire ledger). */
  consumed: number;
  /** O₂-poor air vented above the layer (still in the atmosphere, not resolved). */
  aloft: number;
  final: number;
}

export interface EnergyLedger {
  initial: number;
  /** Net heat into the layer from surfaces, sources, rooms (from the thermal state). */
  heatIn: number;
  /** Heat vented above the layer by buoyancy (thermal `atmosphere` account). */
  ventedAloft: number;
  /** Layer heat carried out through the edges (thermal `airAdvection`). */
  advectedOut: number;
  /** c_p·T·dm of air crossing the edges (column flux). */
  boundaryIn: number;
  boundaryOut: number;
  removed: number;
  restored: number;
  /** Volcanic gas added (at the layer temperature). */
  source: number;
  /** Isothermal mode: external heat that replaced the expansion cooling (− for compression). */
  isothermalHeat: number;
  /** Informational: heat released above the layer by sources / plumes (thermal aboveLayer, volcano plume). */
  aboveLayerInfo: number;
  /** Kinetic energy of the column flow now, and what damping removed (not returned as heat — unresolved). */
  kinetic: number;
  dissipated: number;
  /** Adiabatic expansion (−) / compression (+) work on the air that stays, from each column's actual pressure change. */
  pressureWork: number;
  final: number;
}

export interface MomentumLedger {
  /** Air momentum of the column flow now (kg·m/s, x / z). */
  px: number;
  pz: number;
  /** Impulse of the pressure-gradient force (incl. the boundary pressure and terrain form force). */
  pressureX: number;
  pressureZ: number;
  /** Impulse removed by the flux damping. */
  dampingX: number;
  dampingZ: number;
  /** Informational: impulse of aerodynamic forces on objects (ForceLedger 'wind', both flows). */
  objectsX: number;
  objectsZ: number;
}

export interface GasLedger {
  emitted: number;
  airborne: number;
  aloft: number;
  out: number;
  removed: number;
}

export interface StepForcing {
  /** Uniform removal: share of every column's mass (0–1). */
  removeShare?: number;
  /** Uniform restoration: mass (kg) added in proportion to the columns' mass. */
  addMass?: number;
  /** Local sink (kg < 0) or source (kg > 0) over the disc columns with weights (sum 1). */
  local?: { cols: readonly number[]; w: readonly number[]; kg: number };
  /** Volcanic gas into the layer of a column (kg this step). */
  gas?: readonly { a: number; kg: number }[];
  /** Background reduced pressure at an open boundary as a share of p₀. */
  bgShare: number;
  /** Reservoir / inflow air temperature (K). */
  Tin: number;
  /** Absolute layer temperature per column (K) — from the thermal state. */
  layerT: Float64Array;
  /** Buoyant updraft velocity per column (m/s), null = none. */
  updraft: Float64Array | null;
}

export interface StepResult {
  /** Columns whose layer mass / temperature changed: their new absolute temperature (K) and mass ratio. */
  changed: number[];
  T2: Float64Array;
  massRatio: Float64Array;
  /** Mass leaving each column's layer by a near-surface sink this step (share of its layer mass). */
  sinkShare: Float64Array;
  /** Columns that lost air to a removal this step and the share each lost (its O₂ deficit / tracers go too). */
  removedList: number[];
  removedShare: Float64Array;
  removedKg: Float64Array;
  iterations: number;
  idle: boolean;
}

export class AtmosphereField implements Grid {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly count: number;
  readonly area: number;
  readonly originX: number;
  readonly originZ: number;
  readonly H: number;
  readonly p0: number;
  readonly T0: number;
  readonly Href: number;
  /** Share of a column's mass inside the resolved layer (Boussinesq, reference temperature). */
  readonly ell: number;
  readonly boundary: BoundaryMode;
  readonly thermo: ThermoMode;
  readonly tau: number;
  readonly sigma: Float64Array;
  readonly sigma0: Float64Array;
  readonly ground: Float64Array;
  readonly red: Float64Array;
  readonly Ux: Float64Array;
  readonly Uz: Float64Array;
  /** Column-mean velocity on faces (m/s). */
  readonly ubx: Float64Array;
  readonly ubz: Float64Array;
  /** Layer convergence velocity on faces (m/s). */
  readonly ulx: Float64Array;
  readonly ulz: Float64Array;
  readonly phi: Float64Array;
  /** Volcanic gas in the layer per column (kg). */
  readonly gas: Float64Array;
  /** Free-atmosphere temperature above the layer (K). */
  Tcol: number;
  readonly mass: MassLedger;
  readonly oxygen: OxygenLedger;
  readonly energy: EnergyLedger;
  readonly momentum: MomentumLedger = { px: 0, pz: 0, pressureX: 0, pressureZ: 0, dampingX: 0, dampingZ: 0, objectsX: 0, objectsZ: 0 };
  readonly gasLedger: GasLedger = { emitted: 0, airborne: 0, aloft: 0, out: 0, removed: 0 };
  /** Non-air gas added (kg·Y_O2): keeps the O₂ total consistent without a per-column composition. */
  o2Offset = 0;
  time = 0;
  steps = 0;
  solves = 0;
  lastIterations = 0;
  maxSpeed = 0;
  maxLayerSpeed = 0;
  private readonly work: Float64Array[];
  private readonly s: Float64Array;
  private readonly rhs: Float64Array;
  private readonly diag: Float64Array;
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;
  private readonly src: Float64Array;
  private readonly prev: Float64Array;
  private readonly mid: Float64Array;
  private readonly Tmix: Float64Array;
  private readonly tmp: Float64Array;
  private readonly res: StepResult;
  private readonly Yo2: number;

  constructor(init: FieldInit, Yo2 = 0.232) {
    this.nx = init.nx; this.nz = init.nz; this.dx = init.dx;
    this.count = this.nx * this.nz;
    this.area = this.dx * this.dx;
    this.originX = init.originX; this.originZ = init.originZ;
    this.H = init.H; this.p0 = init.p0; this.T0 = init.T0;
    this.Href = scaleHeight(init.T0);
    this.ell = 1 - Math.exp(-this.H / this.Href);
    this.boundary = init.boundary; this.thermo = init.thermo;
    this.tau = init.tau ?? TAU;
    this.Yo2 = Yo2;
    const n = this.count;
    this.sigma = new Float64Array(n);
    this.sigma0 = new Float64Array(n);
    this.ground = new Float64Array(n);
    this.red = new Float64Array(n);
    this.Ux = new Float64Array(faceCountX(this)); this.Uz = new Float64Array(faceCountZ(this));
    this.ubx = new Float64Array(this.Ux.length); this.ubz = new Float64Array(this.Uz.length);
    this.ulx = new Float64Array(this.Ux.length); this.ulz = new Float64Array(this.Uz.length);
    this.phi = new Float64Array(n);
    this.gas = new Float64Array(n);
    this.s = new Float64Array(n); this.rhs = new Float64Array(n); this.diag = new Float64Array(n);
    this.kx = new Float64Array(this.Ux.length); this.kz = new Float64Array(this.Uz.length);
    this.src = new Float64Array(n); this.tmp = new Float64Array(n);
    this.prev = new Float64Array(n); this.mid = new Float64Array(n); this.Tmix = new Float64Array(n);
    this.work = [0, 1, 2, 3, 4].map(() => new Float64Array(n));
    this.res = { changed: [], T2: new Float64Array(n), massRatio: new Float64Array(n).fill(1), sinkShare: new Float64Array(n), removedList: [], removedShare: new Float64Array(n), removedKg: new Float64Array(n), iterations: 0, idle: true };
    this.Tcol = init.T0;
    this.setGround(init.ground, true);
    let M = 0;
    for (let a = 0; a < n; a++) {
      // Hydrostatic rest state: equal reduced pressure everywhere.
      this.sigma[a] = this.p0 / G / this.red[a];
      this.sigma0[a] = this.sigma[a];
      M += this.sigma[a] * this.area;
    }
    this.mass = { initial: M, boundaryIn: 0, boundaryOut: 0, source: 0, removed: 0, restored: 0, shortfall: 0, final: M };
    const O = this.Yo2 * M;
    this.oxygen = { initial: O, removed: 0, restored: 0, boundaryIn: 0, boundaryOut: 0, consumed: 0, aloft: 0, final: O };
    const E = CP_AIR * this.T0 * M;
    this.energy = { initial: E, heatIn: 0, ventedAloft: 0, advectedOut: 0, boundaryIn: 0, boundaryOut: 0, removed: 0, restored: 0, source: 0, isothermalHeat: 0, aboveLayerInfo: 0, kinetic: 0, dissipated: 0, pressureWork: 0, final: E };
  }

  /** Column ground heights changed (terrain deformation): new reduction factors; the mass stays. */
  setGround(ground: Float64Array, init = false) {
    for (let a = 0; a < this.count; a++) {
      this.ground[a] = ground[a];
      this.red[a] = Math.exp(ground[a] / this.Href);
    }
    if (!init) this.dirty = true;
  }
  private dirty = false;

  // ── Derived state ──────────────────────────────────────

  /** Column index at a world point (−1 outside). */
  index(x: number, z: number): number {
    const ix = Math.floor((x - this.originX) / this.dx), iz = Math.floor((z - this.originZ) / this.dx);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  surfacePressure(a: number): number {
    return this.sigma[a] * G;
  }

  /** Mass of the resolved layer of a column (kg). */
  layerMass(a: number): number {
    return this.ell * this.sigma[a] * this.area;
  }

  /** Mean density of the layer at the reference temperature (Boussinesq capacity, kg/m³). */
  layerDensity(a: number): number {
    return (this.ell * this.sigma[a]) / this.H;
  }

  /** Pressure at a height above a column's ground (Pa): the layer at Tl, above it the free atmosphere. */
  pressureAt(a: number, h: number, Tl = this.T0): number {
    const ps = this.sigma[a] * G;
    const hh = Math.max(0, h);
    if (hh <= this.H) return ps * Math.exp(-hh / scaleHeight(Tl));
    return ps * Math.exp(-this.H / scaleHeight(Tl)) * Math.exp(-(hh - this.H) / scaleHeight(this.Tcol));
  }

  /** Density at a height (kg/m³), p/(R·T) with the temperature there. */
  densityAt(a: number, h: number, Tl = this.T0): number {
    const T = h <= this.H ? Tl : this.Tcol;
    return density(this.pressureAt(a, h, Tl), T);
  }

  /** Pressure at the middle of the layer relative to the standard pressure (convection correlations). */
  pressureRatio(a: number, Tl = this.T0): number {
    return this.pressureAt(a, 0.5 * this.H, Tl) / STANDARD_PRESSURE;
  }

  totalMass(): number {
    let M = 0;
    for (let a = 0; a < this.count; a++) M += this.sigma[a];
    return M * this.area;
  }

  /** Area-mean surface pressure reduced to the datum (Pa) — the "world pressure". */
  meanReducedPressure(): number {
    let s = 0;
    for (let a = 0; a < this.count; a++) s += this.sigma[a] * this.red[a];
    return (s * G) / this.count;
  }

  /** Planned-path control: mass share of the initial state (reduced to the datum). */
  share(): number {
    return this.meanReducedPressure() / this.p0;
  }

  /** Total velocity of the computed flow at a world point and height above ground (m/s, x / z). */
  velocity(x: number, z: number, h: number, out: [number, number] = [0, 0]): [number, number] {
    const fx = (x - this.originX) / this.dx, fz = (z - this.originZ) / this.dx;
    velocityAt(this, this.ubx, this.ubz, fx, fz, out);
    if (h <= this.H) {
      const u = out[0], w = out[1];
      velocityAt(this, this.ulx, this.ulz, fx, fz, out);
      out[0] += u; out[1] += w;
    }
    return out;
  }

  /** Column-centre speed of the column flow + layer flow (m/s). */
  speedAt(a: number): number {
    const ix = a % this.nx, iz = (a - ix) / this.nx;
    const fw = iz * (this.nx + 1) + ix;
    const u = 0.5 * (this.ubx[fw] + this.ubx[fw + 1] + this.ulx[fw] + this.ulx[fw + 1]);
    const w = 0.5 * (this.ubz[a] + this.ubz[a + this.nx] + this.ulz[a] + this.ulz[a + this.nx]);
    return Math.hypot(u, w);
  }

  /** Domain pressure-adjustment time L/c (s) — the fastest change the model can follow. */
  adjustmentTime(): number {
    return (Math.max(this.nx, this.nz) * this.dx) / soundSpeed(this.Tcol);
  }

  // ── Step ───────────────────────────────────────────────

  step(dt: number, F: StepForcing): StepResult {
    const r = this.res;
    for (const a of r.changed) { r.massRatio[a] = 1; r.sinkShare[a] = 0; }
    for (const a of r.removedList) { r.removedShare[a] = 0; r.removedKg[a] = 0; }
    r.changed.length = 0;
    r.removedList.length = 0;
    r.idle = false;
    const n = this.count, A = this.area, ell = this.ell;
    const Tl = F.layerT;
    const Tm = this.Tmix, sb = this.prev, smid = this.mid;
    sb.set(this.sigma);
    let upBefore = 0;
    for (let a = 0; a < n; a++) upBefore += this.sigma[a];
    upBefore *= (1 - ell) * A;
    // 1. Mass changes at constant temperature: removed air leaves with its enthalpy c_p·T·dm, added air
    //    (reservoir at Tin, volcanic gas at the layer temperature) mixes in. The pressure work follows
    //    from each column's actual pressure change over the whole step (4.).
    const dm = this.src;
    dm.fill(0);
    let any = false;
    if (F.removeShare && F.removeShare > 0) {
      for (let a = 0; a < n; a++) dm[a] -= F.removeShare * this.sigma[a] * A;
      any = true;
    }
    if (F.addMass && F.addMass > 0) {
      const M = this.totalMass();
      for (let a = 0; a < n; a++) dm[a] += (F.addMass * this.sigma[a] * A) / M;
      any = true;
    }
    if (F.local && F.local.kg !== 0) {
      const { cols, w, kg } = F.local;
      for (let i = 0; i < cols.length; i++) dm[cols[i]] += kg * w[i];
      any = true;
    }
    Tm.set(Tl);
    let localSink = false, upAdded = 0;
    if (any) {
      for (let a = 0; a < n; a++) {
        let d = dm[a];
        if (d === 0) continue;
        const M = this.sigma[a] * A;
        if (d < 0) {
          // Never below the floor: what is not there cannot be removed (booked as shortfall).
          const avail = Math.max(0, M - MASS_FLOOR * this.sigma0[a] * A);
          if (-d > avail) { this.mass.shortfall += -d - avail; d = -avail; }
          if (d === 0) continue;
          const rr = -d / M;
          this.energy.removed += CP_AIR * -d * (ell * Tl[a] + (1 - ell) * this.Tcol);
          this.mass.removed += -d;
          // The removed air took its share of the layer gas (the O₂ deficit is the fire's — the adapter scales it).
          const g = this.gas[a] * rr;
          this.gas[a] -= g;
          this.gasLedger.removed += g;
          r.removedShare[a] = rr;
          r.removedKg[a] = -d;
          r.removedList.push(a);
          if (F.local && F.local.kg < 0) { r.sinkShare[a] = rr; localSink = true; }
        } else {
          const ml = ell * M;
          Tm[a] = (ml * Tl[a] + ell * d * F.Tin) / (ml + ell * d);
          this.energy.restored += CP_AIR * d * F.Tin;
          this.mass.restored += d;
          upAdded += (1 - ell) * d;
          if (F.local && F.local.kg > 0) { r.sinkShare[a] = -d / M; localSink = true; }
        }
        this.sigma[a] = (M + d) / A;
      }
    }
    if (F.gas) {
      for (const { a, kg } of F.gas) {
        if (!(kg > 0) || a < 0) continue;
        this.sigma[a] += kg / A;
        this.gas[a] += kg;
        this.gasLedger.emitted += kg;
        this.mass.source += kg;
        this.o2Offset += this.Yo2 * kg;
        // Added at the local temperatures (the gas's own heat is not modelled — Phase 28 books none).
        this.energy.source += CP_AIR * kg * (ell * Tm[a] + (1 - ell) * this.Tcol);
        any = true;
      }
    }
    // Upper free atmosphere: the removed share left at T_col (no change); restored air mixes in.
    if (upAdded > 0) {
      let up = 0;
      for (let a = 0; a < n; a++) up += this.sigma[a];
      up *= (1 - ell) * A;
      this.Tcol = ((up - upAdded) * this.Tcol + upAdded * F.Tin) / up;
    }
    smid.set(this.sigma);
    // 2–3. Column redistribution (skipped at rest).
    const it = this.redistribute(dt, F.bgShare);
    r.iterations = it;
    // 4. Pressure work: the air of every column expands / is compressed adiabatically by its actual
    //    pressure change over the step (p ∝ σ). Air carried in or out by the column flow is mixed at
    //    the reference temperature (E unchanged) — its heat perturbation travels with the thermal
    //    layer's own transport, never twice.
    if (any || it >= 0) {
      const iso = this.thermo === 'isothermal';
      const T0 = this.T0;
      let work = 0;
      for (let a = 0; a < n; a++) {
        const s0 = sb[a], s1 = this.sigma[a];
        if (s0 === s1 && Tm[a] === Tl[a]) continue;
        const Tx = smid[a] === s1 ? Tm[a] : T0 + ((Tm[a] - T0) * smid[a]) / s1;
        const Tad = Tx * Math.pow(s1 / s0, KAPPA);
        work += CP_AIR * ell * s1 * A * (Tad - Tx);
        r.T2[a] = iso ? Tx : Tad;
        r.massRatio[a] = s1 / s0;
        r.changed.push(a);
      }
      let upAfter = 0;
      for (let a = 0; a < n; a++) upAfter += this.sigma[a];
      upAfter *= (1 - ell) * A;
      if (upAfter !== upBefore) {
        const Tad = this.Tcol * Math.pow(upAfter / upBefore, KAPPA);
        work += CP_AIR * upAfter * (Tad - this.Tcol);
        if (!iso) this.Tcol = Tad;
      }
      this.energy.pressureWork += work;
      if (iso) this.energy.isothermalHeat -= work;
    }
    // 5. Layer convergence flow (updrafts, near-surface sinks / sources).
    this.layerFlow(dt, F.updraft, localSink ? r.sinkShare : null);
    r.idle = it < 0 && !any;
    this.time += dt;
    this.steps++;
    this.mass.final = this.totalMass();
    return r;
  }

  /**
   * Volcanic gas added to columns after the step (the volcano's actual emission of the step): mass into
   * the column and the layer tracer, at the local temperatures (no T change — a negligible share).
   * Returns the columns whose layer mass changed (their capacity follows; T unchanged).
   */
  injectGas(list: readonly { a: number; kg: number }[], layerT: (a: number) => number): number[] {
    const out: number[] = [];
    for (const { a, kg } of list) {
      if (!(kg > 0) || a < 0) continue;
      this.sigma[a] += kg / this.area;
      this.gas[a] += kg;
      this.gasLedger.emitted += kg;
      this.mass.source += kg;
      this.o2Offset += this.Yo2 * kg;
      this.energy.source += CP_AIR * kg * (this.ell * layerT(a) + (1 - this.ell) * this.Tcol);
      out.push(a);
    }
    if (out.length) { this.mass.final = this.totalMass(); this.dirty = true; }
    return out;
  }

  /** Semi-implicit column redistribution. Returns the PCG iterations (−1: at rest, skipped). */
  private redistribute(dt: number, bgShare: number): number {
    const { nx, nz, dx, Ux, Uz, sigma, red, s, rhs, diag, kx, kz } = this;
    const n = this.count;
    const open = this.boundary === 'open';
    const sg = (bgShare * this.p0) / G;
    // At rest? (no flux and equal reduced pressure across every face, ghosts included)
    if (!this.dirty) {
      let flux = 0;
      for (let f = 0; f < Ux.length; f++) if (Ux[f] !== 0) { flux = 1; break; }
      if (!flux) for (let f = 0; f < Uz.length; f++) if (Uz[f] !== 0) { flux = 1; break; }
      if (!flux) {
        let lo = Infinity, hi = -Infinity;
        for (let a = 0; a < n; a++) { const v = sigma[a] * red[a]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (open) { if (sg < lo) lo = sg; if (sg > hi) hi = sg; }
        if (hi - lo <= 1e-12 * hi) return -1;
      }
    }
    this.dirty = false;
    const beta = 1 / (1 + dt / this.tau);
    const Hs = scaleHeight(this.Tcol);
    const c = (beta * dt * dt * Hs * G) / (dx * dx);
    const kb = open ? c : 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix <= nx; ix++) kx[iz * (nx + 1) + ix] = ix === 0 || ix === nx ? kb : c;
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix < nx; ix++) kz[iz * nx + ix] = iz === 0 || iz === nz ? kb : c;
    const h = dt / dx;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const a = iz * nx + ix, fw = iz * (nx + 1) + ix;
      diag[a] = 1 / red[a];
      const out = Ux[fw + 1] - Ux[fw] + Uz[a + nx] - Uz[a];
      let rr = sigma[a] - h * beta * out;
      if (open) {
        if (ix === 0) rr += kb * sg;
        if (ix === nx - 1) rr += kb * sg;
        if (iz === 0) rr += kb * sg;
        if (iz === nz - 1) rr += kb * sg;
      }
      rhs[a] = rr;
      s[a] = sigma[a] * red[a];
    }
    const it = pcg(this, diag, kx, kz, rhs, s, this.work, 1e-13, 500);
    this.lastIterations = it;
    this.solves++;
    // New fluxes from s; momentum ledger (exact split of the update into pressure and damping parts).
    const kp = beta * dt * Hs * G / dx;
    const m = this.momentum, A = dx * dx;
    const sAt = (ix: number, iz: number) => (ix < 0 || iz < 0 || ix >= nx || iz >= nz ? sg : s[iz * nx + ix]);
    let ke = 0, diss = 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix <= nx; ix++) {
      const f = iz * (nx + 1) + ix;
      if (!open && (ix === 0 || ix === nx)) { Ux[f] = 0; continue; }
      const old = Ux[f];
      const pg = -kp * (sAt(ix, iz) - sAt(ix - 1, iz));
      const nu = beta * old + pg;
      m.pressureX += pg * A;
      m.dampingX += (beta - 1) * old * A;
      diss += (1 - beta * beta) * old * old;
      Ux[f] = nu;
    }
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const f = iz * nx + ix;
      if (!open && (iz === 0 || iz === nz)) { Uz[f] = 0; continue; }
      const old = Uz[f];
      const pg = -kp * (sAt(ix, iz) - sAt(ix, iz - 1));
      const nu = beta * old + pg;
      m.pressureZ += pg * A;
      m.dampingZ += (beta - 1) * old * A;
      diss += (1 - beta * beta) * old * old;
      Uz[f] = nu;
    }
    // Outflow limiter: a column never gives more than it holds above its floor (scaled faces are what the neighbour receives).
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const a = iz * nx + ix, fw = iz * (nx + 1) + ix;
      const out = Math.max(0, -Ux[fw]) + Math.max(0, Ux[fw + 1]) + Math.max(0, -Uz[a]) + Math.max(0, Uz[a + nx]);
      const avail = (sigma[a] - MASS_FLOOR * this.sigma0[a]) / h;
      if (out > avail && out > 0) {
        const k = Math.max(0, avail) / out;
        if (Ux[fw] < 0) Ux[fw] *= k;
        if (Ux[fw + 1] > 0) Ux[fw + 1] *= k;
        if (Uz[a] < 0) Uz[a] *= k;
        if (Uz[a + nx] > 0) Uz[a + nx] *= k;
      }
    }
    // Mass update in flux form; boundary exchange booked with its energy and oxygen.
    const Tb = this.Tcol;
    let bin = 0, bout = 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const a = iz * nx + ix, fw = iz * (nx + 1) + ix;
      const div = Ux[fw + 1] - Ux[fw] + Uz[a + nx] - Uz[a];
      const d = -h * div;
      sigma[a] += d;
    }
    const edge = (U: number, sign: number) => { const q = U * sign * dt * dx; if (q > 0) bout += q; else bin -= q; };
    if (open) {
      for (let iz = 0; iz < nz; iz++) { edge(Ux[iz * (nx + 1)], -1); edge(Ux[iz * (nx + 1) + nx], 1); }
      for (let ix = 0; ix < nx; ix++) { edge(Uz[ix], -1); edge(Uz[nz * nx + ix], 1); }
    }
    this.mass.boundaryIn += bin;
    this.mass.boundaryOut += bout;
    this.oxygen.boundaryIn += this.Yo2 * bin;
    this.oxygen.boundaryOut += this.Yo2 * bout;
    // Inflow at the background state (reference temperature); outflow: the layer's base part at the
    // reference (its heat perturbation leaves through the thermal layer's own transport), the rest at T_col.
    this.energy.boundaryIn += CP_AIR * this.T0 * bin;
    this.energy.boundaryOut += CP_AIR * (this.ell * this.T0 + (1 - this.ell) * Tb) * bout;
    if (bin > 0) {
      // Upper column mixes with the inflowing background air.
      let up = 0;
      for (let a = 0; a < n; a++) up += (1 - this.ell) * sigma[a];
      up *= dx * dx;
      const inUp = (1 - this.ell) * bin, outUp = (1 - this.ell) * bout;
      const before = up - inUp + outUp;
      if (up > 0) this.Tcol = ((before - outUp) * this.Tcol + inUp * this.T0) / up;
    }
    // Velocities (column mean) and kinetic energy ½·U²/σ per face area.
    let vmax = 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix <= nx; ix++) {
      const f = iz * (nx + 1) + ix;
      const sl = ix > 0 ? sigma[iz * nx + ix - 1] : sigma[iz * nx + ix];
      const sr = ix < nx ? sigma[iz * nx + ix] : sl;
      const sf = Math.max(1e-9, 0.5 * (sl + sr));
      const u = Ux[f] / sf;
      this.ubx[f] = u;
      ke += 0.5 * Ux[f] * u * A;
      if (Math.abs(u) > vmax) vmax = Math.abs(u);
    }
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const f = iz * nx + ix;
      const st = iz > 0 ? sigma[(iz - 1) * nx + ix] : sigma[ix];
      const sb = iz < nz ? sigma[iz * nx + ix] : st;
      const sf = Math.max(1e-9, 0.5 * (st + sb));
      const u = Uz[f] / sf;
      this.ubz[f] = u;
      ke += 0.5 * Uz[f] * u * A;
      if (Math.abs(u) > vmax) vmax = Math.abs(u);
    }
    // Damping removes (1 − β²)·U²/(2σ) of kinetic energy per face (approximately; informational).
    let sm = 0;
    for (let a = 0; a < n; a++) sm += sigma[a];
    sm /= n;
    this.energy.dissipated += (0.5 * diss * A) / Math.max(1e-9, sm);
    this.energy.kinetic = ke;
    let px = 0, pz = 0;
    for (let f = 0; f < Ux.length; f++) px += Ux[f];
    for (let f = 0; f < Uz.length; f++) pz += Uz[f];
    m.px = px * A;
    m.pz = pz * A;
    this.maxSpeed = vmax;
    return it;
  }

  /** Layer convergence potential flow: ∇²φ = −s/H, u_L = ∇φ. */
  private layerFlow(dt: number, updraft: Float64Array | null, sink: Float64Array | null) {
    const { nx, nz, dx, ulx, ulz, phi } = this;
    const n = this.count;
    const src = this.tmp;
    let any = false, mean = 0;
    for (let a = 0; a < n; a++) {
      let w = updraft ? updraft[a] : 0;
      // Near-surface sink: the column's removed share leaves through the layer (replenished from above
      // and around) ⇒ volume velocity dm/(ρ_L·A) = share·M/(ℓ·M/H)/dt (m/s).
      if (sink && sink[a] !== 0) w += (sink[a] * this.H) / (this.ell * dt);
      src[a] = w;
      if (w !== 0) any = true;
      mean += w;
    }
    if (!any) {
      if (this.maxLayerSpeed !== 0) { ulx.fill(0); ulz.fill(0); phi.fill(0); this.maxLayerSpeed = 0; }
      return;
    }
    mean /= n;
    const open = this.boundary === 'open';
    const kx = this.kx, kz = this.kz, diag = this.diag, rhs = this.rhs;
    const kb = open ? 1 : 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix <= nx; ix++) kx[iz * (nx + 1) + ix] = ix === 0 || ix === nx ? kb : 1;
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix < nx; ix++) kz[iz * nx + ix] = iz === 0 || iz === nz ? kb : 1;
    // Closed world: the updraft returns as uniform subsidence (consistent Neumann problem, tiny diagonal).
    for (let a = 0; a < n; a++) { rhs[a] = ((src[a] - (open ? 0 : mean)) * dx * dx) / this.H; diag[a] = open ? 0 : 1e-9; }
    pcg(this, diag, kx, kz, rhs, phi, this.work, 1e-10, 500);
    let vmax = 0;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix <= nx; ix++) {
      const f = iz * (nx + 1) + ix;
      let u = 0;
      if (ix > 0 && ix < nx) u = (phi[iz * nx + ix] - phi[iz * nx + ix - 1]) / dx;
      else if (open) u = ix === 0 ? phi[iz * nx] / dx : -phi[iz * nx + nx - 1] / dx;
      ulx[f] = u;
      if (Math.abs(u) > vmax) vmax = Math.abs(u);
    }
    for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const f = iz * nx + ix;
      let u = 0;
      if (iz > 0 && iz < nz) u = (phi[iz * nx + ix] - phi[(iz - 1) * nx + ix]) / dx;
      else if (open) u = iz === 0 ? phi[ix] / dx : -phi[(nz - 1) * nx + ix] / dx;
      ulz[f] = u;
      if (Math.abs(u) > vmax) vmax = Math.abs(u);
    }
    this.maxLayerSpeed = vmax;
  }

  /**
   * Transport of a layer tracer (kg per column) by the total layer face velocities (layerFaces()),
   * venting the `vent` share of each column above the layer first.
   * Returns { out, moved, vented }.
   */
  transportLayer(q: Float64Array, dt: number, vent: Float64Array | null, fx: Float64Array, fz: Float64Array, tmp: Float64Array) {
    let vented = 0;
    if (vent) for (let a = 0; a < this.count; a++) { const v = q[a] * vent[a]; if (v !== 0) { q[a] -= v; vented += v; } }
    const c = courant(this, fx, fz, dt);
    const n = substepsFor(c);
    const res = c > 0 ? advectFaces(this, q, fx, fz, dt, n, tmp) : { out: 0, moved: 0 };
    return { ...res, vented, substeps: n };
  }

  /** Total face velocities of the layer: uniform background (u, w) + column flow + layer flow. */
  layerFaces(u: number, w: number, fx: Float64Array, fz: Float64Array) {
    for (let f = 0; f < fx.length; f++) fx[f] = u + this.ubx[f] + this.ulx[f];
    for (let f = 0; f < fz.length; f++) fz[f] = w + this.ubz[f] + this.ulz[f];
  }

  /** Oxygen (kg) in the atmosphere given the fire's layer deficit (kg). */
  oxygenTotal(deficit: number): number {
    return this.Yo2 * this.totalMass() - deficit - this.oxygen.aloft - this.o2Offset;
  }

  /** Close the energy ledger with the layer energy from the thermal state: c_p·Σ m·T (J). */
  closeEnergy(layerEnergy: number) {
    let up = 0;
    for (let a = 0; a < this.count; a++) up += (1 - this.ell) * this.sigma[a];
    this.energy.final = CP_AIR * this.Tcol * up * this.area + layerEnergy;
  }

  energyExpected(): number {
    const e = this.energy;
    return e.initial + e.heatIn - e.ventedAloft - e.advectedOut + e.boundaryIn - e.boundaryOut - e.removed + e.restored + e.source + e.pressureWork + e.isothermalHeat;
  }

  massResidual(): number {
    const m = this.mass;
    return m.final - (m.initial + m.boundaryIn - m.boundaryOut + m.source - m.removed + m.restored);
  }
}
