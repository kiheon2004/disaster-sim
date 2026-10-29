/**
 * Lava field (Phase 28): mobile lava and the volcanic deposits on the terrain's VERTEX grid (each vertex
 * owns its dual cell dx² — the Phase 22 GeoField convention, so a deposit thickness at the vertices is
 * exactly the volume the rendered / collision terrain gains). Pure: no Rapier, no React, no Phase 26
 * objects — the surroundings (ground, air, water temperatures) come in through `LavaSurroundings` and the
 * heat that leaves goes out through per-vertex accumulators the adapter turns into thermal source steps.
 *
 * State per vertex (SoA):
 *   M, E, age        mobile lava mass (kg), energy above the reference state (J), crust age (s)
 *   depM, depB, depA deposited lava / bomb / ash mass (kg) — the deposit layer (part of the terrain)
 *   depE, depAge     energy of the hot deposit (lava + bombs; ash is deposited cold) and its age
 *   dep              deposit thickness (m) = (depM + depB)/ρ_lava/dx² + depA/ρ_ash/dx²
 *
 * Flow (`flow`): the Bingham plate flux (rheology.ts) on every face from the vertex with the higher lava
 * surface S = bed + h, with the DONOR's flowing depth (h minus rigid crusts) and properties; donor-cell
 * transport of mass, energy and crust age. Numerical techniques shared with Phase 14 / 22 (and only
 * those): face fluxes subtracted from one vertex and added to the other (exact mass), outflow scaled to
 * the donor's content (positivity), active set with sleeping vertices (a settled flow costs nothing).
 * Stability: the flux is a nonlinear diffusion of the surface; a sub-step h is chosen so that no face
 * moves more than ΔS·dx²/5 (the explicit diffusion bound with 4 neighbours and a margin), never more
 * than MAX_SUB per call — beyond that the face volume is limited (counted in `limited`), so the free
 * surface never inverts and depths never go negative. Thin films stop by themselves: h ≤ h_cr gives 0.
 *
 * Cooling (`cool`): crust.ts top / base balances on every hot column; lock-up (φ ≥ φ_lock) moves the
 * column into the deposit layer (same mass, same energy, same vertex). Deposits keep cooling (top to air,
 * base to ground, top to mobile lava above when covered) and hand their remaining heat to the ground when
 * within RETIRE_DT of it (exact: nothing dropped). Lateral conduction inside the lava is neglected
 * (time scale dx²/κ ≈ 10⁶ s); lava–lava exchange = advective mixing + mobile ↔ deposit conduction.
 */
import { gravityDown } from '@/thermal/gravityScope';
import { GRAVITY } from '@/core/units';
import { SIGMA } from '@/thermal/units';
import { hGround } from '@/thermal/convection';
import { binghamFlux } from './rheology';
import { boundaryLayer, rigidPart, surfaceTemperature, surfaceUnderWater, H_WATER } from './crust';
import { crystalFraction, lockTemperature, specificEnergy, temperatureFromEnergy, viscosity, yieldStrength, type LavaMaterial } from './materials';

export const MAX_SUB = 48;
const NO_TOP = { rad: 0, conv: 0, water: 0, sink: Infinity, source: -Infinity };
/** Deposits thinner than this (m) hand their heat to the ground and are not computed (grams of spatter). */
const THIN_DEPOSIT = 1e-4;
/** Fraction of the surface difference a face may move per sub-step (explicit diffusion bound with margin). */
const FACE_SHARE = 0.2;
/** Mobile lava thinner than this (m) is a residual film: it does not flow (it cools and locks). */
export const FILM = 0.005;
/** Deposits this close to the ground temperature (K) hand their heat to the ground and stop being computed. */
export const RETIRE_DT = 2;
/** Bulk density of a fresh ash fall deposit (kg/m³; 500–1500 reported) — assumed. */
export const ASH_DEPOSIT_DENSITY = 1000;
/** Deposits are cooled every DEP_EVERY calls with the accumulated time (their time constants are hours). */
export const DEP_EVERY = 10;
/** Vertices without flow for this many sub-steps fall asleep until something flows into them. */
const SLEEP_AFTER = 4;

export interface LavaSurroundings {
  Tref: number;
  /** Air temperature above a vertex (K). */
  airT(i: number): number;
  /** Wind at 2 m (m/s). */
  wind(i: number): number;
  /** Ground surface-layer temperature under a vertex (K) and the half-layer resistance (m²·K/W). */
  groundT(i: number): number;
  groundR(i: number): number;
  /** Water depth (m) and temperature (K) over a vertex. */
  waterDepth(i: number): number;
  waterT(i: number): number;
  /** Phase 29 (atmosphere experiments only): pressure ratio to the standard pressure over a vertex. */
  pr?(i: number): number;
}

export const stillSurroundings = (Tref: number): LavaSurroundings => ({
  Tref, airT: () => Tref, wind: () => 0, groundT: () => Tref, groundR: () => 0.01 / 1.5, waterDepth: () => 0, waterT: () => Tref,
});

export interface FieldLedger {
  /** Mass (kg) / energy (J) put in: vent supply (mobile), bomb deposits, ash deposits. */
  suppliedMass: number;
  suppliedEnergy: number;
  bombMass: number;
  bombEnergy: number;
  ashMass: number;
  /** Lava that left the world over the edges. */
  outMass: number;
  outEnergy: number;
  /** Heat out (J): into the ground (incl. retired deposits), the air (convection), radiation, water, objects. */
  toGround: number;
  toAir: number;
  radiated: number;
  toWater: number;
  toObjects: number;
  /** Mass that locked up (kg, informational). */
  lockedMass: number;
  /** Faces whose volume had to be limited because the sub-step cap was reached. */
  limited: number;
}

export const emptyFieldLedger = (): FieldLedger => ({ suppliedMass: 0, suppliedEnergy: 0, bombMass: 0, bombEnergy: 0, ashMass: 0, outMass: 0, outEnergy: 0, toGround: 0, toAir: 0, radiated: 0, toWater: 0, toObjects: 0, lockedMass: 0, limited: 0 });

export class LavaField {
  readonly n: number;
  readonly area: number;
  readonly rho: number;
  readonly M: Float64Array;
  readonly E: Float64Array;
  readonly age: Float32Array;
  /** Interior and surface temperature (K), flowing speed (m/s) of the last step — cached for readers. */
  readonly T: Float32Array;
  readonly Ts: Float32Array;
  readonly speed: Float32Array;
  readonly depM: Float64Array;
  readonly depB: Float64Array;
  readonly depA: Float64Array;
  readonly depE: Float64Array;
  readonly depAge: Float32Array;
  readonly depT: Float32Array;
  readonly dep: Float32Array;
  /** What the terrain already carries of `dep` (the adapter's deformation source sets it; 0 in pure use). */
  readonly applied: Float32Array;
  /** Obstacle height above the bed (m): lava enters only above it (intact buildings, walls). */
  readonly obstacle: Float32Array;
  /** Heat out per vertex since the last `drain` (J). */
  readonly qGround: Float64Array;
  readonly qAir: Float64Array;
  readonly qRad: Float64Array;
  readonly qWater: Float64Array;
  /** Of qRad: the part radiated by the exposed margins (flow fronts), and their outward normal × area (m²). */
  readonly qSide: Float64Array;
  readonly nSideX: Float32Array;
  readonly nSideZ: Float32Array;
  /** Peak mobile depth (m) and peak interior temperature (K) ever seen per vertex (overlays, inspector). */
  readonly hPeak: Float32Array;
  readonly Tpeak: Float32Array;
  /** Vertices with mobile lava / hot deposit (unordered; `inList` marks members). */
  mobile: number[] = [];
  hot: number[] = [];
  private readonly inMobile: Uint8Array;
  private readonly inHot: Uint8Array;
  private readonly still: Uint8Array;
  private readonly heatTouched: Uint8Array;
  touched: number[] = [];
  readonly ledger: FieldLedger = emptyFieldLedger();
  /** Bumped when `dep` changed; the box of vertices whose `dep` changed since `clearDirty`. */
  rev = 0;
  dirty = { x0: 0, z0: 0, x1: -1, z1: -1 };
  /** Open edges: lava leaving the grid is booked as outflow (closed: the edge is a wall). */
  open = true;
  /** Sub-steps of the last flow call; flow faces evaluated (cost). */
  substeps = 0;
  faces = 0;
  private readonly Tlock: number;
  private readonly kappa: number;
  // Per-substep scratch (faces of the donors).
  private fFrom = new Int32Array(1024);
  private fTo = new Int32Array(1024);
  private fV = new Float64Array(1024);
  private fCap = new Float64Array(1024);
  private readonly outV: Float64Array;
  private readonly eSnap: Float64Array;
  private readonly aSnap: Float32Array;

  constructor(
    readonly nx: number,
    readonly nz: number,
    readonly dx: number,
    readonly originX: number,
    readonly originZ: number,
    /** Terrain heights per vertex (live reference — follows every deformation). */
    readonly heights: Float32Array,
    readonly mat: LavaMaterial,
    readonly Tref: number,
  ) {
    const n = (this.n = nx * nz);
    this.area = dx * dx;
    this.rho = mat.thermal.bulk;
    this.M = new Float64Array(n); this.E = new Float64Array(n); this.age = new Float32Array(n);
    this.T = new Float32Array(n).fill(Tref); this.Ts = new Float32Array(n).fill(Tref); this.speed = new Float32Array(n);
    this.depM = new Float64Array(n); this.depB = new Float64Array(n); this.depA = new Float64Array(n); this.depE = new Float64Array(n);
    this.depAge = new Float32Array(n); this.depT = new Float32Array(n).fill(Tref); this.dep = new Float32Array(n); this.applied = new Float32Array(n);
    this.obstacle = new Float32Array(n);
    this.qGround = new Float64Array(n); this.qAir = new Float64Array(n); this.qRad = new Float64Array(n); this.qWater = new Float64Array(n);
    this.qSide = new Float64Array(n); this.nSideX = new Float32Array(n); this.nSideZ = new Float32Array(n);
    this.hPeak = new Float32Array(n); this.Tpeak = new Float32Array(n);
    this.inMobile = new Uint8Array(n); this.inHot = new Uint8Array(n); this.still = new Uint8Array(n); this.heatTouched = new Uint8Array(n);
    this.outV = new Float64Array(n);
    this.cooledAt = new Float64Array(n);
    this.awakeStamp = new Int32Array(n); this.cacheStamp = new Int32Array(n);
    this.cEta = new Float64Array(n); this.cTau = new Float64Array(n); this.cRigid = new Float64Array(n);
    this.eSnap = new Float64Array(n);
    this.aSnap = new Float32Array(n);
    this.Tlock = lockTemperature(mat);
    this.kappa = mat.kappa;
  }

  // ── Geometry ───────────────────────────────────────────

  index(x: number, z: number): number {
    const ix = Math.round((x - this.originX) / this.dx), iz = Math.round((z - this.originZ) / this.dx);
    return ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz ? -1 : iz * this.nx + ix;
  }

  xOf = (i: number) => this.originX + (i % this.nx) * this.dx;
  zOf = (i: number) => this.originZ + Math.floor(i / this.nx) * this.dx;

  /** Ground under the mobile lava: terrain without the deposits it already carries, plus the deposits now. */
  bed(i: number): number {
    return this.heights[i] - this.applied[i] + this.dep[i];
  }

  depth(i: number): number {
    return this.M[i] / (this.rho * this.area);
  }

  surface(i: number): number {
    return this.bed(i) + this.depth(i);
  }

  // ── Inputs ─────────────────────────────────────────────

  private wake(i: number) {
    this.still[i] = 0;
    if (!this.inMobile[i]) { this.inMobile[i] = 1; this.mobile.push(i); this.cooledAt[i] = this.clock; }
    if (this.awakeStamp[i] !== this.callStamp) { this.awakeStamp[i] = this.callStamp; this.awakeList.push(i); }
  }

  /** η, τ_y and the rigid crust thickness of a donor for this flow call (τ_y < 0 marks a locked column). */
  private rheology(i: number, call: number) {
    this.cacheStamp[i] = call;
    const T = this.clampT(temperatureFromEnergy(this.mat, this.E[i] / this.M[i], this.Tref));
    this.T[i] = T;
    if (T <= this.Tlock) { this.cTau[i] = -1; return; }
    const h = this.depth(i);
    const d = boundaryLayer(this.kappa, this.age[i], h);
    const below = this.depThicknessLava(i) > 0.01 ? this.depT[i] : T;
    this.cRigid[i] = rigidPart(d, T, this.Ts[i], this.Tlock) + rigidPart(d, T, Math.min(below, T), this.Tlock);
    this.cEta[i] = viscosity(this.mat, T);
    this.cTau[i] = yieldStrength(this.mat, T);
  }
  private callStamp = 0;
  private awakeList: number[] = [];
  private awakeStamp = new Int32Array(0);
  private cacheStamp = new Int32Array(0);
  private cEta = new Float64Array(0);
  private cTau = new Float64Array(0);
  private cRigid = new Float64Array(0);

  private heat(i: number) {
    if (!this.inHot[i]) { this.inHot[i] = 1; this.hot.push(i); }
  }

  /** Lava erupted at a vertex: mass (kg) at temperature T (K), fresh surface. */
  supply(i: number, mass: number, T: number) {
    if (!(mass > 0)) return;
    const e = mass * specificEnergy(this.mat, T, this.Tref);
    const m0 = this.M[i];
    this.M[i] += mass;
    this.E[i] += e;
    this.age[i] = (this.age[i] * m0) / this.M[i];
    this.ledger.suppliedMass += mass;
    this.ledger.suppliedEnergy += e;
    this.refresh(i);
    this.wake(i);
  }

  /** Bomb / spatter landing at a vertex: hot material straight into the deposit layer. */
  addBomb(i: number, mass: number, energy: number) {
    if (!(mass > 0)) return;
    const m0 = this.depM[i] + this.depB[i];
    this.depB[i] += mass;
    this.depE[i] += energy;
    this.depAge[i] = (this.depAge[i] * m0) / (m0 + mass);
    this.ledger.bombMass += mass;
    this.ledger.bombEnergy += energy;
    this.thickness(i);
    this.heat(i);
  }

  /** Ash settling on the ground at a vertex (cold — its heat stayed in the plume). */
  addAsh(i: number, mass: number) {
    if (!(mass > 0)) return;
    this.depA[i] += mass;
    this.ledger.ashMass += mass;
    this.thickness(i);
  }

  /** Heat taken from the lava at a vertex by an object in contact (J); returns what was taken. */
  take(i: number, J: number): number {
    if (!(J > 0)) return 0;
    let got = 0;
    if (this.M[i] > 0) {
      const t = Math.min(J, 0.5 * Math.max(0, this.E[i]));
      this.E[i] -= t; got += t;
    }
    if (got < J && this.depE[i] > 0) {
      const t = Math.min(J - got, 0.5 * this.depE[i]);
      this.depE[i] -= t; got += t;
    }
    this.ledger.toObjects += got;
    return got;
  }

  private thickness(i: number) {
    const d = (this.depM[i] + this.depB[i]) / (this.rho * this.area) + this.depA[i] / (ASH_DEPOSIT_DENSITY * this.area);
    if (d === this.dep[i]) return;
    this.dep[i] = d;
    this.rev++;
    const ix = i % this.nx, iz = (i / this.nx) | 0, b = this.dirty;
    if (b.x1 < b.x0) { b.x0 = b.x1 = ix; b.z0 = b.z1 = iz; }
    else { if (ix < b.x0) b.x0 = ix; if (ix > b.x1) b.x1 = ix; if (iz < b.z0) b.z0 = iz; if (iz > b.z1) b.z1 = iz; }
  }

  clearDirty() {
    const b = this.dirty;
    b.x0 = 0; b.z0 = 0; b.x1 = -1; b.z1 = -1;
  }

  /** Cached temperatures of a vertex from its energy. */
  private refresh(i: number) {
    if (this.M[i] > 0) {
      const T = this.clampT(temperatureFromEnergy(this.mat, this.E[i] / this.M[i], this.Tref));
      this.T[i] = T;
      if (T > this.Tpeak[i]) this.Tpeak[i] = T;
    }
    const dm = this.depM[i] + this.depB[i];
    if (dm > 0) this.depT[i] = this.clampT(temperatureFromEnergy(this.mat, this.depE[i] / dm, this.Tref));
  }

  /**
   * Temperatures of vanishing masses (grams) can be off by round-off of E / M; nothing physical lies outside
   * [reference − 50 K, liquidus + 300 K], so the cached temperature is bounded (the energy itself is untouched).
   */
  private clampT(T: number): number {
    const lo = this.Tref - 50, hi = this.mat.thermal.TL + 300;
    return T < lo ? lo : T > hi ? hi : T;
  }

  // ── Flow ───────────────────────────────────────────────

  /** Flowing (non-rigid) depth of a vertex (m). */
  flowingDepth(i: number): number {
    const h = this.depth(i);
    if (h <= FILM) return 0;
    const Ti = this.T[i];
    if (Ti <= this.Tlock) return 0;
    const d = boundaryLayer(this.kappa, this.age[i], h);
    const below = this.depThicknessLava(i) > 0.01 ? this.depT[i] : Ti; // base boundary layer judged only on a lava deposit (ground side below)
    const top = rigidPart(d, Ti, this.Ts[i], this.Tlock);
    const base = rigidPart(d, Ti, Math.min(below, Ti), this.Tlock);
    return Math.max(0, h - top - base);
  }

  /**
   * Advance the flow by dt (s). Returns the number of sub-steps. Properties (T, η, τ_y) of each donor
   * are evaluated at the start of every sub-step from its current energy.
   */
  flow(dt: number): number {
    // Phase 31: the downward gravity of the step drives the flow (ρ·g·sinθ; 0 without downward gravity — the lava holds).
    const gLava = GRAVITY * gravityDown();
    const { nx, nz, area, rho, dx } = this;
    let left = dt, subs = 0;
    this.faces = 0;
    // Awake donors of this call; the rheology of each (η, τ_y, rigid crust) is evaluated once per call from
    // its current energy (the temperature does not change between sub-steps — it is refreshed after the flow),
    // vertices reached during the call join with their own mixed temperature.
    const call = ++this.callStamp;
    const awake = this.awakeList;
    awake.length = 0;
    for (const i of this.mobile) { this.speed[i] = 0; if (this.still[i] < SLEEP_AFTER && this.M[i] > 0) { awake.push(i); this.awakeStamp[i] = call; } }
    while (left > 1e-12 && subs < MAX_SUB) {
      // 1. face fluxes of the awake donors.
      let nf = 0, hMin = left;
      const minH = dt / MAX_SUB;
      for (let k = 0; k < awake.length; k++) {
        const i = awake[k];
        if (this.still[i] >= SLEEP_AFTER || this.M[i] <= 0) continue;
        if (this.cacheStamp[i] !== call) this.rheology(i, call);
        const h0 = this.depth(i);
        const hf = h0 <= FILM || this.cTau[i] < 0 ? 0 : Math.max(0, h0 - this.cRigid[i]);
        if (hf <= 0) { this.still[i]++; continue; }
        const eta = this.cEta[i], tau = this.cTau[i];
        const Si = this.bed(i) + this.depth(i);
        const ix = i % nx, iz = (i / nx) | 0;
        let any = false;
        for (let d = 0; d < 4; d++) {
          const jx = ix + (d === 0 ? 1 : d === 1 ? -1 : 0), jz = iz + (d === 2 ? 1 : d === 3 ? -1 : 0);
          let Sj: number, j: number;
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) {
            if (!this.open) continue;
            // Outside: the terrain continues its slope toward the edge (or stays level); no lava there.
            const ox = ix - (jx - ix), oz = iz - (jz - iz);
            const opp = ox >= 0 && oz >= 0 && ox < nx && oz < nz ? this.bed(oz * nx + ox) : this.bed(i);
            Sj = this.bed(i) - Math.max(0, opp - this.bed(i));
            j = -1;
          } else {
            j = jz * nx + jx;
            Sj = this.bed(j) + this.depth(j);
            // Obstacles: lava passes only above them.
            const ob = this.obstacle[j];
            if (ob > 0) { const top = this.bed(j) + ob; if (Si <= top) continue; Sj = Math.max(Sj, top); }
          }
          const dS = Si - Sj;
          if (dS <= 0) continue;
          const s = dS / dx, sinT = s / Math.sqrt(1 + s * s);
          const q = binghamFlux(hf, sinT, rho, eta, tau, gLava) * dx; // m³/s across the face
          if (q <= 0) continue;
          const cap = FACE_SHARE * dS * area;
          if (nf >= this.fFrom.length) this.grow();
          this.fFrom[nf] = i; this.fTo[nf] = j; this.fV[nf] = q; this.fCap[nf] = cap; nf++;
          const hq = cap / q;
          if (hq < hMin) hMin = hq;
          any = true;
          const v = q / (dx * Math.max(hf, 1e-6));
          if (v > this.speed[i]) this.speed[i] = v;
        }
        if (!any) this.still[i]++;
      }
      if (nf === 0) break;
      const h = Math.max(minH, Math.min(left, hMin));
      // 2. volumes: face cap (only binding when the sub-step cap was reached), then the donor's content.
      const out = this.outV;
      for (let f = 0; f < nf; f++) {
        let v = this.fV[f] * h;
        if (v > this.fCap[f]) { if (v > this.fCap[f] * (1 + 1e-9)) this.ledger.limited++; v = this.fCap[f]; }
        this.fV[f] = v;
        out[this.fFrom[f]] += v;
      }
      // 3. donor content: total outflow ≤ what the donor held at the start of the sub-step (positivity).
      for (let f = 0; f < nf; f++) {
        const i = this.fFrom[f];
        if (out[i] > this.M[i] / rho) this.fV[f] *= this.M[i] / rho / out[i];
      }
      // 4. apply with the donors' start-of-sub-step specific energy and age (face order does not matter).
      for (let f = 0; f < nf; f++) {
        const i = this.fFrom[f];
        if (out[i] === 0) continue;
        out[i] = 0;
        this.eSnap[i] = this.E[i] / this.M[i];
        this.aSnap[i] = this.age[i];
      }
      for (let f = 0; f < nf; f++) {
        const i = this.fFrom[f], j = this.fTo[f], v = this.fV[f];
        if (v <= 0) continue;
        // Emptying the donor moves exactly what it holds (no round-off remnant of energy without mass).
        const all = v * rho >= this.M[i] * (1 - 1e-9);
        const dm = all ? this.M[i] : v * rho, de = all ? this.E[i] : dm * this.eSnap[i];
        this.M[i] -= dm; this.E[i] -= de;
        if (j < 0) { this.ledger.outMass += dm; this.ledger.outEnergy += de; continue; }
        const mj = this.M[j];
        this.M[j] += dm; this.E[j] += de;
        this.age[j] = (this.age[j] * mj + this.aSnap[i] * dm) / this.M[j];
        this.wake(j);
      }
      this.faces += nf;
      left -= h;
      subs++;
    }
    this.substeps = subs;
    // Drop empty vertices from the mobile list; refresh temperatures; peaks.
    const keep: number[] = [];
    for (const i of this.mobile) {
      if (this.M[i] <= 1e-9) {
        // Round-off remnant: into the deposit (exact mass and energy).
        if (this.M[i] > 0) this.lock(i);
        this.M[i] = 0; this.E[i] = 0; this.inMobile[i] = 0; this.speed[i] = 0;
        continue;
      }
      this.refresh(i);
      const h = this.depth(i);
      if (h > this.hPeak[i]) this.hPeak[i] = h;
      keep.push(i);
    }
    this.mobile = keep;
    return subs;
  }

  private grow() {
    const m = this.fFrom.length * 2;
    const a = new Int32Array(m); a.set(this.fFrom); this.fFrom = a;
    const b = new Int32Array(m); b.set(this.fTo); this.fTo = b;
    const c = new Float64Array(m); c.set(this.fV); this.fV = c;
    const d = new Float64Array(m); d.set(this.fCap); this.fCap = d;
  }

  // ── Cooling ────────────────────────────────────────────

  private touch(i: number) {
    if (!this.heatTouched[i]) { this.heatTouched[i] = 1; this.touched.push(i); }
  }

  /** Move a vertex's mobile lava into its deposit layer (lock-up). */
  private lock(i: number) {
    const m = this.M[i];
    if (m <= 0) return;
    const m0 = this.depM[i] + this.depB[i];
    this.depM[i] += m;
    this.depE[i] += this.E[i];
    this.depAge[i] = (this.depAge[i] * m0 + this.age[i] * m) / (m0 + m);
    this.ledger.lockedMass += m;
    this.M[i] = 0; this.E[i] = 0;
    this.thickness(i);
    this.refresh(i);
    this.heat(i);
  }

  /**
   * Heat losses over dt (s): top (air + radiation, or water), base (ground, or the deposit below),
   * deposits (top / base); lock-up; retirement of cold deposits. Heat out is accumulated per vertex
   * (qGround / qAir / qRad / qWater) for the adapter.
   */
  cool(step: number, env: LavaSurroundings) {
    const mat = this.mat;
    this.clock += step;
    const cadence = this.depCount + 1 >= DEP_EVERY;
    for (const i of this.mobile) this.age[i] += step;
    for (const i of this.hot) this.depAge[i] += step;
    // Mobile columns: top to air / water, base to the deposit below or the ground. Lava that no longer
    // moves (asleep) is cooled at the deposit cadence over the time since it was last cooled (exact).
    for (const i of this.mobile) {
      const m = this.M[i];
      if (m <= 0) continue;
      if (this.still[i] >= SLEEP_AFTER && !cadence) continue;
      const dt = this.clock - this.cooledAt[i];
      this.cooledAt[i] = this.clock;
      if (dt <= 0) continue;
      const onDep = this.depThicknessLava(i) > 0.01;
      const t = this.top(i, this.T[i], this.depth(i), this.age[i], dt, env);
      const d = boundaryLayer(this.kappa, this.age[i], this.depth(i));
      const k = mat.thermal.k;
      const Tb = onDep ? this.depT[i] : env.groundT(i);
      let base = onDep
        ? ((this.T[i] - Tb) / (d / k + boundaryLayer(this.kappa, this.depAge[i], this.depThicknessLava(i)) / k)) * this.area * dt
        : ((this.T[i] - Tb) / (d / k + env.groundR(i))) * this.area * dt;
      if (onDep) {
        // Lava ↔ lava: never more than half of the way to the common temperature (either direction —
        // a thin film over a hot deposit must not overshoot). Sensible c_p only: a safe (smaller) bound.
        const cp = mat.thermal.cp, Cm = m * cp, Cd = (this.depM[i] + this.depB[i]) * cp;
        const half = 0.5 * Math.abs(this.T[i] - Tb) * ((Cm * Cd) / (Cm + Cd));
        if (base > half) base = half; else if (base < -half) base = -half;
      }
      const f = this.limit(this.E[i], m, this.T[i], Math.min(t.sink, Tb), Math.max(t.source, Tb), t.rad + t.conv + t.water + base, env.Tref);
      this.E[i] -= (t.rad + t.conv + t.water + base) * f;
      this.book(i, t.rad * f, t.conv * f, t.water * f, onDep ? 0 : base * f);
      if (this.sideNow.J > 0) { this.qSide[i] += this.sideNow.J * f; this.nSideX[i] += this.sideNow.nx; this.nSideZ[i] += this.sideNow.nz; }
      if (onDep) { this.depE[i] += base * f; this.heat(i); }
      this.refresh(i);
      if (crystalFraction(mat, this.T[i]) >= mat.phiLock) this.lock(i);
    }
    // Hot deposits: top to air / water (unless mobile lava covers them — that exchange is above), base to the ground.
    this.depAcc += step;
    if (++this.depCount < DEP_EVERY) return;
    const dt = this.depAcc;
    this.depAcc = 0;
    this.depCount = 0;
    const keep: number[] = [];
    for (const i of this.hot) {
      const dm = this.depM[i] + this.depB[i];
      if (dm <= 0 || this.depE[i] === 0) { this.inHot[i] = 0; continue; }
      this.refresh(i);
      const Td = this.depT[i], hD = this.depThicknessLava(i);
      if (hD < THIN_DEPOSIT && this.M[i] <= 0) {
        this.book(i, 0, 0, 0, this.depE[i]);
        this.depE[i] = 0;
        this.depT[i] = env.groundT(i);
        this.inHot[i] = 0;
        continue;
      }
      const covered = this.M[i] > 0;
      const t = covered ? NO_TOP : this.top(i, Td, hD, this.depAge[i], dt, env);
      const Tg = env.groundT(i);
      const d = boundaryLayer(this.kappa, this.depAge[i], hD);
      const base = ((Td - Tg) / (d / this.mat.thermal.k + env.groundR(i))) * this.area * dt;
      const f = this.limit(this.depE[i], dm, Td, Math.min(t.sink, Tg), Math.max(t.source, Tg), t.rad + t.conv + t.water + base, env.Tref);
      this.depE[i] -= (t.rad + t.conv + t.water + base) * f;
      this.book(i, t.rad * f, t.conv * f, t.water * f, base * f);
      this.refresh(i);
      // Retire: close to the ground below and the air above — the rest of its heat goes into the ground.
      if (!covered && Math.abs(this.depT[i] - Tg) < RETIRE_DT && Math.abs(this.depT[i] - env.airT(i)) < 4 * RETIRE_DT) {
        this.book(i, 0, 0, 0, this.depE[i]);
        this.depE[i] = 0;
        this.depT[i] = Tg;
        this.Ts[i] = Tg;
        this.inHot[i] = 0;
        continue;
      }
      keep.push(i);
    }
    this.hot = keep;
  }

  /** Top losses of a column (J over dt) and its surface temperature (kept in Ts). */
  private top(i: number, Ti: number, h: number, age: number, dt: number, env: LavaSurroundings): { rad: number; conv: number; water: number; sink: number; source: number } {
    const { k, emissivity: eps } = this.mat.thermal;
    const d = boundaryLayer(this.kappa, age, h);
    const A = this.area;
    this.sideNow.J = 0;
    if (env.waterDepth(i) > 1e-3) {
      const Tw = env.waterT(i);
      const Ts = surfaceUnderWater(Ti, d, k, Tw);
      this.Ts[i] = Ts;
      return { rad: 0, conv: 0, water: H_WATER * (Ts - Tw) * A * dt, sink: Tw, source: Tw };
    }
    const Ta = env.airT(i), Tsky = env.Tref;
    const hc = env.pr ? hGround(Math.max(this.Ts[i], Ta), Ta, env.wind(i), 1, env.pr(i)) : hGround(Math.max(this.Ts[i], Ta), Ta, env.wind(i));
    const Ts = surfaceTemperature(Ti, d, k, eps, Tsky, hc, Ta, this.Ts[i]);
    this.Ts[i] = Ts;
    const q = eps * SIGMA * (Ts ** 4 - Tsky ** 4);
    // Margins: the faces standing above lava-free neighbours radiate sideways (same crust temperature).
    let side = 0, nx = 0, nz = 0;
    if (this.M[i] > 0) {
      const ix = i % this.nx, iz = (i / this.nx) | 0, S = this.surface(i);
      for (let dd = 0; dd < 4; dd++) {
        const jx = ix + (dd === 0 ? 1 : dd === 1 ? -1 : 0), jz = iz + (dd === 2 ? 1 : dd === 3 ? -1 : 0);
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const j = jz * this.nx + jx;
        if (this.M[j] > 0) continue;
        const e = Math.min(h, S - this.bed(j));
        if (e <= 0) continue;
        const a = e * this.dx;
        side += a;
        nx += (jx - ix) * a; nz += (jz - iz) * a;
      }
    }
    const sideJ = q * side * dt;
    this.sideNow.J = sideJ; this.sideNow.nx = nx; this.sideNow.nz = nz;
    return { rad: q * A * dt + sideJ, conv: hc * (Ts - Ta) * A * dt, water: 0, sink: Math.min(Ta, Tsky), source: Math.max(Ta, Tsky) };
  }

  /**
   * Factor (≤ 1) on this step's exchanges so a column gives at most 90 % of what it holds above its coldest
   * surroundings — or, when it gains (hotter air / ground / deposit around a cooled film), at most 90 % of the
   * way to its hottest surroundings (thin films over a 0.1 s step). The terms are scaled together and booked
   * as scaled, so the ledgers stay exact.
   */
  private limit(E: number, m: number, Ti: number, sink: number, source: number, lost: number, Tref: number): number {
    if (lost > 0) {
      const avail = E - m * specificEnergy(this.mat, Math.max(Tref - 50, Math.min(Ti, sink)), this.Tref);
      return lost > 0.9 * avail ? Math.max(0, 0.9 * avail) / lost : 1;
    }
    if (lost < 0) {
      const room = m * specificEnergy(this.mat, Math.max(Ti, source), this.Tref) - E;
      return -lost > 0.9 * room ? Math.max(0, 0.9 * room) / -lost : 1;
    }
    return 1;
  }

  private depAcc = 0;
  private depCount = 0;
  /** Time cooled so far (s) and, per mobile vertex, the time it was last cooled. */
  private clock = 0;
  private cooledAt = new Float64Array(0);
  /** Margin radiation of the column just evaluated by top() (J, outward normal × area). */
  private readonly sideNow = { J: 0, nx: 0, nz: 0 };

  private book(i: number, rad: number, conv: number, water: number, ground: number) {
    const L = this.ledger;
    this.qRad[i] += rad; L.radiated += rad;
    this.qAir[i] += conv; L.toAir += conv;
    this.qWater[i] += water; L.toWater += water;
    this.qGround[i] += ground; L.toGround += ground;
    this.touch(i);
  }

  depThicknessLava(i: number) {
    return (this.depM[i] + this.depB[i]) / (this.rho * this.area);
  }

  /** Hand over the heat accumulated per vertex (the adapter clears it after turning it into source steps). */
  drain(f: (i: number, ground: number, air: number, rad: number, water: number) => void) {
    for (const i of this.touched) {
      f(i, this.qGround[i], this.qAir[i], this.qRad[i], this.qWater[i]);
      this.qGround[i] = 0; this.qAir[i] = 0; this.qRad[i] = 0; this.qWater[i] = 0;
      this.qSide[i] = 0; this.nSideX[i] = 0; this.nSideZ[i] = 0;
      this.heatTouched[i] = 0;
    }
    this.touched = [];
  }

  // ── Totals ─────────────────────────────────────────────

  mobileMass() { let s = 0; for (const i of this.mobile) s += this.M[i]; return s; }
  mobileEnergy() { let s = 0; for (const i of this.mobile) s += this.E[i]; return s; }
  depositMass() { let s = 0; for (let i = 0; i < this.n; i++) s += this.depM[i]; return s; }
  bombDeposit() { let s = 0; for (let i = 0; i < this.n; i++) s += this.depB[i]; return s; }
  ashDeposit() { let s = 0; for (let i = 0; i < this.n; i++) s += this.depA[i]; return s; }
  depositEnergy() { let s = 0; for (const i of this.hot) s += this.depE[i]; return s; }
  /** Undrained heat still in the accumulators (J). */
  pendingHeat() { let s = 0; for (const i of this.touched) s += this.qGround[i] + this.qAir[i] + this.qRad[i] + this.qWater[i]; return s; }

  /** Energy balance of the field: in − out − held (J) → round-off only. */
  energyResidual(): number {
    const L = this.ledger;
    const held = this.mobileEnergy() + this.depositEnergy();
    return L.suppliedEnergy + L.bombEnergy - L.outEnergy - L.toGround - L.toAir - L.radiated - L.toWater - L.toObjects - held;
  }

  massResidual(): number {
    const L = this.ledger;
    return L.suppliedMass + L.bombMass + L.ashMass - L.outMass - this.mobileMass() - this.depositMass() - this.bombDeposit() - this.ashDeposit();
  }
}
