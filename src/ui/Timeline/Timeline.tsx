import { countRender } from '@/utils/renderCounter';
import { SIM_SPEEDS, type SimSpeed } from '@/core/units';
import { nearestCompass } from '@/core/compass';
import { useLocale, useT, translateMessage, type MessageKey } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { enterSimulation, resetSimulation, togglePlay } from '@/app/actions';
import { Icon } from '@/ui/common/Icon';
import { useUiStore } from '@/ui/uiStore';
import { Segmented } from '@/ui/common/Segmented';
import styles from './Timeline.module.css';

export function Timeline() {
  countRender('Timeline');
  const t = useT();
  const locale = useLocale();
  const mode = useEditorStore((s) => s.mode);
  const status = useSimStore((s) => s.status);
  const time = useSimStore((s) => s.time);
  const end = useSimStore((s) => s.endTime);
  const speed = useSimStore((s) => s.speed);
  const events = useSimStore((s) => s.events);
  const milestones = useSimStore((s) => s.milestones);
  // Phase 15: one lane per phenomenon type (in order of first appearance).
  const lanes: string[] = [];
  for (const e of events) if (!lanes.includes(e.type)) lanes.push(e.type);
  const laneCount = Math.max(1, lanes.length);
  const trackH = laneCount > 1 ? Math.min(72, 8 + laneCount * 15) : 26;
  const wind = useSimStore((s) => s.wind);
  const inSim = mode === 'simulation';
  const busy = status === 'loading';
  const span = Math.max(end, 1);
  const pct = (v: number) => `${Math.min(100, (v / span) * 100)}%`;
  const tickStep = span > 240 ? 60 : span > 90 ? 20 : 10;

  return (
    <div className={styles.bar}>
      <button
        className={`${styles.ctrl} ${styles.play}`}
        disabled={busy}
        title={`${t(status === 'running' ? 'timeline.pause' : 'timeline.play')} (Space)`}
        onClick={() => (inSim ? togglePlay() : void enterSimulation().then(() => simulationController.play()))}
      >
        <Icon name={status === 'running' ? 'pause' : 'play'} size={14} />
      </button>
      <button className={styles.ctrl} disabled={!inSim || busy} title={t('timeline.reset')} onClick={() => void resetSimulation()}>
        <Icon name="reset" size={15} />
      </button>
      <span className={styles.time}>
        <b>{time.toFixed(1)}</b> / {inSim ? end.toFixed(0) : '–'} s
      </span>
      <div className={styles.track} style={{ height: trackH }} aria-label={t('panel.timeline')}>
        {inSim && (
          <>
            <div className={styles.ticks}>
              {Array.from({ length: Math.floor(span / tickStep) }, (_, i) => (
                <div key={i} className={styles.tick} style={{ left: pct((i + 1) * tickStep) }} />
              ))}
            </div>
            {events.map((e) => (
              <div
                key={e.id}
                className={`${styles.evt} ${e.status === 'active' ? styles.active : ''} ${e.status === 'superseded' ? styles.superseded : ''}`}
                style={{
                  left: pct(e.start), width: `calc(${pct(e.duration)} - 1px)`,
                  top: 3 + (lanes.indexOf(e.type) * (trackH - 6)) / laneCount, height: (trackH - 6) / laneCount - 1, bottom: 'auto',
                }}
                title={translateMessage(locale, e.label)}
              >
                <svg width="100%" height="100%" viewBox="0 0 47 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }}>
                  <path
                    d={`M0 1 ${e.profile.map((v, i) => `L${i} ${1 - Math.min(1, v)}`).join(' ')} L47 1 Z`}
                    fill={e.type === 'rain' || e.type === 'risingWater' || e.type === 'waterSource' ? 'rgba(70,160,230,0.45)' : 'rgba(240,138,60,0.35)'}
                  />
                </svg>
                <span className={styles.evtLabel}>{translateMessage(locale, e.label)}</span>
              </div>
            ))}
            {milestones.filter((m) => m.kind !== 'start' && m.kind !== 'end').map((m, i) => (
              <div key={i} className={styles.milestone} data-hazard={m.hazard} style={{ left: pct(m.time) }}
                title={`${m.time.toFixed(1)} s · ${t(`milestone.${m.kind}` as MessageKey, { hazard: m.hazard ? t(`hazardName.${m.hazard}` as MessageKey) : '', ha: (m.label.params?.ha as number) ?? '' })}`} />
            ))}
            <div className={styles.progress} style={{ width: pct(time) }} />
            <div className={styles.head} style={{ left: pct(time) }} />
          </>
        )}
        {(!inSim || events.length === 0) && <div className={styles.empty}>{t(inSim ? 'timeline.noEvents' : 'timeline.editorHint')}</div>}
      </div>
      {inSim && (
        <span className={styles.windNow} title={t('timeline.windNow')}>
          <Icon name="wind" size={13} /> {wind.speed.toFixed(1)} m/s {wind.speed > 0.5 ? t(`compass.short.${nearestCompass(wind.bearing)}` as MessageKey) : ''}
        </span>
      )}
      <Segmented<SimSpeed>
        size="small"
        ariaLabel={t('timeline.speed')}
        value={speed}
        onChange={(v) => simulationController.setSpeed(v)}
        options={SIM_SPEEDS.map((s) => ({ value: s, label: `${s}x` }))}
      />
      <span className={`${styles.status} ${styles[`s-${status}`]}`}>{t(`simStatus.${status}`)}</span>
      <button
        className={styles.resultsBtn}
        disabled={!inSim || (status !== 'paused' && status !== 'finished')}
        title={t('results.open.title')}
        onClick={() => useUiStore.getState().setResultsOpen(true)}
      >
        <Icon name="list" size={14} /> {t('results.open')}
      </button>
    </div>
  );
}
