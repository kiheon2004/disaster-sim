import { useMemo } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { WorldObject } from '@/core/model';
import { GRAVITY } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { samplerFor } from '@/terrain/TerrainSampler';
import { analysisOf, designExtent } from '@/buildings/design';
import { foundationContact } from '@/buildings/foundation';
import type { BuildingAnalysis } from '@/buildings/analysis';
import { chainPeriod } from '@/buildings/analysis';
import { MEMBER_TYPES } from '@/buildings/types';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { AnalysisRows, WarningList } from './AnalysisSummary';
import { StructureSection } from './StructureInspector';
import styles from './Building.module.css';

/** Building Inspector sections of a modular building (Phase 17). */
export function BuildingInspector({ obj }: { obj: WorldObject }) {
  const t = useT();
  const d = obj.building!;
  const a = analysisOf(d);
  const ext = designExtent(d);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of d.members) c[m.type] = (c[m.type] ?? 0) + 1;
    return c;
  }, [d]);
  const inSim = useEditorStore((s) => s.mode) === 'simulation';
  return (
    <>
      <Section title={t('building.inspector.overview')}>
        <div className={styles.summary} data-testid="building-overview">
          <span>{t('building.inspector.dimensions')}</span><span>{fmt(ext.width, 1)} × {fmt(ext.depth, 1)} × {fmt(ext.height + ext.roofHeight, 1)} m</span>
          <span>{t('building.field.floors')}</span><span>{d.spec.floors}</span>
          <span>{t('building.field.system')}</span><span>{t(`struct.system.${d.spec.system}` as MessageKey)}</span>
          <span>{t('building.field.structureMaterial')}</span><span>{t(`material.${d.spec.structureMaterial}` as MessageKey)}</span>
          <span>{t('building.field.slabMaterial')}</span><span>{t(`material.${d.spec.slabMaterial}` as MessageKey)}</span>
          <span>{t('building.field.claddingMaterial')}</span><span>{t(`material.${d.spec.claddingMaterial}` as MessageKey)}</span>
          <span>{t('building.inspector.members')}</span>
          <span>{MEMBER_TYPES.filter((k) => counts[k]).map((k) => `${t(`member.type.${k}` as MessageKey)} ${counts[k]}`).join(' · ')}</span>
        </div>
      </Section>
      <Section title={t('building.analysis')}>
        <AnalysisRows a={a} design={d} />
        <StoryTable a={a} />
      </Section>
      <FoundationSection obj={obj} a={a} />
      <Section title={t('building.inspector.loadPath')} defaultOpen={a.warnings.length > 0}>
        <div className={styles.summary}>
          <span>{t('building.inspector.supported')}</span><span>{d.members.length - a.unsupported.length} / {d.members.length}</span>
          <span>{t('building.inspector.maxUtil')}</span><span>{fmt(Math.max(0, ...a.members.map((m) => m.utilization)), 2)}</span>
          <span>{t('building.inspector.connections')}</span><span>{a.connections}</span>
        </div>
        <WarningList warnings={a.warnings} />
      </Section>
      {inSim && <LiveBuildingSection obj={obj} a={a} />}
      {inSim && <StructureSection obj={obj} />}
      <Section title={t('building.assumptions.title')} defaultOpen={false}>
        <ul className={styles.assumptions} data-testid="building-assumptions">
          {(['model', 'loadPath', 'stiffness', 'period', 'materials', 'damage', 'limits'] as const).map((k) => (
            <li key={k}>{t(`building.assumptions.${k}` as MessageKey)}</li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function StoryTable({ a }: { a: BuildingAnalysis }) {
  const t = useT();
  return (
    <table className={styles.compare} style={{ marginTop: 8 }} data-testid="story-table">
      <thead>
        <tr><th>{t('building.story')}</th><th>h m</th><th>k x/z MN/m</th><th>V x/z MN</th><th>θu %</th></tr>
      </thead>
      <tbody>
        {a.stories.slice().reverse().map((s) => (
          <tr key={s.index}>
            <td>{s.index + 1}</td>
            <td>{fmt(s.height, 1)}</td>
            <td>{fmt(s.kx / 1e6, 0)} / {fmt(s.kz / 1e6, 0)}</td>
            <td>{fmt(s.vx / 1e6, 1)} / {fmt(s.vz / 1e6, 1)}</td>
            <td>{fmt(s.driftU * 100, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FoundationSection({ obj, a }: { obj: WorldObject; a: BuildingAnalysis }) {
  const t = useT();
  const terrain = useWorldStore((s) => s.doc.terrain);
  const fc = useMemo(() => foundationContact(obj, samplerFor(terrain)), [obj, terrain]);
  const d = obj.building!;
  void a;
  const warn = fc.contact < 0.999 || fc.buried || fc.bearingRatio > 1;
  return (
    <Section title={t('building.foundationSection')} defaultOpen={warn}>
      <div className={styles.summary} data-testid="foundation-status">
        <span>{t('found.type')}</span><span>{t(`found.type.${d.spec.foundation}` as MessageKey)}</span>
        <span>{t('building.policy')}</span><span>{t(`building.policy.${d.options.foundationPolicy}` as MessageKey)}</span>
        <span>{t('building.found.contact')}</span><span>{fmt(fc.contact * 100, 0)} %</span>
        <span>{t('building.found.unsupported')}</span><span>{fmt(fc.unsupportedArea, 1)} m²</span>
        <span>{t('building.found.embed')}</span><span>{fmt(fc.embedMin, 2)} … {fmt(fc.embedMax, 2)} m</span>
        <span>{t('building.found.slope')}</span><span>{fmt(fc.slope, 1)}°</span>
        <span>{t('building.found.plinth')}</span><span>{fmt(fc.plinth, 2)} m</span>
        <span>{t('building.found.bearing')}</span><span>{fmt(fc.bearingRatio, 2)} ({fmt(fc.bearingCapacity, 0)} kPa)</span>
      </div>
      {fc.contact < 0.999 && <div className={`${styles.warn} ${styles.warning}`} style={{ marginTop: 6 }}>{t('building.found.gapWarn', { pct: fmt((1 - fc.contact) * 100, 0) })}</div>}
      {fc.buried && <div className={`${styles.warn} ${styles.warning}`} style={{ marginTop: 6 }}>{t('building.found.buriedWarn')}</div>}
      {fc.bearingRatio > 1 && <div className={`${styles.warn} ${styles.warning}`} style={{ marginTop: 6 }}>{t('building.found.bearingWarn')}</div>}
      <div className={styles.note} style={{ marginTop: 6 }}>{t(`building.policy.${d.options.foundationPolicy}.hint` as MessageKey)}</div>
    </Section>
  );
}

/**
 * Before / after: the original world's analysis next to the current simulation state
 * (failed members, remaining lateral strength, stiffness, period estimate, peak story drifts).
 */
function LiveBuildingSection({ obj, a }: { obj: WorldObject; a: BuildingAnalysis }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(obj.id);
  const mr = e?.modular;
  if (!e || !mr) return null;
  const cur = mr.current;
  const failed = mr.failedSet.size;
  const damaged = Array.from(mr.damage).filter((v, i) => v > 0.3 && !mr.failed[i]).length;
  const st0 = cur.stories[0];
  const T = (an: BuildingAnalysis) => Math.max(
    chainPeriod(an.stories.map((s) => Math.max(1, s.mass)), an.stories.map((s) => Math.max(1, s.kx))),
    chainPeriod(an.stories.map((s) => Math.max(1, s.mass)), an.stories.map((s) => Math.max(1, s.kz))),
  );
  const rows: [string, string, string, boolean][] = [
    [t('building.live.failed'), '0', String(failed), failed > 0],
    [t('building.live.damaged'), String(obj.building!.members.filter((m) => (m.initialDamage ?? 0) > 0.3).length), String(damaged), damaged > 0],
    [t('building.live.reserve'), '100 %', `${fmt(mr.reserve * 100, 0)} %`, mr.reserve < 0.999],
    [t('building.live.stiffness'), `${fmt((a.stories[0]?.kx ?? 0) / 1e6, 0)} / ${fmt((a.stories[0]?.kz ?? 0) / 1e6, 0)}`, `${fmt((st0?.kx ?? 0) / 1e6, 0)} / ${fmt((st0?.kz ?? 0) / 1e6, 0)}`, (st0?.kx ?? 0) < (a.stories[0]?.kx ?? 0) * 0.999],
    [t('building.live.periodRaw'), `${fmt(T(a), 2)} s`, `${fmt(T(cur), 2)} s`, T(cur) > T(a) * 1.001],
    [t('building.live.mass'), `${fmt(a.totalMass / 1000, 0)} t`, `${fmt(cur.totalMass / 1000, 0)} t`, cur.totalMass < a.totalMass * 0.999],
    [t('building.live.collapse'), '—', e.flags.collapsed ? t('building.live.total') : mr.collapsedFrom < Infinity ? t('building.live.fromStory', { story: mr.collapsedFrom + 1 }) : '—', mr.collapsedFrom < Infinity || !!e.flags.collapsed],
  ];
  return (
    <Section title={t('building.live.title')}>
      <table className={styles.compare} data-testid="building-compare">
        <thead><tr><th /><th>{t('building.live.before')}</th><th>{t('building.live.now')}</th></tr></thead>
        <tbody>
          {rows.map(([k, b, n, worse]) => (
            <tr key={k}><td>{k}</td><td>{b}</td><td className={worse ? styles.worse : ''}>{n}</td></tr>
          ))}
        </tbody>
      </table>
      {e.seismic && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }} data-testid="story-drifts">
          <div className={styles.note}>{t('building.live.storyDrift')}</div>
          {Array.from(mr.storyPeak).map((p, s) => {
            const cap = a.stories[s]?.driftU ?? 0.02;
            const r = Math.min(1.2, p / cap);
            return (
              <div key={s} className={styles.storyBar}>
                <span>{t('building.storyN', { n: s + 1 })}</span>
                <div className={styles.bar}><div className={styles.barFill} style={{ width: `${Math.min(100, r * 100)}%`, background: r >= 1 ? '#ef4d4d' : r > 0.5 ? '#f5973b' : '#3fbf7f' }} /></div>
                <span style={{ fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{fmt(p * 100, 2)} %</span>
              </div>
            );
          }).reverse()}
        </div>
      )}
      <div className={styles.note} style={{ marginTop: 6 }}>{t('building.live.note', { g: fmt(GRAVITY, 2) })}</div>
    </Section>
  );
}
