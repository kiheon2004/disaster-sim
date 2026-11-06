import { useState } from 'react';
import type { TFunction } from '@/i18n/i18n';
import { CAPACITY_LEVELS, THERMAL_STATES } from '@/physiology/engine';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import type { SeriesKey } from '@/simulation/physiology/state';
import { aggregatePhysio, physioCsv, physioEntities, physioJson, physioRow, seriesOf, SERIES_UNITS } from '@/simulation/physiology/summary';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import { airwayLabel, capColor, capLabel, causesLabel, thermalLabel } from '@/ui/Inspector/PhysiologyInspector';
import { seriesRuns } from './HumanResults';
import styles from './ResultsPanel.module.css';

const TABLE_ROWS = 200;
const NUM_TH = { textAlign: 'right' } as const;
const SERIES_COLORS = ['#7fd0ff', '#ffc46b', '#b9a3f0'] as const;

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

/** Axis range of the finite samples of several series (null when there is none). */
export function seriesRange(vs: readonly (readonly number[])[]): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const v of vs) for (const x of v) if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
  if (lo > hi) return null;
  if (hi - lo < 1e-12) { hi += 0.5; lo -= 0.5; }
  return [lo, hi];
}

/** One chart of one or more series of a person (time axis in s, value axis printed at both ends with its unit; NaN = gap). */
function Chart({ title, unit, series, t, testId, label, empty }: { title: string; unit: string; series: { name: string; v: number[] }[]; t: number[]; testId: string; label?: (x: number) => string; empty: string }) {
  const r = seriesRange(series.map((s) => s.v));
  if (t.length < 2 || !r) {
    return (
      <div style={{ flex: '1 1 23%', minWidth: 200 }} data-testid={testId} data-empty="true">
        <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{title}</div>
        <div style={{ height: 56, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'center' }}>{empty}</div>
      </div>
    );
  }
  const [lo, hi] = r;
  const x = (k: number) => ((t[k] - t[0]) / Math.max(1e-9, t[t.length - 1] - t[0])) * 200;
  const y = (s: number) => 46 - ((s - lo) / (hi - lo)) * 42;
  const lab = label ?? ((s: number) => fmt(s, Math.abs(s) >= 100 ? 0 : 2));
  return (
    <div style={{ flex: '1 1 23%', minWidth: 200 }} data-testid={testId}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>{title}{series.length > 1 && series.map((s, i) => <span key={s.name} style={{ color: SERIES_COLORS[i], marginLeft: 5 }}>■ {s.name}</span>)}</span>
        <span>{lab(hi)} {unit}</span>
      </div>
      <svg width="100%" viewBox="0 0 200 50" preserveAspectRatio="none" style={{ height: 56, background: 'rgba(120,200,255,0.05)', borderRadius: 4 }}>
        {series.map((s, si) => seriesRuns(s.v).map((run, i) => run.length === 1
          ? <circle key={`${si}-${i}`} cx={x(run[0])} cy={y(s.v[run[0]])} r={0.8} fill={SERIES_COLORS[si]} />
          : <polyline key={`${si}-${i}`} points={run.map((k) => `${x(k)},${y(s.v[k])}`).join(' ')} fill="none" stroke={SERIES_COLORS[si]} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />))}
      </svg>
      <div style={{ fontSize: 10, color: 'var(--text-3)', display: 'flex', justifyContent: 'space-between' }}><span>{fmt(t[0], 0)} s</span><span>{lab(lo)} {unit}</span><span>{fmt(t[t.length - 1], 0)} s</span></div>
    </div>
  );
}

/** Physiology block of the results JSON (schema-versioned; undefined without physiology). */
export function physiologyResultsJson() {
  const rt = simulationController.getRuntime();
  return rt ? physioJson(rt.entities.values(), useSimStore.getState().damageEvents, rt.physiology) : undefined;
}

const nz = (x: number | null, d: number) => (x === null ? '–' : fmt(x, d));

/**
 * Physiology results (Phase 34, physiology runs only): aggregate cards (people per capacity level, thermal states, airway
 * under water, core range, largest FEDs / doses / water deficit / fatigue, lowest O₂ supply), the people table, a person's
 * charts (time axis s, units; NaN = gap — not computed, never drawn as 0) and the physiology CSV.
 */
export function PhysiologySummary({ t, name }: { t: TFunction; name: string }) {
  useSimStore((s) => Math.floor(s.time));
  useSimStore((s) => s.damageEvents.length);
  const objects = useWorldStore((s) => s.doc.objects);
  const selected = useEditorStore((s) => s.selectedId);
  const [pick, setPick] = useState<string | null>(null);
  const rt = simulationController.getRuntime();
  if (!rt?.physiology) return null;
  const people = physioEntities(rt.entities.values());
  if (!people.length) return null;
  const a = aggregatePhysio(people);
  const label = (id: string) => (objects[id] ? displayName(objects[id], t) : id);
  const charted = people.filter((e) => e.physio.series && e.physio.series.t.length > 1);
  const who = charted.find((e) => e.id === pick) ?? charted.find((e) => e.id === selected) ?? charted[0];
  const s = who?.physio.series ?? null;
  const exportCsv = () => download(`${name || 'simulation'}-physiology.csv`, physioCsv(rt.entities.values(), useSimStore.getState().damageEvents, simulationController.getTime()), 'text/csv');
  const rows = people.slice(0, TABLE_ROWS).map(physioRow);
  const thermalSub = THERMAL_STATES.filter((k) => a.thermal[k] > 0).map((k) => `${thermalLabel(t, k)} ${a.thermal[k]}`).join(' · ');
  const ser = (k: SeriesKey, n: string) => ({ name: n, v: seriesOf(who!.physio, k) });
  const nc = t('physioUi.notComputed');
  return (
    <div className={styles.box} data-testid="physio-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('physioUi.results.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="physio-csv"><Icon name="save" size={13} /> {t('physioUi.results.csv')}</button>
      </div>
      <div style={{ fontSize: 11, color: '#ffd29a', fontWeight: 600 }}>{t('physioUi.limitation')}</div>
      <div className={styles.cards}>
        <Card label={t('physioUi.results.people')} value={String(a.people)} sub={a.frozen ? t('physioUi.results.frozenSub', { n: a.frozen }) : undefined} />
        <Card label={t('physioUi.results.unable')} value={String(a.combined.unableToAct)} sub={t('physioUi.results.unableSub', { n: a.combined.severelyImpaired })} />
        <Card label={t('physioUi.results.thermal')} value={String(a.people - a.thermal.normal)} sub={thermalSub || t('physioUi.thermal.normal')} />
        <Card label={t('physioUi.results.coreRange')} value={a.minCore === null ? '–' : `${fmt(a.minCore, 1)}–${fmt(a.maxCore!, 1)}`} unit={a.minCore === null ? '' : '°C'} sub={a.minCore === null ? t('physioUi.notComputed') : undefined} />
        <Card label={t('physioUi.results.airway')} value={String(a.airwaySubmerged)} sub={t('physioUi.results.airwaySub', { n: a.airwayEver })} />
        <Card label={t('physioUi.results.fedGas')} value={nz(a.maxFedAsphyxiant, 3)} sub={t('physioUi.results.fedSub')} />
        <Card label={t('physioUi.results.fedHeat')} value={nz(a.maxFedHeat, 3)} />
        <Card label={t('physioUi.results.coDose')} value={nz(a.maxCoDose, 0)} unit={a.maxCoDose === null ? '' : 'ppm·min'} />
        <Card label={t('physioUi.results.smoke')} value={nz(a.maxSmokeDose, 0)} unit={a.maxSmokeDose === null ? '' : 'mg·min/m³'} />
        <Card label={t('physioUi.results.supply')} value={nz(a.minSupply, 2)} sub={a.minSupply === null ? t('physioUi.notComputed') : t('physioUi.results.supplySub')} />
        <Card label={t('physioUi.results.deficit')} value={nz(a.maxDeficit, 2)} unit={a.maxDeficit === null ? '' : '%'} />
        <Card label={t('physioUi.results.fatigue')} value={nz(a.maxFatigue, 2)} />
      </div>
      <table className={styles.table} data-testid="physio-levels" style={{ marginTop: 8 }}>
        <thead>
          <tr><th>{t('physioUi.results.capacity')}</th>{CAPACITY_LEVELS.map((l) => <th key={l} className={styles.num} style={{ color: capColor(l), textAlign: 'right' }}>{capLabel(t, l)}</th>)}</tr>
        </thead>
        <tbody>
          <tr style={{ cursor: 'default' }}><td>{t('physioUi.inspect.capacityPhys')}</td>{CAPACITY_LEVELS.map((l) => <td key={l} className={styles.num}>{a.physiological[l]}</td>)}</tr>
          <tr style={{ cursor: 'default' }}><td>{t('physioUi.inspect.capacityCombined')}</td>{CAPACITY_LEVELS.map((l) => <td key={l} className={styles.num}>{a.combined[l]}</td>)}</tr>
        </tbody>
      </table>
      <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
        <table className={styles.table} data-testid="physio-table">
          <thead>
            <tr>
              <th>{t('physioUi.results.col.person')}</th><th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.core')}</th><th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.skin')}</th>
              <th>{t('physioUi.inspect.thermalState')}</th><th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.supply')}</th><th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.fed')}</th>
              <th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.smoke')}</th><th>{t('physioUi.inspect.airway')}</th><th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.deficit')}</th>
              <th className={styles.num} style={NUM_TH}>{t('physioUi.results.col.fatigue')}</th><th>{t('physioUi.results.col.capacity')}</th><th>{t('physioUi.results.col.causes')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setPick(r.id)} style={r.id === who?.id ? { background: 'var(--accent-soft)' } : undefined}>
                <td>{label(r.id)}</td>
                <td className={styles.num}>{nz(r.core, 2)}</td>
                <td className={styles.num}>{nz(r.skin, 2)}</td>
                <td>{thermalLabel(t, r.thermalState)}</td>
                <td className={styles.num}>{nz(r.supply, 2)}</td>
                <td className={styles.num}>{nz(r.fedAsphyxiant, 3)}</td>
                <td className={styles.num}>{nz(r.smokeDose, 0)}</td>
                <td>{airwayLabel(t, r.airway)}</td>
                <td className={styles.num}>{nz(r.deficit, 2)}</td>
                <td className={styles.num}>{nz(r.fatigue, 2)}</td>
                <td style={{ color: capColor(r.combined) }}>{capLabel(t, r.combined)}</td>
                <td>{r.combinedCauses.length ? causesLabel(t, r.combinedCauses) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {people.length > TABLE_ROWS && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('physioUi.results.more', { n: people.length - TABLE_ROWS })}</div>}
      </div>
      {who && s ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('physioUi.results.chartsOf')}</span>
            <select value={who.id} onChange={(ev) => setPick(ev.target.value)} aria-label={t('physioUi.results.chartsOf')} data-testid="physio-chart-person" style={{ fontSize: 11.5 }}>
              {charted.map((e) => <option key={e.id} value={e.id}>{label(e.id)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }} data-testid="physio-charts">
            <Chart title={t('physioUi.ch.temperature')} unit={SERIES_UNITS.core} t={s.t} empty={nc} testId="physio-chart-temperature"
              series={[ser('core', t('physioUi.ch.core')), ser('skin', t('physioUi.ch.skin')), ser('air', t('physioUi.ch.air'))]} />
            <Chart title={t('physioUi.ch.heat')} unit="W" t={s.t} empty={nc} testId="physio-chart-heat" series={[ser('heatIn', t('physioUi.ch.in')), ser('heatOut', t('physioUi.ch.out'))]} />
            <Chart title={t('physioUi.ch.strain')} unit="K" t={s.t} empty={nc} testId="physio-chart-strain" series={[ser('strain', '')]} />
            <Chart title={t('physioUi.ch.supply')} unit="" t={s.t} empty={nc} testId="physio-chart-supply" series={[ser('supply', '')]} />
            <Chart title={t('physioUi.ch.breathing')} unit="" t={s.t} empty={nc} testId="physio-chart-breathing" series={[ser('breathing', '')]} label={(x) => (x >= 0.5 ? t('physioUi.yes') : t('physioUi.no'))} />
            <Chart title={t('physioUi.ch.smoke')} unit="mg·min/m³" t={s.t} empty={nc} testId="physio-chart-smoke" series={[ser('smoke', '')]} />
            <Chart title={t('physioUi.ch.airway')} unit="s" t={s.t} empty={nc} testId="physio-chart-airway" series={[ser('airway', '')]} />
            <Chart title={t('physioUi.ch.deficit')} unit="%" t={s.t} empty={nc} testId="physio-chart-deficit" series={[ser('deficit', '')]} />
            <Chart title={t('physioUi.ch.fatigue')} unit="" t={s.t} empty={nc} testId="physio-chart-fatigue" series={[ser('fatigue', '')]} />
            <Chart title={t('physioUi.ch.capacity')} unit="" t={s.t} empty={nc} testId="physio-chart-capacity" series={[ser('capacity', '')]} label={(x) => capLabel(t, CAPACITY_LEVELS[Math.max(0, Math.min(4, Math.round(x)))])} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('physioUi.results.chartNote')}</div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{t('physioUi.results.noSeries')}</div>
      )}
    </div>
  );
}
