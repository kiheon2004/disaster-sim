/** Validation of air-blast specs (Phase 24; saved experiment plans, commands). */
import { z } from 'zod';
import { BLAST_LIMITS, BLAST_MODELS, BLAST_WAVEFORMS, type BlastSpec } from '@/blast/types';

const finite = z.number().refine(Number.isFinite);
const range = ([lo, hi]: readonly [number, number]) => finite.refine((v) => v >= lo && v <= hi, { message: `${lo}–${hi}` });

export const blastSchema = z.object({
  event: z.literal('blast'),
  position: z.tuple([finite, finite]),
  height: range(BLAST_LIMITS.height),
  energy: range(BLAST_LIMITS.energy),
  model: z.enum(BLAST_MODELS as unknown as [string, ...string[]]),
  waveform: z.enum(BLAST_WAVEFORMS as unknown as [string, ...string[]]),
  ambientPressure: range(BLAST_LIMITS.ambientPressure).optional(),
  ambientDensity: range(BLAST_LIMITS.ambientDensity).optional(),
  seed: z.number().int().nonnegative().optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}) as unknown as z.ZodType<BlastSpec>;
