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
import { qRotate, quatFromEuler } from '@/core/math';
import type { CreateObjectInput } from '@/world/WorldDocument';
import { collisionFootprint, FootprintIndex } from './footprint';
import { isInsideWorld } from '../placement';

/**
 * Phase 36 §16 / §19 adds, for vehicles and people (they used to skip every check — "tilted objects follow the ground
 * plane"): 'wheelContact' (a wheel more than WHEEL_TOLERANCE off the ground on uneven terrain — the car rocks or
 * hangs), 'steep' (vehicles > 25°, people > 30°: they slide / tip), 'inWater' (below the sea level) and, for cars,
 * 'offRoad' (not on asphalt — allowed, just shown).
 */
export type PlacementWarning = 'slope' | 'floating' | 'buried' | 'overlap' | 'outside' | 'wheelContact' | 'steep' | 'inWater' | 'offRoad';

export const WHEEL_TOLERANCE = 0.15;

/**
 * Paste / duplicate stamps (Phase 36 §16 — before, a paste was never checked): an object outside the world refuses the
 * whole stamp; overlaps with existing objects (or between the stamp's own objects) are warnings, like placement.
 */
export function checkStamp(inputs: readonly CreateObjectInput[], existing: FootprintIndex | null): { ok: boolean; items: { ok: boolean; warnings: PlacementWarning[] }[] } {
  const own = new FootprintIndex();
  let ok = true;
  const items = inputs.map((input) => {
    const def = getDefinition(input.type);
    const params = { ...def.defaultParams, ...(input.params ?? {}) };
    const d = def.getDimensions(params);
    const k = input.transform.scale;
    const [x, , z] = input.transform.position;
    const yaw = yawOf(input.transform.rotation);
    if (!isInsideWorld([x, 0, z], [d[0] * k[0], d[1] * k[1], d[2] * k[2]], yaw)) { ok = false; return { ok: false, warnings: ['outside' as const] }; }
    const fp = collisionFootprint(input.type, params, k, x, z, yaw);
    const warnings: PlacementWarning[] = [];
    if (fp && ((existing && existing.overlaps(fp)) || own.overlaps(fp))) warnings.push('overlap');
    if (fp) own.add(fp);
    return { ok: true, warnings };
  });
  return { ok, items };
}
const STEEP: Partial<Record<WorldObject['type'], number>> = { car: 25, human: 30 };
const ASPHALT = 3;

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
  const steep = STEEP[obj.type];
  if (steep !== undefined && slope > steep && !out.warnings.includes('slope')) out.warnings.push('steep');
  const sea = terrain.data.settings.waterLevel;
  if ((obj.type === 'car' || obj.type === 'human') && sea !== null && terrain.sampleHeight(x, z) < sea - 0.2) out.warnings.push('inWater');
  if (obj.type === 'car' && terrain.sampleGroundType(x, z) !== ASPHALT) out.warnings.push('offRoad');
  if (terrain.flat) return out;
  const def = getDefinition(obj.type);
  const fit = def.terrainFit ?? { align: 0, base: 'center' as const };
  // Tilted objects (vehicles) follow the ground PLANE through their footprint corners; on uneven ground a wheel can
  // still be off the ground under it (Phase 36: checked at the four wheel positions of the seated pose).
  if (fit.align >= 0.99) {
    if (obj.type === 'car') {
      const d = def.getDimensions(obj.params);
      const k = obj.transform.scale;
      const hx = (d[0] * k[0]) / 2 * 0.78, hz = (d[2] * k[2]) / 2 * 0.85;
      const q = quatFromEuler(obj.transform.rotation);
      let worst = 0;
      for (const [lx, lz] of [[hx, hz], [hx, -hz], [-hx, hz], [-hx, -hz]]) {
        const v = qRotate(q, [lx, 0, lz]);
        const gx = x + v[0], gz = z + v[2];
        worst = Math.max(worst, Math.abs(y + v[1] - terrain.sampleHeight(gx, gz)));
      }
      out.gap = worst;
      if (worst > WHEEL_TOLERANCE) out.warnings.push('wheelContact');
    }
    return out;
  }
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
