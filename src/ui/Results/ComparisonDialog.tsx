import { useEffect, useRef, useState } from 'react';
import { useT, type TFunction } from '@/i18n/i18n';
import { useUiStore } from '@/ui/uiStore';
import { useWorldStore } from '@/world/worldStore';
import { compareExperiment, type ComparisonRun } from '@/app/actions';
import { phenomena } from '@/phenomena/registry';
import { defaultScenarios, type ScenarioResult } from '@/phenomena/experiment';
import { NumberField } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { fmt } from '@/ui/format';
import styles from './ResultsPanel.module.css';

type MetricKey = 'damagedObjects' | 'collapsedBuildings' | 'displacedObjects' | 'floodedArea' | 'totalDamageEvents' | 'simTime' | 'msPerSimSecond';
const METRICS: { key: MetricKey; unit: string; digits: number }[] = [
  { key: 'damagedObjects', unit: '', digits: 0 },
  { key: 'collapsedBuildings', unit: '', digits: 0 },
  { key: 'displacedObjects', unit: '', digits: 0 },
  { key: 'floodedArea', unit: 'm²', digits: 0 },
  { key: 'totalDamageEvents', unit: '', digits: 0 },
  { key: 'simTime', unit: 's', digits: 0 },
  { key: 'msPerSimSecond', unit: 'ms/s', digits: 1 },
];

function scenarioLabel(r: { id: string; instanceIds: string[] }, t: TFunction, types: Map<string, string>) {
  const names = r.instanceIds.map((id) => `${id} ${t(phenomena.get(types.get(id) ?? '')?.labelKey ?? 'phen.wind')}`);
  return r.id === 'all' ? `${t('exp.cmp.all')} (${names.join(' + ')})` : names.join(' + ');
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Experiment comparison (Phase 15): each phenomenon alone and all together, same initial world. */
export function ComparisonDialog() {
  const open = useUiStore((s) => s.compareOpen);
  if (!open) return null;
  return <Dialog />;
}

function Dialog() {
  const t = useT();
  const exp = useWorldStore((s) => s.doc.scenario.experiment);
  const name = useWorldStore((s) => s.doc.meta.name);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const interactions = useWorldStore((s) => s.doc.settings.simulation.interactions?.enabled ?? true);
  const [results, setResults] = useState<ScenarioResult[] | null>(null);
  const [progress, setProgress] = useState<{ scenario: number; time: number; total: number } | null>(null);
  const run = useRef<ComparisonRun | null>(null);
  const scenarios = defaultScenarios(exp.instances);
  const types = new Map(exp.instances.map((i) => [i.id, i.type]));
  const close = () => {
    run.current?.cancel();
    useUiStore.getState().setCompareOpen(false);
  };
  useEffect(() => () => run.current?.cancel(), []);

  const start = () => {
    setResults(null);
    const r = compareExperiment((scenario, time, total) => setProgress({ scenario, time, total }));
    run.current = r;
    void r.done.then((res) => {
      setResults(res);
      setProgress(null);
      run.current = null;
    });
  };

  const max = (k: MetricKey) => Math.max(1e-9, ...(results ?? []).map((r) => r[k]));
  const exportCsv = () => {
    if (!results) return;
    const head = ['scenario', ...METRICS.map((m) => m.key), 'wind_events', 'earthquake_events', 'flood_events', 'wall_ms'];
    const rows = results.map((r) => [scenarioLabel(r, t, types), ...METRICS.map((m) => r[m.key].toFixed(m.digits)), r.eventsByHazard.wind, r.eventsByHazard.earthquake, r.eventsByHazard.flood, r.wallMs.toFixed(0)]
      .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','));
    download(`${name || 'experiment'}-comparison.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  };
  const exportJson = () => results && download(`${name || 'experiment'}-comparison.json`, JSON.stringify({ model: 'approximate', seed, interactions, instances: exp.instances, results }, null, 2), 'application/json');

  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div className={styles.dialog} style={{ height: 'auto', maxHeight: 'min(760px, calc(100vh - 60px))' }} role="dialog" aria-modal="true" aria-label={t('exp.cmp.title')} onMouseDown={(e) => e.stopPropagation()} data-testid="comparison-dialog">
        <div className={styles.head}>
          <Icon name="flask" />
          <span className={styles.title}>{t('exp.cmp.title')}</span>
          <span className={styles.badge}>{t('model.badge')}</span>
          <span className={styles.meta}>seed {seed} · {t(interactions ? 'exp.cmp.interactionsOn' : 'exp.cmp.interactionsOff')}</span>
          <div className={styles.headActions}>
            <button className={styles.btn} onClick={exportCsv} disabled={!results}><Icon name="save" size={14} /> CSV</button>
            <button className={styles.btn} onClick={exportJson} disabled={!results}><Icon name="save" size={14} /> JSON</button>
            <button className={styles.btn} onClick={close} aria-label={t('common.close')}><Icon name="x" size={14} /></button>
          </div>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
          <div className={styles.disclaimer}>{t('exp.cmp.note')}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12 }}>{t('exp.cmp.scenarios', { n: scenarios.length })}</span>
            <div style={{ width: 230 }}>
              <NumberField label={t('exp.cmp.duration')} value={exp.compareDuration} min={0} max={600} step={10} precision={0} unit="s"
                onChange={(v, live) => !live && useWorldStore.getState().setExperiment({ compareDuration: v })} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('exp.cmp.durationHint')}</span>
            <button className={styles.btn} style={{ marginLeft: 'auto' }} disabled={progress !== null || scenarios.length === 0} onClick={start}>
              <Icon name="play" size={14} /> {t('exp.cmp.run')}
            </button>
            {progress && <button className={styles.btn} onClick={() => run.current?.cancel()}>{t('exp.cmp.stop')}</button>}
          </div>
          {progress && (
            <div style={{ fontSize: 12 }} data-testid="comparison-progress">
              {t('exp.cmp.progress', { i: progress.scenario + 1, n: scenarios.length, t: progress.time.toFixed(0), total: progress.total.toFixed(0) })}
              <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 2, marginTop: 4 }}>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--accent)', width: `${((progress.scenario + progress.time / progress.total) / scenarios.length) * 100}%` }} />
              </div>
            </div>
          )}
          {results && (
            <table className={styles.table} data-testid="comparison-table">
              <thead>
                <tr>
                  <th>{t('exp.cmp.scenario')}</th>
                  {METRICS.map((m) => <th key={m.key} className={styles.num}>{t(`exp.cmp.${m.key}`)}</th>)}
                  <th className={styles.num}>{t('exp.cmp.byHazard')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id} style={{ cursor: 'default' }}>
                    <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{scenarioLabel(r, t, types)}{r.issues.length > 0 && <span style={{ color: 'var(--warn)' }}> ⚠</span>}</td>
                    {METRICS.map((m) => (
                      <td key={m.key} className={styles.num}>
                        <div>{fmt(r[m.key], m.digits)}{m.unit && <span style={{ color: 'var(--text-3)', marginLeft: 3 }}>{m.unit}</span>}</div>
                        <div style={{ height: 3, background: 'var(--bg-4)', borderRadius: 2, marginTop: 2 }}>
                          <div style={{ height: 3, borderRadius: 2, width: `${(r[m.key] / max(m.key)) * 100}%`, background: m.key === 'msPerSimSecond' || m.key === 'simTime' ? 'var(--text-3)' : 'var(--sim)' }} />
                        </div>
                      </td>
                    ))}
                    <td className={styles.num}>{r.eventsByHazard.wind} / {r.eventsByHazard.earthquake} / {r.eventsByHazard.flood}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {results && <div className={styles.cardSub}>{t('exp.cmp.legend')}</div>}
        </div>
      </div>
    </div>
  );
}
