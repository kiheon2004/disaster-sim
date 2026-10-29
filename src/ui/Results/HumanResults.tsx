import { useState } from 'react';
import type { MessageKey, TFunction } from '@/i18n/i18n';
import { SEGMENT_IDS } from '@/human/anthropometry';
import { INJURY_LEVELS, levelRank } from '@/human/injury';
import { POSTURES } from '@/human/posture';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { aggregateHumans, humanCsv, humanEntities, humanJson, humanRow } from '@/simulation/human/summary';
import type { HumanSeries } from '@/simulation/human/state';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import { causeLabel, LEVEL_COLORS, limitLabel } from '@/ui/Inspector/HumanInspector';
import styles from './ResultsPanel.module.css';

const TABLE_ROWS = 200;
/** Numeric column headers right-aligned like their cells (the table's th rule is left-aligned). */
const NUM_TH = { textAlign: 'right' } as const;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Card({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className={styles.card}>
      <span className={styles.cardLabel} title={label}>{label}</span>
      <span className={styles.cardValue}>{value}{unit && <span style={{ fontSize: 11, color: 'var(--text-2)', marginLeft: 3 }}>{unit}</span>}</span>
      {sub && <span className={styles.cardSub} title={sub}>{sub}</span>}
    </div>
  );
}

/** Polyline runs of the finite samples: a NaN sample (not measured) breaks the line — it is a gap, not a zero. */
export function seriesRuns(v: readonly number[]): number[][] {
  const runs: number[][] = [];
  let cur: number[] = [];
  for (let k = 0; k < v.length; k++) {
    if (Number.isFinite(v[k])) cur.push(k);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** One time-series chart of a person (linear axes printed at both ends; NaN = gap). */
function Chart({ title, unit, v, t, testId, label }: { title: string; unit: string; v: number[]; t: number[]; testId: string; label?: (x: number) => string }) {
  const vals = v.filter(Number.isFinite);
  if (t.length < 2 || !vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-12) { hi += 0.5; lo -= 0.5; }
  const x = (k: number) => ((t[k] - t[0]) / Math.max(1e-9, t[t.length - 1] - t[0])) * 200;
  const y = (s: number) => 46 - ((s - lo) / (hi - lo)) * 42;
  const lab = label ?? ((s: number) => fmt(s, Math.abs(s) >= 100 ? 0 : 2));
  return (
    <div style={{ flex: '1 1 23%', minWidth: 200 }} data-testid={testId}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between' }}><span>{title}</span><span>{lab(hi)} {unit}</span></div>
      <svg width="100%" viewBox="0 0 200 50" preserveAspectRatio="none" style={{ height: 56, background: 'rgba(120,200,255,0.05)', borderRadius: 4 }}>
        {seriesRuns(v).map((run, i) => run.length === 1
          ? <circle key={i} cx={x(run[0])} cy={y(v[run[0]])} r={0.8} fill="#7fd0ff" />
          : <polyline key={i} points={run.map((k) => `${x(k)},${y(v[k])}`).join(' ')} fill="none" stroke="#7fd0ff" strokeWidth={1.3} vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div style={{ fontSize: 10, color: 'var(--text-3)', display: 'flex', justifyContent: 'space-between' }}><span>{fmt(t[0], 1)} s</span><span>{lab(lo)} {unit}</span><span>{fmt(t[t.length - 1], 1)} s</span></div>
    </div>
  );
}

/** Human block of the results JSON (schema-versioned; undefined without people). */
export function humanResultsJson() {
  const rt = simulationController.getRuntime();
  return rt ? humanJson(rt.entities.values(), useSimStore.getState().damageEvents) : undefined;
}

/**
 * Human physical response results (Phase 33, extended model): aggregate cards (falls, impacts, the largest impulse,
 * closing speed, representative deceleration — a lower bound, step-resolved —, drop, spin), level counts per body segment,
 * the people table, a person's charts (NaN = gap) and the human CSV. Legacy runs: nothing (the fallen-people card stays).
 */
export function HumanSummary({ t, name }: { t: TFunction; name: string }) {
  useSimStore((s) => Math.floor(s.time));
  useSimStore((s) => s.damageEvents.length);
  const objects = useWorldStore((s) => s.doc.objects);
  const selected = useEditorStore((s) => s.selectedId);
  const [pick, setPick] = useState<string | null>(null);
  const rt = simulationController.getRuntime();
  const people = rt ? humanEntities(rt.entities.values()) : [];
  if (!rt || !people.length) return null;
  const a = aggregateHumans(people);
  const label = (id: string) => (objects[id] ? displayName(objects[id], t) : id);
  const charted = people.filter((e) => e.human.series && e.human.series.t.length > 1);
  const who = charted.find((e) => e.id === pick) ?? charted.find((e) => e.id === selected) ?? charted[0];
  const s: HumanSeries | null = who?.human.series ?? null;
  const exportCsv = () => download(`${name || 'simulation'}-humans.csv`, humanCsv(rt.entities.values(), useSimStore.getState().damageEvents, simulationController.getTime()), 'text/csv');
  const rows = people.slice(0, TABLE_ROWS).map(humanRow);
  return (
    <div className={styles.box} data-testid="human-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('humanUi.results.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="human-csv"><Icon name="save" size={13} /> {t('humanUi.results.csv')}</button>
      </div>
      <div style={{ fontSize: 11, color: '#ffd29a', fontWeight: 600 }}>{t('humanUi.limitation')}</div>
      <div className={styles.cards}>
        <Card label={t('humanUi.results.people')} value={String(a.people)} sub={t('humanUi.results.peopleSub', { b: a.buried, i: a.incapacitated })} />
        <Card label={t('humanUi.results.fallen')} value={String(a.fallen)} sub={t('humanUi.results.fallsSub', { n: a.falls })} />
        <Card label={t('humanUi.results.firstFall')} value={Number.isFinite(a.firstFall) ? fmt(a.firstFall, 2) : '–'} unit={Number.isFinite(a.firstFall) ? 's' : ''} sub={Number.isFinite(a.firstFall) ? undefined : t('humanUi.results.noFall')} />
        <Card label={t('humanUi.results.impacts')} value={String(a.impacts)} sub={t('humanUi.results.impulseSub', { j: fmt(a.maxImpulse, 1) })} />
        <Card label={t('humanUi.results.closing')} value={fmt(a.maxClosing, 2)} unit="m/s" />
        <Card label={t('humanUi.results.decel')} value={fmt(a.maxDecel, 0)} unit="m/s²" sub={t('humanUi.results.decelSub')} />
        <Card label={t('humanUi.results.drop')} value={fmt(a.maxDrop, 2)} unit="m" />
        <Card label={t('humanUi.results.spin')} value={fmt(a.maxSpin, 2)} unit="rad/s" />
        <Card label={t('humanUi.results.buried')} value={String(a.buried)} />
        <Card label={t('humanUi.results.incapacitated')} value={String(a.incapacitated)} />
        <Card label={t('humanUi.results.impulse')} value={fmt(a.maxImpulse, 1)} unit="N·s" />
        {a.legacy > 0 && <Card label={t('humanUi.results.legacy')} value={String(a.legacy)} />}
      </div>
      <table className={styles.table} data-testid="human-levels" style={{ marginTop: 8 }}>
        <thead>
          <tr><th>{t('humanUi.seg')}</th>{INJURY_LEVELS.map((l, i) => <th key={l} className={styles.num} style={{ color: LEVEL_COLORS[i], textAlign: 'right' }}>{t(`human.level.${l}` as MessageKey)}</th>)}</tr>
        </thead>
        <tbody>
          {SEGMENT_IDS.map((id) => (
            <tr key={id} style={{ cursor: 'default' }}>
              <td>{t(`human.seg.${id}` as MessageKey)}</td>
              {INJURY_LEVELS.map((l) => <td key={l} className={styles.num}>{a.levels[id][l]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
        <table className={styles.table} data-testid="human-table">
          <thead>
            <tr>
              <th>{t('humanUi.results.col.person')}</th><th>{t('humanUi.inspect.posture')}</th><th className={styles.num} style={NUM_TH}>{t('humanUi.results.col.falls')}</th><th>{t('humanUi.results.col.cause')}</th>
              <th className={styles.num} style={NUM_TH}>{t('humanUi.results.col.impacts')}</th><th className={styles.num} style={NUM_TH}>{t('humanUi.results.col.impulse')}</th><th className={styles.num} style={NUM_TH}>{t('humanUi.results.col.decel')}</th>
              <th className={styles.num} style={NUM_TH}>{t('humanUi.results.col.drop')}</th><th className={styles.num} style={NUM_TH}>{t('humanUi.results.col.risk')}</th><th>{t('humanUi.level')}</th><th>{t('humanUi.inspect.mobility')}</th><th>{t('humanUi.results.col.flags')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setPick(r.id)} style={r.id === who?.id ? { background: 'var(--accent-soft)' } : undefined}>
                <td>{label(r.id)}</td>
                <td>{t(`human.posture.${r.posture}` as MessageKey)}</td>
                <td className={styles.num}>{r.falls}</td>
                <td>{r.falls > 0 ? causeLabel(t, r.fallCause) : '–'}</td>
                <td className={styles.num}>{r.impacts}</td>
                <td className={styles.num}>{fmt(r.maxImpulse, 1)}</td>
                <td className={styles.num}>{fmt(r.maxDecel, 0)}</td>
                <td className={styles.num}>{fmt(r.maxDrop, 2)}</td>
                <td className={styles.num}>{fmt(r.risk, 2)}</td>
                <td style={{ color: LEVEL_COLORS[levelRank(r.level)] }}>{t(`human.level.${r.level}` as MessageKey)}</td>
                <td>{t(`human.mobility.${r.mobility}` as MessageKey)}</td>
                <td title={r.limits.map((l) => limitLabel(t, l)).join(' · ')}>
                  {[r.incapacitated && t('humanUi.results.flag.incapacitated'), r.buried && t('humanUi.results.flag.buried'), r.limits.length > 0 && t('humanUi.results.flag.limits', { n: r.limits.length })].filter(Boolean).join(' · ') || '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {people.length > TABLE_ROWS && <div className={styles.more} style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('humanUi.results.more', { n: people.length - TABLE_ROWS })}</div>}
      </div>
      {who && s ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('humanUi.results.chartsOf')}</span>
            <select value={who.id} onChange={(ev) => setPick(ev.target.value)} aria-label={t('humanUi.results.chartsOf')} data-testid="human-chart-person" style={{ fontSize: 11.5 }}>
              {charted.map((e) => <option key={e.id} value={e.id}>{label(e.id)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }} data-testid="human-charts">
            <Chart title={t('humanUi.ch.speed')} unit="m/s" v={s.speed} t={s.t} testId="human-chart-speed" />
            <Chart title={t('humanUi.ch.height')} unit="m" v={s.height} t={s.t} testId="human-chart-height" />
            <Chart title={t('humanUi.ch.spin')} unit="rad/s" v={s.spin} t={s.t} testId="human-chart-spin" />
            <Chart title={t('humanUi.ch.margin')} unit="" v={s.margin} t={s.t} testId="human-chart-margin" />
            <Chart title={t('humanUi.ch.impulse')} unit="N·s" v={s.impulse} t={s.t} testId="human-chart-impulse" />
            <Chart title={t('humanUi.ch.risk')} unit="" v={s.risk} t={s.t} testId="human-chart-risk" />
            <Chart title={t('humanUi.ch.contact')} unit="" v={s.contact} t={s.t} testId="human-chart-contact" label={(x) => (x >= 0.5 ? t('humanUi.yes') : t('humanUi.no'))} />
            <Chart title={t('humanUi.ch.posture')} unit="" v={s.posture} t={s.t} testId="human-chart-posture" label={(x) => (POSTURES[Math.round(x)] ? t(`human.posture.${POSTURES[Math.round(x)]}` as MessageKey) : '–')} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('humanUi.results.chartNote')}</div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{t('humanUi.results.noSeries')}</div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('humanUi.decelNote')}</div>
    </div>
  );
}
