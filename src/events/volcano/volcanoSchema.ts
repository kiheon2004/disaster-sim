/** Validation of volcano scenario specs (Phase 28; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { VOLCANO_LIMITS, volcanoIssues, type VolcanoSpec } from '@/volcano/types';
import { LAVA_MATERIALS, LAVA_MATERIAL_IDS } from '@/volcano/materials';
import { ZERO_C } from '@/thermal/units';

const finite = z.number().refine(Number.isFinite);
const point = z.tuple([finite, finite]);

/** Eruption temperature range offered for a material (°C). */
export const temperatureRange = (m: string): [number, number] => {
  const mat = LAVA_MATERIALS[m as keyof typeof LAVA_MATERIALS];
  return mat ? [Math.round(mat.Trange[0] - ZERO_C), Math.round(mat.Trange[1] - ZERO_C)] : [0, 0];
};

export const volcanoSchema = z.object({
  event: z.literal('volcano'),
  vents: z.array(z.object({ kind: z.enum(['central', 'fissure']), position: point, end: point.optional(), radius: finite, share: finite.optional() })).max(VOLCANO_LIMITS.vents[1]),
  material: z.enum(['basalt', 'andesite']),
  temperature: finite,
  rate: finite,
  duration: finite,
  profile: z.enum(['constant', 'ramp', 'pulse', 'staged', 'wane']),
  rampTime: finite.optional(),
  period: finite.optional(),
  pulseWidth: finite.optional(),
  stages: z.array(finite).max(VOLCANO_LIMITS.stages[1]).optional(),
  declineTime: finite.optional(),
  bombFraction: finite.optional(),
  ashFraction: finite.optional(),
  plumeHeight: finite.optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  for (const key of volcanoIssues(s as unknown as VolcanoSpec, LAVA_MATERIAL_IDS, temperatureRange)) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<VolcanoSpec>;

export { VOLCANO_LIMITS };
