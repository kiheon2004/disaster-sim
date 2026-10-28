import { useMemo, useState } from 'react';
import { useLocale, useT, translateMessage } from '@/i18n/i18n';
import type { EarthquakeEventSpec } from '@/events/specs';
import { assumedPga, defaultDuration, defaultFrequency, hypocentralDistanceKm, radialBearing, resolveEarthquake } from '@/events/earthquake/resolveEarthquake';
import { sMinusP } from '@/simulation/seismic/GroundMotionField';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { useSimStore } from '@/simulation/simStore';
import { runSimulation } from '@/app/actions';
import { NumberField, SliderField, Toggle } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { Icon } from '@/ui/common/Icon';
import { randomSeed } from '@/core/random';
import styles from './BottomPanel.module.css';
import eq from './EarthquakeForm.module.css';

export const DEFAULT_EARTHQUAKE: EarthquakeEventSpec = { event: 'earthquake', magnitude: 6.5, pga: 0.3, epicenter: [0, 0], depth: 10 };

/**
 * Earthquake settings. The spec IS the project's saved scenario (doc.scenario.earthquake),
 * so it is stored with the project and reloaded with it. Optional fields left on "auto" stay
 * undefined and are resolved (and listed as assumptions) exactly like a parsed command.
 */
export function EarthquakeForm({ tabs }: { tabs: React.ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const saved = useWorldStore((s) => s.doc.scenario.earthquake);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const mode = useEditorStore((s) => s.mode);
  const status = useSimStore((s) => s.status);
  const [advanced, setAdvanced] = useState(false);
  const spec = saved ?? DEFAULT_EARTHQUAKE;
  const set = (patch: Partial<EarthquakeEventSpec>) => {
    const next = { ...spec, ...patch } as EarthquakeEventSpec;
    for (const k of Object.keys(next) as (keyof EarthquakeEventSpec)[]) if (next[k] === undefined) delete next[k];
    useWorldStore.getState().setEarthquakeScenario(next);
  };
  const q = useMemo(() => resolveEarthquake(spec, seed), [spec, seed]);
  const epi = spec.epicenter ?? [0, 0];
  const dist = hypocentralDistanceKm(epi, q.depth);
  const inSim = mode === 'simulation';

  return (
    <>
      <div className={styles.colHead}>
        {tabs}
        <span className={styles.aside}>
          <span className={eq.badge} title={t('eq.form.synthetic')}>{t('quakeHud.synthetic')}</span>
        </span>
      </div>
      <div className={styles.colBody}>
        <div className={eq.grid}>
          <div className={eq.fields}>
            <SliderField label={t('eq.form.magnitude')} value={spec.magnitude} min={3} max={9.5} step={0.1} precision={1} onChange={(v) => set({ magnitude: Math.round(v * 10) / 10 })} />
            <div className={`${eq.row} ${eq.wrapRow}`}>
              <span className={eq.label} title={t('eq.form.pga.hint')}>{t('eq.form.pgaMode')}</span>
              <Segmented
                size="small"
                value={spec.pga === undefined ? 'assume' : 'specify'}
                onChange={(m) => set({ pga: m === 'assume' ? undefined : (spec.pga ?? assumedPga(spec.magnitude, dist)) })}
                options={[
                  { value: 'specify', label: t('eq.form.pgaMode.specify') },
                  { value: 'assume', label: t('eq.form.pgaMode.assume') },
                ]}
              />
            </div>
            {spec.pga !== undefined ? (
              <SliderField label={t('eq.form.pga')} value={spec.pga} min={0.01} max={1.5} step={0.01} precision={2} unit="g" onChange={(v) => set({ pga: Math.round(v * 100) / 100 })} />
            ) : (
              <div className={eq.assumed}>{t('eq.form.pgaAssumed', { g: q.pga.toFixed(2) })}</div>
            )}
            <AutoNumber label={t('eq.form.duration')} value={spec.duration} auto={defaultDuration(spec.magnitude)} min={5} max={180} step={1} precision={0} unit="s" onChange={(v) => set({ duration: v })} t={t} />
            <AutoNumber label={t('eq.form.frequency')} value={spec.dominantFrequency} auto={defaultFrequency(spec.magnitude)} min={0.3} max={10} step={0.1} precision={1} unit="Hz" onChange={(v) => set({ dominantFrequency: v })} t={t} />
            <AutoNumber label={t('eq.form.direction')} value={spec.direction} auto={Math.round(radialBearing(epi))} min={0} max={359} step={5} precision={0} unit="°" onChange={(v) => set({ direction: v })} t={t} autoLabel={t('eq.form.direction.radial')} />
          </div>
          <div className={eq.side}>
            <button className={eq.disclosure} onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={12} /> {t('eq.form.advanced')}
            </button>
            {advanced && (
              <div className={eq.fields}>
                <NumberField label={t('eq.form.depth')} value={q.depth} min={0} max={700} step={1} precision={0} unit="km" onChange={(v, live) => !live && set({ depth: v })} />
                <NumberField label={t('eq.form.epicenterX')} value={epi[0]} min={-500000} max={500000} step={10} precision={0} unit="m" onChange={(v, live) => !live && set({ epicenter: [v, epi[1]] })} />
                <NumberField label={t('eq.form.epicenterZ')} value={epi[1]} min={-500000} max={500000} step={10} precision={0} unit="m" onChange={(v, live) => !live && set({ epicenter: [epi[0], v] })} />
                <button className={eq.small} onClick={() => set({ epicenter: [0, 0] })}>{t('eq.form.center')}</button>
                <NumberField label={t('eq.form.vertical')} value={q.verticalRatio} min={0} max={1.5} step={0.05} precision={2} onChange={(v, live) => !live && set({ verticalRatio: v })} />
                <div className={eq.row}>
                  <span className={eq.label}>{t('eq.form.seed')}</span>
                  <Toggle checked={spec.seed === undefined} onChange={(b) => set({ seed: b ? undefined : seed })} label={t('eq.form.seed.project')} />
                </div>
                {spec.seed !== undefined && (
                  <div className={eq.row}>
                    <NumberField label="" value={spec.seed} min={0} max={999999999} step={1} precision={0} onChange={(v, live) => !live && set({ seed: Math.round(v) })} />
                    <button className={eq.small} onClick={() => set({ seed: randomSeed() })} title={t('settings.seed.random')}><Icon name="sparkle" size={12} /></button>
                  </div>
                )}
              </div>
            )}
            <div className={eq.info}>{t('eq.form.distance', { km: dist.toFixed(1), s: sMinusP(dist).toFixed(1) })}</div>
            {q.assumptions.length > 0 && (
              <div className={eq.assumptions}>
                <b>{t('eq.form.assumptions')}</b>
                {q.assumptions.map((a, i) => <div key={i}>· {translateMessage(locale, a)}</div>)}
              </div>
            )}
          </div>
        </div>
        <div className={styles.actions}>
          <button className={styles.primary} disabled={status === 'loading'} onClick={() => void runSimulation([{ ...spec }])}>
            <Icon name="play" size={14} /> {inSim ? t('eq.form.applyNow') : t('eq.form.run')}
          </button>
          <div className={eq.disclaimer}>{t('eq.form.synthetic')}</div>
        </div>
      </div>
    </>
  );
}

function AutoNumber(p: {
  label: string; value: number | undefined; auto: number; min: number; max: number; step: number; precision: number; unit: string;
  onChange: (v: number | undefined) => void; t: ReturnType<typeof useT>; autoLabel?: string;
}) {
  const isAuto = p.value === undefined;
  return (
    <div className={eq.autoRow}>
      <NumberField label={p.label} value={p.value ?? p.auto} min={p.min} max={p.max} step={p.step} precision={p.precision} unit={p.unit}
        disabled={isAuto} onChange={(v, live) => !live && p.onChange(v)} />
      <Toggle checked={isAuto} onChange={(b) => p.onChange(b ? undefined : p.auto)} label={p.autoLabel ?? p.t('eq.form.auto')} />
    </div>
  );
}
