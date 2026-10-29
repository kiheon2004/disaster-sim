/** Validation of terrain deformation specs (Phase 21; saved experiment plans, commands). */
import { z } from 'zod';
import { DEFORMATION_KINDS, FALLOFFS, TIME_PROFILES, type TerrainDeformationSpec } from '@/deformation/types';
import { LIMITS } from '@/deformation/field';

const finite = z.number().refine(Number.isFinite);
const range = ([lo, hi]: readonly [number, number]) => finite.refine((v) => v >= lo && v <= hi, { message: `${lo}–${hi}` });

export const prescribedFieldSchema = z.object({
  x0: finite, z0: finite,
  cell: z.number().positive().max(50),
  nx: z.number().int().min(1).max(2001),
  nz: z.number().int().min(1).max(2001),
  values: z.array(range([-LIMITS.amount[1], LIMITS.amount[1]])).max(LIMITS.fieldCells),
}).refine((f) => f.values.length === f.nx * f.nz, { message: 'values.length ≠ nx × nz' });

export const terrainDeformationSchema = z.object({
  event: z.literal('terrainDeformation'),
  kind: z.enum(DEFORMATION_KINDS as [string, ...string[]]),
  center: z.tuple([finite, finite]),
  radius: range(LIMITS.radius),
  amount: range(LIMITS.amount),
  duration: range(LIMITS.duration),
  profile: z.enum(TIME_PROFILES as [string, ...string[]]),
  stages: range(LIMITS.stages).optional(),
  period: range(LIMITS.period).optional(),
  falloff: z.enum(FALLOFFS as [string, ...string[]]).optional(),
  length: range(LIMITS.length).optional(),
  bearing: finite.optional(),
  variability: range(LIMITS.variability).optional(),
  seed: z.number().int().nonnegative().optional(),
  supportLoss: range(LIMITS.supportLoss).optional(),
  field: prescribedFieldSchema.optional(),
  startTime: z.number().min(0).optional(),
}).refine((s) => s.kind !== 'prescribed' || !!s.field, { message: 'prescribed field missing' }) as unknown as z.ZodType<TerrainDeformationSpec>;
