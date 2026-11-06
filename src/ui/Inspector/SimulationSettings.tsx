import { useT, type MessageKey } from '@/i18n/i18n';
import { useWorldStore } from '@/world/worldStore';
import { DEFAULT_WIND_MODEL, type HumanSettings } from '@/core/model';
import { randomSeed } from '@/core/random';
import { Section } from '@/ui/common/Panel';
import { NumberField, SelectField, ToggleField } from '@/ui/common/fields';
import { DEFAULT_REFERENCE, PHYSIO_LIMITS, PHYSIO_MODULES, type PhysiologyReference, type PhysiologySettings } from '@/physiology/settings';
import { ACTIVITIES, CLOTHING, type Activity, type Clothing } from '@/physiology/thermal';
import { activityLabel, clothingLabel } from './PhysiologyInspector';
import { DEFAULT_SUBSTEPS, type VehicleSettings } from '@/vehicle/settings';
import type { TireModel } from '@/vehicle/tire';
import { tireLabel } from './VehicleInspector';
import styles from './Inspector.module.css';

/**
 * Extended human model (Phase 33): `settings.simulation.humans` set / removed (absent = the legacy people). Written like
 * the other optional simulation settings (a document edit, not an undo step).
 */
function setHumanSettings(h: HumanSettings | null) {
  useWorldStore.getState().updateSimulationSettings({ humans: h });
}

/**
 * Reduced physiology (Phase 34): `settings.simulation.physiology` set / removed (absent = no physiology). It needs the
 * extended human model — switching it on switches the extended model on with it (existing human options kept).
 */
function PhysiologySettingsBlock({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const sim = useWorldStore((s) => s.doc.settings.simulation);
  const upd = useWorldStore.getState().updateSimulationSettings;
  const ph = sim.physiology;
  const set = (patch: Partial<PhysiologySettings>) => upd({ physiology: { ...(ph ?? { model: 'reduced' }), ...patch, model: 'reduced' } });
  const ref = (k: keyof PhysiologyReference, v: number) => set({ reference: { ...(ph?.reference ?? {}), [k]: v } });
  const lim = (k: keyof typeof PHYSIO_LIMITS, v: number) => Math.min(PHYSIO_LIMITS[k][1], Math.max(PHYSIO_LIMITS[k][0], v));
  const r = { ...DEFAULT_REFERENCE, ...(ph?.reference ?? {}) };
  return (
    <div data-testid="physio-settings" style={{ display: 'contents' }}>
      <ToggleField label={t('physioUi.settings.on')} checked={!!ph} disabled={readOnly} hint={t('physioUi.settings.on.hint')}
        onChange={(b) => (b ? upd({ humans: { ...(sim.humans ?? {}), model: 'extended' }, physiology: { model: 'reduced' } }) : upd({ physiology: null }))} />
      {ph && (
        <Section title={t('physioUi.settings.advanced')} defaultOpen={false}>
          <div data-testid="physio-advanced-settings" style={{ display: 'contents' }}>
            <SelectField<Activity> label={t('physioUi.settings.activity')} value={ph.activity ?? 'resting'} disabled={readOnly}
              options={ACTIVITIES.map((a) => ({ value: a, label: activityLabel(t, a) }))} onChange={(v) => set({ activity: v })} />
            <SelectField<Clothing> label={t('physioUi.settings.clothing')} value={ph.clothing ?? 'normal'} disabled={readOnly}
              options={CLOTHING.map((c) => ({ value: c, label: clothingLabel(t, c) }))} onChange={(v) => set({ clothing: v })} />
            <NumberField label={t('physioUi.settings.water')} value={ph.waterIntake ?? 0} min={0} max={2} step={0.05} precision={2} unit="L/h" disabled={readOnly}
              hint={t('physioUi.settings.water.hint')} onChange={(v) => set({ waterIntake: lim('waterIntake', v) })} />
            {PHYSIO_MODULES.map((m) => (
              <ToggleField key={m} label={t(`physioUi.mod.${m}` as MessageKey)} checked={ph.modules?.[m] !== false} disabled={readOnly}
                onChange={(b) => set({ modules: { ...(ph.modules ?? {}), [m]: b } })} />
            ))}
            <NumberField label={t('physioUi.settings.humidity')} value={r.humidity * 100} min={0} max={100} step={5} precision={0} unit="%" disabled={readOnly}
              onChange={(v) => ref('humidity', lim('humidity', v / 100))} />
            <NumberField label={t('physioUi.settings.pressure')} value={r.pressure / 1000} min={1} max={200} step={1} precision={1} unit="kPa" disabled={readOnly}
              onChange={(v) => ref('pressure', lim('pressure', v * 1000))} />
            <NumberField label={t('physioUi.settings.o2')} value={r.o2 * 100} min={0} max={100} step={0.5} precision={2} unit="%" disabled={readOnly}
              onChange={(v) => ref('o2', lim('o2', v / 100))} />
            <NumberField label={t('physioUi.settings.co2')} value={r.co2 * 100} min={0} max={30} step={0.01} precision={2} unit="%" disabled={readOnly}
              onChange={(v) => ref('co2', lim('co2', v / 100))} />
            <NumberField label={t('physioUi.settings.waterT')} value={r.waterTemperature - 273.15} min={-2} max={60} step={1} precision={1} unit="°C" disabled={readOnly}
              onChange={(v) => ref('waterTemperature', lim('waterTemperature', v + 273.15))} />
            <div className={styles.note}>{t('physioUi.settings.assumedNote')}</div>
            {!readOnly && (
              <button className={styles.linkBtn} onClick={() => upd({ physiology: { model: 'reduced', ...(ph.zones ? { zones: ph.zones } : {}), ...(ph.people ? { people: ph.people } : {}) } })}>{t('physioUi.settings.reset')}</button>
            )}
          </div>
        </Section>
      )}
      {ph && <div className={styles.note}>{t('physioUi.limitation')}</div>}
    </div>
  );
}

/**
 * Vehicle dynamics (Phase 35): `settings.simulation.vehicles` set / removed (absent = the legacy rigid cars, bit-identical).
 * The per-car entries (controls, programs, autopilot, occupants) are kept while an option changes; switching the model off
 * removes them with it.
 */
function VehicleSettingsBlock({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const vs = useWorldStore((s) => s.doc.settings.simulation.vehicles);
  const upd = useWorldStore.getState().updateSimulationSettings;
  const set = (patch: Partial<VehicleSettings>) => upd({ vehicles: { ...(vs ?? { model: 'dynamics' }), ...patch, model: 'dynamics' } });
  return (
    <div data-testid="vehicle-settings" style={{ display: 'contents' }}>
      <ToggleField label={t('vehicleUi.settings.on')} checked={!!vs} disabled={readOnly} hint={t('vehicleUi.settings.on.hint')}
        onChange={(b) => upd({ vehicles: b ? { model: 'dynamics' } : null })} />
      {vs && (
        <>
          <SelectField<TireModel> label={t('vehicleUi.settings.tire')} value={vs.tire ?? 'saturating'} disabled={readOnly}
            options={(['saturating', 'linear'] as const).map((m) => ({ value: m, label: tireLabel(t, m) }))} onChange={(m) => set({ tire: m })} />
          <ToggleField label={t('vehicleUi.settings.abs')} checked={vs.abs ?? true} disabled={readOnly} hint={t('vehicleUi.settings.abs.hint')} onChange={(b) => set({ abs: b })} />
          <NumberField label={t('vehicleUi.settings.substeps')} value={vs.substeps ?? DEFAULT_SUBSTEPS} min={1} max={32} step={1} precision={0} disabled={readOnly}
            hint={t('vehicleUi.settings.substeps.hint')} onChange={(n) => set({ substeps: Math.min(32, Math.max(1, Math.round(n))) })} />
          <div className={styles.note}>{t('vehicleUi.limitation')}</div>
        </>
      )}
    </div>
  );
}

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
      <div data-testid="human-settings" style={{ display: 'contents' }}>
        <ToggleField label={t('humanUi.settings.extended')} checked={!!sim.humans} disabled={readOnly}
          hint={t('humanUi.settings.extended.hint')} onChange={(b) => setHumanSettings(b ? { model: 'extended', ...(sim.humans?.riskScale !== undefined ? { riskScale: sim.humans.riskScale } : {}) } : null)} />
        {sim.humans && (
          <NumberField label={t('humanUi.settings.riskScale')} value={sim.humans.riskScale ?? 1} min={0.5} max={2} step={0.05} precision={2} unit="×" disabled={readOnly}
            hint={t('humanUi.settings.riskScale.hint')} onChange={(v) => setHumanSettings({ model: 'extended', ...(Math.abs(v - 1) > 1e-9 ? { riskScale: Math.min(2, Math.max(0.5, v)) } : {}) })} />
        )}
        {sim.humans && <div className={styles.note}>{t('humanUi.limitation')}</div>}
      </div>
      <PhysiologySettingsBlock readOnly={readOnly} />
      <VehicleSettingsBlock readOnly={readOnly} />
    </Section>
  );
}
