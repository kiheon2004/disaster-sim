import type { EntityId, Quat, Vec3 } from '@/core/types';
import type { ComponentSpec, WorldObject } from '@/core/model';
import type { ObjectDefinition, PhysicsProfile } from '@/objects/ObjectDefinition';
import type { I18nMessage } from '@/i18n/i18n';
import type { BodyHandle, Pose } from '@/physics/PhysicsEngine';
import type { DamageState } from './damage/DamageState';
import type { LocalWind, SampleCache } from './wind/SpatialWindField';
import type { DamageCause, Hazard } from './analysis/DamageEvent';
import type { SeismicEntityState, SeismicRuntime } from './seismic/SeismicState';
import type { FloodEntityState, FloodRuntime } from './flood/FloodState';

export type ComponentCondition = 'intact' | 'broken' | 'detached';

export interface RuntimeComponent {
  spec: Readonly<ComponentSpec>;
  state: DamageState;
  /** 1 → 0 */
  health: number;
  condition: ComponentCondition;
  loadRatio: number;
  /** World position/normal of a part on a static object, computed once (internal). */
  worldPos?: Vec3;
  worldNormal?: Vec3 | null;
  windCache?: SampleCache;
}

/** Purely visual animation channels written by systems and read by renderers. */
export interface VisualState {
  /** Bending angle (rad) around `swayAxis`, pivoting at the object base. */
  swayAngle: number;
  /** Horizontal unit axis to bend around (perpendicular to the wind). */
  swayAxis: Vec3;
  /** 0–1: raised arms / bracing posture (people). */
  brace: number;
  /** 0–1: fraction of foliage lost (trees). */
  foliageLoss: number;
  /** Angular velocity of the sway spring (internal). */
  swayVel: number;
}

export interface RuntimeEntity {
  id: EntityId;
  source: Readonly<WorldObject>;
  def: ObjectDefinition;
  profile: PhysicsProfile;
  body: BodyHandle | null;
  /** Whether the body is currently simulated (false = fixed in place). */
  dynamic: boolean;
  /** Current world pose of the entity root (or the falling part for snapped trees). */
  pose: Pose;
  /** Pose at t = 0. */
  initialPose: Pose;
  /** Scaled bounding box and center of pressure (local). */
  dims: Vec3;
  copLocal: Vec3;
  /** Broadside frontal area (m²) — informational. */
  area: number;
  /** Ratio of the real frontal area to the bounding-box silhouette (porous canopies, slim people). */
  areaFactor: number;
  /** Individual strength multiplier on windResistance (natural variation between specimens). */
  strength: number;
  /** Friction multiplier from the ground type under a free-standing object at t = 0. */
  groundFriction: number;
  state: DamageState;
  health: number;
  loadRatio: number;
  peakLoadRatio: number;
  /** Effective wind speed at the center of pressure (m/s). */
  windAtCop: number;
  /** Full local-wind sample at the center of pressure (from the spatial wind field). */
  localWind: LocalWind;
  /** Current aerodynamic load magnitude (N). */
  windLoad: number;
  /** Worst state reached so far. */
  peakState: DamageState;
  /** Cause of the most recent damage. */
  lastCause: DamageCause | null;
  /** Hazard behind the most recent damage (wind / earthquake / flood). */
  lastHazard: Hazard | null;
  /** Earthquake response state; created when the first earthquake starts (Phase 13). */
  seismic?: SeismicEntityState;
  /** Unified damage state: own wind fatigue + ordered damage history (Phase 15). */
  integrity?: import('./interactions/integrity').IntegrityState;
  /** Environmental exposure (people, Phase 15). */
  exposure?: import('./response/exposure').ExposureState;
  /** Last force per source from the ForceLedger (inspector breakdown, Phase 15). */
  forces?: Float64Array;
  /** Flood exposure / response state; created when the water model activates (Phase 14). */
  flood?: FloodEntityState;
  /** Member-level state of a modular building (Phase 17); absent on every other entity. */
  modular?: import('./buildings/modular').ModularRuntime;
  components: RuntimeComponent[];
  visual: VisualState;
  flags: { fallen?: boolean; snapped?: boolean; uprooted?: boolean; overturned?: boolean; collapsed?: boolean; toppled?: boolean; partialCollapse?: number };
  /** Consecutive calm, motionless steps on uneven terrain (see PoseSyncSystem). */
  quietSteps: number;
  /** Position where the current quiet window started (internal). */
  restRef: Vec3;
  /** Horizontal distance moved from the initial position (m). */
  displacement: number;
  /** Bumped on discrete visual changes (component broken, snapped …) so views can update. */
  rev: number;
  /** Obstacle-effect cache while the entity is static (internal). */
  windCache: SampleCache;
  /** Running counters used to aggregate log messages. */
  counters: Record<string, number>;
}

export interface DebrisPiece {
  id: string;
  sourceId: EntityId;
  kind: ComponentSpec['kind'];
  body: BodyHandle;
  size: Vec3;
  color: string;
  mass: number;
  /** Plate-like debris (roof panels, signs) gets aerodynamic lift. */
  plate: boolean;
  pose: Pose;
  spawnTime: number;
  /** Hazard that tore the piece off (impact events inherit it). */
  hazard: Hazard;
  /** Water surface last applied while asleep (flood, internal). */
  lastEta?: number;
  /** ForceLedger record (Phase 15). */
  forces?: Float64Array;
}

/** Short-lived visual particles (glass shards, leaves) — integrated without the physics engine. */
export interface Particle {
  kind: 'glass' | 'leaf';
  position: Vec3;
  velocity: Vec3;
  rotation: Quat;
  spin: Vec3;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  /** Cached local wind (refreshed every few steps — particles are visual only). */
  wind?: [number, number, number];
}

export interface SimulationLogEntry {
  time: number;
  entityId: EntityId | null;
  severity: 'info' | 'warn' | 'danger';
  message: I18nMessage;
}

export interface SimulationRuntime {
  entities: Map<EntityId, RuntimeEntity>;
  debris: DebrisPiece[];
  particles: Particle[];
  /** Simulation time the particle positions correspond to (they update at a lower rate). */
  particlesTime: number;
  /** Bumped when debris is added/removed. */
  debrisRev: number;
  /** Deterministic id counter for debris. */
  debrisCounter: number;
  log: SimulationLogEntry[];
  /** Structural model + bookkeeping of the earthquake systems (lazily created, Phase 13). */
  seismic?: SeismicRuntime;
  /** Flood bookkeeping (lazily created when the water model activates, Phase 14). */
  flood?: FloodRuntime;
}
