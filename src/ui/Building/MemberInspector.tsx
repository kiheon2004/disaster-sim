import { useMemo } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { Vec3 } from '@/core/types';
import { useEditorStore } from '@/editor/editorStore';
import { useMemberStore } from '@/editor/memberStore';
import { useWorldStore } from '@/world/worldStore';
import { analysisOf } from '@/buildings/design';
import { MATERIAL_IDS, MATERIALS, type MaterialId } from '@/buildings/materials';
import { ROLES_BY_TYPE, memberUid, type MemberType, type StructuralRole } from '@/buildings/types';
import { TYPE_SWAPS } from '@/buildings/edit';
import { setMemberPosition, setMemberYaw, setSelectedType } from '@/app/buildingActions';
import {
  deleteSelectedMembers, duplicateSelectedMembers, exitBuildingEdit, setMemberSize, setSelectedInitialDamage, setSelectedMaterial, setSelectedRole,
} from '@/app/buildingActions';
import { Section } from '@/ui/common/Panel';
import { NumberField, SelectField, SliderField, Vec3Field } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import { AnalysisRows, WarningList } from './AnalysisSummary';
import { StructurePreview } from './StructurePreview';
import styles from './Building.module.css';

/**
 * Inspector of Building Edit Mode (Phase 17): the selected member(s) — type, structural role,
 * material, size, pre-existing damage — and what the simplified model computes for them
 * (mass, load carried, utilization, supports, lateral contribution, drift capacity).
 */
export function MemberInspector() {
  const t = useT();
  const id = useEditorStore((s) => s.buildingId);
  const obj = useWorldStore((s) => (id ? s.doc.objects[id] : undefined));
  const selected = useMemberStore((s) => s.selected);
  const d = obj?.building;
  const a = useMemo(() => (d ? analysisOf(d) : null), [d]);
  if (!obj || !d || !a) return null;
  const idx = selected.map((s) => d.members.findIndex((m) => m.id === s)).filter((i) => i >= 0);
  return (
    <div data-testid="member-inspector">
      <div className={styles.editing}>
        <span>{t('building.edit.title')} <b>{displayName(obj, t)}</b></span>
        <span className={styles.note}>{t('building.members.help')}</span>
        <div className={styles.row}>
          <button onClick={exitBuildingEdit} data-testid="exit-building-edit"><Icon name="check" size={12} /> {t('building.members.done')}</button>
        </div>
      </div>
      {idx.length === 0 && (
        <Section title={t('building.analysis')}>
          <AnalysisRows a={a} design={d} />
          <WarningList warnings={a.warnings} />
        </Section>
      )}
      {idx.length === 1 && <OneMember buildingId={obj.id} index={idx[0]} />}
      {idx.length > 1 && <ManyMembers indices={idx} />}
    </div>
  );
}

function OneMember({ buildingId, index }: { buildingId: string; index: number }) {
  const t = useT();
  const obj = useWorldStore((s) => s.doc.objects[buildingId]);
  const d = obj.building!;
  const m = d.members[index];
  const a = analysisOf(d);
  const ma = a.members[index];
  const mat = MATERIALS[m.material];
  const supportIds = ma.supports.map((j) => d.members[j].id);
  return (
    <>
      <Section title={`${t(`member.type.${m.type}` as MessageKey)} · ${m.id}`}>
        <div className={styles.note} style={{ marginBottom: 6 }}>{t('building.members.uid', { uid: memberUid(buildingId, m.id) })}</div>
        {(TYPE_SWAPS[m.type] ?? []).length > 0 && (
          <SelectField<MemberType> label={t('ed36.member.type')} value={m.type}
            options={[m.type, ...(TYPE_SWAPS[m.type] ?? [])].map((v) => ({ value: v, label: t(`member.type.${v}` as MessageKey) }))} onChange={(v) => setSelectedType(v)} />
        )}
        <SelectField<StructuralRole> label={t('building.members.role')} value={m.role}
          options={ROLES_BY_TYPE[m.type].map((r) => ({ value: r, label: t(`role.${r}` as MessageKey) }))} onChange={(r) => setSelectedRole(r)} />
        <div className={styles.note}>{t(`role.${m.role}.hint` as MessageKey)}</div>
        <SelectField<MaterialId> label={t('building.members.material')} value={m.material}
          options={MATERIAL_IDS.map((v) => ({ value: v, label: t(`material.${v}` as MessageKey) }))} onChange={(v) => setSelectedMaterial(v)} />
        <Vec3Field label={t('building.members.size')} value={m.size} step={0.05} precision={2} min={0.02} max={200}
          onChange={(v, live) => !live && setMemberSize(m.id, v as Vec3)} />
        {/* Phase 36 §36: exact position (building-local) and heading, validated like a gizmo move. */}
        <Vec3Field label={t('ed36.member.position')} value={m.position} step={0.05} precision={2}
          onChange={(v, live) => !live && setMemberPosition(m.id, v as Vec3)} />
        <NumberField label={t('ed36.member.yaw')} value={Math.round((m.rotation[1] * 180) / Math.PI * 10) / 10} step={15} precision={1} unit="°"
          onChange={(v, live) => !live && setMemberYaw(m.id, v)} />
        <div className={styles.summary}>
          <span>{t('building.members.level')}</span><span>{m.level < 0 ? t('building.members.foundationLevel') : m.level >= d.spec.floors ? t('building.members.roofLevel') : t('building.storyN', { n: m.level + 1 })}</span>
          {m.host && (<><span>{t('building.members.host')}</span><span>{m.host}</span></>)}
        </div>
        <SliderField label={t('building.members.initialDamage')} value={m.initialDamage ?? 0} min={0} max={1} step={0.05} precision={2}
          onChange={(v) => setSelectedInitialDamage(v)} />
        <div className={styles.note}>{t('building.members.initialDamage.hint')}</div>
      </Section>
      <Section title={t('building.members.model')}>
        <div className={styles.summary} data-testid="member-model">
          <span>{t('building.members.mass')}</span><span>{fmt(ma.mass, 0)} kg</span>
          <span>{t('building.members.supported')}</span><span className={ma.supported ? '' : styles.worse}>{t(ma.supported ? 'building.yes' : 'building.no')}</span>
          <span>{t('building.members.supports')}</span><span>{supportIds.length ? supportIds.slice(0, 4).join(', ') + (supportIds.length > 4 ? ' …' : '') : ma.ground ? t('building.members.ground') : '—'}</span>
          <span>{t('building.members.load')}</span><span>{fmt(ma.load / 1000, 1)} kN</span>
          {ma.bearing && (<><span>{t('building.members.utilization')}</span><span className={ma.utilization > 1 ? styles.worse : ''}>{fmt(ma.utilization, 2)}</span></>)}
          {(ma.kx > 0 || ma.kz > 0) && (
            <>
              <span>{t('building.members.lateralK')}</span><span>{fmt(ma.kx / 1e6, 1)} / {fmt(ma.kz / 1e6, 1)} MN/m</span>
              <span>{t('building.members.lateralV')}</span><span>{fmt(ma.vx / 1e3, 0)} / {fmt(ma.vz / 1e3, 0)} kN</span>
              <span>{t('building.members.drift')}</span><span>{fmt(ma.driftCapacity * 100, 2)} %</span>
            </>
          )}
          <span>{t('building.members.failure')}</span><span>{t(`building.failure.${mat.failure}` as MessageKey)}</span>
        </div>
        {!mat.structural && m.role !== 'cladding' && m.role !== 'opening' && m.role !== 'roofing' && m.role !== 'nonStructural' && (
          <div className={`${styles.warn} ${styles.warning}`} style={{ marginTop: 6 }}>{t('building.members.nonStructural')}</div>
        )}
        <div className={styles.note} style={{ marginTop: 6 }}>{t('building.members.modelNote')}</div>
      </Section>
      <StructurePreview design={d} ids={[m.id]} />
      <Actions />
    </>
  );
}

function ManyMembers({ indices }: { indices: number[] }) {
  const t = useT();
  const id = useEditorStore((s) => s.buildingId)!;
  const d = useWorldStore((s) => s.doc.objects[id].building!);
  const counts: Record<string, number> = {};
  for (const i of indices) counts[d.members[i].type] = (counts[d.members[i].type] ?? 0) + 1;
  const types = Object.keys(counts) as (keyof typeof ROLES_BY_TYPE)[];
  const commonRoles = ROLES_BY_TYPE[types[0]].filter((r) => types.every((ty) => (ROLES_BY_TYPE[ty] as readonly string[]).includes(r)));
  return (
    <>
      <Section title={t('building.members.many', { n: indices.length })}>
        <div className={styles.note}>{types.map((ty) => `${t(`member.type.${ty}` as MessageKey)} ${counts[ty]}`).join(' · ')}</div>
        <SelectField<MaterialId | ''> label={t('building.members.material')} value=""
          options={[{ value: '', label: '—' }, ...MATERIAL_IDS.map((v) => ({ value: v as MaterialId | '', label: t(`material.${v}` as MessageKey) }))]}
          onChange={(v) => v && setSelectedMaterial(v)} />
        {commonRoles.length > 1 && (
          <SelectField<StructuralRole | ''> label={t('building.members.role')} value=""
            options={[{ value: '', label: '—' }, ...commonRoles.map((r) => ({ value: r as StructuralRole | '', label: t(`role.${r}` as MessageKey) }))]}
            onChange={(v) => v && setSelectedRole(v)} />
        )}
        <SliderField label={t('building.members.initialDamage')} value={0} min={0} max={1} step={0.05} precision={2} onChange={(v) => setSelectedInitialDamage(v)} />
      </Section>
      <StructurePreview design={d} ids={indices.map((i) => d.members[i].id)} />
      <Actions />
    </>
  );
}

function Actions() {
  const t = useT();
  return (
    <div className={styles.actions}>
      <button onClick={() => duplicateSelectedMembers()} data-testid="member-duplicate"><Icon name="copy" size={12} /> {t('inspector.duplicate')}</button>
      <button onClick={() => deleteSelectedMembers()} data-testid="member-delete"><Icon name="trash" size={12} /> {t('inspector.delete')}</button>
    </div>
  );
}
