import { useEffect, useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { WorldObject } from '@/core/model';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { useBuildingDraft } from '@/editor/buildingDraft';
import { useWorldStore } from '@/world/worldStore';
import { BUILDING_PRESETS, hasErrors, presetSpec, validateSpec } from '@/buildings/spec';
import { createDesign, withDesign } from '@/buildings/design';
import { totalHeight } from '@/buildings/generate';
import type { BuildingSpec, FoundationPolicy } from '@/buildings/types';
import type { ConversionNote } from '@/buildings/convert';
import { CUSTOM_BUILDING_ID } from '@/objects/palette';
import {
  addFloorTo, applySpec, convertToModular, designForSpec, enterBuildingEdit, placeCreatorBuilding, removeFloorFrom,
  setAllowUnsupported, setFoundationPolicy, specRegenerates,
} from '@/app/buildingActions';
import { Section } from '@/ui/common/Panel';
import { SelectField, ToggleField } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import { SpecForm } from './SpecForm';
import { AnalysisSummary } from './AnalysisSummary';
import styles from './Building.module.css';

/**
 * Building Creator (Phase 17, left panel "Building" tab). Without a selection: set up a NEW
 * building from a preset / parameters and place it. With a modular building selected: edit its
 * parameters with a live preview (Apply / Cancel), add / remove floors, foundation policy, and
 * open Building Edit Mode for its members. A selected legacy building can be converted.
 */
export function BuildingPanel() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const tool = useEditorStore((s) => s.tool);
  const editId = useEditorStore((s) => s.buildingId);
  const id = tool === 'building' ? editId : selectedIds.length === 1 ? selectedIds[0] : null;
  const obj = useWorldStore((s) => (id ? s.doc.objects[id] : undefined));
  if (mode !== 'editor') return <div className={styles.intro}>{t('building.simLocked')}</div>;
  return (
    <div className={styles.panel} data-testid="building-panel">
      {obj?.type === 'building' && obj.building ? (
        <EditBuilding key={obj.id} obj={obj} />
      ) : (
        <>
          {obj?.type === 'building' && <ConvertLegacy key={obj.id} obj={obj} />}
          <NewBuilding />
        </>
      )}
    </div>
  );
}

function PresetButtons({ active, onPick }: { active: string | null; onPick: (id: string) => void }) {
  const t = useT();
  return (
    <div className={styles.presets} data-testid="building-presets">
      {BUILDING_PRESETS.map((p) => (
        <button key={p.id} className={`${styles.preset} ${active === p.id ? styles.presetOn : ''}`} data-preset={p.id} onClick={() => onPick(p.id)}>
          <span>{t(`building.preset.${p.id}` as MessageKey)}</span>
          <small>{p.spec.width}×{p.spec.depth} m · {t('building.floorsN', { n: p.spec.floors })} · {fmt(totalHeight(p.spec), 0)} m</small>
        </button>
      ))}
    </div>
  );
}

// ── New building ─────────────────────────────────────────────────────

function NewBuilding() {
  const t = useT();
  const creator = useBuildStore((s) => s.creator);
  const placing = useEditorStore((s) => s.placeItemId === CUSTOM_BUILDING_ID);
  const issues = useMemo(() => validateSpec(creator.spec), [creator.spec]);
  const blocked = hasErrors(issues);
  // The preview design follows the parameters (the ghost / placement uses it).
  const design = useMemo(() => (blocked ? null : createDesign(creator.spec, creator.preset ?? undefined)), [creator.spec, creator.preset, blocked]);
  useEffect(() => useBuildStore.getState().setCreator({ design }), [design]);
  const set = (patch: Partial<BuildingSpec>) => useBuildStore.getState().setCreator({ spec: { ...useBuildStore.getState().creator.spec, ...patch } });
  return (
    <>
      <div className={styles.intro}>{t('building.new.intro')}</div>
      <PresetButtons active={creator.preset} onPick={(p) => useBuildStore.getState().setCreator({ spec: presetSpec(p)!, preset: p })} />
      <Section title={t('building.new.params')}>
        <SpecForm spec={creator.spec} issues={issues} onChange={set} />
      </Section>
      <Section title={t('building.analysis')}>
        <AnalysisSummary design={design} />
      </Section>
      <div className={styles.actions}>
        <button className={`${styles.primary} ${styles.grow}`} disabled={blocked} data-testid="building-place" onClick={() => placeCreatorBuilding()}>
          <Icon name="place" size={13} /> {t(placing ? 'building.new.placing' : 'building.new.place')}
        </button>
        {placing && <button onClick={() => useEditorStore.getState().armPlacement(null)}>{t('building.cancel')}</button>}
      </div>
    </>
  );
}

// ── Edit a placed modular building ───────────────────────────────────

function EditBuilding({ obj }: { obj: WorldObject }) {
  const t = useT();
  const d = obj.building!;
  const [spec, setSpec] = useState<BuildingSpec>(d.spec);
  // A different design (undo, member edits, apply) resets the draft.
  useEffect(() => setSpec(d.spec), [d]);
  const issues = useMemo(() => validateSpec(spec), [spec]);
  const blocked = hasErrors(issues);
  const dirty = (Object.keys(spec) as (keyof BuildingSpec)[]).some((k) => spec[k] !== d.spec[k]);
  const draft = useMemo(() => (dirty && !blocked ? designForSpec(d, spec) : null), [d, spec, dirty, blocked]);
  // Preview: the editor draws the draft object in place of the document's until Apply / Cancel.
  useEffect(() => {
    useBuildingDraft.getState().set(draft ? withDesign(obj, draft) : null);
    return () => useBuildingDraft.getState().set(null);
  }, [draft, obj]);
  const regenerates = dirty && specRegenerates(d, spec);
  const apply = () => {
    if (regenerates && d.edits > 0 && !window.confirm(t('building.confirm.regenerate', { n: d.edits }))) return;
    if (applySpec(obj.id, spec)) useBuildingDraft.getState().set(null);
  };
  const tool = useEditorStore((s) => s.tool);
  const report = useBuildingDraft((s) => (s.report?.id === obj.id ? s.report.notes : null));
  return (
    <>
      {report && (
        <Section title={t('building.convert.report')}>
          <ConversionReport notes={report} />
          <button className={styles.grow} onClick={() => useBuildingDraft.getState().setReport(null)}>{t('building.convert.dismiss')}</button>
        </Section>
      )}
      <div className={styles.editing}>
        <span>{t('building.edit.title')} <b>{displayName(obj, t)}</b></span>
        <span className={styles.note}>{t('building.edit.info', { members: d.members.length, edits: d.edits })}{d.convertedFrom ? ` · ${t('building.edit.converted')}` : ''}</span>
        <div className={styles.row}>
          <button data-testid="add-floor" onClick={() => addFloorTo(obj.id)} disabled={dirty}><Icon name="plus" size={12} /> {t('building.addFloor')}</button>
          <button data-testid="remove-floor" onClick={() => removeFloorFrom(obj.id)} disabled={dirty || d.spec.floors <= 1}>− {t('building.removeFloor')}</button>
          {tool !== 'building' && <button data-testid="edit-members" onClick={() => enterBuildingEdit(obj.id)} disabled={dirty}><Icon name="move" size={12} /> {t('building.editMembers')}</button>}
        </div>
      </div>
      <Section title={t('building.edit.params')}>
        <SpecForm spec={spec} issues={issues} onChange={(p) => setSpec({ ...spec, ...p })} />
        {regenerates && d.edits > 0 && <div className={`${styles.issue} ${styles.warning}`}>{t('building.edit.regenerateWarn', { n: d.edits })}</div>}
      </Section>
      <Section title={t('building.foundationSection')}>
        <SelectField<FoundationPolicy> label={t('building.policy')} value={d.options.foundationPolicy}
          options={(['refit', 'preserve'] as const).map((v) => ({ value: v, label: t(`building.policy.${v}` as MessageKey) }))}
          onChange={(v) => setFoundationPolicy(obj.id, v)} />
        <div className={styles.note}>{t(`building.policy.${d.options.foundationPolicy}.hint` as MessageKey)}</div>
        <ToggleField label={t('building.allowUnsupported')} checked={d.options.allowUnsupported} onChange={(v) => setAllowUnsupported(obj.id, v)} hint={t('building.allowUnsupported.hint')} />
      </Section>
      <Section title={t(draft ? 'building.analysis.preview' : 'building.analysis')}>
        <AnalysisSummary design={draft ?? d} />
      </Section>
      {dirty && (
        <div className={styles.actions}>
          <button className={`${styles.primary} ${styles.grow}`} disabled={blocked} data-testid="building-apply" onClick={apply}>{t('building.apply')}</button>
          <button data-testid="building-cancel" onClick={() => setSpec(d.spec)}>{t('building.cancel')}</button>
        </div>
      )}
    </>
  );
}

// ── Legacy conversion ────────────────────────────────────────────────

function ConvertLegacy({ obj }: { obj: WorldObject }) {
  const t = useT();
  const convert = () => {
    const notes = convertToModular(obj.id);
    if (notes) useBuildingDraft.getState().setReport({ id: obj.id, notes });
  };
  return (
    <Section title={t('building.convert.title')}>
      <div className={styles.note}>{t('building.convert.intro', { name: displayName(obj, t) })}</div>
      <div className={styles.row} style={{ marginTop: 6 }}>
        <button data-testid="convert-legacy" onClick={convert}>{t('building.convert.button')}</button>
      </div>
    </Section>
  );
}

export function ConversionReport({ notes }: { notes: readonly ConversionNote[] }) {
  const t = useT();
  return (
    <table className={styles.report} data-testid="conversion-report">
      <tbody>
        {notes.map((n, i) => (
          <tr key={i}>
            <td><span className={`${styles.tag} ${styles[n.level]}`}>{t(`building.convert.level.${n.level}` as MessageKey)}</span></td>
            <td>{t(`building.convert.${n.field}` as MessageKey)}</td>
            <td>{n.before !== undefined ? `${n.before} → ${n.after}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
