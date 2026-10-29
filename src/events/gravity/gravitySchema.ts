/** Validation of gravity experiment specs (Phase 31; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { FALLOFFS, GRAVITY_ENDS, GRAVITY_LIMITS, GRAVITY_SCENARIOS, GRAVITY_TRANSITIONS, RADIAL_LAWS, REGION_MODES, REGION_SHAPES, SOURCE_KINDS, gravityIssues, type GravitySpec } from '@/gravity/types';
import { GRAVITY_PROFILES } from '@/gravity/profiles';

const finite = z.number().refine(Number.isFinite);
const vec = z.tuple([finite, finite, finite]);
const point = z.tuple([finite, finite]);
const e = (v: readonly string[]) => z.enum(v as [string, ...string[]]);

const source = z.object({
  kind: e(SOURCE_KINDS),
  center: vec,
  radius: finite,
  edge: finite.optional(),
  falloff: e(FALLOFFS),
  shape: e(REGION_SHAPES).optional(),
  mode: e(REGION_MODES).optional(),
  accel: vec.optional(),
  strength: finite.optional(),
  r0: finite.optional(),
  law: e(RADIAL_LAWS).optional(),
  softening: finite.optional(),
  followProfile: z.boolean().optional(),
});

export const gravitySchema = z.object({
  event: z.literal('gravity'),
  scenario: e(GRAVITY_SCENARIOS),
  global: z.boolean(),
  magnitude: finite,
  direction: vec,
  transition: e(GRAVITY_TRANSITIONS),
  profile: e(GRAVITY_PROFILES),
  duration: finite,
  ramp: finite.optional(),
  stages: z.array(point).max(24).optional(),
  period: finite.optional(),
  pulseWidth: finite.optional(),
  windows: z.array(point).max(24).optional(),
  end: e(GRAVITY_ENDS),
  sources: z.array(source).max(GRAVITY_LIMITS.sources),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  for (const key of gravityIssues(s as unknown as GravitySpec)) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<GravitySpec>;
