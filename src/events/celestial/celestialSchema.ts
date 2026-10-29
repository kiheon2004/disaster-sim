/** Validation of celestial experiment specs (Phase 32; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { CELESTIAL_KINDS, CELESTIAL_LIMITS, CELESTIAL_SCALES, CELESTIAL_SCENARIOS, LIMIT_POLICIES, MASS_POLICIES, MOTION_KINDS, PROBE_MODES, celestialIssues, type CelestialSpec } from '@/celestial/types';

const finite = z.number().refine(Number.isFinite);
const vec = z.tuple([finite, finite, finite]);
const e = (v: readonly string[]) => z.enum(v as [string, ...string[]]);

const source = z.object({
  kind: e(CELESTIAL_KINDS),
  center: vec,
  mass: finite,
  softening: finite,
  capture: finite,
  influence: finite,
  massPolicy: e(MASS_POLICIES),
  motion: e(MOTION_KINDS),
  velocity: vec.optional(),
  path: z.array(z.tuple([finite, finite, finite, finite])).max(32).optional(),
  start: finite.optional(),
  end: finite.optional(),
  ramp: finite.optional(),
  refAccel: finite.optional(),
  refRadius: finite.optional(),
});

const probe = z.object({
  position: vec,
  mode: e(PROBE_MODES),
  factor: finite,
  direction: vec,
  velocity: vec.optional(),
  mass: finite,
  radius: finite,
  source: z.number().int().min(0).optional(),
});

export const celestialSchema = z.object({
  event: z.literal('celestial'),
  scenario: e(CELESTIAL_SCENARIOS),
  scale: e(CELESTIAL_SCALES),
  sources: z.array(source).max(CELESTIAL_LIMITS.sources),
  probes: z.array(probe).max(CELESTIAL_LIMITS.probes),
  accretion: z.object({ visual: z.boolean(), particles: finite, inner: finite, outer: finite, particleMass: finite, spread: finite.optional(), source: z.number().int().min(0).optional() }),
  duration: finite,
  end: e(['restore', 'hold']),
  tidal: z.boolean(),
  lensing: z.boolean(),
  limitPolicy: e(LIMIT_POLICIES),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  for (const key of celestialIssues(s as unknown as CelestialSpec)) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<CelestialSpec>;
