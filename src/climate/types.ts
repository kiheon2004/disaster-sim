/**
 * Climate experiment spec (Phase 30) — saved in the experiment plan (schema v7, validated per instance).
 * Temperatures are stored in K (the editor shows °C), humidity as a fraction, rates in mm/h of water.
 *
 *  scenario      a label of the experiment (heatwave, coldWave, …) — it selects defaults in the editor and the
 *                milestone wording; the physics is set by the fields below, never by the label
 *  forcing       flux: the free atmosphere above the near-surface air layer follows the temperature / humidity
 *                profile; the layer relaxes toward it with the boundary-layer mixing time and air entering at the
 *                edges is background air (the surfaces keep their own energy balance)
 *                prescribed: the air-layer temperature IS the profile value every step (an infinite reservoir —
 *                the heat this takes or gives is booked as external)
 *  temperature   start / reference air temperature (becomes the thermal reference when the climate comes first)
 *  target, profile, ramp, stages, period, windows   the temperature path (profiles.ts)
 *  humidity      background relative humidity at the start (over liquid water), humidityTarget at the end of the
 *                path (it follows the temperature path's shape); the air's VAPOUR MASS is the state, RH is derived
 *  precipitation rate (mm/h of water) with its phase (auto: wet-bulb split; snow; rain — freezing rain when the
 *                surfaces are below 0 °C), window and shape, optionally only over a disc
 *  solar         off | clearSky (latitude, day of year, local solar hour at the start, cloud cover) |
 *                constant (global horizontal irradiance, the sun direction frozen at the start time)
 *  initial state snow depth / density on the ground (and roofs, crowns), ice on water surfaces, frozen ground depth,
 *                antecedent soil moisture (volumetric) — a starting condition, booked as initial storage
 */
import { AMBIENT_LIMITS } from '@/thermal/units';
import { CLIMATE_PROFILES, PRECIP_PROFILES, shapeOf, valueAt, type ClimateProfileKind, type PrecipProfileKind } from './profiles';
import { T_MELT } from './constants';
import { humidityFromRH, wetBulb } from './psychro';
import { STANDARD_PRESSURE } from '@/thermal/units';

export type ClimateScenario =
  | 'heatwave' | 'coldWave' | 'rapidCooling' | 'rapidWarming' | 'snowfall' | 'freezingRain' | 'frost' | 'roadIcing'
  | 'lakeFreezing' | 'snowmelt' | 'thawing' | 'drying' | 'humid' | 'custom';
export const CLIMATE_SCENARIOS: readonly ClimateScenario[] = [
  'heatwave', 'coldWave', 'rapidCooling', 'rapidWarming', 'snowfall', 'freezingRain', 'frost', 'roadIcing', 'lakeFreezing', 'snowmelt', 'thawing', 'drying', 'humid', 'custom',
];
export type ForcingMode = 'flux' | 'prescribed';
export const FORCING_MODES: readonly ForcingMode[] = ['flux', 'prescribed'];
export type PrecipPhase = 'auto' | 'snow' | 'rain';
export const PRECIP_PHASES: readonly PrecipPhase[] = ['auto', 'snow', 'rain'];
export type SolarMode = 'off' | 'clearSky' | 'constant';
export const SOLAR_MODES: readonly SolarMode[] = ['off', 'clearSky', 'constant'];

export interface ClimateSpec {
  event: 'climate';
  scenario: ClimateScenario;
  forcing: ForcingMode;
  /** Start air temperature (K). */
  temperature: number;
  /** Target air temperature (K). */
  target: number;
  profile: ClimateProfileKind;
  /** Experiment duration (s). */
  duration: number;
  ramp?: number;
  stages?: [number, number][];
  period?: number;
  windows?: [number, number][];
  /** Background relative humidity at the start / end of the path (0–1, over liquid water). */
  humidity: number;
  humidityTarget?: number;
  /** Boundary-layer mixing time of the flux forcing (s). */
  mixTime?: number;
  /** Precipitation (mm/h of water) and its phase, window and shape. */
  precipitation?: number;
  precipPhase?: PrecipPhase;
  precipStart?: number;
  precipDuration?: number;
  precipProfile?: PrecipProfileKind;
  precipRamp?: number;
  precipWindows?: [number, number][];
  /** Precipitation only over this disc (null / absent = the whole world). */
  area?: { center: [number, number]; radius: number } | null;
  solar: SolarMode;
  latitude?: number;
  dayOfYear?: number;
  /** Local solar time at the start (h, 0–24). */
  hour?: number;
  /** Constant mode: global horizontal irradiance (W/m²). */
  irradiance?: number;
  cloud?: number;
  /** Initial snow depth on the ground (m) and its density (kg/m³); also on roofs and crowns unless roofSnow = false. */
  initialSnow?: number;
  initialSnowDensity?: number;
  roofSnow?: boolean;
  /** Initial ice thickness on water surfaces (m). */
  initialIce?: number;
  /** Initial frozen-ground depth (m, ≤ 0.8 — the depth of the thermal ground columns). */
  initialFrost?: number;
  /** Antecedent volumetric soil moisture (m³/m³). */
  soilMoisture: number;
  /** Wind redistribution of loose snow (blowing snow). */
  blowingSnow?: boolean;
  startTime?: number;
  name?: string;
}

export const CLIMATE_LIMITS = {
  temperature: AMBIENT_LIMITS,
  duration: [1, 172_800],
  ramp: [1, 172_800],
  period: [60, 172_800],
  humidity: [0.01, 1],
  mixTime: [60, 86_400],
  precipitation: [0, 300],
  /** Snowfall above this water-equivalent rate (mm/h, ≈ 30–50 cm of new snow per hour) exceeds observed extremes. */
  snowRate: [0, 30],
  latitude: [-90, 90],
  dayOfYear: [1, 365],
  hour: [0, 24],
  irradiance: [0, 1361],
  cloud: [0, 1],
  initialSnow: [0, 5],
  initialSnowDensity: [50, 550],
  initialIce: [0, 2],
  initialFrost: [0, 0.8],
  soilMoisture: [0, 0.5],
  radius: [2, 200],
} as const;

/** Snow cannot reach the ground through air whose wet-bulb temperature stays above this (K) — input rejected. */
export const SNOW_MAX_WETBULB = T_MELT + 3;
/** Background RH below this during snowfall: sublimation of the falling snow (not modelled) would be large — warned. */
export const DRY_SNOWFALL_RH = 0.3;

export const defaultClimateSpec = (): ClimateSpec => ({
  event: 'climate', scenario: 'heatwave', forcing: 'flux', temperature: T_MELT + 25, target: T_MELT + 38, profile: 'smooth', duration: 3600, ramp: 1800,
  humidity: 0.4, humidityTarget: 0.25, mixTime: 900, precipitation: 0, precipPhase: 'auto', precipProfile: 'constant',
  solar: 'clearSky', latitude: 37.5, dayOfYear: 200, hour: 11, cloud: 0, soilMoisture: 0.25, blowingSnow: true, roofSnow: true,
});

/** Values of the temperature path (start, target, stages) — for range checks. */
export function pathTemperatures(s: ClimateSpec): number[] {
  const out = [s.temperature, s.target];
  if (s.profile === 'staged') for (const [, v] of s.stages ?? []) out.push(v);
  return out;
}

/** Problems of a spec as i18n keys (empty = valid). Impossible input is explained, never silently fixed. */
export function climateIssues(s: ClimateSpec): string[] {
  const out: string[] = [];
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const inRange = (v: number | undefined, [lo, hi]: readonly [number, number]) => fin(v) && v >= lo && v <= hi;
  if (!CLIMATE_SCENARIOS.includes(s.scenario)) out.push('climate.invalid.scenario');
  if (!FORCING_MODES.includes(s.forcing)) out.push('climate.invalid.forcing');
  for (const T of pathTemperatures(s)) {
    if (fin(T) && T <= 0) { out.push('climate.invalid.absoluteZero'); break; }
    if (!inRange(T, CLIMATE_LIMITS.temperature)) { out.push('climate.invalid.temperature'); break; }
  }
  if (!CLIMATE_PROFILES.includes(s.profile)) out.push('climate.invalid.profile');
  if (!inRange(s.duration, CLIMATE_LIMITS.duration)) out.push('climate.invalid.duration');
  const D = fin(s.duration) ? s.duration : 0;
  if ((s.profile === 'linear' || s.profile === 'smooth') && !(inRange(s.ramp, CLIMATE_LIMITS.ramp) && (s.ramp as number) <= D)) out.push('climate.invalid.ramp');
  if (s.profile === 'cyclic' && !inRange(s.period, CLIMATE_LIMITS.period)) out.push('climate.invalid.period');
  if (s.profile === 'staged') {
    const st = s.stages ?? [];
    let last = -Infinity;
    const ok = st.length > 0 && st.every(([t, v]) => fin(t) && fin(v) && t >= 0 && t < D && t > last && ((last = t), true));
    if (!ok) out.push('climate.invalid.stages');
  }
  if (s.profile === 'scheduled' && !windowsOk(s.windows, D)) out.push('climate.invalid.windows');
  if (!fin(s.humidity) || s.humidity > 1) out.push(fin(s.humidity) && s.humidity > 1 ? 'climate.invalid.supersaturated' : 'climate.invalid.humidity');
  else if (!inRange(s.humidity, CLIMATE_LIMITS.humidity)) out.push('climate.invalid.humidity');
  if (s.humidityTarget !== undefined) {
    if (fin(s.humidityTarget) && s.humidityTarget > 1) out.push('climate.invalid.supersaturated');
    else if (!inRange(s.humidityTarget, CLIMATE_LIMITS.humidity)) out.push('climate.invalid.humidity');
  }
  if (s.forcing === 'flux' && s.mixTime !== undefined && !inRange(s.mixTime, CLIMATE_LIMITS.mixTime)) out.push('climate.invalid.mixTime');
  const P = s.precipitation ?? 0;
  if (!inRange(P, CLIMATE_LIMITS.precipitation)) out.push(fin(P) && P < 0 ? 'climate.invalid.precipSign' : 'climate.invalid.precipitation');
  if (P > 0) {
    const phase = s.precipPhase ?? 'auto';
    if (!PRECIP_PHASES.includes(phase)) out.push('climate.invalid.precipPhase');
    const st = s.precipStart ?? 0, pd = s.precipDuration ?? D - st;
    if (!(fin(st) && st >= 0 && st < D)) out.push('climate.invalid.precipStart');
    if (!(fin(pd) && pd > 0 && st + pd <= D + 1e-9)) out.push('climate.invalid.precipDuration');
    const pp = s.precipProfile ?? 'constant';
    if (!PRECIP_PROFILES.includes(pp)) out.push('climate.invalid.precipProfile');
    if (pp === 'rampUp' && !(fin(s.precipRamp) && s.precipRamp > 0 && s.precipRamp <= pd)) out.push('climate.invalid.precipRamp');
    if (pp === 'scheduled' && !windowsOk(s.precipWindows, pd)) out.push('climate.invalid.precipWindows');
    if (phase === 'snow') {
      if (P > CLIMATE_LIMITS.snowRate[1]) out.push('climate.invalid.snowRate');
      // Snow forced through air whose wet bulb is above +3 °C over the whole window cannot reach the ground.
      if (out.length === 0 && warmestWetBulbMin(s) > SNOW_MAX_WETBULB) out.push('climate.invalid.snowTooWarm');
    }
    if (s.area) {
      if (!Array.isArray(s.area.center) || !fin(s.area.center[0]) || !fin(s.area.center[1])) out.push('climate.invalid.position');
      if (!inRange(s.area.radius, CLIMATE_LIMITS.radius)) out.push('climate.invalid.radius');
    }
  }
  if (!SOLAR_MODES.includes(s.solar)) out.push('climate.invalid.solar');
  if (s.solar === 'clearSky') {
    if (!inRange(s.latitude, CLIMATE_LIMITS.latitude)) out.push('climate.invalid.latitude');
    if (!inRange(s.dayOfYear, CLIMATE_LIMITS.dayOfYear)) out.push('climate.invalid.day');
    if (!inRange(s.hour, CLIMATE_LIMITS.hour)) out.push('climate.invalid.hour');
  }
  if (s.solar === 'constant' && !inRange(s.irradiance, CLIMATE_LIMITS.irradiance)) out.push(fin(s.irradiance) && s.irradiance > 1361 ? 'climate.invalid.aboveSolarConstant' : 'climate.invalid.irradiance');
  if (s.solar !== 'off' && s.cloud !== undefined && !inRange(s.cloud, CLIMATE_LIMITS.cloud)) out.push('climate.invalid.cloud');
  if (s.initialSnow !== undefined && !inRange(s.initialSnow, CLIMATE_LIMITS.initialSnow)) out.push('climate.invalid.initialSnow');
  if ((s.initialSnow ?? 0) > 0 && s.initialSnowDensity !== undefined && !inRange(s.initialSnowDensity, CLIMATE_LIMITS.initialSnowDensity)) out.push('climate.invalid.snowDensity');
  if ((s.initialSnow ?? 0) > 0 && fin(s.temperature) && s.temperature > T_MELT + 15) out.push('climate.invalid.snowWarmStart');
  if (s.initialIce !== undefined && !inRange(s.initialIce, CLIMATE_LIMITS.initialIce)) out.push('climate.invalid.initialIce');
  if ((s.initialIce ?? 0) > 0 && fin(s.temperature) && s.temperature > T_MELT + 15) out.push('climate.invalid.iceWarmStart');
  if (s.initialFrost !== undefined && !inRange(s.initialFrost, CLIMATE_LIMITS.initialFrost)) out.push('climate.invalid.initialFrost');
  if ((s.initialFrost ?? 0) > 0 && fin(s.temperature) && s.temperature > T_MELT + 15) out.push('climate.invalid.frostWarmStart');
  if (!inRange(s.soilMoisture, CLIMATE_LIMITS.soilMoisture)) out.push('climate.invalid.soilMoisture');
  return out;
}

function windowsOk(w: [number, number][] | undefined, D: number): boolean {
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const list = w ?? [];
  let last = 0;
  return list.length > 0 && list.every(([a, b]) => { const good = fin(a) && fin(b) && a >= last && b > a && b <= D + 1e-9; last = b; return good; });
}

/** Lowest background wet-bulb temperature along the path during the precipitation window (K) — sampled. */
function warmestWetBulbMin(s: ClimateSpec): number {
  const st = s.precipStart ?? 0, pd = s.precipDuration ?? s.duration - st;
  const vp = { profile: s.profile, duration: s.duration, ramp: s.ramp, stages: s.stages, period: s.period, windows: s.windows };
  let lo = Infinity;
  for (let k = 0; k <= 64; k++) {
    const t = st + (pd * k) / 64;
    const T = valueAt(vp, s.temperature, s.target, t);
    const RH = s.humidity + ((s.humidityTarget ?? s.humidity) - s.humidity) * shapeOf(vp, s.temperature, s.target, t);
    const q = humidityFromRH(Math.min(1, RH), T, STANDARD_PRESSURE);
    lo = Math.min(lo, wetBulb(T, q, STANDARD_PRESSURE));
  }
  return lo;
}

/** Non-blocking warnings (i18n keys): valid input outside the model's resolved range, or a label mismatch. */
export function climateWarnings(s: ClimateSpec): string[] {
  const out: string[] = [];
  const P = s.precipitation ?? 0;
  if (s.scenario === 'heatwave' && s.target < s.temperature) out.push('climate.warn.heatwaveCooling');
  if (s.scenario === 'coldWave' && s.target > s.temperature) out.push('climate.warn.coldWaveWarming');
  if (P > 0 && (s.precipPhase ?? 'auto') !== 'rain' && Math.min(s.humidity, s.humidityTarget ?? s.humidity) < DRY_SNOWFALL_RH) out.push('climate.warn.drySnowfall');
  if (P > 0 && s.precipPhase === 'rain' && Math.max(...pathTemperatures(s)) < T_MELT - 15) out.push('climate.warn.coldRain');
  if (s.forcing === 'prescribed') out.push('climate.warn.prescribed');
  if (Math.max(...pathTemperatures(s)) > T_MELT + 50 || Math.min(...pathTemperatures(s)) < T_MELT - 50) out.push('climate.warn.extremeRange');
  if ((s.initialIce ?? 0) > 0.5) out.push('climate.warn.thickIce');
  return out;
}
