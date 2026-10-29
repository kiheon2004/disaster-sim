import { energyText } from '@/thermal/units';
import { THERMAL_MATERIAL_IDS } from '@/thermal/materials';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLocale, useT, type MessageKey, type TFunction } from '@/i18n/i18n';
import type { ObjectType } from '@/core/types';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import type { DamageEventRecord, DamageEventType, Hazard } from '@/simulation/analysis/DamageEvent';
import type { EarthquakeMetrics, SeismicSeries } from '@/simulation/analysis/SeismicRecorder';
import type { FloodMetrics, FloodSeries } from '@/simulation/analysis/FloodRecorder';
import { useWorldStore } from '@/world/worldStore';
import { focusPosition } from '@/app/actions';
import { useUiStore } from '@/ui/uiStore';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import { DAMAGE_STATE_IDS } from '@/simulation/damage/DamageState';
import { MODELS } from '@/phenomena/models';
import { phenomena } from '@/phenomena/registry';
import { ModelBadge } from '@/ui/common/ModelBadge';
import styles from './ResultsPanel.module.css';

const PAGE = 400;

const EVENT_COLORS: Partial<Record<DamageEventType, string>> = {
  DESTROYED: '#8a8f98', COLLAPSED: '#ef4d4d', SNAPPED: '#f5973b', UPROOTED: '#f5973b', FALLEN: '#ef4d4d',
  OVERTURNED: '#ef4d4d', MOVED: '#e6d14a', BROKEN: '#7fb8e6', DETACHED: '#f5a13b', TOPPLED: '#f5973b',
  CRITICAL: '#ef4d4d', DAMAGED: '#f5973b', IMPACT: '#c43bd6', CRACKED: '#d9a441', TILTED: '#ef4d4d',
  INUNDATED: '#46a0e6', FLOATED: '#2d7fd0', SCOURED: '#8a6a48',
};

const HAZARD_COLORS: Partial<Record<Hazard, string>> = { earthquake: '#ffb3a1', flood: '#9fd3ff', ground: '#ffd9a0', impact: '#ff8fd0', blast: '#ffcf5c' };

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
  const [hazardFilter, setHazardFilter] = useState<'all' | Hazard>('all');
  const series = useSimStore((s) => s.seismicSeries);
  const floodSeries = useSimStore((s) => s.floodSeries);
  const milestones = useSimStore((s) => s.milestones);
  const runEvents = useSimStore((s) => s.events);
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
          (hazardFilter === 'all' || e.hazard === hazardFilter) &&
          (second === null || Math.floor(e.time) === second),
      ),
    [events, typeFilter, eventFilter, hazardFilter, second],
  );
  const types = useMemo(() => [...new Set(events.map((e) => e.objectType))], [events]);
  const evTypes = useMemo(() => [...new Set(events.map((e) => e.eventType))], [events]);
  const hazards = useMemo(() => [...new Set(events.map((e) => e.hazard))], [events]);

  const exportCsv = () => {
    const head = ['time_s', 'object_id', 'object_name', 'object_type', 'component', 'event', 'cause', 'x', 'y', 'z', 'local_wind_ms', 'global_wind_ms', 'force_N', 'damage_before', 'damage_after', 'shadow_source', 'hazard', 'ground_accel_g', 'response', 'water_depth_m', 'flow_speed_ms', 'exposure_s', 'damage_state', 'origin', 'damage_wind', 'damage_earthquake', 'damage_flood', 'damage_ground', 'source',
      'failure', 'chain_trigger', 'chain_root', 'chain_depth', 'secondary_striker', 'secondary_source', 'secondary_member'];
    const rows = events.map((e) => [
      e.time.toFixed(2), e.objectId, objects[e.objectId] ? displayName(objects[e.objectId], t) : '', e.objectType, e.componentId ?? '', e.eventType, e.cause,
      ...e.worldPosition.map((v) => v.toFixed(2)), e.localWindSpeed.toFixed(2), e.globalWindSpeed.toFixed(2), e.force.toFixed(0),
      e.damageBefore.toFixed(3), e.damageAfter.toFixed(3), e.shadowSource ?? '',
      e.hazard, (e.groundAcceleration / 9.81).toFixed(3), e.response.toFixed(4),
      (e.waterDepth ?? 0).toFixed(3), (e.flowSpeed ?? 0).toFixed(3), (e.exposure ?? 0).toFixed(1), DAMAGE_STATE_IDS[e.state ?? 0] ?? '',
      e.origin ?? e.hazard, ...(['wind', 'earthquake', 'flood', 'ground'] as const).map((h) => (e.contributors?.[h] ?? 0).toFixed(3)), e.source ?? '',
      e.failure ?? '', e.chain?.trigger ?? '', e.chain?.root ?? '', e.chain?.depth ?? '', e.secondary?.striker ?? '', e.secondary?.source ?? '', e.secondary?.member ?? '',
    ].map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','));
    download(`${name || 'simulation'}-damage-events.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  };
  const exportJson = () => download(`${name || 'simulation'}-results.json`, JSON.stringify({
    model: 'approximate', groundMotion: metrics?.earthquake ? 'synthetic' : undefined,
    floodModel: metrics?.flood ? 'local-inertial shallow-water approximation (educational, not a validated hydraulic model)' : undefined,
    metrics, seismicSeries: series ?? undefined, floodSeries: floodSeries ?? undefined, events,
    structure: useSimStore.getState().structure ?? undefined, collapseSequences: collapseSequences(),
    thermal: useSimStore.getState().thermal ?? undefined, thermalMembers: thermalMembers(),
    milestones, models: modelsUsed(runEvents.map((e) => e.type), useWorldStore.getState().doc.settings.simulation.interactions?.enabled ?? true).map((id) => MODELS[id]),
  }, null, 2), 'application/json');

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
        <div className={m?.earthquake || m?.flood ? `${styles.body} ${styles.bodyHazard}` : styles.body}>
          <div className={styles.disclaimer}>{t('model.approximate')}</div>
          <ExperimentSummary t={t} />
          {m?.flood && <FloodSummary f={m.flood} t={t} objects={objects} series={floodSeries} events={events} name={name} />}
          {m?.earthquake && <QuakeSummary q={m.earthquake} t={t} objects={objects} series={series} events={events} />}
          <ThermalSummary t={t} name={name} />
          <StructureSummary t={t} name={name} />
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
                {hazards.length > 1 && (
                  <select value={hazardFilter} onChange={(e) => setHazardFilter(e.target.value as typeof hazardFilter)} aria-label={t('results.col.hazard')}>
                    <option value="all">{t('results.allHazards')}</option>
                    {hazards.map((h) => <option key={h} value={h}>{t(`hazardName.${h}`)}</option>)}
                  </select>
                )}
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
                        <th>{t('results.col.hazard')}</th>
                        <th>{t('results.col.cause')}</th>
                        <th className={styles.num}>{t('results.col.local')}</th>
                        <th className={styles.num}>{t('results.col.global')}</th>
                        <th className={styles.num}>{t('results.col.force')}</th>
                        <th className={styles.num}>{t('results.col.damage')}</th>
                        <th className={styles.num}>{t('results.col.ground')}</th>
                        <th className={styles.num}>{t('results.col.response')}</th>
                        {hazards.includes('flood') && <th className={styles.num}>{t('results.col.depth')}</th>}
                        {hazards.includes('flood') && <th className={styles.num}>{t('results.col.flow')}</th>}
                        {hazards.includes('flood') && <th className={styles.num}>{t('results.col.exposure')}</th>}
                        <th>{t('results.col.shadow')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, limit).map((e) => (
                        <tr key={e.id} onClick={() => { focusPosition(e.worldPosition, e.objectId); }} title={t('results.rowHint')}>
                          <td className={styles.num}>{e.time.toFixed(1)}s</td>
                          <td>{objectLabel(e, objects, t)}</td>
                          <td><span className={styles.evt} style={{ color: EVENT_COLORS[e.eventType] }}>{t(`evt.${e.eventType}` as MessageKey)}</span></td>
                          <td style={{ color: HAZARD_COLORS[e.hazard] }}>{t(`hazardName.${e.hazard}`)}</td>
                          <td>{t(`cause.${e.cause}`)}</td>
                          <td className={styles.num}>{e.localWindSpeed.toFixed(1)}</td>
                          <td className={styles.num}>{e.globalWindSpeed.toFixed(1)}</td>
                          <td className={styles.num}>{(e.force / 1000).toFixed(2)}</td>
                          <td className={styles.num}>{Math.round(e.damageBefore * 100)}→{Math.round(e.damageAfter * 100)}%</td>
                          <td className={styles.num}>{e.hazard === 'earthquake' ? (e.groundAcceleration / 9.81).toFixed(2) : ''}</td>
                          <td className={styles.num}>{e.hazard === 'earthquake' && e.response ? (e.cause === 'drift' ? `${(e.response * 100).toFixed(2)}%` : e.cause === 'foundation' ? `${e.response.toFixed(1)}°` : `${e.response.toFixed(2)}g`) : ''}</td>
                          {hazards.includes('flood') && <td className={styles.num}>{e.hazard === 'flood' ? e.waterDepth.toFixed(2) : ''}</td>}
                          {hazards.includes('flood') && <td className={styles.num}>{e.hazard === 'flood' ? e.flowSpeed.toFixed(2) : ''}</td>}
                          {hazards.includes('flood') && <td className={styles.num}>{e.hazard === 'flood' ? Math.round(e.exposure) : ''}</td>}
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

/** Earthquake analysis block: summary cards + ground acceleration / drift / damage chart. */
function QuakeSummary({ q, t, objects, series, events }: {
  q: EarthquakeMetrics; t: TFunction; objects: ReturnType<typeof useWorldStore.getState>['doc']['objects'];
  series: SeismicSeries | null; events: DamageEventRecord[];
}) {
  const name = (id: string | null) => (id && objects[id] ? displayName(objects[id], t) : '–');
  const quakeEvents = events.filter((e) => e.hazard === 'earthquake');
  const tMax = Math.max(1, ...(series?.t ?? [1]), ...quakeEvents.map((e) => e.time));
  const gMax = Math.max(0.05, ...(series?.ground.map(Math.abs) ?? [0]));
  const dMax = Math.max(0.002, ...(series?.drift ?? [0]));
  return (
    <div className={styles.box}>
      <div className={styles.boxTitle} style={{ color: '#ffb3a1' }}>{t('results.quake.title')} · M{q.magnitude.toFixed(1)} · {t('quakeHud.synthetic')}</div>
      <div className={`${styles.cards} ${styles.quakeCards}`}>
        <Card label={t('results.quake.duration')} value={fmt(q.duration, 1)} unit="s" />
        <Card label={t('results.quake.pga')} value={fmt(q.peakGroundAcceleration, 2)} unit="g" sub={t('results.quake.pgaSub', { g: q.inputPga.toFixed(2) })} />
        <Card label={t('results.quake.maxDisp')} value={fmt(q.maxBuildingDisplacement * 100, 1)} unit="cm" sub={name(q.maxDisplacementObject)} />
        <Card label={t('results.quake.maxDrift')} value={fmt(q.maxDrift * 100, 2)} unit="%" sub={name(q.maxDriftObject)} />
        <Card label={t('results.quake.maxFloorAcc')} value={fmt(q.maxFloorAcceleration, 2)} unit="g" />
        <Card label={t('results.quake.damaged')} value={String(q.buildingsDamaged)} />
        <Card label={t('results.quake.collapsed')} value={String(q.buildingsCollapsed)} />
        <Card label={t('results.quake.infra')} value={String(q.infrastructureFallen)} />
        <Card label={t('results.quake.people')} value={String(q.peopleFallen)} />
        <Card label={t('results.quake.events')} value={String(q.earthquakeEvents)} sub={t('results.quake.windEvents', { n: q.windEvents })} />
      </div>
      {series && series.t.length > 1 && (
        <>
          <div className={styles.cardSub} style={{ marginTop: 6 }}>{t('results.quake.chart')}</div>
          <svg width="100%" height="120" viewBox={`0 -1.05 1000 2.1`} preserveAspectRatio="none" role="img" aria-label={t('results.quake.chart')}>
            <line x1={0} x2={1000} y1={0} y2={0} stroke="var(--line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <polyline fill="none" stroke="#f08a3c" strokeWidth={1.2} vectorEffect="non-scaling-stroke" points={series.t.map((s, i) => `${(s / tMax) * 1000},${-series.ground[i] / gMax}`).join(' ')} />
            <polyline fill="none" stroke="#5aa9ff" strokeWidth={1.2} vectorEffect="non-scaling-stroke" points={series.t.map((s, i) => `${(s / tMax) * 1000},${1 - (series.drift[i] / dMax) * 1.9}`).join(' ')} />
            {quakeEvents.map((e) => (
              <line key={e.id} x1={(e.time / tMax) * 1000} x2={(e.time / tMax) * 1000} y1={1.05} y2={0.75} stroke="#ef4d4d" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          <div className={styles.cardSub}>
            <span style={{ color: '#f08a3c' }}>■</span> {t('seis.ground')} (±{gMax.toFixed(2)} g) · <span style={{ color: '#5aa9ff' }}>■</span> {t('seis.response')} (≤ {(dMax * 100).toFixed(2)} %) · <span style={{ color: '#ef4d4d' }}>■</span> {t('seis.damage')} · 0–{tMax.toFixed(0)} s
          </div>
        </>
      )}
      <div className={styles.disclaimer} style={{ marginTop: 6 }}>{t('results.quake.disclaimer')}</div>
    </div>
  );
}

const fmtArea = (m2: number) => (m2 >= 10000 ? `${fmt(m2 / 10000, 2)} ha` : `${Math.round(m2)} m²`);

/** Flood analysis block (Phase 14): summary cards, area / volume chart and the water budget. */
function FloodSummary({ f, t, objects, series, events, name }: {
  f: FloodMetrics; t: TFunction; objects: ReturnType<typeof useWorldStore.getState>['doc']['objects'];
  series: FloodSeries | null; events: DamageEventRecord[]; name: string;
}) {
  const floodEvents = events.filter((e) => e.hazard === 'flood');
  const b = f.budget;
  const tMax = Math.max(1, ...(series?.t ?? [1]));
  const aMax = Math.max(1, ...(series?.area ?? [0]));
  const vMax = Math.max(1, ...(series?.volume ?? [0]));
  const exportSeries = () => {
    if (!series) return;
    const rows = series.t.map((tt, i) => [tt.toFixed(1), series.area[i].toFixed(1), series.volume[i].toFixed(3), series.maxDepth[i].toFixed(3), series.rain[i].toFixed(2)].join(','));
    download(`${name || 'simulation'}-flood-series.csv`, ['time_s,flooded_area_m2,water_volume_m3,max_depth_m,rain_mm_h', ...rows].join('\n'), 'text/csv');
  };
  const budgetRows: [string, number, string?][] = [
    [t('results.flood.budget.initial'), b.initial],
    [t('results.flood.budget.rain'), b.rain, '+'],
    [t('results.flood.budget.sources'), b.sources, '+'],
    [t('results.flood.budget.boundaryIn'), b.boundaryIn, '+'],
    [t('results.flood.budget.boundaryOut'), b.boundaryOut, '−'],
    [t('results.flood.budget.infiltration'), b.infiltration, '−'],
    [t('results.flood.budget.drainage'), b.drainage, '−'],
    [t('results.flood.budget.current'), b.current, '='],
  ];
  return (
    <div className={styles.box} data-testid="flood-results">
      <div className={styles.boxTitle} style={{ color: '#9fd3ff', display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.flood.title')} · {t('flood.badge')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportSeries} disabled={!series}><Icon name="save" size={13} /> {t('results.flood.csv')}</button>
      </div>
      <div className={`${styles.cards} ${styles.floodCards}`}>
        <Card label={t('results.flood.floodedArea')} value={fmtArea(f.floodedArea)} sub={t('results.flood.peakArea', { a: Math.round(f.peakFloodedArea) })} />
        <Card label={t('results.flood.maxDepth')} value={fmt(f.maxDepth, 2)} unit="m" sub={f.maxDepthAt ? `(${Math.round(f.maxDepthAt[0])}, ${Math.round(f.maxDepthAt[1])})` : undefined} />
        <Card label={t('results.flood.avgDepth')} value={fmt(f.averageDepth, 2)} unit="m" />
        <Card label={t('results.flood.maxSpeed')} value={fmt(f.maxFlowSpeed, 2)} unit="m/s" />
        <Card label={t('results.flood.volume')} value={fmt(f.totalVolume, 0)} unit="m³" />
        <Card label={t('results.flood.buildings')} value={String(f.floodedBuildings)} sub={f.maxObject && objects[f.maxObject] ? displayName(objects[f.maxObject], t) : undefined} />
        <Card label={t('results.flood.vehicles')} value={String(f.affectedVehicles)} sub={t('results.flood.floated', { n: f.floatedVehicles })} />
        <Card label={t('results.flood.humans')} value={String(f.fallenHumans)} />
        <Card label={t('results.flood.roads')} value={String(f.roadsInundated)} />
        <Card label={t('results.flood.infra')} value={String(f.infrastructureFailed)} />
        <Card label={t('results.flood.events')} value={String(f.floodDamageEvents)} />
        <Card label={t('results.duration')} value={fmt(f.duration, 0)} unit="s" />
      </div>
      <div className={styles.floodRow} style={{ marginTop: 8 }}>
        <div>
          <div className={styles.cardSub}>{t('results.flood.chart')}</div>
          {series && series.t.length > 1 ? (
            <>
              <svg width="100%" height="120" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={t('results.flood.chart')}>
                <polyline fill="none" stroke="#46a0e6" strokeWidth={1.6} vectorEffect="non-scaling-stroke" points={series.t.map((s, i) => `${(s / tMax) * 1000},${100 - (series.area[i] / aMax) * 96}`).join(' ')} />
                <polyline fill="none" stroke="#f2d43d" strokeWidth={1.4} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" points={series.t.map((s, i) => `${(s / tMax) * 1000},${100 - (series.volume[i] / vMax) * 96}`).join(' ')} />
                {floodEvents.map((e) => (
                  <line key={e.id} x1={(e.time / tMax) * 1000} x2={(e.time / tMax) * 1000} y1={100} y2={92} stroke="#ef4d4d" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
              </svg>
              <div className={styles.cardSub}>
                <span style={{ color: '#46a0e6' }}>■</span> {t('results.flood.area')} (≤ {fmtArea(aMax)}) · <span style={{ color: '#f2d43d' }}>■</span> {t('results.flood.water')} (≤ {fmt(vMax, 0)} m³) · <span style={{ color: '#ef4d4d' }}>■</span> {t('results.flood.damageMarks')} · 0–{tMax.toFixed(0)} s
              </div>
            </>
          ) : <div className={styles.cardSub}>–</div>}
        </div>
        <div>
          <div className={styles.cardSub}>{t('results.flood.budget')}</div>
          <div className={styles.budget}>
            {budgetRows.map(([label, v, sign]) => (
              <Fragment key={label}>
                <span>{sign ? `${sign} ` : ''}{label}</span>
                <span>{v.toFixed(2)}</span>
              </Fragment>
            ))}
            <span style={{ color: 'var(--text-2)' }}>{t('results.flood.budget.error')}</span>
            <span style={{ color: f.relativeError < 1e-6 ? '#4fc27a' : 'var(--warn)' }}>{b.error.toExponential(2)} ({f.relativeError.toExponential(1)})</span>
          </div>
        </div>
      </div>
      <div className={styles.disclaimer} style={{ marginTop: 6 }}>{t('flood.disclaimer')}</div>
    </div>
  );
}

/** Models behind a run: those of the phenomena that ran, plus the interaction models when on. */
export function modelsUsed(types: string[], interactions: boolean): string[] {
  const ids = new Set<string>();
  for (const ty of new Set(types)) for (const m of phenomena.get(ty)?.models ?? []) ids.add(m);
  const has = (...tt: string[]) => types.some((x) => tt.includes(x));
  const water = has('rain', 'risingWater', 'waterSource');
  if (water) ids.add('buoyancy').add('floodDamage');
  if (has('earthquake')) ids.add('structural');
  if (interactions) {
    if (has('wind') && water) ids.add('windStress');
    if (has('earthquake') && water) ids.add('waterInertia').add('saturatedBearing');
    if (has('wind') && has('earthquake')) ids.add('combinedStructuralLoad');
    if ([has('wind'), has('earthquake'), water].filter(Boolean).length >= 2) ids.add('residualStrength');
  }
  if (types.length) ids.add('exposure');
  return [...ids];
}

/** Experiment timeline (milestones in simulation-time order) and the models used (Phase 15). */
function ExperimentSummary({ t }: { t: TFunction }) {
  const milestones = useSimStore((s) => s.milestones);
  const events = useSimStore((s) => s.events);
  const interactions = useWorldStore((s) => s.doc.settings.simulation.interactions?.enabled ?? true);
  if (!events.length) return null;
  const label = (m: (typeof milestones)[number]) => {
    if (m.kind === 'start' || m.kind === 'end') {
      const def = phenomena.get(m.subject ?? '');
      return `${def ? t(def.labelKey) : m.subject} ${t(`milestone.${m.kind}`)}`;
    }
    // The milestone's own parameters (id, values) — they were dropped, leaving '{id}' in Phase 23 labels.
    return t(`milestone.${m.kind}` as MessageKey, { ...m.label.params, hazard: m.hazard ? t(`hazardName.${m.hazard}` as MessageKey) : '', ha: (m.label.params?.ha as number) ?? '' });
  };
  return (
    <div className={styles.box} data-testid="experiment-results">
      <div className={styles.boxTitle}>{t('results.exp.title')} · {t(interactions ? 'exp.cmp.interactionsOn' : 'exp.cmp.interactionsOff')}</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', fontSize: 11.5, maxHeight: 150, overflow: 'auto' }}>
          {milestones.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <span className="mono" style={{ width: 54, textAlign: 'right', color: 'var(--text-2)' }}>{m.time.toFixed(1)} s</span>
              <span style={{ color: m.hazard === 'flood' ? '#9fd3ff' : m.hazard === 'earthquake' ? '#ffb3a1' : m.hazard === 'wind' ? '#f5a13b' : undefined }}>{label(m)}</span>
            </div>
          ))}
        </div>
        <div style={{ flex: '1 1 320px' }}>
          <div className={styles.cardSub}>{t('results.exp.models')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {modelsUsed(events.map((e) => e.type), interactions).map((id) => <ModelBadge key={id} id={id} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Full collapse sequences of every building with a collapse model (Phase 25): one row per member failure. */
function collapseSequences() {
  const rt = simulationController.getRuntime();
  const out: Record<string, { time: number; member: string; type: string; cause: string; trigger: string | null; root: string; depth: number; round: number; hazard: string; u: number; striker?: string }[]> = {};
  for (const e of rt?.structures?.all ?? []) {
    const m = e.modular!.structure!.model;
    const ids = e.modular!.design.members;
    out[e.id] = m.records.map((r) => ({
      time: +r.time.toFixed(4), member: ids[r.i].id, type: ids[r.i].type, cause: r.cause, trigger: r.trigger >= 0 ? ids[r.trigger].id : null, root: ids[r.root].id,
      depth: r.depth, round: r.round, hazard: r.hazard || 'original', u: +r.u.toFixed(4), ...(r.secondary ? { striker: r.secondary.striker } : {}),
    }));
  }
  return out;
}

/** Structural destruction results (Phase 25): building collapse classes, members, debris, roads, secondary damage. */
function StructureSummary({ t, name }: { t: TFunction; name: string }) {
  const s = useSimStore((x) => x.structure);
  if (!s || s.models === 0) return null;
  const debris = s.mass.bodies + s.mass.rubble + s.mass.resting + s.mass.fines + s.mass.left;
  const exportSequence = () => {
    const seq = collapseSequences();
    const rows = Object.entries(seq).flatMap(([id, list]) => list.map((r) => [id, r.time, r.member, r.type, r.cause, r.trigger ?? '', r.root, r.depth, r.round, r.hazard, r.u, r.striker ?? ''].join(',')));
    download(`${name || 'simulation'}-collapse-sequence.csv`, ['building,time_s,member,type,cause,trigger,root,depth,round,primary_hazard,utilization,striker', ...rows].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="structure-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.struct.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportSequence}><Icon name="save" size={13} /> {t('results.struct.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.struct.damaged')} value={String(s.damaged + s.local)} sub={`${t('struct.level.local')} ${s.local}`} />
        <Card label={t('results.struct.partial')} value={String(s.partial)} />
        <Card label={t('results.struct.global')} value={String(s.global)} />
        <Card label={t('results.struct.members')} value={String(s.failedMembers)} sub={`${t('struct.connectionsFailed')} ${s.connectionsFailed}`} />
        <Card label={t('results.struct.debris')} value={fmt(debris / 1000, 1)} unit="t" sub={t('results.struct.debrisSub', { bodies: fmt(s.mass.bodies / 1000, 1), rubble: fmt(s.mass.rubble / 1000, 1), resting: fmt(s.mass.resting / 1000, 1) })} />
        <Card label={t('results.struct.roads')} value={String(s.roadsBlocked)} />
        <Card label={t('results.struct.secondary')} value={String(s.secondary)} />
        <Card label={t('results.struct.residual')} value={s.residual.toExponential(1)} unit="kg" sub={t('results.struct.residualSub')} />
      </div>
    </div>
  );
}

/** Thermal state of every heated member (Phase 26): temperatures, strength factor, thermal force. */
function thermalMembers() {
  const rt = simulationController.getEnvironment().thermal.rt;
  if (!rt) return [];
  const B = rt.world.bodies;
  const out: { building: string; member: string; type: string; material: string; T_skin_C: number; T_core_C: number; T_max_C: number; factor: number; thermalForce_kN: number; utilization: number; restraint: number; freeStrain: number }[] = [];
  for (const bt of rt.buildings) {
    const ids = bt.e.modular!.design.members;
    for (let i = 0; i < bt.g.n; i++) {
      const b = bt.body[i];
      if (b < 0 || Math.max(B.TmaxS[b], B.TmaxC[b]) - rt.world.Tref < 1) continue;
      out.push({
        building: bt.e.id, member: ids[i].id, type: ids[i].type, material: THERMAL_MATERIAL_IDS[bt.tmat[i]],
        T_skin_C: +(B.TS[b] - 273.15).toFixed(2), T_core_C: +(B.TC[b] - 273.15).toFixed(2), T_max_C: +(Math.max(B.TmaxS[b], B.TmaxC[b]) - 273.15).toFixed(2),
        factor: +bt.fApplied[i].toFixed(4), thermalForce_kN: +(bt.nApplied[i] / 1000).toFixed(2), utilization: +bt.util[i].toFixed(3), restraint: +bt.restraint[i].toFixed(5), freeStrain: +bt.strain[i].toExponential(4),
      });
    }
  }
  return out;
}

function ThermalSummary({ t, name }: { t: TFunction; name: string }) {
  const s = useSimStore((x) => x.thermal);
  if (!s) return null;
  const C = (K: number) => fmt(K - 273.15, 1);
  const exportCsv = () => {
    const ledger = [
      ['added_sources_J', s.added], ['boundary_supply_J', s.boundarySupply], ['impact_deposit_J', s.impactDeposit],
      ...Object.entries(s.losses).map(([k, v]) => [`lost_${k}_J`, v]), ['lost_total_J', s.lost], ['internal_final_J', s.internal], ['residual_J', s.residual],
      ...Object.entries(s.transfers).map(([k, v]) => [`transfer_${k}_J`, v]),
    ].map(([k, v]) => `${k},${v}`);
    const head = 'building,member,type,material,T_skin_C,T_core_C,T_max_C,strength_factor,thermal_force_kN,utilization,restraint,free_strain';
    const rows = thermalMembers().map((r) => [r.building, r.member, r.type, r.material, r.T_skin_C, r.T_core_C, r.T_max_C, r.factor, r.thermalForce_kN, r.utilization, r.restraint, r.freeStrain].join(','));
    download(`${name || 'simulation'}-thermal.csv`, ['# thermal energy ledger (J, sensible heat above the ambient reference)', 'quantity,value', ...ledger, '', '# heated members', head, ...rows].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="thermal-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.thermal.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="thermal-csv"><Icon name="save" size={13} /> {t('results.thermal.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.thermal.max')} value={C(s.maxT)} unit="°C" sub={t(`thermal.where.${s.maxWhere}` as MessageKey)} />
        <Card label={t('results.thermal.mean')} value={C(s.meanHeatedT)} unit="°C" sub={t('results.thermal.meanSub', { amb: C(s.ambient) })} />
        <Card label={t('results.thermal.area')} value={fmt(s.heatedArea, 0)} unit="m²" />
        <Card label={t('results.thermal.added')} value={energyText(s.added + s.boundarySupply + s.impactDeposit)} sub={t('results.thermal.addedSub', { s: energyText(s.added), b: energyText(s.boundarySupply), i: energyText(s.impactDeposit) })} />
        <Card label={t('results.thermal.lost')} value={energyText(s.lost)} sub={t('results.thermal.lostSub', { r: energyText(s.losses.radiationSky + s.losses.unresolvedRadiation), a: energyText(s.losses.atmosphere + s.losses.airAdvection + s.losses.aboveLayer), g: energyText(s.losses.deepGround) })} />
        <Card label={t('results.thermal.residual')} value={s.residual.toExponential(1)} unit="J" sub={t('results.thermal.residualSub', { pct: (s.relativeResidual * 100).toExponential(1) })} />
        <Card label={t('results.thermal.damaged')} value={String(s.damagedStructures)} sub={t('results.thermal.damagedSub', { f: fmt(s.minFactor * 100, 0), n: s.failedMembers })} />
        <Card label={t('results.thermal.flux')} value={fmt(s.maxFlux / 1000, 2)} unit="kW/m²" />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.thermal.note')}</div>
    </div>
  );
}
