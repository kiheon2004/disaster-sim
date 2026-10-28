import { useMemo } from 'react';
import type { ComponentKind } from '@/core/model';
import type { EntityId } from '@/core/types';
import { useLocale, useT } from '@/i18n/i18n';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { DAMAGE_STATE_COLORS, DamageState } from '@/simulation/damage/DamageState';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { focusObject, toggleFollow } from '@/app/actions';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { StateBadge, StateDot } from '@/ui/common/StateBadge';
import { displayName, fmt, formatLogEntry } from '@/ui/format';
import styles from './Inspector.module.css';

/** Re-render at the store publish rate (≈10 Hz) while simulating. */
function useSimTick() {
  return useSimStore((s) => s.time);
}

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className={styles.meter}>
      <div className={styles.meterFill} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </div>
  );
}

const KIND_ORDER: ComponentKind[] = ['window', 'sign', 'roof', 'wall', 'exterior', 'canopy'];

/** Live physical/damage status of the selected entity (read from the runtime at ~10 Hz). */
export function LiveStatusSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimTick();
  const followId = useViewStore((s) => s.followId);
  const objects = useWorldStore((s) => s.doc.objects);
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e) return null;
  const lw = e.localWind;
  const loadColor = e.loadRatio < 0.3 ? DAMAGE_STATE_COLORS[0] : e.loadRatio < 0.7 ? DAMAGE_STATE_COLORS[1] : e.loadRatio < 1 ? DAMAGE_STATE_COLORS[2] : DAMAGE_STATE_COLORS[3];
  const flags = Object.entries(e.flags).filter(([, v]) => v).map(([k]) => t(`flag.${k}` as Parameters<typeof t>[0]));
  const comps = KIND_ORDER.map((kind) => {
    const list = e.components.filter((c) => c.spec.kind === kind);
    return { kind, total: list.length, failed: list.filter((c) => c.condition !== 'intact').length };
  }).filter((r) => r.total > 0 && !(r.kind === 'canopy'));
  const design = e.source.physics.windResistance * e.strength;
  const instant = design * Math.sqrt(e.source.physics.breakThreshold);
  const ratio = lw.freeStream > 0.1 ? lw.speed / lw.freeStream : 1;
  const source = lw.shadowSource ? objects[lw.shadowSource] : undefined;

  // Why does local wind differ from the free stream?
  const reasons: string[] = [];
  if (source && ratio < 0.97) reasons.push(t('live.reason.shadow', { name: displayName(source, t), pct: Math.round((1 - ratio) * 100) }));
  if (lw.corner && ratio > 1.02) reasons.push(t('live.reason.corner', { pct: Math.round((ratio - 1) * 100) }));
  if (lw.turbulence > 0.05) reasons.push(t('live.reason.turbulence', { pct: Math.round(lw.turbulence * 100) }));
  if (e.localWind.global > 0.5 && reasons.length === 0) reasons.push(t('live.reason.open'));

  return (
    <Section title={t('live.title')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StateBadge state={e.state} />
        {flags.length > 0 && <span style={{ color: 'var(--text-1)', fontSize: 12 }}>{flags.join(' · ')}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className={styles.smallBtn} onClick={() => focusObject(id)}>{t('live.focus')}</button>
        <button className={`${styles.smallBtn} ${followId === id ? styles.smallBtnOn : ''}`} aria-pressed={followId === id} onClick={() => toggleFollow(id)}>
          {t(followId === id ? 'live.following' : 'live.follow')}
        </button>
      </div>
      <div className={styles.liveGrid}>
        <span>{t('live.globalWind')}</span><span>{fmt(lw.global, 1)} m/s</span>
        <span>{t('live.localWind')}</span><span>{fmt(lw.speed, 1)} m/s</span>
        <span>{t('live.freeStream')}</span><span>{fmt(lw.freeStream, 1)} m/s</span>
      </div>
      {reasons.map((r) => (
        <div key={r} className={styles.reason}>{r}</div>
      ))}
      <div className={styles.liveGrid}>
        <span>{t('live.windLoad')}</span><span>{fmt(e.windLoad / 1000, 2)} kN</span>
        <span>{t('live.damage')}</span><span>{fmt((1 - e.health) * 100, 0)} %</span>
      </div>
      <Meter value={1 - e.health} color={e.health > 0.6 ? 'var(--warn)' : 'var(--danger)'} />
      <div className={styles.liveGrid}>
        <span>{t('live.loadRatio')}</span><span>{fmt(e.loadRatio, 2)} ({t('live.peak')} {fmt(e.peakLoadRatio, 2)})</span>
      </div>
      <Meter value={e.loadRatio / 1.5} color={loadColor} />
      <div className={styles.liveGrid}>
        <span>{t('live.threshold')}</span><span>{fmt(design, 0)} m/s</span>
        <span>{t('live.instantThreshold')}</span><span>{fmt(instant, 0)} m/s</span>
        <span>{t('live.cause')}</span><span>{e.lastCause ? t(`cause.${e.lastCause}`) : '–'}</span>
        {e.dynamic && (<><span>{t('live.displacement')}</span><span>{fmt(e.displacement, 2)} m</span></>)}
        {comps.map((r) => (
          <FragmentPair key={r.kind} a={t(`component.${r.kind}`)} b={`${r.failed} / ${r.total}`} />
        ))}
      </div>
      <div className={styles.note}>{t('live.thresholdNote')}</div>
    </Section>
  );
}

function FragmentPair({ a, b }: { a: string; b: string }) {
  return (<><span>{a}</span><span>{b}</span></>);
}

/** Simulation overview shown when nothing is selected. */
export function SimSummary() {
  const t = useT();
  const locale = useLocale();
  const stats = useSimStore((s) => s.stats);
  const log = useSimStore((s) => s.log);
  const objects = useWorldStore((s) => s.doc.objects);
  const reversed = useMemo(() => log.slice().reverse(), [log]);
  const total = stats.byState.reduce((a, b) => a + b, 0);

  return (
    <>
      <Section title={t('sim.summary')}>
        <div className={styles.liveGrid}>
          {([0, 1, 2, 3, 4] as DamageState[]).map((s) => (
            <FragmentState key={s} state={s} n={stats.byState[s]} total={total} />
          ))}
        </div>
        <div className={styles.liveGrid} style={{ marginTop: 6 }}>
          <span>{t('sim.stat.fallenPeople')}</span><span>{stats.fallenPeople}</span>
          <span>{t('sim.stat.fallenTrees')}</span><span>{stats.fallenTrees}</span>
          <span>{t('sim.stat.movedCars')}</span><span>{stats.movedCars}</span>
          <span>{t('sim.stat.brokenWindows')}</span><span>{stats.brokenWindows}</span>
          <span>{t('sim.stat.detachedParts')}</span><span>{stats.detachedParts}</span>
          <span>{t('sim.stat.debris')}</span><span>{stats.debris}</span>
        </div>
      </Section>
      <Section title={t('sim.log')} aside={log.length}>
        {reversed.length === 0 && <div className={styles.note}>{t('sim.log.empty')}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {reversed.slice(0, 60).map((l, i) => (
            <button
              key={`${l.time}-${i}`}
              onClick={() => l.entityId && objects[l.entityId] && (useEditorStore.getState().select(l.entityId), focusObject(l.entityId))}
              style={{ display: 'grid', gridTemplateColumns: '44px 1fr', gap: 6, textAlign: 'left', background: 'transparent', border: 'none', padding: '3px 2px', fontSize: 11.5, color: l.severity === 'danger' ? '#ff9a8a' : l.severity === 'warn' ? 'var(--warn)' : 'var(--text-1)' }}
            >
              <span className="mono" style={{ color: 'var(--text-3)' }}>{l.time.toFixed(1)}s</span>
              <span>{formatLogEntry(locale, l, objects)}</span>
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}

function FragmentState({ state, n, total }: { state: DamageState; n: number; total: number }) {
  const t = useT();
  return (
    <>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><StateDot state={state} /> {t(`damage.${['NORMAL', 'STRESSED', 'DAMAGED', 'CRITICAL', 'DESTROYED'][state]}` as Parameters<typeof t>[0])}</span>
      <span>{n}{total ? ` (${Math.round((n / total) * 100)}%)` : ''}</span>
    </>
  );
}
