import type { EntityId, Quat, Vec3 } from '@/core/types';
import type { ComponentSpec, WorldObject } from '@/core/model';
import type { ObjectDefinition, PhysicsProfile } from '@/objects/ObjectDefinition';
import type { I18nMessage } from '@/i18n/i18n';
import type { BodyHandle, Pose } from '@/physics/PhysicsEngine';
import type { DamageState } from './damage/DamageState';

export type ComponentCondition = 'intact' | 'broken' | 'detached';

export interface RuntimeComponent {
  spec: Readonly<ComponentSpec>;
  state: DamageState;
  /** 1 → 0 */
  health: number;
  condition: ComponentCondition;
  loadRatio: number;
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
  state: DamageState;
  health: number;
  loadRatio: number;
  peakLoadRatio: number;
  /** Effective wind speed at the center of pressure (m/s). */
  windAtCop: number;
  components: RuntimeComponent[];
  visual: VisualState;
  flags: { fallen?: boolean; snapped?: boolean; uprooted?: boolean; overturned?: boolean; collapsed?: boolean; toppled?: boolean };
  /** Horizontal distance moved from the initial position (m). */
  displacement: number;
  /** Bumped on discrete visual changes (component broken, snapped …) so views can update. */
  rev: number;
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
  /** Bumped when debris is added/removed. */
  debrisRev: number;
  log: SimulationLogEntry[];
}
