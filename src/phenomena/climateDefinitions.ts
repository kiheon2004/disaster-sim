/**
 * Climate (Phase 30) for the phenomenon engine: a forcing path of the background air (temperature, humidity),
 * precipitation with its phase, the sun, and an initial snow / ice / frozen-ground state. Impossible input is rejected
 * by the schema with a reason. A local reduced climate model — not a weather forecast or a climate projection.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { ClimateEvent, describeClimate } from '@/events/climate/ClimateEvent';
import { climateSchema } from '@/events/climate/climateSchema';
import { CLIMATE_LIMITS, CLIMATE_SCENARIOS, FORCING_MODES, PRECIP_PHASES, SOLAR_MODES, defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import { CLIMATE_PROFILES, PRECIP_PROFILES } from '@/climate/profiles';
import { scenarioDefaults } from '@/climate/presets';
import { ZERO_C } from '@/thermal/units';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const C = (s: EventSpec) => s as unknown as ClimateSpec;
const put = (s: EventSpec, patch: Partial<ClimateSpec>) => ({ ...C(s), ...patch }) as unknown as EventSpec;
const opt = <T extends string>(prefix: string, values: readonly T[]) => values.map((v) => ({ value: v, labelKey: `${prefix}.${v}` as MessageKey }));
const ON_OFF = ['off', 'on'] as const;
const raining = (s: EventSpec) => (C(s).precipitation ?? 0) > 0;
const solarOn = (s: EventSpec) => C(s).solar !== 'off';
const celsius = (key: 'temperature' | 'target', labelKey: MessageKey): ParamField => ({
  key, labelKey, unit: '°C', min: CLIMATE_LIMITS.temperature[0] - ZERO_C, max: CLIMATE_LIMITS.temperature[1] - ZERO_C, step: 1, precision: 1,
  get: (s) => C(s)[key] - ZERO_C, set: (s, v) => put(s, { [key]: Number(v) + ZERO_C }),
});

export const climate = implemented<ClimateSpec>({
  type: 'climate', labelKey: 'phen.climate', icon: 'climate', status: 'implemented',
  channels: ['climate', 'temperature', 'water', 'airflow'],
  models: ['climateForcing', 'waterPhase', 'snowpack', 'iceCover', 'heatTransfer'],
  keywords: /폭염|한파|혹한|강설|폭설|눈|결빙|해빙|융설|서리|습도|증발|응결|heat\s*wave|cold\s*(?:wave|snap)|snow|frost|freez|thaw|humid|evaporat|icing/,
  schema: climateSchema,
  defaults: () => defaultClimateSpec(),
  seeded: false,
  fields: [
    {
      key: 'scenario', labelKey: 'climate.f.scenario', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.scenario', CLIMATE_SCENARIOS),
      // A scenario sets its own humidity path: a humidity target left from the previous one is dropped.
      set: (s, v) => put(s, { humidityTarget: undefined, ...scenarioDefaults(v as ClimateSpec['scenario']), scenario: v as ClimateSpec['scenario'] }),
    },
    { key: 'forcing', labelKey: 'climate.f.forcing', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.forcing', FORCING_MODES) },
    celsius('temperature', 'climate.f.temperature'),
    celsius('target', 'climate.f.target'),
    {
      key: 'profile', labelKey: 'climate.f.profile', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.profile', CLIMATE_PROFILES),
      set: (s, v) => {
        const sp = C(s), D = sp.duration, p = v as ClimateSpec['profile'];
        const patch: Partial<ClimateSpec> = { profile: p };
        if ((p === 'linear' || p === 'smooth') && !(sp.ramp && sp.ramp <= D)) patch.ramp = Math.round(D / 2);
        if (p === 'cyclic' && !sp.period) patch.period = Math.min(D, 86400);
        if (p === 'staged' && !sp.stages?.length) patch.stages = [[Math.round(D / 3), (sp.temperature + sp.target) / 2], [Math.round((2 * D) / 3), sp.target]];
        if (p === 'scheduled' && !sp.windows?.length) patch.windows = [[Math.round(D / 4), Math.round((3 * D) / 4)]];
        return put(s, patch);
      },
    },
    { key: 'duration', labelKey: 'climate.f.duration', unit: 'min', min: 1, max: CLIMATE_LIMITS.duration[1] / 60, step: 5, precision: 0, scale: 1 / 60 },
    { visible: (s) => C(s).profile === 'linear' || C(s).profile === 'smooth', key: 'ramp', labelKey: 'climate.f.ramp', unit: 'min', min: 0.1, max: CLIMATE_LIMITS.ramp[1] / 60, step: 5, precision: 1, scale: 1 / 60 },
    { visible: (s) => C(s).profile === 'cyclic', key: 'period', labelKey: 'climate.f.period', unit: 'min', min: 1, max: CLIMATE_LIMITS.period[1] / 60, step: 30, precision: 0, scale: 1 / 60 },
    { key: 'humidity', labelKey: 'climate.f.humidity', unit: '%', min: 1, max: 100, step: 5, precision: 0, scale: 100 },
    { key: 'humidityTarget', labelKey: 'climate.f.humidityTarget', unit: '%', min: 1, max: 100, step: 5, precision: 0, scale: 100, optional: true, autoValue: (s) => C(s).humidity },
    { visible: (s) => C(s).forcing === 'flux', key: 'mixTime', labelKey: 'climate.f.mixTime', unit: 'min', min: 1, max: CLIMATE_LIMITS.mixTime[1] / 60, step: 5, precision: 0, scale: 1 / 60, optional: true, autoValue: () => 900 },
    { key: 'precipitation', labelKey: 'climate.f.precipitation', unit: 'mm/h', min: 0, max: CLIMATE_LIMITS.precipitation[1], step: 0.5, precision: 1, get: (s) => C(s).precipitation ?? 0 },
    { visible: raining, key: 'precipPhase', labelKey: 'climate.f.precipPhase', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.phase', PRECIP_PHASES), get: (s) => C(s).precipPhase ?? 'auto' },
    {
      visible: (s) => raining(s) && C(s).precipPhase === 'snow', key: 'snowfall', labelKey: 'climate.f.snowfall', unit: 'cm/h', min: 0, max: 50, step: 0.5, precision: 1,
      // Snowfall entered as new-snow depth: converted with a new-snow density of 100 kg/m³ (10:1 ratio).
      get: (s) => C(s).precipitation ?? 0, set: (s, v) => put(s, { precipitation: Number(v) }),
    },
    { visible: raining, key: 'precipProfile', labelKey: 'climate.f.precipProfile', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.precipProfile', PRECIP_PROFILES), get: (s) => C(s).precipProfile ?? 'constant',
      set: (s, v) => { const sp = C(s), pd = sp.precipDuration ?? sp.duration - (sp.precipStart ?? 0); const patch: Partial<ClimateSpec> = { precipProfile: v as ClimateSpec['precipProfile'] }; if (v === 'rampUp' && !sp.precipRamp) patch.precipRamp = Math.round(pd / 3); if (v === 'scheduled' && !sp.precipWindows?.length) patch.precipWindows = [[0, Math.round(pd / 2)]]; return put(s, patch); } },
    { visible: raining, key: 'precipStart', labelKey: 'climate.f.precipStart', unit: 'min', min: 0, max: CLIMATE_LIMITS.duration[1] / 60, step: 5, precision: 0, scale: 1 / 60, get: (s) => C(s).precipStart ?? 0 },
    { visible: raining, key: 'precipDuration', labelKey: 'climate.f.precipDuration', unit: 'min', min: 1, max: CLIMATE_LIMITS.duration[1] / 60, step: 5, precision: 0, scale: 1 / 60, optional: true, autoValue: (s) => C(s).duration - (C(s).precipStart ?? 0) },
    { visible: (s) => raining(s) && C(s).precipProfile === 'rampUp', key: 'precipRamp', labelKey: 'climate.f.precipRamp', unit: 'min', min: 0.1, max: CLIMATE_LIMITS.duration[1] / 60, step: 5, precision: 1, scale: 1 / 60 },
    { visible: raining, key: 'areaMode', labelKey: 'climate.f.area', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.area', ['world', 'disc'] as const), get: (s) => (C(s).area ? 'disc' : 'world'), set: (s, v) => put(s, { area: v === 'disc' ? { center: [0, 0], radius: 40 } : null }) },
    { visible: (s) => raining(s) && !!C(s).area, key: 'x', labelKey: 'climate.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => C(s).area?.center[0] ?? 0, set: (s, v) => put(s, { area: { center: [Number(v), C(s).area?.center[1] ?? 0], radius: C(s).area?.radius ?? 40 } }) },
    { visible: (s) => raining(s) && !!C(s).area, key: 'z', labelKey: 'climate.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => C(s).area?.center[1] ?? 0, set: (s, v) => put(s, { area: { center: [C(s).area?.center[0] ?? 0, Number(v)], radius: C(s).area?.radius ?? 40 } }) },
    { visible: (s) => raining(s) && !!C(s).area, key: 'radius', labelKey: 'climate.f.radius', unit: 'm', min: CLIMATE_LIMITS.radius[0], max: CLIMATE_LIMITS.radius[1], step: 1, precision: 0, get: (s) => C(s).area?.radius ?? 40, set: (s, v) => put(s, { area: { center: C(s).area?.center ?? [0, 0], radius: Number(v) } }) },
    { key: 'solar', labelKey: 'climate.f.solar', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.solar', SOLAR_MODES) },
    { visible: (s) => C(s).solar !== 'off', key: 'latitude', labelKey: 'climate.f.latitude', unit: '°', min: -90, max: 90, step: 1, precision: 1, get: (s) => C(s).latitude ?? 37.5 },
    { visible: (s) => C(s).solar !== 'off', key: 'dayOfYear', labelKey: 'climate.f.day', unit: '', min: 1, max: 365, step: 1, precision: 0, get: (s) => C(s).dayOfYear ?? 172 },
    { visible: (s) => C(s).solar !== 'off', key: 'hour', labelKey: 'climate.f.hour', unit: 'h', min: 0, max: 24, step: 0.5, precision: 1, get: (s) => C(s).hour ?? 12 },
    { visible: (s) => C(s).solar === 'constant', key: 'irradiance', labelKey: 'climate.f.irradiance', unit: 'W/m²', min: 0, max: 1361, step: 10, precision: 0, get: (s) => C(s).irradiance ?? 800 },
    { visible: solarOn, key: 'cloud', labelKey: 'climate.f.cloud', unit: '%', min: 0, max: 100, step: 5, precision: 0, scale: 100, get: (s) => C(s).cloud ?? 0 },
    { key: 'initialSnow', labelKey: 'climate.f.initialSnow', unit: 'cm', min: 0, max: 500, step: 5, precision: 0, scale: 100, get: (s) => C(s).initialSnow ?? 0 },
    { visible: (s) => (C(s).initialSnow ?? 0) > 0, key: 'initialSnowDensity', labelKey: 'climate.f.snowDensity', unit: 'kg/m³', min: 50, max: 550, step: 10, precision: 0, get: (s) => C(s).initialSnowDensity ?? 250 },
    { visible: (s) => (C(s).initialSnow ?? 0) > 0, key: 'roofSnow', labelKey: 'climate.f.roofSnow', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.onoff', ON_OFF), get: (s) => (C(s).roofSnow === false ? 'off' : 'on'), set: (s, v) => put(s, { roofSnow: v === 'on' }) },
    { key: 'initialIce', labelKey: 'climate.f.initialIce', unit: 'cm', min: 0, max: 200, step: 1, precision: 0, scale: 100, get: (s) => C(s).initialIce ?? 0 },
    { key: 'initialFrost', labelKey: 'climate.f.initialFrost', unit: 'cm', min: 0, max: 80, step: 5, precision: 0, scale: 100, get: (s) => C(s).initialFrost ?? 0 },
    { key: 'soilMoisture', labelKey: 'climate.f.soilMoisture', unit: '%', min: 0, max: 50, step: 1, precision: 0, scale: 100 },
    { key: 'blowingSnow', labelKey: 'climate.f.blowingSnow', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('climate.onoff', ON_OFF), get: (s) => (C(s).blowingSnow === false ? 'off' : 'on'), set: (s, v) => put(s, { blowingSnow: v === 'on' }) },
  ] as ParamField[],
  createEvent: (spec, now) => new ClimateEvent(spec, now),
  duration: (spec) => Math.max(1, spec.duration),
  assumptions: (spec) => climateAssumptions(spec),
  describe: (spec) => describeClimate(spec),
});

/** Assumptions and model limitations of a climate experiment (editor, preview, command preview). */
export function climateAssumptions(s: ClimateSpec): I18nMessage[] {
  const out: I18nMessage[] = [
    { key: 'climate.as.model' },
    { key: s.forcing === 'flux' ? 'climate.as.flux' : 'climate.as.prescribed', params: { tau: ((s.mixTime ?? 900) / 60).toFixed(0) } },
    { key: 'climate.as.humidity' }, { key: 'climate.as.evaporation' }, { key: 'climate.as.condensation' },
  ];
  if ((s.precipitation ?? 0) > 0) out.push({ key: (s.precipPhase ?? 'auto') === 'auto' ? 'climate.as.splitAuto' : s.precipPhase === 'snow' ? 'climate.as.splitSnow' : 'climate.as.splitRain' });
  out.push({ key: 'climate.as.snow' }, { key: 'climate.as.ice' }, { key: 'climate.as.soil' });
  out.push({ key: s.solar === 'off' ? 'climate.as.solarOff' : s.solar === 'constant' ? 'climate.as.solarConstant' : 'climate.as.solarClear' });
  out.push({ key: 'climate.as.loads' }, { key: 'climate.as.friction' }, { key: 'climate.as.people' }, { key: 'climate.as.limits' });
  return out;
}
