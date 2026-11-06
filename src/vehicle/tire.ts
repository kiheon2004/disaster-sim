/**
 * Phase 35: tyre contact force (level B: textbook reduced tyre models; coefficients level B/C, see params.ts).
 *
 * Wheel frame at the contact: x along the wheel heading projected on the ground plane, y = n × x (to the wheel's left), n the
 * ground normal. Contact-point velocity (v_x, v_y); slip velocity of the tread v_sx = R ω − v_x.
 *
 * Slips (steady state):   κ = (R ω − v_x) / max(|v_x|, |R ω|, v_ε),   α = atan2(v_y, |v_x| + v_ε)
 * Transient (relaxation lengths σ, Pacejka 2012 ch. 7) — the slips used by the force lag the steady values and stay defined
 * at standstill, where they become tread deflections (static friction holds a car on a slope):
 *   σ_x dκ'/dt + |v_x| κ' = v_sx,      σ_y dα'/dt + |v_x| α' = v_y            (α' ≈ tan α for small angles)
 * lateral: exact over a sub-step for the frozen speeds (exponential, linear growth at v_x = 0); longitudinal: implicitSpin.
 *
 * Force from the slips:
 *   model 'linear' (A):      F_x = C_κ κ',  F_y = −C_α α'                     (no friction limit — small-slip reference only)
 *   model 'saturating' (B):  combined slip vector s = (C_κ κ', −C_α α'), φ = |s| / (3 μ F_z):
 *                            |F| = μ F_z (3φ − 3φ² + φ³) for φ < 1 (brush / Fiala shape), μ_slide F_z beyond, along s
 *                            → |F| ≤ μ F_z: the friction circle shared by driving / braking and cornering.
 *   The peak μ falls to the sliding μ (slideShare × μ) as the patch slides (φ from 1 to 2): static vs kinetic friction.
 * Low speed (|v_x| < v_low): viscous tread damping (treadDamping) on the slip velocities, blended out at v_low. The wheel spin and the
 * longitudinal slip are integrated implicitly together (implicitSpin) — at standstill they form a stiff oscillator.
 */
import { TIRE } from './params';

export type TireModel = 'linear' | 'saturating';

export interface TireState {
  /** Transient longitudinal slip κ' and lateral slip α' (1). */
  k: number;
  a: number;
}

export const V_EPS = 0.1;

/** Steady-state slips of a contact (for display / tests). */
export function steadySlip(vx: number, vy: number, Rw: number): { kappa: number; alpha: number } {
  return { kappa: (Rw - vx) / Math.max(Math.abs(vx), Math.abs(Rw), V_EPS), alpha: Math.atan2(vy, Math.abs(vx) + V_EPS) };
}

/** Lateral transient slip over dt with frozen speeds (exact for the linear first-order equation). */
export function relaxLateral(st: TireState, vx: number, vy: number, dt: number) {
  const ax = Math.abs(vx);
  if (ax > 1e-9) {
    const ky = vy / ax;
    st.a = ky + (st.a - ky) * Math.exp((-ax * dt) / TIRE.sigmaY);
  } else st.a += (vy * dt) / TIRE.sigmaY;
}

/** Longitudinal transient slip over dt for a frozen tread speed R ω (exact, as relaxLateral). */
export function relaxLongitudinal(st: TireState, vx: number, Rw: number, dt: number) {
  const ax = Math.abs(vx), vs = Rw - vx;
  if (ax > 1e-9) {
    const kx = vs / ax;
    st.k = kx + (st.k - kx) * Math.exp((-ax * dt) / TIRE.sigmaX);
  } else st.k += (vs * dt) / TIRE.sigmaX;
}

/**
 * Low-speed tread damping (N·s/m) of one direction: the transient tyre at standstill is a tread spring of stiffness C / σ on the
 * corner mass m_c = F_z / g; its viscous damping 2 ζ √(k m_c) with ζ = 0.5 (assumption, the order Pacejka 2012 §7.2 uses for the
 * low-speed extension) acts below v_low with weight w = 1 − |v_x| / v_low.
 */
export function treadDamping(C: number, sigma: number, Fz: number, g: number): number {
  return Math.sqrt((C / sigma) * (Fz / g));
}
export const lowSpeedWeight = (vx: number) => Math.max(0, 1 - Math.abs(vx) / TIRE.vLow);

/**
 * Wheel spin and longitudinal transient slip over one sub-step, solved implicitly together (the pair is a stiff tread-spring /
 * wheel-inertia oscillator at low speed):
 *   κ₁ (1 + h|v_x|/σ) − (hR/σ) ω₁ = κ₀ − h v_x / σ
 *   ω₁ (1 + h R² c_w / I) + (h R K / I) κ₁ = ω₀ + h (T + R c_w v_x) / I
 * K = secant stiffness of the force curve at the previous slip (C_κ in the linear range, smaller when saturated), c_w = the
 * low-speed damping × weight. Returns ω₁; writes κ₁.
 */
export function implicitSpin(st: TireState, omega: number, vx: number, R: number, I: number, T: number, K: number, cw: number, h: number): number {
  const sx = TIRE.sigmaX;
  const a11 = 1 + (h * Math.abs(vx)) / sx, a12 = -(h * R) / sx, b1 = st.k - (h * vx) / sx;
  const a21 = (h * R * K) / I, a22 = 1 + (h * R * R * cw) / I, b2 = omega + (h * (T + R * cw * vx)) / I;
  const det = a11 * a22 - a12 * a21;
  st.k = (b1 * a22 - a12 * b2) / det;
  return (a11 * b2 - a21 * b1) / det;
}

export interface TireForce { fx: number; fy: number; sliding: boolean; phi: number }

/**
 * Tyre force from the linear demands (sx, sy) = (C_κ κ' + damping, −C_α α' − damping) (N), normal load Fz (N), peak friction mu.
 * 'linear' returns them unchanged; 'saturating' applies the brush (Fiala) curve on the combined demand — the friction circle.
 */
export function tireForce(model: TireModel, sx: number, sy: number, Fz: number, mu: number, out: TireForce): TireForce {
  if (!(Fz > 0)) {
    out.fx = out.fy = 0; out.sliding = false; out.phi = 0;
    return out;
  }
  if (model === 'linear') {
    out.fx = sx; out.fy = sy; out.sliding = false; out.phi = 0;
    return out;
  }
  const s = Math.hypot(sx, sy);
  if (s === 0) {
    out.fx = out.fy = 0; out.sliding = false; out.phi = 0;
    return out;
  }
  const phi = s / (3 * mu * Fz);
  let F: number;
  if (phi < 1) F = mu * Fz * (3 * phi - 3 * phi * phi + phi * phi * phi);
  else {
    // Sliding: from the peak to the kinetic friction as the slip grows (φ 1 → 2).
    const b = Math.min(1, phi - 1);
    F = mu * Fz * (1 - (1 - TIRE.slideShare) * b);
  }
  out.fx = (sx / s) * F;
  out.fy = (sy / s) * F;
  out.sliding = phi >= 1;
  out.phi = phi;
  return out;
}

/**
 * Contact force with the low-speed static limit: at rest (weight lw = 1) the tread is a spring whose force is the linear demand
 * capped at the static friction μ F_z (Coulomb); above v_low (lw = 0) the brush curve. Blended linearly between.
 */
export function contactForce(model: TireModel, sx: number, sy: number, Fz: number, mu: number, lw: number, out: TireForce): TireForce {
  tireForce(model, sx, sy, Fz, mu, out);
  if (lw <= 0 || model === 'linear' || !(Fz > 0)) return out;
  const s = Math.hypot(sx, sy), lim = mu * Fz;
  const k = s > lim ? lim / s : 1;
  out.fx = (1 - lw) * out.fx + lw * sx * k;
  out.fy = (1 - lw) * out.fy + lw * sy * k;
  if (lw > 0.5) out.sliding = s > lim;
  return out;
}

/** Cap the transient slips at low speed so the elastic demand stays within the static limit (μ F_z at rest, 3 μ F_z at v_low). */
export function capDeflection(st: TireState, Ck: number, Ca: number, muFz: number, lw: number) {
  if (lw <= 0 || !(muFz > 0)) return;
  const lim = muFz * (1 + 2 * (1 - lw));
  const s = Math.hypot(Ck * st.k, Ca * st.a);
  if (s > lim) {
    const f = lim / s;
    st.k *= f;
    st.a *= f;
  }
}
