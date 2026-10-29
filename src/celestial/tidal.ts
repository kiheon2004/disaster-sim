/**
 * Tidal mechanics on finite bodies (Phase 32) from the gravity gradient tensor T = ∂g/∂x (symmetric for a
 * conservative field):
 *
 *  - tidal acceleration of a point at offset d from the centre of mass: Δg ≈ T·d (exact difference g(x + d) − g(x)
 *    is available from the field; this linear form is valid for |d| ≪ the distance to the source);
 *  - principal stretch λ₁ ≥ λ₂ ≥ λ₃ (eigenvalues of T): along a point mass's radius λ₁ = 2μ/r³, across it −μ/r³ —
 *    a uniform field has T = 0 and no tide, however strong it is;
 *  - internal tension of a uniform bar of mass m and length L aligned with a stretching axis λ > 0: the mid-section
 *    carries N = ∫₀^{L/2} (m/L)·λ·s ds = m·λ·L/8 (the two halves pulled apart);
 *  - gravity-gradient torque on a rigid body with second-moment tensor S = Σ m·r·rᵀ (about its centre of mass):
 *    τ_i = ε_ijk·S_jl·T_kl — zero when S and T share axes (a body aligned with the radius sits in equilibrium).
 */
import type { Vec3 } from '@/core/types';

/** Eigenvalues of a symmetric 3×3 matrix (row-major), descending (closed-form trigonometric solution). */
export function symEigenvalues(m: ArrayLike<number>): [number, number, number] {
  const a = m[0], b = 0.5 * (m[1] + m[3]), c = 0.5 * (m[2] + m[6]);
  const d = m[4], e = 0.5 * (m[5] + m[7]), f = m[8];
  const p1 = b * b + c * c + e * e;
  if (p1 <= 1e-30 * (a * a + d * d + f * f + 1e-300)) {
    const v = [a, d, f].sort((x, y) => y - x);
    return [v[0], v[1], v[2]];
  }
  const q = (a + d + f) / 3;
  const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  // B = (A − qI)/p, r = det(B)/2.
  const ba = (a - q) / p, bd = (d - q) / p, bf = (f - q) / p, bb = b / p, bc = c / p, be = e / p;
  const det = ba * (bd * bf - be * be) - bb * (bb * bf - be * bc) + bc * (bb * be - bd * bc);
  const r = Math.max(-1, Math.min(1, det / 2));
  const phi = Math.acos(r) / 3;
  const l1 = q + 2 * p * Math.cos(phi);
  const l3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [l1, 3 * q - l1 - l3, l3];
}

/** Unit eigenvector of a symmetric matrix for eigenvalue λ (largest cross product of the rows of A − λI). */
export function symEigenvector(m: ArrayLike<number>, lambda: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const r0: Vec3 = [m[0] - lambda, 0.5 * (m[1] + m[3]), 0.5 * (m[2] + m[6])];
  const r1: Vec3 = [r0[1], m[4] - lambda, 0.5 * (m[5] + m[7])];
  const r2: Vec3 = [r0[2], r1[2], m[8] - lambda];
  const cr = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let best: Vec3 = [1, 0, 0], bn = 0;
  for (const c of [cr(r0, r1), cr(r0, r2), cr(r1, r2)]) {
    const n = Math.hypot(c[0], c[1], c[2]);
    if (n > bn) { bn = n; best = c; }
  }
  if (bn < 1e-300) { out[0] = 1; out[1] = 0; out[2] = 0; return out; }
  out[0] = best[0] / bn; out[1] = best[1] / bn; out[2] = best[2] / bn;
  return out;
}

/** Tidal acceleration T·d (m/s²). */
export function tidalLinear(T: ArrayLike<number>, d: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = T[0] * d[0] + T[1] * d[1] + T[2] * d[2];
  out[1] = T[3] * d[0] + T[4] * d[1] + T[5] * d[2];
  out[2] = T[6] * d[0] + T[7] * d[1] + T[8] * d[2];
  return out;
}

/** Stretch of T along a unit axis n: nᵀ·T·n (1/s²; > 0 pulls the ends apart). */
export function stretchAlong(T: ArrayLike<number>, n: Readonly<Vec3>): number {
  let s = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += n[i] * T[3 * i + j] * n[j];
  return s;
}

/** Mid-section tension of a uniform bar (N): m·λ·L/8 for a stretch λ > 0 along it, 0 under compression. */
export const barTension = (m: number, L: number, lambda: number) => (lambda > 0 ? (m * lambda * L) / 8 : 0);

/** Second-moment tensor S = m/12·R·diag(a², b², c²)·Rᵀ of a uniform box (dims a, b, c along its local axes; R the
 *  rotation as a row-major 3×3 whose columns are the local axes in world). */
export function boxSecondMoment(m: number, dims: Readonly<Vec3>, R: ArrayLike<number>, out: Float64Array | number[] = new Float64Array(9)) {
  const d = [dims[0] * dims[0], dims[1] * dims[1], dims[2] * dims[2]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += R[3 * i + k] * d[k] * R[3 * j + k];
      out[3 * i + j] = (m / 12) * s;
    }
  }
  return out;
}

/** Gravity-gradient torque τ_i = ε_ijk·Σ_l S_jl·T_kl (N·m). */
export function gradientTorque(S: ArrayLike<number>, T: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  // M = S·Tᵀ (M_jk = Σ_l S_jl T_kl); τ = (M_yz − M_zy, M_zx − M_xz, M_xy − M_yx).
  const M = (j: number, k: number) => S[3 * j] * T[3 * k] + S[3 * j + 1] * T[3 * k + 1] + S[3 * j + 2] * T[3 * k + 2];
  out[0] = M(1, 2) - M(2, 1);
  out[1] = M(2, 0) - M(0, 2);
  out[2] = M(0, 1) - M(1, 0);
  return out;
}
