/**
 * Phase 33: read-only aggregates of the extended human model for the UI (inspector, results panel, CSV / JSON export).
 * Pure functions over runtime entities and damage events — they never write simulation state.
 */
import type { RuntimeEntity } from '../SimulationRuntime';
import type { DamageEventRecord } from '../analysis/DamageEvent';
import { SEGMENT_IDS, type SegmentId } from '@/human/anthropometry';
import { INJURY_LEVELS, worstLevel, type InjuryLevel } from '@/human/injury';
import { POSTURES } from '@/human/posture';
import type { HumanSeries, HumanState } from './state';

/** Version of the human export rows (CSV header comment, JSON field). Bump on a column / field change. */
export const HUMAN_EXPORT_SCHEMA = 1;

export type HumanEntity = RuntimeEntity & { human: HumanState };

export const isHuman = (e: RuntimeEntity) => e.source.type === 'human';
export const hasHumanModel = (e: RuntimeEntity): e is HumanEntity => e.human !== undefined;

/** People of a run with the extended model state, in entity order. */
export function humanEntities(entities: Iterable<RuntimeEntity>): HumanEntity[] {
  const out: HumanEntity[] = [];
  for (const e of entities) if (e.human) out.push(e as HumanEntity);
  return out;
}

const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

/** Largest cumulative segment index of a person (the educational risk index of the whole body). */
export function riskIndex(st: HumanState): number {
  let m = 0;
  for (const id of SEGMENT_IDS) m = Math.max(m, st.risk[id].cum);
  return m;
}

export interface HumanAggregate {
  people: number;
  /** People of the run without the extended model (legacy people of the same run: none, or all). */
  legacy: number;
  fallen: number;
  falls: number;
  /** Earliest first fall (s; NaN = nobody fell). */
  firstFall: number;
  impacts: number;
  maxImpulse: number;
  maxClosing: number;
  /** Representative deceleration |Δv| / (n·dt) — a lower bound of the peak, step-resolved. */
  maxDecel: number;
  maxDrop: number;
  maxSpin: number;
  buried: number;
  incapacitated: number;
  /** People per worst level, and per segment × level. */
  worst: Record<InjuryLevel, number>;
  levels: Record<SegmentId, Record<InjuryLevel, number>>;
}

const levelCounts = () => Object.fromEntries(INJURY_LEVELS.map((l) => [l, 0])) as Record<InjuryLevel, number>;

export function aggregateHumans(entities: Iterable<RuntimeEntity>): HumanAggregate {
  const a: HumanAggregate = {
    people: 0, legacy: 0, fallen: 0, falls: 0, firstFall: NaN, impacts: 0, maxImpulse: 0, maxClosing: 0, maxDecel: 0, maxDrop: 0, maxSpin: 0, buried: 0, incapacitated: 0,
    worst: levelCounts(),
    levels: Object.fromEntries(SEGMENT_IDS.map((id) => [id, levelCounts()])) as Record<SegmentId, Record<InjuryLevel, number>>,
  };
  for (const e of entities) {
    if (!isHuman(e)) continue;
    const st = e.human;
    if (!st) { a.legacy++; continue; }
    a.people++;
    if (st.falls > 0) a.fallen++;
    a.falls += st.falls;
    if (st.firstFall === st.firstFall && !(st.firstFall >= a.firstFall)) a.firstFall = st.firstFall;
    a.impacts += st.impacts;
    a.maxImpulse = Math.max(a.maxImpulse, st.maxImpulse);
    a.maxClosing = Math.max(a.maxClosing, st.maxClosing);
    a.maxDecel = Math.max(a.maxDecel, st.maxDecel);
    a.maxDrop = Math.max(a.maxDrop, st.maxDrop);
    a.maxSpin = Math.max(a.maxSpin, st.maxSpin);
    if (st.buried) a.buried++;
    if (st.incapacitated) a.incapacitated++;
    a.worst[worstLevel(st.risk)]++;
    for (const id of SEGMENT_IDS) a.levels[id][st.risk[id].level]++;
  }
  return a;
}

/** One person's summary (results table, export). */
export interface HumanRow {
  id: string;
  mass: number;
  height: number;
  posture: string;
  standing: boolean;
  falls: number;
  firstFall: number;
  fallCause: string | null;
  speed: number;
  spin: number;
  impacts: number;
  maxImpulse: number;
  maxClosing: number;
  maxDecel: number;
  maxDrop: number;
  maxSpin: number;
  risk: number;
  level: InjuryLevel;
  mobility: string;
  incapacitated: boolean;
  buried: boolean;
  limits: string[];
}

export function humanRow(e: HumanEntity): HumanRow {
  const st = e.human;
  return {
    id: e.id, mass: st.model.mass, height: st.model.height, posture: st.posture, standing: st.standing, falls: st.falls, firstFall: st.firstFall, fallCause: st.fallCause,
    speed: norm(st.v), spin: norm(st.w), impacts: st.impacts, maxImpulse: st.maxImpulse, maxClosing: st.maxClosing, maxDecel: st.maxDecel, maxDrop: st.maxDrop, maxSpin: st.maxSpin,
    risk: riskIndex(st), level: worstLevel(st.risk), mobility: st.mobility, incapacitated: st.incapacitated, buried: st.buried, limits: [...st.limits],
  };
}

/** Sample of a series at time t (the last sample at or before t; NaN when the person has no series or none yet). */
export function seriesAt(s: HumanSeries | null, key: 'speed' | 'spin', t: number): number {
  if (!s || !s.t.length || t < s.t[0] - 1e-9) return NaN;
  let lo = 0, hi = s.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.t[mid] <= t + 1e-9) lo = mid; else hi = mid - 1;
  }
  return s[key][lo];
}

/** Damage events that carry the human detail (IMPACT / INJURED / FALLEN of extended people). */
export const humanEvents = (events: readonly DamageEventRecord[]) => events.filter((ev) => ev.human !== undefined);

export const HUMAN_UNITS = {
  time: 's', mass: 'kg', height: 'm', speed: 'm/s', angularSpeed: 'rad/s', impulse: 'N·s', dv: 'm/s', closing: 'm/s',
  decel: 'm/s² (lower bound, step-resolved)', drop: 'm', riskIndex: '1 (educational index, not a medical measure)', tidal: 'body weights', energy: 'J', point: 'm (world)',
} as const;

const NOTE = 'Educational reduced model (rigid single body, 8-segment mass model, inverted-pendulum balance, contact-episode risk index). Not a medical diagnosis or an injury prediction for a real person.';

/** CSV columns of the human rows (units in the header names). */
export const HUMAN_CSV_COLUMNS = [
  'time_s', 'object_id', 'model', 'event', 'posture', 'speed_ms', 'angular_speed_rads', 'partner', 'contact_x_m', 'contact_y_m', 'contact_z_m',
  'impulse_Ns', 'dv_ms', 'decel_lower_bound_ms2', 'segment', 'risk_index', 'level', 'cause', 'limits',
] as const;

type Cell = string | number | boolean | null | undefined;
const cell = (v: Cell, missing = 'not-measured'): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return missing;
  const s = typeof v === 'number' ? String(+v.toPrecision(6)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Human rows of a run (CSV): one row per human damage event (fall, impact episode, risk-level rise), then one final-state
 * row per person; then the chart series of the people that have one. Missing values are written as the reason
 * ('not-measured', 'none'), never as 0. Legacy runs: final rows with model = legacy only.
 */
export function humanCsv(entities: Iterable<RuntimeEntity>, events: readonly DamageEventRecord[], time: number): string {
  const all = [...entities].filter(isHuman);
  const byId = new Map(all.map((e) => [e.id, e]));
  const lines: string[] = [
    `# schema: disaster-sim.human v${HUMAN_EXPORT_SCHEMA}`,
    `# model: ${NOTE}`,
    '# units: time s, speed m/s, angular speed rad/s, impulse N·s, dv m/s, deceleration m/s² (representative |Δv|/(n·dt): a LOWER bound of the peak, step-resolved), contact point m (world), risk index dimensionless',
    '# rows: one per fall / impact episode / risk-level rise (damage events), then the final state of every person ("final")',
    HUMAN_CSV_COLUMNS.join(','),
  ];
  for (const ev of humanEvents(events)) {
    const e = byId.get(ev.objectId), st = e?.human, h = ev.human!;
    const fall = ev.eventType === 'FALLEN';
    const p = ev.eventType === 'IMPACT' ? ev.worldPosition : undefined;
    lines.push([
      ev.time.toFixed(3), ev.objectId, st ? 'extended' : 'legacy', ev.eventType, h.posture ?? 'not-recorded',
      cell(seriesAt(st?.series ?? null, 'speed', ev.time), 'not-sampled'), cell(seriesAt(st?.series ?? null, 'spin', ev.time), 'not-sampled'),
      fall ? 'none' : cell(h.partner, 'none'), cell(p?.[0], 'none'), cell(p?.[1], 'none'), cell(p?.[2], 'none'),
      cell(h.impulse, 'none'), cell(h.dv, 'none'), cell(h.decel, 'none'), cell(h.segment ?? ev.componentId, 'none'), cell(h.index, 'none'), cell(h.level, 'none'),
      fall ? cell(h.partner, ev.cause) : ev.cause, cell(st?.limits.join(';') || 'none'),
    ].join(','));
  }
  for (const e of all) {
    const st = e.human;
    if (!st) {
      lines.push([time.toFixed(3), e.id, 'legacy', 'final', e.flags.fallen ? 'fallen' : 'standing', ...Array(14).fill('not-modelled')].join(','));
      continue;
    }
    const L = st.last;
    lines.push([
      time.toFixed(3), e.id, 'extended', 'final', st.posture, cell(norm(st.v)), cell(norm(st.w)), cell(L?.partner, 'none'),
      cell(L?.point[0], 'none'), cell(L?.point[1], 'none'), cell(L?.point[2], 'none'), cell(L?.impulse, 'none'), cell(L?.dv, 'none'), cell(L?.decel, 'none'),
      cell(L?.segments.map((s) => s.id).join('+') || undefined, 'none'), cell(riskIndex(st)), worstLevel(st.risk), cell(st.fallCause, 'none'), cell(st.limits.join(';') || 'none'),
    ].join(','));
  }
  const withSeries = all.filter((e): e is HumanEntity => !!e.human?.series?.t.length);
  if (withSeries.length) {
    lines.push('', '# series (4 Hz, thinned for long runs; "not-measured" = no value at that sample, e.g. the balance margin of a released body)',
      'object_id,time_s,speed_ms,com_height_m,angular_speed_rads,balance_margin,impulse_Ns,risk_index,contact,posture');
    for (const e of withSeries) {
      const s = e.human.series!;
      for (let i = 0; i < s.t.length; i++) {
        lines.push([e.id, s.t[i].toFixed(2), cell(s.speed[i]), cell(s.height[i]), cell(s.spin[i]), cell(s.margin[i]), cell(s.impulse[i]), cell(s.risk[i]), cell(s.contact[i]), POSTURES[s.posture[i]] ?? 'not-measured'].join(','));
      }
    }
  }
  return lines.join('\n');
}

/** JSON block of the human model for the results export (undefined when the run has no people). */
export function humanJson(entities: Iterable<RuntimeEntity>, events: readonly DamageEventRecord[]) {
  const all = [...entities].filter(isHuman);
  if (!all.length) return undefined;
  const ext = all.filter(hasHumanModel);
  if (!ext.length) return { schemaVersion: HUMAN_EXPORT_SCHEMA, model: 'legacy' as const, people: all.length };
  const a = aggregateHumans(all);
  return {
    schemaVersion: HUMAN_EXPORT_SCHEMA,
    model: 'extended' as const,
    note: NOTE,
    units: HUMAN_UNITS,
    aggregate: { ...a, firstFall: Number.isFinite(a.firstFall) ? a.firstFall : null },
    people: ext.map((e) => {
      const st = e.human;
      return {
        ...humanRow(e),
        firstFall: Number.isFinite(st.firstFall) ? st.firstFall : null,
        segments: Object.fromEntries(SEGMENT_IDS.map((id) => [id, { ...st.risk[id] }])),
        last: st.last,
        releaseEnergy: st.releaseEnergy,
        tidalPeak: st.tidalPeak,
        regained: st.regained,
        collapsed: st.collapsed,
        // NaN samples are written as null (unmeasured, not 0).
        series: st.series ? { dt: st.series.dt, t: st.series.t, speed: st.series.speed, height: st.series.height, spin: st.series.spin, margin: st.series.margin, impulse: st.series.impulse, risk: st.series.risk, contact: st.series.contact, posture: st.series.posture.map((k) => POSTURES[k] ?? null) } : null,
      };
    }),
    events: humanEvents(events).map((ev) => ({ time: ev.time, object: ev.objectId, event: ev.eventType, cause: ev.cause, hazard: ev.hazard, point: ev.eventType === 'IMPACT' ? ev.worldPosition : null, ...ev.human })),
  };
}
