/**
 * Heat source (Phase 26) for the phenomenon engine: editor fields (only those that apply to the
 * chosen kind / input / profile), defaults, and the assumptions + model limitations listed in the
 * editor and the command preview. Output power, total energy and prescribed temperature are separate
 * fields of separate boundary conditions; impossible input is rejected by the schema with a reason.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { HeatSourceEvent, describeHeatSource } from '@/events/thermal/HeatSourceEvent';
import { heatSourceSchema } from '@/events/thermal/thermalSchema';
import { DEFAULT_RADIATIVE_FRACTION, HEAT_LIMITS, HEAT_SOURCE_KINDS, type HeatSourceSpec } from '@/thermal/types';
import { PROFILE_KINDS } from '@/thermal/profiles';
import { amplitude, peakPower, radiativeFraction, totalEnergy } from '@/thermal/sources';
import { energyText, powerText, toC, toK } from '@/thermal/units';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const H = (s: EventSpec) => s as unknown as HeatSourceSpec;
const put = (s: EventSpec, patch: Partial<HeatSourceSpec>) => ({ ...H(s), ...patch }) as unknown as EventSpec;
const opt = <T extends string>(prefix: string, values: readonly T[]) => values.map((v) => ({ value: v, labelKey: `${prefix}.${v}` as MessageKey }));

export const heatSource = implemented<HeatSourceSpec>({
  type: 'heatSource', labelKey: 'phen.heatSource', icon: 'heat', status: 'implemented',
  channels: ['temperature'],
  models: ['heatTransfer', 'thermalStructure'],
  keywords: /열원|가열|히터|발열|열\s*(?:실험|전달)|온도\s*(?:경계|지정)|heat\s*source|heater|heating|thermal/,
  schema: heatSourceSchema,
  defaults: () => ({ event: 'heatSource', kind: 'point', position: [0, 0], height: 1.5, radius: 2, input: 'power', power: 5e5, profile: 'constant', duration: 300 }),
  seeded: false,
  fields: [
    {
      key: 'kind', labelKey: 'thermal.f.kind', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('thermal.kind', HEAT_SOURCE_KINDS),
      set: (s, v) => {
        const k = v as HeatSourceSpec['kind'];
        // A prescribed temperature replaces the output (and cannot be instant).
        if (k === 'temperature') return put(s, { kind: k, temperature: H(s).temperature ?? toK(800), profile: H(s).profile === 'instant' ? 'constant' : H(s).profile });
        return put(s, { kind: k });
      },
    },
    { key: 'x', labelKey: 'thermal.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => H(s).position[0], set: (s, v) => put(s, { position: [Number(v), H(s).position[1]] }) },
    { key: 'z', labelKey: 'thermal.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => H(s).position[1], set: (s, v) => put(s, { position: [H(s).position[0], Number(v)] }) },
    { key: 'height', labelKey: 'thermal.f.height', unit: 'm', min: HEAT_LIMITS.height[0], max: HEAT_LIMITS.height[1], step: 0.5, precision: 1 },
    { visible: (s) => H(s).kind !== 'point', key: 'radius', labelKey: 'thermal.f.radius', unit: 'm', min: HEAT_LIMITS.radius[0], max: HEAT_LIMITS.radius[1], step: 0.5, precision: 1 },
    {
      visible: (s) => H(s).kind !== 'temperature', key: 'input', labelKey: 'thermal.f.input', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('thermal.input', ['power', 'energy'] as const),
      set: (s, v) => {
        const sp = H(s);
        if (v === 'energy') return put(s, { input: 'energy', energy: sp.energy ?? Math.max(1, totalEnergy(sp)) });
        return put(s, { input: 'power', power: sp.power ?? Math.max(1, amplitude(sp)), profile: sp.profile === 'instant' ? 'constant' : sp.profile });
      },
    },
    { visible: (s) => H(s).kind !== 'temperature' && H(s).input === 'power', key: 'power', labelKey: 'thermal.f.power', unit: 'kW', min: HEAT_LIMITS.power[0] / 1e3, max: HEAT_LIMITS.power[1] / 1e3, step: 10, precision: 3, scale: 1e-3 },
    { visible: (s) => H(s).kind !== 'temperature' && H(s).input === 'energy', key: 'energy', labelKey: 'thermal.f.energy', unit: 'MJ', min: HEAT_LIMITS.energy[0] / 1e6, max: HEAT_LIMITS.energy[1] / 1e6, step: 1, precision: 3, scale: 1e-6 },
    {
      visible: (s) => H(s).kind === 'temperature', key: 'temperature', labelKey: 'thermal.f.temperature', unit: '°C', min: toC(HEAT_LIMITS.temperature[0]), max: toC(HEAT_LIMITS.temperature[1]), step: 10, precision: 0,
      get: (s) => (H(s).temperature === undefined ? undefined : toC(H(s).temperature!)), set: (s, v) => put(s, { temperature: toK(Number(v)) }),
    },
    { visible: (s) => H(s).kind === 'point', key: 'radiativeFraction', labelKey: 'thermal.f.radiative', unit: '%', min: 0, max: 100, step: 5, precision: 0, scale: 100, optional: true, autoValue: () => DEFAULT_RADIATIVE_FRACTION },
    {
      key: 'profile', labelKey: 'thermal.f.profile', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('thermal.profile', PROFILE_KINDS),
      set: (s, v) => {
        const sp = H(s), p = v as HeatSourceSpec['profile'], D = sp.duration;
        const patch: Partial<HeatSourceSpec> = { profile: p };
        if (p === 'instant') { patch.input = 'energy'; patch.energy = sp.energy ?? Math.max(1, totalEnergy(sp)); }
        if (p === 'ramp' && !(sp.rampTime && sp.rampTime <= D)) patch.rampTime = D / 2;
        if (p === 'pulse' && !(sp.period && sp.pulseWidth && sp.pulseWidth < sp.period)) { patch.period = Math.max(0.2, D / 5); patch.pulseWidth = Math.max(0.1, D / 10); }
        if (p === 'schedule' && !sp.schedule?.length) patch.schedule = [[0, D / 3], [(2 * D) / 3, D]];
        return put(s, patch);
      },
    },
    { key: 'duration', labelKey: 'param.duration', unit: 's', min: HEAT_LIMITS.duration[0], max: HEAT_LIMITS.duration[1], step: 10, precision: 1 },
    { visible: (s) => H(s).profile === 'ramp', key: 'rampTime', labelKey: 'thermal.f.rampTime', unit: 's', min: 0.1, max: HEAT_LIMITS.duration[1], step: 5, precision: 1 },
    { visible: (s) => H(s).profile === 'pulse', key: 'pulseWidth', labelKey: 'thermal.f.pulseWidth', unit: 's', min: 0.1, max: HEAT_LIMITS.duration[1], step: 1, precision: 1 },
    { visible: (s) => H(s).profile === 'pulse', key: 'period', labelKey: 'thermal.f.period', unit: 's', min: 0.2, max: HEAT_LIMITS.duration[1], step: 1, precision: 1 },
  ] as ParamField[],
  createEvent: (spec, now) => new HeatSourceEvent(spec, now),
  duration: (spec) => new HeatSourceEvent(spec, 0).duration,
  assumptions: (spec) => heatAssumptions(spec),
  describe: (spec) => describeHeatSource(spec),
});

/** Assumptions and model limitations of a source (editor, preview, command preview). */
export function heatAssumptions(s: HeatSourceSpec): I18nMessage[] {
  const out: I18nMessage[] = [{ key: 'thermal.as.noCombustion' }, { key: `thermal.as.kind.${s.kind}` as MessageKey }];
  if (s.kind === 'temperature') out.push({ key: 'thermal.as.temperature', params: { T: toC(s.temperature ?? 0).toFixed(0) } });
  else {
    out.push({ key: 'thermal.as.output', params: { P: powerText(peakPower(s)), E: energyText(totalEnergy(s)) } });
    if (s.kind === 'point') out.push({ key: 'thermal.as.radiative', params: { pct: Math.round(radiativeFraction(s) * 100), auto: s.radiativeFraction === undefined ? 1 : 0 } });
    if ((s.kind === 'area' || s.kind === 'surface') && s.radius > 0) {
      const q = peakPower(s) / (Math.PI * s.radius * s.radius);
      out.push({ key: 'thermal.as.flux', params: { q: (q / 1000).toFixed(1) } });
      if (q > 2e5) out.push({ key: 'thermal.warn.flux' });
    }
  }
  out.push({ key: 'thermal.as.materialRange' }, { key: 'thermal.as.reduced' });
  return out;
}
