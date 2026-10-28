/**
 * GroundMaterialRegistry: the surface types a terrain vertex can carry.
 *
 * Every number here is an APPROXIMATE SIMULATION PARAMETER chosen to give plausible relative
 * behavior (asphalt grips better than loose sand, concrete drains worse than grass) — not
 * measured material data. The UI labels them that way.
 *
 *  - friction:     contact friction coefficient against a generic object (used to scale the
 *                  friction of free-standing bodies that start on this ground)
 *  - roughness:    0–1 surface roughness index (reserved for terrain-dependent wind profiles)
 *  - permeability: 0–1 relative infiltration capacity (rain / flood, Phase 14: the infiltration
 *                  rate and soil storage of a cell scale with it — see simulation/water/waterParams)
 *  - manning:      Manning roughness n (s/m^(1/3)) of overland flow on this surface (Phase 14)
 *
 * Future properties (soil strength, seismic site amplification, erodibility) go here as
 * optional fields so earthquake and flood systems can read them per sample.
 */
import type { GroundTypeId } from '@/core/model';
import type { MessageKey } from '@/i18n/i18n';

export interface GroundMaterial {
  id: GroundTypeId;
  key: 'grass' | 'soil' | 'sand' | 'asphalt' | 'concrete';
  labelKey: MessageKey;
  /** Display color (sRGB). */
  color: string;
  friction: number;
  roughness: number;
  permeability: number;
  manning: number;
  /** Paved: storm drains remove water here (drainage capacity setting). */
  paved: boolean;
}

export const GROUND_MATERIALS: readonly GroundMaterial[] = [
  { id: 0, key: 'grass', labelKey: 'ground.grass', color: '#5f8f43', friction: 0.55, roughness: 0.35, permeability: 0.6, manning: 0.035, paved: false },
  { id: 1, key: 'soil', labelKey: 'ground.soil', color: '#8a6a48', friction: 0.6, roughness: 0.3, permeability: 0.45, manning: 0.03, paved: false },
  { id: 2, key: 'sand', labelKey: 'ground.sand', color: '#d6c08b', friction: 0.5, roughness: 0.2, permeability: 0.85, manning: 0.025, paved: false },
  { id: 3, key: 'asphalt', labelKey: 'ground.asphalt', color: '#4a4f55', friction: 0.7, roughness: 0.1, permeability: 0.05, manning: 0.016, paved: true },
  { id: 4, key: 'concrete', labelKey: 'ground.concrete', color: '#a9a8a2', friction: 0.65, roughness: 0.08, permeability: 0.02, manning: 0.014, paved: true },
];

export const DEFAULT_GROUND: GroundTypeId = 0;

export function groundMaterial(id: number): GroundMaterial {
  return GROUND_MATERIALS[id] ?? GROUND_MATERIALS[DEFAULT_GROUND];
}

/**
 * Multiplier on the friction of a free-standing body that rests on this ground at simulation
 * start, relative to the default ground (grass → exactly 1, so unpainted terrain is unchanged).
 */
export function groundFrictionFactor(id: number): number {
  return groundMaterial(id).friction / GROUND_MATERIALS[DEFAULT_GROUND].friction;
}
