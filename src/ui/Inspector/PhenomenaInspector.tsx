import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useWorldStore } from '@/world/worldStore';
import { forcesAt, FORCE_SOURCES } from '@/simulation/forces/ForceLedger';
import { hazardDamage, residualStrength } from '@/simulation/interactions/integrity';
import { DAMAGE_STATE_IDS } from '@/simulation/damage/DamageState';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

const SOURCE_KEY: Record<(typeof FORCE_SOURCES)[number], MessageKey> = {
  wind: 'channel.airflow', groundMotion: 'channel.groundMotion', water: 'channel.water', gravityField: 'channel.gravity', sediment: 'channel.sediment', impact: 'channel.impact',
};

function Grid({ rows }: { rows: [string, string][] }) {
  return (
    <div className={styles.liveGrid}>
      {rows.map(([k, v], i) => (
        <Fragment key={i}>
          <span>{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Multi-phenomenon view of the selected object (Phase 15): the forces each channel applied in
 * the last step (ForceLedger), damage per hazard and the residual strength each hazard sees,
 * the ordered damage history, and — for people — the environmental exposure record.
 */
export function PhenomenaLiveSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const interactions = useWorldStore((s) => s.doc.settings.simulation.interactions?.enabled ?? true);
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e || e.def.inert) return null;
  const step = simulationController.getStep() - 1;
  const forces = forcesAt(e, step);
  const forceRows: [string, string][] = FORCE_SOURCES.filter((s) => forces[s] >= 0).map((s) => [t(SOURCE_KEY[s]), `${fmt(forces[s] / 1000, 2)} kN`]);
  const dmg = hazardDamage(e);
  const multi = [dmg.wind, dmg.earthquake, dmg.flood].filter((d) => d > 0).length;
  const hist = e.integrity?.history ?? [];
  const x = e.exposure;
  if (!forceRows.length && !multi && !hist.length && !x) return null;
  return (
    <Section title={t('live.phen.title')}>
      {forceRows.length > 0 && (
        <>
          <div className={styles.note}>{t('live.phen.forces')}</div>
          <Grid rows={forceRows} />
        </>
      )}
      {(multi > 0 || e.seismic || e.flood) && (
        <>
          <div className={styles.note}>{t('live.phen.damage')}</div>
          <Grid rows={(['wind', 'earthquake', 'flood'] as const).map((h) => [
            t(`hazardName.${h}`),
            `D ${fmt(dmg[h], 2)}${interactions ? ` · ${t('live.phen.capacity')} ${Math.round(residualStrength(e, h) * 100)} %` : ''}`,
          ])} />
          {!interactions && <div className={styles.note}>{t('live.phen.independent')}</div>}
        </>
      )}
      {hist.length > 0 && (
        <>
          <div className={styles.note}>{t('live.phen.history')}</div>
          <Grid rows={hist.slice(-8).map((h) => [`${fmt(h.time, 1)} s`, `${t(`hazardName.${h.hazard}`)} → ${t(`damage.${DAMAGE_STATE_IDS[h.state]}` as MessageKey)}`])} />
        </>
      )}
      {x && (
        <>
          <div className={styles.note}>{t('live.phen.exposure')}</div>
          <Grid rows={[
            [t('live.phen.wind'), `${fmt(x.wind, 1)} m/s (max ${fmt(x.peak.wind, 1)})`],
            [t('live.phen.water'), `${fmt(x.waterDepth, 2)} m · ${fmt(x.flowSpeed, 2)} m/s`],
            [t('live.phen.shaking'), `${fmt(x.groundAccel, 2)} g (max ${fmt(x.peak.groundAccel, 2)})`],
            [t('live.phen.atmosphere'), `${x.atmosphere.pressure} kPa · O₂ ${(x.atmosphere.oxygen * 100).toFixed(1)} % · ${x.atmosphere.temperature} °C`],
          ]} />
          <div className={styles.note}>{t('live.phen.baseline')}</div>
        </>
      )}
    </Section>
  );
}
