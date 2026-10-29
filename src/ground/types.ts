/**
 * Sinkhole and landslide specs (Phase 22). SI units: m, s, kPa. Saved in the experiment plan.
 */
import type { MechanicalId } from './materials';

/** What drives a sinkhole to failure (all four also feel structure / water / deposit loads). */
export type SinkholeInitiation = 'growth' | 'supportLoss' | 'water' | 'load';
export const SINKHOLE_INITIATIONS: readonly SinkholeInitiation[] = ['growth', 'supportLoss', 'water', 'load'];

export interface SinkholeSpec {
  event: 'sinkhole';
  /** Cavity centre (m). */
  center: [number, number];
  /** Initial cavity radius a₀ (m) and cavity height h_c (m). */
  cavityRadius: number;
  cavityHeight: number;
  /** Soil cover above the cavity roof H (m). */
  cover: number;
  /** Mechanical profile of the cover (default: from the terrain's soil map at the centre). */
  material?: MechanicalId;
  initiation: SinkholeInitiation;
  /** growth: radius growth rate (m/s). */
  growthRate?: number;
  /** supportLoss: prescribed loss of roof resistance (0–0.95) reached after `duration`. */
  supportLoss?: number;
  /** water: water-table ratio in the cover reached after `duration` (0–1). */
  saturation?: number;
  /** load: extra surcharge on the ground above the cavity (kPa) reached after `duration`. */
  surcharge?: number;
  /** Ramp time of the prescribed input (s); growth: maximum time the cavity grows. */
  duration: number;
  /** Relative spatial variability of the cover strength (seeded), 0–0.5. */
  variability?: number;
  seed?: number;
  startTime?: number;
  name?: string;
}

/** Area of a landslide analysis (source area): circle or polygon (world x / z). */
export type GroundArea = { kind: 'circle'; center: [number, number]; radius: number } | { kind: 'polygon'; points: [number, number][] };

export type LandslideTrigger = 'rain' | 'saturation' | 'earthquake' | 'slope' | 'user';
export const LANDSLIDE_TRIGGERS: readonly LandslideTrigger[] = ['rain', 'saturation', 'earthquake', 'slope', 'user'];

export interface LandslideSpec {
  event: 'landslide';
  area: GroundArea;
  /** Soil thickness above the slip surface z (m). */
  thickness: number;
  material?: MechanicalId;
  /** Initial (antecedent) water-table ratio m₀ (0–1). */
  saturation: number;
  /**
   * What is expected to drive failure. Every mechanism is ALWAYS evaluated (rain infiltration,
   * Newmark under an earthquake, slope changes from other phenomena); the trigger only adds a
   * prescribed input: 'saturation' ramps m to `targetSaturation` over `duration`, 'user' forces
   * the failure of the whole area at the start (prescribed, labelled as such).
   */
  trigger: LandslideTrigger;
  targetSaturation?: number;
  duration: number;
  /** Newmark displacement that counts as failure (m; empirical, default 0.1). */
  newmarkLimit?: number;
  /** Voellmy turbulence coefficient ξ (m/s²; empirical, default 400). */
  turbulence?: number;
  /** World edges for the runout. */
  boundary?: 'closed' | 'open';
  /** Relative spatial variability of strength (seeded), 0–0.5. */
  variability?: number;
  seed?: number;
  startTime?: number;
  name?: string;
}

export const SINKHOLE_LIMITS = {
  cavityRadius: [0.5, 40], cavityHeight: [0.5, 30], cover: [1, 60], growthRate: [0, 1], supportLoss: [0, 0.95], saturation: [0, 1],
  surcharge: [0, 500], duration: [0, 3600], variability: [0, 0.5],
} as const;

export const LANDSLIDE_LIMITS = {
  thickness: [0.3, 10], saturation: [0, 1], duration: [0, 7200], newmarkLimit: [0.01, 1], turbulence: [50, 5000], variability: [0, 0.5], radius: [3, 150],
} as const;
