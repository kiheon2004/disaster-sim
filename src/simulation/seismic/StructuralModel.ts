/**
 * Reduced multi-degree-of-freedom structural response (Phase 13), all structures in one
 * structure-of-arrays model (Float64Array, no per-step allocation).
 *
 * Each unit (building, pole, sign, wall) is a lumped-mass shear chain on a foundation:
 *
 *        m_n ─┐
 *             ├ story n   (bilinear hysteretic spring + damper, P-Δ)
 *        …    │
 *        m_1 ─┤
 *             ├ story 1
 *        m_f ─┤ foundation (optional): spring–dashpot to the ground with a slip limit
 *   ground ═══╧══  ← ground acceleration a_g(t) (from GroundMotionField)
 *
 * Coordinates are displacements RELATIVE TO THE GROUND, so the ground motion enters as the
 * inertial load −m·a_g. Two horizontal directions (unit-local x / z) are integrated
 * independently (no biaxial interaction). Integration: semi-implicit (symplectic) Euler with a
 * per-unit number of substeps chosen from the highest frequency, so every unit is stable at
 * the 60 Hz simulation step; the schedule only depends on the unit's properties
 * (deterministic).
 *
 * Story spring (per direction): elastic stiffness k_eff = k·(1 − 0.4·D), yield force
 * F_y,eff = F_y·(1 − 0.3·D), post-yield stiffness ratio α (bilinear, kinematic), geometric
 * P-Δ stiffness −P/h, stiffness-proportional damping c = 2ζk/ω₁.
 * Damage index per story (Park–Ang style): D = θ_max/θ_u + β·Σ|Δθ_p|/θ_u.
 */

const BETA = 0.05;
/** ω_max·h ≤ STABILITY per substep. */
const STABILITY = 0.4;
const MAX_SUBSTEPS = 64;
export const MAX_DOF = 5;

export interface UnitInit {
  /** Lumped floors (1 … MAX_DOF). */
  ndof: number;
  /** Superstructure mass (kg). */
  mass: number;
  /** Total height (m). */
  height: number;
  /** Target fundamental period, fixed base (s). */
  period: number;
  dampingRatio: number;
  /** Yield base-shear coefficients along local x / z (× weight). */
  cyX: number;
  cyZ: number;
  hardening: number;
  /** Ultimate drift ratio (damage index = 1). */
  driftU: number;
  /** Heading (rad about +Y): local axes = world axes rotated by yaw. */
  yaw: number;
  gravity: number;
  /** Foundation (null = fixed base). */
  foundation: { mass: number; stiffness: number; dampingRatio: number; slipX: number; slipZ: number } | null;
  /**
   * Per-dof properties (Phase 17 modular buildings, already lumped to `ndof` entries). Replaces
   * the uniform chain derived from `period` / `cyX` / `cyZ`: story stiffness may differ between
   * stories (soft stories) and between the two directions. Damping c = 2ζk/ω₁ per direction with
   * ω₁ of the given chain. Absent → uniform chain (Phase 13 path, bit-identical).
   */
  stories?: { mass: number[]; height: number[]; kx: number[]; kz: number[]; fyX: number[]; fyZ: number[] };
}

export class StructuralModel {
  units = 0;
  /** Total degrees of freedom (incl. foundations). */
  dofs = 0;
  // ── per unit ───────────────────────────────────────────
  off = new Int32Array(0);
  n = new Int32Array(0);
  /** Highest natural frequency estimate (rad/s) → substeps per step. */
  wMax = new Float64Array(0);
  cos = new Float64Array(0);
  sin = new Float64Array(0);
  driftU = new Float64Array(0);
  hasF = new Uint8Array(0);
  fK = new Float64Array(0);
  fC = new Float64Array(0);
  fSlip = new Float64Array(0); // 2 per unit (local x, z)
  fP = new Float64Array(0); // foundation slip offset, 2 per unit
  /** Ground acceleration input (world x, z), set by the system before step(). */
  agx = new Float64Array(0);
  agz = new Float64Array(0);
  /**
   * External quasi-static force on the top lumped story (world x, z; N) — the mean wind load
   * during an earthquake (Phase 15 multi-hazard interaction). 0 = none (bit-identical path).
   */
  fwx = new Float64Array(0);
  fwz = new Float64Array(0);
  /** Outputs (world axes): top / foundation displacement relative to the ground (2 per unit). */
  top = new Float64Array(0);
  base = new Float64Array(0);
  /** Current max story drift ratio, peak drift, damage index (max over stories). */
  drift = new Float64Array(0);
  peakDrift = new Float64Array(0);
  damage = new Float64Array(0);
  /** Overturning moment about the base, local x / z (N·m). */
  otm = new Float64Array(0);
  /** Base shear magnitude (N). */
  baseShear = new Float64Array(0);
  // ── per dof (index off + j; j = 0 foundation, 1..n floors) ─────────
  m = new Float64Array(0);
  /** Story stiffness / damping per direction: 2 per dof (local x, z). */
  k = new Float64Array(0);
  c = new Float64Array(0);
  fy = new Float64Array(0); // 2 per dof
  /** Units built from per-story data (non-uniform heights → generic story lookup). */
  irregular = new Uint8Array(0);
  pdel = new Float64Array(0);
  hs = new Float64Array(0);
  alpha = new Float64Array(0);
  /** Height of the dof above the base (m). */
  z = new Float64Array(0);
  u = new Float64Array(0); // 2 per dof
  v = new Float64Array(0); // 2 per dof
  p = new Float64Array(0); // plastic offset, 2 per dof (story below the dof)
  cum = new Float64Array(0); // cumulative plastic drift ratio of the story below
  thMax = new Float64Array(0);
  storyD = new Float64Array(0);
  /** Absolute horizontal acceleration of the dof at the end of the step (world x, z). */
  acc = new Float64Array(0); // 2 per dof
  /** Peak absolute horizontal floor acceleration magnitude over the run (m/s²). */
  peakAcc = new Float64Array(0);

  private force = new Float64Array(MAX_DOF + 2);
  private accL = new Float64Array(MAX_DOF + 2);
  private inits: UnitInit[] = [];

  /** Register a unit; call finalize() once all units are added. Returns the unit index. */
  add(init: UnitInit): number {
    this.inits.push(init);
    return this.inits.length - 1;
  }

  finalize() {
    const U = this.inits.length;
    let D = 0;
    for (const i of this.inits) D += Math.min(MAX_DOF, Math.max(1, Math.round(i.ndof))) + 1;
    this.units = U;
    this.dofs = D;
    const f = (n: number) => new Float64Array(n);
    this.off = new Int32Array(U); this.n = new Int32Array(U); this.wMax = f(U);
    this.cos = f(U); this.sin = f(U); this.driftU = f(U); this.hasF = new Uint8Array(U);
    this.fK = f(U); this.fC = f(U); this.fSlip = f(2 * U); this.fP = f(2 * U);
    this.agx = f(U); this.agz = f(U); this.fwx = f(U); this.fwz = f(U); this.top = f(2 * U); this.base = f(2 * U);
    this.drift = f(U); this.peakDrift = f(U); this.damage = f(U); this.otm = f(2 * U); this.baseShear = f(U);
    this.m = f(D); this.k = f(2 * D); this.c = f(2 * D); this.fy = f(2 * D); this.pdel = f(D); this.hs = f(D); this.alpha = f(D); this.z = f(D);
    this.irregular = new Uint8Array(U);
    this.u = f(2 * D); this.v = f(2 * D); this.p = f(2 * D); this.cum = f(D); this.thMax = f(D); this.storyD = f(D);
    this.acc = f(2 * D); this.peakAcc = f(D);

    let o = 0;
    this.inits.forEach((init, ui) => {
      const n = Math.min(MAX_DOF, Math.max(1, Math.round(init.ndof)));
      this.off[ui] = o;
      this.n[ui] = n;
      this.cos[ui] = Math.cos(init.yaw);
      this.sin[ui] = Math.sin(init.yaw);
      this.driftU[ui] = init.driftU;
      if (init.stories) {
        o += this.initStories(ui, o, n, init);
        return;
      }
      const mf = init.mass / n;
      const h = init.height / n;
      const w1 = (2 * Math.PI) / Math.max(0.02, init.period);
      // Uniform fixed-base shear chain: ω₁ = 2√(k/m)·sin(π / (2(2n+1))).
      const kk = mf * (w1 / (2 * Math.sin(Math.PI / (2 * (2 * n + 1))))) ** 2;
      const cc = (2 * init.dampingRatio * kk) / w1;
      // Story yield strengths ∝ first-mode story shear, story 1 = Cy·W.
      let shear1 = 0;
      const shear: number[] = [];
      for (let s = 1; s <= n; s++) {
        let v = 0;
        for (let j = s; j <= n; j++) v += Math.sin((Math.PI * j) / (2 * n + 1));
        shear.push(v);
        if (s === 1) shear1 = v;
      }
      const W = init.mass * init.gravity;
      for (let j = 1; j <= n; j++) {
        const d = o + j;
        this.m[d] = mf;
        this.k[2 * d] = kk;
        this.k[2 * d + 1] = kk;
        this.c[2 * d] = cc;
        this.c[2 * d + 1] = cc;
        this.hs[d] = h;
        this.z[d] = h * j;
        this.alpha[d] = init.hardening;
        const share = shear[j - 1] / shear1;
        this.fy[2 * d] = init.cyX * W * share;
        this.fy[2 * d + 1] = init.cyZ * W * share;
        // Weight carried by story j (masses j … n) over the story height.
        this.pdel[d] = (mf * (n - j + 1) * init.gravity) / h;
      }
      const wMax = 2 * Math.sqrt(kk / mf) * 1.05 + cc / mf;
      this.wMax[ui] = this.initFoundation(ui, o, init, kk, wMax);
      o += n + 1;
    });
    this.inits = [];
  }

  /** Foundation dof of a unit; returns the unit's highest-frequency estimate. */
  private initFoundation(ui: number, o: number, init: UnitInit, kFirst: number, wMax: number): number {
    if (init.foundation) {
      const F = init.foundation;
      this.hasF[ui] = 1;
      this.m[o] = F.mass;
      // Keep the foundation stable at MAX_SUBSTEPS (stiffer than this = effectively rigid).
      const kMax = F.mass * ((STABILITY * MAX_SUBSTEPS * 60) ** 2) * 0.5;
      this.fK[ui] = Math.min(F.stiffness, kMax);
      this.fC[ui] = 2 * F.dampingRatio * Math.sqrt(this.fK[ui] * F.mass);
      this.fSlip[2 * ui] = F.slipX;
      this.fSlip[2 * ui + 1] = F.slipZ;
      return Math.max(wMax, Math.sqrt((this.fK[ui] + kFirst) / F.mass) + this.fC[ui] / F.mass);
    }
    this.m[o] = 1;
    return wMax;
  }

  /** Per-story unit (Phase 17). Returns the number of dofs used (n + 1). */
  private initStories(ui: number, o: number, n: number, init: UnitInit): number {
    const st = init.stories!;
    this.irregular[ui] = 1;
    let z = 0;
    let above = 0;
    for (let j = n; j >= 1; j--) above += st.mass[j - 1];
    // Fundamental circular frequency of each direction's chain (for stiffness-proportional damping).
    const w1 = [chainOmega(st.mass, st.kx), chainOmega(st.mass, st.kz)];
    let wMax = 0;
    for (let j = 1; j <= n; j++) {
      const d = o + j;
      const m = Math.max(1, st.mass[j - 1]);
      const h = Math.max(0.5, st.height[j - 1]);
      z += h;
      this.m[d] = m;
      this.hs[d] = h;
      this.z[d] = z;
      this.alpha[d] = init.hardening;
      for (let ax = 0; ax < 2; ax++) {
        const kk = Math.max(1, ax === 0 ? st.kx[j - 1] : st.kz[j - 1]);
        this.k[2 * d + ax] = kk;
        this.c[2 * d + ax] = (2 * init.dampingRatio * kk) / w1[ax];
        this.fy[2 * d + ax] = Math.max(1, ax === 0 ? st.fyX[j - 1] : st.fyZ[j - 1]);
      }
      this.pdel[d] = (above * init.gravity) / h;
      above -= st.mass[j - 1];
    }
    // Gershgorin bound of the chain's highest frequency (both directions).
    for (let j = 1; j <= n; j++) {
      const d = o + j;
      for (let ax = 0; ax < 2; ax++) {
        const kUp = j < n ? this.k[2 * (d + 1) + ax] : 0;
        const cUp = j < n ? this.c[2 * (d + 1) + ax] : 0;
        const w = Math.sqrt((this.k[2 * d + ax] + kUp) / this.m[d]) * 1.05 + (this.c[2 * d + ax] + cUp) / this.m[d];
        if (w > wMax) wMax = w;
      }
    }
    this.wMax[ui] = this.initFoundation(ui, o, init, Math.max(this.k[2 * (o + 1)], this.k[2 * (o + 1) + 1]), wMax);
    return n + 1;
  }

  /**
   * Scale the stiffness / yield strength of one story (dof j = 1..n) along one local axis —
   * structural members of that story failed (Phase 17). Stability is kept: stiffness only drops.
   */
  scaleStory(ui: number, j: number, ax: 0 | 1, kFactor: number, fyFactor: number) {
    const d = this.off[ui] + j;
    const i = 2 * d + ax;
    this.k[i] *= Math.max(1e-4, Math.min(1, kFactor));
    this.c[i] *= Math.max(1e-4, Math.min(1, kFactor));
    this.fy[i] *= Math.max(1e-4, Math.min(1, fyFactor));
  }

  /**
   * Partial collapse (Phase 17): dofs j … n no longer exist. Their mass, stiffness, damping and
   * strength are scaled by ε (same k/m ratio → same substep count, negligible forces) and the
   * P-Δ weight of the remaining stories is recomputed.
   */
  truncateFrom(ui: number, j: number, gravity: number) {
    const o = this.off[ui];
    const n = this.n[ui];
    const eps = 1e-6;
    for (let q = Math.max(1, j); q <= n; q++) {
      const d = o + q;
      this.m[d] *= eps;
      this.pdel[d] = 0;
      for (let ax = 0; ax < 2; ax++) {
        this.k[2 * d + ax] *= eps;
        this.c[2 * d + ax] *= eps;
        this.fy[2 * d + ax] *= eps;
      }
    }
    let above = 0;
    for (let q = j - 1; q >= 1; q--) {
      const d = o + q;
      above += this.m[d];
      this.pdel[d] = (above * gravity) / this.hs[d];
    }
  }

  /** Relative displacement of dof j over dof j−1 along a LOCAL axis (m). */
  storyDelta(ui: number, j: number, ax: 0 | 1): number {
    const d = this.off[ui] + j;
    return this.u[2 * d + ax] - this.u[2 * (d - 1) + ax];
  }

  /**
   * Reduce a unit's yield strength by a factor (0–1] — damage it already carries from another
   * hazard when the earthquake starts (Phase 15, residual strength).
   */
  scaleStrength(ui: number, factor: number) {
    if (factor >= 1) return;
    const o = this.off[ui];
    for (let j = 1; j <= this.n[ui]; j++) {
      this.fy[2 * (o + j)] *= factor;
      this.fy[2 * (o + j) + 1] *= factor;
    }
  }

  /** Advance every unit by dt with the ground accelerations in agx / agz. */
  step(dt: number) {
    for (let ui = 0; ui < this.units; ui++) this.stepUnit(ui, dt);
  }

  stepUnit(ui: number, dt: number) {
    const o = this.off[ui];
    const n = this.n[ui];
    const ns = this.substeps(ui, dt);
    const h = dt / ns;
    const cs = this.cos[ui];
    const sn = this.sin[ui];
    // World → local (yaw about +Y: local x = (cos, 0, −sin), local z = (sin, 0, cos)).
    const gx = this.agx[ui];
    const gz = this.agz[ui];
    const agL0 = gx * cs - gz * sn;
    const agL1 = gx * sn + gz * cs;
    const wx = this.fwx[ui];
    const wz = this.fwz[ui];
    const extL0 = wx * cs - wz * sn;
    const extL1 = wx * sn + wz * cs;
    const hasF = this.hasF[ui] === 1;
    const F = this.force;
    const A = this.accL;
    const m = this.m, k = this.k, c = this.c, fy = this.fy, pd = this.pdel, al = this.alpha, sd = this.storyD;
    const u = this.u, v = this.v, p = this.p;
    let ot0 = 0, ot1 = 0, vb0 = 0, vb1 = 0;
    for (let ax = 0; ax < 2; ax++) {
      const ag = ax === 0 ? agL0 : agL1;
      for (let s = 0; s < ns; s++) {
        // Story forces (story j between dof j−1 and j).
        for (let j = 1; j <= n; j++) {
          const d = o + j;
          const i2 = 2 * d + ax;
          const below = 2 * (d - 1) + ax;
          const delta = u[i2] - u[below];
          const D = sd[d];
          const ke = k[i2] * (1 - 0.4 * (D > 1 ? 1 : D));
          const fye = fy[i2] * (1 - 0.3 * (D > 1 ? 1 : D));
          const a1 = 1 - al[d];
          let e = delta - p[i2];
          const ey = fye / ke;
          if (e > ey) {
            this.cum[d] += (e - ey) / this.hs[d];
            e = ey;
            p[i2] = delta - e;
          } else if (e < -ey) {
            this.cum[d] += (-ey - e) / this.hs[d];
            e = -ey;
            p[i2] = delta - e;
          }
          F[j] = al[d] * ke * delta + a1 * ke * e - pd[d] * delta + c[i2] * (v[i2] - v[below]);
        }
        F[n + 1] = 0;
        // Foundation spring with slip.
        const f2 = 2 * o + ax;
        if (hasF) {
          const kf = this.fK[ui];
          const slip = this.fSlip[2 * ui + ax];
          const fp = 2 * ui + ax;
          let e = u[f2] - this.fP[fp];
          const ey = slip / kf;
          if (e > ey) { e = ey; this.fP[fp] = u[f2] - e; }
          else if (e < -ey) { e = -ey; this.fP[fp] = u[f2] - e; }
          F[0] = kf * e + this.fC[ui] * v[f2];
          A[0] = -ag - (F[0] - F[1]) / m[o];
        } else {
          A[0] = 0;
        }
        for (let j = 1; j <= n; j++) A[j] = -ag - (F[j] - F[j + 1]) / m[o + j];
        const ext = ax === 0 ? extL0 : extL1;
        if (ext !== 0) A[n] += ext / m[o + n];
        // Semi-implicit Euler: velocities, then positions.
        for (let j = hasF ? 0 : 1; j <= n; j++) {
          const i2 = 2 * (o + j) + ax;
          v[i2] += A[j] * h;
          u[i2] += v[i2] * h;
        }
      }
      // End-of-step absolute accelerations (local, converted to world below) and the
      // overturning moment / base shear.
      let ot = 0;
      for (let j = 0; j <= n; j++) {
        const absA = ag + A[j];
        this.acc[2 * (o + j) + ax] = absA;
        if (j > 0) ot += m[o + j] * absA * this.z[o + j];
      }
      if (ax === 0) { ot0 = ot; vb0 = F[1]; } else { ot1 = ot; vb1 = F[1]; }
    }
    this.otm[2 * ui] = ot0;
    this.otm[2 * ui + 1] = ot1;
    this.baseShear[ui] = Math.hypot(vb0, vb1);
    // Drift, damage, peak accelerations; local → world for outputs.
    let maxDrift = 0;
    let maxD = 0;
    const thU = this.driftU[ui];
    for (let j = 1; j <= n; j++) {
      const d = o + j;
      const dx = u[2 * d] - u[2 * (d - 1)];
      const dz = u[2 * d + 1] - u[2 * (d - 1) + 1];
      const th = Math.sqrt(dx * dx + dz * dz) / this.hs[d];
      if (th > maxDrift) maxDrift = th;
      if (th > this.thMax[d]) this.thMax[d] = th;
      const D = this.thMax[d] / thU + (BETA * this.cum[d]) / thU;
      sd[d] = D;
      if (D > maxD) maxD = D;
    }
    for (let j = 0; j <= n; j++) {
      const d = o + j;
      const lx = this.acc[2 * d];
      const lz = this.acc[2 * d + 1];
      const wx = lx * cs + lz * sn;
      const wz = -lx * sn + lz * cs;
      this.acc[2 * d] = wx;
      this.acc[2 * d + 1] = wz;
      const mag = Math.sqrt(wx * wx + wz * wz);
      if (j > 0 && mag > this.peakAcc[d]) this.peakAcc[d] = mag;
    }
    const top = 2 * (o + n);
    this.top[2 * ui] = u[top] * cs + u[top + 1] * sn;
    this.top[2 * ui + 1] = -u[top] * sn + u[top + 1] * cs;
    const b = 2 * o;
    this.base[2 * ui] = u[b] * cs + u[b + 1] * sn;
    this.base[2 * ui + 1] = -u[b] * sn + u[b + 1] * cs;
    this.drift[ui] = maxDrift;
    if (maxDrift > this.peakDrift[ui]) this.peakDrift[ui] = maxDrift;
    this.damage[ui] = maxD;
  }

  // ── Queries (story s = 1..n, dof j = 0..n) ───────────────

  /** Story containing height y above the base (1..n). */
  storyAt(ui: number, y: number): number {
    const n = this.n[ui];
    if (this.irregular[ui]) {
      const o = this.off[ui];
      for (let j = 1; j < n; j++) if (y < this.z[o + j]) return j;
      return n;
    }
    const s = Math.floor(y / this.hs[this.off[ui] + 1]) + 1;
    return s < 1 ? 1 : s > n ? n : s;
  }

  /** Current drift ratio of a story. */
  storyDrift(ui: number, s: number): number {
    const d = this.off[ui] + s;
    const dx = this.u[2 * d] - this.u[2 * (d - 1)];
    const dz = this.u[2 * d + 1] - this.u[2 * (d - 1) + 1];
    return Math.sqrt(dx * dx + dz * dz) / this.hs[d];
  }

  peakStoryDrift(ui: number, s: number): number {
    return this.thMax[this.off[ui] + s];
  }

  /** Absolute horizontal acceleration magnitude at height y (linear between dofs). */
  accelAt(ui: number, y: number): number {
    const o = this.off[ui];
    const n = this.n[ui];
    let x: number;
    if (this.irregular[ui]) {
      // Fractional dof index from the cumulative dof heights.
      x = n;
      let zPrev = 0;
      for (let j = 1; j <= n; j++) {
        const zj = this.z[o + j];
        if (y < zj) {
          x = j - 1 + Math.max(0, (y - zPrev) / Math.max(1e-6, zj - zPrev));
          break;
        }
        zPrev = zj;
      }
    } else x = Math.max(0, Math.min(n, y / this.hs[o + 1]));
    const j = Math.min(n - 1, Math.floor(x));
    const f = x - j;
    const ax = this.acc[2 * (o + j)] * (1 - f) + this.acc[2 * (o + j + 1)] * f;
    const az = this.acc[2 * (o + j) + 1] * (1 - f) + this.acc[2 * (o + j + 1) + 1] * f;
    return Math.sqrt(ax * ax + az * az);
  }

  /** Horizontal velocity (world x, z) of the top relative to the ground, written into out. */
  topVelocity(ui: number, out: [number, number]): [number, number] {
    const t = 2 * (this.off[ui] + this.n[ui]);
    const cs = this.cos[ui], sn = this.sin[ui];
    out[0] = this.v[t] * cs + this.v[t + 1] * sn;
    out[1] = -this.v[t] * sn + this.v[t + 1] * cs;
    return out;
  }

  /** Fundamental frequency (Hz) of the current (degraded) fixed-base chain — for display. */
  frequency(ui: number): number {
    const o = this.off[ui];
    const n = this.n[ui];
    if (this.irregular[ui]) {
      // Lower of the two directions' chain frequencies with the degraded stiffness.
      const m: number[] = [], kx: number[] = [], kz: number[] = [];
      for (let j = 1; j <= n; j++) {
        const d = o + j;
        const D = Math.min(1, this.storyD[d]);
        m.push(this.m[d]);
        kx.push(this.k[2 * d] * (1 - 0.4 * D));
        kz.push(this.k[2 * d + 1] * (1 - 0.4 * D));
      }
      return Math.min(chainOmega(m, kx), chainOmega(m, kz)) / (2 * Math.PI);
    }
    const d = o + 1;
    const D = Math.min(1, this.storyD[d]);
    const ke = this.k[2 * d] * (1 - 0.4 * D);
    return (2 * Math.sqrt(ke / this.m[d]) * Math.sin(Math.PI / (2 * (2 * n + 1)))) / (2 * Math.PI);
  }

  /** Substeps of a unit for a step of dt (depends only on its properties → deterministic). */
  substeps(ui: number, dt: number): number {
    const s = Math.ceil((this.wMax[ui] * dt) / STABILITY);
    return s < 1 ? 1 : s > MAX_SUBSTEPS ? MAX_SUBSTEPS : s;
  }

  /** Total substeps per step (profiling). */
  totalSubsteps(dt: number): number {
    let s = 0;
    for (let i = 0; i < this.units; i++) s += this.substeps(i, dt);
    return s;
  }
}

/** Fundamental circular frequency (rad/s) of a fixed-base shear chain (inverse iteration). */
export function chainOmega(m: readonly number[], k: readonly number[]): number {
  const n = m.length;
  let x = new Float64Array(n).fill(1);
  let lambda = 0;
  const cp = new Float64Array(n), dp = new Float64Array(n), y = new Float64Array(n);
  for (let it = 0; it < 100; it++) {
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? -k[i] : 0;
      const b = k[i] + (i + 1 < n ? k[i + 1] : 0);
      const c = i + 1 < n ? -k[i + 1] : 0;
      const den = b - (i > 0 ? a * cp[i - 1] : 0);
      cp[i] = c / den;
      dp[i] = (m[i] * x[i] - (i > 0 ? a * dp[i - 1] : 0)) / den;
    }
    for (let i = n - 1; i >= 0; i--) y[i] = dp[i] - (i + 1 < n ? cp[i] * y[i + 1] : 0);
    let num = 0, den = 0, norm = 0;
    for (let i = 0; i < n; i++) {
      num += y[i] * m[i] * x[i];
      den += y[i] * m[i] * y[i];
      norm = Math.max(norm, Math.abs(y[i]));
    }
    const next = num / den;
    x = Float64Array.from(y, (v) => v / norm);
    if (Math.abs(next - lambda) < 1e-12 * next) return Math.sqrt(next);
    lambda = next;
  }
  return Math.sqrt(Math.max(1e-9, lambda));
}
