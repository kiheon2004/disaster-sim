import type { ReactNode } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { StructuralSystem } from '@/core/model';
import { FACADE_STYLES, OCCUPANCIES, ROOF_TYPES, type BuildingSpec, type FacadeStyle, type Occupancy, type RoofType } from '@/buildings/types';
import { MATERIAL_IDS, MATERIALS, type MaterialId } from '@/buildings/materials';
import { SPEC_LIMITS, SYSTEMS, SYSTEM_MATERIALS, type SpecIssue } from '@/buildings/spec';
import { totalHeight } from '@/buildings/generate';
import { ColorField, NumberField, SelectField, ToggleField } from '@/ui/common/fields';
import { fmt } from '@/ui/format';
import styles from './Building.module.css';

/** Issues of one field, under it. */
function Issues({ issues, field }: { issues: readonly SpecIssue[]; field: SpecIssue['field'] }) {
  const t = useT();
  const list = issues.filter((i) => i.field === field);
  if (!list.length) return null;
  return (
    <>
      {list.map((i, k) => (
        <div key={k} className={`${styles.issue} ${styles[i.level]}`}>{t(`building.issue.${i.code}` as MessageKey, i.params)}</div>
      ))}
    </>
  );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>{title}</div>
      {children}
    </div>
  );
}

/**
 * Parametric building inputs (SI units). Values are not clamped silently: anything out of range
 * shows an error under the field and blocks Apply / Place (SPEC_LIMITS).
 */
export function SpecForm({ spec, issues, onChange, disabled = false }: { spec: BuildingSpec; issues: readonly SpecIssue[]; onChange: (patch: Partial<BuildingSpec>) => void; disabled?: boolean }) {
  const t = useT();
  const mat = (ids: readonly MaterialId[]) => ids.map((v) => ({ value: v, label: t(`material.${v}` as MessageKey) }));
  const structural = MATERIAL_IDS.filter((m) => MATERIALS[m].structural);
  const num = (key: keyof typeof SPEC_LIMITS & keyof BuildingSpec, label: MessageKey, step: number, unit?: string, precision = 1) => (
    <>
      <NumberField label={t(label)} value={spec[key] as number} step={step} precision={precision} unit={unit} disabled={disabled}
        onChange={(v, live) => !live && onChange({ [key]: v } as Partial<BuildingSpec>)} />
      <Issues issues={issues} field={key} />
    </>
  );
  return (
    <div data-testid="spec-form">
      <Group title={t('building.group.size')}>
        {num('width', 'building.field.width', 0.5, 'm')}
        {num('depth', 'building.field.depth', 0.5, 'm')}
        {num('floors', 'building.field.floors', 1, undefined, 0)}
        {num('floorHeight', 'building.field.floorHeight', 0.1, 'm')}
        {num('groundFloorHeight', 'building.field.groundFloorHeight', 0.1, 'm')}
        <div className={styles.note}>{t('building.field.totalHeight', { h: fmt(totalHeight(spec), 1) })}</div>
        <Issues issues={issues} field="height" />
      </Group>
      <Group title={t('building.group.structure')}>
        <SelectField<StructuralSystem> label={t('building.field.system')} value={spec.system} disabled={disabled}
          options={SYSTEMS.map((v) => ({ value: v, label: t(`struct.system.${v}` as MessageKey) }))}
          onChange={(v) => onChange({ system: v, structureMaterial: SYSTEM_MATERIALS[v].structure, slabMaterial: SYSTEM_MATERIALS[v].slab, claddingMaterial: SYSTEM_MATERIALS[v].cladding })} />
        <SelectField<MaterialId> label={t('building.field.structureMaterial')} value={spec.structureMaterial} disabled={disabled} options={mat(structural)} onChange={(v) => onChange({ structureMaterial: v })} />
        <Issues issues={issues} field="structureMaterial" />
        <SelectField<MaterialId> label={t('building.field.slabMaterial')} value={spec.slabMaterial} disabled={disabled} options={mat(structural)} onChange={(v) => onChange({ slabMaterial: v })} />
        <Issues issues={issues} field="slabMaterial" />
        {num('bay', 'building.field.bay', 0.5, 'm')}
        <ToggleField label={t('building.field.core')} checked={spec.core} disabled={disabled} onChange={(v) => onChange({ core: v })} />
        <Issues issues={issues} field="core" />
        <SelectField label={t('building.field.foundation')} value={spec.foundation} disabled={disabled}
          options={(['spread', 'mat', 'pile'] as const).map((v) => ({ value: v, label: t(`found.type.${v}` as MessageKey) }))} onChange={(v) => onChange({ foundation: v })} />
        <Issues issues={issues} field="foundation" />
        <Issues issues={issues} field="floors" />
        <SelectField<Occupancy> label={t('building.field.occupancy')} value={spec.occupancy} disabled={disabled}
          options={OCCUPANCIES.map((v) => ({ value: v, label: t(`building.occupancy.${v}` as MessageKey) }))} onChange={(v) => onChange({ occupancy: v })} />
      </Group>
      <Group title={t('building.group.roof')}>
        <SelectField<RoofType> label={t('building.field.roof')} value={spec.roof} disabled={disabled}
          options={ROOF_TYPES.map((v) => ({ value: v, label: t(`building.roof.${v}` as MessageKey) }))} onChange={(v) => onChange({ roof: v })} />
        {spec.roof !== 'flat' && num('roofPitch', 'building.field.roofPitch', 1, '°', 0)}
        {spec.roof !== 'flat' && <ToggleField label={t('building.field.ceiling')} checked={spec.ceiling} disabled={disabled} onChange={(v) => onChange({ ceiling: v })} />}
      </Group>
      <Group title={t('building.group.facade')}>
        <SelectField<MaterialId> label={t('building.field.claddingMaterial')} value={spec.claddingMaterial} disabled={disabled} options={mat(MATERIAL_IDS)} onChange={(v) => onChange({ claddingMaterial: v })} />
        <SelectField<FacadeStyle> label={t('building.field.facade')} value={spec.facade} disabled={disabled}
          options={FACADE_STYLES.map((v) => ({ value: v, label: t(`building.facade.${v}` as MessageKey) }))} onChange={(v) => onChange({ facade: v })} />
        {num('windowDensity', 'building.field.windowDensity', 0.05, undefined, 2)}
        <ColorField label={t('building.field.color')} value={spec.color} disabled={disabled} onChange={(v) => onChange({ color: v })} />
        <ToggleField label={t('param.sign')} checked={spec.sign} disabled={disabled} onChange={(v) => onChange({ sign: v })} />
        {num('rooftopUnits', 'param.rooftopUnits', 1, undefined, 0)}
      </Group>
    </div>
  );
}
