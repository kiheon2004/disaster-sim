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
  | 'IMPACT';

/**
 * Why it happened:
 *  - overload: load ratio above the instant-break threshold (typically a gust)
 *  - fatigue:  accumulated damage from sustained load above ~70 % of design
 *  - push:     aerodynamic force moved/overturned a free-standing object
 *  - impact:   hit by debris or another object
 */
export type DamageCause = 'overload' | 'fatigue' | 'push' | 'impact';

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
}

export type DamageEventInput = Omit<DamageEventRecord, 'id' | 'time' | 'objectId' | 'objectType' | 'globalWindSpeed' | 'worldPosition' | 'localWindSpeed' | 'force' | 'damageBefore' | 'damageAfter' | 'shadowSource'> &
  Partial<Pick<DamageEventRecord, 'worldPosition' | 'localWindSpeed' | 'force' | 'damageBefore' | 'damageAfter' | 'shadowSource'>>;
