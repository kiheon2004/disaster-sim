import { useMemo } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import {
  alignSelection, copySelection, deleteSelection, distributeSelection, duplicateSelection, groupSelection, transformSelection, ungroupSelection,
} from '@/app/buildActions';
import { focusPosition } from '@/app/actions';
import { selectionPivot } from '@/editor/build/groupTransform';
import { Icon, type IconName } from '@/ui/common/Icon';
import { Section } from '@/ui/common/Panel';
import styles from './Inspector.module.css';

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

  const align: [IconName, MessageKey, () => void][] = [
    ['alignStart', 'multi.align.xmin', () => alignSelection('x', 'min')],
    ['alignCenter', 'multi.align.xcenter', () => alignSelection('x', 'center')],
    ['alignEnd', 'multi.align.xmax', () => alignSelection('x', 'max')],
    ['alignStart', 'multi.align.zmin', () => alignSelection('z', 'min')],
    ['alignCenter', 'multi.align.zcenter', () => alignSelection('z', 'center')],
    ['alignEnd', 'multi.align.zmax', () => alignSelection('z', 'max')],
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
          <Section title={t('object.group')}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className={styles.smallBtn} disabled={oneGroup} onClick={groupSelection}><Icon name="group" size={12} /> {t('multi.group')} (Ctrl+G)</button>
              <button className={styles.smallBtn} disabled={!anyGroup} onClick={ungroupSelection}>{t('multi.ungroup')} (Ctrl+Shift+G)</button>
            </div>
            <div className={styles.note} style={{ marginTop: 6 }}>{t('multi.physicsNote')}</div>
          </Section>
          <Section title={t('multi.align')}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
              {align.map(([icon, key, fn], i) => (
                <button key={key} className={styles.smallBtn} title={t(key)} aria-label={t(key)} onClick={fn} disabled={objs.length < 2}>
                  <Icon name={icon} size={13} style={i >= 3 ? { transform: 'rotate(90deg)' } : undefined} /> {i < 3 ? 'X' : 'Z'}
                </button>
              ))}
              <button className={styles.smallBtn} onClick={() => distributeSelection('x')} disabled={objs.length < 3} title={t('multi.distribute.x')}><Icon name="distribute" size={13} /> X</button>
              <button className={styles.smallBtn} onClick={() => distributeSelection('z')} disabled={objs.length < 3} title={t('multi.distribute.z')}><Icon name="distribute" size={13} style={{ transform: 'rotate(90deg)' }} /> Z</button>
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
