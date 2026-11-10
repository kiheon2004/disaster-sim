/**
 * Atmospheric pressure wave (Phase 24) for the phenomenon engine: editor fields, defaults and the
 * assumptions list computed with the SAME planBlast() the simulation runs on the current document
 * terrain. The input is the energy coupled into the air by a virtual release — the editor offers no
 * explosive type, composition, mass or TNT equivalence (by design).
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField, PhenomenonContext } from './types';
import { BlastEvent, blastEventDuration, describeBlast } from '@/events/blast/BlastEvent';
import { blastSchema } from '@/events/blast/blastSchema';
import { BLAST_LIMITS, BLAST_MODELS, BLAST_WAVEFORMS, STANDARD_PRESSURE, type BlastSpec } from '@/blast/types';
import { planBlast, type BlastPlan } from '@/blast/plan';
import { AIR_DENSITY } from '@/core/units';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const nested = <S,>(get: (s: S) => number | string | undefined, set: (s: S, v: number | string | undefined) => S) => ({
  get: (s: EventSpec) => get(s as unknown as S),
  set: (s: EventSpec, v: number | string | undefined) => set(s as unknown as S, v) as unknown as EventSpec,
});

/** Plan cache (the editor re-renders often; the plan only changes with the spec / terrain). */
let cache: { spec: BlastSpec; terrain: unknown; plan: BlastPlan } | null = null;

export function blastOutlook(spec: BlastSpec, ctx: PhenomenonContext): BlastPlan | null {
  if (!ctx.terrain) return null;
  if (cache && cache.spec === spec && cache.terrain === ctx.terrain) return cache.plan;
  const plan = planBlast(spec, ctx.terrain);
  cache = { spec, terrain: ctx.terrain, plan };
  return plan;
}

export const energyText = (E: number) => (E >= 1e12 ? `${(E / 1e12).toFixed(2)} TJ` : E >= 1e9 ? `${(E / 1e9).toFixed(2)} GJ` : E >= 1e6 ? `${(E / 1e6).toFixed(2)} MJ` : `${(E / 1e3).toFixed(1)} kJ`);

export const blast = implemented<BlastSpec>({
  type: 'blast', labelKey: 'phen.blast', icon: 'blast', status: 'implemented',
  channels: ['pressure', 'mechanicalForce'],
  models: ['blastWave', 'blastLoading', 'blastShielding', 'structural'],
  keywords: /폭발|압력파|폭풍파|폭풍압|충격파|explosion|explode|blast|pressure\s*wave|shock\s*wave/,
  schema: blastSchema,
  defaults: () => ({ event: 'blast', position: [0, 0], height: 1, energy: 1e8, model: 'weakShock', waveform: 'nWave' }),
  seeded: false,
  fields: [
    { key: 'x', labelKey: 'blast.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...nested<BlastSpec>((s) => s.position[0], (s, v) => ({ ...s, position: [Number(v), s.position[1]] })) },
    { key: 'z', labelKey: 'blast.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...nested<BlastSpec>((s) => s.position[1], (s, v) => ({ ...s, position: [s.position[0], Number(v)] })) },
    { key: 'height', labelKey: 'blast.f.height', unit: 'm', min: BLAST_LIMITS.height[0], max: BLAST_LIMITS.height[1], step: 0.5, precision: 1 },
    { key: 'energy', labelKey: 'blast.f.energy', unit: 'MJ', min: BLAST_LIMITS.energy[0] / 1e6, max: BLAST_LIMITS.energy[1] / 1e6, step: 1, precision: 3, scale: 1e-6 },
    { key: 'model', labelKey: 'blast.f.model', unit: '', min: 0, max: 0, step: 0, precision: 0, options: BLAST_MODELS.map((m) => ({ value: m, labelKey: `blast.model.${m}` as MessageKey })) },
    { key: 'waveform', labelKey: 'blast.f.waveform', unit: '', min: 0, max: 0, step: 0, precision: 0, options: BLAST_WAVEFORMS.map((m) => ({ value: m, labelKey: `blast.waveform.${m}` as MessageKey })) },
    { key: 'ambientPressure', labelKey: 'blast.f.pressure', unit: 'kPa', min: BLAST_LIMITS.ambientPressure[0] / 1000, max: BLAST_LIMITS.ambientPressure[1] / 1000, step: 0.5, precision: 2, scale: 0.001, optional: true, autoValue: () => STANDARD_PRESSURE },
    { key: 'ambientDensity', labelKey: 'blast.f.density', unit: 'kg/m³', min: BLAST_LIMITS.ambientDensity[0], max: BLAST_LIMITS.ambientDensity[1], step: 0.01, precision: 3, optional: true, autoValue: () => AIR_DENSITY },
  ] as ParamField[],
  createEvent: (spec, now, ctx) => new BlastEvent(spec, now, ctx.terrain),
  duration: (spec, ctx) => blastEventDuration(spec, ctx.terrain),
  assumptions: (spec, ctx) => {
    const out: I18nMessage[] = [{ key: 'blast.as.virtual' }, { key: 'blast.as.model' }, { key: spec.height < 0.5 ? 'blast.as.surface' : 'blast.as.elevated' }];
    const p = blastOutlook(spec, ctx);
    if (!p) return out;
    out.push({ key: 'blast.as.ambient', params: { p: (p.ambient.p / 1000).toFixed(2), rho: p.ambient.rho.toFixed(3), c: p.ambient.c.toFixed(0), T: (p.temperature - 273.15).toFixed(0) } });
    out.push({ key: 'blast.as.scales', params: { R0: p.R0.toFixed(1), rt: p.rt.toFixed(1), valid: p.validRadius.toFixed(1), eff: (100 * p.efficiency).toFixed(0), Ep: energyText(p.pulseEnergy) } });
    const s50 = p.wave.sample(50);
    out.push({ key: 'blast.as.at50', params: { p: (s50.dp / 1000).toFixed(2), T: (s50.T * 1000).toFixed(1), I: (0.5 * s50.dp * s50.T).toFixed(1), t: (s50.t * 1000).toFixed(0) } });
    out.push({ key: 'blast.as.shielding' });
    for (const w of p.warnings) out.push({ key: w.key as MessageKey, params: w.params });
    return out;
  },
  describe: (spec) => describeBlast(spec),
});
