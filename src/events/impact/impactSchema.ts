/** Validation of impact specs (Phase 23; saved experiment plans, commands). */
import { z } from 'zod';
import { IMPACT_LIMITS, PROJECTILE_MATERIALS, type ImpactSpec } from '@/impact/types';
import { sphereMass } from '@/impact/projectile';
import { PROJECTILES } from '@/impact/projectile';

const finite = z.number().refine(Number.isFinite);
const range = ([lo, hi]: readonly [number, number]) => finite.refine((v) => v >= lo && v <= hi, { message: `${lo}–${hi}` });

export const impactSchema = z.object({
  event: z.literal('impact'),
  target: z.tuple([finite, finite]),
  material: z.enum(PROJECTILE_MATERIALS as unknown as [string, ...string[]]),
  diameter: range(IMPACT_LIMITS.diameter),
  density: range(IMPACT_LIMITS.density).optional(),
  mass: finite.refine((v) => v > 0).optional(),
  speed: range(IMPACT_LIMITS.speed),
  angle: range(IMPACT_LIMITS.angle),
  azimuth: finite,
  entry: z.enum(['atmosphere', 'direct']),
  airBlast: z.boolean().optional(),
  airCoupling: range(IMPACT_LIMITS.airCoupling).optional(),
  thermalShare: range(IMPACT_LIMITS.thermalShare).optional(),
  seed: z.number().int().nonnegative().optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).refine((s) => {
  // A given mass must agree with the sphere of the given diameter and density (1 %).
  if (s.mass === undefined) return true;
  const rho = s.density ?? PROJECTILES[s.material as ImpactSpec['material']].density;
  const m = sphereMass(s.diameter, rho);
  return Math.abs(s.mass - m) <= 0.01 * m;
}, { message: 'mass ≠ π/6·L³·ρ' }) as unknown as z.ZodType<ImpactSpec>;
