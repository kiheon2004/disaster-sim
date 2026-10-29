/** Validation of sinkhole / landslide specs (Phase 22; saved experiment plans, commands). */
import { z } from 'zod';
import { MECHANICAL_IDS } from '@/ground/materials';
import { LANDSLIDE_LIMITS, LANDSLIDE_TRIGGERS, SINKHOLE_INITIATIONS, SINKHOLE_LIMITS, type LandslideSpec, type SinkholeSpec } from '@/ground/types';

const finite = z.number().refine(Number.isFinite);
const range = ([lo, hi]: readonly [number, number]) => finite.refine((v) => v >= lo && v <= hi, { message: `${lo}–${hi}` });
const point = z.tuple([finite, finite]);
const material = z.enum(MECHANICAL_IDS as unknown as [string, ...string[]]).optional();

export const sinkholeSchema = z.object({
  event: z.literal('sinkhole'),
  center: point,
  cavityRadius: range(SINKHOLE_LIMITS.cavityRadius),
  cavityHeight: range(SINKHOLE_LIMITS.cavityHeight),
  cover: range(SINKHOLE_LIMITS.cover),
  material,
  initiation: z.enum(SINKHOLE_INITIATIONS as unknown as [string, ...string[]]),
  growthRate: range(SINKHOLE_LIMITS.growthRate).optional(),
  supportLoss: range(SINKHOLE_LIMITS.supportLoss).optional(),
  saturation: range(SINKHOLE_LIMITS.saturation).optional(),
  surcharge: range(SINKHOLE_LIMITS.surcharge).optional(),
  duration: range(SINKHOLE_LIMITS.duration),
  variability: range(SINKHOLE_LIMITS.variability).optional(),
  seed: z.number().int().nonnegative().optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}) as unknown as z.ZodType<SinkholeSpec>;

const area = z.union([
  z.object({ kind: z.literal('circle'), center: point, radius: range(LANDSLIDE_LIMITS.radius) }),
  z.object({ kind: z.literal('polygon'), points: z.array(point).min(3).max(64) }),
]);

export const landslideSchema = z.object({
  event: z.literal('landslide'),
  area,
  thickness: range(LANDSLIDE_LIMITS.thickness),
  material,
  saturation: range(LANDSLIDE_LIMITS.saturation),
  trigger: z.enum(LANDSLIDE_TRIGGERS as unknown as [string, ...string[]]),
  targetSaturation: range(LANDSLIDE_LIMITS.saturation).optional(),
  duration: range(LANDSLIDE_LIMITS.duration),
  newmarkLimit: range(LANDSLIDE_LIMITS.newmarkLimit).optional(),
  turbulence: range(LANDSLIDE_LIMITS.turbulence).optional(),
  boundary: z.enum(['closed', 'open']).optional(),
  variability: range(LANDSLIDE_LIMITS.variability).optional(),
  seed: z.number().int().nonnegative().optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}) as unknown as z.ZodType<LandslideSpec>;
