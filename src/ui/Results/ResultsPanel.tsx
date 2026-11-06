import { energyText } from '@/thermal/units';
import { MS } from '@/structure/types';
import { THERMAL_MATERIAL_IDS } from '@/thermal/materials';
import { FIRE_STATES } from '@/fire/FireWorld';
import { FUEL_IDS } from '@/fire/materials';
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
import { CelestialSummary, celestialObjects } from './CelestialResults';
import { HumanSummary, humanResultsJson } from './HumanResults';
import { PhysiologySummary, physiologyResultsJson } from './PhysiologyResults';
import { VehicleSummary, vehicleResultsJson } from './VehicleResults';

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
      'failure', 'chain_trigger', 'chain_root', 'chain_depth', 'secondary_striker', 'secondary_source', 'secondary_member',
      'human_segment', 'human_impulse_Ns', 'human_dv_ms', 'human_decel_lower_bound_ms2', 'human_risk_index', 'human_level', 'human_partner', 'human_posture',
      'physio_kind', 'physio_from', 'physio_to', 'physio_value', 'physio_causes',
      // Phase 35 (appended — earlier columns keep their order): vehicle collision / rollover / damage / ejection / stall detail.
      'vehicle_kind', 'vehicle_partner', 'vehicle_partner_kind', 'vehicle_dv_ms', 'vehicle_closing_ms', 'vehicle_impulse_Ns', 'vehicle_energy_J', 'vehicle_level'];
    const rows = events.map((e) => [
      e.time.toFixed(2), e.objectId, objects[e.objectId] ? displayName(objects[e.objectId], t) : '', e.objectType, e.componentId ?? '', e.eventType, e.cause,
      ...e.worldPosition.map((v) => v.toFixed(2)), e.localWindSpeed.toFixed(2), e.globalWindSpeed.toFixed(2), e.force.toFixed(0),
      e.damageBefore.toFixed(3), e.damageAfter.toFixed(3), e.shadowSource ?? '',
      e.hazard, (e.groundAcceleration / 9.81).toFixed(3), e.response.toFixed(4),
      (e.waterDepth ?? 0).toFixed(3), (e.flowSpeed ?? 0).toFixed(3), (e.exposure ?? 0).toFixed(1), DAMAGE_STATE_IDS[e.state ?? 0] ?? '',
      e.origin ?? e.hazard, ...(['wind', 'earthquake', 'flood', 'ground'] as const).map((h) => (e.contributors?.[h] ?? 0).toFixed(3)), e.source ?? '',
      e.failure ?? '', e.chain?.trigger ?? '', e.chain?.root ?? '', e.chain?.depth ?? '', e.secondary?.striker ?? '', e.secondary?.source ?? '', e.secondary?.member ?? '',
      e.human?.segment ?? '', e.human?.impulse?.toFixed(2) ?? '', e.human?.dv?.toFixed(3) ?? '', e.human?.decel?.toFixed(1) ?? '', e.human?.index?.toFixed(3) ?? '', e.human?.level ?? '', e.human?.partner ?? '', e.human?.posture ?? '',
      e.physio?.kind ?? '', e.physio?.from ?? '', e.physio?.to ?? '', e.physio && Number.isFinite(e.physio.value) ? +e.physio.value.toPrecision(6) : '', e.physio?.causes ?? '',
      e.vehicle?.kind ?? '', e.vehicle?.partner ?? '', e.vehicle?.partnerKind ?? '', ...[e.vehicle?.dv, e.vehicle?.closing, e.vehicle?.impulse, e.vehicle?.energy].map((x) => (x !== undefined && Number.isFinite(x) ? +x.toPrecision(6) : '')), e.vehicle?.level ?? '',
    ].map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','));
    download(`${name || 'simulation'}-damage-events.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  };
  const exportJson = () => download(`${name || 'simulation'}-results.json`, JSON.stringify({
    model: 'approximate', groundMotion: metrics?.earthquake ? 'synthetic' : undefined,
    floodModel: metrics?.flood ? 'local-inertial shallow-water approximation (educational, not a validated hydraulic model)' : undefined,
    metrics, seismicSeries: series ?? undefined, floodSeries: floodSeries ?? undefined, events,
    structure: useSimStore.getState().structure ?? undefined, collapseSequences: collapseSequences(),
    thermal: useSimStore.getState().thermal ?? undefined, thermalMembers: thermalMembers(),
    fire: useSimStore.getState().fire ?? undefined, fireItems: fireItems(),
    volcano: useSimStore.getState().volcano ?? undefined, volcanoRoads: volcanoRoads(),
    atmosphere: useSimStore.getState().atmosphere ?? undefined,
    climate: useSimStore.getState().climate ?? undefined, climateObjects: climateObjects(), climateRoads: climateRoads(),
    gravity: useSimStore.getState().gravity ?? undefined, gravityObjects: gravityObjects(), gravityBuildings: gravityBuildings(),
    celestial: useSimStore.getState().celestial ? { ...useSimStore.getState().celestial, model: 'Newtonian softened point masses (real G); educational capture radius; no general relativity', units: { mass: 'kg', length: 'm', time: 's', energy: 'J', impulse: 'N·s' } } : undefined, celestialObjects: celestialObjects(),
    humans: humanResultsJson(),
    physiology: physiologyResultsJson(),
    vehicles: vehicleResultsJson(),
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
          <VolcanoSummary t={t} name={name} />
          <AtmosphereSummary t={t} name={name} />
          <GravitySummary t={t} name={name} />
          <CelestialSummary t={t} name={name} />
          <HumanSummary t={t} name={name} />
          <PhysiologySummary t={t} name={name} />
          <VehicleSummary t={t} name={name} />
          <ClimateSummary t={t} name={name} />
          <FireSummary t={t} name={name} />
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

/** Road segments reached by the volcano (Phase 28). */
function volcanoRoads() {
  const segs = simulationController.getRuntime()?.roads?.segments ?? [];
  return segs.filter((s) => s.volcanic).map((s) => ({ segment: s.id, status: s.status, lava_m: +s.volcanic!.peakLava.toFixed(3), deposit_m: +s.volcanic!.deposit.toFixed(3), ash_m: +s.volcanic!.ash.toFixed(4), peakSurface_C: +(s.volcanic!.peakT > 0 ? s.volcanic!.peakT - 273.15 : 0).toFixed(0), blocked: s.volcanic!.blocked, impassable: s.volcanic!.impassable }));
}

/** Objects with a volcano state (Phase 28). */
function volcanoObjects() {
  const out: { object: string; type: string; lava_m: number; peakLava_m: number; deposit_m: number; loadRatio: number; damage: number; contact_s: number; buried: boolean; held: boolean; ash_kg: number; ashLoad_kPa: number; bombs: number }[] = [];
  for (const e of simulationController.getRuntime()?.entities.values() ?? []) {
    const v = e.volcano;
    if (!v) continue;
    out.push({ object: e.id, type: e.source.type, lava_m: +v.lava.toFixed(3), peakLava_m: +v.peakLava.toFixed(3), deposit_m: +v.deposit.toFixed(3), loadRatio: +v.ratio.toFixed(3), damage: +v.damage.toFixed(3), contact_s: +v.contact.toFixed(1), buried: v.noted.has('buried'), held: v.held, ash_kg: +v.ash.toFixed(1), ashLoad_kPa: +v.ashLoad.toFixed(3), bombs: v.bombs });
  }
  return out;
}

function VolcanoSummary({ t, name }: { t: TFunction; name: string }) {
  const s = useSimStore((x) => x.volcano);
  if (!s) return null;
  const M = s.ledger.mass, E = s.ledger.energy;
  const exportCsv = () => {
    const mass = Object.entries(M).map(([k, v]) => `mass.${k},${v}`);
    const energy = Object.entries(E).map(([k, v]) => `energy.${k},${v}`);
    const obj = volcanoObjects();
    const roads = volcanoRoads();
    download(`${name || 'simulation'}-volcano.csv`, [
      '# volcano ledgers (kg, J)', 'quantity,value', ...mass, ...energy, `thermal.volcanic,${s.thermalVolcanic}`, '',
      '# eruptions', 'id,name,start_s,phase,supplied_kg,rejected', ...s.eruptions.map((e) => [e.id, e.name, e.start.toFixed(1), e.phase, e.supplied.toFixed(0), e.reason ?? ''].join(',')), '',
      '# objects', 'object,type,lava_m,peakLava_m,deposit_m,loadRatio,damage,contact_s,buried,held,ash_kg,ashLoad_kPa,bombs', ...obj.map((o) => Object.values(o).join(',')), '',
      '# roads', 'segment,status,lava_m,deposit_m,ash_m,peakSurface_C,blocked,impassable', ...roads.map((r) => Object.values(r).join(',')),
    ].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="volcano-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.volcano.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="volcano-csv"><Icon name="save" size={13} /> {t('results.volcano.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.volcano.supplied')} value={fmt(M.supplied / 1000, 0)} unit="t" sub={t('results.volcano.suppliedSub', { l: fmt(M.lavaSupplied / 1000, 0), b: fmt(M.bombsLaunched / 1000, 1), a: fmt(M.ashReleased / 1000, 1) })} />
        <Card label={t('results.volcano.solid')} value={fmt(M.solidified / 1000, 0)} unit="t" sub={t('results.volcano.solidSub', { A: fmt(s.depositArea, 0), h: fmt(s.maxDeposit, 2) })} />
        <Card label={t('results.volcano.mobile')} value={fmt(M.mobile / 1000, 0)} unit="t" sub={t('results.volcano.mobileSub', { out: fmt(M.outLava / 1000, 1) })} />
        <Card label={t('results.volcano.ash')} value={fmt((M.ashDeposited + M.ashCaught) / 1000, 1)} unit="t" sub={t('results.volcano.ashSub', { r: fmt(M.ashCaught / 1000, 2), o: fmt(M.outAsh / 1000, 2), A: fmt(s.ashArea, 0) })} />
        <Card label={t('results.volcano.heat')} value={energyText(E.toGround + E.toObjects + E.toWater + E.toAir + E.radiated)} sub={t('results.volcano.heatSub', { g: energyText(E.toGround), o: energyText(E.toObjects), w: energyText(E.toWater) })} />
        <Card label={t('results.volcano.latent')} value={energyText(E.latentReleased)} sub={t('results.volcano.latentSub', { p: energyText(E.plumeHeat) })} />
        <Card label={t('results.volcano.objects')} value={String(s.objects.contact)} sub={t('results.volcano.objectsSub', { b: s.objects.buried, h: s.objects.held, d: s.objects.damaged, r: s.roads.blocked })} />
        <Card label={t('results.volcano.residual')} value={(M.residual / Math.max(1, M.supplied)).toExponential(1)} sub={t('results.volcano.residualSub', { e: (E.residual / Math.max(1, E.supplied)).toExponential(1) })} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.volcano.note')}</div>
    </div>
  );
}

/** Atmosphere experiment results (Phase 29): cards, CSV (ledgers, history), the JSON carries the live summary. */
function AtmosphereSummary({ t, name }: { t: TFunction; name: string }) {
  const a = useSimStore((x) => x.atmosphere);
  if (!a) return null;
  const s = a.stats, M = a.mass, E = a.energy, O = a.oxygen, G = a.gas, P = a.momentum;
  const kt = (kg: number) => fmt(kg / 1e6, 2);
  const exportCsv = () => {
    const rows = (pre: string, o: object) => Object.entries(o).map(([k, v]) => `${pre}.${k},${v}`);
    download(`${name || 'simulation'}-atmosphere.csv`, [
      '# atmosphere reference state', 'quantity,value', `p0_Pa,${a.p0}`, `T0_K,${a.T0}`, `rho0_kgm3,${a.rho0}`, `altitude_m,${a.spec.altitude}`, `boundary,${a.spec.boundary}`, `removal,${a.spec.removal}`, `extent,${a.spec.extent ?? 'uniform'}`, `restore,${a.spec.restore ?? 'none'}`, '',
      '# ledgers (kg, J, kg·m/s)', 'quantity,value', ...rows('mass', M), ...rows('energy', E), ...rows('oxygen', O), ...rows('gas', G), ...rows('momentum', P), `thermal.airMass,${a.thermalAirMass}`, '',
      '# state now', 'quantity,value', ...rows('stats', s), '',
      '# history', 't_s,datumPressure_Pa,minPressure_Pa,minDensity_kgm3,massShare,maxFlow_ms,meanLayerT_K,layerO2_kg', ...a.series.map((r) => [r.t.toFixed(1), r.p.toFixed(3), r.pMin.toFixed(3), r.rho.toFixed(5), r.share.toFixed(6), r.v.toFixed(4), r.T.toFixed(3), r.o2.toFixed(3)].join(',')),
    ].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="atmos-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.atmos.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="atmos-csv"><Icon name="save" size={13} /> {t('results.atmos.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.atmos.pressure')} value={fmt(s.datumPressure / 1000, 2)} unit="kPa" sub={t('results.atmos.pressureSub', { p0: fmt(a.p0 / 1000, 2), min: fmt(s.minPressure / 1000, 3) })} />
        <Card label={t('results.atmos.mass')} value={kt(s.mass)} unit="kt" sub={t('results.atmos.massSub', { r: kt(M.removed), s: kt(M.restored), i: kt(M.boundaryIn), o: kt(M.boundaryOut) })} />
        <Card label={t('results.atmos.density')} value={fmt(s.minDensity, 3)} unit="kg/m³" sub={t('results.atmos.densitySub', { r0: fmt(a.rho0, 3), m: fmt(s.meanDensity, 3) })} />
        <Card label={t('results.atmos.flow')} value={fmt(s.peakSpeed, 2)} unit="m/s" sub={t('results.atmos.flowSub', { t: fmt(s.peakSpeedTime, 0) })} />
        <Card label={t('results.atmos.temp')} value={fmt(s.meanLayerT - 273.15, 1)} unit="°C" sub={t('results.atmos.tempSub', { a: fmt(s.Tcol - 273.15, 1), T0: fmt(a.T0 - 273.15, 1) })} />
        <Card label={t('results.atmos.energy')} value={energyText(E.removed)} sub={t('results.atmos.energySub', { w: energyText(E.pressureWork), q: energyText(E.heatIn), r: energyText(E.restored) })} />
        <Card label={t('results.atmos.o2')} value={fmt(O.layer / 1000, 2)} unit="t" sub={t('results.atmos.o2Sub', { f: fmt(s.o2Fraction * 100, 1), n: s.o2LimitedEver })} />
        <Card label={t('results.atmos.residual')} value={s.massResidual.toExponential(1)} sub={t('results.atmos.residualSub', { e: s.energyResidual.toExponential(1) })} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.atmos.note')}</div>
    </div>
  );
}

/** Climate state of the road segments (Phase 30) for the JSON export (the CSV writes the same rows). */
function climateRoads() {
  const segs = simulationController.getRuntime()?.roads?.segments ?? [];
  return segs.filter((g) => g.climate).map((g) => ({ segment: g.id, state: g.climate!.state, snow_m: g.climate!.snow, ice_m: g.climate!.ice, film_m: g.climate!.film, surfaceT_C: g.climate!.surfaceT - 273.15, friction: g.climate!.friction, impassable: g.climate!.impassable }));
}

/** Units of the climate statistics in the CSV (the stats object mixes K, kg, m, rad, mm/h, counts). */
const CLIMATE_STAT_UNITS: Record<string, string> = {
  meanAirT: 'K', minAirT: 'K', maxAirT: 'K', meanSurfaceT: 'K', minSurfaceT: 'K', maxSurfaceT: 'K', meanRH: '1', vapour: 'kg', condensate: 'kg', snowMass: 'kg', iceMass: 'kg', storeMass: 'kg',
  maxSnowDepth: 'm', meanSnowDepth: 'm', snowCells: 'cells', iceCells: 'cells', maxIce: 'm', frozenSoilCells: 'cells', frostDepth: 'm', meltwater: 'kg', evaporation: 'kg', evaporationRate: 'kg/s',
  precipRate: 'mm/h', boilingCells: 'cells', maxRoofLoad: 'kPa', roofsLoaded: 'count', roadsIcy: 'count', roadsSnow: 'count', roadsImpassable: 'count', treesBroken: 'count', waterResidual: 'relative',
  energyResidual: 'relative', thermalResidual: 'relative', sunElevation: 'rad', solar: 'W/m2', Tsky: 'K', bgT: 'K', bgRH: '1', freezeThaw: 'cycles', solidPrecip: 'kg', floorClamps: 'count', floorEnergy: 'J',
};

/** Snow / ice stores on objects and the roads' climate state (Phase 30) for the exports. */
function climateObjects() {
  const r = simulationController.getEnvironment().climate.rt;
  if (!r) return [];
  const cw = r.cw;
  const kinds = ['roof', 'crown', 'vehicle'];
  return r.stores.map((s) => {
    const st = cw.stores[s.k];
    return { object: s.e.id, type: s.e.source.type, store: kinds[st.kind], area_m2: +st.area.toFixed(2), mass_kg: +cw.sM[s.k].toFixed(3), ice_kg: +cw.sIce[s.k].toFixed(3), load_kPa: +((cw.sM[s.k] * simulationController.getEnvironment().gravity.downUniform(9.81)) / st.area / 1000).toFixed(4), T_C: +(cw.sT[s.k] - 273.15).toFixed(2), dropped: cw.sGone[s.k] === 1, broken: s.broken, structural: !!s.e.climate?.applied };
  });
}

/** Bodies under a gravity experiment (Phase 31): mass (constant), local g, weight, velocity — for the exports. */
function gravityObjects() {
  const env = simulationController.getEnvironment(), f = env.gravity.field, ph = simulationController.getPhysics();
  if (!f || !ph) return undefined;
  const g: [number, number, number] = [0, 0, 0];
  return [...(simulationController.getRuntime()?.entities.values() ?? [])].filter((e) => e.dynamic && e.body !== null).map((e) => {
    const p = e.pose.position;
    f.sample(p[0], p[1], p[2], g);
    const v = ph.getLinearVelocity(e.body!);
    const gm = Math.hypot(g[0], g[1], g[2]);
    return { object: e.id, type: e.source.type, mass_kg: e.source.physics.mass, gx: +g[0].toFixed(4), gy: +g[1].toFixed(4), gz: +g[2].toFixed(4), g_ms2: +gm.toFixed(4), weight_N: +(e.source.physics.mass * gm).toFixed(2), vx: +v[0].toFixed(4), vy: +v[1].toFixed(4), vz: +v[2].toFixed(4), x: +p[0].toFixed(3), y: +p[1].toFixed(3), z: +p[2].toFixed(3), cause: e.lastCause ?? '', hazard: e.lastHazard ?? '' };
  });
}

/** Modular buildings under a gravity experiment (Phase 31): structural gravity ratio, failed members (roof panels). */
function gravityBuildings() {
  if (!simulationController.getEnvironment().gravity.field) return undefined;
  const out: { building: string; ratio: number | 'unsupported'; members: number; failed: number; roofPanels: number; roofFailed: number; collapse: string }[] = [];
  for (const e of simulationController.getRuntime()?.entities.values() ?? []) {
    if (!e.modular) continue;
    const m = e.modular.structure?.model;
    if (!m) { out.push({ building: e.id, ratio: 1, members: e.modular.design.members.length, failed: 0, roofPanels: 0, roofFailed: 0, collapse: 'intact' }); continue; }
    let k = 0, c = 0, failed = 0, rp = 0, rf = 0;
    for (let i = 0; i < m.n; i++) {
      if (m.state[i] === MS.ABSENT) continue;
      k += m.s.kM[i]; c++;
      if (m.state[i] >= MS.FAILED) failed++;
      if (m.g.roofCap[i] > 0) { rp++; if (m.state[i] >= MS.FAILED) rf++; }
    }
    out.push({ building: e.id, ratio: c ? +(k / c).toFixed(4) : 1, members: c, failed, roofPanels: rp, roofFailed: rf, collapse: m.collapseLevel() });
  }
  return out;
}

/** Gravity experiment results (Phase 31): cards, CSV (field, ledgers, bodies, buildings, history); the JSON carries the live summary. */
function GravitySummary({ t, name }: { t: TFunction; name: string }) {
  const g = useSimStore((x) => x.gravity);
  if (!g) return null;
  const b = g.balance, s = g.stats;
  const exportCsv = () => {
    const num = (v: number) => (Number.isFinite(v) ? String(v) : 'unsupported');
    download(`${name || 'simulation'}-gravity.csv`, [
      '# gravity experiments (spec, SI units: m/s², s, m)', 'name,scenario,start_s,duration_s,end,global,sources', ...g.experiments.map((e) => [e.name, e.scenario, e.start, e.duration, e.end, e.global, e.sources].join(',')), '',
      '# field now', 'quantity,value,unit', `gx,${g.G[0]},m/s²`, `gy,${g.G[1]},m/s²`, `gz,${g.G[2]},m/s²`, `magnitude,${g.magnitude},m/s²`, `ratio,${g.ratio},g0`, `down,${g.down},m/s²`, `mode,${g.mode},`, `uniform,${g.uniform},`, `potentialDefined,${g.potentialDefined},`, `pressure,${g.pressure.value},Pa ${g.pressure.modelled ? 'model' : 'estimate'}`, '',
      '# model support', 'model,support', ...Object.entries(g.support).map(([k, v]) => `${k},${v}`), '',
      '# energy / momentum ledger of gravity on the bodies', 'quantity,value,unit', `kinetic,${b.kinetic},J`, `potential,${num(b.potential)},J`, `workGravity,${b.workGravity},J`, `workField,${num(b.workField)},J`, `workOther,${b.workOther},J`, `workMoved,${b.workMoved},J`, `integratorResidual,${b.integratorResidual},J`, `fieldResidual,${num(b.fieldResidual)},J`, `energyResidual,${num(b.energyResidual)},J`, `workGravityGross,${b.workGravityGross},J`, `boundaryKinetic,${b.boundaryKinetic},J`, `boundaryPotential,${b.boundaryPotential},J`, `boundaryEnergy,${b.boundaryEnergy},J`, `potentialGaps,${b.potentialGaps},`, `stepsWithPotential,${b.stepsWithPotential},`,
      `impulse,${b.impulse.join(';')},N·s`, `momentum,${b.momentum.join(';')},kg·m/s`, `impulseOther,${b.impulseOther.join(';')},N·s`, '',
      '# structures', 'building,ratio_g0,members,failed,roofPanels,roofFailed,collapse', ...(gravityBuildings() ?? []).map((r) => [r.building, r.ratio, r.members, r.failed, r.roofPanels, r.roofFailed, r.collapse].join(',')), '',
      '# bodies', 'object,type,mass_kg,gx,gy,gz,g_ms2,weight_N,vx,vy,vz,x,y,z,cause,hazard', ...(gravityObjects() ?? []).map((o) => Object.values(o).join(',')), '',
      '# history', 't_s,gx,gy,gz,magnitude,kinetic_J,potential_J,workGravity_J,workField_J,workOther_J,workMoved_J,integrator_J,energyResidual_J,px,py,pz,Jx,Jy,Jz,bodies,failedMembers',
      ...g.series.map((r) => [r.t.toFixed(2), r.gx.toFixed(4), r.gy.toFixed(4), r.gz.toFixed(4), r.magnitude.toFixed(4), r.kinetic.toFixed(2), num(r.potential), r.workGravity.toFixed(2), num(r.workField), r.workOther.toFixed(2), r.workMoved.toFixed(2), r.integrator.toFixed(4), num(r.energyResidual), r.px.toFixed(2), r.py.toFixed(2), r.pz.toFixed(2), r.jx.toFixed(2), r.jy.toFixed(2), r.jz.toFixed(2), r.bodies, r.failed].join(',')),
    ].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="gravity-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.gravity.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="gravity-csv"><Icon name="save" size={13} /> {t('results.gravity.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.gravity.field')} value={fmt(g.magnitude, 2)} unit="m/s²" sub={t('results.gravity.fieldSub', { x: fmt(g.ratio, 2), m: t(`gravity.mode.${g.mode}` as MessageKey), lo: fmt(Number.isFinite(s.minimum) ? s.minimum : 0, 2), hi: fmt(s.peak, 2) })} />
        <Card label={t('results.gravity.bodies')} value={String(s.bodies)} sub={t('results.gravity.bodiesSub', { a: s.affected, w: s.wakes })} />
        <Card label={t('results.gravity.structures')} value={String(g.structures.failures)} sub={t('results.gravity.structuresSub', { n: g.structures.loaded, r: g.structures.roofFailures })} />
        <Card label={t('results.gravity.energy')} value={energyText(b.workGravity)} sub={t('results.gravity.energySub', { k: energyText(b.kinetic), f: Number.isFinite(b.workField) ? energyText(b.workField) : '—', o: energyText(b.workOther) })} />
        <Card label={t('results.gravity.momentum')} value={fmt(Math.hypot(...b.impulse) / 1000, 1)} unit="kN·s" sub={t('results.gravity.momentumSub', { o: fmt(Math.hypot(...b.impulseOther) / 1000, 1) })} />
        <Card label={t('results.gravity.residual')} value={Number.isFinite(b.fieldResidual) ? b.fieldResidual.toExponential(1) : '—'} unit="J" sub={t('results.gravity.residualSub', { e: Number.isFinite(b.energyResidual) ? b.energyResidual.toExponential(1) : '—', i: b.integratorResidual.toExponential(1), rel: b.workGravityGross > 0 && Number.isFinite(b.energyResidual) ? (Math.abs(b.energyResidual) / b.workGravityGross).toExponential(1) : '—' })} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.gravity.note')}</div>
    </div>
  );
}

/** Climate experiment results (Phase 30): cards, CSV (ledgers, stores, roads, history), the JSON carries the live summary. */
function ClimateSummary({ t, name }: { t: TFunction; name: string }) {
  const c = useSimStore((x) => x.climate);
  if (!c) return null;
  const s = c.stats, W = c.water, E = c.energy, Th = c.thermal;
  const tn = (kg: number) => fmt(kg / 1000, 2);
  const exportCsv = () => {
    const rows = (pre: string, o: object): string[] => Object.entries(o).flatMap(([k, v]): string[] => (typeof v === 'object' && v !== null ? rows(`${pre}.${k}`, v) : [`${pre}.${k},${v}`]));
    const roads = (simulationController.getRuntime()?.roads?.segments ?? []).filter((g) => g.climate).map((g) => [g.id, g.climate!.state, g.climate!.snow.toFixed(3), g.climate!.ice.toFixed(4), g.climate!.film.toFixed(4), (g.climate!.surfaceT - 273.15).toFixed(2), g.climate!.friction.toFixed(3), g.climate!.impassable].join(','));
    download(`${name || 'simulation'}-climate.csv`, [
      // The whole spec as given (SI: K, s, m, kg/m³, mm/h, 0–1; arrays as JSON) — every input the run used.
      '# climate experiment (spec, SI units)', 'quantity,value', ...Object.entries(c.spec).filter(([, v]) => v !== undefined).map(([k, v]) => `${k},${typeof v === 'object' ? JSON.stringify(v).replace(/,/g, ';') : v}`), '',
      '# water ledger (kg)', 'quantity,value', ...rows('water', W), '',
      '# energy ledger (J)', 'quantity,value', ...rows('energy', E), ...rows('thermal', Th), '',
      '# state now', 'quantity,value,unit', ...rows('stats', s).map((r) => `${r},${CLIMATE_STAT_UNITS[r.slice(6, r.indexOf(','))] ?? ''}`), ...rows('totals', c.totals).map((r) => `${r},kg`), '',
      '# object stores', 'object,type,store,area_m2,mass_kg,ice_kg,load_kPa,T_C,dropped,broken,structural', ...climateObjects().map((o) => [o.object, o.type, o.store, o.area_m2, o.mass_kg, o.ice_kg, o.load_kPa, o.T_C, o.dropped, o.broken, o.structural].join(',')), '',
      '# roads', 'segment,state,snow_m,ice_m,film_m,surfaceT_C,friction,impassable', ...roads, '',
      '# history', 't_s,meanAirT_K,meanSurfaceT_K,meanRH,snow_kg,ice_kg,meltwater_kg,evaporated_kg,precip_mmh', ...c.series.map((r) => [r.t.toFixed(1), r.T.toFixed(3), r.Ts.toFixed(3), r.rh.toFixed(4), r.snow.toFixed(2), r.ice.toFixed(2), r.melt.toFixed(2), r.evap.toFixed(3), r.P.toFixed(3)].join(',')),
    ].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="climate-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.climate.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="climate-csv"><Icon name="save" size={13} /> {t('results.climate.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.climate.air')} value={fmt(s.meanAirT - 273.15, 1)} unit="°C" sub={t('results.climate.airSub', { lo: fmt(s.minAirT - 273.15, 1), hi: fmt(s.maxAirT - 273.15, 1), rh: fmt(s.meanRH * 100, 0) })} />
        <Card label={t('results.climate.surface')} value={fmt(s.maxSurfaceT - 273.15, 1)} unit="°C" sub={t('results.climate.surfaceSub', { lo: fmt(s.minSurfaceT - 273.15, 1), m: fmt(s.meanSurfaceT - 273.15, 1) })} />
        <Card label={t('results.climate.snow')} value={tn(s.snowMass + s.storeMass)} unit="t" sub={t('results.climate.snowSub', { d: fmt(s.maxSnowDepth * 100, 1), f: tn(c.totals.snowfall), o: tn(s.storeMass) })} />
        <Card label={t('results.climate.ice')} value={tn(s.iceMass)} unit="t" sub={t('results.climate.iceSub', { h: fmt(s.maxIce * 100, 1), n: s.iceCells })} />
        <Card label={t('results.climate.melt')} value={fmt(s.meltwater / 1000, 2)} unit="m³" sub={t('results.climate.meltSub', { m: tn(c.totals.melt), e: tn(c.totals.evaporated) })} />
        <Card label={t('results.climate.loads')} value={fmt(s.maxRoofLoad, 2)} unit="kPa" sub={t('results.climate.loadsSub', { n: s.roofsLoaded, b: s.treesBroken, r: s.roadsIcy + s.roadsSnow })} />
        <Card label={t('results.climate.energy')} value={energyText(Th.latent)} sub={t('results.climate.energySub', { s: energyText(Th.solar + E.solar), f: energyText(Th.climate), lw: energyText(E.longwave) })} />
        <Card label={t('results.climate.residual')} value={s.waterResidual.toExponential(1)} sub={t('results.climate.residualSub', { e: s.energyResidual.toExponential(1), th: s.thermalResidual.toExponential(1) })} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.climate.note')}</div>
    </div>
  );
}

/** Every fuel item of the run (Phase 27): owner, kind, material, state, fuel, energy, peak heat release, char, ignition. */
function fireItems() {
  const fr = simulationController.getEnvironment().fire.rt;
  if (!fr) return [];
  const fw = fr.fw;
  const kinds = ['member', 'foliage', 'trunk', 'contents', 'heap'];
  const out: { object: string; kind: string; member: string; material: string; state: string; fuel0_kg: number; fuel_kg: number; released_MJ: number; peakHrr_kW: number; char_mm: number; ignited_s: number | null; cause: string }[] = [];
  for (let i = 0; i < fw.n; i++) {
    if (fw.m0[i] <= 0) continue;
    const bt = fw.kind[i] === 0 ? fr.trt.buildings[fw.ref[i]] : null;
    out.push({
      object: fr.owner[i], kind: kinds[fw.kind[i]] ?? '', member: bt ? bt.e.modular!.design.members[fw.sub[i]]?.id ?? String(fw.sub[i]) : fw.kind[i] === 3 ? `story ${fw.sub[i] + 1}` : '',
      material: FUEL_IDS[fw.mat[i]], state: FIRE_STATES[fw.state[i]], fuel0_kg: +fw.m0[i].toFixed(3), fuel_kg: +fw.m[i].toFixed(3), released_MJ: +(fw.E[i] / 1e6).toFixed(3),
      peakHrr_kW: +(fw.peak[i] / 1e3).toFixed(2), char_mm: +(fw.char[i] * 1000).toFixed(2), ignited_s: Number.isNaN(fw.tIgn[i]) ? null : +fw.tIgn[i].toFixed(2), cause: fr.cause[i],
    });
  }
  return out;
}

function FireSummary({ t, name }: { t: TFunction; name: string }) {
  const s = useSimStore((x) => x.fire);
  if (!s) return null;
  const L = s.ledger;
  const exportCsv = () => {
    const ledger = Object.entries(L).map(([k, v]) => `${k},${v}`);
    const items = fireItems();
    const head = 'object,kind,member,material,state,fuel0_kg,fuel_kg,released_MJ,peakHrr_kW,char_mm,ignited_s,cause';
    const rows = items.map((r) => [r.object, r.kind, r.member, r.material, r.state, r.fuel0_kg, r.fuel_kg, r.released_MJ, r.peakHrr_kW, r.char_mm, r.ignited_s ?? '', r.cause].join(','));
    const rooms = s.roomList.map((r) => [r.building, r.story + 1, (r.T - 273.15).toFixed(1), (r.o2 * 100).toFixed(2), (r.soot * 1000).toFixed(3), r.Ao.toFixed(2), (r.hrr / 1e3).toFixed(1), (r.hrrExt / 1e3).toFixed(1), Number.isNaN(r.flashover) ? '' : r.flashover.toFixed(1), r.open ? 1 : 0].join(','));
    download(`${name || 'simulation'}-fire.csv`, [
      '# fire ledgers (kg, J)', 'quantity,value', ...ledger, '',
      '# fuel items', head, ...rows, '',
      '# rooms', 'building,story,T_C,O2_mass_pct,soot_g_m3,openings_m2,hrr_inside_kW,hrr_outside_kW,flashover_s,open', ...rooms,
    ].join('\n'), 'text/csv');
  };
  return (
    <div className={styles.box} data-testid="fire-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.fire.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="fire-csv"><Icon name="save" size={13} /> {t('results.fire.csv')}</button>
      </div>
      <div className={styles.cards}>
        <Card label={t('results.fire.objects')} value={String(s.ignitedObjects)} sub={t('results.fire.objectsSub', { b: s.burningObjects, o: s.burnedOutObjects })} />
        <Card label={t('results.fire.consumed')} value={fmt(L.fuelConsumed, 0)} unit="kg" sub={t('results.fire.consumedSub', { pct: fmt(L.fuelRegistered > 0 ? (100 * L.fuelConsumed) / L.fuelRegistered : 0, 1) })} />
        <Card label={t('results.fire.released')} value={energyText(L.released)} sub={t('results.fire.releasedSub', { r: energyText(L.releasedRooms), o: energyText(L.releasedOutdoor), e: energyText(L.releasedExternal) })} />
        <Card label={t('results.fire.peak')} value={(s.peakHrr / 1e6).toFixed(2)} unit="MW" sub={t('results.fire.peakSub', { t: fmt(s.peakTime, 0) })} />
        <Card label={t('results.fire.roomT')} value={fmt(s.maxRoomT - 273.15, 0)} unit="°C" sub={t('results.fire.roomsSub', { f: s.flashovers, v: s.ventLimited })} />
        <Card label={t('results.fire.smoke')} value={fmt(L.smokeProduced, 1)} unit="kg" sub={Number.isFinite(s.minVisibility) ? t('results.fire.smokeSub', { S: fmt(s.minVisibility, 1) }) : t('results.fire.smokeClear')} />
        <Card label={t('results.fire.structure')} value={String(s.fireFailures)} sub={t('results.fire.structureSub', { c: s.charredMembers, w: s.windowsBroken, tr: s.treesBurned })} />
        <Card label={t('results.fire.residual')} value={L.chemResidual.toExponential(1)} unit="J" sub={t('results.fire.residualSub', { f: L.fuelResidual.toExponential(1), s: L.smokeResidual.toExponential(1) })} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.fire.note')}</div>
    </div>
  );
}

function ThermalSummary({ t, name }: { t: TFunction; name: string }) {
  const s = useSimStore((x) => x.thermal);
  if (!s) return null;
  const C = (K: number) => fmt(K - 273.15, 1);
  const exportCsv = () => {
    const ledger = [
      ['added_sources_J', s.added], ['boundary_supply_J', s.boundarySupply], ['impact_deposit_J', s.impactDeposit], ['combustion_J', s.combustion],
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
        <Card label={t('results.thermal.added')} value={energyText(s.added + s.boundarySupply + s.impactDeposit + s.combustion)} sub={t('results.thermal.addedSub', { s: energyText(s.added), b: energyText(s.boundarySupply), i: energyText(s.impactDeposit) }) + (s.combustion > 0 ? ` · ${t('results.thermal.combustion', { c: energyText(s.combustion) })}` : '')} />
        <Card label={t('results.thermal.lost')} value={energyText(s.lost)} sub={t('results.thermal.lostSub', { r: energyText(s.losses.radiationSky + s.losses.unresolvedRadiation), a: energyText(s.losses.atmosphere + s.losses.airAdvection + s.losses.aboveLayer), g: energyText(s.losses.deepGround) })} />
        <Card label={t('results.thermal.residual')} value={s.residual.toExponential(1)} unit="J" sub={t('results.thermal.residualSub', { pct: (s.relativeResidual * 100).toExponential(1) })} />
        <Card label={t('results.thermal.damaged')} value={String(s.damagedStructures)} sub={t('results.thermal.damagedSub', { f: fmt(s.minFactor * 100, 0), n: s.failedMembers })} />
        <Card label={t('results.thermal.flux')} value={fmt(s.maxFlux / 1000, 2)} unit="kW/m²" />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.thermal.note')}</div>
    </div>
  );
}
