/**
 * zod contracts of the water events (Phase 14) — shared by the command system (parser / LLM
 * output) and the project file (the saved flood scenario).
 */
import { z } from 'zod';
import { FLOOD_LIMITS } from './resolveFlood';

const side = z.enum(['N', 'E', 'S', 'W']);
const xz = z.tuple([z.number(), z.number()]);
const lim = (k: keyof typeof FLOOD_LIMITS) => z.number().min(FLOOD_LIMITS[k][0]).max(FLOOD_LIMITS[k][1]);

export const rainEventSchema = z.object({
  event: z.literal('rain'),
  intensity: lim('rainIntensity').describe('Rainfall intensity in mm/h (mm of water depth per hour)'),
  duration: lim('duration').describe('Seconds of rain'),
  area: z.object({ center: xz, radius: lim('radius') }).nullable().optional().describe('Circular area [x, z] (m) + radius; omitted = whole map'),
  startTime: z.number().min(0).optional().describe('Absolute simulation start time in seconds (default: now)'),
});

export const risingWaterEventSchema = z.object({
  event: z.literal('risingWater'),
  boundary: side.describe('Map edge: N (−z), E (+x), S (+z), W (−x)'),
  level: lim('level').describe('Target water SURFACE ELEVATION in m on the terrain datum (not a depth)'),
  riseRate: lim('riseRate').optional().describe('Rise rate in m/min (default 0.5)'),
  duration: lim('duration').optional().describe('Total seconds incl. the rise (default: rise time + 180 s)'),
  startTime: z.number().min(0).optional(),
});

export const waterSourceEventSchema = z.object({
  event: z.literal('waterSource'),
  position: xz.describe('World [x, z] in m (map center = [0, 0])'),
  rate: lim('sourceRate').describe('Inflow in m³/s'),
  duration: lim('duration').describe('Seconds'),
  radius: lim('radius').optional().describe('Radius the inflow is spread over, m (default 2)'),
  startTime: z.number().min(0).optional(),
});
