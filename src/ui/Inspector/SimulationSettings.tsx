import { useT } from '@/i18n/i18n';
import { useWorldStore } from '@/world/worldStore';
import { DEFAULT_WIND_MODEL } from '@/core/model';
import { randomSeed } from '@/core/random';
import { Section } from '@/ui/common/Panel';
import { NumberField, ToggleField } from '@/ui/common/fields';
import styles from './Inspector.module.css';

/** Seed + approximate wind-model parameters, stored in the world document. */
export function SimulationSettingsSection({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const sim = useWorldStore((s) => s.doc.settings.simulation);
  const upd = useWorldStore.getState().updateSimulationSettings;
  const w = sim.wind;
  return (
    <Section title={t('settings.title')} defaultOpen={false}>
      <NumberField label={t('settings.seed')} value={sim.seed} min={0} max={999999999} step={1} precision={0} disabled={readOnly}
        hint={t('settings.seed.hint')} onChange={(v) => upd({ seed: Math.round(v) })} />
      {!readOnly && (
        <button className={styles.linkBtn} onClick={() => upd({ seed: randomSeed() })}>{t('settings.seed.random')}</button>
      )}
      <ToggleField label={t('settings.shelter')} checked={w.shelterEnabled} disabled={readOnly}
        hint={t('settings.shelter.hint')} onChange={(b) => upd({ wind: { shelterEnabled: b } })} />
      <NumberField label={t('settings.shadowStrength')} value={w.shadowStrength * 100} min={0} max={90} step={5} precision={0} unit="%" disabled={readOnly || !w.shelterEnabled}
        onChange={(v) => upd({ wind: { shadowStrength: v / 100 } })} />
      <NumberField label={t('settings.wakeLength')} value={w.wakeLength} min={1} max={20} step={0.5} precision={1} unit="×H" disabled={readOnly || !w.shelterEnabled}
        onChange={(v) => upd({ wind: { wakeLength: v } })} />
      <NumberField label={t('settings.wakeRecovery')} value={w.wakeRecovery} min={0.5} max={10} step={0.1} precision={1} unit="×H" disabled={readOnly || !w.shelterEnabled}
        onChange={(v) => upd({ wind: { wakeRecovery: v } })} />
      <NumberField label={t('settings.cornerSpeedup')} value={w.cornerSpeedup * 100} min={0} max={60} step={1} precision={0} unit="%" disabled={readOnly || !w.shelterEnabled}
        onChange={(v) => upd({ wind: { cornerSpeedup: v / 100 } })} />
      <NumberField label={t('settings.turbulence')} value={w.turbulence * 100} min={0} max={100} step={5} precision={0} unit="%" disabled={readOnly || !w.shelterEnabled}
        onChange={(v) => upd({ wind: { turbulence: v / 100 } })} />
      {!readOnly && (
        <button className={styles.linkBtn} onClick={() => upd({ wind: { ...DEFAULT_WIND_MODEL } })}>{t('inspector.resetPhysics')}</button>
      )}
      <div className={styles.note}>{t('model.approximate')}</div>
    </Section>
  );
}
