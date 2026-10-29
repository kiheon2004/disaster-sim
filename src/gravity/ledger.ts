/**
 * Energy and momentum ledger of gravity on the rigid bodies of a run (Phase 31; terms split by the Phase 31 audit,
 * docs/PHASE31_AUDIT.md §3) — pure bookkeeping.
 *
 * Time stepping (semi-implicit Euler, as Rapier: v₁ = v₀ + a·dt, x₁ = x₀ + v₁·dt). The field of step k is prepared for
 * t_k before the physics step; per step and body (mass m, x₀ → x₁, v₀ → v₁, g = g(x₀, t_k) the step applied):
 *   W_g    += m·g·(x₁ − x₀)                         path work of gravity (what moves U in a uniform field)
 *   ε      += ½·m·dt·g·(v₁ − v₀)                    the integrator's share of it: m·g·v₁·dt − m·g·v̄·dt, the part of W_g the
 *                                                   discrete scheme does not turn into kinetic energy (½·m·g²·dt² per
 *                                                   step in free fall; O(dt) overall)
 *   J_g    += m·g·dt                                gravity impulse (an external field: Σp is not conserved)
 *   W_fld  += m·(Φ(x, t_k) − Φ(x, t_{k−1}))         work of the CHANGING field (∂Φ/∂t at the body's position x at the
 *                                                   start of step k — gravity changed by the experiment); booked by the
 *                                                   runtime before the step (`field`)
 *   W_mv   += m·(Φ(x′, t_{k−1}) − Φ(x, t_{k−1}))    a body MOVED outside the integrator between two steps (pose set by
 *                                                   a rubble heap, ground deformation …) — not work of the field (`moved`)
 *   U       = Σ m·Φ(x, t)                           potential energy (NaN while a region source acts — no potential is
 *                                                   invented to close the books)
 *   K       = Σ ½·m·v²                              translational kinetic energy
 * Balances (each term traceable):
 *   other work    W_o = ΔK − W_g + ε                contacts, friction, damping, impulses and every other force (0 in free
 *                                                   flight, also in a spatially varying field)
 *   field check   R_Φ = Σ_steps [m·(Φ(x₁, t_k) − Φ(x₀, t_k)) + m·g·(x₁ − x₀)]
 *                                                   potential discretisation: 0 for a uniform field (exact), O(dt) for
 *                                                   radial fields; summed over the steps a potential exists
 *   energy check  Δ(K + U) − W_fld − W_mv − W_o = R_Φ − ε   (per step with a potential)
 *   other impulse = Δp − J_g                        contacts with the ground, other forces
 * Bodies entering / leaving the set (debris spawned, removed, made fixed or dynamic) bring / take their K, U and p
 * (booked separately as boundary terms; their mass is in the set exactly while they are tracked).
 */
import type { Vec3 } from '@/core/types';

export interface GravityBalance {
  kinetic: number;
  potential: number;
  workGravity: number;
  /** Σ |m·g·Δx| per body and step — the scale of the checks (the net work of an oscillation or orbit is ≈ 0). */
  workGravityGross: number;
  workField: number;
  /** Change of U by bodies moved outside the integrator between steps. */
  workMoved: number;
  /** ΔK − W_g + ε since the ledger started (contacts, damping, other forces), net of bodies entering / leaving. */
  workOther: number;
  /** ε: the share of W_g the semi-implicit Euler scheme does not turn into kinetic energy (O(dt)). */
  integratorResidual: number;
  /** R_Φ: potential discretisation over the steps with a potential (NaN when the run never had one). */
  fieldResidual: number;
  /** R_Φ − ε over the steps with a potential: Δ(K + U) − W_fld − W_mv − W_o (NaN when the run never had one). */
  energyResidual: number;
  impulse: Vec3;
  momentum: Vec3;
  impulseOther: Vec3;
  /** Energy brought in (+) / taken out (−) by bodies entering / leaving the set (U part only where Φ exists). */
  boundaryEnergy: number;
  boundaryKinetic: number;
  boundaryPotential: number;
  /** Times the potential became undefined (a region source switched on); steps that had one. */
  potentialGaps: number;
  stepsWithPotential: number;
  bodies: number;
}

export class GravityLedger {
  workGravity = 0;
  workGravityGross = 0;
  workField = 0;
  workMoved = 0;
  integrator = 0;
  /** Field / energy checks summed over the steps with a potential. */
  fieldCheck = 0;
  energyCheck = 0;
  kinetic = 0;
  potential = 0;
  /** K at the start (first step). */
  private k0 = NaN;
  boundaryK = 0;
  boundaryU = 0;
  readonly impulse: Vec3 = [0, 0, 0];
  readonly momentum: Vec3 = [0, 0, 0];
  private readonly p0: Vec3 = [0, 0, 0];
  readonly boundaryP: Vec3 = [0, 0, 0];
  potentialGaps = 0;
  stepsWithPotential = 0;
  private defined = true;
  bodies = 0;
  private kStep = 0;
  private uStep = 0;
  private fStep = 0;
  private eStep = 0;
  private pStep: Vec3 = [0, 0, 0];
  private nStep = 0;
  steps = 0;

  beginStep() {
    this.kStep = 0;
    this.uStep = 0;
    this.fStep = 0;
    this.eStep = 0;
    this.pStep[0] = this.pStep[1] = this.pStep[2] = 0;
    this.nStep = 0;
  }

  /**
   * One body over one step: x₀ / v₀ at the start, x₁ / v₁ after it, g the field the step applied, phi0 = Φ(x₀, t),
   * phi1 = Φ(x₁, t) (NaN without a potential).
   */
  body(m: number, x0: ArrayLike<number>, x1: ArrayLike<number>, v0: ArrayLike<number>, v1: ArrayLike<number>, g: ArrayLike<number>, dt: number, phi0: number, phi1: number) {
    const w = m * (g[0] * (x1[0] - x0[0]) + g[1] * (x1[1] - x0[1]) + g[2] * (x1[2] - x0[2]));
    const e = 0.5 * m * dt * (g[0] * (v1[0] - v0[0]) + g[1] * (v1[1] - v0[1]) + g[2] * (v1[2] - v0[2]));
    this.workGravity += w;
    this.workGravityGross += Math.abs(w);
    this.integrator += e;
    this.impulse[0] += m * g[0] * dt; this.impulse[1] += m * g[1] * dt; this.impulse[2] += m * g[2] * dt;
    const r = m * (phi1 - phi0) + w;
    this.fStep += r;
    this.eStep += r - e;
    this.kStep += 0.5 * m * (v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]);
    this.uStep += m * phi1;
    this.pStep[0] += m * v1[0]; this.pStep[1] += m * v1[1]; this.pStep[2] += m * v1[2];
    this.nStep++;
  }

  /** ∂Φ/∂t term of one body before a step: m·(Φ(x, t) − Φ(x, t_prev)) (skipped without a potential at either time). */
  field(m: number, phi: number, phiPrev: number) {
    const d = phi - phiPrev;
    if (!Number.isNaN(d)) this.workField += m * d;
  }

  /** A body moved outside the integrator between steps: m·(Φ(x′, t_prev) − Φ(x, t_prev)). */
  moved(m: number, phiNew: number, phiOld: number) {
    const d = phiNew - phiOld;
    if (!Number.isNaN(d)) this.workMoved += m * d;
  }

  /** A body enters (+1) or leaves (−1) the set with its kinetic energy, potential and momentum. */
  boundary(sign: 1 | -1, m: number, v: ArrayLike<number>, phi: number) {
    this.boundaryK += sign * 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (!Number.isNaN(phi)) this.boundaryU += sign * m * phi;
    this.boundaryP[0] += sign * m * v[0]; this.boundaryP[1] += sign * m * v[1]; this.boundaryP[2] += sign * m * v[2];
  }

  /** Start state (K, U, p of the bodies before the first step). */
  start(k: number, u: number, p: Readonly<Vec3>) {
    this.k0 = k;
    this.p0[0] = p[0]; this.p0[1] = p[1]; this.p0[2] = p[2];
    this.kinetic = k; this.potential = u;
    this.momentum[0] = p[0]; this.momentum[1] = p[1]; this.momentum[2] = p[2];
  }

  get started() {
    return !Number.isNaN(this.k0);
  }

  endStep(potentialDefined: boolean) {
    this.kinetic = this.kStep;
    const defined = potentialDefined && !Number.isNaN(this.uStep);
    this.potential = defined ? this.uStep : NaN;
    if (defined) {
      this.fieldCheck += this.fStep;
      this.energyCheck += this.eStep;
      this.stepsWithPotential++;
    } else if (this.defined) this.potentialGaps++;
    this.defined = defined;
    this.momentum[0] = this.pStep[0]; this.momentum[1] = this.pStep[1]; this.momentum[2] = this.pStep[2];
    this.bodies = this.nStep;
    this.steps++;
  }

  balance(): GravityBalance {
    const dK = this.kinetic - this.k0 - this.boundaryK;
    const io: Vec3 = [0, 1, 2].map((i) => this.momentum[i] - this.p0[i] - this.boundaryP[i] - this.impulse[i]) as Vec3;
    const any = this.stepsWithPotential > 0;
    return {
      kinetic: this.kinetic,
      potential: this.potential,
      workGravity: this.workGravity,
      workGravityGross: this.workGravityGross,
      workField: any ? this.workField : NaN,
      workMoved: this.workMoved,
      workOther: dK - this.workGravity + this.integrator,
      integratorResidual: this.integrator,
      fieldResidual: any ? this.fieldCheck : NaN,
      energyResidual: any ? this.energyCheck : NaN,
      impulse: [...this.impulse] as Vec3,
      momentum: [...this.momentum] as Vec3,
      impulseOther: io,
      boundaryEnergy: this.boundaryK + this.boundaryU,
      boundaryKinetic: this.boundaryK,
      boundaryPotential: this.boundaryU,
      potentialGaps: this.potentialGaps,
      stepsWithPotential: this.stepsWithPotential,
      bodies: this.bodies,
    };
  }
}
