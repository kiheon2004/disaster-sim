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
  | 'TILTED'
  | 'INUNDATED'
  | 'FLOATED'
  | 'SCOURED'
  // Phase 17 modular buildings: a structural member failed / the stories above a level collapsed.
  | 'FAILED'
  | 'STORY_COLLAPSED';

/**
 * Why it happened:
 *  - overload: load ratio above the instant-break threshold (typically a gust)
 *  - fatigue:  accumulated damage from sustained load above ~70 % of design
 *  - push:     aerodynamic force moved/overturned a free-standing object
 *  - impact:   hit by debris or another object
 */
export type DamageCause =
  | 'overload' | 'fatigue' | 'push' | 'impact' | 'drift' | 'acceleration' | 'foundation' | 'shaking'
  | 'hydrostatic' | 'hydrodynamic' | 'buoyancy' | 'inundation' | 'scour'
  // Phase 17: a member lost its load path or was overloaded by redistributed gravity load.
  | 'gravity';

/**
 * Which hazard produced the event (Phase 13). Earthquake causes:
 *  - drift:        inter-story drift beyond a capacity (glass, walls, structure)
 *  - acceleration: floor / ground acceleration beyond an anchorage capacity (cladding, signs, roof units)
 *  - foundation:   foundation tilt / bearing failure
 *  - shaking:      ground shaking moved or toppled a free object (people, poles, walls)
 * Flood causes (Phase 14):
 *  - hydrostatic:  water pressure from a depth difference (walls, windows, building envelope)
 *  - hydrodynamic: drag of flowing water (people, vehicles, poles, debris)
 *  - buoyancy:     lifted by the water (vehicles floating)
 *  - inundation:   standing in water for a time (finishes, interiors, vehicle electrics)
 *  - scour:        fast flow eroding a road surface
 */
export type Hazard = 'wind' | 'earthquake' | 'flood' | 'ground';
export const HAZARDS: readonly Hazard[] = ['wind', 'earthquake', 'flood', 'ground'];

export interface DamageEventRecord {
  id: number;
  /** Simulation time (s). */
  time: number;
  objectId: EntityId;
  objectType: ObjectType;
  componentId?: string;
  componentKind?: ComponentKind;
  /** Modular building member type (Phase 17; componentId is the member id). */
  memberType?: string;
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
  /** Water depth at the object (m; 0 for wind / earthquake events). Phase 14. */
  waterDepth: number;
  /** Flow speed at the object (m/s). */
  flowSpeed: number;
  /** Seconds the object had been in water ≥ 0.1 m deep. */
  exposure: number;
  /** Damage state of the object right after the event. */
  state: number;
}

type Optional = 'worldPosition' | 'localWindSpeed' | 'force' | 'damageBefore' | 'damageAfter' | 'shadowSource' | 'hazard' | 'groundAcceleration' | 'response' | 'waterDepth' | 'flowSpeed' | 'exposure' | 'state';

export type DamageEventInput = Omit<DamageEventRecord, 'id' | 'time' | 'objectId' | 'objectType' | 'globalWindSpeed' | Optional> & Partial<Pick<DamageEventRecord, Optional>>;
