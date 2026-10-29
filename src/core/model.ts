/**
 * Serializable data model shared by every layer (World, Objects, Simulation, Physics).
 * Everything here must stay plain JSON-compatible data — except the terrain grids, which are
 * typed arrays in memory and go through the terrain codec (src/terrain/terrainCodec.ts) on save.
 */
import type { EntityId, ObjectType, Transform, Vec3 } from './types';
import type { EarthquakeEventSpec, RainEventSpec, RisingWaterEventSpec, WaterSourceEventSpec } from '@/events/specs';
import type { ExperimentSettings } from '@/phenomena/types';

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
  | 'canopy'
  // Phase 17 modular buildings: doors and non-structural envelope panels.
  | 'door'
  | 'cladding';

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
  /** Euler XYZ rotation of the part box (pitched roof panels, Phase 17). Absent = axis-aligned. */
  rotation?: Vec3;
  /** Material id of the part (Phase 17 modular buildings; capacities and look). */
  material?: string;
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
  /**
   * Earthquake properties (Phase 13): structural system + foundation. Present on buildings;
   * other objects use type defaults. Missing in older files → filled in on load.
   */
  seismic?: SeismicProperties;
  /**
   * Editing group (Phase 16): objects sharing this id are selected and transformed together.
   * A logical editor structure only — every object keeps its own physics body. Absent = none.
   */
  group?: string;
  /**
   * Modular building design (Phase 17): members, parametric spec, foundation policy. Absent on
   * legacy buildings (Phase 0–16 behavior). params / physics / seismic / components of a
   * modular building are DERIVED from it (src/buildings/design.ts) and kept in sync.
   */
  building?: import('@/buildings/types').BuildingDesign;
  /**
   * Slope alignment chosen at placement (0 = level … 1 = ground plane). Absent = the type's
   * rule. Kept so re-seating after terrain edits / moves keeps the chosen tilt (Phase 17 fix
   * of the Phase 16 known issue).
   */
  terrainAlign?: number;
  /**
   * Link to a road (Phase 18): where the object sits relative to a road segment and whether it
   * follows road edits (src/roads/links.ts). Absent = not linked.
   */
  roadLink?: import('@/roads/types').RoadLink;
}

// ── Earthquake: structure & foundation (approximate model parameters) ─────────

/** Lateral structural system — selects period formula, strength and drift capacities. */
export type StructuralSystem = 'rcFrame' | 'steelFrame' | 'masonry' | 'wood';

export interface StructuralSpec {
  system: StructuralSystem;
  /** Viscous damping ratio of the first mode (0.01–0.2). */
  dampingRatio: number;
  /** Multiplier on lateral stiffness (period ∝ 1/√k). */
  stiffnessFactor: number;
  /** Multiplier on lateral yield strength. */
  strengthFactor: number;
  /** Fundamental period override (s); 0 = estimated from height and system. */
  periodOverride: number;
}

export type FoundationType = 'spread' | 'mat' | 'pile';

export interface FoundationSpec {
  type: FoundationType;
  /** Multiplier on the soil-derived horizontal foundation stiffness. */
  stiffness: number;
  /** Foundation (radiation + material) damping ratio; 0 = from the soil profile. */
  damping: number;
  /** Lateral resistance before the foundation slips, as a fraction of the building weight. */
  anchorage: number;
  /** Fraction of the footprint bearing on the ground (0.2–1). */
  groundContact: number;
  /** Residual tilt (degrees) at which the foundation counts as failed. */
  failureThreshold: number;
}

export interface SeismicProperties {
  structure: StructuralSpec;
  foundation: FoundationSpec;
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
  /** Flood / water model settings (Phase 14). Missing in older files → defaults. */
  water: WaterSettings;
  /**
   * Multi-hazard interaction models (Phase 15, docs/PHENOMENA.md §6–7): wind stress on water,
   * ground shaking on water, wind on the emerged part of floating bodies, residual strength
   * after damage by another hazard, saturated-ground bearing, wind load inside the earthquake
   * structural model. Off = hazards act independently (Phase 13–14 behavior, bit-identical).
   * New projects: on. Projects saved before schema v5: off (their results stay reproducible).
   */
  interactions: { enabled: boolean };
  /**
   * Vegetation responses (Phase 19, simulation/vegetation): canopy shelter of trees inside a
   * forest and tree toppling by flood flow. Absent / off = Phase 18 behavior (bit-identical).
   */
  vegetation?: { canopyShelter: boolean; floodResponse: boolean };
  /**
   * Thermal physics (Phase 26): ambient (reference) air temperature K, height of the resolved air
   * layer, axial restraint mode of heated members. Absent = defaults (15 °C, 10 m, frame); only read
   * when a heat source runs — runs without one are unchanged.
   */
  thermal?: import('@/thermal/ThermalWorld').ThermalSettings;
}

// ── Flood: water model settings (Phase 14, approximate model parameters) ─────

/** Map edges, named like compass points (north = −Z, east = +X). */
export type BoundarySide = 'N' | 'S' | 'E' | 'W';
export const BOUNDARY_SIDES: readonly BoundarySide[] = ['N', 'E', 'S', 'W'];

/**
 * What water does at a map edge:
 *  - auto:       fixedLevel at the terrain's reference water level when part of the edge lies
 *                below it (sea / river connected to the outside), otherwise open
 *  - closed:     a wall — nothing flows in or out (mass is conserved exactly)
 *  - open:       free outflow, as if the terrain continued with the same slope; never inflow
 *  - fixedLevel: an outside water body with a fixed surface elevation `level` (in and out)
 */
export type WaterBoundaryType = 'auto' | 'closed' | 'open' | 'fixedLevel';

export interface WaterBoundarySpec {
  type: WaterBoundaryType;
  /** Water SURFACE elevation (m, same datum as terrain heights) for fixedLevel; default = reference level ?? 0. */
  level?: number;
}

export interface WaterSettings {
  boundaries: Record<BoundarySide, WaterBoundarySpec>;
  /** Infiltration into the ground (rate from the ground type's permeability). */
  infiltration: boolean;
  /** Multiplier on every ground type's infiltration capacity. */
  infiltrationScale: number;
  /** Storm-drain removal capacity on paved surfaces (asphalt, concrete, road objects), mm/h. 0 = none. */
  drainageCapacity: number;
  /** Multiplier on every ground type's Manning roughness. */
  roughnessScale: number;
  /** At flood start, fill ground below the reference level that is connected to a fixed-level edge. */
  initialFromReference: boolean;
}

export function defaultWaterSettings(): WaterSettings {
  return {
    boundaries: { N: { type: 'auto' }, E: { type: 'auto' }, S: { type: 'auto' }, W: { type: 'auto' } },
    infiltration: true,
    infiltrationScale: 1,
    drainageCapacity: 30,
    roughnessScale: 1,
    initialFromReference: true,
  };
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
  return { seed: 1234, wind: { ...DEFAULT_WIND_MODEL }, water: defaultWaterSettings(), interactions: { enabled: true } };
}

export interface WorldSettings {
  /** [x, z] size in meters */
  size: [number, number];
  gravity: number;
  airDensity: number;
  simulation: SimulationSettings;
}

/** Ground type ids (index into the GroundMaterialRegistry; stored as bytes). */
/** 5 = gravel (Phase 18, road material). */
export type GroundTypeId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Soil profile ids (index into the SoilProfileRegistry; stored as bytes). Independent of the surface. */
export type SoilProfileId = 0 | 1 | 2 | 3;

export type TerrainPresetId = 'flat' | 'gentleHills' | 'valley' | 'coastal' | 'lowland';

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
 * Further layers (permeability map, moisture …) are added as per-vertex typed arrays next to
 * `ground` and `soil`, each with its own codec entry.
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
  /** Surface material per vertex (GroundTypeId) — what you walk on (grass, asphalt …). */
  ground: Uint8Array;
  /** Soil profile per vertex (SoilProfileId) — what lies beneath (rock, soft soil …). Phase 13. */
  soil: Uint8Array;
  settings: TerrainSettings;
  /** Bumped on every in-place change; renderers and caches compare it. Not saved. */
  revision: number;
}

/**
 * Configured flood events (Phase 14). Each entry is null / empty when not used; `enabled`
 * lists which of them the flood form's Run button starts together.
 */
export interface FloodScenario {
  rain: RainEventSpec | null;
  risingWater: RisingWaterEventSpec | null;
  sources: WaterSourceEventSpec[];
  enabled: { rain: boolean; risingWater: boolean; sources: boolean };
}

export function defaultFloodScenario(): FloodScenario {
  return { rain: null, risingWater: null, sources: [], enabled: { rain: true, risingWater: false, sources: false } };
}

/** Hazard scenarios saved with the project (Phase 13, flood Phase 14). */
export interface ScenarioSettings {
  /** The configured earthquake (run from the earthquake form / commands), or none. */
  earthquake: EarthquakeEventSpec | null;
  flood: FloodScenario;
  /** Multi-phenomenon experiment plan (Phase 15). */
  experiment: ExperimentSettings;
}

export interface WorldDocument {
  schemaVersion: 7;
  meta: { name: string; createdAt: string; updatedAt: string };
  settings: WorldSettings;
  terrain: TerrainData;
  objects: Record<EntityId, WorldObject>;
  scenario: ScenarioSettings;
  /**
   * Road network (Phase 18). Baked into `terrain` (heights + ground types); `roads.underlay`
   * keeps the natural terrain values under the roads so edits can restore them.
   */
  roads: import('@/roads/types').RoadNetwork;
  /**
   * Non-destructive terrain layers (Phase 19): base terrain, user sculpt / paint, natural
   * features. `terrain` = roads baked on the composition of these layers (landscape/types.ts).
   */
  landscape: import('@/landscape/types').Landscape;
}
