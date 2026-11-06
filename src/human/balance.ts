/**
 * Phase 33: standing balance of the reduced human model — an inverted pendulum on the support (a standard reduced model of
 * standing balance) with a bounded ankle moment.
 *
 * State: the lean θ (2-vector, rad; the horizontal offset of the COM from the stance centre is h_c·θ, measured in the plane
 * normal to the local "up" = −ĝ) and its rate θ̇. Per step:
 *
 *   I_a θ̈ = T + m g_n h_c θ − M_c
 *
 *   T   tipping moment (N·m, pointing where the COM is pushed): external forces about the stance centre (wind, water, ground
 *       motion inertia, blast, sediment, impacts …) + m h_c (g_t − a_b) (tangential gravity, base acceleration — the feet
 *       slipping or being carried);
 *   m g_n h_c θ   the gravity moment of the lean (destabilising);
 *   M_c the corrective ankle / foot moment. Its magnitude is limited by the centre of pressure staying under the feet:
 *       |M_c| ≤ m g_n e(û), e = distance from the stance centre to the support edge along û.
 *
 * The controller wants θ̈ = −k_p (θ − θ*) − k_d θ̇ towards a lean θ* INTO a sustained load (θ* = −T / (m g_n h_c), the COM
 * kept inside the support, at most LEAN_SHARE of the edge) — steady leaning against a load doubles the moment that can be
 * resisted (COM at one foot edge, centre of pressure at the other); a sudden load meets the person unprepared.
 *
 * Fall (loss of balance): the extrapolated centre of mass x = h_c (θ + θ̇ / ω₀), ω₀ = √(g_n / l), l = I_a / (m h_c), leaves the
 * support rectangle (Hof et al. 2005, "The condition for dynamic stability", J. Biomech. 38) — or the lean passes MAX_LEAN.
 * No support (|g_n| below MIN_GN or no contact): the standing model does not apply (the caller releases the body).
 *
 * Small-angle model; one rigid body; no stepping strategy (a real person can step to widen the support — the model is
 * conservative there). Educational reduced model.
 */
export const KP = 9; // (rad/s)²: ω_n = 3 rad/s
export const KD = 6; // 1/s: critically damped
export const LEAN_SHARE = 0.9;
export const MAX_LEAN = 0.35; // rad (20°)
/** Support-normal gravity below which standing is not modelled (0.05 g₀, the Phase 31 limit of "downward" models). */
export const MIN_GN = 0.05 * 9.80665;

export interface BalanceParams {
  mass: number;
  /** COM height above the soles (m). */
  hc: number;
  /** Transverse moment of inertia about the stance point (kg·m²). */
  Ia: number;
  /** Support rectangle half extents: forward (body +z), lateral (body x) (m). */
  forward: number;
  lateral: number;
}

export interface BalanceState {
  /** Lean (rad) along the plane axes e1, e2. */
  th: [number, number];
  /** Lean rate (rad/s). */
  om: [number, number];
  /** Last corrective moment (N·m), tipping moment (N·m), margin = 1 − |XcoM| / edge (< 0: outside). */
  mc: [number, number];
  tip: [number, number];
  margin: number;
  /** Demand: |needed corrective moment| / capacity of the step (≥ 1: saturated). */
  demand: number;
}

export function newBalance(): BalanceState {
  return { th: [0, 0], om: [0, 0], mc: [0, 0], tip: [0, 0], margin: 1, demand: 0 };
}

/** Edge distance of the support rectangle along a unit plane direction (u1, u2), with the body's facing (f1, f2) in the
 *  same plane (unit). */
export function edgeDistance(p: BalanceParams, u1: number, u2: number, f1: number, f2: number): number {
  const uf = Math.abs(u1 * f1 + u2 * f2); // along the facing
  const ul = Math.abs(u1 * f2 - u2 * f1); // lateral
  const k = Math.max(uf / p.forward, ul / p.lateral);
  return k > 0 ? 1 / k : Math.min(p.forward, p.lateral);
}

export interface BalanceInput {
  /** Support-normal gravity (m/s², > 0 = pressing into the support). */
  gn: number;
  /** Tipping moment (N·m) along e1, e2 — external forces + m h_c (g_t − a_b). */
  t1: number;
  t2: number;
  /** Facing in the plane (unit; for the support rectangle). */
  f1: number;
  f2: number;
  /** Phase 34: share of the ankle moment available (physiological capacity, 0…1; absent = 1). */
  control?: number;
}

export type BalanceOutcome = 'standing' | 'fall';

/** One step of the standing model. Returns 'fall' when balance is lost this step (state left at the moment of loss). */
export function stepBalance(p: BalanceParams, s: BalanceState, inp: BalanceInput, dt: number): BalanceOutcome {
  const { mass: m, hc, Ia } = p;
  const gn = inp.gn;
  const W = m * gn;
  s.tip[0] = inp.t1;
  s.tip[1] = inp.t2;
  // Target lean into the sustained load, inside LEAN_SHARE of the edge along that direction.
  let l1 = 0, l2 = 0;
  const tm = Math.hypot(inp.t1, inp.t2);
  if (tm > 0) {
    const u1 = -inp.t1 / tm, u2 = -inp.t2 / tm;
    const want = tm / (W * hc);
    const lim = (LEAN_SHARE * edgeDistance(p, u1, u2, inp.f1, inp.f2)) / hc;
    const a = Math.min(want, lim);
    l1 = u1 * a;
    l2 = u2 * a;
  }
  // Corrective moment wanted for θ̈ = −k_p (θ − θ*) − k_d θ̇, limited by the centre of pressure under the feet.
  const g1 = inp.t1 + W * hc * s.th[0], g2 = inp.t2 + W * hc * s.th[1];
  let c1 = g1 + Ia * (KP * (s.th[0] - l1) + KD * s.om[0]);
  let c2 = g2 + Ia * (KP * (s.th[1] - l2) + KD * s.om[1]);
  const cm = Math.hypot(c1, c2);
  let demand = 0;
  if (cm > 0) {
    const cap = inp.control === undefined ? W * edgeDistance(p, c1 / cm, c2 / cm, inp.f1, inp.f2) : W * edgeDistance(p, c1 / cm, c2 / cm, inp.f1, inp.f2) * inp.control;
    demand = cm / cap;
    if (cm > cap) {
      c1 *= cap / cm;
      c2 *= cap / cm;
    }
  }
  s.mc[0] = c1;
  s.mc[1] = c2;
  s.demand = demand;
  // Semi-implicit Euler (rate first).
  s.om[0] += ((g1 - c1) / Ia) * dt;
  s.om[1] += ((g2 - c2) / Ia) * dt;
  s.th[0] += s.om[0] * dt;
  s.th[1] += s.om[1] * dt;
  // Extrapolated centre of mass against the support edge along its direction.
  const w0 = Math.sqrt((gn * m * hc) / Ia);
  const x1 = hc * (s.th[0] + s.om[0] / w0), x2 = hc * (s.th[1] + s.om[1] / w0);
  const xm = Math.hypot(x1, x2);
  const e = xm > 0 ? edgeDistance(p, x1 / xm, x2 / xm, inp.f1, inp.f2) : Math.min(p.forward, p.lateral);
  s.margin = 1 - xm / e;
  if (s.margin < 0 || Math.hypot(s.th[0], s.th[1]) > MAX_LEAN) return 'fall';
  return 'standing';
}
