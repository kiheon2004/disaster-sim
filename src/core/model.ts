/**
 * Serializable data model shared by every layer (World, Objects, Simulation, Physics).
 * Everything here must stay plain JSON-compatible data — except the terrain grids, which are
 * typed arrays in memory and go through the terrain codec (src/terrain/terrainCodec.ts) on save.
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

/** Ground type ids (index into the GroundMaterialRegistry; stored as bytes). */
export type GroundTypeId = 0 | 1 | 2 | 3 | 4;

export type TerrainPresetId = 'flat' | 'gentleHills' | 'valley' | 'coastal';

export interface TerrainSettings {
  /** Preset the terrain was last generated from (informational; edits come on top). */
  preset: TerrainPresetId;
  /** Seed of that preset (same preset + seed → same terrain). */
  seed: number;
  /**
   * Static reference water surface (m), e.g. sea level for the coastal preset. Nothing flows —
   * it only marks where the ground is under water (flood systems will start from here).
   */
  waterLevel: number | null;
}

/**
 * Terrain = regular heightfield over the buildable area, with per-vertex layers.
 * Vertex (ix, iz) sits at (originX + ix·cellSize, originZ + iz·cellSize); arrays are row-major
 * (index = iz·nx + ix). Each grid cell is split into two triangles along its (x1,z0)–(x0,z1)
 * diagonal — the same triangulation the renderer and the physics collider use.
 *
 * Future layers (soil strength, permeability, moisture, seismic amplification …) are added as
 * further optional per-vertex typed arrays next to `ground`, each with its own codec entry.
 */
export interface TerrainData {
  kind: 'heightfield';
  nx: number;
  nz: number;
  cellSize: number;
  originX: number;
  originZ: number;
  /** Elevation per vertex (m), quantized to 1 cm so save/load is exact. */
  heights: Float32Array;
  /** Ground type per vertex (GroundTypeId). */
  ground: Uint8Array;
  settings: TerrainSettings;
  /** Bumped on every in-place change; renderers and caches compare it. Not saved. */
  revision: number;
}

export interface WorldDocument {
  schemaVersion: 2;
  meta: { name: string; createdAt: string; updatedAt: string };
  settings: WorldSettings;
  terrain: TerrainData;
  objects: Record<EntityId, WorldObject>;
}
