/**
 * Mechanical and hydrological ground profiles (Phase 22 — shared by sinkholes and landslides).
 *
 * Three independent descriptions of a terrain point (§ docs/GROUND_FAILURE.md §3):
 *   surface material (GroundMaterials: grass, asphalt … — look, friction, infiltration capacity)
 *   soil profile     (SoilProfiles, Phase 13: what lies beneath for SEISMIC response / bearing)
 *   mechanical ground profile (this file: SHEAR STRENGTH, unit weight, porosity, bulking)
 * The same grass surface can lie on rock or on fill; the terrain's soil map selects the default
 * mechanical profile (DEFAULT_MECHANICAL) and a phenomenon may override it in its own area.
 *
 * The numbers are REPRESENTATIVE TEXTBOOK VALUES for the class — mid-points of published typical
 * ranges — NOT test results for any site. Real values vary widely (the `range` fields give the
 * typical spread) and governing parameters of a real slope come from site investigation.
 * Sources (typical ranges): Das & Sobhan, Principles of Geotechnical Engineering (8th ed.),
 * tables of φ' for sands and of c', φ' for clays; NAVFAC DM-7.01 (1986) typical properties;
 * Carter & Bentley (1991) correlations; swell (bulking) factors of excavated soils from earthwork
 * handbooks (Caterpillar Performance Handbook "swell" tables: sand ~1.1, clay ~1.2–1.4, rock
 * ~1.5–1.7).
 *
 * "Saturated soil" is not a material: saturation is a STATE of any of these profiles (the
 * perched water-table ratio m of the geotechnical field), set by rain infiltration or as an
 * explicit initial condition.
 */
import type { SoilProfileId } from '@/core/model';
import type { MessageKey } from '@/i18n/i18n';

export type MechanicalId = 'rock' | 'denseGranular' | 'looseGranular' | 'cohesive' | 'fill';
export const MECHANICAL_IDS: readonly MechanicalId[] = ['rock', 'denseGranular', 'looseGranular', 'cohesive', 'fill'];

export interface MechanicalProfile {
  id: MechanicalId;
  labelKey: MessageKey;
  /** Effective cohesion c' (kPa) and the typical range. */
  cohesion: number;
  cohesionRange: [number, number];
  /** Apparent cohesion from matric suction in the unsaturated state (kPa) — lost when saturated. */
  apparentCohesion: number;
  /** Effective friction angle φ' (deg) and the typical range. */
  friction: number;
  frictionRange: [number, number];
  /** Bulk density of the in-situ soil (kg/m³) → unit weight γ = ρ·g. */
  density: number;
  /** Porosity n (–) and the drainable fraction of it (specific yield / n). */
  porosity: number;
  drainable: number;
  /** Volume of loosened material per volume in place (swell / bulking factor). */
  bulking: number;
  /**
   * Whether the infinite-slope / plug models apply. Rock: no — rock-slope failure is controlled
   * by discontinuities (planes, wedges, toppling) that this project does not model; a rock cell
   * never fails here and the UI says so.
   */
  failureModel: boolean;
}

export const MECHANICAL_PROFILES: Record<MechanicalId, MechanicalProfile> = {
  rock: {
    id: 'rock', labelKey: 'geo.mat.rock', cohesion: 0, cohesionRange: [0, 0], apparentCohesion: 0, friction: 45, frictionRange: [35, 55],
    density: 2400, porosity: 0.05, drainable: 0.5, bulking: 1.6, failureModel: false,
  },
  denseGranular: {
    id: 'denseGranular', labelKey: 'geo.mat.denseGranular', cohesion: 0, cohesionRange: [0, 2], apparentCohesion: 2, friction: 38, frictionRange: [35, 45],
    density: 2000, porosity: 0.3, drainable: 0.7, bulking: 1.15, failureModel: true,
  },
  looseGranular: {
    id: 'looseGranular', labelKey: 'geo.mat.looseGranular', cohesion: 0, cohesionRange: [0, 1], apparentCohesion: 1, friction: 30, frictionRange: [28, 33],
    density: 1750, porosity: 0.42, drainable: 0.7, bulking: 1.05, failureModel: true,
  },
  cohesive: {
    id: 'cohesive', labelKey: 'geo.mat.cohesive', cohesion: 8, cohesionRange: [2, 25], apparentCohesion: 6, friction: 24, frictionRange: [18, 30],
    density: 1850, porosity: 0.45, drainable: 0.3, bulking: 1.25, failureModel: true,
  },
  fill: {
    id: 'fill', labelKey: 'geo.mat.fill', cohesion: 2, cohesionRange: [0, 8], apparentCohesion: 3, friction: 30, frictionRange: [26, 35],
    density: 1750, porosity: 0.4, drainable: 0.6, bulking: 1.15, failureModel: true,
  },
};

/** Default mechanical profile of each Phase 13 soil profile (rock, dense soil, soft soil, reclaimed). */
export const DEFAULT_MECHANICAL: Record<SoilProfileId, MechanicalId> = { 0: 'rock', 1: 'denseGranular', 2: 'cohesive', 3: 'fill' } as Record<SoilProfileId, MechanicalId>;

export const mechanicalOf = (soil: number): MechanicalProfile => MECHANICAL_PROFILES[DEFAULT_MECHANICAL[soil as SoilProfileId] ?? 'denseGranular'];

/** Unit weight of water (kN/m³) and g. */
export const GAMMA_W = 9.81;
export const G = 9.81;

/** Unit weight γ (kN/m³) of a profile. */
export const unitWeight = (p: MechanicalProfile) => (p.density * G) / 1000;

export const DEG = Math.PI / 180;
