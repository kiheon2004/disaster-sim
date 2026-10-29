/**
 * Road network data model (Phase 18). Plain JSON, SI units (m, rad), stored as `doc.roads`.
 *
 *  RoadNode      a point of the network (end, bend, junction); optional fixed elevation
 *  RoadSegment   a road between two nodes, straight or curved through control points, with a
 *                RoadProfile (width, lanes, direction, material, sidewalks, elevation policy,
 *                drainage). Its length / geometry / slopes are derived.
 *  intersections nodes where ≥ 3 segments meet — derived (surface polygon, trims, crosswalks)
 *  attachments   drainage inlets (derived from the profile) and world objects linked to a
 *                segment through `WorldObject.roadLink` (lamps, signs, buildings, vehicles …)
 *  zones         block type chosen for an enclosed city block (key = its sorted segment ids)
 *  underlay      natural terrain values under road-covered vertices (restored when a road
 *                moves away — the road itself is baked into the terrain layers)
 *
 * Every edit returns a NEW network (immutable values, shared structure).
 */
export type RoadMaterial = 'asphalt' | 'concrete' | 'gravel' | 'dirt';
export const ROAD_MATERIALS: readonly RoadMaterial[] = ['asphalt', 'concrete', 'gravel', 'dirt'];

export type ElevationPolicy = 'follow' | 'graded' | 'fixed';
export const ELEVATION_POLICIES: readonly ElevationPolicy[] = ['follow', 'graded', 'fixed'];

export type SidewalkSide = 'both' | 'left' | 'right' | 'none';
export const SIDEWALK_SIDES: readonly SidewalkSide[] = ['both', 'left', 'right', 'none'];

export type Drainage = 'none' | 'standard' | 'enhanced';
export const DRAINAGE_LEVELS: readonly Drainage[] = ['none', 'standard', 'enhanced'];

export interface RoadProfile {
  /** Carriageway width (m, curb to curb). */
  width: number;
  lanes: number;
  /** Traffic only from node a to node b. */
  oneWay: boolean;
  material: RoadMaterial;
  sidewalk: SidewalkSide;
  /** Sidewalk width (m). */
  sidewalkWidth: number;
  /** Curb height above the carriageway (m). */
  curbHeight: number;
  elevation: ElevationPolicy;
  /** Storm-drain inlets along the curbs (spacing by level). */
  drainage: Drainage;
  markings: boolean;
}

export interface RoadNode {
  id: string;
  x: number;
  z: number;
  /** Fixed elevation of the road surface at this node (m) — 'fixed' segments; null = terrain. */
  y: number | null;
}

export interface RoadSegment {
  id: string;
  a: string;
  b: string;
  /** Interior control points (x, z) between a and b; empty = straight. */
  control: [number, number][];
  profile: RoadProfile;
  /** Pre-existing surface damage 0–1 (part of the original world). */
  condition?: number;
}

export type ZoneType = 'residential' | 'commercial' | 'industrial' | 'park' | 'mixed';
export const ZONE_TYPES: readonly ZoneType[] = ['residential', 'commercial', 'industrial', 'park', 'mixed'];

/** Natural terrain under road-covered vertices: vertex index, height (m), ground type. */
export interface Underlay {
  idx: number[];
  h: number[];
  g: number[];
}

export interface RoadNetwork {
  version: 1;
  nodes: Record<string, RoadNode>;
  segments: Record<string, RoadSegment>;
  zones: Record<string, ZoneType>;
  underlay: Underlay;
  /** Next id number (n<k>, s<k>) — deterministic ids within a document. */
  next: number;
}

/**
 * Link of a world object to a road (WorldObject.roadLink). What happens when the road changes:
 *  - follow:   the object keeps its place relative to the road (moves with it)
 *  - preserve: it stays where it is in the world (the link is kept for information)
 *  - detach:   the link is dropped at the next road edit; the object stays
 */
export type LinkPolicy = 'follow' | 'preserve' | 'detach';
export const LINK_POLICIES: readonly LinkPolicy[] = ['follow', 'preserve', 'detach'];

export interface RoadLink {
  segment: string;
  /** Position along the centerline, 0 (node a) … 1 (node b). */
  t: number;
  /** Signed distance from the centerline (m, + = right side looking from a to b). */
  lateral: number;
  /** Heading relative to the road direction at t (rad). */
  yaw: number;
  policy: LinkPolicy;
}

export function emptyNetwork(): RoadNetwork {
  return { version: 1, nodes: {}, segments: {}, zones: {}, underlay: { idx: [], h: [], g: [] }, next: 1 };
}

export function defaultProfile(): RoadProfile {
  return { width: 7, lanes: 2, oneWay: false, material: 'asphalt', sidewalk: 'both', sidewalkWidth: 2, curbHeight: 0.15, elevation: 'graded', drainage: 'standard', markings: true };
}

/** Named profiles offered by the road tool (all fields stay editable). */
export const PROFILE_PRESETS: Record<string, Partial<RoadProfile>> = {
  street: { width: 7, lanes: 2, sidewalk: 'both', sidewalkWidth: 2, material: 'asphalt', drainage: 'standard' },
  avenue: { width: 14, lanes: 4, sidewalk: 'both', sidewalkWidth: 3, material: 'asphalt', drainage: 'enhanced' },
  lane: { width: 4.5, lanes: 1, sidewalk: 'none', material: 'concrete', drainage: 'none', markings: false },
  gravel: { width: 4, lanes: 1, sidewalk: 'none', material: 'gravel', drainage: 'none', markings: false, elevation: 'follow' },
  dirt: { width: 3.5, lanes: 1, sidewalk: 'none', material: 'dirt', drainage: 'none', markings: false, elevation: 'follow' },
};

export const PROFILE_LIMITS = {
  width: [2.5, 30],
  lanes: [1, 8],
  sidewalkWidth: [0.8, 6],
  curbHeight: [0, 0.3],
} as const;

/** Total half-width including sidewalks on a side (m). */
export function sideWidth(p: RoadProfile, side: 'left' | 'right'): number {
  const has = p.sidewalk === 'both' || p.sidewalk === side;
  return p.width / 2 + (has ? p.sidewalkWidth : 0);
}
