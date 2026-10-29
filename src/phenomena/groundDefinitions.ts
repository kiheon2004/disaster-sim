/**
 * Sinkhole and landslide phenomena (Phase 22) for the phenomenon engine: parameters shown in the
 * experiment editor, defaults, assumptions (with the predicted outcome and validation issues on
 * the ACTUAL ground), models and channels.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { TerrainData } from '@/core/model';
import type { ImplementedPhenomenon, ParamField, PhenomenonContext } from './types';
import { LandslideEvent, SinkholeEvent, groundEventDuration } from '@/events/ground/GroundEvents';
import { landslideSchema, sinkholeSchema } from '@/events/ground/groundSchema';
import { MECHANICAL_IDS, MECHANICAL_PROFILES, mechanicalOf, type MechanicalProfile } from '@/ground/materials';
import { LANDSLIDE_LIMITS, LANDSLIDE_TRIGGERS, SINKHOLE_INITIATIONS, SINKHOLE_LIMITS, type LandslideSpec, type SinkholeSpec } from '@/ground/types';
import { SinkholeModel } from '@/ground/sinkhole';
import { LandslideModel } from '@/ground/landslide';
import { GeoField } from '@/ground/GeoField';
import { areaCentroid } from '@/ground/common';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const nested = <S,>(get: (s: S) => number | string | undefined, set: (s: S, v: number | string | undefined) => S) => ({
  get: (s: EventSpec) => get(s as unknown as S),
  set: (s: EventSpec, v: number | string | undefined) => set(s as unknown as S, v) as unknown as EventSpec,
});

const materialField = <S extends { material?: string }>(): ParamField => ({
  key: 'material', labelKey: 'geo.material', unit: '', min: 0, max: 0, step: 0, precision: 0,
  options: [{ value: 'auto', labelKey: 'geo.material.auto' }, ...MECHANICAL_IDS.map((id) => ({ value: id, labelKey: MECHANICAL_PROFILES[id].labelKey }))],
  ...nested<S>((s) => s.material ?? 'auto', (s, v) => {
    const n = { ...s } as S;
    if (v === 'auto' || v === undefined) delete n.material;
    else (n as { material?: string }).material = String(v);
    return n;
  }),
});

/** Mechanical profile at a point of a terrain (the soil map's default) or the spec's override. */
export function profileAt(t: TerrainData | null, x: number, z: number, override?: string): MechanicalProfile {
  if (override) return MECHANICAL_PROFILES[override as keyof typeof MECHANICAL_PROFILES];
  if (!t) return MECHANICAL_PROFILES.denseGranular;
  const ix = Math.round((x - t.originX) / t.cellSize), iz = Math.round((z - t.originZ) / t.cellSize);
  if (ix < 0 || iz < 0 || ix >= t.nx || iz >= t.nz) return MECHANICAL_PROFILES.denseGranular;
  return mechanicalOf(t.soil[iz * t.nx + ix]);
}

const inside = (t: TerrainData | null, x: number, z: number) => !t || (x >= t.originX && z >= t.originZ && x <= t.originX + (t.nx - 1) * t.cellSize && z <= t.originZ + (t.nz - 1) * t.cellSize);

/** Default input of each initiation mode (filled in when the mode is chosen and the input is unset). */
const SINKHOLE_MODE_DEFAULTS: Record<SinkholeSpec['initiation'], Partial<SinkholeSpec>> = {
  growth: { growthRate: 0.2 }, supportLoss: { supportLoss: 0.5 }, water: { saturation: 1 }, load: { surcharge: 50 },
};

// ── Sinkhole ────────────────────────────────────────────────────────────────

export function sinkholeOutlook(spec: SinkholeSpec, ctx: PhenomenonContext) {
  const p = profileAt(ctx.terrain, spec.center[0], spec.center[1], spec.material);
  return { profile: p, ...SinkholeModel.predict(spec, p) };
}

export const sinkhole = implemented<SinkholeSpec>({
  type: 'sinkhole', labelKey: 'phen.sinkhole', icon: 'warning', status: 'implemented',
  channels: ['groundSupport', 'terrainDeformation', 'sediment', 'mechanicalForce'],
  models: ['sinkholePlug', 'cutStability', 'granularRunout', 'bedDisplacement', 'foundationSettlement', 'roadDeformation', 'sedimentLoads'],
  keywords: /싱크홀|땅\s*꺼짐|지반\s*함몰|sinkhole/,
  schema: sinkholeSchema,
  defaults: () => ({ event: 'sinkhole', center: [0, 0], cavityRadius: 3, cavityHeight: 6, cover: 6, initiation: 'growth', growthRate: 0.2, duration: 30 }),
  seeded: true,
  fields: [
    { key: 'x', labelKey: 'deform.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...nested<SinkholeSpec>((s) => s.center[0], (s, v) => ({ ...s, center: [Number(v), s.center[1]] })) },
    { key: 'z', labelKey: 'deform.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...nested<SinkholeSpec>((s) => s.center[1], (s, v) => ({ ...s, center: [s.center[0], Number(v)] })) },
    { key: 'cavityRadius', labelKey: 'sink.cavityRadius', unit: 'm', min: SINKHOLE_LIMITS.cavityRadius[0], max: SINKHOLE_LIMITS.cavityRadius[1], step: 0.5, precision: 1 },
    { key: 'cavityHeight', labelKey: 'sink.cavityHeight', unit: 'm', min: SINKHOLE_LIMITS.cavityHeight[0], max: SINKHOLE_LIMITS.cavityHeight[1], step: 0.5, precision: 1 },
    { key: 'cover', labelKey: 'sink.cover', unit: 'm', min: SINKHOLE_LIMITS.cover[0], max: SINKHOLE_LIMITS.cover[1], step: 0.5, precision: 1 },
    materialField<SinkholeSpec>(),
    {
      key: 'initiation', labelKey: 'sink.initiation', unit: '', min: 0, max: 0, step: 0, precision: 0, options: SINKHOLE_INITIATIONS.map((k) => ({ value: k, labelKey: `sink.init.${k}` as MessageKey })),
      // Switching the mode gives its input a default (an unset input could not be edited).
      ...nested<SinkholeSpec>((s) => s.initiation, (s, v) => ({ ...SINKHOLE_MODE_DEFAULTS[v as SinkholeSpec['initiation']], ...s, initiation: v as SinkholeSpec['initiation'] })),
    },
    { visible: (s) => (s as SinkholeSpec).initiation === 'growth', key: 'growthRate', labelKey: 'sink.growthRate', unit: 'cm/s', min: 0, max: 100, step: 1, precision: 1, scale: 100 },
    { visible: (s) => (s as SinkholeSpec).initiation === 'supportLoss', key: 'supportLoss', labelKey: 'sink.supportLoss', unit: '%', min: 0, max: 95, step: 5, precision: 0, scale: 100 },
    { visible: (s) => (s as SinkholeSpec).initiation === 'water', key: 'saturation', labelKey: 'sink.saturation', unit: '%', min: 0, max: 100, step: 5, precision: 0, scale: 100 },
    { visible: (s) => (s as SinkholeSpec).initiation === 'load', key: 'surcharge', labelKey: 'sink.surcharge', unit: 'kPa', min: 0, max: 500, step: 5, precision: 0 },
    { key: 'duration', labelKey: 'sink.duration', unit: 's', min: 0, max: SINKHOLE_LIMITS.duration[1], step: 1, precision: 0 },
    { key: 'variability', labelKey: 'geo.variability', unit: '%', min: 0, max: 50, step: 5, precision: 0, scale: 100, optional: true },
  ],
  createEvent: (spec, now, ctx) => new SinkholeEvent(spec, now, ctx.seed),
  duration: (spec) => groundEventDuration(spec),
  assumptions: (spec, ctx) => {
    const o = sinkholeOutlook(spec, ctx);
    const out: I18nMessage[] = [
      { key: 'sink.as.hidden' },
      { key: `sink.as.mode.${spec.initiation}` as MessageKey },
      { key: 'sink.as.material', params: { c: o.profile.cohesion, ca: o.profile.apparentCohesion, phi: o.profile.friction, b: o.profile.bulking.toFixed(2) } },
      { key: 'sink.as.critical', params: { ac: o.criticalRadius.toFixed(1), fs0: o.fs0.toFixed(2), fs1: o.fsEnd.toFixed(2) } },
      o.choked ? { key: 'sink.as.choked', params: { d: o.drop.toFixed(2) } } : { key: 'sink.as.drop', params: { d: o.drop.toFixed(2), t: o.fallTime.toFixed(2) } },
      { key: o.fails ? 'sink.as.expectFail' : 'sink.as.expectStable' },
    ];
    if (!inside(ctx.terrain, spec.center[0], spec.center[1])) out.push({ key: 'geo.issue.outside' });
    if (!o.profile.failureModel) out.push({ key: 'geo.issue.rock' });
    return out;
  },
  describe: (spec) => new SinkholeEvent(spec, 0, 1).describe(),
});

// ── Landslide ───────────────────────────────────────────────────────────────

/** FS summary of the area on the current ground (preview / assumptions). */
export function landslideOutlook(spec: LandslideSpec, ctx: PhenomenonContext) {
  if (!ctx.terrain) return null;
  const f = new GeoField(ctx.terrain);
  const H = ctx.terrain.heights;
  return LandslideModel.preview(spec, f, (i) => H[i]);
}

const circleField = (k: 'x' | 'z' | 'r'): Partial<ParamField> => ({
  visible: (s) => (s as LandslideSpec).area.kind === 'circle',
  ...nested<LandslideSpec>(
    (s) => (s.area.kind === 'circle' ? (k === 'x' ? s.area.center[0] : k === 'z' ? s.area.center[1] : s.area.radius) : undefined),
    (s, v) => {
      if (s.area.kind !== 'circle') return s;
      const a = { ...s.area, center: [...s.area.center] as [number, number] };
      if (k === 'x') a.center[0] = Number(v);
      else if (k === 'z') a.center[1] = Number(v);
      else a.radius = Number(v);
      return { ...s, area: a };
    },
  ),
});

export const landslide = implemented<LandslideSpec>({
  type: 'landslide', labelKey: 'phen.landslide', icon: 'warning', status: 'implemented',
  channels: ['groundSupport', 'sediment', 'terrainDeformation', 'mechanicalForce'],
  models: ['infiniteSlope', 'newmark', 'granularRunout', 'sedimentLoads', 'bedDisplacement', 'foundationSettlement', 'roadDeformation'],
  keywords: /산사태|토석류|사면\s*붕괴|landslide|mudslide|debris\s*flow/,
  schema: landslideSchema,
  defaults: () => ({ event: 'landslide', area: { kind: 'circle', center: [0, 0], radius: 25 }, thickness: 2, saturation: 0.3, trigger: 'saturation', targetSaturation: 1, duration: 60 }),
  seeded: true,
  fields: [
    { key: 'ax', labelKey: 'slide.areaX', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...circleField('x') } as ParamField,
    { key: 'az', labelKey: 'slide.areaZ', unit: 'm', min: -100, max: 100, step: 1, precision: 1, ...circleField('z') } as ParamField,
    { key: 'ar', labelKey: 'slide.areaRadius', unit: 'm', min: LANDSLIDE_LIMITS.radius[0], max: LANDSLIDE_LIMITS.radius[1], step: 1, precision: 0, ...circleField('r') } as ParamField,
    { key: 'thickness', labelKey: 'slide.thickness', unit: 'm', min: LANDSLIDE_LIMITS.thickness[0], max: LANDSLIDE_LIMITS.thickness[1], step: 0.1, precision: 1 },
    materialField<LandslideSpec>(),
    { key: 'saturation', labelKey: 'slide.saturation', unit: '%', min: 0, max: 100, step: 5, precision: 0, scale: 100 },
    {
      key: 'trigger', labelKey: 'slide.trigger', unit: '', min: 0, max: 0, step: 0, precision: 0, options: LANDSLIDE_TRIGGERS.map((k) => ({ value: k, labelKey: `slide.trigger.${k}` as MessageKey })),
      ...nested<LandslideSpec>((s) => s.trigger, (s, v) => ({ ...(v === 'saturation' ? { targetSaturation: 1 } : {}), ...s, trigger: v as LandslideSpec['trigger'] })),
    },
    { visible: (s) => (s as LandslideSpec).trigger === 'saturation', key: 'targetSaturation', labelKey: 'slide.targetSaturation', unit: '%', min: 0, max: 100, step: 5, precision: 0, scale: 100 },
    { visible: (s) => (s as LandslideSpec).trigger === 'saturation', key: 'duration', labelKey: 'sink.duration', unit: 's', min: 0, max: LANDSLIDE_LIMITS.duration[1], step: 1, precision: 0 },
    { visible: (s) => (s as LandslideSpec).trigger === 'earthquake', key: 'newmarkLimit', labelKey: 'slide.newmarkLimit', unit: 'cm', min: 1, max: 100, step: 1, precision: 0, scale: 100, optional: true },
    { key: 'turbulence', labelKey: 'slide.turbulence', unit: 'm/s²', min: LANDSLIDE_LIMITS.turbulence[0], max: LANDSLIDE_LIMITS.turbulence[1], step: 50, precision: 0, optional: true },
    { key: 'boundary', labelKey: 'slide.boundary', unit: '', min: 0, max: 0, step: 0, precision: 0, options: [{ value: 'closed', labelKey: 'slide.boundary.closed' }, { value: 'open', labelKey: 'slide.boundary.open' }], ...nested<LandslideSpec>((s) => s.boundary ?? 'closed', (s, v) => ({ ...s, boundary: v as 'closed' | 'open' })) },
    { key: 'variability', labelKey: 'geo.variability', unit: '%', min: 0, max: 50, step: 5, precision: 0, scale: 100, optional: true },
  ],
  createEvent: (spec, now, ctx) => new LandslideEvent(spec, now, ctx.seed),
  duration: (spec) => groundEventDuration(spec),
  assumptions: (spec, ctx) => {
    const out: I18nMessage[] = [{ key: 'slide.as.model' }, { key: `slide.as.trigger.${spec.trigger}` as MessageKey }, { key: 'slide.as.runout' }];
    const o = landslideOutlook(spec, ctx);
    if (o) {
      out.push(o.cells.length === 0 ? { key: 'geo.issue.outside' } : { key: 'slide.as.outlook', params: { min: Number.isFinite(o.minFS) ? o.minFS.toFixed(2) : '∞', n: o.unstable, v: Math.round(o.volume), total: o.cells.length } });
      const c = areaCentroid(spec.area);
      if (!profileAt(ctx.terrain, c[0], c[1], spec.material).failureModel) out.push({ key: 'geo.issue.rock' });
      if (o.cells.length && !Number.isFinite(o.minFS) && spec.trigger !== 'user') out.push({ key: 'slide.issue.flat' });
    }
    return out;
  },
  describe: (spec) => new LandslideEvent(spec, 0, 1).describe(),
});
