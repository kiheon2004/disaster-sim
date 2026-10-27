import { useMemo } from 'react';
import type { ComponentKind } from '@/core/model';
import type { EntityId } from '@/core/types';
import { useLocale, useT } from '@/i18n/i18n';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { DAMAGE_STATE_COLORS, DamageState } from '@/simulation/damage/DamageState';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { focusObject } from '@/app/actions';
import { Section } from '@/ui/common/Panel';
import { StateBadge, StateDot } from '@/ui/common/StateBadge';
import { fmt, formatLogEntry } from '@/ui/format';
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

/** Live physical/damage status of the selected entity. */
export function LiveStatusSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimTick();
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e) return null;
  const loadColor = e.loadRatio < 0.3 ? DAMAGE_STATE_COLORS[0] : e.loadRatio < 0.7 ? DAMAGE_STATE_COLORS[1] : e.loadRatio < 1 ? DAMAGE_STATE_COLORS[2] : DAMAGE_STATE_COLORS[3];
  const flags = Object.entries(e.flags).filter(([, v]) => v).map(([k]) => t(`flag.${k}` as Parameters<typeof t>[0]));
  const comps = KIND_ORDER.map((kind) => {
    const list = e.components.filter((c) => c.spec.kind === kind);
    return { kind, total: list.length, failed: list.filter((c) => c.condition !== 'intact').length };
  }).filter((r) => r.total > 0 && !(r.kind === 'canopy'));

  return (
    <Section title={t('live.title')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StateBadge state={e.state} />
        {flags.length > 0 && <span style={{ color: 'var(--text-1)', fontSize: 12 }}>{flags.join(' · ')}</span>}
      </div>
      <div className={styles.liveGrid}>
        <span>{t('live.health')}</span><span>{fmt(e.health * 100, 0)} %</span>
      </div>
      <Meter value={e.health} color={e.health > 0.6 ? 'var(--ok)' : e.health > 0.3 ? 'var(--warn)' : 'var(--danger)'} />
      <div className={styles.liveGrid}>
        <span>{t('live.loadRatio')}</span><span>{fmt(e.loadRatio, 2)} ({t('live.peak')} {fmt(e.peakLoadRatio, 2)})</span>
      </div>
      <Meter value={e.loadRatio / 1.5} color={loadColor} />
      <div className={styles.liveGrid}>
        <span>{t('live.windAtCop')}</span><span>{fmt(e.windAtCop, 1)} m/s</span>
        <span>{t('physics.windResistance')}</span><span>{fmt(e.source.physics.windResistance, 0)} m/s</span>
        {e.dynamic && (<><span>{t('live.displacement')}</span><span>{fmt(e.displacement, 2)} m</span></>)}
        {comps.map((r) => (
          <FragmentPair key={r.kind} a={t(`component.${r.kind}`)} b={`${r.failed} / ${r.total}`} />
        ))}
      </div>
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
          {reversed.slice(0, 120).map((l, i) => (
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
