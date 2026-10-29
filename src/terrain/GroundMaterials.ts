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
 *  - erodibility:  0–1 relative susceptibility to erosion (Phase 19). APPROXIMATE ranking only
 *                  (loose sand / mud highest, bare rock and pavement lowest); used by the
 *                  erosion-inspired brush — there is no sediment transport model.
 *
 * Natural channel / bed values (Phase 19): Manning n of natural streams ~0.03–0.04 (clean,
 * some stones), rock-cut channels ~0.035–0.05 (Chow 1959, Open-Channel Hydraulics, tab. 5-6);
 * mud: fine, nearly saturated sediment — low infiltration, slippery.
 *
 * Future properties (soil strength, seismic site amplification, erodibility) go here as
 * optional fields so earthquake and flood systems can read them per sample.
 */
import type { GroundTypeId } from '@/core/model';
import type { MessageKey } from '@/i18n/i18n';

export interface GroundMaterial {
  id: GroundTypeId;
  key: 'grass' | 'soil' | 'sand' | 'asphalt' | 'concrete' | 'gravel' | 'rock' | 'mud' | 'riverbed';
  labelKey: MessageKey;
  /** Display color (sRGB). */
  color: string;
  friction: number;
  roughness: number;
  permeability: number;
  manning: number;
  /** Paved: storm drains remove water here (drainage capacity setting). */
  paved: boolean;
  erodibility: number;
}

export const GROUND_MATERIALS: readonly GroundMaterial[] = [
  { id: 0, key: 'grass', labelKey: 'ground.grass', color: '#5f8f43', friction: 0.55, roughness: 0.35, permeability: 0.6, manning: 0.035, paved: false, erodibility: 0.4 },
  { id: 1, key: 'soil', labelKey: 'ground.soil', color: '#8a6a48', friction: 0.6, roughness: 0.3, permeability: 0.45, manning: 0.03, paved: false, erodibility: 0.7 },
  { id: 2, key: 'sand', labelKey: 'ground.sand', color: '#d6c08b', friction: 0.5, roughness: 0.2, permeability: 0.85, manning: 0.025, paved: false, erodibility: 0.9 },
  { id: 3, key: 'asphalt', labelKey: 'ground.asphalt', color: '#4a4f55', friction: 0.7, roughness: 0.1, permeability: 0.05, manning: 0.016, paved: true, erodibility: 0.02 },
  { id: 4, key: 'concrete', labelKey: 'ground.concrete', color: '#a9a8a2', friction: 0.65, roughness: 0.08, permeability: 0.02, manning: 0.014, paved: true, erodibility: 0.01 },
  // Phase 18 (gravel roads / shoulders): loose, fairly permeable, no storm drains.
  { id: 5, key: 'gravel', labelKey: 'ground.gravel', color: '#9b948a', friction: 0.6, roughness: 0.25, permeability: 0.5, manning: 0.025, paved: false, erodibility: 0.5 },
  // Phase 19 natural surfaces.
  { id: 6, key: 'rock', labelKey: 'ground.rock', color: '#8c8a86', friction: 0.7, roughness: 0.4, permeability: 0.08, manning: 0.04, paved: false, erodibility: 0.05 },
  { id: 7, key: 'mud', labelKey: 'ground.mud', color: '#5e4b38', friction: 0.35, roughness: 0.15, permeability: 0.15, manning: 0.03, paved: false, erodibility: 0.8 },
  { id: 8, key: 'riverbed', labelKey: 'ground.riverbed', color: '#7b7462', friction: 0.55, roughness: 0.3, permeability: 0.4, manning: 0.035, paved: false, erodibility: 0.5 },
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
