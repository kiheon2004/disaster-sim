/**
 * Pressure wave of a point release of energy E into still air (Phase 24) — a physics-based,
 * deliberately GENERIC model: nothing in it is fitted to any explosive (no blast curves of high
 * explosives are used), so it describes "a release of E joules into the air", not a device.
 *
 * Sachs scaling (Sachs 1944): every result depends on E only through R₀ = (E/p₀)^(1/3) and t₀ = R₀/c₀,
 * so ambient pressure and density (altitude, weather) enter consistently.
 *
 * 1. Near field — strong point blast (Taylor 1950, Sedov 1959): the shock radius grows as
 *    R = ξ₀·(E·t²/ρ₀)^(1/5), ξ₀ = 1.033 for γ = 1.4, and the strong-shock jump gives the overpressure
 *        Δp = 2ρ₀U²/(γ+1) = K·E / r³,   K = 8ξ₀⁵ / (25(γ+1)) ≈ 0.157.
 *    It is the exact similarity solution while Δp ≫ p₀ (it neglects the ambient pressure).
 * 2. Transition radius r_t where that overpressure equals p₀: r_t = K^(1/3)·R₀ ≈ 0.54·R₀. From there
 *    the wave is treated as a weak shock (Δp ≤ p₀). Its positive duration at r_t is taken as the local
 *    self-similar time scale — the arrival time there (an order-one closure, labelled). The energy the
 *    pulse carries then FOLLOWS (it is not chosen): E_p = (8π/3)·r_t²·Δp_t²·T_t/(ρ₀c₀) ≈ 0.3–0.4·E;
 *    the rest stays near the source as heat left behind by the strong shock (ledger: "near-source
 *    dissipation", not modelled further).
 * 3. Far field — weak-shock theory of a spherical N-wave (Whitham 1974 §9.5; Landau & Lifshitz §102):
 *    with the linear amplitude P(r) = Δp_t·(r_t/r)·√(ρ(r)/ρ_s) (energy flux p²/(ρc) per ray tube is
 *    conserved — √ρ is the impedance correction for a source at altitude) and the "age"
 *        σ(r) = (1/T_t)·∫ β·P(r')/(ρ(r')·c³) dr',   β = (γ+1)/2,
 *    the equal-area shock fit of the triangular phase gives
 *        Δp(r) = P(r)/√(1+σ),   T₊(r) = T_t·√(1+σ),   I₊ = ½Δp·T₊ ∝ 1/r exactly,
 *    and the energy left in the pulse E_p/√(1+σ) (the rest is dissipated at the shocks).
 *    'acoustic' sets σ = 0 (no steepening, no loss).
 * 4. Arrival: t_a(r) = ∫ dr / U(Δp(r)) with the exact Rankine–Hugoniot shock speed
 *        U = c·√(1 + (γ+1)/(2γ)·Δp/p)
 *    in every zone (so near and far field join without a jump; to first order U = c(1 + (γ+1)Δp/(4γp)),
 *    the weak-shock speed). 'acoustic': U = c beyond r_t.
 *
 * Validity (by the local Δp/p): weak shock Δp/p ≤ 0.3 (first-order theory; shock Mach ≤ 1.12) —
 * VALID; 0.3–3 — transition, neither asymptote is accurate (approximate, warned); ≥ 3 strong-shock
 * similarity (approximate: counter-pressure neglected). Below r = 0.02·r_t ("core") values are held.
 * Not modelled: atmospheric absorption, wind / temperature gradients (refraction), turbulence,
 * real-gas and radiation effects of very energetic sources.
 */
import type { Vec3 } from '@/core/types';
import type { BlastModel } from './types';

export const GAMMA = 1.4;
export const BETA = (GAMMA + 1) / 2;
/** Sedov–Taylor constant ξ₀ of a spherical blast in a γ = 1.4 gas. */
export const SEDOV_XI = 1.033;
/** Strong-shock overpressure Δp = K·E/r³. */
export const K_SEDOV = (8 * SEDOV_XI ** 5) / (25 * (GAMMA + 1));
/** Isothermal scale height of the atmosphere (m) — as the Phase 23 entry model. */
export const SCALE_HEIGHT = 8000;
/** Δp/p limits of the zones. */
export const WEAK_LIMIT = 0.3;
export const STRONG_LIMIT = 3;
const NODES = 480;
const CORE = 0.02;

export interface Ambient {
  /** Pressure (Pa), density (kg/m³), sound speed (m/s). */
  p: number;
  rho: number;
  c: number;
}

export function makeAmbient(p: number, rho: number): Ambient {
  return { p, rho, c: Math.sqrt((GAMMA * p) / rho) };
}

/** Isothermal exponential atmosphere: ambient at height z (m) above the reference level of `a`. */
export function ambientAt(a: Ambient, z: number): Ambient {
  const k = Math.exp(-z / SCALE_HEIGHT);
  return { p: a.p * k, rho: a.rho * k, c: a.c };
}

export type Zone = 'core' | 'strong' | 'transition' | 'weak';

export function zoneOf(dpOverP: number): Exclude<Zone, 'core'> {
  return dpOverP <= WEAK_LIMIT ? 'weak' : dpOverP < STRONG_LIMIT ? 'transition' : 'strong';
}

/** Rankine–Hugoniot speed of a shock of overpressure dp into air at pressure p, sound speed c. */
export function shockSpeed(dp: number, p: number, c: number): number {
  return c * Math.sqrt(1 + ((GAMMA + 1) / (2 * GAMMA)) * (dp / p));
}

/** Normal reflection factor p_r/Δp of a plane shock on a rigid wall (exact for an ideal gas, γ = 1.4): 2 (weak) … 8 (strong). */
export function reflectionFactor(dp: number, p: number): number {
  return 2 + ((GAMMA + 1) * dp) / ((GAMMA - 1) * dp + 2 * GAMMA * p);
}

/** Particle velocity behind a shock (Rankine–Hugoniot), m/s; → Δp/(ρc) for weak shocks. */
export function particleVelocity(dp: number, p: number, rho: number): number {
  const c = Math.sqrt((GAMMA * p) / rho);
  return (c * (dp / (GAMMA * p))) / Math.sqrt(1 + ((GAMMA + 1) / (2 * GAMMA)) * (dp / p));
}

export interface TableInput {
  /** Energy of the wave this table describes (J; 2E for a hemispherical surface release). */
  energy: number;
  /** Ambient at the source height. */
  source: Ambient;
  /** Ambient on the ground reference level (z = 0 of `height`). */
  ground: Ambient;
  /** Source height above the ground reference (m) and the height of the target the ray points to. */
  height: number;
  targetHeight: number;
  /** Length of the ray to the target (m). */
  targetDistance: number;
  model: BlastModel;
  /** Largest distance that will be queried (m). */
  reach: number;
}

export interface RadialSample {
  dp: number;
  /** Positive-phase duration (s). */
  T: number;
  /** Arrival time after the release (s). */
  t: number;
  /** Ambient pressure at that point along the ray (Pa). */
  p: number;
  zone: Zone;
  /** Share of the pulse energy still in the wave (1/√(1+σ)). */
  energyLeft: number;
}

/**
 * The propagation of one spherical wave along a radial ray, tabulated once (log-spaced nodes,
 * log–log interpolation) — every query (objects, parts, preview grid, renderer) reads this table.
 */
export class RadialTable {
  readonly R0: number;
  readonly rt: number;
  readonly dpT: number;
  readonly Tt: number;
  readonly tt: number;
  /** Pulse energy (J) of the full-sphere N-wave at r_t and its share of the wave energy. */
  readonly pulseEnergy: number;
  readonly efficiency: number;
  private readonly lr: Float64Array;
  private readonly ldp: Float64Array;
  private readonly lT: Float64Array;
  private readonly ta: Float64Array;
  private readonly pz: Float64Array;
  private readonly eLeft: Float64Array;
  private readonly r0: number;
  private readonly rMax: number;
  readonly input: TableInput;

  constructor(i: TableInput) {
    this.input = i;
    const { energy: E, source: s } = i;
    const c = s.c;
    this.R0 = Math.cbrt(E / s.p);
    this.rt = Math.cbrt(K_SEDOV) * this.R0;
    this.dpT = s.p;
    this.r0 = CORE * this.rt;
    this.rMax = Math.max(i.reach, 2 * this.rt) * 1.05;
    const n = NODES;
    this.lr = new Float64Array(n);
    this.ldp = new Float64Array(n);
    this.lT = new Float64Array(n);
    this.ta = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.eLeft = new Float64Array(n);
    const l0 = Math.log(this.r0), l1 = Math.log(this.rMax);
    // r_t is a node exactly, so both zones are tabulated up to their common point.
    const nNear = Math.max(8, Math.min(n - 8, Math.round(((Math.log(this.rt) - l0) / (l1 - l0)) * (n - 1))));
    const r = new Float64Array(n);
    for (let k = 0; k <= nNear; k++) r[k] = Math.exp(l0 + ((Math.log(this.rt) - l0) * k) / nNear);
    for (let k = nNear + 1; k < n; k++) r[k] = Math.exp(Math.log(this.rt) + ((l1 - Math.log(this.rt)) * (k - nNear)) / (n - 1 - nNear));
    const zAt = (rr: number) => i.height + (i.targetHeight - i.height) * Math.min(1, rr / Math.max(1e-6, i.targetDistance));
    const amb = (rr: number) => ambientAt(i.ground, zAt(rr));
    const dp = new Float64Array(n);
    // Near field: Sedov overpressure, arrival with the Rankine–Hugoniot speed (from r = 0:
    // U ≈ A·r^(-3/2) for r → 0, so t(r₀) = r₀^(5/2) / (2.5·A)).
    for (let k = 0; k <= nNear; k++) dp[k] = (K_SEDOV * E) / (r[k] * r[k] * r[k]);
    const A = Math.sqrt(((GAMMA + 1) * K_SEDOV * E) / (2 * s.rho));
    const ta = this.ta;
    ta[0] = r[0] ** 2.5 / (2.5 * A);
    for (let k = 1; k <= nNear; k++) {
      const pa = amb(r[k - 1]).p, pb = amb(r[k]).p;
      ta[k] = ta[k - 1] + 0.5 * (r[k] - r[k - 1]) * (1 / shockSpeed(dp[k - 1], pa, c) + 1 / shockSpeed(dp[k], pb, c));
    }
    this.tt = ta[nNear];
    this.Tt = this.tt;
    const T = new Float64Array(n);
    for (let k = 0; k <= nNear; k++) {
      T[k] = this.Tt * (ta[k] / this.tt);
      this.eLeft[k] = 1;
    }
    // Far field: weak-shock N-wave (or linear acoustics).
    let S = 0;
    const nl = i.model === 'weakShock';
    let prevP = this.dpT, prevRho = s.rho;
    for (let k = nNear + 1; k < n; k++) {
      const a = amb(r[k]);
      const P = this.dpT * (this.rt / r[k]) * Math.sqrt(a.rho / s.rho);
      if (nl) S += 0.5 * (r[k] - r[k - 1]) * BETA * (prevP / (prevRho * c ** 3) + P / (a.rho * c ** 3));
      prevP = P; prevRho = a.rho;
      const sig = S / this.Tt;
      const g = Math.sqrt(1 + sig);
      dp[k] = P / g;
      T[k] = this.Tt * g;
      this.eLeft[k] = 1 / g;
      const pa = amb(r[k - 1]).p;
      ta[k] = ta[k - 1] + (nl ? 0.5 * (r[k] - r[k - 1]) * (1 / shockSpeed(dp[k - 1], pa, c) + 1 / shockSpeed(dp[k], a.p, c)) : (r[k] - r[k - 1]) / c);
    }
    for (let k = 0; k < n; k++) {
      this.lr[k] = Math.log(r[k]);
      this.ldp[k] = Math.log(dp[k]);
      this.lT[k] = Math.log(T[k]);
      this.pz[k] = amb(r[k]).p;
    }
    this.pulseEnergy = ((8 * Math.PI) / 3) * this.rt * this.rt * this.dpT * this.dpT * this.Tt / (s.rho * c);
    this.efficiency = this.pulseEnergy / E;
  }

  /** Values at distance r (m) from the source, written into `out`. */
  at(r: number, out: RadialSample): RadialSample {
    const lr = this.lr, n = lr.length;
    const core = r < this.r0;
    const x = Math.log(Math.min(this.rMax, Math.max(this.r0, r)));
    // Binary search on the log grid.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (lr[m] <= x) lo = m;
      else hi = m;
    }
    const f = (x - lr[lo]) / (lr[hi] - lr[lo]);
    out.dp = Math.exp(this.ldp[lo] + (this.ldp[hi] - this.ldp[lo]) * f);
    out.T = Math.exp(this.lT[lo] + (this.lT[hi] - this.lT[lo]) * f);
    // Arrival is nearly linear in r: interpolate it in r (not log r).
    const ra = Math.exp(lr[lo]), rb = Math.exp(lr[hi]);
    const fr = (Math.exp(x) - ra) / (rb - ra);
    out.t = this.ta[lo] + (this.ta[hi] - this.ta[lo]) * fr;
    out.p = this.pz[lo] + (this.pz[hi] - this.pz[lo]) * f;
    out.energyLeft = this.eLeft[lo] + (this.eLeft[hi] - this.eLeft[lo]) * f;
    if (r > this.rMax) {
      // Beyond the table (never queried by the simulation): continue with 1/r and the last speed.
      const k = this.rMax / r;
      out.t += (r - this.rMax) / this.input.source.c;
      out.dp *= k;
    } else if (r < this.r0) {
      out.t *= (Math.max(r, 0) / this.r0) ** 2.5;
    }
    out.zone = core ? 'core' : zoneOf(out.dp / out.p);
    return out;
  }

  /** Radius of the shock front at time t after the release (m); 0 before it. */
  radiusAt(t: number): number {
    const ta = this.ta, n = ta.length;
    if (t <= 0) return 0;
    if (t >= ta[n - 1]) return Math.exp(this.lr[n - 1]) + (t - ta[n - 1]) * this.input.source.c;
    if (t <= ta[0]) return this.r0 * (t / ta[0]) ** 0.4;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ta[m] <= t) lo = m;
      else hi = m;
    }
    const f = (t - ta[lo]) / (ta[hi] - ta[lo]);
    const ra = Math.exp(this.lr[lo]), rb = Math.exp(this.lr[hi]);
    return ra + (rb - ra) * f;
  }

  /** Distance (m) at which the overpressure falls to `dp` (Pa); 0 if never reached beyond the core. */
  radiusOfPressure(dp: number): number {
    const n = this.ldp.length, ld = Math.log(dp);
    if (this.ldp[0] < ld) return 0;
    if (this.ldp[n - 1] >= ld) return Math.exp(this.lr[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.ldp[m] >= ld) lo = m;
      else hi = m;
    }
    const f = (ld - this.ldp[lo]) / (this.ldp[hi] - this.ldp[lo]);
    return Math.exp(this.lr[lo] + (this.lr[hi] - this.lr[lo]) * f);
  }

  /** Distance where the weak-shock theory becomes valid (Δp/p = 0.3). */
  validRadius(): number {
    return this.radiusOfPressure(WEAK_LIMIT * this.input.ground.p);
  }

  get coreRadius() {
    return this.r0;
  }

  get maxRadius() {
    return this.rMax;
  }
}

export const newSample = (): RadialSample => ({ dp: 0, T: 0, t: 0, p: 0, zone: 'weak', energyLeft: 1 });

export const dist3 = (a: Readonly<Vec3>, b: Readonly<Vec3>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
