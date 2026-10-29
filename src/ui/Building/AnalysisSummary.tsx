import { useMemo } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { BuildingDesign } from '@/buildings/types';
import type { AnalysisWarning, BuildingAnalysis } from '@/buildings/analysis';
import { analysisOf, designPhysics } from '@/buildings/design';
import { fmt } from '@/ui/format';
import styles from './Building.module.css';

/** Localized analysis warnings (member ids capped). */
export function WarningList({ warnings, max = 8 }: { warnings: readonly AnalysisWarning[]; max?: number }) {
  const t = useT();
  if (!warnings.length) return <div className={styles.note}>{t('building.warn.none')}</div>;
  return (
    <div className={styles.warnList} data-testid="building-warnings">
      {warnings.slice(0, max).map((w, i) => (
        <div key={i} className={`${styles.warn} ${styles[w.level]}`} data-code={w.code}>
          {t(`building.warn.${w.code}` as MessageKey, {
            n: w.value !== undefined ? Math.round(w.value) : w.members?.length ?? 0,
            story: (w.story ?? 0) + 1,
            v: w.value !== undefined ? fmt(w.value, 2) : '',
            ids: (w.members ?? []).slice(0, 4).join(', ') + ((w.members?.length ?? 0) > 4 ? ' …' : ''),
          })}
        </div>
      ))}
    </div>
  );
}

/** Key numbers of the simplified structural model of a design. */
export function AnalysisRows({ a, design }: { a: BuildingAnalysis; design: BuildingDesign }) {
  const t = useT();
  const phys = useMemo(() => designPhysics(design, a), [design, a]);
  const counts = useMemo(() => {
    let structural = 0, envelope = 0;
    for (const m of design.members) {
      if (m.role === 'cladding' || m.role === 'opening' || m.role === 'roofing' || m.role === 'nonStructural') envelope++;
      else structural++;
    }
    return { structural, envelope };
  }, [design]);
  const calibrated = Math.abs(a.calibration[0] - 1) > 1e-6 || Math.abs(a.calibration[1] - 1) > 1e-6;
  return (
    <div className={styles.summary} data-testid="analysis-rows">
      <span>{t('building.sum.mass')}</span><span>{fmt(a.totalMass / 1000, 0)} t</span>
      <span>{t('building.sum.height')}</span><span>{fmt(a.height, 1)} m</span>
      <span>{t('building.sum.members')}</span><span>{counts.structural} / {counts.envelope}</span>
      <span>{t('building.sum.period')}</span><span>{fmt(a.periodX, 2)} / {fmt(a.periodZ, 2)} s{calibrated ? ' *' : ''}</span>
      <span>{t('building.sum.stiffness')}</span><span>{fmt((a.stories[0]?.kx ?? 0) / 1e6, 0)} / {fmt((a.stories[0]?.kz ?? 0) / 1e6, 0)} MN/m</span>
      <span>{t('building.sum.cy')}</span><span>{fmt(a.cyX, 2)} / {fmt(a.cyZ, 2)}</span>
      <span>{t('building.sum.weakStory')}</span><span>{a.weakStory[0] + 1} / {a.weakStory[1] + 1}</span>
      <span>{t('building.sum.wind')}</span><span>{fmt(phys.windResistance, 0)} m/s</span>
      <span>{t('building.sum.system')}</span><span>{t(`struct.system.${a.system}` as MessageKey)}</span>
      {calibrated && (<><span className={styles.note}>* {t('building.sum.calibrated')}</span><span /></>)}
    </div>
  );
}

export function AnalysisSummary({ design }: { design: BuildingDesign | null }) {
  const t = useT();
  const a = useMemo(() => (design ? analysisOf(design) : null), [design]);
  if (!design || !a) return <div className={styles.note}>{t('building.sum.invalid')}</div>;
  return (
    <>
      <AnalysisRows a={a} design={design} />
      <WarningList warnings={a.warnings} />
      <div className={styles.note} style={{ marginTop: 6 }}>{t('building.sum.note')}</div>
    </>
  );
}
