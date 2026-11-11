/**
 * Scene outliner logic (Phase 37 §17) — pure: the rows the list shows, range selection between two rows, keyboard
 * movement and keeping a row in view. No stores, no React; the component (ui/ObjectPalette/Outliner.tsx) holds the
 * anchor / cursor and applies the result to the selection.
 *
 * Rows are in VISIBLE order: what the filter and the search left, groups first (each followed by its members unless
 * it is collapsed), then the ungrouped objects. A range never reaches rows that are not listed — objects filtered out
 * and the members of a collapsed group are not rows (a collapsed group is one row: the group).
 *
 * How this differs from the viewport: in the 3D view Shift+click ADDS / REMOVES the clicked object (there is no order
 * to take a range from) and Shift+drag draws a box. In the outliner — a list — Shift+click selects the RANGE from the
 * last clicked row to this one, Ctrl/⌘+click adds / removes one row, and ↑ / ↓ move (Shift extends), as in a file list.
 */
import type { EntityId } from '@/core/types';

/** What the range / movement functions need of a row: its key and the objects it stands for. */
export interface OutlinerRowRef {
  /** Unique in the list: the object id, or `g:<group id>` for a group row. */
  key: string;
  /** The row's objects: the object itself, or the LISTED members of the group (those the filter / search left). */
  ids: readonly EntityId[];
}

export type OutlinerRow<T extends { id: EntityId; group?: string }> =
  | (OutlinerRowRef & { kind: 'group'; id: string; index: number; members: T[] })
  | (OutlinerRowRef & { kind: 'object'; obj: T; depth: 0 | 1 });

export const groupRowKey = (group: string) => `g:${group}`;

/**
 * The rows for the listed objects (already filtered, in list order): groups first — in the order of their first listed
 * member, `index` = 1, 2, … for the default name — each followed by its listed members unless collapsed; then the
 * ungrouped objects.
 */
export function outlinerRows<T extends { id: EntityId; group?: string }>(shown: readonly T[], collapsed: ReadonlySet<string>): OutlinerRow<T>[] {
  const groups = new Map<string, T[]>();
  const loose: T[] = [];
  for (const o of shown) {
    if (o.group) (groups.get(o.group) ?? groups.set(o.group, []).get(o.group)!).push(o);
    else loose.push(o);
  }
  const out: OutlinerRow<T>[] = [];
  let index = 0;
  for (const [id, members] of groups) {
    index++;
    out.push({ kind: 'group', key: groupRowKey(id), id, index, members, ids: members.map((o) => o.id) });
    if (!collapsed.has(id)) for (const o of members) out.push({ kind: 'object', key: o.id, obj: o, depth: 1, ids: [o.id] });
  }
  for (const o of loose) out.push({ kind: 'object', key: o.id, obj: o, depth: 0, ids: [o.id] });
  return out;
}

const indexOfRow = (rows: readonly OutlinerRowRef[], key: string | null | undefined) => (key == null ? -1 : rows.findIndex((r) => r.key === key));

/**
 * The objects of the rows from the anchor row to the target row (both included), in visible order, each once. The
 * anchor is not listed (filtered out, collapsed away, deleted, or there is none) → the target row alone; the target is
 * not listed → nothing.
 */
export function rowRange(rows: readonly OutlinerRowRef[], anchorKey: string | null, targetKey: string): EntityId[] {
  const b = indexOfRow(rows, targetKey);
  if (b < 0) return [];
  const a = indexOfRow(rows, anchorKey);
  const from = a < 0 ? b : Math.min(a, b);
  const to = a < 0 ? b : Math.max(a, b);
  const seen = new Set<EntityId>();
  for (let i = from; i <= to; i++) for (const id of rows[i].ids) seen.add(id);
  return [...seen];
}

export type RowStep = 'up' | 'down' | 'home' | 'end';

/**
 * The row the keyboard moves to from `fromKey`: the previous / next visible row (staying on the first / last one at
 * the ends), or the first / last row. No current row (null, or it is not listed any more): ↓ / Home start at the first
 * row, ↑ / End at the last. Null only when the list is empty.
 */
export function stepRow(rows: readonly OutlinerRowRef[], fromKey: string | null, step: RowStep): string | null {
  if (!rows.length) return null;
  const last = rows.length - 1;
  const i = indexOfRow(rows, fromKey);
  if (step === 'home') return rows[0].key;
  if (step === 'end') return rows[last].key;
  if (i < 0) return rows[step === 'down' ? 0 : last].key;
  return rows[Math.min(last, Math.max(0, i + (step === 'down' ? 1 : -1)))].key;
}

/**
 * The row a range or a keyboard move starts from: the remembered row (the last one clicked / moved to in the list)
 * while it is still listed and the selection is still the list's own — `untouched`: nothing else changed the selection
 * since (so a row that Ctrl/⌘+click just DEselected stays the starting point, as in a file list) — or the row is still
 * (partly) selected. Otherwise the row of the primary selected object (a click in the 3D view also sets where
 * Shift+click and the arrow keys continue from); otherwise none.
 */
export function currentRow(rows: readonly OutlinerRowRef[], rememberedKey: string | null, selected: ReadonlySet<EntityId>, primary: EntityId | null, untouched = false): string | null {
  const kept = rows[indexOfRow(rows, rememberedKey)];
  if (kept && (untouched || kept.ids.some((id) => selected.has(id)))) return kept.key;
  if (primary != null && selected.has(primary) && indexOfRow(rows, primary) >= 0) return primary;
  return null;
}

/**
 * The scroll position that shows row `index` completely in a windowed list (rows `rowHeight` tall, starting `pad`
 * below the top of the scrolled content): unchanged when the row is already in view, otherwise the smallest scroll.
 */
export function revealScroll(index: number, scrollTop: number, viewHeight: number, rowHeight: number, pad = 0): number {
  if (index < 0) return scrollTop;
  const top = pad + index * rowHeight;
  if (top < scrollTop) return Math.max(0, top - pad);
  const bottom = top + rowHeight;
  if (bottom > scrollTop + viewHeight) return bottom - viewHeight + pad;
  return scrollTop;
}
