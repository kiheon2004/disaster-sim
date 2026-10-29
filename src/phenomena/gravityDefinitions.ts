/**
 * Variable gravity (Phase 31) for the phenomenon engine: the global field (magnitude, direction, time profile, end
 * mode) and up to eight local sources (regions, radial fields). A user-defined acceleration field — not the field of a
 * real body, no general relativity. Impossible input is rejected by the schema with a reason.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { GravityEvent, describeGravity } from '@/events/gravity/GravityEvent';
import { gravitySchema } from '@/events/gravity/gravitySchema';
import { FALLOFFS, GRAVITY_ENDS, GRAVITY_LIMITS, GRAVITY_SCENARIOS, GRAVITY_TRANSITIONS, RADIAL_LAWS, REGION_MODES, REGION_SHAPES, SOURCE_KINDS, defaultGravitySpec, type GravitySourceSpec, type GravitySpec } from '@/gravity/types';
import { GRAVITY_PROFILES } from '@/gravity/profiles';
import { scenarioDefaults } from '@/gravity/presets';
import { gravityOutlook } from '@/gravity/outlook';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const G = (s: EventSpec) => s as unknown as GravitySpec;
const put = (s: EventSpec, patch: Partial<GravitySpec>) => ({ ...G(s), ...patch }) as unknown as EventSpec;
const opt = <T extends string>(prefix: string, values: readonly T[]) => values.map((v) => ({ value: v, labelKey: `${prefix}.${v}` as MessageKey }));
const ON_OFF = ['off', 'on'] as const;
const DIRECTIONS = { down: [0, -1, 0], up: [0, 1, 0], east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1] } as const;
type DirName = keyof typeof DIRECTIONS | 'custom';
const DIR_NAMES: readonly DirName[] = ['down', 'up', 'east', 'west', 'south', 'north', 'custom'];
function dirName(v: readonly number[]): DirName {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  for (const [k, d] of Object.entries(DIRECTIONS)) if (Math.abs(v[0] / n - d[0]) < 1e-9 && Math.abs(v[1] / n - d[1]) < 1e-9 && Math.abs(v[2] / n - d[2]) < 1e-9) return k as DirName;
  return 'custom';
}
const global = (s: EventSpec) => G(s).global;
const profileIs = (...p: GravitySpec['profile'][]) => (s: EventSpec) => p.includes(G(s).profile);

/** Fields of source k (shown while the spec has more than k sources). */
function sourceFields(k: number): ParamField[] {
  const has = (s: EventSpec) => G(s).sources.length > k;
  const src = (s: EventSpec) => G(s).sources[k];
  const region = (s: EventSpec) => has(s) && src(s).kind === 'region';
  const radial = (s: EventSpec) => has(s) && src(s).kind === 'radial';
  const putSrc = (s: EventSpec, patch: Partial<GravitySourceSpec>) => {
    const list = G(s).sources.map((q, i) => (i === k ? { ...q, ...patch } : q));
    return put(s, { sources: list });
  };
  const L = (name: string) => `gravity.f.src${k + 1}.${name}` as MessageKey;
  const coord = (i: 0 | 1 | 2, name: string): ParamField => ({
    visible: has, key: `s${k}.${name}`, labelKey: L(name), unit: 'm', min: i === 1 ? -50 : -200, max: i === 1 ? 300 : 200, step: 1, precision: 1,
    get: (s) => src(s).center[i], set: (s, v) => { const c = [...src(s).center] as [number, number, number]; c[i] = Number(v); return putSrc(s, { center: c }); },
  });
  const acc = (i: 0 | 1 | 2, name: string): ParamField => ({
    visible: region, key: `s${k}.${name}`, labelKey: L(name), unit: 'm/s²', min: -GRAVITY_LIMITS.magnitude[1], max: GRAVITY_LIMITS.magnitude[1], step: 0.5, precision: 2,
    get: (s) => (src(s).accel ?? [0, 0, 0])[i], set: (s, v) => { const a = [...(src(s).accel ?? [0, 0, 0])] as [number, number, number]; a[i] = Number(v); return putSrc(s, { accel: a }); },
  });
  return [
    {
      visible: has, key: `s${k}.kind`, labelKey: L('kind'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: [...opt('gravity.kind', SOURCE_KINDS), { value: 'remove', labelKey: 'gravity.kind.remove' as MessageKey }],
      get: (s) => src(s).kind,
      set: (s, v) => (v === 'remove' ? put(s, { sources: G(s).sources.filter((_, i) => i !== k) }) : putSrc(s, v === 'region' ? { kind: 'region', shape: src(s).shape ?? 'sphere', mode: src(s).mode ?? 'add', accel: src(s).accel ?? [0, 9.81, 0] } : { kind: 'radial', strength: src(s).strength ?? 10, r0: src(s).r0 ?? 5, law: src(s).law ?? 'inverseSquare', softening: src(s).softening ?? 3 })),
    },
    coord(0, 'x'), coord(1, 'y'), coord(2, 'z'),
    { visible: has, key: `s${k}.radius`, labelKey: L('radius'), unit: 'm', min: GRAVITY_LIMITS.radius[0], max: GRAVITY_LIMITS.radius[1], step: 1, precision: 0, get: (s) => src(s).radius, set: (s, v) => putSrc(s, { radius: Number(v), edge: Math.min(src(s).edge ?? 0.2 * Number(v), Number(v)) }) },
    { visible: has, key: `s${k}.falloff`, labelKey: L('falloff'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.falloff', FALLOFFS), get: (s) => src(s).falloff, set: (s, v) => putSrc(s, { falloff: v as GravitySourceSpec['falloff'] }) },
    { visible: (s) => has(s) && src(s).falloff !== 'none', key: `s${k}.edge`, labelKey: L('edge'), unit: 'm', min: 0, max: GRAVITY_LIMITS.radius[1], step: 0.5, precision: 1, get: (s) => src(s).edge ?? 0.2 * src(s).radius, set: (s, v) => putSrc(s, { edge: Number(v) }) },
    { visible: region, key: `s${k}.shape`, labelKey: L('shape'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.shape', REGION_SHAPES), get: (s) => src(s).shape ?? 'sphere', set: (s, v) => putSrc(s, { shape: v as GravitySourceSpec['shape'] }) },
    { visible: region, key: `s${k}.mode`, labelKey: L('mode'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.mode', REGION_MODES), get: (s) => src(s).mode ?? 'add', set: (s, v) => putSrc(s, { mode: v as GravitySourceSpec['mode'] }) },
    acc(0, 'ax'), acc(1, 'ay'), acc(2, 'az'),
    { visible: radial, key: `s${k}.strength`, labelKey: L('strength'), unit: 'm/s²', min: GRAVITY_LIMITS.strength[0], max: GRAVITY_LIMITS.strength[1], step: 0.5, precision: 2, get: (s) => src(s).strength ?? 0, set: (s, v) => putSrc(s, { strength: Number(v) }) },
    { visible: radial, key: `s${k}.r0`, labelKey: L('r0'), unit: 'm', min: 0.1, max: GRAVITY_LIMITS.radius[1], step: 0.5, precision: 1, get: (s) => src(s).r0 ?? 5, set: (s, v) => putSrc(s, { r0: Number(v) }) },
    { visible: radial, key: `s${k}.law`, labelKey: L('law'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.law', RADIAL_LAWS), get: (s) => src(s).law ?? 'inverseSquare', set: (s, v) => putSrc(s, { law: v as GravitySourceSpec['law'] }) },
    { visible: radial, key: `s${k}.softening`, labelKey: L('softening'), unit: 'm', min: 0.01, max: GRAVITY_LIMITS.radius[1], step: 0.5, precision: 2, get: (s) => src(s).softening ?? 1, set: (s, v) => putSrc(s, { softening: Number(v) }) },
    { visible: has, key: `s${k}.follow`, labelKey: L('follow'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.onoff', ON_OFF), get: (s) => (src(s).followProfile ? 'on' : 'off'), set: (s, v) => putSrc(s, { followProfile: v === 'on' }) },
  ];
}

/** A new source of a kind at the world centre (the "add source" choice). */
export function newSource(kind: GravitySourceSpec['kind']): GravitySourceSpec {
  return kind === 'region'
    ? { kind: 'region', center: [0, 0, 0], radius: 20, edge: 4, falloff: 'smooth', shape: 'sphere', mode: 'add', accel: [0, 9.81, 0], followProfile: true }
    : { kind: 'radial', center: [0, 5, 0], radius: 30, edge: 8, falloff: 'smooth', strength: 10, r0: 5, law: 'inverseSquare', softening: 3, followProfile: true };
}

export const gravity = implemented<GravitySpec>({
  type: 'gravity', labelKey: 'phen.gravity', icon: 'gravity', status: 'implemented',
  channels: ['gravity', 'mechanicalForce'],
  models: ['gravityField', 'gravityStructure', 'gravityFluids'],
  keywords: /중력|무중력|저중력|고중력|gravity|zero[\s-]?g|weightless/,
  schema: gravitySchema,
  defaults: () => defaultGravitySpec(),
  seeded: false,
  fields: [
    {
      key: 'scenario', labelKey: 'gravity.f.scenario', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.scenario', GRAVITY_SCENARIOS),
      set: (s, v) => put(s, { ...scenarioDefaults(v as GravitySpec['scenario']), scenario: v as GravitySpec['scenario'] }),
    },
    { key: 'global', labelKey: 'gravity.f.global', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.onoff', ON_OFF), get: (s) => (G(s).global ? 'on' : 'off'), set: (s, v) => put(s, { global: v === 'on' }) },
    { visible: global, key: 'magnitude', labelKey: 'gravity.f.magnitude', unit: 'm/s²', min: GRAVITY_LIMITS.magnitude[0], max: GRAVITY_LIMITS.magnitude[1], step: 0.1, precision: 2 },
    { visible: global, key: 'ratio', labelKey: 'gravity.f.ratio', unit: '× g₀', min: 0, max: GRAVITY_LIMITS.magnitude[1] / 9.81, step: 0.05, precision: 2, get: (s) => G(s).magnitude / 9.81, set: (s, v) => put(s, { magnitude: Number(v) * 9.81 }) },
    {
      visible: global, key: 'dir', labelKey: 'gravity.f.direction', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.dir', DIR_NAMES),
      get: (s) => dirName(G(s).direction), set: (s, v) => (v === 'custom' ? put(s, { direction: [0.5, -0.8, 0.3] }) : put(s, { direction: [...DIRECTIONS[v as keyof typeof DIRECTIONS]] as [number, number, number] })),
    },
    ...([0, 1, 2] as const).map((i): ParamField => ({
      // Always editable while the global part is on (a named direction is a shortcut; editing a component keeps its field).
      visible: global, key: `d${i}`, labelKey: `gravity.f.d${'xyz'[i]}` as MessageKey, unit: '', min: -1, max: 1, step: 0.05, precision: 2,
      get: (s) => G(s).direction[i], set: (s, v) => { const d = [...G(s).direction] as [number, number, number]; d[i] = Number(v); return put(s, { direction: d }); },
    })),
    { visible: global, key: 'transition', labelKey: 'gravity.f.transition', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.transition', GRAVITY_TRANSITIONS) },
    {
      key: 'profile', labelKey: 'gravity.f.profile', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.profile', GRAVITY_PROFILES),
      set: (s, v) => {
        const sp = G(s), D = sp.duration, p = v as GravitySpec['profile'];
        const patch: Partial<GravitySpec> = { profile: p };
        if ((p === 'linear' || p === 'smooth') && !(sp.ramp && sp.ramp <= D)) patch.ramp = Math.max(1, Math.round(D / 6));
        if ((p === 'cyclic' || p === 'pulse') && !sp.period) patch.period = Math.max(2, Math.round(D / 4));
        if (p === 'pulse' && !sp.pulseWidth) patch.pulseWidth = Math.max(1, Math.round(D / 10));
        if (p === 'staged' && !sp.stages?.length) patch.stages = [[Math.round(D / 3), 0.5], [Math.round((2 * D) / 3), 1]];
        if (p === 'scheduled' && !sp.windows?.length) patch.windows = [[Math.round(D / 4), Math.round((3 * D) / 4)]];
        return put(s, patch);
      },
    },
    { key: 'duration', labelKey: 'gravity.f.duration', unit: 's', min: GRAVITY_LIMITS.duration[0], max: GRAVITY_LIMITS.duration[1], step: 5, precision: 0 },
    { visible: profileIs('linear', 'smooth', 'pulse'), key: 'ramp', labelKey: 'gravity.f.ramp', unit: 's', min: 0, max: GRAVITY_LIMITS.duration[1], step: 1, precision: 1 },
    { visible: profileIs('cyclic', 'pulse'), key: 'period', labelKey: 'gravity.f.period', unit: 's', min: 0.5, max: GRAVITY_LIMITS.duration[1], step: 1, precision: 1 },
    { visible: profileIs('pulse'), key: 'pulseWidth', labelKey: 'gravity.f.pulseWidth', unit: 's', min: 0.1, max: GRAVITY_LIMITS.duration[1], step: 0.5, precision: 1 },
    { key: 'end', labelKey: 'gravity.f.end', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.end', GRAVITY_ENDS) },
    {
      key: 'addSource', labelKey: 'gravity.f.addSource', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('gravity.add', ['none', 'region', 'radial'] as const),
      get: () => 'none', set: (s, v) => (v === 'none' || G(s).sources.length >= GRAVITY_LIMITS.sources ? s : put(s, { sources: [...G(s).sources, newSource(v as GravitySourceSpec['kind'])] })),
    },
    ...Array.from({ length: GRAVITY_LIMITS.sources }, (_, k) => sourceFields(k)).flat(),
  ] as ParamField[],
  createEvent: (spec, now) => new GravityEvent(spec, now),
  duration: (spec) => Math.max(1, spec.duration),
  assumptions: (spec) => gravityAssumptions(spec),
  describe: (spec) => describeGravity(spec),
});

/** Assumptions and model limitations of a gravity experiment (editor, preview, command preview). */
export function gravityAssumptions(s: GravitySpec): I18nMessage[] {
  const o = gravityOutlook(s);
  const out: I18nMessage[] = [{ key: 'gravity.as.model' }, { key: 'gravity.as.mass' }, { key: s.global ? 'gravity.as.replace' : 'gravity.as.localOnly' }];
  if (s.sources.length) out.push({ key: 'gravity.as.sources' });
  if (s.scenario === 'moon' || s.scenario === 'mars') out.push({ key: 'gravity.as.bodyMagnitude' });
  for (const w of o.limits) out.push({ key: w as MessageKey });
  out.push({ key: 'gravity.as.noGR' }, { key: 'gravity.as.notSafety' });
  return out;
}
