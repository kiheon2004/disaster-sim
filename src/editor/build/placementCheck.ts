/**
 * Placement checks on terrain (Phase 16): slope under an object and how far its footprint
 * corners float above / dig into the ground once seated by its category rule
 * (terrain/groundPlacement). Buildings get a foundation plinth down to the ground, so they never
 * "float"; the real foundation model is Phase 17.
 */
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { yawOf } from '@/terrain/groundPlacement';

export type PlacementWarning = 'slope' | 'floating' | 'buried' | 'overlap' | 'outside';

export interface PlacementCheck {
  /** Slope at the object's center (degrees). */
  slope: number;
  /** Largest gap between the base and the ground under a footprint corner (m). */
  gap: number;
  /** Largest depth a footprint corner is below the ground (m). */
  bury: number;
  warnings: PlacementWarning[];
}

/** A corner more than this above the ground counts as floating (m). */
export const FLOAT_TOLERANCE = 0.3;

type Placed = Pick<WorldObject, 'type' | 'params' | 'transform'>;

export function checkPlacement(obj: Placed, terrain: TerrainSampler, slopeLimit = 90): PlacementCheck {
  const [x, y, z] = obj.transform.position;
  const slope = terrain.flat ? 0 : terrain.sampleSlope(x, z);
  const out: PlacementCheck = { slope, gap: 0, bury: 0, warnings: [] };
  if (slope > slopeLimit) out.warnings.push('slope');
  if (terrain.flat) return out;
  const def = getDefinition(obj.type);
  const fit = def.terrainFit ?? { align: 0, base: 'center' as const };
  // Tilted objects (vehicles) follow the ground plane: their corners are on it by construction.
  if (fit.align >= 0.99) return out;
  const d = def.getDimensions(obj.params);
  const k = obj.transform.scale;
  // Trees stand on their trunk, not on the crown's footprint.
  const trunk = obj.type === 'tree' ? Number(obj.params.trunkRadius) || 0.3 : 0;
  const hx = trunk || (d[0] * k[0]) / 2;
  const hz = trunk || (d[2] * k[2]) / 2;
  const yaw = yawOf(obj.transform.rotation);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [lx, lz] of [[hx, hz], [hx, -hz], [-hx, hz], [-hx, -hz]]) {
    const h = terrain.sampleHeight(x + lx * c + lz * s, z - lx * s + lz * c);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  out.gap = Math.max(0, y - lo);
  out.bury = Math.max(0, hi - y);
  // Buildings stand on a foundation plinth that reaches the ground.
  if (fit.base !== 'foundation' && out.gap > FLOAT_TOLERANCE) out.warnings.push('floating');
  if (out.bury > Math.max(0.5, d[1] * k[1] * 0.25)) out.warnings.push('buried');
  return out;
}
