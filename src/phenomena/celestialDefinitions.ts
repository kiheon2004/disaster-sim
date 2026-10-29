/**
 * Black holes & extreme celestial gravity (Phase 32) for the phenomenon engine: up to four softened point masses of
 * real mass (μ = G·M, real G) with a capture radius, prescribed motion and mass policy, probe bodies with orbit
 * initial conditions, accretion (visual disc, physical test particles), structural tidal response. Newtonian gravity
 * with declared educational reductions — no general relativity (docs/EXTREME_CELESTIAL.md §3). Impossible input is
 * rejected by the schema with a reason.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { CelestialEvent, describeCelestial } from '@/events/celestial/CelestialEvent';
import { celestialSchema } from '@/events/celestial/celestialSchema';
import { CELESTIAL_KINDS, CELESTIAL_LIMITS, CELESTIAL_SCALES, CELESTIAL_SCENARIOS, LIMIT_POLICIES, MASS_POLICIES, MOTION_KINDS, PROBE_MODES, defaultCelestialSpec, defaultSource, massForAccel, type CelestialSourceSpec, type CelestialSpec, type ProbeSpec } from '@/celestial/types';
import { scenarioDefaults } from '@/celestial/presets';
import { celestialOutlook } from '@/celestial/outlook';
import { G_N } from '@/celestial/constants';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const C = (s: EventSpec) => s as unknown as CelestialSpec;
const put = (s: EventSpec, patch: Partial<CelestialSpec>) => ({ ...C(s), ...patch }) as unknown as EventSpec;
const opt = <T extends string>(prefix: string, values: readonly T[]) => values.map((v) => ({ value: v, labelKey: `${prefix}.${v}` as MessageKey }));
const ON_OFF = ['off', 'on'] as const;
const educational = (s: EventSpec) => C(s).scale === 'educational';
/** Probes / sources shown in the editor (the spec may hold more probes — presets — they are kept). */
const EDIT_PROBES = 4;

/** Fields of source k (shown while the spec has more than k sources). */
function sourceFields(k: number): ParamField[] {
  const has = (s: EventSpec) => C(s).sources.length > k;
  const src = (s: EventSpec) => C(s).sources[k];
  const putSrc = (s: EventSpec, patch: Partial<CelestialSourceSpec>) => put(s, { sources: C(s).sources.map((q, i) => (i === k ? { ...q, ...patch } : q)) });
  const L = (name: string) => `celestial.f.src.${name}` as MessageKey;
  const key = (name: string) => `s${k}.${name}`;
  const num = (name: string, unit: string, min: number, max: number, step: number, precision: number, get: (q: CelestialSourceSpec) => number, set: (q: CelestialSourceSpec, v: number) => Partial<CelestialSourceSpec>, visible: (s: EventSpec) => boolean = has): ParamField => ({
    visible, key: key(name), labelKey: L(name), unit, min, max, step, precision, get: (s) => get(src(s)), set: (s, v) => putSrc(s, set(src(s), Number(v))),
  });
  const coord = (i: 0 | 1 | 2, name: string) => num(name, 'm', i === 1 ? -20 : -300, i === 1 ? 400 : 300, 1, 1, (q) => q.center[i], (q, v) => { const c = [...q.center] as [number, number, number]; c[i] = v; return { center: c }; });
  const moving = (s: EventSpec) => has(s) && src(s).motion === 'velocity';
  const vel = (i: 0 | 1 | 2, name: string) => num(name, 'm/s', -200, 200, 0.5, 2, (q) => (q.velocity ?? [0, 0, 0])[i], (q, v) => { const w = [...(q.velocity ?? [0, 0, 0])] as [number, number, number]; w[i] = v; return { velocity: w }; }, moving);
  const L1 = CELESTIAL_LIMITS;
  return [
    {
      visible: has, key: key('kind'), labelKey: L('kind'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: [...opt('celestial.kind', CELESTIAL_KINDS), { value: 'remove', labelKey: 'celestial.kind.remove' as MessageKey }],
      get: (s) => src(s).kind,
      set: (s, v) => (v === 'remove' ? put(s, { sources: C(s).sources.filter((_, i) => i !== k), probes: C(s).probes.filter((p) => (p.source ?? 0) !== k).map((p) => ({ ...p, source: (p.source ?? 0) > k ? (p.source ?? 0) - 1 : p.source })) }) : putSrc(s, { kind: v as CelestialSourceSpec['kind'], capture: v === 'compact' ? 0 : Math.max(src(s).capture, 1) })),
    },
    coord(0, 'x'), coord(1, 'y'), coord(2, 'z'),
    // Mass: as log₁₀(M/kg) (physical mode spans 1–10⁴² kg), as μ, or — educational — from |g| at a reference distance.
    num('log10m', 'log₁₀ kg', 0, 42, 0.1, 2, (q) => Math.log10(q.mass), (_q, v) => ({ mass: 10 ** v, refAccel: undefined, refRadius: undefined })),
    num('mu', 'm³/s²', 0, 1e9, 1000, 0, (q) => G_N * q.mass, (_q, v) => ({ mass: v / G_N, refAccel: undefined, refRadius: undefined })),
    num('refAccel', 'm/s²', 0.01, 1e4, 0.5, 2, (q) => q.refAccel ?? (G_N * q.mass * (q.refRadius ?? 50)) / ((q.refRadius ?? 50) ** 2 + q.softening ** 2) ** 1.5, (q, v) => ({ refAccel: v, refRadius: q.refRadius ?? 50, mass: massForAccel(v, q.refRadius ?? 50, q.softening) }), (s) => has(s) && educational(s)),
    num('refRadius', 'm', 1, 500, 1, 1, (q) => q.refRadius ?? 50, (q, v) => { const a = q.refAccel ?? (G_N * q.mass * 50) / (2500 + q.softening ** 2) ** 1.5; return { refRadius: v, refAccel: a, mass: massForAccel(a, v, q.softening) }; }, (s) => has(s) && educational(s)),
    num('softening', 'm', L1.softening[0], L1.softening[1], 0.1, 2, (q) => q.softening, (_q, v) => ({ softening: v })),
    num('capture', 'm', L1.capture[0], L1.capture[1], 0.1, 2, (q) => q.capture, (_q, v) => ({ capture: v }), (s) => has(s) && src(s).kind === 'blackHole'),
    num('influence', 'm', 0, L1.influence[1], 5, 0, (q) => q.influence, (_q, v) => ({ influence: v })),
    { visible: has, key: key('massPolicy'), labelKey: L('massPolicy'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.massPolicy', MASS_POLICIES), get: (s) => src(s).massPolicy, set: (s, v) => putSrc(s, { massPolicy: v as CelestialSourceSpec['massPolicy'] }) },
    {
      visible: has, key: key('motion'), labelKey: L('motion'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.motion', MOTION_KINDS), get: (s) => src(s).motion,
      set: (s, v) => {
        const q = src(s);
        if (v === 'velocity') return putSrc(s, { motion: 'velocity', velocity: q.velocity ?? [3, 0, 0] });
        if (v === 'path') return putSrc(s, { motion: 'path', path: q.path ?? [[0, q.center[0], q.center[1], q.center[2]], [Math.min(30, C(s).duration / 2), q.center[0] + 40, q.center[1], q.center[2]], [Math.min(60, C(s).duration), q.center[0] + 40, q.center[1], q.center[2] + 40]] });
        return putSrc(s, { motion: 'fixed' });
      },
    },
    vel(0, 'vx'), vel(1, 'vy'), vel(2, 'vz'),
    // Path: the source starts at its first waypoint; two more editable waypoints (time s, x, y, z) — longer paths
    // come from presets / files.
    ...([1, 2] as const).flatMap((w) => (['t', 'x', 'y', 'z'] as const).map((c, ci): ParamField => ({
      visible: (s) => has(s) && src(s).motion === 'path' && (src(s).path?.length ?? 0) > w,
      key: key(`w${w}${c}`), labelKey: L(`w${w}${c}`), unit: c === 't' ? 's' : 'm', min: c === 't' ? 0 : c === 'y' ? -20 : -300, max: c === 't' ? L1.duration[1] : c === 'y' ? 400 : 300, step: 1, precision: 1,
      get: (s) => src(s).path![w][ci],
      set: (s, v) => { const p = src(s).path!.map((q) => [...q] as [number, number, number, number]); p[w][ci] = Number(v); return putSrc(s, { path: p }); },
    }))),
    num('start', 's', 0, L1.duration[1], 1, 0, (q) => q.start ?? 0, (_q, v) => ({ start: v })),
    // End: optional — "auto" is the experiment's duration.
    { visible: has, key: key('end'), labelKey: L('end'), unit: 's', min: 0, max: L1.duration[1], step: 1, precision: 0, optional: true, autoValue: (s) => C(s).duration, get: (s) => src(s).end, set: (s, v) => putSrc(s, { end: v === undefined || v === '' ? undefined : Number(v) }) },
    num('ramp', 's', 0, 600, 0.5, 1, (q) => q.ramp ?? 0, (_q, v) => ({ ramp: v })),
  ];
}

/** Fields of probe k. */
function probeFields(k: number): ParamField[] {
  const has = (s: EventSpec) => C(s).probes.length > k;
  const pr = (s: EventSpec) => C(s).probes[k];
  const putP = (s: EventSpec, patch: Partial<ProbeSpec>) => put(s, { probes: C(s).probes.map((q, i) => (i === k ? { ...q, ...patch } : q)) });
  const L = (name: string) => `celestial.f.probe.${name}` as MessageKey;
  const key = (name: string) => `p${k}.${name}`;
  const vec = (field: 'position' | 'direction' | 'velocity', i: 0 | 1 | 2, name: string, unit: string, min: number, max: number, step: number, visible: (s: EventSpec) => boolean = has): ParamField => ({
    visible, key: key(name), labelKey: L(name), unit, min, max, step, precision: 2,
    get: (s) => (pr(s)[field] ?? [0, 0, 0])[i],
    set: (s, v) => { const w = [...(pr(s)[field] ?? [0, 0, 0])] as [number, number, number]; w[i] = Number(v); return putP(s, { [field]: w }); },
  });
  const custom = (s: EventSpec) => has(s) && pr(s).mode === 'custom';
  const auto = (s: EventSpec) => has(s) && pr(s).mode !== 'custom';
  return [
    {
      visible: has, key: key('mode'), labelKey: L('mode'), unit: '', min: 0, max: 0, step: 0, precision: 0, options: [...opt('celestial.probeMode', PROBE_MODES), { value: 'remove', labelKey: 'celestial.kind.remove' as MessageKey }],
      get: (s) => pr(s).mode, set: (s, v) => (v === 'remove' ? put(s, { probes: C(s).probes.filter((_, i) => i !== k) }) : putP(s, { mode: v as ProbeSpec['mode'], velocity: v === 'custom' ? pr(s).velocity ?? [0, 0, 10] : pr(s).velocity })),
    },
    vec('position', 0, 'x', 'm', -300, 300, 1), vec('position', 1, 'y', 'm', -20, 400, 1), vec('position', 2, 'z', 'm', -300, 300, 1),
    { visible: auto, key: key('factor'), labelKey: L('factor'), unit: '×', min: 0, max: 10, step: 0.05, precision: 2, get: (s) => pr(s).factor, set: (s, v) => putP(s, { factor: Number(v) }) },
    vec('direction', 0, 'dx', '', -1, 1, 0.05, auto), vec('direction', 1, 'dy', '', -1, 1, 0.05, auto), vec('direction', 2, 'dz', '', -1, 1, 0.05, auto),
    vec('velocity', 0, 'vx', 'm/s', -500, 500, 0.5, custom), vec('velocity', 1, 'vy', 'm/s', -500, 500, 0.5, custom), vec('velocity', 2, 'vz', 'm/s', -500, 500, 0.5, custom),
    { visible: has, key: key('mass'), labelKey: L('mass'), unit: 'kg', min: 0.1, max: 1e6, step: 10, precision: 1, get: (s) => pr(s).mass, set: (s, v) => putP(s, { mass: Number(v) }) },
    { visible: has, key: key('radius'), labelKey: L('radius'), unit: 'm', min: 0.1, max: 10, step: 0.1, precision: 2, get: (s) => pr(s).radius, set: (s, v) => putP(s, { radius: Number(v) }) },
    { visible: (s) => has(s) && C(s).sources.length > 1, key: key('source'), labelKey: L('source'), unit: '', min: 1, max: CELESTIAL_LIMITS.sources, step: 1, precision: 0, get: (s) => (pr(s).source ?? 0) + 1, set: (s, v) => putP(s, { source: Math.max(0, Math.min(C(s).sources.length - 1, Number(v) - 1)) }) },
  ];
}

/** A new probe: circular orbit 20 m east of the first source, velocity towards +z. */
export function newProbe(s: CelestialSpec, mode: ProbeSpec['mode'], factor: number): ProbeSpec {
  const c = s.sources[0]?.center ?? [0, 30, 0];
  return { position: [c[0] + 20, c[1], c[2]], mode, factor, direction: [0, 0, 1], velocity: mode === 'custom' ? [0, 0, 20] : undefined, mass: 50, radius: 0.6 };
}

const PROBE_ADD = ['none', 'circular', 'elliptic', 'escape', 'hyperbolic', 'custom'] as const;

export const celestial = implemented<CelestialSpec>({
  type: 'celestial', labelKey: 'phen.celestial', icon: 'celestial', status: 'implemented',
  channels: ['gravity', 'mechanicalForce'],
  models: ['celestialField', 'celestialOrbits', 'celestialCapture', 'celestialStructure'],
  keywords: /블랙홀|극한\s*중력|중력원|천체|black\s*hole|celestial|gravity\s*well|singularity/,
  schema: celestialSchema,
  defaults: () => defaultCelestialSpec(),
  seeded: false,
  fields: [
    {
      key: 'scenario', labelKey: 'celestial.f.scenario', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.scenario', CELESTIAL_SCENARIOS),
      set: (s, v) => put(s, { ...scenarioDefaults(v as CelestialSpec['scenario']), scenario: v as CelestialSpec['scenario'] }),
    },
    { key: 'scale', labelKey: 'celestial.f.scale', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.scale', CELESTIAL_SCALES), set: (s, v) => put(s, { scale: v as CelestialSpec['scale'], limitPolicy: v === 'physical' ? 'stop' : C(s).limitPolicy }) },
    { key: 'duration', labelKey: 'celestial.f.duration', unit: 's', min: CELESTIAL_LIMITS.duration[0], max: CELESTIAL_LIMITS.duration[1], step: 5, precision: 0 },
    { key: 'end', labelKey: 'celestial.f.end', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.end', ['restore', 'hold'] as const) },
    { key: 'tidal', labelKey: 'celestial.f.tidal', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.onoff', ON_OFF), get: (s) => (C(s).tidal ? 'on' : 'off'), set: (s, v) => put(s, { tidal: v === 'on' }) },
    { key: 'limitPolicy', labelKey: 'celestial.f.limitPolicy', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.limitPolicy', LIMIT_POLICIES) },
    { key: 'disc', labelKey: 'celestial.f.disc', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.onoff', ON_OFF), get: (s) => (C(s).accretion.visual ? 'on' : 'off'), set: (s, v) => put(s, { accretion: { ...C(s).accretion, visual: v === 'on' } }) },
    { key: 'lensing', labelKey: 'celestial.f.lensing', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.onoff', ON_OFF), get: (s) => (C(s).lensing ? 'on' : 'off'), set: (s, v) => put(s, { lensing: v === 'on' }) },
    { key: 'particles', labelKey: 'celestial.f.particles', unit: '', min: 0, max: CELESTIAL_LIMITS.particles, step: 50, precision: 0, get: (s) => C(s).accretion.particles, set: (s, v) => put(s, { accretion: { ...C(s).accretion, particles: Math.round(Number(v)) } }) },
    { visible: (s) => C(s).accretion.particles > 0, key: 'inner', labelKey: 'celestial.f.inner', unit: 'm', min: 0.5, max: 200, step: 0.5, precision: 1, get: (s) => C(s).accretion.inner, set: (s, v) => put(s, { accretion: { ...C(s).accretion, inner: Number(v) } }) },
    { visible: (s) => C(s).accretion.particles > 0, key: 'outer', labelKey: 'celestial.f.outer', unit: 'm', min: 1, max: 300, step: 0.5, precision: 1, get: (s) => C(s).accretion.outer, set: (s, v) => put(s, { accretion: { ...C(s).accretion, outer: Number(v) } }) },
    { visible: (s) => C(s).accretion.particles > 0, key: 'spread', labelKey: 'celestial.f.spread', unit: '', min: 0, max: 0.5, step: 0.05, precision: 2, get: (s) => C(s).accretion.spread ?? 0, set: (s, v) => put(s, { accretion: { ...C(s).accretion, spread: Number(v) } }) },
    { visible: (s) => C(s).accretion.particles > 0, key: 'particleMass', labelKey: 'celestial.f.particleMass', unit: 'kg', min: 0.001, max: 1e6, step: 1, precision: 3, get: (s) => C(s).accretion.particleMass, set: (s, v) => put(s, { accretion: { ...C(s).accretion, particleMass: Number(v) } }) },
    {
      key: 'addSource', labelKey: 'celestial.f.addSource', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.add', ['none', 'blackHole', 'compact'] as const),
      get: () => 'none', set: (s, v) => (v === 'none' || C(s).sources.length >= CELESTIAL_LIMITS.sources ? s : put(s, { sources: [...C(s).sources, { ...defaultSource(), kind: v as CelestialSourceSpec['kind'], capture: v === 'compact' ? 0 : 1.5, center: [20 * C(s).sources.length, 30, 0] }] })),
    },
    ...Array.from({ length: CELESTIAL_LIMITS.sources }, (_, k) => sourceFields(k)).flat(),
    {
      visible: (s) => C(s).sources.length > 0, key: 'addProbe', labelKey: 'celestial.f.addProbe', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('celestial.addProbe', PROBE_ADD),
      get: () => 'none',
      set: (s, v) => {
        if (v === 'none' || C(s).probes.length >= CELESTIAL_LIMITS.probes) return s;
        const p = v === 'circular' ? newProbe(C(s), 'circular', 1) : v === 'elliptic' ? newProbe(C(s), 'circular', 0.7) : v === 'escape' ? newProbe(C(s), 'escape', 1) : v === 'hyperbolic' ? newProbe(C(s), 'escape', 1.3) : newProbe(C(s), 'custom', 1);
        return put(s, { probes: [...C(s).probes, p] });
      },
    },
    ...Array.from({ length: EDIT_PROBES }, (_, k) => probeFields(k)).flat(),
  ] as ParamField[],
  createEvent: (spec, now) => new CelestialEvent(spec, now),
  duration: (spec) => Math.max(1, spec.duration),
  assumptions: (spec) => celestialAssumptions(spec),
  describe: (spec) => describeCelestial(spec),
});

/** Assumptions and model limitations of a celestial experiment (editor, preview, command preview). */
export function celestialAssumptions(s: CelestialSpec): I18nMessage[] {
  const o = celestialOutlook(s);
  const out: I18nMessage[] = [{ key: 'celestial.as.model' as MessageKey }, { key: 'celestial.as.realG' as MessageKey }];
  if (s.scale === 'educational') out.push({ key: 'celestial.as.scaled' as MessageKey });
  else out.push({ key: 'celestial.as.physical' as MessageKey });
  for (const w of o.limits) out.push({ key: w as MessageKey });
  out.push({ key: 'celestial.as.notSafety' as MessageKey });
  return out;
}
