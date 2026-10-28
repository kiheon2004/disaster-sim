import type { EntityId, ObjectType, Vec3 } from '@/core/types';
import type { ComponentKind } from '@/core/model';

/** Kinds of damage events recorded in the history. */
export type DamageEventType =
  | 'DAMAGED'
  | 'CRITICAL'
  | 'DESTROYED'
  | 'FALLEN'
  | 'SNAPPED'
  | 'UPROOTED'
  | 'MOVED'
  | 'OVERTURNED'
  | 'BROKEN'
  | 'DETACHED'
  | 'COLLAPSED'
  | 'TOPPLED'
  | 'IMPACT'
  | 'CRACKED'
  | 'TILTED';

/**
 * Why it happened:
 *  - overload: load ratio above the instant-break threshold (typically a gust)
 *  - fatigue:  accumulated damage from sustained load above ~70 % of design
 *  - push:     aerodynamic force moved/overturned a free-standing object
 *  - impact:   hit by debris or another object
 */
export type DamageCause = 'overload' | 'fatigue' | 'push' | 'impact' | 'drift' | 'acceleration' | 'foundation' | 'shaking';

/**
 * Which hazard produced the event (Phase 13). Earthquake causes:
 *  - drift:        inter-story drift beyond a capacity (glass, walls, structure)
 *  - acceleration: floor / ground acceleration beyond an anchorage capacity (cladding, signs, roof units)
 *  - foundation:   foundation tilt / bearing failure
 *  - shaking:      ground shaking moved or toppled a free object (people, poles, walls)
 */
export type Hazard = 'wind' | 'earthquake';

export interface DamageEventRecord {
  id: number;
  /** Simulation time (s). */
  time: number;
  objectId: EntityId;
  objectType: ObjectType;
  componentId?: string;
  componentKind?: ComponentKind;
  eventType: DamageEventType;
  worldPosition: Vec3;
  /** Local wind at the object / component (m/s). */
  localWindSpeed: number;
  /** Global reference wind (10 m mean, m/s). */
  globalWindSpeed: number;
  /** Aerodynamic load at that moment (N), or contact force for impacts. */
  force: number;
  /** Damage fraction 0–1 before / after. */
  damageBefore: number;
  damageAfter: number;
  cause: DamageCause;
  /** Building casting a wind shadow at the location, if any. */
  shadowSource: EntityId | null;
  /** Wind or earthquake. */
  hazard: Hazard;
  /** Horizontal ground acceleration at the object at that moment (m/s²; 0 for wind events). */
  groundAcceleration: number;
  /** Structural response at that moment: drift ratio (drift causes) or acceleration in g. */
  response: number;
}

export type DamageEventInput = Omit<DamageEventRecord, 'id' | 'time' | 'objectId' | 'objectType' | 'globalWindSpeed' | 'worldPosition' | 'localWindSpeed' | 'force' | 'damageBefore' | 'damageAfter' | 'shadowSource' | 'hazard' | 'groundAcceleration' | 'response'> &
  Partial<Pick<DamageEventRecord, 'worldPosition' | 'localWindSpeed' | 'force' | 'damageBefore' | 'damageAfter' | 'shadowSource' | 'hazard' | 'groundAcceleration' | 'response'>>;
