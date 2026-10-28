/**
 * zod contract of an EarthquakeEventSpec — shared by the command system (parser / LLM output)
 * and the project file format (the saved scenario).
 */
import { z } from 'zod';
import { EQ_LIMITS } from './resolveEarthquake';

export const earthquakeEventSchema = z.object({
  event: z.literal('earthquake'),
  magnitude: z.number().min(EQ_LIMITS.magnitude[0]).max(EQ_LIMITS.magnitude[1]).describe('Moment magnitude (source size; sets default duration and frequency)'),
  epicenter: z.tuple([z.number(), z.number()]).optional().describe('Epicenter [x, z] in world meters (map center = [0, 0]; may be far outside the map)'),
  depth: z.number().min(EQ_LIMITS.depth[0]).max(EQ_LIMITS.depth[1]).optional().describe('Hypocenter depth, km'),
  duration: z.number().min(EQ_LIMITS.duration[0]).max(EQ_LIMITS.duration[1]).optional().describe('Total event length in seconds'),
  pga: z.number().min(EQ_LIMITS.pga[0]).max(EQ_LIMITS.pga[1]).optional().describe('Peak horizontal ground acceleration on dense soil at the map center, in g (site intensity — independent of magnitude)'),
  dominantFrequency: z.number().min(EQ_LIMITS.frequency[0]).max(EQ_LIMITS.frequency[1]).optional().describe('Dominant shaking frequency, Hz'),
  direction: z.number().min(0).max(360).optional().describe('Bearing of the principal horizontal shaking axis in degrees (0 = N, 90 = E)'),
  verticalRatio: z.number().min(EQ_LIMITS.verticalRatio[0]).max(EQ_LIMITS.verticalRatio[1]).optional().describe('Peak vertical / peak horizontal acceleration'),
  seed: z.number().int().nonnegative().optional().describe('Waveform seed (default: project seed)'),
  startTime: z.number().min(0).optional().describe('Absolute simulation start time in seconds (default: now)'),
});
