import { useEffect, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { Section } from '@/ui/common/Panel';
import styles from '@/ui/Inspector/Inspector.module.css';

/** Road network state during a simulation (Phase 18): counts + the most damaged roads. */
export function RoadSimSection() {
  const t = useT();
  useSimStore((s) => s.runtimeVersion);
  const [rev, setRev] = useState(-1);
  useEffect(() => {
    const id = setInterval(() => {
      const r = simulationController.getRuntime()?.roads;
      if (r && r.rev !== rev) setRev(r.rev);
    }, 400);
    return () => clearInterval(id);
  }, [rev]);
  const roads = simulationController.getRuntime()?.roads;
  if (!roads || roads.empty) return null;
  const s = roads.summary();
  const worst = [...roads.segments]
    .filter((x) => x.crack >= 0.05 || x.maxDepth >= 0.15 || x.scour >= 1)
    .sort((a, b) => b.crack + b.maxDepth - (a.crack + a.maxDepth))
    .slice(0, 6);
  return (
    <Section title={t('road.sim.title')}>
      <div className={styles.liveGrid} data-testid="road-sim">
        <span>{t('road.sim.total')}</span><span>{s.total}</span>
        <span>{t('road.sim.cracked')}</span><span>{s.cracked}</span>
        <span>{t('road.sim.severe')}</span><span>{s.severe}</span>
        <span>{t('road.sim.inundated')}</span><span>{s.inundated}</span>
        <span>{t('road.sim.impassable')}</span><span>{s.impassable}</span>
        <span>{t('road.sim.scoured')}</span><span>{s.scoured}</span>
      </div>
      {/* Most affected roads: one line each (long values do not fit the two-column grid). */}
      {worst.map((w) => (
        <div key={w.id} className={styles.note} data-road-state={w.status}>
          <b>{w.id}</b> · {t('road.sim.row', { crack: Math.round(w.crack * 100), pgv: w.peakPgv.toFixed(2), depth: w.maxDepth.toFixed(2), crown: w.maxCrownDepth.toFixed(2) })}
        </div>
      ))}
      <div className={styles.note}>{t('road.sim.note')}</div>
    </Section>
  );
}
