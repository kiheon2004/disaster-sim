/**
 * Energy and momentum ledger of gravity on the rigid bodies of a run (Phase 31) — pure bookkeeping.
 *
 * Per fixed step and body (mass m, position x₀ → x₁, velocity v₁, the field g(x₀, t) the step applied):
 *   W_g    += m·g(x₀, t)·(x₁ − x₀)                       work of gravity along the path the integrator took
 *   J_g    += m·g(x₀, t)·dt                              gravity impulse (an external field: Σp is not conserved)
 *   W_fld  += m·(Φ(x₁, t + dt) − Φ(x₁, t))               work of the CHANGING field (∂Φ/∂t at fixed x — gravity changed
 *                                                        by the experiment pumps energy in or out; only when Φ exists)
 *   U       = Σ m·Φ(x, t)                                potential energy (NaN while a region source acts — no
 *                                                        potential is invented to close the books)
 *   K       = Σ ½·m·v²                                   translational kinetic energy
 * Balances:
 *   other work   = ΔK − W_g                              contacts, friction, damping and every other force
 *   field check  = ΔU − W_fld + W_g                      0 for a uniform field (exact), O(dt²) for radial fields
 *   other impulse = Δp − J_g                             contacts with the ground, other forces
 * Bodies entering / leaving the set (debris spawned, removed) bring / take their K, U and p (booked separately).
 */
import type { Vec3 } from '@/core/types';

export interface GravityBalance {
  kinetic: number;
  potential: number;
  workGravity: number;
  workField: number;
  /** ΔK − W_g since the ledger started (contacts, damping, other forces), net of bodies entering / leaving. */
  workOther: number;
  /** ΔU − W_fld + W_g (integrator / potential discretisation residual; NaN without a potential). */
  fieldResidual: number;
  impulse: Vec3;
  momentum: Vec3;
  impulseOther: Vec3;
  /** Energy brought in (+) / taken out (−) by bodies entering / leaving the set. */
  boundaryEnergy: number;
  bodies: number;
}

export class GravityLedger {
  workGravity = 0;
  workField = 0;
  kinetic = 0;
  potential = 0;
  /** K and U at the start (first step) and of bodies entering / leaving. */
  private k0 = NaN;
  private u0 = NaN;
  boundaryK = 0;
  boundaryU = 0;
  readonly impulse: Vec3 = [0, 0, 0];
  readonly momentum: Vec3 = [0, 0, 0];
  private readonly p0: Vec3 = [0, 0, 0];
  readonly boundaryP: Vec3 = [0, 0, 0];
  /** Potential undefined at some step: U and the field check are not reported from then on. */
  potentialLost = false;
  bodies = 0;
  private kStep = 0;
  private uStep = 0;
  private pStep: Vec3 = [0, 0, 0];
  private nStep = 0;
  steps = 0;

  beginStep() {
    this.kStep = 0;
    this.uStep = 0;
    this.pStep[0] = this.pStep[1] = this.pStep[2] = 0;
    this.nStep = 0;
  }

  /** One body over one step. phi1 = Φ(x₁, t + dt), phi1Old = Φ(x₁, t) (NaN without a potential). */
  body(m: number, x0: ArrayLike<number>, x1: ArrayLike<number>, v1: ArrayLike<number>, g: ArrayLike<number>, dt: number, phi1: number, phi1Old: number) {
    this.workGravity += m * (g[0] * (x1[0] - x0[0]) + g[1] * (x1[1] - x0[1]) + g[2] * (x1[2] - x0[2]));
    this.impulse[0] += m * g[0] * dt; this.impulse[1] += m * g[1] * dt; this.impulse[2] += m * g[2] * dt;
    if (!Number.isNaN(phi1)) this.workField += m * (phi1 - phi1Old);
    this.kStep += 0.5 * m * (v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]);
    this.uStep += m * phi1;
    this.pStep[0] += m * v1[0]; this.pStep[1] += m * v1[1]; this.pStep[2] += m * v1[2];
    this.nStep++;
  }

  /** A body enters (+1) or leaves (−1) the set with its kinetic energy, potential and momentum. */
  boundary(sign: 1 | -1, m: number, v: ArrayLike<number>, phi: number) {
    this.boundaryK += sign * 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    this.boundaryU += sign * m * phi;
    this.boundaryP[0] += sign * m * v[0]; this.boundaryP[1] += sign * m * v[1]; this.boundaryP[2] += sign * m * v[2];
  }

  /** Start state (K, U, p of the bodies before the first step). */
  start(k: number, u: number, p: Readonly<Vec3>) {
    this.k0 = k; this.u0 = u;
    this.p0[0] = p[0]; this.p0[1] = p[1]; this.p0[2] = p[2];
    this.kinetic = k; this.potential = u;
    this.momentum[0] = p[0]; this.momentum[1] = p[1]; this.momentum[2] = p[2];
  }

  get started() {
    return !Number.isNaN(this.k0);
  }

  endStep(potentialDefined: boolean) {
    this.kinetic = this.kStep;
    this.potential = this.uStep;
    this.momentum[0] = this.pStep[0]; this.momentum[1] = this.pStep[1]; this.momentum[2] = this.pStep[2];
    this.bodies = this.nStep;
    if (!potentialDefined || Number.isNaN(this.uStep)) this.potentialLost = true;
    this.steps++;
  }

  balance(): GravityBalance {
    const dK = this.kinetic - this.k0 - this.boundaryK;
    const dU = this.potential - this.u0 - this.boundaryU;
    const io: Vec3 = [0, 1, 2].map((i) => this.momentum[i] - this.p0[i] - this.boundaryP[i] - this.impulse[i]) as Vec3;
    return {
      kinetic: this.kinetic,
      potential: this.potentialLost ? NaN : this.potential,
      workGravity: this.workGravity,
      workField: this.potentialLost ? NaN : this.workField,
      workOther: dK - this.workGravity,
      fieldResidual: this.potentialLost ? NaN : dU - this.workField + this.workGravity,
      impulse: [...this.impulse] as Vec3,
      momentum: [...this.momentum] as Vec3,
      impulseOther: io,
      boundaryEnergy: this.boundaryK + (this.potentialLost ? 0 : this.boundaryU),
      bodies: this.bodies,
    };
  }
}
