import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import styles from './Seismogram.module.css';

/**
 * Earthquake time graph under the timeline (shown once an earthquake is scheduled):
 *  - planned principal ground acceleration at the map center (gray, known in advance — the
 *    waveform is deterministic),
 *  - recorded ground acceleration (orange) and the largest current story drift of any
 *    building (blue, own scale),
 *  - earthquake damage events (red ticks).
 * Same time axis as the timeline (0 … end).
 */
export function Seismogram() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  const events = useSimStore((s) => s.events);
  const end = useSimStore((s) => s.endTime);
  const time = useSimStore((s) => s.time);
  const series = useSimStore((s) => s.seismicSeries);
  const damage = useSimStore((s) => s.damageEvents);
  const quake = useSimStore((s) => s.quake);
  const quakes = useMemo(() => events.filter((e) => e.type === 'earthquake' && e.waveform), [events]);
  const ticks = useMemo(() => {
    const bins = new Map<number, number>();
    for (const e of damage) if (e.hazard === 'earthquake') bins.set(Math.round(e.time * 4) / 4, (bins.get(Math.round(e.time * 4) / 4) ?? 0) + 1);
    return [...bins.entries()];
  }, [damage]);
  if (mode !== 'simulation' || quakes.length === 0) return null;

  const span = Math.max(end, 1);
  const W = 1000;
  const x = (s: number) => (s / span) * W;
  let gMax = 0.05;
  for (const q of quakes) for (const v of q.waveform!) gMax = Math.max(gMax, Math.abs(v));
  if (series) for (const v of series.ground) gMax = Math.max(gMax, Math.abs(v));
  const dMax = Math.max(0.002, ...(series?.drift ?? [0]));
  const peakDrift = series ? Math.max(0, ...series.drift) : 0;
  const tickMax = Math.max(1, ...ticks.map((k) => k[1]));

  return (
    <div className={styles.strip}>
      <div className={styles.legend}>
        <b>{t('seis.title')}</b>
        <span><i style={{ background: '#f08a3c' }} />{t('seis.ground')} {quake ? `${quake.peak.toFixed(2)}g` : ''}</span>
        <span><i style={{ background: '#5aa9ff' }} />{t('seis.response')} {(peakDrift * 100).toFixed(2)}%</span>
        <span><i style={{ background: '#ef4d4d' }} />{t('seis.damage')}</span>
      </div>
      <svg className={styles.plot} viewBox={`0 -1 ${W} 2`} preserveAspectRatio="none" role="img" aria-label={t('seis.title')}>
        <line x1={0} x2={W} y1={0} y2={0} className={styles.axis} />
        {quakes.map((q) => (
          <polyline
            key={q.id}
            className={styles.planned}
            points={q.waveform!.map((v, i) => `${x(q.start + ((i + 0.5) / q.waveform!.length) * q.duration)},${-v / gMax}`).join(' ')}
          />
        ))}
        {series && series.t.length > 1 && (
          <>
            <polyline className={styles.ground} points={series.t.map((s, i) => `${x(s)},${-series.ground[i] / gMax}`).join(' ')} />
            <polyline className={styles.drift} points={series.t.map((s, i) => `${x(s)},${1 - (series.drift[i] / dMax) * 1.9}`).join(' ')} />
          </>
        )}
        {ticks.map(([s, n]) => (
          <line key={s} x1={x(s)} x2={x(s)} y1={1} y2={1 - 0.25 - (n / tickMax) * 0.6} className={styles.tick} />
        ))}
        <line x1={x(time)} x2={x(time)} y1={-1} y2={1} className={styles.cursor} />
      </svg>
    </div>
  );
}
