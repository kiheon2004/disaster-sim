/**
 * Phase 33: impact episodes and the EDUCATIONAL injury-risk index of the reduced human model.
 *
 * NOT a medical model. It does not diagnose, predict an individual's injuries, or give probabilities. It turns the
 * mechanics the simulation actually computed — the velocity change of the struck point of the body during a contact episode
 * — into an ordered risk index per body segment so that scenarios can be compared (a feet-first 1 m drop < a 10 m drop; a
 * head strike weighs more than the same strike on a leg).
 *
 * Episode: contact-force events of one partner (ground, an object, a debris piece) on consecutive steps (gaps of up to
 * GAP steps bridged), closed after the gap or MAX_STEPS. The impulse is J = Σ F_k·dt over the event steps (Rapier reports
 * the solver force of a step = impulse / dt); the body's velocity change Δv = v_after − v_before is read from the body.
 * The contact duration is only known to the step resolution (≥ one step): the "representative deceleration" |Δv| / (n·dt)
 * is a LOWER bound of the real peak (a real impact is usually shorter than 1/60 s).
 *
 * Index of a segment for one episode: i = |Δv_s| / v_ref(segment), Δv_s = the velocity change of the segment's struck point
 * (the impulse-weighted mean of the solver contact points attributed to it) — the simulation reads it from the rigid
 * body's motion (v + ω × r before / after; for a single point impulse that is J/m + (I⁻¹(r × J)) × r, pointDeltaV). A
 * segment counts as struck when it took ≥ MIN_SHARE of the episode's contact impulse (a body landing along its length
 * strikes several segments, each at its own speed: in a topple the head end arrives fastest). v_ref are MODEL PARAMETERS (not injury tolerances from data), anchored on four reference
 * scenarios of this model: a fall from standing height lands the torso / pelvis at "minor", a head striking the ground in
 * such a fall at "severe", a 3 m feet-first drop the legs at "moderate", a 10 m one at "severe". They are listed in
 * HUMAN_PHYSICS.md and scaled by settings.simulation.humans.riskScale.
 * Accumulation over episodes: i_cum = √(Σ i²) (the velocity changes add like energies: ½ m Δv²).
 * Levels: none < minor < moderate < severe < incapacitating at the cumulative index thresholds LEVEL_AT.
 */
import type { Vec3 } from '@/core/types';
import type { SegmentId } from './anthropometry';
import { SEGMENT_IDS } from './anthropometry';

export const INJURY_LEVELS = ['none', 'minor', 'moderate', 'severe', 'incapacitating'] as const;
export type InjuryLevel = (typeof INJURY_LEVELS)[number];
/** Cumulative index at which each level starts (minor, moderate, severe, incapacitating). */
export const LEVEL_AT = [0.3, 0.6, 1, 1.6] as const;
/** Reference velocity changes (m/s) — model parameters (see header). */
export const V_REF: Record<SegmentId, number> = { head: 6, neck: 5, torso: 9, pelvis: 8, leftArm: 8, rightArm: 8, leftLeg: 10, rightLeg: 10 };
/** A segment counts as struck in an episode when it took at least this share of the episode's contact impulse. */
export const MIN_SHARE = 0.1;
/** Event steps bridged inside one episode, and the longest episode (steps). */
export const GAP = 2;
export const MAX_STEPS = 30;

export function levelOf(index: number): InjuryLevel {
  let k = 0;
  while (k < LEVEL_AT.length && index >= LEVEL_AT[k]) k++;
  return INJURY_LEVELS[k];
}
export const levelRank = (l: InjuryLevel) => INJURY_LEVELS.indexOf(l);

export interface SegmentRisk {
  /** Largest single-episode index, cumulative index, episodes that reached the segment. */
  peak: number;
  cum: number;
  hits: number;
  level: InjuryLevel;
}

export function newRisk(): Record<SegmentId, SegmentRisk> {
  const r = {} as Record<SegmentId, SegmentRisk>;
  for (const id of SEGMENT_IDS) r[id] = { peak: 0, cum: 0, hits: 0, level: 'none' };
  return r;
}

/** Velocity change of a point of a rigid body at r (from the COM, world) for an impulse J, with the inverse inertia applied
 *  by `invI` (world). */
export function pointDeltaV(J: Readonly<Vec3>, m: number, r: Readonly<Vec3>, invI: (v: Vec3) => Vec3): Vec3 {
  const L: Vec3 = [r[1] * J[2] - r[2] * J[1], r[2] * J[0] - r[0] * J[2], r[0] * J[1] - r[1] * J[0]];
  const w = invI(L);
  return [J[0] / m + (w[1] * r[2] - w[2] * r[1]), J[1] / m + (w[2] * r[0] - w[0] * r[2]), J[2] / m + (w[0] * r[1] - w[1] * r[0])];
}

/** Apply one episode's struck segments (their struck points' velocity changes, m/s) to the risk record. Returns the
 *  segments whose level rose. */
export function applyEpisode(risk: Record<SegmentId, SegmentRisk>, hits: readonly { id: SegmentId; dv: number }[], vref: Record<SegmentId, number> = V_REF): SegmentId[] {
  const rose: SegmentId[] = [];
  for (const { id, dv } of hits) {
    const i = dv / vref[id];
    if (!(i > 0)) continue;
    const r = risk[id];
    r.hits++;
    if (i > r.peak) r.peak = i;
    r.cum = Math.sqrt(r.cum * r.cum + i * i);
    const lv = levelOf(r.cum);
    if (levelRank(lv) > levelRank(r.level)) {
      r.level = lv;
      rose.push(id);
    }
  }
  return rose;
}

export type Mobility = 'mobile' | 'impaired' | 'immobile';

export function worstLevel(risk: Record<SegmentId, SegmentRisk>): InjuryLevel {
  let k = 0;
  for (const id of SEGMENT_IDS) k = Math.max(k, levelRank(risk[id].level));
  return INJURY_LEVELS[k];
}

/** Reduced "able to act" state (rules of the educational model): incapacitated when the head or neck reaches severe, the
 *  torso and pelvis are both severe, or any segment is incapacitating; mobility from the legs and pelvis (severe legs alone
 *  make a person immobile, not unable to act). */
export function capability(risk: Record<SegmentId, SegmentRisk>): { incapacitated: boolean; mobility: Mobility } {
  let inc = false;
  for (const id of SEGMENT_IDS) if (levelRank(risk[id].level) >= 4) inc = true;
  if (levelRank(risk.head.level) >= 3 || levelRank(risk.neck.level) >= 3) inc = true;
  if (levelRank(risk.torso.level) >= 3 && levelRank(risk.pelvis.level) >= 3) inc = true;
  const legs = Math.max(levelRank(risk.leftLeg.level), levelRank(risk.rightLeg.level), levelRank(risk.pelvis.level));
  const mobility: Mobility = inc || legs >= 3 ? 'immobile' : legs >= 2 ? 'impaired' : 'mobile';
  return { incapacitated: inc, mobility };
}
