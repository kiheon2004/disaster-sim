/**
 * Road cross-section (Phase 35.5): ONE description of a road's width that every part reads — the mesh (lanes, shoulders,
 * markings), the terrain bake and junctions (carriageway `width` + sidewalks, unchanged), the vehicle lane centres and the
 * palette. A road profile stores the carriageway width (curb to curb) and the lane count as before; shoulders and a median
 * are optional (absent = 0, which is exactly the geometry of every road made before Phase 35.5 — old files are unchanged).
 *
 *   carriageway = lanes × laneWidth + 2 × shoulderWidth + medianWidth      total = carriageway + sidewalks
 *
 * Presets: the same preset gives the same section wherever a road is made (road tool, palette, default world, templates).
 */
import type { RoadProfile } from './types';

export interface RoadCrossSection {
  laneCount: number;
  laneWidth: number;
  /** Paved shoulder on each side (m). */
  shoulderWidth: number;
  /** Sidewalk on each side that has one (m). */
  sidewalkWidth: number;
  medianWidth: number;
  /** Curb to curb (m). */
  carriageway: number;
  /** Outer edge to outer edge, sidewalks included (m). */
  totalWidth: number;
}

/** The cross-section of a profile (derived; shoulders / median default to 0). */
export function crossSectionOf(p: RoadProfile): RoadCrossSection {
  const shoulder = p.shoulderWidth ?? 0, median = p.medianWidth ?? 0;
  const sides = p.sidewalk === 'both' ? 2 : p.sidewalk === 'none' ? 0 : 1;
  return {
    laneCount: p.lanes,
    laneWidth: (p.width - 2 * shoulder - median) / p.lanes,
    shoulderWidth: shoulder,
    sidewalkWidth: sides ? p.sidewalkWidth : 0,
    medianWidth: median,
    carriageway: p.width,
    totalWidth: p.width + sides * p.sidewalkWidth,
  };
}

/** Lateral offset (m, + = right of the a→b direction) of the centre of lane i (0 = leftmost). */
export function laneCenter(p: RoadProfile, i: number): number {
  const shoulder = p.shoulderWidth ?? 0, median = p.medianWidth ?? 0;
  if (shoulder === 0 && median === 0) return -p.width / 2 + (p.width / p.lanes) * (i + 0.5);
  const lw = (p.width - 2 * shoulder - median) / p.lanes;
  const left = -p.width / 2 + shoulder;
  return left + lw * (i + 0.5) + (!p.oneWay && i >= p.lanes / 2 ? median : 0);
}

export type CrossSectionId = 'narrow2' | 'normal2' | 'wide2' | 'avenue4';

/** Cross-section presets → road profile fields. normal2 / avenue4 are exactly the road tool's 'street' / 'avenue'. */
export const CROSS_SECTIONS: Record<CrossSectionId, { profile: Partial<RoadProfile>; preset: string }> = {
  narrow2: { preset: 'narrow', profile: { width: 6, lanes: 2, sidewalk: 'both', sidewalkWidth: 1.5, material: 'asphalt', drainage: 'standard' } },
  normal2: { preset: 'street', profile: { width: 7, lanes: 2, sidewalk: 'both', sidewalkWidth: 2, material: 'asphalt', drainage: 'standard' } },
  wide2: { preset: 'wide', profile: { width: 10, lanes: 2, shoulderWidth: 1.5, sidewalk: 'both', sidewalkWidth: 2.5, material: 'asphalt', drainage: 'standard' } },
  avenue4: { preset: 'avenue', profile: { width: 14, lanes: 4, sidewalk: 'both', sidewalkWidth: 3, material: 'asphalt', drainage: 'enhanced' } },
};

/** The preset a profile matches exactly (null = custom). */
export function presetOf(p: RoadProfile): CrossSectionId | null {
  for (const [id, c] of Object.entries(CROSS_SECTIONS) as [CrossSectionId, (typeof CROSS_SECTIONS)[CrossSectionId]][]) {
    const q = c.profile;
    if (q.width === p.width && q.lanes === p.lanes && (q.shoulderWidth ?? 0) === (p.shoulderWidth ?? 0) && (q.medianWidth ?? 0) === (p.medianWidth ?? 0) && q.sidewalkWidth === p.sidewalkWidth && q.sidewalk === p.sidewalk) return id;
  }
  return null;
}
