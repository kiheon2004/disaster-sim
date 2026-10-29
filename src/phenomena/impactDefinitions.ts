/**
 * Meteoroid / asteroid impact (Phase 23) for the phenomenon engine: parameters of the experiment
 * editor, defaults, and the assumptions list — computed with the SAME planImpact() the simulation
 * runs, on the current document terrain (the preview never draws an invented crater).
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField, PhenomenonContext } from './types';
import { describeImpact, ImpactEvent, impactEventDuration } from '@/events/impact/ImpactEvent';
import { impactSchema } from '@/events/impact/impactSchema';
import { DEFAULT_AIR_COUPLING, IMPACT_LIMITS, PROJECTILE_MATERIALS, type ImpactSpec } from '@/impact/types';
import { PROJECTILES, sphereMass } from '@/impact/projectile';
import { planImpact, shockAt, type ImpactPlan } from '@/impact/plan';
import { tntTonnes } from '@/impact/energy';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const nested = <S,>(get: (s: S) => number | string | undefined, set: (s: S, v: number | string | undefined) => S) => ({
  get: (s: EventSpec) => get(s as unknown as S),
  set: (s: EventSpec, v: number | string | undefined) => set(s as unknown as S, v) as unknown as EventSpec,
});

/** Plan cache: the editor re-renders often; the plan only changes with the spec / terrain / seed. */
let cache: { spec: ImpactSpec; terrain: unknown; seed: number; withEjecta: boolean; plan: ImpactPlan } | null = null;

export function impactOutlook(spec: ImpactSpec, ctx: PhenomenonContext, withEjecta = true): ImpactPlan | null {
  if (!ctx.terrain) return null;
  const seed = spec.seed ?? ctx.seed;
  if (cache && cache.spec === spec && cache.terrain === ctx.terrain && cache.seed === seed && (cache.withEjecta || !withEjecta)) return cache.plan;
  const plan = planImpact(spec, ctx.terrain, seed, withEjecta);
  cache = { spec, terrain: ctx.terrain, seed, withEjecta, plan };
  return plan;
}

const fmtE = (E: number) => (E >= 1e12 ? `${(E / 1e12).toFixed(2)} TJ` : E >= 1e9 ? `${(E / 1e9).toFixed(2)} GJ` : `${(E / 1e6).toFixed(2)} MJ`);

export const impact = implemented<ImpactSpec>({
  type: 'impact', labelKey: 'phen.meteor', icon: 'warning', status: 'implemented',
  channels: ['groundMotion', 'terrainDeformation', 'sediment', 'mechanicalForce'],
  models: ['impactEntry', 'craterScaling', 'ejectaBallistics', 'groundShock', 'granularRunout', 'bedDisplacement', 'foundationSettlement', 'roadDeformation'],
  keywords: /운석|소행성|유성체|meteor|asteroid|meteoroid|impactor/,
  schema: impactSchema,
  defaults: () => ({ event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere', airBlast: true }),
  seeded: true,
  fields: [
    { key: 'x', labelKey: 'impact.f.targetX', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...nested<ImpactSpec>((s) => s.target[0], (s, v) => ({ ...s, target: [Number(v), s.target[1]] })) },
    { key: 'z', labelKey: 'impact.f.targetZ', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...nested<ImpactSpec>((s) => s.target[1], (s, v) => ({ ...s, target: [s.target[0], Number(v)] })) },
    {
      key: 'material', labelKey: 'impact.f.material', unit: '', min: 0, max: 0, step: 0, precision: 0,
      options: PROJECTILE_MATERIALS.map((m) => ({ value: m, labelKey: PROJECTILES[m].labelKey })),
      // A new material drops a density / mass override that belonged to the old one.
      ...nested<ImpactSpec>((s) => s.material, (s, v) => { const n = { ...s, material: v as ImpactSpec['material'] }; delete n.density; delete n.mass; return n; }),
    },
    { key: 'diameter', labelKey: 'impact.f.diameter', unit: 'm', min: IMPACT_LIMITS.diameter[0], max: IMPACT_LIMITS.diameter[1], step: 0.1, precision: 2 },
    { key: 'density', labelKey: 'impact.f.density', unit: 'kg/m³', min: IMPACT_LIMITS.density[0], max: IMPACT_LIMITS.density[1], step: 50, precision: 0, optional: true, autoValue: (s) => PROJECTILES[(s as ImpactSpec).material].density },
    { key: 'mass', labelKey: 'impact.f.mass', unit: 't', min: 0.001, max: 100000, step: 1, precision: 3, scale: 0.001, optional: true, autoValue: (s) => { const x = s as ImpactSpec; return sphereMass(x.diameter, x.density ?? PROJECTILES[x.material].density); } },
    { key: 'speed', labelKey: 'impact.f.speed', unit: 'km/s', min: IMPACT_LIMITS.speed[0] / 1000, max: IMPACT_LIMITS.speed[1] / 1000, step: 0.5, precision: 1, scale: 0.001 },
    { key: 'angle', labelKey: 'impact.f.angle', unit: '°', min: IMPACT_LIMITS.angle[0], max: IMPACT_LIMITS.angle[1], step: 1, precision: 0 },
    { key: 'azimuth', labelKey: 'impact.f.azimuth', unit: '°', min: 0, max: 359, step: 5, precision: 0 },
    { key: 'entry', labelKey: 'impact.f.entry', unit: '', min: 0, max: 0, step: 0, precision: 0, options: [{ value: 'atmosphere', labelKey: 'impact.entry.atmosphere' }, { value: 'direct', labelKey: 'impact.entry.direct' }] },
    // Phase 24: the impact's atmospheric pressure wave (off for files saved before Phase 24).
    {
      key: 'airBlast', labelKey: 'impact.f.airBlast', unit: '', min: 0, max: 0, step: 0, precision: 0,
      options: [{ value: 'on', labelKey: 'impact.airBlast.on' }, { value: 'off', labelKey: 'impact.airBlast.off' }],
      ...nested<ImpactSpec>((s) => (s.airBlast ? 'on' : 'off'), (s, v) => { const n = { ...s, airBlast: v === 'on' }; if (!n.airBlast) delete n.airCoupling; return n; }),
    },
    { visible: (s) => !!(s as ImpactSpec).airBlast, key: 'airCoupling', labelKey: 'impact.f.airCoupling', unit: '%', min: IMPACT_LIMITS.airCoupling[0] * 100, max: IMPACT_LIMITS.airCoupling[1] * 100, step: 0.5, precision: 1, scale: 100, optional: true, autoValue: () => DEFAULT_AIR_COUPLING },
  ] as ParamField[],
  createEvent: (spec, now, ctx) => new ImpactEvent(spec, now, ctx.seed),
  duration: (spec) => impactEventDuration(spec),
  assumptions: (spec, ctx) => {
    const out: I18nMessage[] = [{ key: 'impact.as.sphere' }, { key: spec.entry === 'atmosphere' ? 'impact.as.entry' : 'impact.as.direct' }];
    const p = impactOutlook(spec, ctx, false);
    if (!p) return out;
    out.push({ key: 'impact.as.projectile', params: { m: (p.projectile.mass / 1000).toFixed(2), rho: p.projectile.density, Y: (p.projectile.strength / 1e6).toFixed(1) } });
    if (p.airburst) {
      out.push({ key: 'impact.as.noGround', params: { t: p.timeToImpact.toFixed(1) } });
    } else {
      out.push({ key: 'impact.as.atGround', params: { v: p.speed.toFixed(0), m: (p.mass / 1000).toFixed(2), a: p.angle.toFixed(0), t: p.timeToImpact.toFixed(1), E: fmtE(p.energy), tnt: tntTonnes(p.energy).toFixed(2), P: (Math.hypot(...p.momentum) / 1000).toFixed(0) } });
      if (p.crater) {
        const s50 = shockAt(p, 50);
        out.push({ key: 'impact.as.crater', params: { D: (2 * p.crater.radius).toFixed(1), d: p.crater.depth.toFixed(1), regime: p.crater.regime, set: p.crater.set.id, V: p.crater.volume.toFixed(0) } });
        out.push({ key: 'impact.as.shock', params: { pgv: s50.pgv.toFixed(3), pga: (s50.pga / 9.81).toFixed(2), app: (s50.pgaApplied / 9.81).toFixed(2) } });
      }
    }
    if (spec.airBlast) {
      const E = p.airburst ? p.partition.airburstBlast : p.partition.blast;
      out.push({ key: p.airburst ? 'impact.as.airBlastBurst' : 'impact.as.airBlast', params: { E: fmtE(E), pct: ((spec.airCoupling ?? DEFAULT_AIR_COUPLING) * 100).toFixed(1) } });
    } else out.push({ key: 'impact.as.noAirBlast' });
    for (const w of p.warnings) out.push({ key: w.key as MessageKey, params: w.params });
    return out;
  },
  describe: (spec) => describeImpact(spec),
});
