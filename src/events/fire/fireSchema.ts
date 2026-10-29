/** Validation of fire scenario specs (Phase 27; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { FIRE_LIMITS, fireIssues, type FireSpec } from '@/fire/types';

const finite = z.number().refine(Number.isFinite);

export const fireSchema = z.object({
  event: z.literal('fire'),
  position: z.tuple([finite, finite]),
  height: finite,
  radius: finite,
  target: z.string().max(64).optional(),
  duration: finite,
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  for (const key of fireIssues(s as unknown as FireSpec)) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<FireSpec>;

export { FIRE_LIMITS };
