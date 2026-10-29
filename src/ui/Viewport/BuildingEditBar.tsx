import { useT, type MessageKey } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useMemberStore } from '@/editor/memberStore';
import { useWorldStore } from '@/world/worldStore';
import { MEMBER_TYPES } from '@/buildings/types';
import { deleteSelectedMembers, duplicateSelectedMembers, exitBuildingEdit } from '@/app/buildingActions';
import { Icon } from '@/ui/common/Icon';
import styles from './ViewportToolbar.module.css';

/** Building Edit Mode toolbar (Phase 17, viewport top): add members, gizmo, snapping, views. */
export function BuildingEditBar() {
  const t = useT();
  const id = useEditorStore((s) => s.buildingId);
  const floors = useWorldStore((s) => (id ? s.doc.objects[id]?.building?.spec.floors ?? 1 : 1));
  const ms = useMemberStore();
  const on = (b: boolean) => `${styles.btn} ${b ? styles.active : ''}`;
  return (
    <div className={styles.bar} role="toolbar" aria-label={t('build.tool.building')} data-testid="building-edit-bar" style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center' }}>
      <button className={on(!ms.adding)} title={t('building.bar.select')} onClick={() => ms.setAdding(null)}><Icon name="cursor" size={15} /></button>
      {MEMBER_TYPES.map((ty) => (
        <button key={ty} className={on(ms.adding === ty)} data-member={ty} title={t('building.bar.add', { type: t(`member.type.${ty}` as MessageKey) })}
          onClick={() => ms.setAdding(ms.adding === ty ? null : ty)} style={{ fontSize: 11, width: 'auto', padding: '0 6px' }}>
          + {t(`member.type.${ty}` as MessageKey)}
        </button>
      ))}
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line-strong)', margin: '2px 3px' }} />
      <button className={on(ms.gizmo === 'translate')} title={`${t('building.bar.move')} (W)`} onClick={() => ms.setGizmo('translate')}><Icon name="move" size={15} /></button>
      <button className={on(ms.gizmo === 'rotate')} title={`${t('building.bar.rotate')} (E)`} onClick={() => ms.setGizmo('rotate')}><Icon name="rotate" size={15} /></button>
      <button className={on(ms.snap.grid)} title={t('building.bar.snapGrid')} onClick={() => ms.setSnap({ grid: !ms.snap.grid })} style={{ fontSize: 10.5, width: 'auto', padding: '0 6px' }}>{t('building.bar.grid')}</button>
      <button className={on(ms.snap.floor)} title={t('building.bar.snapFloor')} onClick={() => ms.setSnap({ floor: !ms.snap.floor })} style={{ fontSize: 10.5, width: 'auto', padding: '0 6px' }}>{t('building.bar.floor')}</button>
      <button className={on(ms.snap.structure)} title={t('building.bar.snapStructure')} onClick={() => ms.setSnap({ structure: !ms.snap.structure })} style={{ fontSize: 10.5, width: 'auto', padding: '0 6px' }}>{t('building.bar.structure')}</button>
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line-strong)', margin: '2px 3px' }} />
      <button className={on(ms.xray)} title={`${t('building.bar.xray')} (X)`} onClick={() => ms.setXray(!ms.xray)}><Icon name="eye" size={15} /></button>
      <button className={on(ms.loadPath)} title={`${t('building.bar.loadPath')} (H)`} data-testid="toggle-load-path" onClick={() => ms.setLoadPath(!ms.loadPath)} style={{ fontSize: 10.5, width: 'auto', padding: '0 6px' }}>{t('building.bar.loadPathShort')}</button>
      <select value={ms.cut ?? ''} title={t('building.bar.cut')} onChange={(e) => ms.setCut(e.target.value === '' ? null : Number(e.target.value))} style={{ height: 26, fontSize: 11, width: 92, padding: '0 4px' }}>
        <option value="">{t('building.bar.allStories')}</option>
        {Array.from({ length: floors }, (_, s) => <option key={s} value={s}>{t('building.bar.upTo', { n: s + 1 })}</option>)}
      </select>
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line-strong)', margin: '2px 3px' }} />
      <button className={styles.btn} title={`${t('inspector.duplicate')} (Ctrl+D)`} disabled={!ms.selected.length} onClick={() => duplicateSelectedMembers()}><Icon name="copy" size={15} /></button>
      <button className={styles.btn} title={`${t('inspector.delete')} (Delete)`} disabled={!ms.selected.length} onClick={() => deleteSelectedMembers()}><Icon name="trash" size={15} /></button>
      <button className={styles.btn} title={`${t('building.members.done')} (Esc)`} onClick={exitBuildingEdit}><Icon name="check" size={15} /></button>
    </div>
  );
}
