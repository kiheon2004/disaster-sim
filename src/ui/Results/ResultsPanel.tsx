import { useEffect, useMemo, useState } from 'react';
import { useLocale, useT, type MessageKey, type TFunction } from '@/i18n/i18n';
import type { ObjectType } from '@/core/types';
import { useSimStore } from '@/simulation/simStore';
import type { DamageEventRecord, DamageEventType } from '@/simulation/analysis/DamageEvent';
import { useWorldStore } from '@/world/worldStore';
import { focusPosition } from '@/app/actions';
import { useUiStore } from '@/ui/uiStore';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import styles from './ResultsPanel.module.css';

const PAGE = 400;

const EVENT_COLORS: Partial<Record<DamageEventType, string>> = {
  DESTROYED: '#8a8f98', COLLAPSED: '#ef4d4d', SNAPPED: '#f5973b', UPROOTED: '#f5973b', FALLEN: '#ef4d4d',
  OVERTURNED: '#ef4d4d', MOVED: '#e6d14a', BROKEN: '#7fb8e6', DETACHED: '#f5a13b', TOPPLED: '#f5973b',
  CRITICAL: '#ef4d4d', DAMAGED: '#f5973b', IMPACT: '#c43bd6',
};

function objectLabel(e: DamageEventRecord, objects: ReturnType<typeof useWorldStore.getState>['doc']['objects'], t: TFunction) {
  const o = objects[e.objectId];
  const base = o ? displayName(o, t) : e.objectId;
  // Component ids look like "win-s-2-3" / "roof-1-0" / "sign": show the numeric part only.
  const idx = e.componentId?.match(/\d+(?:-\d+)*$/)?.[0];
  return e.componentKind ? `${base} · ${t(`component.${e.componentKind}`)}${idx ? ` #${idx}` : ''}` : base;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Post-run analysis: summary metrics, damage histogram and the full damage event history. */
export function ResultsPanel() {
  const open = useUiStore((s) => s.resultsOpen);
  if (!open) return null;
  return <ResultsDialog />;
}

function ResultsDialog() {
  const t = useT();
  const locale = useLocale();
  const metrics = useSimStore((s) => s.metrics);
  const events = useSimStore((s) => s.damageEvents);
  const objects = useWorldStore((s) => s.doc.objects);
  const name = useWorldStore((s) => s.doc.meta.name);
  const [typeFilter, setTypeFilter] = useState<'all' | ObjectType>('all');
  const [eventFilter, setEventFilter] = useState<'all' | DamageEventType>('all');
  const [second, setSecond] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const close = () => useUiStore.getState().setResultsOpen(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(
    () =>
      events.filter(
        (e) =>
          (typeFilter === 'all' || e.objectType === typeFilter) &&
          (eventFilter === 'all' || e.eventType === eventFilter) &&
          (second === null || Math.floor(e.time) === second),
      ),
    [events, typeFilter, eventFilter, second],
  );
  const types = useMemo(() => [...new Set(events.map((e) => e.objectType))], [events]);
  const evTypes = useMemo(() => [...new Set(events.map((e) => e.eventType))], [events]);

  const exportCsv = () => {
    const head = ['time_s', 'object_id', 'object_name', 'object_type', 'component', 'event', 'cause', 'x', 'y', 'z', 'local_wind_ms', 'global_wind_ms', 'force_N', 'damage_before', 'damage_after', 'shadow_source'];
    const rows = events.map((e) => [
      e.time.toFixed(2), e.objectId, objects[e.objectId] ? displayName(objects[e.objectId], t) : '', e.objectType, e.componentId ?? '', e.eventType, e.cause,
      ...e.worldPosition.map((v) => v.toFixed(2)), e.localWindSpeed.toFixed(2), e.globalWindSpeed.toFixed(2), e.force.toFixed(0),
      e.damageBefore.toFixed(3), e.damageAfter.toFixed(3), e.shadowSource ?? '',
    ].map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','));
    download(`${name || 'simulation'}-damage-events.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  };
  const exportJson = () => download(`${name || 'simulation'}-results.json`, JSON.stringify({ model: 'approximate', metrics, events }, null, 2), 'application/json');

  const m = metrics;
  const hist = m?.histogram ?? [];
  const histMax = Math.max(1, ...hist);
  const maxObj = m?.maxLocalWindObject ? objects[m.maxLocalWindObject] : undefined;

  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('results.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <Icon name="list" />
          <span className={styles.title}>{t('results.title')}</span>
          <span className={styles.badge}>{t('model.badge')}</span>
          {m && <span className={styles.meta}>seed {m.seed} · t = {fmt(m.duration, 1)} s</span>}
          <div className={styles.headActions}>
            <button className={styles.btn} onClick={exportCsv} disabled={!events.length}><Icon name="save" size={14} /> CSV</button>
            <button className={styles.btn} onClick={exportJson} disabled={!m}><Icon name="save" size={14} /> JSON</button>
            <button className={styles.btn} onClick={close} aria-label={t('common.close')}><Icon name="x" size={14} /></button>
          </div>
        </div>
        <div className={styles.body}>
          <div className={styles.disclaimer}>{t('model.approximate')}</div>
          {m ? (
            <div className={styles.cards}>
              <Card label={t('results.maxWind')} value={`${fmt(m.maxWindSpeed, 1)}`} unit="m/s" sub={`${t('results.avgWind')} ${fmt(m.averageWindSpeed, 1)} m/s`} />
              <Card label={t('results.maxLocal')} value={`${fmt(m.maxLocalWindSpeed, 1)}`} unit="m/s" sub={maxObj ? displayName(maxObj, t) : '–'} />
              <Card label={t('results.totalEvents')} value={String(m.totalDamageEvents)} sub={m.firstDamageTime !== null ? `${t('results.firstDamage')} ${fmt(m.firstDamageTime, 1)} s` : t('results.noDamage')} />
              <Card label={t('results.damaged')} value={String(m.objectsDamaged)} sub={`${t('results.destroyed')} ${m.objectsDestroyed}`} />
              <Card label={t('results.peak')} value={m.peakDamageTime !== null ? `${fmt(m.peakDamageTime, 1)}` : '–'} unit={m.peakDamageTime !== null ? 's' : ''} sub={t('results.peakCount', { n: m.peakDamageCount })} />
              <Card label={t('results.duration')} value={fmt(m.duration, 1)} unit="s" sub={t('results.seed', { seed: m.seed })} />
              <Card label={t('sim.stat.fallenPeople')} value={String(m.humansFallen)} />
              <Card label={t('sim.stat.movedCars')} value={String(m.vehiclesMoved)} />
              <Card label={t('sim.stat.fallenTrees')} value={String(m.treesFallen)} />
              <Card label={t('results.buildingsDamaged')} value={String(m.buildingsDamaged)} />
              <Card label={t('results.destroyed')} value={String(m.objectsDestroyed)} />
              <Card label={t('results.events')} value={String(events.length)} />
            </div>
          ) : (
            <div className={styles.empty}>{t('results.none')}</div>
          )}
          <div className={styles.split}>
            <div className={styles.side}>
              <div className={styles.box}>
                <div className={styles.boxTitle}>{t('results.histogram')}</div>
                <svg width="100%" height="110" viewBox={`0 0 ${Math.max(hist.length, 1)} 100`} preserveAspectRatio="none" role="img" aria-label={t('results.histogram')}>
                  {hist.map((c, i) => (
                    <rect
                      key={i}
                      x={i + 0.1}
                      width={0.8}
                      y={100 - (c / histMax) * 100}
                      height={(c / histMax) * 100}
                      fill={second === i ? 'var(--accent)' : 'var(--sim)'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSecond(second === i ? null : i)}
                    >
                      <title>{`${i}–${i + 1}s: ${c}`}</title>
                    </rect>
                  ))}
                </svg>
                <div className={styles.cardSub}>{second !== null ? t('results.filterSecond', { s: second }) : t('results.histHint')}</div>
              </div>
              <div className={styles.box}>
                <div className={styles.boxTitle}>{t('results.byType')}</div>
                <TypeBreakdown events={events} t={t} />
              </div>
            </div>
            <div className={styles.tableWrap}>
              <div className={styles.filters}>
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} aria-label={t('results.filterType')}>
                  <option value="all">{t('results.allObjects')}</option>
                  {types.map((ty) => <option key={ty} value={ty}>{t(`object.${ty}`)}</option>)}
                </select>
                <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value as typeof eventFilter)} aria-label={t('results.filterEvent')}>
                  <option value="all">{t('results.allEvents')}</option>
                  {evTypes.map((ev) => <option key={ev} value={ev}>{t(`evt.${ev}` as MessageKey)}</option>)}
                </select>
                {second !== null && <button className={styles.btn} onClick={() => setSecond(null)}>{t('results.clearSecond')}</button>}
                <span className={styles.count}>{t('results.showing', { n: Math.min(limit, filtered.length), total: filtered.length })}</span>
              </div>
              <div className={styles.scroll}>
                {filtered.length === 0 ? (
                  <div className={styles.empty}>{t('results.noEvents')}</div>
                ) : (
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t('results.col.time')}</th>
                        <th>{t('results.col.object')}</th>
                        <th>{t('results.col.event')}</th>
                        <th>{t('results.col.cause')}</th>
                        <th className={styles.num}>{t('results.col.local')}</th>
                        <th className={styles.num}>{t('results.col.global')}</th>
                        <th className={styles.num}>{t('results.col.force')}</th>
                        <th className={styles.num}>{t('results.col.damage')}</th>
                        <th>{t('results.col.shadow')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, limit).map((e) => (
                        <tr key={e.id} onClick={() => { focusPosition(e.worldPosition, e.objectId); }} title={t('results.rowHint')}>
                          <td className={styles.num}>{e.time.toFixed(1)}s</td>
                          <td>{objectLabel(e, objects, t)}</td>
                          <td><span className={styles.evt} style={{ color: EVENT_COLORS[e.eventType] }}>{t(`evt.${e.eventType}` as MessageKey)}</span></td>
                          <td>{t(`cause.${e.cause}`)}</td>
                          <td className={styles.num}>{e.localWindSpeed.toFixed(1)}</td>
                          <td className={styles.num}>{e.globalWindSpeed.toFixed(1)}</td>
                          <td className={styles.num}>{(e.force / 1000).toFixed(2)}</td>
                          <td className={styles.num}>{Math.round(e.damageBefore * 100)}→{Math.round(e.damageAfter * 100)}%</td>
                          <td>{e.shadowSource && objects[e.shadowSource] ? displayName(objects[e.shadowSource], t) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {filtered.length > limit && (
                  <div className={styles.more}><button onClick={() => setLimit((l) => l + PAGE)}>{t('results.more')}</button></div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <span hidden>{locale}</span>
    </div>
  );
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

function TypeBreakdown({ events, t }: { events: DamageEventRecord[]; t: TFunction }) {
  const rows = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.eventType, (m.get(e.eventType) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return <div className={styles.cardSub}>–</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map(([k, n]) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 40px', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
          <span style={{ color: EVENT_COLORS[k as DamageEventType] }}>{t(`evt.${k}` as MessageKey)}</span>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-4)' }}>
            <div style={{ width: `${(n / max) * 100}%`, height: '100%', borderRadius: 3, background: EVENT_COLORS[k as DamageEventType] ?? 'var(--accent)' }} />
          </div>
          <span className="mono" style={{ textAlign: 'right' }}>{n}</span>
        </div>
      ))}
    </div>
  );
}
