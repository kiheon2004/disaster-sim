/**
 * Meteoroid / asteroid impact spec (Phase 23). SI units (m, s, kg, kg/m³); angles in degrees.
 * Saved in the experiment plan; everything else (entry, crater, ejecta, shock) is derived from it
 * deterministically (seeded).
 */

export type ProjectileMaterial = 'stony' | 'iron' | 'icy';
export const PROJECTILE_MATERIALS: readonly ProjectileMaterial[] = ['stony', 'iron', 'icy'];

/**
 * 'atmosphere': the body starts at the top of the atmosphere (100 km) and is slowed / ablated /
 * possibly broken up by the air (Collins et al. 2005 entry model, computed as a separate stage —
 * the 200 m world cannot hold it); 'direct': no atmosphere, the given speed reaches the ground
 * (an airless body, or a deliberate "what if" — labelled).
 */
export type EntryMode = 'atmosphere' | 'direct';

export interface ImpactSpec {
  event: 'impact';
  /** Aim point on the ground (x, z), m. The actual impact point is where the trajectory meets the terrain. */
  target: [number, number];
  material: ProjectileMaterial;
  /** Diameter of the (spherical) body at the start, m. */
  diameter: number;
  /** Bulk density, kg/m³ (default: the material's representative value). */
  density?: number;
  /**
   * Mass, kg — optional. When given it must agree with the sphere of `diameter` and `density`
   * (within 1 %); the validator rejects an inconsistent triple instead of picking one silently.
   */
  mass?: number;
  /** Speed at the start (top of the atmosphere, or at the start point in 'direct' mode), m/s. */
  speed: number;
  /** Trajectory angle above the horizontal at entry, 5–90°. */
  angle: number;
  /** Direction of travel: bearing (0 = north, 90 = east), °. */
  azimuth: number;
  entry: EntryMode;
  /**
   * Simulate the atmospheric pressure wave of the impact (Phase 24): an airburst releases its
   * energy into the air; a ground impact couples `airCoupling` of its kinetic energy into the air
   * (taken out of the energy left unresolved by the crater model, never out of the seismic or ejecta
   * shares). Absent in files written before Phase 24 → off (the run reproduces as it was saved).
   */
  airBlast?: boolean;
  /** Fraction of the ground-impact kinetic energy coupled into the air (default 0.02; 0.001–0.5). */
  airCoupling?: number;
  /**
   * Share of the ground-impact kinetic energy deposited as HEAT in the crater's surface (Phase 26,
   * opt-in; absent / 0 = Phase 25 behaviour). Taken out of the energy the crater model leaves
   * unresolved (after the air-coupled share), never out of the seismic or ejecta shares; capped at
   * what is left. Literature puts the internal energy of the target at tens of percent for
   * hypervelocity impacts (e.g. O'Keefe & Ahrens 1977), but most of it is in melt / vapour that this
   * model does not resolve — the share is a user choice, not a prediction.
   */
  thermalShare?: number;
  seed?: number;
  startTime?: number;
  name?: string;
}

export const IMPACT_LIMITS = {
  diameter: [0.05, 20],
  density: [300, 8000],
  speed: [1000, 72000],
  angle: [5, 90],
  airCoupling: [0.001, 0.5],
  thermalShare: [0, 0.5],
} as const;

/**
 * Default air-coupled share of a ground impact (assumption): low-speed (km/s) impacts vaporize
 * almost nothing, so the air shock comes from the expanding crater / ejecta; Collins et al. (2005)
 * use the FULL impact energy as the blast yield — an upper bound. 2 % is an order-of-magnitude
 * choice, editable and labelled.
 */
export const DEFAULT_AIR_COUPLING = 0.02;
