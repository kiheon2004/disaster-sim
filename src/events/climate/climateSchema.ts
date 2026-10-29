/** Validation of climate experiment specs (Phase 30; saved experiment plans). Reasons are i18n keys. */
import { z } from 'zod';
import { CLIMATE_LIMITS, CLIMATE_SCENARIOS, FORCING_MODES, PRECIP_PHASES, SOLAR_MODES, climateIssues, type ClimateSpec } from '@/climate/types';
import { CLIMATE_PROFILES, PRECIP_PROFILES } from '@/climate/profiles';

const finite = z.number().refine(Number.isFinite);
const point = z.tuple([finite, finite]);
const e = (v: readonly string[]) => z.enum(v as [string, ...string[]]);

export const climateSchema = z.object({
  event: z.literal('climate'),
  scenario: e(CLIMATE_SCENARIOS),
  forcing: e(FORCING_MODES),
  temperature: finite,
  target: finite,
  profile: e(CLIMATE_PROFILES),
  duration: finite,
  ramp: finite.optional(),
  stages: z.array(point).max(24).optional(),
  period: finite.optional(),
  windows: z.array(point).max(24).optional(),
  humidity: finite,
  humidityTarget: finite.optional(),
  mixTime: finite.optional(),
  precipitation: finite.optional(),
  precipPhase: e(PRECIP_PHASES).optional(),
  precipStart: finite.optional(),
  precipDuration: finite.optional(),
  precipProfile: e(PRECIP_PROFILES).optional(),
  precipRamp: finite.optional(),
  precipWindows: z.array(point).max(24).optional(),
  area: z.object({ center: point, radius: finite }).nullable().optional(),
  solar: e(SOLAR_MODES),
  latitude: finite.optional(),
  dayOfYear: finite.optional(),
  hour: finite.optional(),
  irradiance: finite.optional(),
  cloud: finite.optional(),
  initialSnow: finite.optional(),
  initialSnowDensity: finite.optional(),
  roofSnow: z.boolean().optional(),
  initialIce: finite.optional(),
  initialFrost: finite.optional(),
  soilMoisture: finite,
  blowingSnow: z.boolean().optional(),
  startTime: z.number().min(0).optional(),
  name: z.string().max(40).optional(),
}).superRefine((s, ctx) => {
  for (const key of climateIssues(s as unknown as ClimateSpec)) ctx.addIssue({ code: 'custom', message: key });
}) as unknown as z.ZodType<ClimateSpec>;

export { CLIMATE_LIMITS };
