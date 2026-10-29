/**
 * Experiment milestones (Phase 15): the ordered story of a run for the experiment timeline —
 * when each phenomenon started / ended, the first damage of each hazard, collapses, the first
 * person falling, the first floating vehicle, the flooded area passing 0.1 / 1 / 5 ha.
 * Recorded from simulation time only, so the order is the same at any playback speed or when
 * paused. Pure bookkeeping.
 */
import type { I18nMessage } from '@/i18n/i18n';
import type { Hazard } from './DamageEvent';

export type MilestoneKind = 'start' | 'end' | 'firstDamage' | 'collapse' | 'firstFall' | 'floated' | 'floodArea' | 'deformPeak' | 'supportLoss' | 'roadCut'
  // Phase 22 ground failure.
  | 'sinkholeInit' | 'sinkholeExpansion' | 'slopeInstability' | 'landslideInit' | 'peakSediment' | 'roadBlocked' | 'foundationFailure'
  // Phase 23 impacts.
  | 'impactEntry' | 'impactBreakup' | 'airburst' | 'impact' | 'peakGroundShock' | 'craterFormed' | 'ejectaLanding'
  // Phase 24 air-pressure waves.
  | 'blastSource' | 'blastArrival' | 'blastPeak' | 'blastImpulse'
  // Phase 25 structural destruction.
  | 'memberFailure' | 'connectionFailure' | 'loadRedistribution' | 'progressiveCollapse' | 'partialCollapse' | 'globalCollapse' | 'debrisImpact' | 'secondaryDamage';

export interface Milestone {
  time: number;
  kind: MilestoneKind;
  hazard?: Hazard;
  /** Phenomenon type (start / end) or object type. */
  subject?: string;
  label: I18nMessage;
}

const MAX = 300;
export const FLOOD_AREA_STEPS = [1000, 10000, 50000]; // m²

export class MilestoneRecorder {
  readonly list: Milestone[] = [];
  private firsts = new Set<string>();
  private areaStep = 0;

  add(m: Milestone) {
    if (this.list.length < MAX) this.list.push(m);
  }

  /** Record once per key (first damage per hazard …). */
  once(key: string, m: Milestone) {
    if (this.firsts.has(key)) return;
    this.firsts.add(key);
    this.add(m);
  }

  floodArea(time: number, area: number) {
    while (this.areaStep < FLOOD_AREA_STEPS.length && area >= FLOOD_AREA_STEPS[this.areaStep]) {
      const a = FLOOD_AREA_STEPS[this.areaStep++];
      this.add({ time, kind: 'floodArea', hazard: 'flood', label: { key: 'milestone.floodArea', params: { ha: a / 10000 } } });
    }
  }
}
