/**
 * Modular building data model (Phase 17). Stored on `WorldObject.building` (optional — objects
 * without it are legacy Phase 0–16 buildings). Plain JSON; every length in meters (SI),
 * every angle in radians, masses in kg.
 *
 * The parametric `spec` generates `members`; members are then the source of truth and can be
 * edited one by one (add / move / rotate / remove / duplicate, material, role).
 */
import type { Vec3 } from '@/core/types';
import type { FoundationType, StructuralSystem } from '@/core/model';
import type { MaterialId } from './materials';

export const DESIGN_VERSION = 1 as const;

export type MemberType = 'foundation' | 'column' | 'beam' | 'slab' | 'wall' | 'window' | 'door' | 'roof';
export const MEMBER_TYPES: readonly MemberType[] = ['foundation', 'column', 'beam', 'slab', 'wall', 'window', 'door', 'roof'];

/**
 * What a member does structurally — independent of what it looks like.
 *  - foundation:    carries the building into the ground
 *  - primary:       lateral + gravity system (moment-frame columns, girders)
 *  - secondary:     gravity only (gravity columns, pinned beams, floor slabs)
 *  - bearing:       load-bearing / shear wall (gravity + in-plane lateral)
 *  - nonStructural: interior partition (mass only)
 *  - cladding:      exterior envelope panel (mass, wind / water pressure, no load)
 *  - opening:       window / door (hosted by a wall, never carries load)
 *  - roofing:       roof covering / roof panels (carries its own weight to supports)
 */
export type StructuralRole = 'foundation' | 'primary' | 'secondary' | 'bearing' | 'nonStructural' | 'cladding' | 'opening' | 'roofing';
export const STRUCTURAL_ROLES: readonly StructuralRole[] = ['foundation', 'primary', 'secondary', 'bearing', 'nonStructural', 'cladding', 'opening', 'roofing'];

/** Roles a member type may take (the editor only offers these). */
export const ROLES_BY_TYPE: Record<MemberType, readonly StructuralRole[]> = {
  foundation: ['foundation'],
  column: ['primary', 'secondary'],
  beam: ['primary', 'secondary'],
  slab: ['secondary'],
  wall: ['bearing', 'nonStructural', 'cladding'],
  window: ['opening'],
  door: ['opening'],
  roof: ['roofing'],
};

export type Facade = 'n' | 's' | 'e' | 'w';

export interface BuildingMember {
  /** Unique inside the building (the global id is `${objectId}/${id}`). */
  id: string;
  type: MemberType;
  role: StructuralRole;
  /** Story index: −1 foundation, 0 … floors−1, `floors` = roof level. */
  level: number;
  /** Box center in building-local space (origin = ground-floor level, footprint center). */
  position: Vec3;
  /** Euler XYZ (rad). Structural members use the yaw (Y) only; roof panels may pitch (X). */
  rotation: Vec3;
  /** Box size before rotation (m): x = length, y = height, z = thickness / depth. */
  size: Vec3;
  material: MaterialId;
  /** Windows / doors: the wall they sit in. */
  host?: string;
  /** Envelope members: the facade they face (outward normal). */
  facade?: Facade;
  /** Pre-existing damage 0–1 (part of the ORIGINAL world, restored on reset). */
  initialDamage?: number;
}

export type RoofType = 'flat' | 'gable' | 'shed';
export const ROOF_TYPES: readonly RoofType[] = ['flat', 'gable', 'shed'];
export type FacadeStyle = 'punched' | 'ribbon' | 'curtain';
export const FACADE_STYLES: readonly FacadeStyle[] = ['punched', 'ribbon', 'curtain'];
export type Occupancy = 'residential' | 'office' | 'storage' | 'industrial';
export const OCCUPANCIES: readonly Occupancy[] = ['residential', 'office', 'storage', 'industrial'];

/** Parametric inputs (SI units). */
export interface BuildingSpec {
  /** Footprint along local x / z (m). */
  width: number;
  depth: number;
  floors: number;
  /** Typical story height (m) and the ground story height (m; taller = soft-story experiments). */
  floorHeight: number;
  groundFloorHeight: number;
  roof: RoofType;
  /** Roof pitch (deg) for gable / shed roofs. */
  roofPitch: number;
  /** Lateral system — selects the member layout (frame vs bearing walls). */
  system: StructuralSystem;
  /** Material of the primary structure (columns, beams, bearing walls). */
  structureMaterial: MaterialId;
  /** Floor slab material. */
  slabMaterial: MaterialId;
  /** Exterior wall / infill material. */
  claddingMaterial: MaterialId;
  facade: FacadeStyle;
  /** Fraction of each facade bay that is glazed (0–0.9). */
  windowDensity: number;
  foundation: FoundationType;
  /** Target column spacing (m); the grid uses whole bays. */
  bay: number;
  /** RC shear-wall core in the middle of the plan. */
  core: boolean;
  /** Top story has a ceiling slab under a pitched roof (false: roof on the beams — halls). */
  ceiling: boolean;
  /** Superimposed mass on floors (contents, finishes) — see OCCUPANCY_MASS. */
  occupancy: Occupancy;
  /** Facade tint. */
  color: string;
  /** Legacy extras kept for parity with Phase 0–16 buildings. */
  sign: boolean;
  rooftopUnits: number;
}

/** Superimposed floor mass (kg/m²): finishes + seismic share of contents (approximate). */
export const OCCUPANCY_MASS: Record<Occupancy, number> = { residential: 150, office: 200, storage: 450, industrial: 300 };
/** Roof superimposed mass (kg/m²). */
export const ROOF_SUPERIMPOSED = 50;

/**
 * What happens to the building when the terrain under it is edited:
 *  - refit:    it follows the ground (floor on the highest footprint point, foundation plinth
 *              regrown down to the lowest point) — Phase 13–16 behavior
 *  - preserve: it keeps its world transform; the foundation keeps its designed depth, so new
 *              gaps under it show up as unsupported area (and buried parts as embedment)
 */
export type FoundationPolicy = 'refit' | 'preserve';

export interface DesignOptions {
  foundationPolicy: FoundationPolicy;
  /**
   * Keep members even though they have no load path (warning instead of refusing) — for
   * deliberately unrealistic experiments. Unsupported members still fall in a simulation.
   */
  allowUnsupported: boolean;
  /** Plinth bottom below the floor (m) frozen by the 'preserve' policy; null = from terrain. */
  plinthDepth: number | null;
}

export interface BuildingDesign {
  version: typeof DESIGN_VERSION;
  spec: BuildingSpec;
  members: BuildingMember[];
  options: DesignOptions;
  /** Manual member edits since the members were last generated from `spec`. */
  edits: number;
  /** Preset the spec came from (informational). */
  preset?: string;
  /** Converted from a legacy building (informational). */
  convertedFrom?: 'legacy';
}

export function defaultOptions(): DesignOptions {
  return { foundationPolicy: 'refit', allowUnsupported: false, plinthDepth: null };
}

/** Global member id (unique in the world). */
export function memberUid(objectId: string, memberId: string): string {
  return `${objectId}/${memberId}`;
}

export const isStructuralRole = (r: StructuralRole) => r === 'primary' || r === 'secondary' || r === 'bearing' || r === 'foundation';
/** Members that resist lateral load (story stiffness / strength). */
export const isLateralRole = (r: StructuralRole) => r === 'primary' || r === 'bearing';
