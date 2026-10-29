/**
 * Stability models of Phase 22 (pure functions, SI: kPa, kN/m³, m, rad, m/s²).
 *
 * 1. Infinite-slope factor of safety (translational shallow slide parallel to the surface;
 *    Skempton & DeLory 1957; e.g. Duncan, Wright & Brandon, Soil Strength and Slope Stability,
 *    2nd ed., ch. 6):
 *        FS = [c + (γ − m·γw)·z·cos²β·tanφ] / [γ·z·sinβ·cosβ]
 *    z = depth of the slip surface (soil thickness), m = height of a slope-parallel water table
 *    above it / z (0 dry … 1 saturated to the surface), c = c' + apparent cohesion (unsaturated).
 *    Valid for slides long compared with their depth (L/z ≳ 10–20) — not for rotational,
 *    deep-seated, rock or 3-D failures.
 *
 * 2. Newmark (1965) rigid sliding block for earthquake triggering; critical (yield) acceleration
 *    of an infinite slope a_c = (FS − 1)·g·sinβ (Newmark 1965; Jibson 1993/2011). The block slides
 *    while the downslope ground acceleration exceeds a_c; the permanent displacement D is the
 *    double integral of the excess. Failure is declared when D exceeds a threshold (Jibson &
 *    Keefer 1993 / Wieczorek et al. 1985 used 5–10 cm as a failure indicator) — an empirical
 *    criterion, labelled as such.
 *
 * 3. Plug failure of a cavity roof (vertical shear along the cylinder above a cavity of radius a
 *    under a cover of thickness H; e.g. CIRIA C574 / mining-subsidence "plug" check, Waltham et
 *    al., Sinkholes and Subsidence, 2005, ch. 8):
 *        FS = 2πaH·(c + K₀·σ'ᵥ,mean·tanφ) / [πa²·(γH + q)],  σ'ᵥ,mean = (γ − m·γw)·H/2,
 *        K₀ = 1 − sinφ (Jáky)
 *    q = surcharge (structures) on the plug. Critical radius (FS = 1):
 *        a_c = 2H·(c + K₀·σ'ᵥ,mean·tanφ) / (γH + q)
 *    It ignores arching beyond the plug and roof bending — an upper-bound-style simple check.
 *
 * 4. Culmann (1866) planar failure of a cut of height Hw and inclination β (c–φ soil):
 *        H_c = (4c/γ)·sinβ·cosφ / (1 − cos(β − φ));  β ≤ φ → stable at any height
 *    For β = 90° it reduces to the Rankine critical height (4c/γ)·tan(45° + φ/2). Used for the
 *    walls of collapse pits.
 */
import { GAMMA_W, G } from './materials';

export interface SlopeInput {
  /** Slope angle (rad). */
  beta: number;
  /** Slip-surface depth / soil thickness (m). */
  z: number;
  /** Total cohesion c' + apparent cohesion (kPa). */
  c: number;
  /** Friction angle (rad). */
  phi: number;
  /** Unit weight (kN/m³). */
  gamma: number;
  /** Water-table ratio 0–1. */
  m: number;
}

/** Infinite-slope FS (∞ on flat ground or with no soil). */
export function infiniteSlopeFS(s: SlopeInput): number {
  if (s.z <= 0 || s.beta <= 1e-6) return Infinity;
  const cb = Math.cos(s.beta), sb = Math.sin(s.beta);
  const resist = s.c + Math.max(0, s.gamma - s.m * GAMMA_W) * s.z * cb * cb * Math.tan(s.phi);
  const drive = s.gamma * s.z * sb * cb;
  return resist / drive;
}

/** Newmark critical acceleration of an infinite slope (m/s²; ≤ 0 = already failing statically). */
export function criticalAcceleration(fs: number, beta: number): number {
  return (fs - 1) * G * Math.sin(beta);
}

/**
 * One step of the Newmark rigid-block integration (one-directional, downslope only). `a` =
 * downslope component of the ground acceleration (m/s²), `ac` = critical acceleration.
 * Returns the new relative velocity; the caller adds v·dt to the displacement.
 */
export function newmarkStep(v: number, a: number, ac: number, dt: number): number {
  const nv = v + (a - ac) * dt;
  // The block only slides downslope; it stops when the relative velocity returns to zero.
  return nv > 0 ? nv : 0;
}

export interface PlugInput {
  /** Cavity radius (m) and cover thickness above the cavity roof (m). */
  a: number;
  H: number;
  c: number;
  phi: number;
  gamma: number;
  m: number;
  /** Surcharge on the plug (kPa). */
  q: number;
}

/** Shear resistance per unit plug-wall area (kPa). */
function plugShear(p: PlugInput): number {
  const k0 = 1 - Math.sin(p.phi);
  const sv = Math.max(0, p.gamma - p.m * GAMMA_W) * p.H / 2;
  return p.c + k0 * sv * Math.tan(p.phi);
}

/** Plug factor of safety of the cavity roof. */
export function plugFS(p: PlugInput): number {
  if (p.a <= 0) return Infinity;
  const resist = 2 * Math.PI * p.a * p.H * plugShear(p);
  const load = Math.PI * p.a * p.a * (p.gamma * p.H + p.q);
  return load > 0 ? resist / load : Infinity;
}

/** Cavity radius at which the roof plug fails (FS = 1). */
export function criticalCavityRadius(p: Omit<PlugInput, 'a'>): number {
  return (2 * p.H * plugShear({ ...p, a: 1 })) / (p.gamma * p.H + p.q);
}

/** Culmann critical height of a planar cut (m; ∞ when β ≤ φ or cohesionless & β ≤ φ). */
export function culmannCriticalHeight(c: number, gamma: number, beta: number, phi: number): number {
  if (beta <= phi + 1e-9) return Infinity;
  if (c <= 0) return 0;
  return ((4 * c) / gamma) * (Math.sin(beta) * Math.cos(phi)) / (1 - Math.cos(beta - phi));
}

/**
 * The steepest stable inclination of a cut of height Hw (rad): β with H_c(β) = Hw (bisection;
 * H_c decreases monotonically with β above φ). Cohesionless: φ.
 */
export function stableCutAngle(c: number, gamma: number, phi: number, Hw: number): number {
  if (c <= 0 || Hw <= 0) return c <= 0 ? phi : Math.PI / 2;
  if (culmannCriticalHeight(c, gamma, Math.PI / 2, phi) >= Hw) return Math.PI / 2;
  let lo = phi, hi = Math.PI / 2;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (culmannCriticalHeight(c, gamma, mid, phi) >= Hw) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Free-fall time (s) of a column dropping a height d. */
export const fallTime = (d: number) => Math.sqrt((2 * Math.max(0, d)) / G);
