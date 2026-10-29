/**
 * Natural environment data model (Phase 19): the non-destructive terrain layers.
 *
 *   Base Terrain                         base.heights / base.ground   (preset or loaded terrain)
 *   + User Sculpt Layer                  sculpt (Δh per vertex, m)
 *   + Landform Features                  Σ Δh of mountains, hills, ridges, valleys, canyons
 *   = Landform L
 *   ⊓ Water / Coast Features             min(L, channel / basin / shore section) — rivers,
 *                                        lakes, coastlines (sections computed from L)
 *   + User Paint Layer                   paint (ground type per vertex, 255 = none)
 *   = Natural Terrain N                  natural.* (derived cache, never saved)
 *   ⊕ Road Grading (Phase 18 bake on N)
 *   = Final Terrain                      TerrainData.heights / ground (collider, water bed, render)
 *
 * Sums and minimums commute, so the result does not depend on the order features were made
 * in, and any rectangle can be recomposed on its own. Features are immutable values (edits
 * create new ones); the per-vertex layers are typed arrays edited in place with rectangle
 * patches for undo, like the terrain.
 */
import type { GroundTypeId } from '@/core/model';

export type P2 = [number, number];

export const NO_PAINT = 255;

/** Raised / lowered landforms (additive). */
export interface PeakFeature {
  id: string;
  kind: 'mountain' | 'hill';
  x: number;
  z: number;
  /** Base radius (m). */
  radius: number;
  /** Peak height above the surrounding ground (m). */
  height: number;
  /** 0–1: noise added to the slopes (0 = perfectly smooth). */
  roughness: number;
  seed: number;
  /** Noise frame (Phase 20 blueprints): where the roughness noise is anchored. Absent = world axes. */
  frame?: NoiseFrame;
}

/**
 * Frame of a landform's roughness noise (Phase 20). The noise is sampled at
 * q = Rᵀ(yaw) · (p − (x, z)) instead of the world point p, so a landform moved / turned by a
 * blueprint keeps exactly the same relief. Absent = identity (Phase 19 behavior, bit-identical).
 */
export interface NoiseFrame {
  x: number;
  z: number;
  yaw: number;
}

export interface LineLandformFeature {
  id: string;
  kind: 'ridge' | 'valley' | 'canyon';
  /** Path (≥ 2 points, smooth curve through them). */
  points: P2[];
  /** Full width (m). */
  width: number;
  /** Ridge height / valley or canyon depth (m, positive). */
  height: number;
  roughness: number;
  seed: number;
  frame?: NoiseFrame;
}

export type RiverGrading = 'downhill' | 'follow';
/** What happens where a river meets a road: water passes under it, or the road embankment blocks it. */
export type RiverCrossing = 'culvert' | 'embankment';

export interface RiverWater {
  /** Initial water depth in the channel as a fraction of the channel depth (0 = dry). */
  fill: number;
  /** Steady inflow at the upstream end (m³/s, 0 = none). */
  inflow: number;
  /** Downstream end at the map edge: let the water leave (open boundary) or not. */
  downstream: 'open' | 'closed';
}

export interface RiverFeature {
  id: string;
  kind: 'river';
  /** Path from upstream (first) to downstream (last). */
  points: P2[];
  /** Channel bottom width (m, ≥ MIN_RIVER_WIDTH). */
  width: number;
  /** Bank-full depth below the smoothed landform (m). */
  depth: number;
  /** Bank slope: horizontal metres per metre of height (2 = 1:2). */
  bankSlope: number;
  material: GroundTypeId;
  /** Meander: sideways offset amplitude (m) and wavelength (m), seeded phase. */
  meander: { amplitude: number; wavelength: number; seed: number };
  /** downhill: the bed never rises downstream (running minimum); follow: smoothed landform − depth. */
  grading: RiverGrading;
  crossing: RiverCrossing;
  water: RiverWater;
}

export interface LakeFeature {
  id: string;
  kind: 'lake';
  /** Shoreline polygon (≥ 3 points). */
  points: P2[];
  /** Target water surface elevation (m). */
  surface: number;
  /** Maximum depth below the surface (m). */
  depth: number;
  /** Distance from the shore over which the bottom reaches full depth (m). */
  shoreWidth: number;
  material: GroundTypeId;
  /** Start simulations with the basin filled to the surface elevation. */
  filled: boolean;
}

export interface CoastFeature {
  id: string;
  kind: 'coast';
  /** Shoreline (≥ 2 points); the line is extended past its ends to the map edges. */
  points: P2[];
  /** Which side is the sea: +1 = right of the drawing direction, −1 = left. */
  seaSide: 1 | -1;
  /** Beach rise inland (fraction, 0.05 = 5 %) and beach width (m). */
  beachSlope: number;
  beachWidth: number;
  /** Sea floor drop offshore (fraction) and its maximum depth below sea level (m). */
  offshoreSlope: number;
  maxDepth: number;
  material: GroundTypeId;
}

export type LandformFeature = PeakFeature | LineLandformFeature;
export type WaterFeature = RiverFeature | LakeFeature | CoastFeature;
export type Feature = LandformFeature | WaterFeature;
export type FeatureKind = Feature['kind'];

export const LANDFORM_KINDS: readonly FeatureKind[] = ['mountain', 'hill', 'ridge', 'valley', 'canyon'];
export const isLandform = (f: Feature): f is LandformFeature => (LANDFORM_KINDS as readonly string[]).includes(f.kind);

export interface Landscape {
  version: 1;
  base: { heights: Float32Array; ground: Uint8Array };
  /** User sculpt Δh per vertex (m). */
  sculpt: Float32Array;
  /** User paint per vertex (ground type, NO_PAINT = none). */
  paint: Uint8Array;
  features: Feature[];
  /** Next feature id number (f<k>). */
  next: number;
  /**
   * Derived: the composed natural terrain (no roads) and the culvert mask — vertices of a river
   * channel with the 'culvert' crossing policy, which road grading leaves alone so the water
   * passes under the road (approximation of a culvert / bridge opening). `roadBase`: the natural
   * height WITHOUT 'embankment' river channels — what graded road profiles follow, so a road
   * crosses such a channel on a level fill (an embankment) instead of dipping into it. Not saved.
   */
  natural: { heights: Float32Array; ground: Uint8Array; culvert: Uint8Array; roadBase: Float32Array };
}

/** Narrowest channel the 1 m water grid can carry (three cells across). */
export const MIN_RIVER_WIDTH = 3;

/** Parameter limits (m unless noted). */
export const LIMITS = {
  peakRadius: [8, 100],
  mountainHeight: [3, 60],
  hillHeight: [1, 20],
  lineWidth: [6, 80],
  ridgeHeight: [1, 40],
  valleyDepth: [1, 30],
  roughness: [0, 1],
  riverWidth: [MIN_RIVER_WIDTH, 40],
  riverDepth: [0.5, 8],
  bankSlope: [0.5, 6],
  meanderAmplitude: [0, 30],
  meanderWavelength: [20, 200],
  lakeDepth: [0.5, 15],
  shoreWidth: [1, 30],
  beachSlope: [0.01, 0.3],
  beachWidth: [0, 40],
  offshoreSlope: [0.01, 0.5],
  coastDepth: [0.5, 20],
} as const;
