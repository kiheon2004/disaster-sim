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
  seed?: number;
  startTime?: number;
  name?: string;
}

export const IMPACT_LIMITS = {
  diameter: [0.05, 20],
  density: [300, 8000],
  speed: [1000, 72000],
  angle: [5, 90],
} as const;
