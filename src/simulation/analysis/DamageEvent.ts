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
  | 'STORY_COLLAPSED'
  // Phase 22: covered by deposited sediment (people, vehicles, small structures).
  | 'BURIED'
  // Phase 28: touched by lava (recorded once; the effects are separate events / exposure).
  | 'LAVA_CONTACT';

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
  | 'gravity'
  // Phase 22: moving / deposited sediment (lateral debris load or drag) and burial.
  | 'debris' | 'burial'
  // Phase 23: ground cut away by an impact crater, hit by impact ejecta.
  | 'crater' | 'ejecta'
  // Phase 24: a part failed under the computed face pressure of an air-pressure wave; a body was
  // pushed / knocked down / toppled by the wave's net load (pressure difference + blast wind).
  | 'overpressure' | 'blast'
  // Phase 26: heat — strength lost with temperature / restrained thermal expansion (thermal buckling).
  | 'thermal'
  // Phase 27: burned (fuel consumed by flaming combustion).
  | 'fire'
  // Phase 28: pushed / damaged by lava standing against it; weight of volcanic ash on a roof.
  | 'lava' | 'ashLoad'
  // Phase 30: weight of snow / ice (roofs, crowns), repeated freezing and thawing (reported index).
  | 'snowLoad' | 'iceLoad' | 'freezeThaw'
  // Phase 31: own weight under a changed gravity field (dead load × g / g₀) and the members it overloaded.
  | 'gravityLoad';

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
export type Hazard = 'wind' | 'earthquake' | 'flood' | 'ground' | 'impact' | 'blast' | 'thermal' | 'fire' | 'volcano' | 'climate' | 'gravity';
/** Order matters only for ties (origin); later phases append so earlier hazards keep their indices. */
export const HAZARDS: readonly Hazard[] = ['wind', 'earthquake', 'flood', 'ground', 'impact', 'blast', 'thermal', 'fire', 'volcano', 'climate', 'gravity'];

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
  /**
   * Damage index 0–1 each hazard had caused to the object at that moment (Phase 22). `hazard`
   * is what triggered THIS event; `origin` is the hazard that had done the most damage so far —
   * e.g. a building cracked by an earthquake and finished by wind: hazard wind, origin earthquake.
   */
  contributors: Record<Hazard, number>;
  origin: Hazard;
  /** Phenomenon kind that produced it when more specific than the hazard (sinkhole, landslide …). */
  source?: string;
  /**
   * Phase 25 member failure detail: the engine's failure mode (axial, bending, shear, connection,
   * support, impact, foundation, bearing, story, drift, overpressure) and the collapse chain it
   * belongs to — the member whose loss triggered it, the chain's root member and its depth. The
   * record's `hazard` is the chain's PRIMARY hazard (what started it).
   */
  failure?: string;
  chain?: { trigger: string | null; root: string; depth: number; round: number };
  /**
   * Secondary damage (Phase 25): the object was struck by a fragment / rubble of another object —
   * the striking piece, the building and member it came from. `hazard` stays the primary hazard
   * of the fragment's failure; `cause` is the direct cause (impact, burial).
   */
  secondary?: { striker: string; source: string; member?: string; energy?: number };
}

type Optional = 'worldPosition' | 'localWindSpeed' | 'force' | 'damageBefore' | 'damageAfter' | 'shadowSource' | 'hazard' | 'groundAcceleration' | 'response' | 'waterDepth' | 'flowSpeed' | 'exposure' | 'state' | 'source' | 'failure' | 'chain' | 'secondary';

export type DamageEventInput = Omit<DamageEventRecord, 'id' | 'time' | 'objectId' | 'objectType' | 'globalWindSpeed' | 'contributors' | 'origin' | Optional> & Partial<Pick<DamageEventRecord, Optional>>;
