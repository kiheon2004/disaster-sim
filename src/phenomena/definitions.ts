/**
 * Phenomenon definitions (Phase 15). The implemented ones WRAP the existing events (Phase 3–14)
 * without changing them; the planned ones are recognized and documented, never executed.
 */
import type { I18nMessage } from '@/i18n/i18n';
import { bearingOf } from '@/core/compass';
import type { BoundarySide } from '@/core/model';
import type { EarthquakeEventSpec, EventSpec, RainEventSpec, RisingWaterEventSpec, WaterSourceEventSpec, WindEventSpec } from '@/events/specs';
import { WindEvent } from '@/events/wind/WindEvent';
import { windEventSchema } from '@/events/wind/windSchema';
import { EarthquakeEvent } from '@/events/earthquake/EarthquakeEvent';
import { earthquakeEventSchema } from '@/events/earthquake/earthquakeSchema';
import { resolveEarthquake } from '@/events/earthquake/resolveEarthquake';
import { RainEvent, RisingWaterEvent, WaterSourceEvent } from '@/events/flood/WaterEvents';
import { rainEventSchema, risingWaterEventSchema, waterSourceEventSchema } from '@/events/flood/floodSchema';
import { DEFAULT_SOURCE_RADIUS, rainAssumptions, resolveRisingWater, sourceAssumptions } from '@/events/flood/resolveFlood';
import type { ImplementedPhenomenon, PhenomenonContext, PlannedPhenomenon } from './types';

/** Typed helper: keeps each definition's own spec type while registering it type-erased. */
function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const minutes = 1 / 60;

// ── Wind / typhoon (Phase 3–10) ─────────────────────────────────────────────

const wind = implemented<WindEventSpec>({
  type: 'wind', labelKey: 'phen.wind', icon: 'wind', status: 'implemented',
  channels: ['airflow', 'mechanicalForce'],
  models: ['windLoad', 'spatialWind', 'windDamage', 'weatherVisuals'],
  keywords: /바람|풍속|태풍|강풍|돌풍|폭풍|wind|typhoon|hurricane|gale|storm|gust/,
  schema: windEventSchema,
  defaults: () => ({ event: 'wind', speed: 40, direction: 'E', duration: 60, gustStrength: 0.3, rampDuration: 4 }),
  seeded: false,
  fields: [
    { key: 'speed', labelKey: 'param.windSpeed', unit: 'm/s', min: 0, max: 150, step: 1, precision: 0 },
    {
      key: 'direction', labelKey: 'param.windFrom', unit: '°', min: 0, max: 359, step: 5, precision: 0,
      get: (s) => bearingOf((s as WindEventSpec).direction), set: (s, v) => ({ ...(s as WindEventSpec), direction: Number(v) }),
    },
    { key: 'duration', labelKey: 'param.duration', unit: 's', min: 1, max: 3600, step: 5, precision: 0 },
    { key: 'gustStrength', labelKey: 'param.gust', unit: '%', min: 0, max: 100, step: 5, precision: 0, scale: 100, optional: true },
    { key: 'rampDuration', labelKey: 'param.ramp', unit: 's', min: 0.5, max: 600, step: 1, precision: 1, optional: true },
  ],
  createEvent: (spec, now) => new WindEvent(spec, now),
  duration: (spec) => spec.duration,
  assumptions: (spec) => {
    const out: I18nMessage[] = [];
    if (spec.gustStrength === undefined) out.push({ key: 'phen.assume.gust', params: { pct: 25 } });
    if (spec.rampDuration === undefined) out.push({ key: 'phen.assume.ramp', params: { s: 3 } });
    return out;
  },
  describe: (spec) => new WindEvent(spec, 0).describe(),
});

// ── Earthquake (Phase 13) ─────────────────────────────────────────────────

const earthquake = implemented<EarthquakeEventSpec>({
  type: 'earthquake', labelKey: 'phen.earthquake', icon: 'quake', status: 'implemented',
  channels: ['groundMotion', 'mechanicalForce'],
  models: ['groundMotion', 'structural'],
  keywords: /지진|여진|earthquake|quake|seismic|tremor/,
  schema: earthquakeEventSchema,
  defaults: () => ({ event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 25 }),
  seeded: true,
  fields: [
    { key: 'magnitude', labelKey: 'eq.form.magnitude', unit: 'M', min: 3, max: 9.5, step: 0.1, precision: 1 },
    { key: 'pga', labelKey: 'eq.form.pga', unit: 'g', min: 0.01, max: 2, step: 0.01, precision: 2, optional: true },
    { key: 'duration', labelKey: 'param.duration', unit: 's', min: 5, max: 180, step: 1, precision: 0, optional: true },
    { key: 'dominantFrequency', labelKey: 'eq.form.frequency', unit: 'Hz', min: 0.3, max: 10, step: 0.1, precision: 1, optional: true },
    { key: 'depth', labelKey: 'eq.form.depth', unit: 'km', min: 0, max: 700, step: 1, precision: 0, optional: true },
  ],
  createEvent: (spec, now, ctx) => new EarthquakeEvent(spec, now, ctx.seed),
  duration: (spec, ctx) => resolveEarthquake(spec, ctx.seed).duration,
  assumptions: (spec, ctx) => resolveEarthquake(spec, ctx.seed).assumptions,
  describe: (spec, ctx) => {
    const q = resolveEarthquake(spec, ctx.seed);
    return { key: 'event.earthquake.describe', params: { magnitude: q.magnitude.toFixed(1), pga: q.pga.toFixed(2), duration: Math.round(q.duration) } };
  },
});

// ── Flood (Phase 14) ──────────────────────────────────────────────────────

const rain = implemented<RainEventSpec>({
  type: 'rain', labelKey: 'phen.rain', icon: 'rain', status: 'implemented',
  channels: ['water'],
  models: ['water', 'infiltration', 'weatherVisuals'],
  keywords: /폭우|호우|강우|장대비|소나기|rain|downpour|rainfall/,
  schema: rainEventSchema,
  defaults: () => ({ event: 'rain', intensity: 80, duration: 1800 }),
  seeded: false,
  fields: [
    { key: 'intensity', labelKey: 'flood.form.intensity', unit: 'mm/h', min: 0.1, max: 500, step: 5, precision: 1 },
    { key: 'duration', labelKey: 'param.duration', unit: 'min', min: 1 / 60, max: 360, step: 1, precision: 1, scale: minutes },
  ],
  createEvent: (spec, now) => new RainEvent(spec, now),
  duration: (spec) => spec.duration,
  assumptions: (spec) => rainAssumptions(spec),
  describe: (spec) => ({ key: 'event.rain.describe', params: { mm: spec.intensity, min: +(spec.duration / 60).toFixed(1) } }),
});

const SIDE_OPTIONS = (['N', 'E', 'S', 'W'] as BoundarySide[]).map((s) => ({ value: s, labelKey: `side.${s}` as const }));

const risingWater = implemented<RisingWaterEventSpec>({
  type: 'risingWater', labelKey: 'phen.risingWater', icon: 'water', status: 'implemented',
  channels: ['water'],
  models: ['water'],
  keywords: /수위|범람|홍수|침수|water\s*level|rising\s*water|flood|inundat/,
  schema: risingWaterEventSchema,
  defaults: () => ({ event: 'risingWater', boundary: 'S', level: 1.5, riseRate: 0.5 }),
  seeded: false,
  fields: [
    { key: 'boundary', labelKey: 'flood.form.boundary', unit: '', min: 0, max: 0, step: 0, precision: 0, options: SIDE_OPTIONS },
    { key: 'level', labelKey: 'flood.form.level', unit: 'm', min: -30, max: 60, step: 0.1, precision: 2 },
    { key: 'riseRate', labelKey: 'flood.form.riseRate', unit: 'm/min', min: 0.01, max: 10, step: 0.05, precision: 2, optional: true },
    { key: 'duration', labelKey: 'param.duration', unit: 's', min: 1, max: 21600, step: 10, precision: 0, optional: true },
  ],
  createEvent: (spec, now, ctx) => new RisingWaterEvent(spec, now, ctx.terrain, ctx.water),
  duration: (spec, ctx) => resolveRisingWater(spec, ctx.terrain, ctx.water).duration,
  assumptions: (spec, ctx) => resolveRisingWater(spec, ctx.terrain, ctx.water).assumptions,
  describe: (spec, ctx) => ({
    key: `event.risingWater.describe.${spec.boundary}`, params: { level: spec.level.toFixed(1), rate: resolveRisingWater(spec, ctx.terrain, ctx.water).riseRate },
  }),
});

const waterSource = implemented<WaterSourceEventSpec>({
  type: 'waterSource', labelKey: 'phen.waterSource', icon: 'water', status: 'implemented',
  channels: ['water'],
  models: ['water'],
  keywords: /물\s*공급|유입|수도관|water\s*source|inflow|pump/,
  schema: waterSourceEventSchema,
  defaults: () => ({ event: 'waterSource', position: [0, 0], rate: 5, duration: 600 }),
  seeded: false,
  fields: [
    { key: 'rate', labelKey: 'flood.form.rate', unit: 'm³/s', min: 0.001, max: 200, step: 0.5, precision: 3 },
    {
      key: 'x', labelKey: 'flood.form.sourceX', unit: 'm', min: -100, max: 100, step: 1, precision: 0,
      get: (s) => (s as WaterSourceEventSpec).position[0], set: (s, v) => ({ ...(s as WaterSourceEventSpec), position: [Number(v), (s as WaterSourceEventSpec).position[1]] }),
    },
    {
      key: 'z', labelKey: 'flood.form.sourceZ', unit: 'm', min: -100, max: 100, step: 1, precision: 0,
      get: (s) => (s as WaterSourceEventSpec).position[1], set: (s, v) => ({ ...(s as WaterSourceEventSpec), position: [(s as WaterSourceEventSpec).position[0], Number(v)] }),
    },
    { key: 'duration', labelKey: 'param.duration', unit: 'min', min: 1 / 60, max: 360, step: 1, precision: 1, scale: minutes },
    { key: 'radius', labelKey: 'flood.form.radius', unit: 'm', min: 0.5, max: 100, step: 0.5, precision: 1, optional: true },
  ],
  createEvent: (spec, now) => new WaterSourceEvent(spec, now),
  duration: (spec) => spec.duration,
  assumptions: (spec) => sourceAssumptions({ ...spec, radius: spec.radius }),
  describe: (spec) => ({
    key: 'event.waterSource.describe',
    params: { rate: spec.rate, x: Math.round(spec.position[0]), z: Math.round(spec.position[1]), min: +(spec.duration / 60).toFixed(1), r: spec.radius ?? DEFAULT_SOURCE_RADIUS },
  }),
});

export const IMPLEMENTED: ImplementedPhenomenon<EventSpec>[] = [wind, earthquake, rain, risingWater, waterSource];

// ── Planned (recognized, documented, NOT executed) ─────────────────────────

const planned = (d: Omit<PlannedPhenomenon, 'status'>): PlannedPhenomenon => ({ ...d, status: 'planned' });

export const PLANNED: PlannedPhenomenon[] = [
  planned({
    type: 'tornado', labelKey: 'phen.tornado', icon: 'wind', channels: ['airflow', 'pressure', 'mechanicalForce'], models: [],
    keywords: /토네이도|회오리|tornado|twister/, missing: ['missing.vortexWind', 'missing.pressureDrop'], reuses: ['reuse.windForce', 'reuse.windDamage', 'reuse.debris'],
  }),
  planned({
    type: 'sinkhole', labelKey: 'phen.sinkhole', icon: 'warning', channels: ['terrainDeformation', 'mechanicalForce'], models: [],
    keywords: /싱크홀|땅\s*꺼짐|지반\s*함몰|sinkhole/, missing: ['missing.terrainDeformation', 'missing.supportLoss'], reuses: ['reuse.terrainCollider', 'reuse.waterBed', 'reuse.debris'],
  }),
  planned({
    type: 'landslide', labelKey: 'phen.landslide', icon: 'warning', channels: ['terrainDeformation', 'mechanicalForce'], models: [],
    keywords: /산사태|토석류|landslide|mudslide|debris\s*flow/, missing: ['missing.terrainDeformation', 'missing.slopeStability', 'missing.granularFlow'], reuses: ['reuse.groundMotion', 'reuse.water', 'reuse.debris'],
  }),
  planned({
    type: 'meteor', labelKey: 'phen.meteor', icon: 'warning', channels: ['mechanicalForce', 'pressure', 'temperature', 'terrainDeformation'], models: [],
    keywords: /운석|소행성|meteor|asteroid/, missing: ['missing.pressureWave', 'missing.terrainDeformation', 'missing.thermal'], reuses: ['reuse.impulse', 'reuse.groundMotion', 'reuse.debris'],
  }),
  planned({
    type: 'explosion', labelKey: 'phen.explosion', icon: 'warning', channels: ['pressure', 'temperature', 'mechanicalForce'], models: [],
    keywords: /폭발|explosion|explode|blast|detonat/, missing: ['missing.pressureWave', 'missing.thermal'], reuses: ['reuse.impulse', 'reuse.facadeDamage', 'reuse.debris'],
  }),
  planned({
    type: 'volcano', labelKey: 'phen.volcano', icon: 'warning', channels: ['temperature', 'terrainDeformation', 'atmosphere', 'groundMotion'], models: [],
    keywords: /화산|용암|화산재|분화|volcan|lava|eruption|ash\s*fall/, missing: ['missing.thermal', 'missing.lavaFlow', 'missing.ash'], reuses: ['reuse.waterSolverPattern', 'reuse.groundMotion'],
  }),
  planned({
    type: 'fire', labelKey: 'phen.fire', icon: 'warning', channels: ['temperature', 'atmosphere'], models: [],
    keywords: /화재|산불|불길|불이\s*나|fire|blaze|wildfire/, missing: ['missing.thermal', 'missing.combustion'], reuses: ['reuse.airflow', 'reuse.exposure'],
  }),
  planned({
    type: 'extremeTemperature', labelKey: 'phen.extremeTemperature', icon: 'warning', channels: ['temperature'], models: [],
    keywords: /폭염|혹한|한파|극한\s*(?:온도|기온)|heat\s*wave|cold\s*snap|extreme\s*(?:heat|cold|temperature)/, missing: ['missing.thermal'], reuses: ['reuse.exposure'],
  }),
  planned({
    type: 'atmosphereLoss', labelKey: 'phen.atmosphereLoss', icon: 'warning', channels: ['atmosphere', 'pressure'], models: [],
    keywords: /대기\s*(?:소멸|제거|상실|없)|산소\s*(?:감소|부족|농도)|기압\s*(?:변화|강하|감소)|진공|vacuum|atmosphere\s*(?:loss|removal)|oxygen|air\s*pressure/,
    missing: ['missing.atmosphereField', 'missing.physiology'], reuses: ['reuse.exposure', 'reuse.airDensity'],
  }),
  planned({
    type: 'gravityChange', labelKey: 'phen.gravityChange', icon: 'warning', channels: ['gravity'], models: [],
    keywords: /중력|무중력|gravity|zero[\s-]?g/, missing: ['missing.gravityField'], reuses: ['reuse.forceLedger', 'reuse.structural'],
  }),
  planned({
    type: 'blackHole', labelKey: 'phen.blackHole', icon: 'warning', channels: ['gravity', 'mechanicalForce'], models: [],
    keywords: /블랙홀|black\s*hole/, missing: ['missing.gravityField', 'missing.tidal'], reuses: ['reuse.forceLedger', 'reuse.debris'],
  }),
  planned({
    type: 'tsunami', labelKey: 'phen.tsunami', icon: 'water', channels: ['water'], models: [],
    keywords: /쓰나미|지진해일|tsunami/, missing: ['missing.supercritical'], reuses: ['reuse.water', 'reuse.risingWater'],
  }),
  planned({
    type: 'snow', labelKey: 'phen.snow', icon: 'warning', channels: ['temperature', 'mechanicalForce'], models: [],
    keywords: /폭설|눈보라|눈이\s*(?:많이|쌓)|snow|blizzard/, missing: ['missing.snowLoad', 'missing.thermal'], reuses: ['reuse.structural'],
  }),
];

/** Context used when resolving defaults outside a run (UI previews): no terrain = flat datum. */
export const DEFAULT_CONTEXT: PhenomenonContext = { seed: 1234, terrain: null };
