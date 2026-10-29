/**
 * Landscape file format (Phase 19, schema v7). Per-vertex layers use the terrain codecs (heights
 * in cm deltas, ground bytes run-length encoded); features are plain JSON validated leniently:
 * an invalid feature is DROPPED and counted, parameters are clamped to their limits.
 */
import { z } from 'zod';
import type { TerrainData } from '@/core/model';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';
import { decodeElevation, decodeGround, encodeElevation, encodeGround } from '@/terrain/terrainCodec';
import { createLandscape } from './compose';
import { LIMITS, MIN_RIVER_WIDTH, NO_PAINT, type Feature, type Landscape } from './types';

export interface SerializedLandscape {
  version: 1;
  base: { elevation: string; ground: string };
  sculpt: string | null;
  paint: string | null;
  features: Feature[];
  next: number;
}

export function serializeLandscape(land: Landscape, nx: number): SerializedLandscape {
  const sculptUsed = land.sculpt.some((v) => v !== 0);
  const paintUsed = land.paint.some((v) => v !== NO_PAINT);
  return {
    version: 1,
    base: { elevation: encodeElevation(land.base.heights, nx), ground: encodeGround(land.base.ground) },
    sculpt: sculptUsed ? encodeElevation(land.sculpt, nx) : null,
    paint: paintUsed ? encodeGround(land.paint) : null,
    features: land.features,
    next: land.next,
  };
}

const finite = z.number().refine(Number.isFinite);
const clamp = ([lo, hi]: readonly [number, number]) => finite.transform((v) => Math.min(hi, Math.max(lo, v)));
const p2 = z.tuple([finite, finite]);
const id = z.string().regex(/^f\d{1,9}$/);
const groundId = z.number().int().refine((g) => GROUND_MATERIALS.some((m) => m.id === g));
const seed = z.number().int().nonnegative().catch(1);
// Phase 20: noise frame of a landform moved / turned by a blueprint (optional; v7 readers before
// Phase 20 drop it and get a differently placed relief — the shape stays a valid landform).
const frame = z.object({ x: finite, z: finite, yaw: finite }).optional().catch(undefined);

export const featureSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.enum(['mountain', 'hill']), x: finite, z: finite, radius: clamp(LIMITS.peakRadius), height: clamp([0.5, 60]), roughness: clamp(LIMITS.roughness).catch(0), seed, frame }),
  z.object({ id, kind: z.enum(['ridge', 'valley', 'canyon']), points: z.array(p2).min(2).max(64), width: clamp(LIMITS.lineWidth), height: clamp([0.5, 40]), roughness: clamp(LIMITS.roughness).catch(0), seed, frame }),
  z.object({
    id, kind: z.literal('river'), points: z.array(p2).min(2).max(64),
    width: clamp([MIN_RIVER_WIDTH, LIMITS.riverWidth[1]]), depth: clamp(LIMITS.riverDepth), bankSlope: clamp(LIMITS.bankSlope),
    material: groundId,
    meander: z.object({ amplitude: clamp(LIMITS.meanderAmplitude), wavelength: clamp(LIMITS.meanderWavelength), seed }),
    grading: z.enum(['downhill', 'follow']).catch('downhill'),
    crossing: z.enum(['culvert', 'embankment']).catch('culvert'),
    water: z.object({ fill: clamp([0, 1]).catch(0), inflow: clamp([0, 200]).catch(0), downstream: z.enum(['open', 'closed']).catch('open') }),
  }),
  z.object({ id, kind: z.literal('lake'), points: z.array(p2).min(3).max(128), surface: clamp([-40, 80]), depth: clamp(LIMITS.lakeDepth), shoreWidth: clamp(LIMITS.shoreWidth), material: groundId, filled: z.boolean().catch(true) }),
  z.object({
    id, kind: z.literal('coast'), points: z.array(p2).min(2).max(64), seaSide: z.union([z.literal(1), z.literal(-1)]),
    beachSlope: clamp(LIMITS.beachSlope), beachWidth: clamp(LIMITS.beachWidth), offshoreSlope: clamp(LIMITS.offshoreSlope), maxDepth: clamp(LIMITS.coastDepth), material: groundId,
  }),
]);

const landscapeSchema = z.object({
  version: z.literal(1),
  base: z.object({ elevation: z.string(), ground: z.string() }),
  sculpt: z.string().nullable().catch(null),
  paint: z.string().nullable().catch(null),
  features: z.array(z.unknown()).catch([]),
  next: z.number().int().min(1).catch(1),
});

export interface LandscapeLoadReport {
  droppedFeatures: number;
  /** The landscape block could not be read: the saved terrain became the base. */
  rebuilt: boolean;
}

/**
 * Parse a saved landscape. `fallback` = the natural terrain to use as the base when the block is
 * missing (files before v7) or unreadable.
 */
export function parseLandscape(raw: unknown, t: TerrainData, fallback: Pick<TerrainData, 'heights' | 'ground'>): { landscape: Landscape; report: LandscapeLoadReport } {
  const report: LandscapeLoadReport = { droppedFeatures: 0, rebuilt: false };
  if (raw === undefined || raw === null) return { landscape: createLandscape(fallback), report };
  const r = landscapeSchema.safeParse(raw);
  if (!r.success) return { landscape: createLandscape(fallback), report: { ...report, rebuilt: true } };
  const n = t.nx * t.nz;
  const land = createLandscape(fallback);
  try {
    decodeElevation(r.data.base.elevation, land.base.heights, t.nx);
    decodeGround(r.data.base.ground, land.base.ground);
    if (r.data.sculpt) decodeElevation(r.data.sculpt, land.sculpt, t.nx);
    if (r.data.paint) decodeGround(r.data.paint, land.paint);
  } catch {
    return { landscape: createLandscape(fallback), report: { ...report, rebuilt: true } };
  }
  if (land.base.heights.length !== n) return { landscape: createLandscape(fallback), report: { ...report, rebuilt: true } };
  let maxId = 0;
  const seen = new Set<string>();
  for (const f of r.data.features) {
    const p = featureSchema.safeParse(f);
    if (!p.success || seen.has(p.data.id)) { report.droppedFeatures++; continue; }
    seen.add(p.data.id);
    land.features.push(p.data as Feature);
    maxId = Math.max(maxId, parseInt(p.data.id.slice(1), 10));
  }
  land.next = Math.max(r.data.next, maxId + 1);
  return { landscape: land, report };
}
