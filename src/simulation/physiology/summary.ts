/**
 * Phase 34: read-only aggregates of the reduced physiology for the UI (inspector, results panel, overlay, CSV / JSON
 * export). Pure functions over runtime entities and damage events — they never write simulation state.
 *
 * A value the model did not compute (module off, no sample yet, no gas information, …) is `null` here, an empty CSV cell,
 * `null` in JSON and a gap in the series (NaN) — never 0.
 */
import type { RuntimeEntity } from '../SimulationRuntime';
import type { DamageEventRecord } from '../analysis/DamageEvent';
import { CAPACITY_LEVELS, deficitPercent, THERMAL_STATES, thermalStrain, type CapacityLevel, type ThermalStateName } from '@/physiology/engine';
import { PARAMS } from '@/physiology/params';
import { ZERO_C } from '@/thermal/units';
import { SERIES_KEYS, type PhysioEntity, type PhysiologyRuntime, type SeriesKey } from './state';
import { compartmentFractions } from './zones';

/** Version of the physiology export rows (CSV header comment, JSON field). Bump on a column / field change. */
export const PHYSIO_EXPORT_SCHEMA = 1;
/** Version of the reduced model the rows were produced with. */
export const PHYSIO_MODEL_VERSION = 'reduced-1';
export const PHYSIO_NOTE = 'educational reduced model — not a medical prediction (no diagnosis, no time of death, no survival probability)';

export type PhysioPerson = RuntimeEntity & { physio: PhysioEntity };

/** People of a run with the physiology state, in entity order. */
export function physioEntities(entities: Iterable<RuntimeEntity>): PhysioPerson[] {
  const out: PhysioPerson[] = [];
  for (const e of entities) if (e.physio) out.push(e as PhysioPerson);
  return out;
}

/** The provenance fields shown / exported, in order (sampler codes: see sampler.ts). */
export const PROVENANCE_FIELDS = ['airT', 'humidity', 'pressure', 'wind', 'mrt', 'solar', 'radiant', 'water', 'waterT', 'gas', 'contact', 'airway', 'volcanicGas', 'zone'] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];
/** Codes that mean "an explicit model assumption, not a value from the environment simulation". */
export const ASSUMED_SOURCES = new Set(['scene.ambient', 'reference', 'assumedAir', 'unknown', 'buriedUnknown']);

const mod = (p: PhysioEntity, m: keyof PhysioEntity['cfg']['modules']) => p.cfg.modules[m];
const fin = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

/** One person's physiology summary (inspector, results table, export). null = not computed. */
export interface PhysioRow {
  id: string;
  frozen: boolean;
  mass: number;
  activitySetting: string;
  activity: string;
  clothing: string;
  core: number | null;
  skin: number | null;
  air: number | null;
  strain: number | null;
  heatIn: number | null;
  heatOut: number | null;
  sweat: number | null;
  shiver: number | null;
  breathing: boolean | null;
  demand: number | null;
  ventilation: number | null;
  supply: number | null;
  fedCo: number | null;
  fedO2: number | null;
  fedCo2: number | null;
  fedHeat: number | null;
  fedAsphyxiant: number | null;
  coDose: number | null;
  smokeDose: number | null;
  smokeInhaled: number | null;
  smokeDeposited: number | null;
  airway: string | null;
  airwayFirst: number | null;
  airwayCumulative: number | null;
  airwayLongest: number | null;
  submersions: number | null;
  deficit: number | null;
  fatigue: number | null;
  thermalState: string | null;
  capacity: CapacityLevel;
  combined: CapacityLevel;
  limiting: string[];
  combinedCauses: string[];
  flags: string[];
  provenance: Record<string, string>;
  qFire: number | null;
  qSolar: number | null;
  immersed: number | null;
}

export function physioRow(e: PhysioPerson): PhysioRow {
  const pe = e.physio, s = pe.s, f = s.last;
  const sampled = pe.sample !== null;
  const thermal = mod(pe, 'thermal') && f !== null;
  const gas = mod(pe, 'gas') && sampled;
  const sub = mod(pe, 'submersion') && sampled;
  return {
    id: e.id, frozen: pe.frozen, mass: pe.cfg.mass, activitySetting: pe.cfg.activity, activity: s.activity, clothing: pe.cfg.clothing,
    core: thermal ? s.Tc - ZERO_C : null,
    skin: thermal ? s.Ts - ZERO_C : null,
    air: sampled ? fin(pe.sample!.airT - ZERO_C) : null,
    strain: thermal ? thermalStrain(s.Tc - ZERO_C) : null,
    heatIn: f ? f.M + f.absorbed + f.cond : null,
    heatOut: f ? f.W + f.resSens + f.resLat + f.conv + f.rad + f.water + f.contact + f.evap : null,
    sweat: f ? f.sweat * 3600 * 1000 : null,
    shiver: f ? f.shiver : null,
    breathing: sampled ? s.resp.breathing : null,
    demand: sampled ? s.resp.demand : null,
    ventilation: sampled ? s.resp.actual : null,
    supply: mod(pe, 'respiration') ? fin(s.resp.supply) : null,
    fedCo: gas ? s.fed.co : null,
    fedO2: gas ? s.fed.o2 : null,
    fedCo2: gas ? s.fed.co2 : null,
    fedHeat: mod(pe, 'thermal') && sampled ? s.fed.heatConv + s.fed.heatRad : null,
    fedAsphyxiant: gas ? s.fed.co + s.fed.o2 + s.fed.co2 : null,
    coDose: gas ? s.dose.co / 60 : null,
    smokeDose: gas ? (s.dose.smoke * 1e6) / 60 : null,
    smokeInhaled: gas ? s.dose.smokeInhaled * 1e6 : null,
    smokeDeposited: gas ? s.dose.smokeDeposited * 1e6 : null,
    airway: sub ? s.airway.state : null,
    airwayFirst: sub ? s.airway.first : null,
    airwayCumulative: sub ? s.airway.cumulative : null,
    airwayLongest: sub ? s.airway.longest : null,
    submersions: sub ? s.airway.submersions : null,
    deficit: mod(pe, 'hydration') && sampled ? deficitPercent(s, pe.cfg.mass) : null,
    fatigue: mod(pe, 'fatigue') && sampled ? s.fatigue : null,
    thermalState: thermal ? s.thermalState : null,
    capacity: s.capacity, combined: s.combined, limiting: [...s.limiting], combinedCauses: [...s.combinedCauses], flags: [...s.flags],
    provenance: { ...pe.provenance },
    qFire: sampled ? pe.sample!.qFire : null,
    qSolar: sampled ? pe.sample!.qSolar : null,
    immersed: sampled ? pe.sample!.immersed : null,
  };
}

export interface PhysioAggregate {
  people: number;
  frozen: number;
  /** People per combined (physiological + physical) and per physiological capacity level. */
  combined: Record<CapacityLevel, number>;
  physiological: Record<CapacityLevel, number>;
  thermal: Record<ThermalStateName, number>;
  /** People whose airway is under water now (submerged / intermittent) and who had it under at least once. */
  airwaySubmerged: number;
  airwayEver: number;
  /** °C; null when no core temperature was computed. */
  minCore: number | null;
  maxCore: number | null;
  /** Largest FEDs (null without a computed value). */
  maxFedAsphyxiant: number | null;
  maxFedHeat: number | null;
  maxCoDose: number | null;
  maxSmokeDose: number | null;
  maxDeficit: number | null;
  maxFatigue: number | null;
  minSupply: number | null;
}

const counts = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const mx = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.max(a, b));
const mn = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.min(a, b));

export function aggregatePhysio(entities: Iterable<RuntimeEntity>): PhysioAggregate {
  const a: PhysioAggregate = {
    people: 0, frozen: 0, combined: counts(CAPACITY_LEVELS), physiological: counts(CAPACITY_LEVELS), thermal: counts(THERMAL_STATES),
    airwaySubmerged: 0, airwayEver: 0, minCore: null, maxCore: null, maxFedAsphyxiant: null, maxFedHeat: null, maxCoDose: null, maxSmokeDose: null,
    maxDeficit: null, maxFatigue: null, minSupply: null,
  };
  for (const e of physioEntities(entities)) {
    const r = physioRow(e), s = e.physio.s;
    a.people++;
    if (r.frozen) a.frozen++;
    a.combined[s.combined]++;
    a.physiological[s.capacity]++;
    a.thermal[s.thermalState]++;
    if (r.airway === 'submerged' || r.airway === 'intermittent') a.airwaySubmerged++;
    if (s.airway.first !== null) a.airwayEver++;
    a.minCore = mn(a.minCore, r.core);
    a.maxCore = mx(a.maxCore, r.core);
    a.maxFedAsphyxiant = mx(a.maxFedAsphyxiant, r.fedAsphyxiant);
    a.maxFedHeat = mx(a.maxFedHeat, r.fedHeat);
    a.maxCoDose = mx(a.maxCoDose, r.coDose);
    a.maxSmokeDose = mx(a.maxSmokeDose, r.smokeDose);
    a.maxDeficit = mx(a.maxDeficit, r.deficit);
    a.maxFatigue = mx(a.maxFatigue, r.fatigue);
    a.minSupply = mn(a.minSupply, r.supply);
  }
  return a;
}

/** Damage events of the physiology (cause 'physiology'). */
export const physioEvents = (events: readonly DamageEventRecord[]) => events.filter((ev) => ev.physio !== undefined);

/** Units of the series keys (chart axes, export). */
export const SERIES_UNITS: Record<SeriesKey, string> = {
  core: '°C', skin: '°C', air: '°C', heatIn: 'W', heatOut: 'W', strain: 'K (strain index)', breathing: '0/1', supply: '1 (alveolar O₂ / sea-level reference)',
  smoke: 'mg·min/m³', airway: 's (cumulative)', deficit: '% body mass', fatigue: '1 (index)', capacity: '0–4 (normal … unable to act)',
};

export const PHYSIO_UNITS = {
  time: 's', temperature: '°C', heat: 'W', ventilation: 'L/min', supplyIndex: '1 (alveolar O₂ partial pressure / sea-level reference; null = not computed)',
  fed: '1 (fractional effective dose, ISO 13571 form)', coDose: 'ppm·min', smokeDose: 'mg·min/m³', smokeMass: 'mg', airwayTime: 's', deficit: '% body mass',
  fatigue: '1 (model index 0–1)', sweat: 'g/h', radiantFlux: 'W/m²', capacity: CAPACITY_LEVELS.join(' < '),
} as const;

/** Model level legend (params.ts). */
export const LEVEL_LEGEND = { A: 'conservation law / physics', B: 'reduced physiology from the literature', C: 'explicit educational assumption' } as const;

/** CSV columns of the final rows (units in the header names; empty cell = not computed). */
export const PHYSIO_CSV_COLUMNS = [
  'time_s', 'person_id', 'model_version', 'frozen',
  ...PROVENANCE_FIELDS.map((f) => `src_${f}`),
  'core_C', 'skin_C', 'air_C', 'heat_in_W', 'heat_out_W', 'sweat_gh', 'breathing', 'ventilation_Lmin', 'o2_supply_index',
  'airway_state', 'airway_first_s', 'airway_cumulative_s', 'airway_longest_s', 'submersions',
  'fed_co', 'fed_o2', 'fed_co2', 'fed_heat', 'co_dose_ppm_min', 'smoke_dose_mg_min_m3', 'smoke_inhaled_mg', 'smoke_deposited_mg',
  'water_deficit_pct', 'fatigue', 'thermal_state', 'activity', 'clothing', 'capacity_physiological', 'capacity_combined', 'limiting', 'combined_causes', 'flags',
] as const;

export const PHYSIO_EVENT_COLUMNS = ['time_s', 'person_id', 'event', 'kind', 'from', 'to', 'value', 'causes'] as const;

type Cell = string | number | boolean | null | undefined;
/** CSV cell: missing / non-finite = empty (never 0). */
export const csvCell = (v: Cell): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? String(+v.toPrecision(6)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Physiology rows of a run (CSV): schema / model / units comment lines, the final state of every person, the physiology
 * events, then the series of the charted people. Not computed = empty cell.
 */
export function physioCsv(entities: Iterable<RuntimeEntity>, events: readonly DamageEventRecord[], time: number): string {
  const people = physioEntities(entities);
  const lines: string[] = [
    `# schema: disaster-sim.physiology v${PHYSIO_EXPORT_SCHEMA}`,
    `# model: ${PHYSIO_MODEL_VERSION} — ${PHYSIO_NOTE}`,
    '# units: time s, temperatures °C, heat flows W, sweat g/h, ventilation L/min, O₂ supply index 1 (alveolar O₂ / sea-level reference), FED 1 (ISO 13571 form), CO dose ppm·min, smoke dose mg·min/m³, smoke mass mg, airway times s, water deficit % body mass, fatigue index 0–1',
    '# src_* = where each environment value came from (scene.ambient / reference / assumedAir = an explicit assumption; zone = experimental boundary condition); empty cell = not computed',
    PHYSIO_CSV_COLUMNS.join(','),
  ];
  for (const e of people) {
    const r = physioRow(e);
    lines.push([
      time.toFixed(3), e.id, PHYSIO_MODEL_VERSION, r.frozen,
      ...PROVENANCE_FIELDS.map((f) => r.provenance[f]),
      r.core, r.skin, r.air, r.heatIn, r.heatOut, r.sweat, r.breathing, r.ventilation, r.supply,
      r.airway, r.airwayFirst, r.airwayCumulative, r.airwayLongest, r.submersions,
      r.fedCo, r.fedO2, r.fedCo2, r.fedHeat, r.coDose, r.smokeDose, r.smokeInhaled, r.smokeDeposited,
      r.deficit, r.fatigue, r.thermalState, r.activity, r.clothing, r.capacity, r.combined, r.limiting.join(';'), r.combinedCauses.join(';'), r.flags.join(';'),
    ].map(csvCell).join(','));
  }
  const evs = physioEvents(events);
  if (evs.length) {
    lines.push('', '# events (one per state change; value in the kind\'s unit: thermal °C core, airway s cumulative, gas FED, hydration % body mass, fatigue index, capacity level index)', PHYSIO_EVENT_COLUMNS.join(','));
    for (const ev of evs) lines.push([ev.time.toFixed(3), ev.objectId, ev.eventType, ev.physio!.kind, ev.physio!.from, ev.physio!.to, ev.physio!.value, ev.physio!.causes].map(csvCell).join(','));
  }
  const charted = people.filter((e) => e.physio.series && e.physio.series.t.length);
  if (charted.length) {
    lines.push('', `# series (1 sample/s, thinned ×2 for long runs; empty = not computed at that sample; units: ${SERIES_KEYS.map((k) => `${k} ${SERIES_UNITS[k]}`).join(', ')})`,
      ['person_id', 'time_s', ...SERIES_KEYS].join(','));
    for (const e of charted) {
      const s = e.physio.series!;
      const cols = SERIES_KEYS.map((k) => seriesOf(e.physio, k));
      for (let i = 0; i < s.t.length; i++) lines.push([e.id, s.t[i].toFixed(2), ...cols.map((c) => c[i])].map(csvCell).join(','));
    }
  }
  return lines.join('\n');
}

const nanNull = (a: readonly number[]) => a.map((v) => (Number.isFinite(v) ? v : null));

/** JSON block of the physiology for the results export (undefined when the run has no physiology). */
export function physioJson(entities: Iterable<RuntimeEntity>, events: readonly DamageEventRecord[], rt: PhysiologyRuntime | undefined) {
  if (!rt) return undefined;
  const people = physioEntities(entities);
  return {
    schemaVersion: PHYSIO_EXPORT_SCHEMA,
    model: 'reduced' as const,
    modelVersion: PHYSIO_MODEL_VERSION,
    note: PHYSIO_NOTE,
    units: PHYSIO_UNITS,
    seriesUnits: SERIES_UNITS,
    levels: LEVEL_LEGEND,
    parameters: PARAMS,
    settings: rt.settings,
    aggregate: aggregatePhysio(people),
    compartments: [...rt.compartments.values()].map((c) => ({ zone: c.zone, zoneId: rt.settings.zones?.[c.zone]?.id ?? null, volume: c.V, exchange: c.lambda, ...compartmentFractions(c), ledger: { ...c.ledger } })),
    people: people.map((e) => {
      const s = e.physio.s;
      return {
        ...physioRow(e),
        levels: { ...s.levels },
        ledger: { ...s.ledger },
        water: { lostKg: s.waterLost, intakeKg: s.waterIntake, bodyWaterKg: s.bodyWater },
        series: e.physio.series ? { dt: e.physio.series.dt, t: e.physio.series.t, ...Object.fromEntries(SERIES_KEYS.map((k) => [k, nanNull(seriesOf(e.physio, k))])) } : null,
      };
    }),
    events: physioEvents(events).map((ev) => ({ time: ev.time, object: ev.objectId, event: ev.eventType, hazard: ev.hazard, ...ev.physio })),
  };
}

/** Module a series key belongs to (its samples are "not computed" while that module is off). */
const SERIES_MODULE: Partial<Record<SeriesKey, keyof PhysioEntity['cfg']['modules']>> = {
  core: 'thermal', skin: 'thermal', strain: 'thermal', heatIn: 'thermal', heatOut: 'thermal', supply: 'respiration', smoke: 'gas', airway: 'submersion', deficit: 'hydration', fatigue: 'fatigue',
};

/**
 * Samples of one series of a person for display / export: a key whose module is switched off reads NaN everywhere (the
 * recorder stores the untouched state there — e.g. 0 smoke dose — which is "not computed", not a measured 0).
 */
export function seriesOf(pe: PhysioEntity, k: SeriesKey): number[] {
  const v = pe.series?.v[k] ?? [];
  const m = SERIES_MODULE[k];
  return m && !pe.cfg.modules[m] ? v.map(() => NaN) : v;
}

/** Value of a series at its last sample (NaN when none). */
export function lastSample(e: PhysioPerson, k: SeriesKey): number {
  const v = seriesOf(e.physio, k);
  return v.length ? v[v.length - 1] : NaN;
}
