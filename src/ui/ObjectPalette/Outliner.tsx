/**
 * Scene outliner (Phase 36 §42–44): every object of the world, searchable and filterable, with editing groups as
 * collapsible nodes. Rows select, focus the camera (double-click), rename, hide (editor view only — the object still
 * exists and is simulated) and lock (not picked in the viewport, not moved or deleted). Long lists are windowed: only
 * the visible rows are rendered (5000 objects stay cheap).
 *
 * Selecting (Phase 37 §17 — the rules and how they differ from the viewport: editor/outliner.ts):
 *   click            select the row (a grouped object: its group; Alt = this object only)
 *   Ctrl/⌘+click     add / remove the row
 *   Shift+click      the RANGE from the last clicked row to this one, in the listed order (+Ctrl/⌘: added to the selection)
 *   ↑ / ↓, Home / End   with the list focused: move to the previous / next / first / last row (Shift extends the range)
 * In the 3D view Shift+click adds / removes instead (there is no row order there). The keyboard works in the editor
 * only: during a simulation the list is not focusable, so the arrow keys stay with the live vehicle controls.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isImeKey } from '@/editor/input/keys';
import type { EntityId, ObjectCategory } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { useT, type MessageKey } from '@/i18n/i18n';
import { CATEGORY_ORDER } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { clearSelection, clickSelect, expandGroups, selectRange, selectSameType, setObjectFlags } from '@/app/buildActions';
import { currentRow, outlinerRows, revealScroll, rowRange, stepRow, type OutlinerRow, type RowStep } from '@/editor/outliner';
import { isTyping } from '@/editor/input/keys';
import { focusObject, focusSelection } from '@/app/actions';
import { Icon, type IconName } from '@/ui/common/Icon';
import { displayName } from '@/ui/format';
import { StateDot } from '@/ui/common/StateBadge';
import { useEntityStates } from '@/ui/useEntityStates';
import styles from './ObjectPalette.module.css';

type Filter = 'all' | ObjectCategory | 'hidden' | 'locked';
type Row = OutlinerRow<WorldObject>;

const ROW_H = 26;
const OVERSCAN = 8;
/** Padding of the list above the first row (`.list` in the stylesheet). */
const LIST_PAD = 6;
const STEP: Record<string, RowStep> = { ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' };
const rowDomId = (key: string) => `outliner-row:${key}`;

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
  const primary = useEditorStore((s) => s.selectedId);
  // Phase 37: the row a Shift range starts from (the last row clicked / moved to without Shift) and the row the
  // keyboard is on (the last row clicked / moved to). Both are row keys; `currentRow` falls back to the primary
  // selection when the remembered row is gone, or something else changed the selection (a click in the 3D view) and
  // the row is no longer selected. `own` = the selection as the list's last action left it.
  const anchor = useRef<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const own = useRef<readonly EntityId[] | null>(null);

  const all = useMemo(() => Object.values(objects).sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial), [objects]);
  const cats = useMemo(() => CATEGORY_ORDER.filter((c) => all.some((o) => getDefinition(o.type).category === c)), [all]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => all.filter((o) => {
    if (filter === 'hidden' ? !o.hidden : filter === 'locked' ? !o.locked : filter !== 'all' && getDefinition(o.type).category !== filter) return false;
    if (!q) return true;
    return displayName(o, t).toLowerCase().includes(q) || t(getDefinition(o.type).labelKey).toLowerCase().includes(q) || o.id.toLowerCase().includes(q);
  }), [all, filter, q, t]);

  // Groups first (by first member), each followed by its members unless collapsed; then the ungrouped objects.
  const rows = useMemo<Row[]>(() => outlinerRows(shown, collapsed), [shown, collapsed]);
  const groupName = (r: Extract<Row, { kind: 'group' }>) => groupNames?.[r.id]?.name ?? t('ed36.group.unnamed', { n: r.index });
  const untouched = own.current === selectedIds;
  const cursorKey = editing ? currentRow(rows, cursor, selected, primary, untouched) : null;

  // The row the keyboard moved to stays in view (the list is windowed: a row outside the window is not in the DOM).
  const reveal = useRef<string | null>(null);
  useEffect(() => {
    const el = box.current;
    const i = reveal.current === null ? -1 : rows.findIndex((r) => r.key === reveal.current);
    reveal.current = null;
    if (!el || i < 0) return;
    const top = revealScroll(i, el.scrollTop, el.clientHeight, ROW_H, LIST_PAD);
    if (top !== el.scrollTop) el.scrollTop = top;
  });

  if (!all.length) return <div className={styles.empty}>{t('outliner.empty')}</div>;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  /** Shift: the range from the anchor row (kept) to `row`; `add` keeps the selection (Ctrl/⌘+Shift). */
  const range = (row: Row, mods: { add?: boolean; alt?: boolean }) => {
    const from = currentRow(rows, anchor.current, selected, primary, untouched);
    selectRange(rowRange(rows, from, row.key), row.ids[0] ?? null, mods);
    remember(from ?? row.key, row.key);
  };
  /** After the list changed the selection: the anchor of the next range, and the row the keyboard is on. */
  const remember = (anchorRow: string, cursorRow: string) => {
    anchor.current = anchorRow;
    own.current = useEditorStore.getState().selectedIds;
    setCursor(cursorRow);
  };
  /** A click / move without Shift: this row becomes the anchor of the next range. */
  const mark = (row: Row) => remember(row.key, row.key);
  const pick = (row: Extract<Row, { kind: 'object' }>, e: React.MouseEvent) => {
    const id = row.obj.id;
    if (!editing) return useEditorStore.getState().select(id);
    if (e.shiftKey) return range(row, { add: e.ctrlKey || e.metaKey, alt: e.altKey });
    clickSelect(id, { alt: e.altKey, toggle: e.ctrlKey || e.metaKey });
    mark(row);
  };
  const pickGroup = (row: Extract<Row, { kind: 'group' }>, e: React.MouseEvent) => {
    if (!editing) return;
    if (e.shiftKey) return range(row, { add: e.ctrlKey || e.metaKey, alt: e.altKey });
    if (e.ctrlKey || e.metaKey) clickSelect(row.ids[0], { toggle: true });
    else useEditorStore.getState().setSelection(expandGroups(row.ids));
    mark(row);
  };
  /** ↑ / ↓ / Home / End on the focused list. Other keys (Delete, Ctrl+Z, F …) stay the editor's shortcuts. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = Object.hasOwn(STEP, e.key) ? STEP[e.key] : null;
    if (!editing || !step || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.nativeEvent) || e.nativeEvent.isComposing) return;
    e.preventDefault(); // (the list scrolls by itself otherwise)
    e.stopPropagation();
    const next = rows.find((r) => r.key === stepRow(rows, cursorKey, step));
    if (!next) return;
    reveal.current = next.key;
    if (e.shiftKey) return range(next, {});
    selectRange(next.ids, next.ids[0] ?? null);
    mark(next);
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
        role="tree" aria-label={t('ed36.outliner.tree')} aria-multiselectable={editing} tabIndex={editing ? 0 : undefined}
        aria-activedescendant={cursorKey !== null ? rowDomId(cursorKey) : undefined} onKeyDown={onKeyDown}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((r, i) => {
            const style: CSSProperties = { position: 'absolute', top: (first + i) * ROW_H, left: 0, right: 0, height: ROW_H };
            const cur = r.key === cursorKey ? styles.cursor : '';
            if (r.kind === 'group') {
              const ids = [...r.ids];
              const allSel = ids.every((id) => selected.has(id));
              const open = !collapsed.has(r.id);
              return (
                <div key={r.key} id={rowDomId(r.key)} style={style} role="treeitem" aria-expanded={open} aria-selected={allSel}
                  className={`${styles.item} ${styles.groupRow} ${allSel ? styles.sel : ''} ${cur}`} data-testid="outliner-group" data-id={r.id}
                  onClick={(e) => pickGroup(r, e)}
                  onDoubleClick={() => { useEditorStore.getState().setSelection(ids); focusSelection(); }}>
                  <button type="button" className={styles.rowBtn} aria-label={t(open ? 'ed36.outliner.collapse' : 'ed36.outliner.expand')}
                    onClick={(e) => { e.stopPropagation(); setCollapsed(toggle(collapsed, r.id)); }}>{open ? '▾' : '▸'}</button>
                  <Icon name="group" size={13} />
                  {renaming === `g:${r.id}` ? (
                    <input className={styles.renameInput} autoFocus defaultValue={groupNames?.[r.id]?.name ?? ''} placeholder={groupName(r)} aria-label={t('ed36.outliner.rename')}
                      onClick={(e) => e.stopPropagation()} onBlur={(e) => { useWorldStore.getState().setGroupName(r.id, e.target.value); setRenaming(null); }}
                      onKeyDown={(e) => { if (isImeKey(e)) return; if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : <span className={styles.itemName}>{groupName(r)} <span className={styles.count}>({r.members.length})</span></span>}
                  {editing && <button type="button" className={styles.rowBtn} title={t('ed36.outliner.rename')} aria-label={t('ed36.outliner.rename')} data-testid="outliner-rename-group"
                    onClick={(e) => { e.stopPropagation(); setRenaming(`g:${r.id}`); }}><Icon name="edit" size={11} /></button>}
                  {flagBtn(ids, r.members.every((o) => o.hidden), 'hidden', 'ed36.outliner.hide')}
                  {flagBtn(ids, r.members.every((o) => o.locked), 'locked', 'ed36.outliner.lock')}
                </div>
              );
            }
            const o = r.obj;
            return (
              <div key={r.key} id={rowDomId(r.key)} style={style} role="treeitem" aria-selected={selected.has(o.id)} data-testid="outliner-row" data-id={o.id}
                className={`${styles.item} ${selected.has(o.id) ? styles.sel : ''} ${o.hidden ? styles.dim : ''} ${cur}`}
                onClick={(e) => pick(r, e)} onDoubleClick={() => focusObject(o.id)} title={t('outliner.doubleClickFocus')}>
                <span style={{ width: r.depth ? 16 : 0, flexShrink: 0 }} />
                <Icon name={getDefinition(o.type).icon as IconName} size={14} />
                {renaming === o.id ? (
                  <input className={styles.renameInput} autoFocus defaultValue={o.name} placeholder={displayName(o, t)} aria-label={t('ed36.outliner.rename')}
                    onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== o.name) useWorldStore.getState().rename(o.id, e.target.value); setRenaming(null); }}
                    onKeyDown={(e) => { if (isImeKey(e)) return; if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
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
      <div className={styles.note}>
        {t('ed36.outliner.note')}
        {editing && <><br /><span title={t('p37left.outliner.keys.title')} data-testid="outliner-keys">{t('p37left.outliner.keys')}</span></>}
      </div>
    </>
  );
}
