/**
 * WaterSolver (Phase 14): 2-D overland flow on the WaterField.
 *
 * Model — the "local inertial" shallow-water approximation (Bates, Horritt & Fewtrell 2010,
 * LISFLOOD-FP), with the θ-weighting of de Almeida et al. (2012):
 *
 *   q⁽ⁿ⁺¹⁾ = [θ·q + (1−θ)/2·(q₋ + q₊) − g·h_f·Δt·∂η/∂x] / [1 + g·Δt·n²·|q| / h_f^(7/3)]
 *   h⁽ⁿ⁺¹⁾ = h + Δt·(q_in − q_out) / Δx
 *
 * q is the discharge per meter of face (m²/s) on a staggered grid, η = bed + h the water
 * surface, h_f = max(η_L, η_R) − max(bed_L, bed_R) the depth available to flow across a face,
 * n the Manning roughness (implicit friction). The local inertial form keeps the pressure
 * (surface slope), friction and local acceleration terms of the shallow-water momentum equation
 * and drops convective acceleration — adequate for slow floodplain inundation, NOT for
 * supercritical torrents, bores or dam-break fronts (a Froude limiter keeps it stable there).
 * It is an approximate, educational model; it does not guarantee hydraulic accuracy.
 *
 * Guarantees:
 *  - conservation: every face flux is subtracted from one cell and added to its neighbor, so
 *    water is only created or removed by explicit, budgeted terms (rain, sources, boundaries,
 *    infiltration, drainage); the budget's `error` is pure floating-point round-off.
 *  - non-negative depth: before the depth update, a cell whose outgoing fluxes would remove
 *    more water than it holds has them scaled down to exactly its volume (a conservative
 *    outflow limiter — the scaled flux is also what the neighbor receives).
 *  - stability for any caller Δt: the call is split into adaptive substeps
 *    Δt_sub ≤ CFL·Δx / max(√(g·h_f) + |u|) (Courant number 0.7).
 *  - determinism: fixed iteration order, no randomness, Float64 state.
 *
 * Multi-hazard terms (Phase 15, only with interactions on, see WaterForcing): surface wind
 * stress τ/ρ_w on faces deeper than 5 cm, and the inertial load of the shaking ground −h·Δv_g.
 *
 * Performance: only the bounding box of cells that ever held water (+1 cell ring) is swept;
 * all buffers are preallocated (no allocation per step).
 */
import { GRAVITY } from '@/core/units';
import type { BoundarySide } from '@/core/model';
import type { WaterField } from './WaterField';
import type { ResolvedBoundary, WaterForcing } from './WaterForcing';
import { CFL, FLOOD_DEPTH, FROUDE_MAX, H_FLOW_MIN, MAX_SUBSTEPS, OPEN_EDGE_SLOPE, THETA, WATER_DENSITY, WET_DEPTH } from './waterParams';

const G = GRAVITY;
/** Wind stress acts only on water at least this deep (thin sheets are friction-dominated). */
export const STRESS_MIN_DEPTH = 0.05;

/*
 * ∛x for the friction term hf^(7/3) = hf²·∛hf. Math.cbrt costs ~25 ns in the face loop
 * (≈ 40 % of the solver), so two linearly interpolated tables are used instead: x < 1/64 m
 * with step 2⁻¹⁶ and x < 16 m with step 2⁻¹⁰ (relative error < 7·10⁻⁴ for x ≥ H_FLOW_MIN,
 * negligible next to the uncertainty of Manning's n). Deterministic like any arithmetic.
 */
const CBRT_FINE = new Float64Array(1026);
const CBRT_COARSE = new Float64Array(16386);
for (let i = 0; i < CBRT_FINE.length; i++) CBRT_FINE[i] = Math.cbrt(i / 65536);
for (let i = 0; i < CBRT_COARSE.length; i++) CBRT_COARSE[i] = Math.cbrt(i / 1024);

export function cbrtFast(x: number): number {
  if (x < 0.015625) {
    const t = x * 65536;
    const i = t | 0;
    return CBRT_FINE[i] + (t - i) * (CBRT_FINE[i + 1] - CBRT_FINE[i]);
  }
  if (x < 16) {
    const t = x * 1024;
    const i = t | 0;
    return CBRT_COARSE[i] + (t - i) * (CBRT_COARSE[i + 1] - CBRT_COARSE[i]);
  }
  return Math.cbrt(x);
}

export class WaterSolver {
  /** Max wave speed √(g·h) + |u| seen on the last substep (CFL estimate for the next one). */
  private waveSpeed = 0;
  /** Old z-face fluxes of the previous row (θ weighting needs pre-update neighbors). */
  private rowOld: Float64Array;
  /** Last call: substep count and smallest substep. */
  substeps = 0;
  minDt = 0;
  /** Set when MAX_SUBSTEPS was hit (should never happen in practice). */
  saturated = false;
  /** Duration of the current step() call (the ground-velocity change is spread over it). */
  private callDt = 0;
  /**
   * Gravity (Phase 31): the downward component of the uniform field (m/s²; G without a gravity experiment) and its
   * horizontal components — the latter enter as a body force h·g_h (a tilted reference surface, through the same term
   * as the earthquake's inertial load). Under a spatial field each cell has its own components (null = uniform); a
   * face uses the mean of its two cells; the CFL bound uses the largest downward component.
   */
  g = G;
  tiltX = 0;
  tiltZ = 0;
  gCell: Float32Array | null = null;
  gxCell: Float32Array | null = null;
  gzCell: Float32Array | null = null;
  gMax = G;

  /** Set the gravity for the next step() (uniform: arrays null). Downward components below 0 are not represented (held at 0). */
  setGravity(down: number, gx: number, gz: number, cells: { down: Float32Array; x: Float32Array; z: Float32Array } | null = null) {
    this.g = Math.max(0, down);
    this.tiltX = gx;
    this.tiltZ = gz;
    if (cells) {
      this.gCell = cells.down; this.gxCell = cells.x; this.gzCell = cells.z;
      let m = 0;
      for (let i = 0; i < cells.down.length; i++) if (cells.down[i] > m) m = cells.down[i];
      this.gMax = m;
    } else {
      this.gCell = this.gxCell = this.gzCell = null;
      this.gMax = this.g;
    }
  }

  constructor(readonly field: WaterField, readonly forcing: WaterForcing) {
    this.rowOld = new Float64Array(field.nx);
    // Fixed-level edges can push water in anywhere along them: keep them in the active range.
    for (const side of ['N', 'S', 'E', 'W'] as BoundarySide[]) this.touchEdge(side);
    this.waveSpeed = this.initialWaveSpeed();
  }

  /** Include a whole map edge in the active range (fixed-level edges). */
  touchEdge(side: BoundarySide) {
    if (this.forcing.boundary(side).type !== 'fixedLevel') return;
    const f = this.field;
    if (side === 'W') { f.touch(0, 0); f.touch(0, f.nz - 1); }
    if (side === 'E') { f.touch(f.nx - 1, 0); f.touch(f.nx - 1, f.nz - 1); }
    if (side === 'N') { f.touch(0, 0); f.touch(f.nx - 1, 0); }
    if (side === 'S') { f.touch(0, f.nz - 1); f.touch(f.nx - 1, f.nz - 1); }
  }

  private initialWaveSpeed(): number {
    const f = this.field;
    let hmax = 0;
    for (let i = 0; i < f.count; i++) if (f.h[i] > hmax) hmax = f.h[i];
    return Math.sqrt(this.gMax * hmax);
  }

  /** Deepest possible ghost depth at fixed-level edges (bounds the wave speed of inflow). */
  private boundaryDepth(): number {
    const f = this.field;
    let d = 0;
    for (const side of ['N', 'S', 'E', 'W'] as BoundarySide[]) {
      const b = this.forcing.boundary(side);
      if (b.type !== 'fixedLevel') continue;
      const n = side === 'N' || side === 'S' ? f.nx : f.nz;
      for (let k = 0; k < n; k++) {
        const ix = side === 'W' ? 0 : side === 'E' ? f.nx - 1 : k;
        const iz = side === 'N' ? 0 : side === 'S' ? f.nz - 1 : k;
        const i = iz * f.nx + ix;
        const g = b.level - f.bed[i];
        if (g > d) d = g;
      }
    }
    return d;
  }

  /** Advance the water by `dt` seconds (any dt > 0; split into stable substeps). */
  step(dt: number) {
    const f = this.field;
    let remaining = dt;
    this.callDt = dt;
    let n = 0;
    this.minDt = dt;
    this.saturated = false;
    const ghost = Math.sqrt(this.gMax * this.boundaryDepth());
    while (remaining > 1e-12) {
      // Previous substep's wave speed, the deepest water anywhere (sources may have deepened
      // still water) and the ghost depth of fixed-level edges.
      const speed = Math.max(this.waveSpeed, Math.sqrt(this.gMax * f.stats.maxDepth), ghost);
      const limit = speed > 0 ? (CFL * f.cell) / speed : remaining;
      // Equal-sized substeps for what is left (avoids a sliver at the end).
      const parts = Math.ceil(remaining / limit - 1e-9);
      const sub = remaining / Math.max(1, parts);
      this.substep(sub);
      if (sub < this.minDt) this.minDt = sub;
      remaining -= sub;
      if (++n >= MAX_SUBSTEPS && remaining > 1e-12) {
        // Safety net only: never reached for physical depths on a 1 m grid.
        this.saturated = true;
        this.substep(remaining);
        remaining = 0;
      }
    }
    this.substeps = n;
    if (this.forcing.airPending) {
      this.forcing.airImpulse!.fill(0);
      this.forcing.airPending = false;
    }
    f.time += dt;
    f.rev++;
    f.budget.current = f.totalVolume();
    f.budget.error =
      f.budget.current - (f.budget.initial + f.budget.rain + f.budget.sources + f.budget.boundaryIn - f.budget.boundaryOut - f.budget.infiltration - f.budget.drainage + f.budget.melt - f.budget.frozen - f.budget.evaporated + f.budget.condensed);
    f.updateStats();
    f.stats.substeps = n;
    f.stats.minDt = this.minDt;
  }

  private substep(dt: number) {
    const f = this.field;
    this.applySources(dt);
    this.applyLosses(dt);
    if (!f.hasWater()) {
      this.waveSpeed = 0;
      return;
    }
    if (f.iceLoad) this.computeFluxesIce(dt);
    else this.computeFluxes(dt);
    this.limitOutflow(dt);
    // Phase 26: heat rides on the limited face volumes (no-op without a thermal run).
    if (f.heat) this.advectHeat(dt);
    this.updateDepth(dt);
  }

  // ── 1. Inputs (rain, point sources) ──────────────────────

  private applySources(dt: number) {
    const f = this.field;
    const { h, redirect } = f;
    const heat = f.heat;
    const ex = heat ? f.inflowExcess : 0;
    const A = f.cellArea;
    const nx = f.nx;
    for (const r of this.forcing.rains) {
      const d = r.rate * dt;
      if (d <= 0) continue;
      if (r.cells === null) {
        for (let i = 0; i < f.count; i++) h[redirect[i]] += d;
        if (ex !== 0) { for (let i = 0; i < f.count; i++) heat![redirect[i]] += d * ex; f.heatOut -= d * ex * f.count; }
        f.budget.rain += d * A * f.count;
        f.touch(0, 0);
        f.touch(f.nx - 1, f.nz - 1);
      } else {
        const cells = r.cells;
        for (let k = 0; k < cells.length; k++) {
          const j = redirect[cells[k]];
          h[j] += d;
          if (ex !== 0) heat![j] += d * ex;
          f.touch(j % nx, (j / nx) | 0);
        }
        if (ex !== 0) f.heatOut -= d * ex * cells.length;
        f.budget.rain += d * A * cells.length;
      }
    }
    for (const s of this.forcing.sources) {
      if (s.rate <= 0) continue;
      const cells = s.cells;
      const d = (s.rate * dt) / (A * cells.length);
      for (let k = 0; k < cells.length; k++) {
        const j = cells[k];
        h[j] += d;
        if (ex !== 0) heat![j] += d * ex;
        f.touch(j % nx, (j / nx) | 0);
      }
      if (ex !== 0) f.heatOut -= d * ex * cells.length;
      f.budget.sources += d * A * cells.length;
    }
  }

  // ── 2. Losses (infiltration into the soil bucket, storm drains) ─

  private applyLosses(dt: number) {
    const f = this.field;
    if (!f.hasWater()) return;
    const { h, infilRate, infilStore, infiltrated, drainRate, nx } = f;
    const heat = f.heat;
    const ifac = f.infilFactor;
    const keep = f.drainKeep;
    let inf = 0;
    let drn = 0;
    for (let iz = f.z0; iz <= f.z1; iz++) {
      for (let i = iz * nx + f.x0, e = iz * nx + f.x1; i <= e; i++) {
        let d = h[i];
        if (d <= 0) continue;
        let aInf = 0, aDrn = 0;
        const store = infilStore[i];
        if (store > 0) {
          const room = store - infiltrated[i];
          if (room > 0) {
            // Capacity falls linearly as the soil column fills (bucket model).
            let a = infilRate[i] * (room / store) * dt;
            if (ifac !== null) a *= ifac[i];
            if (a > room) a = room;
            if (a > d) a = d;
            d -= a;
            infiltrated[i] += a;
            inf += a;
            aInf = a;
          }
        }
        const dr = drainRate[i];
        if (dr > 0 && d > keep) {
          let a = dr * dt;
          if (a > d - keep) a = d - keep;
          d -= a;
          drn += a;
          aDrn = a;
        }
        if (heat !== null && heat[i] !== 0 && d < h[i]) {
          // Water leaving takes its share of the heat (well mixed): soil ← infiltration, drains → lost.
          const e = heat[i] / h[i];
          f.infilHeat![i] += e * aInf;
          f.heatOut += e * aDrn;
          heat[i] -= e * (aInf + aDrn);
        }
        h[i] = d;
      }
    }
    f.budget.infiltration += inf * f.cellArea;
    f.budget.drainage += drn * f.cellArea;
  }

  // ── 3. Face fluxes (local inertial momentum) ─────────────

  /*
   * Face update (inlined twice below for speed — this is the hot loop):
   *   q0 = θ·q + (1−θ)/2·(q₋ + q₊)
   *   q' = (q0 − g·hf·Δt·(η_R − η_L)/Δx) / (1 + g·Δt·n²·|q0| / hf^(7/3)),   |q'| ≤ Fr_max·hf·√(g·hf)
   * hf^(7/3) = hf²·∛hf (table cube root); the CFL bound uses √(g·max hf) + max|u| (one sqrt per sweep).
   */
  private computeFluxes(dt: number) {
    const f = this.field;
    const { nx, nz, h, bed, n2, qx, qz, blocked } = f;
    const dx = f.cell;
    const xa = Math.max(0, f.x0 - 1);
    const xb = Math.min(nx - 1, f.x1 + 1);
    const za = Math.max(0, f.z0 - 1);
    const zb = Math.min(nz - 1, f.z1 + 1);
    const W = nx + 1;
    const gU = this.g;
    const gc = this.gCell, gxc = this.gxCell, gzc = this.gzCell;
    const gdt = gU * dt;
    const slopeK = gdt / dx;
    const FR2 = FROUDE_MAX * FROUDE_MAX;
    // Bed friction g·n²·|q|q/h^(7/3) keeps EARTH g (Phase 31): Manning's n is calibrated at g₀ and hides √g (n ∝ √(g₀/g)
    // for a fixed Darcy roughness), so g·n² = g₀·n² — the shear stress ρ·f·u²/8 of the bed does not depend on gravity.
    const gdt0 = G * dt;
    const th = THETA;
    const th2 = (1 - THETA) * 0.5;
    const fr2 = FROUDE_MAX * FROUDE_MAX * gU;
    let hfMax = 0;
    let uMax = 0;
    // Interaction terms (Phase 15), all zero in single-hazard runs → identical arithmetic path.
    const ws = this.forcing.windStress;
    const gdv = this.forcing.groundDv;
    const share = this.callDt > 0 ? dt / this.callDt : 0;
    const sX = ws[0] * dt;
    const sZ = ws[1] * dt;
    // Horizontal gravity (Phase 31): +h·g_h — the opposite of a ground acceleration, same term.
    const gX = this.tiltX !== 0 ? gdv[0] * share - this.tiltX * dt : gdv[0] * share;
    const gZ = this.tiltZ !== 0 ? gdv[1] * share - this.tiltZ * dt : gdv[1] * share;
    const extX = sX !== 0 || gX !== 0 || gxc !== null;
    const extZ = sZ !== 0 || gZ !== 0 || gzc !== null;
    // Air-pressure waves (Phase 24): −h·∂(∫p dt)/∂x / ρ_w, the call's share of it (null otherwise).
    const air = this.forcing.airPending ? this.forcing.airImpulse : null;
    const airK = air !== null ? share / (WATER_DENSITY * dx) : 0;

    // x faces, row by row (face k lies between cells k−1 and k).
    for (let iz = za; iz <= zb; iz++) {
      const row = iz * nx;
      const frow = iz * W;
      let prevOld = qx[frow + xa]; // old value of the face left of the first updated one
      for (let k = xa + 1; k <= xb; k++) {
        const L = row + k - 1;
        const R = L + 1;
        const fi = frow + k;
        const old = qx[fi];
        const hL = h[L];
        const hR = h[R];
        let qn = 0;
        if ((hL > 0 || hR > 0) && blocked[L] === 0 && blocked[R] === 0) {
          const bL = bed[L];
          const bR = bed[R];
          const eL = bL + hL;
          const eR = bR + hR;
          const hf = (eL > eR ? eL : eR) - (bL > bR ? bL : bR);
          if (hf > H_FLOW_MIN) {
            const q0 = th * old + th2 * (prevOld + qx[fi + 1]);
            const aq = q0 < 0 ? -q0 : q0;
            const H = hf * hf * cbrtFast(hf);
            let num = q0 - (gc === null ? slopeK : (0.5 * (gc[L] + gc[R]) * dt) / dx) * hf * (eR - eL);
            if (extX) num += (hf > STRESS_MIN_DEPTH ? sX : 0) - hf * (gxc === null ? gX : gX - 0.5 * (gxc[L] + gxc[R]) * dt);
            if (air !== null) num -= hf * airK * (air[R] - air[L]);
            qn = (num * H) / (H + gdt0 * 0.5 * (n2[L] + n2[R]) * aq);
            // Froude limiter: q² ≤ Fr²·g·hf³
            const lim = (gc === null ? fr2 : FR2 * 0.5 * (gc[L] + gc[R])) * hf * hf * hf;
            if (qn * qn > lim) qn = qn > 0 ? Math.sqrt(lim) : -Math.sqrt(lim);
            // Gravity waves travel even through still water: hf always enters the CFL bound.
            if (hf > hfMax) hfMax = hf;
            const u = (qn < 0 ? -qn : qn) / hf;
            if (u > uMax) uMax = u;
          }
        }
        prevOld = old;
        qx[fi] = qn;
      }
    }

    // z faces (face row k lies between cell rows k−1 and k).
    const rowOld = this.rowOld;
    for (let ix = xa; ix <= xb; ix++) rowOld[ix] = qz[za * nx + ix];
    for (let k = za + 1; k <= zb; k++) {
      const top = (k - 1) * nx;
      for (let ix = xa; ix <= xb; ix++) {
        const T = top + ix;
        const B = T + nx;
        const fi = B; // face row k, column ix = k·nx + ix
        const old = qz[fi];
        const hT = h[T];
        const hB = h[B];
        let qn = 0;
        if ((hT > 0 || hB > 0) && blocked[T] === 0 && blocked[B] === 0) {
          const bT = bed[T];
          const bB = bed[B];
          const eT = bT + hT;
          const eB = bB + hB;
          const hf = (eT > eB ? eT : eB) - (bT > bB ? bT : bB);
          if (hf > H_FLOW_MIN) {
            const q0 = th * old + th2 * (rowOld[ix] + qz[fi + nx]);
            const aq = q0 < 0 ? -q0 : q0;
            const H = hf * hf * cbrtFast(hf);
            let num = q0 - (gc === null ? slopeK : (0.5 * (gc[T] + gc[B]) * dt) / dx) * hf * (eB - eT);
            if (extZ) num += (hf > STRESS_MIN_DEPTH ? sZ : 0) - hf * (gzc === null ? gZ : gZ - 0.5 * (gzc[T] + gzc[B]) * dt);
            if (air !== null) num -= hf * airK * (air[B] - air[T]);
            qn = (num * H) / (H + gdt0 * 0.5 * (n2[T] + n2[B]) * aq);
            const lim = (gc === null ? fr2 : FR2 * 0.5 * (gc[T] + gc[B])) * hf * hf * hf;
            if (qn * qn > lim) qn = qn > 0 ? Math.sqrt(lim) : -Math.sqrt(lim);
            if (hf > hfMax) hfMax = hf;
            const u = (qn < 0 ? -qn : qn) / hf;
            if (u > uMax) uMax = u;
          }
        }
        rowOld[ix] = old;
        qz[fi] = qn;
      }
    }
    let speed = Math.sqrt((gc === null ? gU : this.gMax) * hfMax) + uMax;

    // Boundary faces (only the part of each edge inside the active range).
    if (xa === 0) for (let iz = za; iz <= zb; iz++) speed = Math.max(speed, this.edgeFace('W', iz * nx, iz * W, -1, iz * nx + 1, dt));
    if (xb === nx - 1) for (let iz = za; iz <= zb; iz++) speed = Math.max(speed, this.edgeFace('E', iz * nx + nx - 1, iz * W + nx, +1, iz * nx + nx - 2, dt));
    if (za === 0) for (let ix = xa; ix <= xb; ix++) speed = Math.max(speed, this.edgeFace('N', ix, ix, -1, nx + ix, dt));
    if (zb === nz - 1) for (let ix = xa; ix <= xb; ix++) speed = Math.max(speed, this.edgeFace('S', (nz - 1) * nx + ix, nz * nx + ix, +1, (nz - 2) * nx + ix, dt));
    this.waveSpeed = speed;
  }

  /**
   * Phase 30: the same face update under floating ice — the ice weight (as water depth) adds to the surface
   * that drives the flow, the ice underside adds friction (n² × iceFric); ice frozen to the bed raises the bed (the
   * cell's water lies on it and flows over it).
   * The flowing depth stays the liquid depth. A simplified boundary condition, not an under-ice flow model.
   */
  private computeFluxesIce(dt: number) {
    const iceL = this.field.iceLoad!, fric = this.field.iceFric!, frz = this.field.frozen!;
    const f = this.field;
    const { nx, nz, h, bed, n2, qx, qz, blocked } = f;
    const dx = f.cell;
    const xa = Math.max(0, f.x0 - 1);
    const xb = Math.min(nx - 1, f.x1 + 1);
    const za = Math.max(0, f.z0 - 1);
    const zb = Math.min(nz - 1, f.z1 + 1);
    const W = nx + 1;
    const gU = this.g;
    const gc = this.gCell, gxc = this.gxCell, gzc = this.gzCell;
    const gdt = gU * dt;
    const slopeK = gdt / dx;
    const FR2 = FROUDE_MAX * FROUDE_MAX;
    // Bed friction g·n²·|q|q/h^(7/3) keeps EARTH g (Phase 31): Manning's n is calibrated at g₀ and hides √g (n ∝ √(g₀/g)
    // for a fixed Darcy roughness), so g·n² = g₀·n² — the shear stress ρ·f·u²/8 of the bed does not depend on gravity.
    const gdt0 = G * dt;
    const th = THETA;
    const th2 = (1 - THETA) * 0.5;
    const fr2 = FROUDE_MAX * FROUDE_MAX * gU;
    let hfMax = 0;
    let uMax = 0;
    // Interaction terms (Phase 15), all zero in single-hazard runs → identical arithmetic path.
    const ws = this.forcing.windStress;
    const gdv = this.forcing.groundDv;
    const share = this.callDt > 0 ? dt / this.callDt : 0;
    const sX = ws[0] * dt;
    const sZ = ws[1] * dt;
    // Horizontal gravity (Phase 31): +h·g_h — the opposite of a ground acceleration, same term.
    const gX = this.tiltX !== 0 ? gdv[0] * share - this.tiltX * dt : gdv[0] * share;
    const gZ = this.tiltZ !== 0 ? gdv[1] * share - this.tiltZ * dt : gdv[1] * share;
    const extX = sX !== 0 || gX !== 0 || gxc !== null;
    const extZ = sZ !== 0 || gZ !== 0 || gzc !== null;
    // Air-pressure waves (Phase 24): −h·∂(∫p dt)/∂x / ρ_w, the call's share of it (null otherwise).
    const air = this.forcing.airPending ? this.forcing.airImpulse : null;
    const airK = air !== null ? share / (WATER_DENSITY * dx) : 0;

    // x faces, row by row (face k lies between cells k−1 and k).
    for (let iz = za; iz <= zb; iz++) {
      const row = iz * nx;
      const frow = iz * W;
      let prevOld = qx[frow + xa]; // old value of the face left of the first updated one
      for (let k = xa + 1; k <= xb; k++) {
        const L = row + k - 1;
        const R = L + 1;
        const fi = frow + k;
        const old = qx[fi];
        const hL = h[L];
        const hR = h[R];
        let qn = 0;
        if ((hL > 0 || hR > 0) && blocked[L] === 0 && blocked[R] === 0) {
          // Ice frozen to the bed raises it (iceL = thickness, no load); floating ice adds its draft to the head.
          const bL = bed[L] + (frz[L] ? iceL[L] : 0);
          const bR = bed[R] + (frz[R] ? iceL[R] : 0);
          const eL = bL + hL;
          const eR = bR + hR;
          const hf = (eL > eR ? eL : eR) - (bL > bR ? bL : bR);
          if (hf > H_FLOW_MIN) {
            const q0 = th * old + th2 * (prevOld + qx[fi + 1]);
            const aq = q0 < 0 ? -q0 : q0;
            const H = hf * hf * cbrtFast(hf);
            let num = q0 - (gc === null ? slopeK : (0.5 * (gc[L] + gc[R]) * dt) / dx) * hf * (eR + (frz[R] ? 0 : iceL[R]) - eL - (frz[L] ? 0 : iceL[L]));
            if (extX) num += (hf > STRESS_MIN_DEPTH ? sX : 0) - hf * (gxc === null ? gX : gX - 0.5 * (gxc[L] + gxc[R]) * dt);
            if (air !== null) num -= hf * airK * (air[R] - air[L]);
            qn = (num * H) / (H + gdt0 * 0.5 * (n2[L] * fric[L] + n2[R] * fric[R]) * aq);
            // Froude limiter: q² ≤ Fr²·g·hf³
            const lim = (gc === null ? fr2 : FR2 * 0.5 * (gc[L] + gc[R])) * hf * hf * hf;
            if (qn * qn > lim) qn = qn > 0 ? Math.sqrt(lim) : -Math.sqrt(lim);
            // Gravity waves travel even through still water: hf always enters the CFL bound.
            if (hf > hfMax) hfMax = hf;
            const u = (qn < 0 ? -qn : qn) / hf;
            if (u > uMax) uMax = u;
          }
        }
        prevOld = old;
        qx[fi] = qn;
      }
    }

    // z faces (face row k lies between cell rows k−1 and k).
    const rowOld = this.rowOld;
    for (let ix = xa; ix <= xb; ix++) rowOld[ix] = qz[za * nx + ix];
    for (let k = za + 1; k <= zb; k++) {
      const top = (k - 1) * nx;
      for (let ix = xa; ix <= xb; ix++) {
        const T = top + ix;
        const B = T + nx;
        const fi = B; // face row k, column ix = k·nx + ix
        const old = qz[fi];
        const hT = h[T];
        const hB = h[B];
        let qn = 0;
        if ((hT > 0 || hB > 0) && blocked[T] === 0 && blocked[B] === 0) {
          // Ice frozen to the bed raises it (iceL = thickness, no load); floating ice adds its draft to the head.
          const bT = bed[T] + (frz[T] ? iceL[T] : 0);
          const bB = bed[B] + (frz[B] ? iceL[B] : 0);
          const eT = bT + hT;
          const eB = bB + hB;
          const hf = (eT > eB ? eT : eB) - (bT > bB ? bT : bB);
          if (hf > H_FLOW_MIN) {
            const q0 = th * old + th2 * (rowOld[ix] + qz[fi + nx]);
            const aq = q0 < 0 ? -q0 : q0;
            const H = hf * hf * cbrtFast(hf);
            let num = q0 - (gc === null ? slopeK : (0.5 * (gc[T] + gc[B]) * dt) / dx) * hf * (eB + (frz[B] ? 0 : iceL[B]) - eT - (frz[T] ? 0 : iceL[T]));
            if (extZ) num += (hf > STRESS_MIN_DEPTH ? sZ : 0) - hf * (gzc === null ? gZ : gZ - 0.5 * (gzc[T] + gzc[B]) * dt);
            if (air !== null) num -= hf * airK * (air[B] - air[T]);
            qn = (num * H) / (H + gdt0 * 0.5 * (n2[T] * fric[T] + n2[B] * fric[B]) * aq);
            const lim = (gc === null ? fr2 : FR2 * 0.5 * (gc[T] + gc[B])) * hf * hf * hf;
            if (qn * qn > lim) qn = qn > 0 ? Math.sqrt(lim) : -Math.sqrt(lim);
            if (hf > hfMax) hfMax = hf;
            const u = (qn < 0 ? -qn : qn) / hf;
            if (u > uMax) uMax = u;
          }
        }
        rowOld[ix] = old;
        qz[fi] = qn;
      }
    }
    let speed = Math.sqrt((gc === null ? gU : this.gMax) * hfMax) + uMax;

    // Boundary faces (only the part of each edge inside the active range).
    if (xa === 0) for (let iz = za; iz <= zb; iz++) speed = Math.max(speed, this.edgeFace('W', iz * nx, iz * W, -1, iz * nx + 1, dt));
    if (xb === nx - 1) for (let iz = za; iz <= zb; iz++) speed = Math.max(speed, this.edgeFace('E', iz * nx + nx - 1, iz * W + nx, +1, iz * nx + nx - 2, dt));
    if (za === 0) for (let ix = xa; ix <= xb; ix++) speed = Math.max(speed, this.edgeFace('N', ix, ix, -1, nx + ix, dt));
    if (zb === nz - 1) for (let ix = xa; ix <= xb; ix++) speed = Math.max(speed, this.edgeFace('S', (nz - 1) * nx + ix, nz * nx + ix, +1, (nz - 2) * nx + ix, dt));
    this.waveSpeed = speed;
  }

  /**
   * Flux through a boundary face of cell `c`. `out` = +1 when the outward normal points along
   * +axis (east, south), −1 otherwise. Writes the face (qx for W/E, qz for N/S) and returns the
   * wave speed. `inner` is the next cell inward (for the open-edge slope).
   */
  private edgeFace(side: BoundarySide, c: number, fi: number, out: 1 | -1, inner: number, dt: number): number {
    const f = this.field;
    const arr = side === 'W' || side === 'E' ? f.qx : f.qz;
    const b: ResolvedBoundary = this.forcing.boundary(side);
    const hc = f.h[c];
    const zc = f.bed[c];
    if (b.type === 'closed' || f.blocked[c]) {
      arr[fi] = 0;
      return 0;
    }
    const dx = f.cell;
    const gE = this.gCell ? this.gCell[c] : this.g;
    // Phase 30: floating ice adds its underside friction at the edge too (iceFric null without a climate).
    const n2 = f.iceFric ? f.n2[c] * f.iceFric[c] : f.n2[c];
    // Discharge in the OUTWARD direction (positive = leaving the map).
    const qOld = arr[fi] * out;
    let qOut: number;
    let hf: number;
    if (b.type === 'open') {
      if (hc <= H_FLOW_MIN) {
        arr[fi] = 0;
        return 0;
      }
      // Ghost cell: the terrain continues downhill with the edge's own slope (≥ OPEN_EDGE_SLOPE),
      // same depth → water leaves at a friction-limited, normal-flow-like rate. Never inflow.
      const inward = f.bed[inner] - zc;
      const slope = Math.max(OPEN_EDGE_SLOPE, inward / dx);
      hf = hc;
      qOut = (qOld + gE * hf * dt * slope) / (1 + (G * dt * n2 * Math.abs(qOld)) / (hf * hf * cbrtFast(hf)));
      if (qOut < 0) qOut = 0;
    } else {
      // Fixed water level outside: ghost cell with the same bed and surface = level.
      const etaG = Math.max(b.level, zc);
      const etaC = zc + hc;
      hf = Math.max(etaG, etaC) - zc;
      if (hf <= H_FLOW_MIN) {
        arr[fi] = 0;
        return 0;
      }
      qOut = (qOld - gE * hf * dt * ((etaG - etaC) / dx)) / (1 + (G * dt * n2 * Math.abs(qOld)) / (hf * hf * cbrtFast(hf)));
    }
    const qmax = FROUDE_MAX * hf * Math.sqrt(gE * hf);
    if (qOut > qmax) qOut = qmax;
    else if (qOut < -qmax) qOut = -qmax;
    arr[fi] = qOut * out;
    if (qOut !== 0) f.touch(c % f.nx, (c / f.nx) | 0);
    return Math.sqrt(gE * hf) + Math.abs(qOut) / hf;
  }

  // ── 4. Positivity (conservative outflow limiter) ─────────

  private limitOutflow(dt: number) {
    const f = this.field;
    const { nx, h, qx, qz } = f;
    const W = nx + 1;
    const k = dt / f.cell; // volume out / area = Σq·Δt/Δx
    const xa = Math.max(0, f.x0 - 1);
    const xb = Math.min(nx - 1, f.x1 + 1);
    const za = Math.max(0, f.z0 - 1);
    const zb = Math.min(f.nz - 1, f.z1 + 1);
    for (let iz = za; iz <= zb; iz++) {
      for (let ix = xa; ix <= xb; ix++) {
        const i = iz * nx + ix;
        const w = iz * W + ix;
        const n = i;
        const s = i + nx;
        const qw = qx[w];
        const qe = qx[w + 1];
        const qn = qz[n];
        const qs = qz[s];
        const out = (qw < 0 ? -qw : 0) + (qe > 0 ? qe : 0) + (qn < 0 ? -qn : 0) + (qs > 0 ? qs : 0);
        if (out <= 0) continue;
        const avail = h[i];
        if (out * k <= avail) continue;
        const r = avail / (out * k);
        if (qw < 0) qx[w] = qw * r;
        if (qe > 0) qx[w + 1] = qe * r;
        if (qn < 0) qz[n] = qn * r;
        if (qs > 0) qz[s] = qs * r;
      }
    }
  }

  // ── 4b. Heat advection (Phase 26) ──────────────────────

  private heatDelta: Float64Array | null = null;

  /**
   * Upwind heat transport with the face volumes the depth update is about to use: a face carries
   * the donor cell's heat in proportion to the depth it removes (q·Δt/Δx of its h). Exactly
   * conservative and bounded (the limiter keeps every outflow ≤ the donor's water, hence ≤ its
   * heat); water entering through an edge carries the reference temperature (no heat).
   */
  private advectHeat(dt: number) {
    const f = this.field;
    const { nx, nz, h, qx, qz } = f;
    const heat = f.heat!;
    const d = (this.heatDelta ??= new Float64Array(f.count));
    const W = nx + 1;
    const k = dt / f.cell;
    const xa = Math.max(0, f.x0 - 1);
    const xb = Math.min(nx - 1, f.x1 + 1);
    const za = Math.max(0, f.z0 - 1);
    const zb = Math.min(nz - 1, f.z1 + 1);
    const share = (c: number, vol: number) => (h[c] > 0 && heat[c] !== 0 ? (heat[c] * vol) / h[c] : 0);
    const ex = f.inflowExcess;
    let moved = 0, out = 0, inflow = 0;
    for (let iz = za; iz <= zb; iz++) {
      const row = iz * nx;
      for (let kx = xa; kx <= xb + 1; kx++) {
        const q = qx[iz * W + kx];
        if (q === 0) continue;
        const L = kx - 1, R = kx;
        if (q > 0) {
          // Inflow through the map edge (R3, Phase 31): liquid at the melting point when the reference is colder.
          if (L < 0 && ex !== 0) { const e = q * k * ex; d[row + R] += e; inflow += e; continue; }
          if (L < xa) continue; // inflow from the edge / outside the range: reference water
          const e = share(row + L, q * k);
          d[row + L] -= e;
          if (R <= nx - 1) d[row + R] += e; else out += e;
          moved += Math.abs(e);
        } else {
          if (R > nx - 1 && ex !== 0) { const e = -q * k * ex; d[row + L] += e; inflow += e; continue; }
          if (R > xb) continue;
          const e = share(row + R, -q * k);
          d[row + R] -= e;
          if (L >= 0) d[row + L] += e; else out += e;
          moved += Math.abs(e);
        }
      }
    }
    for (let kz = za; kz <= zb + 1; kz++) {
      for (let ix = xa; ix <= xb; ix++) {
        const q = qz[kz * nx + ix];
        if (q === 0) continue;
        const T = kz - 1, B = kz;
        if (q > 0) {
          if (T < 0 && ex !== 0) { const e = q * k * ex; d[B * nx + ix] += e; inflow += e; continue; }
          if (T < za) continue;
          const e = share(T * nx + ix, q * k);
          d[T * nx + ix] -= e;
          if (B <= nz - 1) d[B * nx + ix] += e; else out += e;
          moved += Math.abs(e);
        } else {
          if (B > nz - 1 && ex !== 0) { const e = -q * k * ex; d[T * nx + ix] += e; inflow += e; continue; }
          if (B > zb) continue;
          const e = share(B * nx + ix, -q * k);
          d[B * nx + ix] -= e;
          if (T >= 0) d[T * nx + ix] += e; else out += e;
          moved += Math.abs(e);
        }
      }
    }
    for (let iz = za; iz <= zb; iz++) for (let i = iz * nx + xa, e = iz * nx + xb; i <= e; i++) if (d[i] !== 0) { heat[i] += d[i]; d[i] = 0; }
    f.heatOut += out - inflow;
    f.heatMoved += moved;
  }

  // ── 5. Continuity, boundary bookkeeping, velocities ──────

  private updateDepth(dt: number) {
    const f = this.field;
    const { nx, nz, h, qx, qz, u, v, maxDepth, floodTime } = f;
    const W = nx + 1;
    const dx = f.cell;
    const k = dt / dx;
    const xa = Math.max(0, f.x0 - 1);
    const xb = Math.min(nx - 1, f.x1 + 1);
    const za = Math.max(0, f.z0 - 1);
    const zb = Math.min(nz - 1, f.z1 + 1);
    // Boundary exchange (volume = q · face length · Δt).
    const vol = dx * dt;
    let bin = 0;
    let bout = 0;
    if (xa === 0) for (let iz = za; iz <= zb; iz++) { const q = qx[iz * W]; if (q > 0) bin += q; else bout -= q; }
    if (xb === nx - 1) for (let iz = za; iz <= zb; iz++) { const q = qx[iz * W + nx]; if (q < 0) bin -= q; else bout += q; }
    if (za === 0) for (let ix = xa; ix <= xb; ix++) { const q = qz[ix]; if (q > 0) bin += q; else bout -= q; }
    if (zb === nz - 1) for (let ix = xa; ix <= xb; ix++) { const q = qz[nz * nx + ix]; if (q < 0) bin -= q; else bout += q; }
    f.budget.boundaryIn += bin * vol;
    f.budget.boundaryOut += bout * vol;

    // New active range = old range ∪ ring cells that received water.
    let nx0 = f.x0;
    let nx1 = f.x1;
    let nz0 = f.z0;
    let nz1 = f.z1;
    for (let iz = za; iz <= zb; iz++) {
      for (let ix = xa; ix <= xb; ix++) {
        const i = iz * nx + ix;
        const w = iz * W + ix;
        const qw = qx[w];
        const qe = qx[w + 1];
        const qn = qz[i];
        const qs = qz[i + nx];
        let d = h[i] + k * (qw - qe + qn - qs);
        // Round-off only (the limiter guarantees ≥ 0 in exact arithmetic); the clamp's tiny
        // gain shows up in the budget error.
        if (d < 0) d = 0;
        h[i] = d;
        if (d > 0) {
          if (ix < nx0) nx0 = ix;
          else if (ix > nx1) nx1 = ix;
          if (iz < nz0) nz0 = iz;
          else if (iz > nz1) nz1 = iz;
          const he = d > WET_DEPTH ? d : WET_DEPTH;
          let uu = (0.5 * (qw + qe)) / he;
          let vv = (0.5 * (qn + qs)) / he;
          // Reconstructed cell velocity (objects, display, statistics — not the fluxes): at a
          // wetting front a face discharge divided by a nearly dry cell's depth overshoots, so it
          // obeys the same Froude bound as the faces.
          const s2 = uu * uu + vv * vv;
          const lim2 = FROUDE_MAX * FROUDE_MAX * (this.gCell ? this.gCell[i] : this.g) * he;
          if (s2 > lim2) {
            const r = Math.sqrt(lim2 / s2);
            uu *= r;
            vv *= r;
          }
          u[i] = uu;
          v[i] = vv;
          if (d > maxDepth[i]) maxDepth[i] = d;
          if (d >= FLOOD_DEPTH) floodTime[i] += dt;
        } else {
          u[i] = 0;
          v[i] = 0;
        }
      }
    }
    f.x0 = nx0;
    f.x1 = nx1;
    f.z0 = nz0;
    f.z1 = nz1;
  }
}
