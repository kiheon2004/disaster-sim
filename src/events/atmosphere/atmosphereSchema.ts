/** Validation of atmosphere experiment specs (Phase 29; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { ATMOS_LIMITS, BOUNDARY_MODES, REMOVAL_EXTENTS, REMOVAL_PROFILES, RESTORE_MODES, THERMO_MODES, atmosphereIssues, type AtmosphereSpec } from '@/atmosphere/types';

const finite = z.number().refine(Number.isFinite);
const point = z.tuple([finite, finite]);

export const atmosphereSchema = z.object({
  event: z.literal('atmosphere'),
  altitude: finite,
  pressure: finite.optional(),
  temperature: finite.optional(),
  boundary: z.enum(BOUNDARY_MODES as [string, ...string[]]),
  thermo: z.enum(THERMO_MODES as [string, ...string[]]).optional(),
  removal: z.enum(REMOVAL_PROFILES as [string, ...string[]]),
  extent: z.enum(REMOVAL_EXTENTS as [string, ...string[]]).optional(),
  target: finite.optional(),
  duration: finite.optional(),
  schedule: z.array(point).max(24).optional(),
  position: point.optional(),
  radius: finite.optional(),
  restore: z.enum(RESTORE_MODES as [string, ...string[]]).optional(),
  restoreAt: finite.optional(),
  restoreDuration: finite.optional(),
  restoreTarget: finite.optional(),
  coupleBlast: z.boolean().optional(),
  coupleMeteor: z.boolean().optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  for (const key of atmosphereIssues(s as unknown as AtmosphereSpec)) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<AtmosphereSpec>;

export { ATMOS_LIMITS };
