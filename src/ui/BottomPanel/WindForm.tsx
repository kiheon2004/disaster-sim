import { useMemo } from 'react';
import { COMPASS_BEARING, type CompassDir } from '@/core/compass';
import { useT, type MessageKey } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { useSimStore } from '@/simulation/simStore';
import { estimateCriticalSpeeds, heightFactor } from '@/simulation/damage/windLoad';
import { windClass } from '@/simulation/damage/windScale';
import { runSimulation } from '@/app/actions';
import { NumberField, SliderField } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { useWindForm } from './windFormStore';
import styles from './BottomPanel.module.css';

// 3×3 layout of the compass rose (null = center)
const ROSE: (CompassDir | null)[] = ['NW', 'N', 'NE', 'W', null, 'E', 'SW', 'S', 'SE'];

export function WindForm() {
  const t = useT();
  const f = useWindForm();
  const mode = useEditorStore((s) => s.mode);
  const status = useSimStore((s) => s.status);
  const cls = windClass(f.speed);
  const inSim = mode === 'simulation';

  return (
    <>
      <div className={styles.colHead}>
        <Icon name="wind" size={14} /> {t('panel.wind')}
        <span className={styles.aside}>
          <span className={styles.speedClass} style={{ color: cls.color, background: `${cls.color}22` }}>{t(cls.key)}</span>
        </span>
      </div>
      <div className={styles.colBody}>
        <div className={styles.windGrid}>
          <div>
            <div className={styles.rose} role="radiogroup" aria-label={t('wind.direction')}>
              {ROSE.map((d, i) =>
                d ? (
                  <button
                    key={d}
                    role="radio"
                    aria-checked={f.direction === d}
                    className={`${styles.roseBtn} ${f.direction === d ? styles.active : ''}`}
                    title={t(`compass.${d}` as MessageKey)}
                    onClick={() => f.set({ direction: d })}
                  >
                    {t(`compass.short.${d}` as MessageKey)}
                  </button>
                ) : (
                  <div key={i} className={styles.roseCenter}>
                    {/* Arrow shows where the air moves TO */}
                    <svg width="22" height="22" viewBox="0 0 24 24" style={{ transform: `rotate(${COMPASS_BEARING[f.direction] + 180}deg)` }}>
                      <path d="M12 3v15M12 21l-5-6h10z" fill="var(--sim)" stroke="var(--sim)" strokeWidth="1.5" strokeLinejoin="round" />
                    </svg>
                  </div>
                ),
              )}
            </div>
            <div className={styles.roseLabel} title={t('wind.directionFrom')}>{t('wind.fromTo', { from: t(`compass.${f.direction}` as MessageKey) })}</div>
          </div>
          <div className={styles.fields}>
            <SliderField label={t('wind.speed')} value={f.speed} min={0} max={100} step={1} unit="m/s" precision={0} onChange={(v) => f.set({ speed: v })} />
            <SliderField label={t('wind.gust')} value={Math.round(f.gust * 100)} min={0} max={100} step={5} unit="%" precision={0} onChange={(v) => f.set({ gust: v / 100 })} />
            <NumberField label={t('wind.duration')} value={f.duration} min={5} max={900} step={5} precision={0} unit="s" onChange={(v) => f.set({ duration: Math.round(v) })} />
            <NumberField label={t('wind.ramp')} value={f.ramp} min={0.5} max={120} step={0.5} precision={1} unit="s" onChange={(v) => f.set({ ramp: v })} />
          </div>
        </div>
        <div className={styles.actions}>
          <button className={styles.primary} disabled={status === 'loading'} onClick={() => void runSimulation([f.toSpec()])}>
            <Icon name="play" size={14} /> {inSim ? t('wind.applyNow') : t('wind.run')}
          </button>
          <ImpactPreview speed={f.speed} gust={f.gust} />
        </div>
      </div>
    </>
  );
}

/** Quick estimate of what this wind will likely do to the current scene. */
function ImpactPreview({ speed, gust }: { speed: number; gust: number }) {
  const t = useT();
  const objects = useWorldStore((s) => s.doc.objects);
  const summary = useMemo(() => {
    const peak = speed * (1 + gust * 0.8);
    const c = { human: [0, 0], tree: [0, 0], car: [0, 0], building: [0, 0] } as Record<string, [number, number]>;
    for (const o of Object.values(objects)) {
      const row = c[o.type];
      if (!row) continue;
      row[1]++;
      const est = estimateCriticalSpeeds(o);
      const threshold =
        o.type === 'car'
          ? Math.min(est.sliding ?? Infinity, est.tipping ?? Infinity)
          : o.type === 'building'
            ? Math.min(...o.components.map((comp) => comp.windResistance / heightFactor(comp.position[1] * o.transform.scale[1])))
            : est.structural;
      if (peak >= threshold) row[0]++;
    }
    return c;
  }, [objects, speed, gust]);
  if (speed <= 0) return null;
  return (
    <div className={styles.preview}>
      {t('wind.preview.title')}{' '}
      {t('wind.preview.people', { n: summary.human[0], total: summary.human[1] })} ·{' '}
      {t('wind.preview.trees', { n: summary.tree[0], total: summary.tree[1] })} ·{' '}
      {t('wind.preview.cars', { n: summary.car[0], total: summary.car[1] })} ·{' '}
      {t('wind.preview.buildings', { n: summary.building[0], total: summary.building[1] })}
    </div>
  );
}
