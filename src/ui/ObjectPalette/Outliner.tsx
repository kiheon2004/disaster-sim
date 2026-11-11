/**
 * Scene outliner (Phase 36 §42–44): every object of the world, searchable and filterable, with editing groups as
 * collapsible nodes. Rows select (click; Shift / Ctrl/⌘ toggle; Alt = this object only), focus the camera (double-click),
 * rename, hide (editor view only — the object still exists and is simulated) and lock (not picked in the viewport, not
 * moved or deleted). Long lists are windowed: only the visible rows are rendered (5000 objects stay cheap).
 */
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import type { EntityId, ObjectCategory } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { useT, type MessageKey } from '@/i18n/i18n';
import { CATEGORY_ORDER } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { clearSelection, clickSelect, expandGroups, selectSameType, setObjectFlags } from '@/app/buildActions';
import { focusObject, focusSelection } from '@/app/actions';
import { Icon, type IconName } from '@/ui/common/Icon';
import { displayName } from '@/ui/format';
import { StateDot } from '@/ui/common/StateBadge';
import { useEntityStates } from '@/ui/useEntityStates';
import styles from './ObjectPalette.module.css';

type Filter = 'all' | ObjectCategory | 'hidden' | 'locked';
type Row = { kind: 'group'; id: string; name: string; members: WorldObject[] } | { kind: 'object'; obj: WorldObject; depth: 0 | 1 };

const ROW_H = 26;
const OVERSCAN = 8;

export function Outliner() {
  const t = useT();
  const objects = useWorldStore((s) => s.doc.objects);
  const groupNames = useWorldStore((s) => s.doc.groups);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const states = useEntityStates();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const box = useRef<HTMLDivElement | null>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const all = useMemo(() => Object.values(objects).sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial), [objects]);
  const cats = useMemo(() => CATEGORY_ORDER.filter((c) => all.some((o) => getDefinition(o.type).category === c)), [all]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => all.filter((o) => {
    if (filter === 'hidden' ? !o.hidden : filter === 'locked' ? !o.locked : filter !== 'all' && getDefinition(o.type).category !== filter) return false;
    if (!q) return true;
    return displayName(o, t).toLowerCase().includes(q) || t(getDefinition(o.type).labelKey).toLowerCase().includes(q) || o.id.toLowerCase().includes(q);
  }), [all, filter, q, t]);

  // Groups first (by first member), each followed by its members unless collapsed; then the ungrouped objects.
  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, WorldObject[]>();
    const loose: WorldObject[] = [];
    for (const o of shown) {
      if (o.group) (groups.get(o.group) ?? groups.set(o.group, []).get(o.group)!).push(o);
      else loose.push(o);
    }
    const out: Row[] = [];
    let n = 0;
    for (const [id, members] of groups) {
      n++;
      out.push({ kind: 'group', id, name: groupNames?.[id]?.name ?? t('ed36.group.unnamed', { n }), members });
      if (!collapsed.has(id)) for (const o of members) out.push({ kind: 'object', obj: o, depth: 1 });
    }
    for (const o of loose) out.push({ kind: 'object', obj: o, depth: 0 });
    return out;
  }, [shown, collapsed, groupNames, t]);

  if (!all.length) return <div className={styles.empty}>{t('outliner.empty')}</div>;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const pick = (id: EntityId, e: React.MouseEvent) => {
    if (!editing) return useEditorStore.getState().select(id);
    clickSelect(id, { shift: e.shiftKey, alt: e.altKey, toggle: e.ctrlKey || e.metaKey });
  };
  const toggle = (set: Set<string>, id: string) => { const s = new Set(set); if (s.has(id)) s.delete(id); else s.add(id); return s; };
  const flagBtn = (ids: EntityId[], on: boolean, flag: 'hidden' | 'locked', label: MessageKey) => (
    <button type="button" className={`${styles.rowBtn} ${on ? styles.rowBtnOn : ''}`} disabled={!editing} aria-pressed={on} title={t(label)} aria-label={t(label)}
      data-testid={`outliner-${flag}`}
      onClick={(e) => { e.stopPropagation(); setObjectFlags(ids, { [flag]: !on }); }}>
      <Icon name={flag === 'hidden' ? (on ? 'eyeOff' : 'eye') : (on ? 'lock' : 'unlock')} size={12} />
    </button>
  );

  return (
    <>
      <div className={styles.outlinerBar}>
        <input className={styles.search} type="search" value={query} placeholder={t('ed36.outliner.search')} aria-label={t('ed36.outliner.search')}
          data-testid="outliner-search" onChange={(e) => setQuery(e.target.value)} />
        <select className={styles.filter} value={filter} aria-label={t('ed36.outliner.filter')} data-testid="outliner-filter" onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">{t('ed36.outliner.all')}</option>
          {cats.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          <option value="hidden">{t('ed36.outliner.hidden')}</option>
          <option value="locked">{t('ed36.outliner.locked')}</option>
        </select>
      </div>
      {editing && (
        <div className={styles.chips}>
          <button className={styles.chip} disabled={!shown.length} data-testid="outliner-select-shown"
            onClick={() => useEditorStore.getState().setSelection(shown.filter((o) => !o.hidden).map((o) => o.id))}>{t('ed36.outliner.selectShown', { n: shown.length })}</button>
          <button className={styles.chip} disabled={!selectedIds.length} onClick={() => selectSameType()}>{t('ed36.sameType')}</button>
          <button className={styles.chip} disabled={!selectedIds.length} onClick={() => focusSelection()}>{t('ed36.outliner.frame')}</button>
          <button className={styles.chip} disabled={!selectedIds.length} onClick={clearSelection}>{t('outliner.clear')}</button>
        </div>
      )}
      <div ref={(el) => { box.current = el; if (el && el.clientHeight && el.clientHeight !== height) setHeight(el.clientHeight); }}
        className={`${styles.scroll} ${styles.list}`} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} data-testid="outliner-list"
        role="tree" aria-label={t('ed36.outliner.tree')}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((r, i) => {
            const style: CSSProperties = { position: 'absolute', top: (first + i) * ROW_H, left: 0, right: 0, height: ROW_H };
            if (r.kind === 'group') {
              const ids = r.members.map((o) => o.id);
              const allSel = ids.every((id) => selected.has(id));
              const open = !collapsed.has(r.id);
              return (
                <div key={`g:${r.id}`} style={style} role="treeitem" aria-expanded={open} aria-selected={allSel}
                  className={`${styles.item} ${styles.groupRow} ${allSel ? styles.sel : ''}`} data-testid="outliner-group"
                  onClick={(e) => editing && (e.shiftKey || e.ctrlKey || e.metaKey ? clickSelect(ids[0], { toggle: true }) : useEditorStore.getState().setSelection(expandGroups(ids)))}
                  onDoubleClick={() => { useEditorStore.getState().setSelection(ids); focusSelection(); }}>
                  <button type="button" className={styles.rowBtn} aria-label={t(open ? 'ed36.outliner.collapse' : 'ed36.outliner.expand')}
                    onClick={(e) => { e.stopPropagation(); setCollapsed(toggle(collapsed, r.id)); }}>{open ? '▾' : '▸'}</button>
                  <Icon name="group" size={13} />
                  {renaming === `g:${r.id}` ? (
                    <input className={styles.renameInput} autoFocus defaultValue={groupNames?.[r.id]?.name ?? ''} placeholder={r.name} aria-label={t('ed36.outliner.rename')}
                      onClick={(e) => e.stopPropagation()} onBlur={(e) => { useWorldStore.getState().setGroupName(r.id, e.target.value); setRenaming(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : <span className={styles.itemName}>{r.name} <span className={styles.count}>({r.members.length})</span></span>}
                  {editing && <button type="button" className={styles.rowBtn} title={t('ed36.outliner.rename')} aria-label={t('ed36.outliner.rename')} data-testid="outliner-rename-group"
                    onClick={(e) => { e.stopPropagation(); setRenaming(`g:${r.id}`); }}><Icon name="edit" size={11} /></button>}
                  {flagBtn(ids, r.members.every((o) => o.hidden), 'hidden', 'ed36.outliner.hide')}
                  {flagBtn(ids, r.members.every((o) => o.locked), 'locked', 'ed36.outliner.lock')}
                </div>
              );
            }
            const o = r.obj;
            return (
              <div key={o.id} style={style} role="treeitem" aria-selected={selected.has(o.id)} data-testid="outliner-row" data-id={o.id}
                className={`${styles.item} ${selected.has(o.id) ? styles.sel : ''} ${o.hidden ? styles.dim : ''}`}
                onClick={(e) => pick(o.id, e)} onDoubleClick={() => focusObject(o.id)} title={t('outliner.doubleClickFocus')}>
                <span style={{ width: r.depth ? 16 : 0, flexShrink: 0 }} />
                <Icon name={getDefinition(o.type).icon as IconName} size={14} />
                {renaming === o.id ? (
                  <input className={styles.renameInput} autoFocus defaultValue={o.name} placeholder={displayName(o, t)} aria-label={t('ed36.outliner.rename')}
                    onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== o.name) useWorldStore.getState().rename(o.id, e.target.value); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                ) : <span className={styles.itemName}>{displayName(o, t)}</span>}
                {states && states[o.id] !== undefined && <StateDot state={states[o.id]} />}
                {editing && <button type="button" className={styles.rowBtn} title={t('ed36.outliner.rename')} aria-label={t('ed36.outliner.rename')} data-testid="outliner-rename"
                  onClick={(e) => { e.stopPropagation(); setRenaming(o.id); }}><Icon name="edit" size={11} /></button>}
                {flagBtn([o.id], !!o.hidden, 'hidden', 'ed36.outliner.hide')}
                {flagBtn([o.id], !!o.locked, 'locked', 'ed36.outliner.lock')}
              </div>
            );
          })}
        </div>
      </div>
      <div className={styles.note}>{t('ed36.outliner.note')}</div>
    </>
  );
}
