import { useMemo, useRef, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import {
  alignSelection, copyPropertiesFromPrimary, copySelection, deleteSelection, distributeGapsSelection, distributeSelection, duplicateSelection, groupSelection, matchSelection, selectSameType,
  setSelectionCommon, transformSelection, ungroupSelection,
} from '@/app/buildActions';
import { commonTransform, type CommonField } from '@/editor/build/numericTransform';
import { samplerFor } from '@/terrain/TerrainSampler';
import { NumberField } from '@/ui/common/fields';
import type { AlignRef } from '@/editor/build/groupTransform';
import { COPY_PROPS, copyApplies, type CopyProp } from '@/editor/build/propertyCopy';
import { Segmented } from '@/ui/common/Segmented';
import { displayName } from '@/ui/format';
import { focusPosition } from '@/app/actions';
import { selectionPivot } from '@/editor/build/groupTransform';
import { Icon, type IconName } from '@/ui/common/Icon';
import { Section } from '@/ui/common/Panel';
import styles from './Inspector.module.css';

/** Label scrub = one transaction, as in the single-object Inspector: one undo step on release, none when nothing changed. */
const scrubTx = {
  onScrubStart: () => useWorldStore.getState().beginTransaction(),
  onScrubEnd: () => { useWorldStore.getState().commitTransaction(); },
};

/** The common fields (Phase 37 §17): label key, step, display precision, range and unit — as the single-object fields. */
const COMMON: { field: CommonField; label: MessageKey; step: number; precision: number; min?: number; max?: number; unit?: string }[] = [
  { field: 'x', label: 'p37left.common.x', step: 0.1, precision: 2 },
  { field: 'y', label: 'p37left.common.y', step: 0.1, precision: 2 },
  { field: 'z', label: 'p37left.common.z', step: 0.1, precision: 2 },
  { field: 'lift', label: 'p37left.common.lift', step: 0.1, precision: 2, unit: 'm' },
  { field: 'heading', label: 'p37left.common.heading', step: 1, precision: 1 },
  { field: 'scale', label: 'p37left.common.scale', step: 0.05, precision: 2, min: 0.1, max: 10 },
];

/**
 * Above this many selected objects the fields are not re-read on every frame of a continuous edit (gizmo drag, label
 * scrub): reading "height above ground" seats every object on the terrain. They are read again when the edit ends.
 */
const LIVE_READ_LIMIT = 200;

/**
 * One value for a transform field of every selected object. A field shows the value when all objects agree and is
 * empty ("—") when they differ; a typed value goes to all of them in one undo step (`setSelectionCommon` →
 * `setCommonTransform`, the function the Phase 37 command `set` calls too).
 */
function CommonFields({ ids, objs }: { ids: string[]; objs: WorldObject[] }) {
  const t = useT();
  const terrain = useWorldStore((s) => s.doc.terrain);
  // The history changes when a continuous edit is committed: the moment a large selection is read again.
  const past = useWorldStore((s) => s.past);
  const last = useRef<{ ids: string[]; values: ReturnType<typeof commonTransform> } | null>(null);
  const common = useMemo(() => {
    const kept = last.current;
    if (kept && kept.ids === ids && objs.length > LIVE_READ_LIMIT && useWorldStore.getState().busy()) return kept.values;
    const values = commonTransform(objs, samplerFor(terrain));
    last.current = { ids, values };
    return values;
  }, [ids, objs, terrain, past]); // eslint-disable-line react-hooks/exhaustive-deps
  // A mixed field has no number to step or scrub from: NaN is never a value to apply.
  const set = (field: CommonField, n: number, live: boolean) => { if (Number.isFinite(n)) setSelectionCommon({ [field]: n }, live); };
  return (
    <Section title={t('p37left.common')}>
      {COMMON.map((c) => {
        const v = common[c.field];
        return (
          <NumberField key={c.field} label={t(c.label)} value={v ?? NaN} step={c.step} precision={c.precision} min={c.min} max={c.max} unit={c.unit}
            placeholder={t('p37left.common.mixed')} title={v === null ? t('p37left.common.mixed.title') : undefined} testId={`multi-${c.field}`}
            {...scrubTx} onChange={(n, live) => set(c.field, n, live)} />
        );
      })}
      <div className={styles.note} style={{ marginTop: 6 }}>{t('p37left.common.note')}</div>
    </Section>
  );
}

/** Selection Inspector for several objects (Phase 16): contents, group, align, rotate, edit. */
export function MultiInspector({ ids, readOnly }: { ids: string[]; readOnly: boolean }) {
  const t = useT();
  const objects = useWorldStore((s) => s.doc.objects);
  const transformMode = useEditorStore((s) => s.transformMode);
  const objs = useMemo(() => ids.map((id) => objects[id]).filter((o): o is WorldObject => !!o), [ids, objects]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const o of objs) c.set(o.type, (c.get(o.type) ?? 0) + 1);
    return [...c.entries()];
  }, [objs]);
  const groups = new Set(objs.map((o) => o.group ?? ''));
  const oneGroup = groups.size === 1 && !groups.has('');
  const anyGroup = objs.some((o) => o.group);
  const pivot = selectionPivot(objs);
  const primaryId = useEditorStore((s) => s.selectedId);
  const primary = primaryId ? objects[primaryId] : undefined;
  // Phase 36 §14: alignment states what it lines up — origins (pivots, as before) or footprints (bounds).
  const [ref, setRef] = useState<AlignRef>('origin');
  const [props, setProps] = useState<Set<CopyProp>>(new Set(['params']));
  // How many selected objects each property would reach (the rest are skipped as incompatible).
  const reach = (p: CopyProp) => (primary ? objs.filter((o) => copyApplies(p, primary, o)).length : 0);

  const align: [IconName, MessageKey, () => void][] = [
    ['alignStart', 'multi.align.xmin', () => alignSelection('x', 'min', ref)],
    ['alignCenter', 'multi.align.xcenter', () => alignSelection('x', 'center', ref)],
    ['alignEnd', 'multi.align.xmax', () => alignSelection('x', 'max', ref)],
    ['alignStart', 'multi.align.zmin', () => alignSelection('z', 'min', ref)],
    ['alignCenter', 'multi.align.zcenter', () => alignSelection('z', 'center', ref)],
    ['alignEnd', 'multi.align.zmax', () => alignSelection('z', 'max', ref)],
  ];

  return (
    <div data-testid="multi-inspector">
      <div className={styles.header}>
        <div className={styles.typeIcon}><Icon name="group" size={18} /></div>
        <div className={styles.titleCol}>
          <b>{t('multi.title', { count: objs.length })}</b>
          <span className={styles.sub}>{oneGroup ? t('multi.grouped') : `${pivot.x.toFixed(1)}, ${pivot.z.toFixed(1)}`}</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.iconBtn} title={t('inspector.focus')} onClick={() => focusPosition([pivot.x, pivot.y, pivot.z])}><Icon name="focus" size={15} /></button>
          {!readOnly && (
            <>
              <button className={styles.iconBtn} title={`${t('build.tool.copy')} (Ctrl/⌘+C)`} onClick={() => copySelection()}><Icon name="paste" size={15} /></button>
              <button className={styles.iconBtn} title={`${t('inspector.duplicate')} (Ctrl/⌘+D)`} onClick={duplicateSelection}><Icon name="copy" size={15} /></button>
              <button className={`${styles.iconBtn} ${styles.danger}`} title={`${t('inspector.delete')} (Delete)`} onClick={deleteSelection}><Icon name="trash" size={15} /></button>
            </>
          )}
        </div>
      </div>
      <Section title={t('multi.types')}>
        <div className={styles.stats}>
          {counts.map(([type, n]) => (
            <span key={type} style={{ display: 'contents' }}>
              <span>{t(getDefinition(type as WorldObject['type']).labelKey)}</span>
              <span>{n}</span>
            </span>
          ))}
        </div>
      </Section>
      {!readOnly && (
        <>
          <CommonFields ids={ids} objs={objs} />
          <Section title={t('object.group')}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className={styles.smallBtn} disabled={oneGroup} onClick={groupSelection}><Icon name="group" size={12} /> {t('multi.group')} (Ctrl+G)</button>
              <button className={styles.smallBtn} disabled={!anyGroup} onClick={ungroupSelection}>{t('multi.ungroup')} (Ctrl+Shift+G)</button>
            </div>
            <div className={styles.note} style={{ marginTop: 6 }}>{t('multi.physicsNote')}</div>
          </Section>
          <Section title={t('multi.align')}>
            <Segmented<AlignRef> size="small" ariaLabel={t('ed36.align.ref')} value={ref} onChange={setRef}
              options={[{ value: 'origin', label: t('ed36.align.origin') }, { value: 'bounds', label: t('ed36.align.bounds') }]} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginTop: 6 }}>
              {align.map(([icon, key, fn], i) => (
                <button key={key} className={styles.smallBtn} title={t(key)} aria-label={t(key)} onClick={fn} disabled={objs.length < 2}>
                  <Icon name={icon} size={13} style={i >= 3 ? { transform: 'rotate(90deg)' } : undefined} /> {i < 3 ? 'X' : 'Z'}
                </button>
              ))}
              <button className={styles.smallBtn} onClick={() => distributeSelection('x')} disabled={objs.length < 3} title={t('multi.distribute.x')}><Icon name="distribute" size={13} /> X</button>
              <button className={styles.smallBtn} onClick={() => distributeSelection('z')} disabled={objs.length < 3} title={t('multi.distribute.z')}><Icon name="distribute" size={13} style={{ transform: 'rotate(90deg)' }} /> Z</button>
              <button className={styles.smallBtn} onClick={() => distributeGapsSelection('x')} disabled={objs.length < 3} title={t('ed36.gaps.x')} data-testid="gaps-x">{t('ed36.gaps')} X</button>
              <button className={styles.smallBtn} onClick={() => distributeGapsSelection('z')} disabled={objs.length < 3} title={t('ed36.gaps.z')} data-testid="gaps-z">{t('ed36.gaps')} Z</button>
            </div>
            <div className={styles.note} style={{ marginTop: 6 }}>{t(ref === 'bounds' ? 'ed36.align.bounds.note' : 'ed36.align.origin.note')}</div>
          </Section>
          <Section title={t('ed36.copy')}>
            <div className={styles.note}>{t('ed36.match.ref', { name: primary ? displayName(primary, t) : '—' })}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 8px', marginTop: 6, fontSize: 12 }}>
              {COPY_PROPS.map((p) => (
                <label key={p} style={{ display: 'contents' }}>
                  <span><input type="checkbox" checked={props.has(p)} data-testid={`copy-${p}`}
                    onChange={(e) => { const s = new Set(props); if (e.target.checked) s.add(p); else s.delete(p); setProps(s); }} /> {t(`ed36.copy.${p}` as MessageKey)}</span>
                  <span className={styles.note}>{reach(p)}/{objs.length - 1}</span>
                </label>
              ))}
            </div>
            <button className={styles.smallBtn} style={{ marginTop: 6 }} disabled={!primary || !props.size} data-testid="copy-apply"
              onClick={() => copyPropertiesFromPrimary(props)}>{t('ed36.copy.apply')}</button>
          </Section>
          <Section title={t('ed36.match')}>
            <div className={styles.note}>{t('ed36.match.ref', { name: primary ? displayName(primary, t) : '—' })}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <button className={styles.smallBtn} disabled={!primary} onClick={() => matchSelection('rotation')} data-testid="match-rotation">{t('ed36.match.rotation')}</button>
              <button className={styles.smallBtn} disabled={!primary} onClick={() => matchSelection('height')} data-testid="match-height">{t('ed36.match.height')}</button>
              <button className={styles.smallBtn} disabled={!primary} onClick={() => matchSelection('scale')} data-testid="match-scale">{t('ed36.match.scale')}</button>
              <button className={styles.smallBtn} disabled={!primary} onClick={() => selectSameType()} data-testid="select-same">{t('ed36.sameType')}</button>
            </div>
          </Section>
          <Section title={t('multi.rotate')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={styles.smallBtn} onClick={() => transformSelection({ dx: 0, dy: 0, dz: 0, dyaw: Math.PI / 2 })}>↺ {t('multi.rotateLeft')}</button>
              <button className={styles.smallBtn} onClick={() => transformSelection({ dx: 0, dy: 0, dz: 0, dyaw: -Math.PI / 2 })}>↻ {t('multi.rotateRight')}</button>
            </div>
            {transformMode === 'scale' && <div className={styles.note} style={{ marginTop: 6 }}>{t('multi.scaleNote')}</div>}
          </Section>
        </>
      )}
    </div>
  );
}
