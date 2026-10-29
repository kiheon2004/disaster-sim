/** Validation of heat-source specs (Phase 26; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { HEAT_LIMITS, HEAT_SOURCE_KINDS, heatSourceIssues, type HeatSourceSpec } from '@/thermal/types';
import { PROFILE_KINDS, profileIssues } from '@/thermal/profiles';

const finite = z.number().refine(Number.isFinite);

export const heatSourceSchema = z.object({
  event: z.literal('heatSource'),
  kind: z.enum(HEAT_SOURCE_KINDS as unknown as [string, ...string[]]),
  position: z.tuple([finite, finite]),
  height: finite,
  radius: finite,
  input: z.enum(['power', 'energy']),
  power: finite.optional(),
  energy: finite.optional(),
  temperature: finite.optional(),
  radiativeFraction: finite.optional(),
  profile: z.enum(PROFILE_KINDS as unknown as [string, ...string[]]),
  duration: finite,
  rampTime: finite.optional(),
  pulseWidth: finite.optional(),
  period: finite.optional(),
  schedule: z.array(z.tuple([finite, finite])).max(16).optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  const spec = s as unknown as HeatSourceSpec;
  for (const key of [...heatSourceIssues(spec), ...profileIssues(spec)]) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<HeatSourceSpec>;

export { HEAT_LIMITS };
