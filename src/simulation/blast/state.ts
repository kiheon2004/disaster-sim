/**
 * Per-object state of the air-blast response (Phase 24), created when the first wave approaches the
 * object. Static objects keep their face loads (computed once at activation); moving bodies recompute
 * them every step from their pose.
 */
import type { Exposure, Shielding, Contribution } from '@/blast/wave';
import type { Faces, FaceLoad, Sdof } from '@/blast/loads';
import type { Zone } from '@/blast/source';

export interface WaveLoad {
  /** Index of the wave in env.blast.waves. */
  wave: number;
  shield: Shielding;
  /** Faces and face loads of a static object (null for bodies: recomputed each step). */
  faces: Faces | null;
  loads: FaceLoad[];
  /** Contributions at the object's centre (side-on peak / impulse, drag). */
  center: Contribution[];
  first: number;
  end: number;
  /** Drag area C_d·A of a static object along the wave (m²; bodies compute theirs each step). */
  cdA: number;
  /**
   * Time the loads of this wave have been integrated up to (s). Each step integrates from here to the
   * step's end, so an impulse that arrived before the object's first evaluated step (an event starting
   * a step late, an activation lead) is delivered at once and never lost or counted twice.
   */
  tDone: number;
}

export interface PartEntry {
  /** Component index (−1 for a structural member). */
  ci: number;
  /** Modular building member index of an exterior wall loaded out of plane (Phase 17 member path). */
  member?: number;
  sdof: Sdof;
  /** Static pressure capacity (Pa). */
  cap: number;
  loads: FaceLoad[];
  first: number;
  end: number;
  /** ∫ p_face dt since the arrival (Pa·s) — the impulse a detaching part leaves with. */
  impulse: number;
  /** Integrated up to (s) — see WaveLoad.tDone. */
  tDone: number;
  /** Peak face pressure (Pa). */
  peakP: number;
  done: boolean;
}

export interface BlastEntityState {
  /** Phenomenon of the strongest wave at the object ('blast:p1', 'impact:p2'). */
  source: string;
  /** Side-on peak overpressure (Pa), positive impulse (Pa·s), first arrival (s) at the object's centre. */
  peak: number;
  impulse: number;
  arrival: number;
  zone: Zone;
  exposure: Exposure;
  shieldedBy: string | null;
  /** Insertion loss of the shielding (dB). */
  il: number;
  waves: WaveLoad[];
  parts: PartEntry[] | null;
  /** Base-moment oscillator (trees) and its capacity (N·m). */
  sdof: Sdof | null;
  cap: number;
  /** Integrated up to (s) for the base-moment oscillator. */
  sdofT: number;
  /** People: running horizontal velocity change along the wave (m/s) and its peak. */
  dv: number;
  dvPeak: number;
  /** Mechanical impulse received (|J| summed, N·s), largest step force (N). */
  J: number;
  peakForce: number;
  /** Structures: peak blast lateral force / structural mass (m/s², comparable to a ground acceleration). */
  aEq: number;
  /** Damage index of the blast's own channel (base-moment oscillators; 1 = toppled). */
  damage: number;
  /** Facade parts / attachments failed by the blast. */
  broken: number;
  done: boolean;
  noted: Set<string>;
}

export function newBlastState(): BlastEntityState {
  return {
    source: '', peak: 0, impulse: 0, arrival: Infinity, zone: 'weak', exposure: 'direct', shieldedBy: null, il: 0, waves: [], parts: null,
    sdof: null, cap: 0, sdofT: -Infinity, dv: 0, dvPeak: 0, J: 0, peakForce: 0, aEq: 0, damage: 0, broken: 0, done: false, noted: new Set(),
  };
}
