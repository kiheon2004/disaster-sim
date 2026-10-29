/**
 * Volcano (Phase 28) for the phenomenon engine: a local eruption — vents placed on the terrain (a central
 * vent, a fissure, or several vents), the lava material and eruption temperature, the supply rate and its
 * time profile, optional bomb / ash shares — with editor fields (only those that apply), defaults and the
 * assumptions + model limitations listed in the editor and the command preview. Impossible input is
 * rejected by the schema with a reason. Not an eruption forecast or a hazard-planning tool.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { VolcanoEvent, describeVolcano } from '@/events/volcano/VolcanoEvent';
import { temperatureRange, volcanoSchema } from '@/events/volcano/volcanoSchema';
import { DEFAULT_PLUME_HEIGHT, ERUPTION_PROFILES, VOLCANO_LIMITS, type VentSpec, type VolcanoSpec } from '@/volcano/types';
import { LAVA_MATERIALS, LAVA_MATERIAL_IDS } from '@/volcano/materials';
import { totalVolume } from '@/volcano/eruption';
import { ZERO_C } from '@/thermal/units';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const V = (s: EventSpec) => s as unknown as VolcanoSpec;
const put = (s: EventSpec, patch: Partial<VolcanoSpec>) => ({ ...V(s), ...patch }) as unknown as EventSpec;
const opt = <T extends string>(prefix: string, values: readonly T[]) => values.map((v) => ({ value: v, labelKey: `${prefix}.${v}` as MessageKey }));
const vent0 = (s: EventSpec): VentSpec => V(s).vents[0] ?? { kind: 'central', position: [0, 0], radius: 2 };
const putVent = (s: EventSpec, patch: Partial<VentSpec>) => put(s, { vents: [{ ...vent0(s), ...patch }, ...V(s).vents.slice(1)] });

export type VentLayout = 'central' | 'fissure' | 'multiple';
export const VENT_LAYOUTS: readonly VentLayout[] = ['central', 'fissure', 'multiple'];
export const layoutOf = (s: VolcanoSpec): VentLayout => (s.vents.length > 1 ? 'multiple' : s.vents[0]?.kind === 'fissure' ? 'fissure' : 'central');

/** Vents of a layout around the first vent (fissure: 20 m long east–west; multiple: three vents 12 m apart). */
export function ventsFor(layout: VentLayout, s: VolcanoSpec): VentSpec[] {
  const v = s.vents[0] ?? { kind: 'central', position: [0, 0], radius: 2 };
  const [x, z] = v.position;
  if (layout === 'fissure') return [{ kind: 'fissure', position: [x, z], end: v.end ?? [x + 20, z], radius: Math.min(v.radius, 2) }];
  if (layout === 'multiple') return s.vents.length > 1 ? s.vents : [{ kind: 'central', position: [x, z], radius: v.radius }, { kind: 'central', position: [x + 12, z], radius: v.radius }, { kind: 'central', position: [x + 24, z], radius: v.radius }];
  return [{ kind: 'central', position: [x, z], radius: v.radius }];
}

const stage = (k: number): ParamField => ({
  visible: (s) => V(s).profile === 'staged', key: `stage${k}`, labelKey: `volcano.f.stage${k}` as MessageKey, unit: '%', min: 0, max: 100, step: 5, precision: 0,
  get: (s) => ((V(s).stages ?? [0.3, 1, 0.5])[k - 1] ?? 0) * 100,
  set: (s, v) => { const st = [...(V(s).stages ?? [0.3, 1, 0.5])]; st[k - 1] = Math.max(0, Math.min(1, Number(v) / 100)); return put(s, { stages: st }); },
});

export const volcano = implemented<VolcanoSpec>({
  type: 'volcano', labelKey: 'phen.volcano', icon: 'volcano', status: 'implemented',
  // Ash and gas are its own state (not the Phase 29 atmosphere channel, which is still an interface).
  channels: ['temperature', 'terrainDeformation'],
  models: ['lavaFlow', 'lavaCooling', 'volcanicDeposition', 'volcanicEjecta', 'volcanicAsh', 'heatTransfer', 'combustion', 'thermalStructure'],
  keywords: /화산|용암|화산재|분화|분출|volcan|lava|eruption|ash\s*fall/,
  schema: volcanoSchema,
  defaults: () => ({ event: 'volcano', vents: [{ kind: 'central', position: [0, 0], radius: 2 }], material: 'basalt', temperature: 1140, rate: 2, duration: 600, profile: 'constant' }),
  seeded: false,
  fields: [
    {
      key: 'layout', labelKey: 'volcano.f.layout', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('volcano.layout', VENT_LAYOUTS),
      get: (s) => layoutOf(V(s)), set: (s, v) => put(s, { vents: ventsFor(v as VentLayout, V(s)) }),
    },
    { key: 'x', labelKey: 'volcano.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => vent0(s).position[0], set: (s, v) => putVent(s, { position: [Number(v), vent0(s).position[1]] }) },
    { key: 'z', labelKey: 'volcano.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => vent0(s).position[1], set: (s, v) => putVent(s, { position: [vent0(s).position[0], Number(v)] }) },
    { visible: (s) => layoutOf(V(s)) === 'fissure', key: 'endX', labelKey: 'volcano.f.endX', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => vent0(s).end?.[0], set: (s, v) => putVent(s, { end: [Number(v), vent0(s).end?.[1] ?? vent0(s).position[1]] }) },
    { visible: (s) => layoutOf(V(s)) === 'fissure', key: 'endZ', labelKey: 'volcano.f.endZ', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => vent0(s).end?.[1], set: (s, v) => putVent(s, { end: [vent0(s).end?.[0] ?? vent0(s).position[0], Number(v)] }) },
    { key: 'radius', labelKey: 'volcano.f.radius', unit: 'm', min: VOLCANO_LIMITS.radius[0], max: VOLCANO_LIMITS.radius[1], step: 0.5, precision: 1, get: (s) => vent0(s).radius, set: (s, v) => put(s, { vents: V(s).vents.map((x) => ({ ...x, radius: Number(v) })) }) },
    {
      key: 'material', labelKey: 'volcano.f.material', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('volcano.material', LAVA_MATERIAL_IDS),
      // A new material starts at its default eruption temperature (the old one may be outside its range).
      set: (s, v) => put(s, { material: v as VolcanoSpec['material'], temperature: Math.round(LAVA_MATERIALS[v as VolcanoSpec['material']].Tdefault - ZERO_C) }),
    },
    { key: 'temperature', labelKey: 'volcano.f.temperature', unit: '°C', min: 900, max: 1300, step: 10, precision: 0 },
    { key: 'rate', labelKey: 'volcano.f.rate', unit: 'm³/s', min: VOLCANO_LIMITS.rate[0], max: VOLCANO_LIMITS.rate[1], step: 0.5, precision: 2 },
    { key: 'duration', labelKey: 'volcano.f.duration', unit: 'min', min: VOLCANO_LIMITS.duration[0] / 60, max: VOLCANO_LIMITS.duration[1] / 60, step: 1, precision: 1, scale: 1 / 60 },
    {
      key: 'profile', labelKey: 'volcano.f.profile', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('volcano.profile', ERUPTION_PROFILES),
      set: (s, v) => {
        const sp = V(s), p = v as VolcanoSpec['profile'], D = sp.duration;
        const patch: Partial<VolcanoSpec> = { profile: p };
        if (p === 'ramp' && !(sp.rampTime && sp.rampTime <= D)) patch.rampTime = Math.round(D / 4);
        if (p === 'pulse' && !(sp.period && sp.pulseWidth && sp.pulseWidth < sp.period && sp.period <= D)) { patch.period = Math.min(D, 60); patch.pulseWidth = Math.min(D, 60) / 3; }
        if (p === 'staged' && !sp.stages?.length) patch.stages = [0.3, 1, 0.5];
        if (p === 'wane' && !(sp.declineTime && sp.declineTime <= D)) patch.declineTime = Math.round(D / 4);
        return put(s, patch);
      },
    },
    { visible: (s) => V(s).profile === 'ramp', key: 'rampTime', labelKey: 'volcano.f.rampTime', unit: 's', min: 1, max: VOLCANO_LIMITS.duration[1], step: 10, precision: 0 },
    { visible: (s) => V(s).profile === 'pulse', key: 'period', labelKey: 'volcano.f.period', unit: 's', min: 1, max: VOLCANO_LIMITS.duration[1], step: 5, precision: 0 },
    { visible: (s) => V(s).profile === 'pulse', key: 'pulseWidth', labelKey: 'volcano.f.pulseWidth', unit: 's', min: 1, max: VOLCANO_LIMITS.duration[1], step: 5, precision: 0 },
    { visible: (s) => V(s).profile === 'wane', key: 'declineTime', labelKey: 'volcano.f.declineTime', unit: 's', min: 1, max: VOLCANO_LIMITS.duration[1], step: 10, precision: 0 },
    stage(1), stage(2), stage(3),
    { key: 'bombFraction', labelKey: 'volcano.f.bombs', unit: '%', min: 0, max: 30, step: 1, precision: 0, scale: 100, optional: true, autoValue: () => 0 },
    { key: 'ashFraction', labelKey: 'volcano.f.ash', unit: '%', min: 0, max: 30, step: 1, precision: 0, scale: 100, optional: true, autoValue: () => 0 },
    { visible: (s) => (V(s).ashFraction ?? 0) > 0, key: 'plumeHeight', labelKey: 'volcano.f.plume', unit: 'm', min: VOLCANO_LIMITS.plumeHeight[0], max: VOLCANO_LIMITS.plumeHeight[1], step: 10, precision: 0, optional: true, autoValue: () => DEFAULT_PLUME_HEIGHT },
  ] as ParamField[],
  createEvent: (spec, now) => new VolcanoEvent(spec, now),
  duration: (spec) => new VolcanoEvent(spec, 0).duration,
  assumptions: (spec) => volcanoAssumptions(spec),
  describe: (spec) => describeVolcano(spec),
});

/** Assumptions and model limitations of a volcano scenario (editor, preview, command preview). */
export function volcanoAssumptions(s: VolcanoSpec): I18nMessage[] {
  const m = LAVA_MATERIALS[s.material] ?? LAVA_MATERIALS.basalt;
  const [lo, hi] = temperatureRange(m.id);
  const out: I18nMessage[] = [
    { key: 'volcano.as.supply', params: { V: totalVolume(s).toFixed(0), t: (m.thermal.bulk * totalVolume(s) / 1000).toFixed(0) } },
    { key: 'volcano.as.material', params: { mat: m.id, lo, hi, TL: Math.round(m.thermal.TL - ZERO_C), TS: Math.round(m.thermal.TS - ZERO_C) } },
    { key: 'volcano.as.flow' }, { key: 'volcano.as.crust' }, { key: 'volcano.as.deposit' },
  ];
  if ((s.bombFraction ?? 0) > 0) out.push({ key: 'volcano.as.bombs' });
  if ((s.ashFraction ?? 0) > 0) out.push({ key: 'volcano.as.ash', params: { H: s.plumeHeight ?? DEFAULT_PLUME_HEIGHT } });
  out.push({ key: 'volcano.as.gas' }, { key: 'volcano.as.water' }, { key: 'volcano.as.fire' }, { key: 'volcano.as.scale' }, { key: 'volcano.as.notForecast' });
  return out;
}
