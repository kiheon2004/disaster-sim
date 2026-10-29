/**
 * Road surface materials (Phase 18) — APPROXIMATE simulation parameters, not pavement design data.
 *
 * A road material is baked into the terrain as a ground type, so friction (current contact
 * position, Phase 14), infiltration, Manning roughness and storm drains (paved) all come from
 * the same GroundMaterialRegistry the rest of the simulation already uses. The fields here add
 * what only roads need: damage susceptibility and the look.
 *
 *  - quakeCrackPgv: peak ground velocity (m/s) at which surface cracking starts (rigid / brittle
 *    slabs crack earlier than flexible asphalt; unbound gravel and dirt barely "crack" — they
 *    deform). Order of magnitude from post-earthquake pavement observations; ground failure
 *    (liquefaction, fault offset) — the main real cause — is not modeled (Phase 21).
 *  - scourSpeed: flow speed (m/s) above which the surface erodes in a flood (loose surfaces
 *    first), compare permissible velocities for erosion control (~1 m/s bare soil, ~1.5–2 m/s
 *    gravel, > 3 m/s paved).
 */
import type { GroundTypeId } from '@/core/model';
import { groundMaterial } from '@/terrain/GroundMaterials';
import type { RoadMaterial } from './types';

export interface RoadMaterialProps {
  ground: GroundTypeId;
  quakeCrackPgv: number;
  scourSpeed: number;
  /** Surface color (vertex color of the batched road mesh). */
  color: string;
  /** Lane markings are drawn on this surface. */
  marked: boolean;
}

export const ROAD_MATERIAL_PROPS: Record<RoadMaterial, RoadMaterialProps> = {
  asphalt: { ground: 3, quakeCrackPgv: 0.6, scourSpeed: 3.5, color: '#3d4247', marked: true },
  concrete: { ground: 4, quakeCrackPgv: 0.45, scourSpeed: 4, color: '#a3a29c', marked: true },
  gravel: { ground: 5, quakeCrackPgv: 1.2, scourSpeed: 1.6, color: '#8f887d', marked: false },
  dirt: { ground: 1, quakeCrackPgv: 1.5, scourSpeed: 1.0, color: '#7d6448', marked: false },
};

/** Sidewalks are concrete (ground type 4). */
export const SIDEWALK_GROUND: GroundTypeId = 4;
export const SIDEWALK_COLOR = '#b7b4ab';
export const CURB_COLOR = '#c9c6bd';

/** Physical summary of a road material (for the inspector). */
export function roadPhysics(m: RoadMaterial) {
  const g = groundMaterial(ROAD_MATERIAL_PROPS[m].ground);
  return { friction: g.friction, permeability: g.permeability, manning: g.manning, paved: g.paved, ...ROAD_MATERIAL_PROPS[m] };
}

/** Drain inlet spacing per drainage level (m) and inlet capacity (m³/s) — typical curb inlets 10–30 L/s. */
export const DRAIN_SPACING = { none: 0, standard: 30, enhanced: 15 } as const;
export const INLET_CAPACITY = 0.015;
