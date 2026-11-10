/** Validation of vortex specs (Phase 35.5; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { TORNADO_LIMITS, type TornadoSpec } from '@/vortex/types';

const finite = z.number().refine(Number.isFinite);
const inRange = (k: keyof typeof TORNADO_LIMITS) => finite.refine((v) => v >= TORNADO_LIMITS[k][0] && v <= TORNADO_LIMITS[k][1], { message: `vortex.err.${k}` });

export const vortexSchema = z.object({
  event: z.literal('tornado'),
  position: z.tuple([finite, finite]),
  maxSpeed: inRange('maxSpeed'),
  coreRadius: inRange('coreRadius'),
  outerRadius: inRange('outerRadius'),
  shape: inRange('shape').optional(),
  inflowAngle: inRange('inflowAngle').optional(),
  rotation: z.enum(['ccw', 'cw']).optional(),
  trackSpeed: inRange('trackSpeed').optional(),
  trackBearing: finite.optional(),
  duration: inRange('duration'),
  rampDuration: inRange('rampDuration').optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  if (s.outerRadius < 1.25 * s.coreRadius) ctx.addIssue({ code: 'custom', message: 'vortex.err.outer' });
}) as unknown as z.ZodType<TornadoSpec>;
