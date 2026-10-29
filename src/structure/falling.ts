/**
 * A falling block striking the structure below (Phase 25) — reduced-order crush-down mechanics in
 * the spirit of Bažant & Verdure (2007) and the energy-balance framework of Izzuddin et al. (2008):
 *
 *  1. free fall of the block (mass M) over the gap h: v = √(v₀² + 2·g·h) (exact, no drag);
 *  2. perfectly inelastic collision with the struck members (mass m_R, at rest): momentum
 *     conserved, v' = M·v / (M + m_R); the kinetic energy lost in the collision,
 *     ΔK = ½·M·v²·m_R / (M + m_R), is dissipated (crushing, fracture, heat);
 *  3. the struck floor system resists with its RESERVE static capacity P (the additional load at
 *     which the first member / connection on its load path reaches its limit — solver.reserve),
 *     rigid-plastically, over its deformation capacity δ_u. With M' = M + m_R:
 *       P ≤ M'·g  → cannot even hold the static weight: it fails;
 *       otherwise the arrest distance is δ = ½·M'·v'² / (P − M'·g):
 *         δ ≤ δ_u → ARRESTED (the floor holds, damage = δ / δ_u), the block rests on it;
 *         δ > δ_u → the floor FAILS after absorbing W = P·δ_u; the block continues with
 *                   ½·M'·v_r² = ½·M'·v'² + M'·g·δ_u − P·δ_u.
 *
 * Energy balance (closes exactly, tested):
 *   ½·M·v² + M'·g·d = ΔK + W + ½·M'·v_r²     (d = δ arrested, δ_u failed; v_r = 0 when arrested)
 *
 * Not modelled: elastic rebound, membrane / catenary action, non-uniform contact, the block's own
 * crushing (crush-up), rotation of the block.
 */
export interface ImpactInput {
  /** Falling mass (kg) and its vertical speed at contact (m/s, ≥ 0). */
  M: number;
  v: number;
  /** Mass of the struck members (kg) — joins the motion. */
  mR: number;
  /** Reserve static capacity of the struck floor system (N; Infinity = rigid). */
  P: number;
  /** Deformation capacity of the governing member (m). */
  deltaU: number;
  g: number;
}

export interface ImpactOutcome {
  /** Speed right after the collision (m/s). */
  vCollision: number;
  /** Kinetic energy before contact, after the collision, dissipated by the collision (J). */
  K0: number;
  K1: number;
  collisionLoss: number;
  arrested: boolean;
  /** Crushing distance (m): δ when arrested, δ_u when the floor failed. */
  distance: number;
  /** Work absorbed by the struck system (J). */
  absorbed: number;
  /** Potential energy released over the crushing distance (J). */
  potential: number;
  /** Speed of the merged block after a failed floor (m/s; 0 when arrested). */
  vResidual: number;
  /** δ / δ_u (≥ 1 = failed). */
  damage: number;
}

export function impactOutcome({ M, v, mR, P, deltaU, g }: ImpactInput): ImpactOutcome {
  const Mt = M + mR;
  const K0 = 0.5 * M * v * v;
  const vc = Mt > 0 ? (M * v) / Mt : 0;
  const K1 = 0.5 * Mt * vc * vc;
  const collisionLoss = K0 - K1;
  const W = Mt * g;
  if (P === Infinity) {
    return { vCollision: vc, K0, K1, collisionLoss, arrested: true, distance: 0, absorbed: K1, potential: 0, vResidual: 0, damage: 0 };
  }
  if (P > W) {
    const d = K1 / (P - W);
    if (d <= deltaU) {
      return { vCollision: vc, K0, K1, collisionLoss, arrested: true, distance: d, absorbed: P * d, potential: W * d, vResidual: 0, damage: deltaU > 0 ? d / deltaU : 1 };
    }
  }
  const d = Math.max(0, deltaU);
  const absorbed = Math.max(0, P) * d;
  const Kr = Math.max(0, K1 + W * d - absorbed);
  return { vCollision: vc, K0, K1, collisionLoss, arrested: false, distance: d, absorbed, potential: W * d, vResidual: Mt > 0 ? Math.sqrt((2 * Kr) / Mt) : 0, damage: Math.max(1, deltaU > 0 ? (K1 / Math.max(1e-9, P - W)) / deltaU : 1) };
}

/**
 * Free fall over a gap: time to fall `h` from speed `v` (m/s down), or Infinity when it does not
 * reach the gap within `dt`. Exact (constant gravity).
 */
export function fallTime(h: number, v: number, g: number): number {
  if (h <= 0) return 0;
  // Phase 31: (almost) no downward gravity — uniform motion (the caller hands blocks to the physics engine below FALL_MIN).
  if (!(g > 1e-9)) return v > 0 ? h / v : Infinity;
  return (-v + Math.sqrt(v * v + 2 * g * h)) / g;
}
