/**
 * Serializable data model shared by every layer (World, Objects, Simulation, Physics).
 * Everything here must stay plain JSON-compatible data.
 */
import type { EntityId, ObjectType, Transform, Vec3 } from './types';

export interface PhysicalProperties {
  /** kg */
  mass: number;
  /** Coulomb friction coefficient (0–1.5). */
  friction: number;
  /** Bounciness (0–1). */
  restitution: number;
  /** Fixed in place until it fails (trees, buildings). */
  anchored: boolean;
  /** Aerodynamic drag coefficient Cd. */
  dragCoefficient: number;
  /** Design wind speed in m/s — at this effective speed the load ratio is 1.0. */
  windResistance: number;
  /** 0–100. Higher = withstands overload for longer (fatigue). */
  durability: number;
  /** Load ratio above which failure is immediate (e.g. 1.5 = 150 % of design load). */
  breakThreshold: number;
  /** Optional manual frontal area override (m²). */
  frontalAreaOverride?: number;
}

export type ComponentKind =
  | 'structure'
  | 'roof'
  | 'window'
  | 'wall'
  | 'sign'
  | 'exterior'
  | 'trunk'
  | 'canopy';

export interface ComponentSpec {
  id: string;
  kind: ComponentKind;
  /** Center position relative to the object origin (unscaled, object local space). */
  position: Vec3;
  /** Full size of the component's bounding box (m). */
  size: Vec3;
  /** Outward facing normal in local space (facade elements); null = omnidirectional. */
  normal: Vec3 | null;
  mass: number;
  windResistance: number;
  durability: number;
  /** Becomes a flying piece of debris when it fails. */
  detachable: boolean;
  /** Display color hint for renderers/debris. */
  color?: string;
}

export type ParamValue = number | string | boolean;
export type ObjectParams = Record<string, ParamValue>;

export interface WorldObject {
  id: EntityId;
  type: ObjectType;
  /** User-given name. Empty → a localized default (“건물 3”) is displayed. */
  name: string;
  /** Running number per type, used for default names. */
  serial: number;
  /** Seed for deterministic procedural variation. */
  seed: number;
  transform: Transform;
  physics: PhysicalProperties;
  params: ObjectParams;
  /** Generated from params by the object definition; kept in the document for transparency. */
  components: ComponentSpec[];
}

/**
 * Parameters of the approximate spatial wind model (not a CFD solver).
 * Distances are expressed in multiples of the obstacle height H.
 */
export interface WindModelSettings {
  /** Enable building wind shadows and corner effects. */
  shelterEnabled: boolean;
  /** Fractional speed deficit directly behind an obstacle (0–0.9). */
  shadowStrength: number;
  /** Wake extent downstream, × H. */
  wakeLength: number;
  /** e-folding recovery distance of the deficit, × H. */
  wakeRecovery: number;
  /** Lateral widening of the wake per meter downstream. */
  wakeSpread: number;
  /** Extra speed along building sides/corners (0.18 = +18 %). */
  cornerSpeedup: number;
  /** Turbulence intensity inside wakes and at corners (0–1). */
  turbulence: number;
}

export interface SimulationSettings {
  /** Seed for every random draw in the simulation core (reproducibility). */
  seed: number;
  wind: WindModelSettings;
}

export const DEFAULT_WIND_MODEL: WindModelSettings = {
  shelterEnabled: true,
  shadowStrength: 0.55,
  wakeLength: 8,
  wakeRecovery: 2.5,
  wakeSpread: 0.12,
  cornerSpeedup: 0.18,
  turbulence: 0.35,
};

export function defaultSimulationSettings(): SimulationSettings {
  return { seed: 1234, wind: { ...DEFAULT_WIND_MODEL } };
}

export interface WorldSettings {
  /** [x, z] size in meters */
  size: [number, number];
  gravity: number;
  airDensity: number;
  simulation: SimulationSettings;
}

export interface TerrainData {
  kind: 'flat';
}

export interface WorldDocument {
  schemaVersion: 1;
  meta: { name: string; createdAt: string; updatedAt: string };
  settings: WorldSettings;
  terrain: TerrainData;
  objects: Record<EntityId, WorldObject>;
}
