/**
 * Unified Blueprint (Phase 20): one self-contained, JSON-serializable value that can hold
 * buildings, objects, vegetation, a road sub-network, natural features and terrain layers of a
 * part of a world, in a LOCAL coordinate frame, with LOCAL ids.
 *
 * Local frame
 *   origin  = the anchor: centre of the captured area (x, z, snapped to a terrain vertex) at the
 *             DATUM height
 *   datum   = the mean pre-feature ground (base terrain + user sculpt) along the area's boundary
 *             in the source — the level the surroundings meet, so applied ground keeps its hills
 *             and hollows relative to the place it is put
 *   axes    = world axes of the source (+x east, +z south, +y up); placement turns the frame
 *             by a yaw about +y: world = T + R(yaw)·local with R(θ)(u, v) = (u·cosθ + v·sinθ,
 *             −u·sinθ + v·cosθ) — the convention of every Phase 16–18 rotation
 *   heights = every absolute elevation (lake surfaces, fixed road elevations, terrain surface
 *             grid) is stored RELATIVE to the datum; object heights are "above the ground
 *             under them" (0 for objects standing on the ground)
 *
 * Ids
 *   Every id inside a blueprint is local and has its own namespace: objects o<k>, vegetation
 *   v<k>, designs d<k>, road nodes n<k>, road segments s<k>, natural features r<k>, editing
 *   groups g<k>. They never appear in a world: placement maps each of them to a fresh world id
 *   (world object ids from createId, road n/s ids and feature f ids from the destination
 *   document's counters), so the same blueprint can be placed any number of times, in any world.
 *
 * Nothing dynamic is stored: no water depth / velocity, no damage, no simulation state. Rivers
 * and lakes carry their INITIAL water configuration (fill, inflow, filled), separable from the
 * channel / basin shape at capture and at placement.
 */
import type { ObjectType, Vec3 } from '@/core/types';
import type { ObjectParams, PhysicalProperties, SeismicProperties } from '@/core/model';
import type { BuildingDesign } from '@/buildings/types';
import type { LinkPolicy, RoadProfile, ZoneType } from '@/roads/types';
import type { Feature, P2 } from '@/landscape/types';
import type { VehicleCar } from '@/vehicle/settings';

export const BLUEPRINT_FORMAT = 'disaster-sim/blueprint';
/** Current blueprint format version (1 = Phase 16–18 copy / paste payload). */
export const BLUEPRINT_VERSION = 2;
/** Oldest reader version that can read what this version writes (forward compatibility). */
export const MIN_READER_VERSION = 2;

export type BlueprintCategory =
  | 'buildings' | 'residential' | 'commercial' | 'industrial' | 'infrastructure' | 'roads' | 'nature' | 'mixed';
export const BLUEPRINT_CATEGORIES: readonly BlueprintCategory[] = ['buildings', 'residential', 'commercial', 'industrial', 'infrastructure', 'roads', 'nature', 'mixed'];

export interface BlueprintMeta {
  name: string;
  description: string;
  category: BlueprintCategory;
  tags: string[];
  /** Optional author metadata (free text, never sent anywhere). */
  author?: string;
  createdAt: string;
  updatedAt: string;
}

/** An object relative to the anchor. */
export interface BlueprintItem {
  /** Local id (o<k> objects, v<k> vegetation). */
  id: string;
  type: ObjectType;
  name: string;
  seed: number;
  /** Absent for modular buildings (derived from the design) — always present otherwise. */
  params?: ObjectParams;
  /**
   * Physical properties. Absent = the definition's defaults for the params (or the design's
   * derived values) — only customized values cost space.
   */
  physics?: Partial<PhysicalProperties>;
  seismic?: SeismicProperties;
  /** x, z relative to the anchor (local frame); y = height above the ground under the object. */
  offset: Vec3;
  /** Euler XYZ as placed in the source (yaw relative to the local frame). */
  rotation: Vec3;
  scale: Vec3;
  /** Stood on the ground in the source → re-seated on the destination ground. */
  grounded: boolean;
  /** Ground height under the object in the source relative to the datum (preview / rigid placement). */
  base: number;
  /** Local editing group key (g<k>). */
  group?: string;
  /** Modular building design: key into `designs` (Phase 17 designs are shared, not copied per object). */
  design?: string;
  terrainAlign?: number;
}

export interface BlueprintRoadNode {
  id: string;
  x: number;
  z: number;
  /** Fixed road elevation relative to the datum, or null (terrain). */
  y: number | null;
}

export interface BlueprintRoadSegment {
  id: string;
  a: string;
  b: string;
  control: P2[];
  profile: RoadProfile;
  condition?: number;
}

export interface BlueprintRoads {
  nodes: BlueprintRoadNode[];
  segments: BlueprintRoadSegment[];
  /** Block types of enclosed blocks whose every segment is in the blueprint (sorted local segment ids). */
  zones: { segments: string[]; zone: ZoneType }[];
}

/** An object linked to a blueprint road (Phase 18 RoadLink with local references). */
export interface BlueprintAttachment {
  object: string;
  segment: string;
  t: number;
  lateral: number;
  yaw: number;
  policy: LinkPolicy;
}

/**
 * Per-vertex terrain layers of the captured area, on a local axis-aligned grid. Encoded with the
 * terrain codecs (heights: cm deltas + RLE; bytes: RLE).
 */
export interface BlueprintTerrain {
  /** Local position of vertex (0, 0), vertex counts and spacing (m). */
  grid: { x0: number; z0: number; nx: number; nz: number; cell: number };
  /**
   * Pre-feature ground (base + sculpt) − datum, every vertex (m). Null in blueprints migrated from
   * Phase 19 nature regions (they carried only sculpt / paint): "apply / blend" are unavailable.
   */
  surface: string | null;
  /** User sculpt Δh (m) or null when none. */
  sculpt: string | null;
  /** User paint (ground type, 255 = none) or null when none. */
  paint: string | null;
  /** Base ground type of the source (what the surface is made of without paint); null = unknown. */
  ground: string | null;
  /** Soil profile (Phase 13) per vertex; null = unknown (destination soil kept). */
  soil: string | null;
  /** 1 = inside the selection (polygon selections); null = the whole grid. */
  mask: string | null;
}

export type DependencyKind =
  | 'roadExternal' // a captured road continued outside the area (cut or connected outside)
  | 'roadPartial' // a road partly inside the area was left out ('inside' policy)
  | 'riverInflowOutside' // a river's upstream part lies outside the area (cut)
  | 'riverOutletOutside' // a river's downstream part lies outside the area (cut)
  | 'riverPartial' // a river partly inside was left out
  | 'lakePartial' // a lake partly inside the area (whole lake kept / left out)
  | 'landformPartial' // a landform partly inside (kept whole / left out)
  | 'coastExcluded' // coastlines are map-scale and never captured
  | 'foundationSupport' // a building's foundation reaches outside the captured terrain
  | 'sharedDesign' // designs shared with objects outside the blueprint (copied)
  | 'externalLink' // an object linked to a road that is not in the blueprint (link dropped)
  | 'groupPartial' // an editing group only partly inside (the captured part forms a new group)
  | 'objectCrossesBoundary' // an object's footprint crosses the area boundary
  | 'seaLevel'; // the captured terrain lies below the source's sea level (reference water)

export interface BlueprintDependency {
  kind: DependencyKind;
  /** Local ids concerned (when they are in the blueprint). */
  refs: string[];
  /** How it was resolved at capture. */
  resolution: 'kept' | 'clipped' | 'dropped' | 'detached' | 'copied' | 'info';
  /** Optional number for messages (count, metres …). */
  value?: number;
}

export interface BlueprintPreview {
  /** Footprint of the captured area (m, local x / z extents). */
  size: [number, number];
  /** Local bounds [x0, z0, x1, z1] of everything in the blueprint. */
  bounds: [number, number, number, number];
  /** Terrain relief inside (min / max surface relative to the datum, m). */
  relief: [number, number];
  counts: { objects: number; buildings: number; vegetation: number; roads: number; features: number; water: number };
  /** Small rendered picture (data:image/png|jpeg|webp;base64 …) or null. */
  thumbnail: string | null;
}

export interface UnifiedBlueprint {
  format: typeof BLUEPRINT_FORMAT;
  version: typeof BLUEPRINT_VERSION;
  minReaderVersion: number;
  /** Library id (bp_…): identity of the blueprint itself, never a world id. */
  id: string;
  meta: BlueprintMeta;
  origin: {
    /** Source absolute elevation of the datum (m) — used by "absolute height" placement. */
    datum: number;
    /** Sea level of the source world (reference water) or null. */
    seaLevel: number | null;
  };
  /** Selection shape in the local frame (rectangle = 4 points). */
  area: P2[];
  objects: BlueprintItem[];
  vegetation: BlueprintItem[];
  designs: Record<string, BuildingDesign>;
  roads: BlueprintRoads;
  attachments: BlueprintAttachment[];
  features: Feature[];
  terrain: BlueprintTerrain | null;
  dependencies: BlueprintDependency[];
  preview: BlueprintPreview;
  /**
   * Phase 37: the simulation settings of the captured cars (`settings.simulation.vehicles.cars` of the source), keyed
   * by the car's LOCAL object id (o<k>); an occupant's `human` is the local id of that person (occupants whose person
   * was not captured are not here). Absent when no captured car had settings — such a blueprint serializes and hashes
   * exactly as before. Optional top-level field: a reader from before Phase 37 keeps it as unsupported data and writes
   * it back. Placement writes the entries under the new world ids in the same undo step (world/stamp.ts).
   */
  cars?: Record<string, VehicleCar>;
  /**
   * Forward compatibility: top-level fields this version does not understand (from a newer
   * writer) and entries it cannot use (objects of unknown types, unknown feature kinds). Kept
   * verbatim so exporting writes them back; never interpreted.
   */
  unsupported?: UnsupportedData;
}

/**
 * Data a reader of this version keeps but does not use (see docs/BLUEPRINTS.md "Versioning"):
 * unknown top-level fields, entries of unknown kinds, and unknown fields of known entries (by
 * local id). Serialization writes all of it back in place.
 */
export interface UnsupportedData {
  fields?: Record<string, unknown>;
  objects?: unknown[];
  features?: unknown[];
  /** Attachments of objects this version could not read. */
  attachments?: unknown[];
  /** Unknown fields of known entries: local id → { field: value }. */
  entryFields?: Record<string, Record<string, unknown>>;
}

/** Which parts of a selection go into a blueprint (capture dialog toggles). */
export interface CaptureInclude {
  buildings: boolean;
  objects: boolean;
  vegetation: boolean;
  roads: boolean;
  landforms: boolean;
  water: boolean;
  /** Initial water of rivers / lakes (fill, inflow, filled) — separate from the channel shape. */
  waterState: boolean;
  terrain: boolean;
}

export const ALL_INCLUDED: CaptureInclude = { buildings: true, objects: true, vegetation: true, roads: true, landforms: true, water: true, waterState: true, terrain: true };

/**
 * What happens to things only partly inside the area:
 *  - whole:  kept whole (the blueprint grows past the area; reported)
 *  - inside: left out unless completely inside (reported)
 *  - clip:   roads / rivers / line landforms are cut at the boundary (cut ends become
 *            dependencies); lakes and peaks cannot be cut and are kept whole
 */
export type BoundaryPolicy = 'whole' | 'inside' | 'clip';
