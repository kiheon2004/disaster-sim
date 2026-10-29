import { Fragment } from 'react';
import { isMessageKey, useT, type MessageKey, type TFunction } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { SEGMENT_IDS } from '@/human/anthropometry';
import { levelRank } from '@/human/injury';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { riskIndex } from '@/simulation/human/summary';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

export const LEVEL_COLORS = ['#8a8f98', '#e6d14a', '#f5973b', '#ef4d4d', '#c43bd6'] as const;

function Rows({ rows, testId }: { rows: [string, React.ReactNode][]; testId: string }) {
  return (
    <div className={styles.liveGrid} data-testid={testId}>
      {rows.map(([k, v], i) => (
        <Fragment key={`${k}:${i}`}>
          <span>{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Translated name of a fall cause / limit id (the id itself is never shown raw when a key exists). */
export function causeLabel(t: TFunction, cause: string | null): string {
  if (!cause) return t('humanUi.none');
  const k = `humanUi.cause.${cause}`;
  return isMessageKey(k) ? t(k) : t('humanUi.cause.other');
}
export function limitLabel(t: TFunction, id: string): string {
  const k = `human.limit.${id}`;
  return isMessageKey(k) ? t(k) : t('humanUi.limit.other');
}

/**
 * Human body state of the selected person (Phase 33, live): the extended model's posture, balance, fall, motion, last
 * contact episode and the educational risk index per body segment; a legacy run shows the model level only.
 */
export function HumanObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e || e.source.type !== 'human') return null;
  const st = e.human;
  if (!st) {
    return (
      <Section title={t('humanUi.inspect.title')}>
        <Rows testId="human-object" rows={[[t('humanUi.inspect.model'), t('humanUi.model.legacy')]]} />
        <div className={styles.note}>{t('humanUi.limitation')}</div>
      </Section>
    );
  }
  const speed = Math.hypot(st.v[0], st.v[1], st.v[2]), spin = Math.hypot(st.w[0], st.w[1], st.w[2]);
  const L = st.last;
  const rows: [string, React.ReactNode][] = [
    [t('humanUi.inspect.model'), t('humanUi.model.extended')],
    [t('humanUi.inspect.body'), `${fmt(st.model.mass, 1)} kg · ${fmt(st.model.height, 2)} m`],
    [t('humanUi.inspect.posture'), t(`human.posture.${st.posture}` as MessageKey)],
    [t('humanUi.inspect.stance'), st.standing ? t('humanUi.inspect.standingMargin', { m: fmt(st.bal.margin, 2) }) : t('humanUi.inspect.released')],
    [t('humanUi.inspect.fall'), st.falls > 0 ? t('humanUi.inspect.fallLine', { n: st.falls, t: fmt(st.firstFall, 2), c: causeLabel(t, st.fallCause) }) : t('humanUi.none')],
    [t('humanUi.inspect.speed'), `${fmt(speed, 2)} m/s`],
    [t('humanUi.inspect.spin'), `${fmt(spin, 2)} rad/s`],
    [t('humanUi.inspect.lastImpulse'), L ? t('humanUi.inspect.lastLine', { j: fmt(L.impulse, 1), dv: fmt(L.dv, 2), t: fmt(L.time, 2), p: L.partner === 'ground' ? t('humanUi.partner.ground') : L.partner }) : t('humanUi.none')],
    [t('humanUi.inspect.risk'), t('humanUi.inspect.riskLine', { c: fmt(riskIndex(st), 2), p: fmt(Math.max(...SEGMENT_IDS.map((s) => st.risk[s].peak)), 2) })],
    [t('humanUi.inspect.mobility'), t(`human.mobility.${st.mobility}` as MessageKey)],
    [t('humanUi.inspect.incapacitated'), st.incapacitated ? t('humanUi.yes') : t('humanUi.no')],
    [t('humanUi.inspect.buried'), st.buried ? t('humanUi.yes') : t('humanUi.no')],
  ];
  if (st.limits.length) rows.push([t('humanUi.inspect.limits'), st.limits.map((l) => limitLabel(t, l)).join(' · ')]);
  return (
    <Section title={t('humanUi.inspect.title')}>
      <Rows testId="human-object" rows={rows} />
      <table className={styles.compTable} data-testid="human-segments" style={{ marginTop: 6 }}>
        <thead>
          <tr><th>{t('humanUi.seg')}</th><th>{t('humanUi.level')}</th><th>{t('humanUi.cum')}</th><th>{t('humanUi.peak')}</th><th>{t('humanUi.hits')}</th></tr>
        </thead>
        <tbody>
          {SEGMENT_IDS.map((s) => {
            const r = st.risk[s];
            return (
              <tr key={s}>
                <td>{t(`human.seg.${s}` as MessageKey)}</td>
                <td style={{ color: LEVEL_COLORS[levelRank(r.level)] }}>{t(`human.level.${r.level}` as MessageKey)}</td>
                <td className={styles.num}>{fmt(r.cum, 2)}</td>
                <td className={styles.num}>{fmt(r.peak, 2)}</td>
                <td className={styles.num}>{r.hits}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Section title={t('humanUi.inspect.advanced')} defaultOpen={false}>
        <Rows testId="human-advanced" rows={[
          [t('humanUi.inspect.demand'), st.standing ? fmt(st.bal.demand, 2) : t('humanUi.notStanding')],
          [t('humanUi.inspect.lean'), st.standing ? `${fmt((Math.hypot(st.bal.th[0], st.bal.th[1]) * 180) / Math.PI, 1)}°` : t('humanUi.notStanding')],
          [t('humanUi.inspect.releaseEnergy'), `${fmt(st.releaseEnergy, 1)} J`],
          [t('humanUi.inspect.tidal'), st.tidal ? t('humanUi.inspect.tidalLine', { b: fmt(st.tidal.bodyWeights, 3), k: st.tidal.sign > 0 ? t('humanUi.tension') : t('humanUi.compression'), p: fmt(st.tidalPeak, 3) }) : t('humanUi.notMeasured')],
          [t('humanUi.inspect.closing'), L ? `${fmt(L.closing, 2)} m/s` : t('humanUi.none')],
          [t('humanUi.inspect.decel'), L ? `${fmt(L.decel, 0)} m/s²` : t('humanUi.none')],
          [t('humanUi.inspect.maxDrop'), `${fmt(st.maxDrop, 2)} m`],
          [t('humanUi.inspect.stanceCount'), t('humanUi.inspect.stanceLine', { r: st.regained, c: st.collapsed })],
        ]} />
        <div className={styles.note}>{t('humanUi.decelNote')}</div>
      </Section>
      <div className={styles.note}>{t('humanUi.limitation')}</div>
    </Section>
  );
}
