/** zod contract of a WindEventSpec (moved from commands/schema.ts in Phase 15; re-exported there). */
import { z } from 'zod';
import { COMPASS_DIRS } from '@/core/compass';

export const compassSchema = z.enum(COMPASS_DIRS);

export const windEventSchema = z.object({
  event: z.literal('wind'),
  speed: z.number().min(0).max(150).describe('Target mean wind speed at 10 m height, m/s'),
  direction: z.union([compassSchema, z.number().min(0).max(360)]).describe('Direction the wind blows FROM (compass point or bearing in degrees)'),
  duration: z.number().positive().max(3600).describe('Total event length in seconds'),
  gustStrength: z.number().min(0).max(1).optional().describe('Gust intensity 0–1'),
  startTime: z.number().min(0).optional().describe('Absolute simulation start time in seconds (default: now)'),
  rampFrom: z.number().min(0).max(150).optional().describe('Speed at ramp start (default: current wind)'),
  rampDuration: z.number().positive().max(3600).optional().describe('Seconds to reach the target speed'),
});

