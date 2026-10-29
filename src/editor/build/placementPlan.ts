/**
 * Placement planner (Phase 16): turns distribution points into complete, validated object
 * inputs — per-object variation, heading and scale from a seeded stream, seated on the terrain
 * with the existing category rules (terrain/groundPlacement), and checked against the world
 * bounds, a slope limit and the footprints of existing objects. Deterministic.
 */
import type { ObjectType, Vec3 } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import { Rng } from '@/core/random';
import { degToRad } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { groundPose } from '@/terrain/groundPlacement';
import { isInsideWorld } from '../placement';
import { collisionFootprint, FootprintIndex } from './footprint';
import { subSeed } from './distribution';
import { checkPlacement, type PlacementWarning } from './placementCheck';
import type { BuildingDesign } from '@/buildings/types';
import { designParams } from '@/buildings/design';

/** Uniform scale range allowed for bulk placement (object definitions are designed around 1). */
export const SCALE_BOUNDS: [number, number] = [0.5, 2];

export type TerrainAlign = 'auto' | 'upright' | 'surface';

export interface PlacementSettings {
  seed: number;
  /** Random heading per object (otherwise the point's heading / baseYaw). */
  randomRotation: boolean;
  /** Heading (rad) added to every object. */
  baseYaw: number;
  /** Rotation snap (deg) applied to random headings; 0 = free. */
  rotationSnap: number;
  /** Uniform scale range (clamped to SCALE_BOUNDS). */
  scaleMin: number;
  scaleMax: number;
  /** Natural variation of the object's params (definition.randomizeParams). */
  variation: boolean;
  /** Tilt on slopes: category rule, always level, or follow the ground plane. */
  align: TerrainAlign;
  /** Points steeper than this (deg) are skipped; 90 = no limit. */
  slopeLimit: number;
  /** Skip points whose footprint overlaps an existing or already planned object. */
  avoidCollisions: boolean;
}

export const DEFAULT_PLACEMENT: PlacementSettings = {
  seed: 1,
  randomRotation: true,
  baseYaw: 0,
  rotationSnap: 0,
  scaleMin: 1,
  scaleMax: 1,
  variation: true,
  align: 'auto',
  slopeLimit: 35,
  avoidCollisions: true,
};

export interface PlanPoint {
  x: number;
  z: number;
  /** Heading from the layout (line placement); random rotation overrides it. */
  yaw?: number;
}

export interface PlannedObject {
  input: CreateObjectInput;
  /** False = will not be placed (reason in `rejected`). */
  ok: boolean;
  rejected?: 'outside' | 'slope' | 'collision';
  /** Non-blocking issues (overlap when avoidance is off, floating / buried corners). */
  warnings: PlacementWarning[];
}

export interface PlanItem {
  type: ObjectType;
  params?: ObjectParams;
  /** Modular building design (Phase 17): params follow it, every copy gets the same design. */
  building?: BuildingDesign;
  /** Whether the palette preset allows natural variation. */
  randomize?: boolean;
}

export interface PlanContext {
  terrain: TerrainSampler;
  /** Footprints of the objects already in the world (null = do not check). */
  existing: FootprintIndex | null;
}

export function clampScale(v: number): number {
  return Math.min(SCALE_BOUNDS[1], Math.max(SCALE_BOUNDS[0], Number.isFinite(v) ? v : 1));
}

function alignValue(a: TerrainAlign): number | undefined {
  return a === 'upright' ? 0 : a === 'surface' ? 1 : undefined;
}

/**
 * Plan objects at `points`. `startIndex` numbers the points of an ongoing stroke so each point
 * keeps its own random stream whatever else is planned in the same call.
 */
export function planPlacement(item: PlanItem, points: readonly PlanPoint[], s: PlacementSettings, ctx: PlanContext, startIndex = 0, plannedIndex?: FootprintIndex): PlannedObject[] {
  const def = getDefinition(item.type);
  const out: PlannedObject[] = [];
  const own = plannedIndex ?? new FootprintIndex();
  const sMin = clampScale(Math.min(s.scaleMin, s.scaleMax));
  const sMax = clampScale(Math.max(s.scaleMin, s.scaleMax));
  const align = alignValue(s.align);
  points.forEach((p, i) => {
    const rng = new Rng(subSeed(s.seed, 'obj', startIndex + i));
    let params: ObjectParams = item.building ? designParams(item.building) : { ...def.defaultParams, ...(item.params ?? {}) };
    if (!item.building && s.variation && item.randomize !== false && def.randomizeParams) {
      params = { ...params, ...(def.randomizeParams(params, () => rng.next()) as ObjectParams) };
    }
    const seed = rng.int(2 ** 31);
    let yaw = (p.yaw ?? 0) + s.baseYaw;
    if (s.randomRotation) {
      yaw = rng.next() * Math.PI * 2;
      if (s.rotationSnap > 0) {
        const step = degToRad(s.rotationSnap);
        yaw = Math.round(yaw / step) * step;
      }
      yaw += s.baseYaw;
    } else rng.next(); // keep the stream aligned whether or not rotation is random
    const k = sMin === sMax ? sMin : sMin + rng.next() * (sMax - sMin);
    const scale: Vec3 = [k, k, k];
    const base = { type: item.type, params, transform: { position: [p.x, 0, p.z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale } };
    const pose = groundPose(base, p.x, p.z, yaw, ctx.terrain, align);
    const input: CreateObjectInput = { type: item.type, params, seed, transform: { position: pose.position, rotation: pose.rotation, scale } };
    if (item.building) input.building = item.building;
    // An explicit slope alignment is remembered so later re-seating keeps it (Phase 17).
    if (align !== undefined && align !== (def.terrainFit?.align ?? 0)) input.terrainAlign = align;
    const entry: PlannedObject = { input, ok: true, warnings: [] };
    const dims = def.getDimensions(params);
    const check = checkPlacement({ type: item.type, params, transform: input.transform }, ctx.terrain, s.slopeLimit);
    entry.warnings.push(...check.warnings.filter((w) => w !== 'slope'));
    const fp = collisionFootprint(item.type, params, scale, p.x, p.z, yaw);
    if (!isInsideWorld([p.x, 0, p.z], [dims[0] * k, dims[1] * k, dims[2] * k], yaw)) {
      entry.ok = false;
      entry.rejected = 'outside';
    } else if (check.warnings.includes('slope')) {
      entry.ok = false;
      entry.rejected = 'slope';
    } else if (fp && ((ctx.existing && ctx.existing.overlaps(fp)) || own.overlaps(fp))) {
      if (s.avoidCollisions) {
        entry.ok = false;
        entry.rejected = 'collision';
      } else entry.warnings.push('overlap');
    }
    if (entry.ok && fp) own.add(fp, String(startIndex + i));
    out.push(entry);
  });
  return out;
}

/** The inputs of the accepted plan entries. */
export function acceptedInputs(plan: readonly PlannedObject[]): CreateObjectInput[] {
  return plan.filter((p) => p.ok).map((p) => p.input);
}
