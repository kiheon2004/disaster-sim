/**
 * Capture ledger of the celestial experiments (Phase 32) — pure bookkeeping, every term traceable:
 *
 *  mass        captured bodies / particles never vanish: Σ captured = the store; a 'grow' source's mass rises by the
 *              same amount (M_new = M_old + m, μ = G·M), a 'fixed' / 'accumulate' source keeps M and the store holds it
 *  momentum    sources are held on prescribed paths: the body's momentum change to the source's velocity V_s is a
 *              constraint impulse J = m·(V_s − v) delivered by whatever holds the source (booked, not lost); a free
 *              source would instead take ΔV = m·(v − V_s)/(M + m) (perfectly inelastic merge — reported as a
 *              diagnostic, not applied: the sources here are not dynamic, no N-body)
 *  energy      at capture the body brings K = ½m·v², K_rel = ½m·|v − V_s|² (relative to the source) and U = m·Φ(x);
 *              the constraint does work J·V_s (identity ½m·V_s² − ½m·v² = J·V_s − K_rel); K_rel and the binding
 *              energy are NOT resolved further — no radiation, heating or accretion-efficiency model — and are
 *              reported as model-unresolved energy (never shown as light or heat)
 * Particles that land on the ground dissipate their kinetic energy in the contact (booked separately).
 */
import type { Vec3 } from '@/core/types';
import type { MassPolicy } from './types';

export type CaptureKind = 'vehicle' | 'person' | 'object' | 'debris' | 'fragment' | 'probe' | 'particle';
export const CAPTURE_KINDS: readonly CaptureKind[] = ['vehicle', 'person', 'object', 'debris', 'fragment', 'probe', 'particle'];

export interface CaptureRecord {
  t: number;
  kind: CaptureKind;
  id: string;
  mass: number;
  source: { owner: number; index: number };
  policy: MassPolicy;
  momentum: Vec3;
  constraintImpulse: Vec3;
  constraintWork: number;
  kinetic: number;
  kineticRel: number;
  potential: number;
  massBefore: number;
  massAfter: number;
  /** Velocity change a FREE source would take (diagnostic; m/s). */
  freeMergeDv: Vec3;
}

/** Bounded history of individual captures (the totals keep counting). */
export const CAPTURE_HISTORY = 500;

export class CelestialLedger {
  readonly records: CaptureRecord[] = [];
  count = 0;
  mass = 0;
  /** Mass added to growing sources (kg) / held in the store of fixed or accumulating sources. */
  grown = 0;
  stored = 0;
  readonly momentum: Vec3 = [0, 0, 0];
  readonly constraintImpulse: Vec3 = [0, 0, 0];
  constraintWork = 0;
  kinetic = 0;
  kineticRel = 0;
  potential = 0;
  /** Count / mass by kind. */
  readonly byKind: Record<CaptureKind, { n: number; m: number }> = Object.fromEntries(CAPTURE_KINDS.map((k) => [k, { n: 0, m: 0 }])) as Record<CaptureKind, { n: number; m: number }>;
  /** Accretion particles: placed, captured, landed, left (kg), kinetic energy dissipated on landing (J). */
  particlesIn = 0;
  particlesCaptured = 0;
  particlesLanded = 0;
  particlesLeft = 0;
  particleDissipated = 0;
  /** Probe bodies that left the world (kg). */
  left = 0;

  capture(r: CaptureRecord) {
    this.count++;
    this.mass += r.mass;
    if (r.policy === 'grow') this.grown += r.mass; else this.stored += r.mass;
    for (let i = 0; i < 3; i++) { this.momentum[i] += r.momentum[i]; this.constraintImpulse[i] += r.constraintImpulse[i]; }
    this.constraintWork += r.constraintWork;
    this.kinetic += r.kinetic;
    this.kineticRel += r.kineticRel;
    this.potential += r.potential;
    this.byKind[r.kind].n++;
    this.byKind[r.kind].m += r.mass;
    this.records.push(r);
    if (this.records.length > CAPTURE_HISTORY) this.records.shift();
  }

  /** Mass closure: captured − (grown + stored) (kg; 0 up to rounding). */
  massResidual(): number {
    return this.mass - this.grown - this.stored;
  }

  /** Energy left unresolved by the model (J): K_rel (dissipation at capture not modelled). */
  get unresolved(): number {
    return this.kineticRel;
  }

  /** Particle mass closure: placed − flying − captured − landed − left (kg) given the flying mass. */
  particleResidual(flying: number): number {
    return this.particlesIn - flying - this.particlesCaptured - this.particlesLanded - this.particlesLeft;
  }
}
