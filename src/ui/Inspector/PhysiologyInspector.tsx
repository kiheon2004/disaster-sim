import { Fragment } from 'react';
import { isMessageKey, useT, type MessageKey, type TFunction } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { CAPACITY_LEVELS, type CapacityLevel } from '@/physiology/engine';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { ASSUMED_SOURCES, ESTIMATED_SOURCES, physioRow, PROVENANCE_FIELDS, type PhysioPerson } from '@/simulation/physiology/summary';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

/** Capacity level colours (neutral sequential scale — not a clinical traffic light). */
export const CAP_COLORS = ['#8a8f98', '#9fb7d9', '#d9c27a', '#d99a5b', '#a678d6'] as const;
export const capColor = (l: string) => CAP_COLORS[Math.max(0, CAPACITY_LEVELS.indexOf(l as CapacityLevel))];

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

/** Translated label of a key family with a fallback key (an id is never shown as a raw i18n key). */
function label(t: TFunction, prefix: string, id: string | null | undefined, fallback: MessageKey): string {
  if (id === null || id === undefined) return t('physioUi.notComputed');
  const k = `${prefix}.${id}`;
  return isMessageKey(k) ? t(k) : t(fallback);
}
export const capLabel = (t: TFunction, l: string) => label(t, 'physioUi.cap', l, 'physioUi.cap.other');
export const thermalLabel = (t: TFunction, s: string | null) => label(t, 'physioUi.thermal', s, 'physioUi.thermal.other');
export const airwayLabel = (t: TFunction, s: string | null) => label(t, 'physioUi.airway', s, 'physioUi.airway.other');
export const compLabel = (t: TFunction, c: string) => label(t, 'physioUi.comp', c, 'physioUi.comp.other');
export const activityLabel = (t: TFunction, a: string) => label(t, 'physioUi.act', a, 'physioUi.act.other');
export const clothingLabel = (t: TFunction, c: string) => label(t, 'physioUi.cloth', c, 'physioUi.cloth.other');
export const flagLabel = (t: TFunction, f: string) => label(t, 'physioUi.flag', f, 'physioUi.flag.other');
export const fieldLabel = (t: TFunction, f: string) => label(t, 'physioUi.field', f, 'physioUi.field.other');
/** Provenance code → translated source (dots / plus signs of the sampler codes become underscores in the key). */
export function srcLabel(t: TFunction, code: string | undefined, field?: string): string {
  if (!code) return t('physioUi.src.none');
  if (field === 'zone') return t('physioUi.src.zoneId', { z: code });
  const k = `physioUi.src.${code.replace(/[.+]/g, '_')}`;
  return isMessageKey(k) ? t(k) : t('physioUi.src.other');
}
export const causesLabel = (t: TFunction, cs: readonly string[]) => (cs.length ? cs.map((c) => compLabel(t, c)).join(' · ') : t('physioUi.none'));

/** Value with unit, or "not computed" (never 0 for a missing value). */
export const val = (t: TFunction, x: number | null, d: number, unit = '') => (x === null || !Number.isFinite(x) ? t('physioUi.notComputed') : `${fmt(x, d)}${unit ? ` ${unit}` : ''}`);

/**
 * Physiology of the selected person (Phase 34, live; extended model with physiology on): body temperatures, the air at the
 * person with its source, heat balance, respiration, gas / smoke doses, airway history, body water, fatigue, the
 * physiological and the combined action capacity with the limiting causes, the value sources, model levels and the
 * limitation line. A value the model did not compute reads "not computed", never 0.
 */
export function PhysiologyObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e || !e.physio) return null;
  const r = physioRow(e as PhysioPerson);
  const nc = t('physioUi.notComputed');
  const yn = (b: boolean | null) => (b === null ? nc : b ? t('physioUi.yes') : t('physioUi.no'));
  const p = r.provenance;
  const assumed = (f: string) => (p[f] && ASSUMED_SOURCES.has(p[f]) ? ` (${t('physioUi.assumed')})` : p[f] && ESTIMATED_SOURCES.has(p[f]) ? ` (${t('physioUi.estimated')})` : '');
  const rows: [string, React.ReactNode][] = [
    [t('physioUi.inspect.model'), t('physioUi.model.reduced')],
    [t('physioUi.inspect.core'), val(t, r.core, 2, '°C')],
    [t('physioUi.inspect.skin'), val(t, r.skin, 2, '°C')],
    [t('physioUi.inspect.air'), r.air === null ? nc : `${fmt(r.air, 1)} °C · ${srcLabel(t, p.airT)}`],
    [t('physioUi.inspect.thermalState'), thermalLabel(t, r.thermalState)],
    [t('physioUi.inspect.heat'), r.heatIn === null || r.heatOut === null ? nc : t('physioUi.inspect.heatLine', { i: fmt(r.heatIn, 0), o: fmt(r.heatOut, 0) })],
    [t('physioUi.inspect.breathing'), yn(r.breathing)],
    [t('physioUi.inspect.ventilation'), r.ventilation === null ? nc : t('physioUi.inspect.ventLine', { a: fmt(r.ventilation, 1), d: fmt(r.demand ?? NaN, 1) })],
    [t('physioUi.inspect.supply'), r.supply === null ? nc : fmt(r.supply, 2)],
    [t('physioUi.inspect.fed'), r.fedAsphyxiant === null ? nc : t('physioUi.inspect.fedLine', { co: fmt(r.fedCo!, 3), o2: fmt(r.fedO2!, 3), co2: fmt(r.fedCo2!, 3) })],
    [t('physioUi.inspect.coDose'), val(t, r.coDose, 0, 'ppm·min')],
    [t('physioUi.inspect.heatFed'), val(t, r.fedHeat, 3)],
    [t('physioUi.inspect.smoke'), r.smokeDose === null ? nc : t('physioUi.inspect.smokeLine', { d: fmt(r.smokeDose, 1), m: fmt(r.smokeInhaled!, 2) })],
    [t('physioUi.inspect.airway'), airwayLabel(t, r.airway)],
    [t('physioUi.inspect.airwayTimes'), r.airway === null ? nc : r.airwayFirst === null ? t('physioUi.inspect.airwayNever') : t('physioUi.inspect.airwayLine', { f: fmt(r.airwayFirst, 1), c: fmt(r.airwayCumulative ?? NaN, 1), l: fmt(r.airwayLongest ?? NaN, 1), n: r.submersions ?? 0 })],
    [t('physioUi.inspect.deficit'), val(t, r.deficit, 2, '%')],
    [t('physioUi.inspect.fatigue'), val(t, r.fatigue, 2)],
    [t('physioUi.inspect.capacityPhys'), <span key="cp" style={{ color: capColor(r.capacity) }}>{capLabel(t, r.capacity)}{r.limiting.length ? ` — ${causesLabel(t, r.limiting)}` : ''}</span>],
    [t('physioUi.inspect.capacityCombined'), <span key="cc" style={{ color: capColor(r.combined) }}>{capLabel(t, r.combined)}{r.combinedCauses.length ? ` — ${causesLabel(t, r.combinedCauses)}` : ''}</span>],
    [t('physioUi.inspect.activity'), t('physioUi.inspect.activityLine', { a: activityLabel(t, r.activity), s: activityLabel(t, r.activitySetting), c: clothingLabel(t, r.clothing) })],
  ];
  if (r.frozen) rows.push([t('physioUi.inspect.frozen'), t('physioUi.yes')]);
  if (r.flags.length) rows.push([t('physioUi.inspect.flags'), r.flags.map((f) => flagLabel(t, f)).join(' · ')]);
  const srcRows: [string, React.ReactNode][] = PROVENANCE_FIELDS.filter((f) => p[f] !== undefined).map((f) => [fieldLabel(t, f), `${srcLabel(t, p[f], f)}${assumed(f)}`]);
  return (
    <Section title={t('physioUi.inspect.title')}>
      <Rows testId="physio-object" rows={rows} />
      <Section title={t('physioUi.inspect.sources')} defaultOpen={false}>
        <Rows testId="physio-sources" rows={srcRows.length ? srcRows : [[t('physioUi.inspect.sources'), nc]]} />
        <div className={styles.note}>{t('physioUi.sourcesNote')}</div>
      </Section>
      <Section title={t('physioUi.inspect.advanced')} defaultOpen={false}>
        <Rows testId="physio-advanced" rows={[
          [t('physioUi.inspect.sweat'), val(t, r.sweat, 0, 'g/h')],
          [t('physioUi.inspect.shiver'), val(t, r.shiver, 0, 'W')],
          [t('physioUi.inspect.strain'), val(t, r.strain, 2, 'K')],
          [t('physioUi.inspect.radiant'), val(t, r.qFire, 0, 'W/m²')],
          [t('physioUi.inspect.solar'), val(t, r.qSolar, 0, 'W/m²')],
          [t('physioUi.inspect.immersed'), r.immersed === null ? nc : `${fmt(r.immersed * 100, 0)} %`],
          [t('physioUi.inspect.deposited'), val(t, r.smokeDeposited, 2, 'mg')],
        ]} />
      </Section>
      <div className={styles.note} data-testid="physio-levels">{t('physioUi.levels')}</div>
      <div className={styles.note} data-testid="physio-limitation">{t('physioUi.limitation')}</div>
    </Section>
  );
}
