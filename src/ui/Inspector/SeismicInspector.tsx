import { useMemo } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { FoundationType, StructuralSystem, WorldObject } from '@/core/model';
import type { EntityId } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { buildingHeight, type BuildingParams } from '@/objects/definitions/building';
import { FOUNDATION_TYPE_IDS, STRUCTURAL_SYSTEMS, STRUCTURAL_SYSTEM_IDS, naturalPeriod, seismicOf } from '@/simulation/seismic/structuralProps';
import { simulationController } from '@/simulation/SimulationController';
import { analysisOf } from '@/buildings/design';
import { useSimStore } from '@/simulation/simStore';
import { soilProfile } from '@/terrain/SoilProfiles';
import { Section } from '@/ui/common/Panel';
import { NumberField, SelectField } from '@/ui/common/fields';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

const store = () => useWorldStore.getState();
/** Label scrub = one transaction (Phase 36): one undo step on release, none when nothing changed. */
const scrubTx = { onScrubStart: () => store().beginTransaction(), onScrubEnd: () => { store().commitTransaction(); } };

/** Structural system + foundation of a building (earthquake model parameters). */
export function SeismicSections({ obj, readOnly }: { obj: WorldObject; readOnly: boolean }) {
  const t = useT();
  const terrain = useWorldStore((s) => s.doc.terrain);
  const s = seismicOf(obj);
  const plinth = useMemo(() => foundationPlinth(obj, samplerFor(terrain)), [obj, terrain]);
  if (!s || obj.type !== 'building') return null;
  const p = obj.params as BuildingParams;
  const H = buildingHeight(p) * obj.transform.scale[1];
  // Modular buildings (Phase 17): system, period and strength come from the members.
  const modular = obj.building ? analysisOf(obj.building) : null;
  const T = modular ? Math.max(modular.periodX, modular.periodZ) : naturalPeriod({ ...s.structure, periodOverride: 0 }, H);
  const cy = (modular ? Math.min(modular.cyX, modular.cyZ) : STRUCTURAL_SYSTEMS[s.structure.system].cy) * s.structure.strengthFactor;
  const soil = samplerFor(terrain).sampleSoil(obj.transform.position[0], obj.transform.position[2]);
  const setS = (patch: Partial<typeof s.structure>, live = false) => store().updateSeismic(obj.id, { structure: patch }, { history: !live });
  const setF = (patch: Partial<typeof s.foundation>, live = false) => store().updateSeismic(obj.id, { foundation: patch }, { history: !live });
  const st = s.structure;
  const f = s.foundation;
  return (
    <>
      <Section title={t('inspector.structure')}>
        <SelectField<StructuralSystem> label={t('struct.system')} value={st.system} disabled={readOnly || !!modular}
          options={STRUCTURAL_SYSTEM_IDS.map((v) => ({ value: v, label: t(`struct.system.${v}` as MessageKey) }))}
          onChange={(v) => setS({ system: v, dampingRatio: STRUCTURAL_SYSTEMS[v].damping })} />
        <NumberField label={t('struct.damping')} value={st.dampingRatio} min={0.005} max={0.3} step={0.005} precision={3} disabled={readOnly} {...scrubTx} onChange={(v, live) => setS({ dampingRatio: v }, live)} />
        <NumberField label={t('struct.stiffness')} value={st.stiffnessFactor} min={0.1} max={10} step={0.05} precision={2} unit="×" disabled={readOnly} {...scrubTx} onChange={(v, live) => setS({ stiffnessFactor: v }, live)} />
        <NumberField label={t('struct.strength')} value={st.strengthFactor} min={0.1} max={10} step={0.05} precision={2} unit="×" disabled={readOnly} {...scrubTx} onChange={(v, live) => setS({ strengthFactor: v }, live)} />
        <NumberField label={t('struct.period')} value={st.periodOverride} min={0} max={10} step={0.05} precision={2} unit="s" hint={t('struct.period.hint')} disabled={readOnly} {...scrubTx} onChange={(v, live) => setS({ periodOverride: v }, live)} />
        <div className={styles.note}>{t('struct.period.estimated', { t: fmt(st.periodOverride > 0 ? st.periodOverride : T, 2), cy: fmt(cy, 2) })}</div>
        <div className={styles.note}>{t(modular ? 'struct.modularNote' : 'struct.note')}</div>
      </Section>
      <Section title={t('inspector.foundation')}>
        <SelectField<FoundationType> label={t('found.type')} value={f.type} disabled={readOnly}
          options={FOUNDATION_TYPE_IDS.map((v) => ({ value: v, label: t(`found.type.${v}` as MessageKey) }))}
          onChange={(v) => setF({ type: v })} />
        <NumberField label={t('found.stiffness')} value={f.stiffness} min={0.05} max={20} step={0.05} precision={2} unit="×" disabled={readOnly} {...scrubTx} onChange={(v, live) => setF({ stiffness: v }, live)} />
        <NumberField label={t('found.damping')} value={f.damping} min={0} max={0.5} step={0.01} precision={2} hint={t('found.damping.hint')} disabled={readOnly} {...scrubTx} onChange={(v, live) => setF({ damping: v }, live)} />
        <NumberField label={t('found.anchorage')} value={f.anchorage} min={0.05} max={5} step={0.05} precision={2} unit="×W" hint={t('found.anchorage.hint')} disabled={readOnly} {...scrubTx} onChange={(v, live) => setF({ anchorage: v }, live)} />
        <NumberField label={t('found.groundContact')} value={f.groundContact} min={0.2} max={1} step={0.05} precision={2} disabled={readOnly} {...scrubTx} onChange={(v, live) => setF({ groundContact: v }, live)} />
        <NumberField label={t('found.failure')} value={f.failureThreshold} min={0.1} max={20} step={0.1} precision={1} unit="°" hint={t('found.failure.hint')} disabled={readOnly} {...scrubTx} onChange={(v, live) => setF({ failureThreshold: v }, live)} />
        <div className={styles.note}>{t('found.soil', { soil: t(soil.labelKey) })}{plinth > 0 ? ` · ${t('found.plinth', { m: fmt(plinth, 2) })}` : ''}</div>
      </Section>
    </>
  );
}

/** Live earthquake response of the selected entity (simulation mode). */
export function QuakeLiveSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  const st = e?.seismic;
  if (!e || !st) return null;
  const sr = simulationController.getRuntime()!.seismic!;
  const g = (a: number) => `${fmt(a / GRAVITY, 3)} g`;
  const isBuilding = e.source.type === 'building';
  return (
    <Section title={t('live.quake.title')}>
      <div className={styles.liveGrid}>
        <span>{t('live.quake.groundAcc')}</span><span>{g(Math.hypot(st.ground.a[0], st.ground.a[2]))}</span>
        <span>{t('live.quake.pga')}</span><span>{g(st.pga)}</span>
        <span>{t('live.quake.soil')}</span><span>{t(soilProfile(st.soil).labelKey)}</span>
        {st.unit >= 0 && (
          <>
            <span>{t('live.quake.drift')}</span><span>{fmt(st.drift * 100, 2)} %</span>
            <span>{t('live.quake.peakDrift')}</span><span>{fmt(st.peakDrift * 100, 2)} %</span>
            <span>{t('live.quake.top')}</span><span>{fmt(Math.hypot(st.top[0], st.top[1]) * 100, 1)} cm</span>
            <span>{t('live.quake.peakTop')}</span><span>{fmt(st.peakTop * 100, 1)} cm</span>
            <span>{t('live.quake.floorAcc')}</span><span>{g(st.peakFloorAcc)}</span>
            <span>{t('live.quake.damage')}</span><span>{fmt(st.damage, 2)}</span>
            <span>{t('live.quake.period')}</span><span>{fmt(st.period, 2)} s</span>
            <span>{t('live.quake.freq')}</span><span>{fmt(sr.model.frequency(st.unit), 2)} Hz</span>
          </>
        )}
        {isBuilding && (
          <>
            <span>{t('live.quake.tilt')}</span><span>{fmt((st.tiltMag * 180) / Math.PI, 2)}°</span>
            <span>{t('live.quake.bearing')}</span><span>{fmt(st.bearingRatio, 2)}</span>
            <span>{t('live.quake.slip')}</span><span>{fmt(Math.hypot(st.slip[0], st.slip[1]) * 100, 1)} cm</span>
            {st.plinth > 0 && (<><span>{t('live.quake.plinth')}</span><span>{fmt(st.plinth, 2)} m</span></>)}
          </>
        )}
        {e.source.type === 'human' && (<><span>{t('live.quake.balance')}</span><span>{fmt(Math.max(0, st.balance) * 100, 0)} %</span></>)}
      </div>
      <div className={styles.note}>{t('live.quake.note')}</div>
    </Section>
  );
}
