/**
 * Phase 37 (§17, S19): outliner rows, Shift range selection, keyboard movement and keeping a row in view (pure logic
 * of editor/outliner.ts) — and the selection action the list applies a range with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import { createEmptyDocument } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { clickSelect, selectRange } from '@/app/buildActions';
import { currentRow, groupRowKey, outlinerRows, revealScroll, rowRange, stepRow, type OutlinerRowRef } from './outliner';

type Obj = { id: string; group?: string };
const o = (id: string, group?: string): Obj => (group ? { id, group } : { id });

/**
 * The list order of nine objects: b1 b2 (group G1) · c1 · c2 (group G2) · h1 · t1 (G1) · t2 · t3 (G2) · w1.
 * Rows: G1 [b1 b2 t1] · G2 [c2 t3] · c1 · h1 · t2 · w1.
 */
const LISTED: Obj[] = [o('b1', 'G1'), o('b2', 'G1'), o('c1'), o('c2', 'G2'), o('h1'), o('t1', 'G1'), o('t2'), o('t3', 'G2'), o('w1')];
const keys = (rows: readonly OutlinerRowRef[]) => rows.map((r) => r.key);
const G1 = groupRowKey('G1'), G2 = groupRowKey('G2');

describe('outlinerRows — the visible order', () => {
  it('groups first (in the order of their first listed member), members under them, then the ungrouped objects', () => {
    const rows = outlinerRows(LISTED, new Set());
    expect(keys(rows)).toEqual([G1, 'b1', 'b2', 't1', G2, 'c2', 't3', 'c1', 'h1', 't2', 'w1']);
    expect(rows.filter((r) => r.kind === 'group').map((r) => (r.kind === 'group' ? [r.id, r.index, r.ids] : null))).toEqual([['G1', 1, ['b1', 'b2', 't1']], ['G2', 2, ['c2', 't3']]]);
    expect(rows.filter((r) => r.kind === 'object').map((r) => (r.kind === 'object' ? r.depth : -1))).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
    for (const r of rows) if (r.kind === 'object') expect(r.ids).toEqual([r.obj.id]);
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });

  it('a collapsed group is one row; a filtered list has only the listed members and groups', () => {
    expect(keys(outlinerRows(LISTED, new Set(['G1'])))).toEqual([G1, G2, 'c2', 't3', 'c1', 'h1', 't2', 'w1']);
    expect(outlinerRows(LISTED, new Set(['G1']))[0].ids).toEqual(['b1', 'b2', 't1']); // the row still stands for its members
    // Search "t": only the trees are listed — G1 shows one member, G2 one.
    const trees = outlinerRows(LISTED.filter((x) => x.id.startsWith('t')), new Set());
    expect(keys(trees)).toEqual([G1, 't1', G2, 't3', 't2']);
    expect(trees[0].ids).toEqual(['t1']);
    expect(outlinerRows([], new Set())).toEqual([]);
  });
});

describe('rowRange — Shift+click', () => {
  const rows = outlinerRows(LISTED, new Set());

  it('every row from the anchor to the target, both included, in the listed order — whichever was clicked first', () => {
    expect(rowRange(rows, 'c1', 'w1')).toEqual(['c1', 'h1', 't2', 'w1']);
    expect(rowRange(rows, 'w1', 'c1')).toEqual(['c1', 'h1', 't2', 'w1']);
    expect(rowRange(rows, 'h1', 'h1')).toEqual(['h1']);
    // Across a group boundary: member rows are rows like any other.
    expect(rowRange(rows, 't1', 'c1')).toEqual(['t1', 'c2', 't3', 'c1']);
    // A group row in the range stands for its listed members (each object once).
    expect(rowRange(rows, G1, 'b2')).toEqual(['b1', 'b2', 't1']);
    expect(rowRange(rows, 'b2', G2)).toEqual(['b2', 't1', 'c2', 't3']);
  });

  it('respects collapsed groups: the group is one row, its members are not rows', () => {
    const collapsed = outlinerRows(LISTED, new Set(['G2']));
    expect(keys(collapsed)).toEqual([G1, 'b1', 'b2', 't1', G2, 'c1', 'h1', 't2', 'w1']);
    expect(rowRange(collapsed, 't1', 'c1')).toEqual(['t1', 'c2', 't3', 'c1']); // through the collapsed group: the group
    expect(rowRange(collapsed, 'c1', 'h1')).toEqual(['c1', 'h1']); // beside it: not its hidden members
    expect(rowRange(collapsed, 'c2', 'h1')).toEqual(['h1']); // an anchor inside a collapsed group is not a row
  });

  it('respects the filter / search: only listed rows are in a range', () => {
    // Without the filter b1 … w1 covers everything; with "trees only" the same two ends give the trees between them.
    const trees = outlinerRows(LISTED.filter((x) => x.id.startsWith('t')), new Set());
    expect(rowRange(trees, 't1', 't2')).toEqual(['t1', 't3', 't2']);
    expect(rowRange(trees, 'b1', 't2')).toEqual(['t2']); // the anchor was filtered out → the clicked row alone
  });

  it('no anchor → the target alone; an unknown target → nothing', () => {
    expect(rowRange(rows, null, 't2')).toEqual(['t2']);
    expect(rowRange(rows, 'gone', G2)).toEqual(['c2', 't3']);
    expect(rowRange(rows, 'c1', 'gone')).toEqual([]);
    expect(rowRange([], 'c1', 'c1')).toEqual([]);
  });
});

describe('stepRow — ↑ / ↓ / Home / End', () => {
  const rows = outlinerRows(LISTED, new Set(['G2']));

  it('moves to the previous / next visible row and stays at the ends', () => {
    expect(stepRow(rows, 'b2', 'down')).toBe('t1');
    expect(stepRow(rows, 't1', 'down')).toBe(G2);
    expect(stepRow(rows, G2, 'down')).toBe('c1'); // the collapsed group's members are skipped
    expect(stepRow(rows, 'c1', 'up')).toBe(G2);
    expect(stepRow(rows, G1, 'up')).toBe(G1);
    expect(stepRow(rows, 'w1', 'down')).toBe('w1');
    expect(stepRow(rows, 'h1', 'home')).toBe(G1);
    expect(stepRow(rows, 'h1', 'end')).toBe('w1');
  });

  it('with no current row ↓ starts at the top and ↑ at the bottom; an empty list has no row', () => {
    expect(stepRow(rows, null, 'down')).toBe(G1);
    expect(stepRow(rows, null, 'up')).toBe('w1');
    expect(stepRow(rows, 'c2', 'down')).toBe(G1); // (c2 is inside the collapsed group: not a row)
    expect(stepRow([], null, 'down')).toBeNull();
    expect(stepRow([], 'x', 'home')).toBeNull();
  });

  it('walking down from the top visits every row once, in order', () => {
    const seen: string[] = [];
    let k = stepRow(rows, null, 'down');
    while (k && seen[seen.length - 1] !== k) { seen.push(k); k = stepRow(rows, k, 'down'); }
    expect(seen).toEqual(keys(rows));
  });
});

describe('currentRow — where a range / the keyboard continues from', () => {
  const rows = outlinerRows(LISTED, new Set(['G2']));

  it('the remembered row while it is listed and still selected', () => {
    expect(currentRow(rows, 'h1', new Set(['h1', 't2']), 't2')).toBe('h1');
    expect(currentRow(rows, G2, new Set(['c2']), 'c2')).toBe(G2); // a group row with a selected member
  });

  it('otherwise the row of the primary selection (a click in the 3D view moves it), else none', () => {
    expect(currentRow(rows, 'h1', new Set(['t2']), 't2')).toBe('t2'); // h1 was deselected elsewhere
    expect(currentRow(rows, 'gone', new Set(['w1']), 'w1')).toBe('w1');
    expect(currentRow(rows, null, new Set(['c1', 'w1']), 'c1')).toBe('c1');
    expect(currentRow(rows, null, new Set(['c2']), 'c2')).toBeNull(); // the primary is inside a collapsed group
    expect(currentRow(rows, 'h1', new Set(), null)).toBeNull();
    expect(currentRow([], 'h1', new Set(['h1']), 'h1')).toBeNull();
  });

  it('a row the list itself just deselected (Ctrl/⌘+click) stays the starting point while nothing else changed the selection', () => {
    expect(currentRow(rows, 'h1', new Set(['t2']), 't2', true)).toBe('h1');
    expect(currentRow(rows, 'h1', new Set(), null, true)).toBe('h1');
    expect(currentRow(rows, 'gone', new Set(['t2']), 't2', true)).toBe('t2'); // …but it must still be listed
    // Ctrl+click h1 off, then Shift+click w1: the range starts at h1.
    expect(rowRange(rows, currentRow(rows, 'h1', new Set(['c1']), 'c1', true), 'w1')).toEqual(['h1', 't2', 'w1']);
  });
});

describe('revealScroll — the row the keyboard is on stays in view', () => {
  const H = 26, PAD = 6, VIEW = 260; // ten rows fit

  it('does not scroll when the row is already completely in view', () => {
    expect(revealScroll(0, 0, VIEW, H, PAD)).toBe(0);
    expect(revealScroll(5, 0, VIEW, H, PAD)).toBe(0);
    expect(revealScroll(12, 200, VIEW, H, PAD)).toBe(200);
    expect(revealScroll(-1, 123, VIEW, H, PAD)).toBe(123);
  });

  it('scrolls just enough: down for a row below, up for a row above', () => {
    const down = revealScroll(30, 0, VIEW, H, PAD);
    expect(PAD + 30 * H).toBeGreaterThanOrEqual(down); // top of the row at or below the top of the view
    expect(PAD + 31 * H).toBeLessThanOrEqual(down + VIEW); // bottom of the row inside the view
    expect(revealScroll(30, down, VIEW, H, PAD)).toBe(down); // and then it stays
    const up = revealScroll(3, 600, VIEW, H, PAD);
    expect(up).toBe(3 * H);
    expect(revealScroll(3, up, VIEW, H, PAD)).toBe(up);
    expect(revealScroll(0, 600, VIEW, H, PAD)).toBe(0);
  });

  it('5000 rows: End then Home put the last / first row in view', () => {
    const end = revealScroll(4999, 0, VIEW, H, PAD);
    expect(end).toBe(PAD + 5000 * H - VIEW + PAD);
    expect(revealScroll(0, end, VIEW, H, PAD)).toBe(0);
  });
});

describe('selectRange — applying a range to the selection', () => {
  const W = () => useWorldStore.getState();
  const ED = () => useEditorStore.getState();
  const at = (x: number) => ({ ...identityTransform(), position: [x, 0, 0] as Vec3 });
  let a = '', b = '', c = '', g1 = '', g2 = '';

  beforeEach(() => {
    W().setLocked(false);
    W().replaceDocument(createEmptyDocument());
    ED().setMode('editor');
    [a, b, c, g1, g2] = W().applyEdit({ add: [0, 5, 10, 15, 20].map((x) => ({ type: 'wall' as const, transform: at(x) })) });
    const objs = W().doc.objects;
    W().applyEdit({ update: [{ ...objs[g1], group: 'grp' }, { ...objs[g2], group: 'grp', hidden: true }, { ...objs[c], locked: true }] });
    ED().setSelection([]);
  });

  it('replaces the selection with the range; the target row\'s object is the primary one', () => {
    ED().setSelection([a]);
    selectRange([a, b, c], c);
    expect(ED().selectedIds).toEqual([a, b, c]); // locked objects are selectable in the outliner
    expect(ED().selectedId).toBe(c);
  });

  it('groups are selected whole, as a click does — Alt takes exactly the listed objects', () => {
    selectRange([b, g1], g1);
    expect(new Set(ED().selectedIds)).toEqual(new Set([b, g1, g2])); // g2 comes with its group (though hidden)
    expect(ED().selectedId).toBe(g1);
    selectRange([b, g1], g1, { alt: true });
    expect(ED().selectedIds).toEqual([b, g1]);
    // The same unit a plain click on the member selects.
    clickSelect(g1);
    expect(new Set(ED().selectedIds)).toEqual(new Set([g1, g2]));
  });

  it('Ctrl/⌘+Shift adds the range to the selection', () => {
    ED().setSelection([a]);
    selectRange([c, g1], g1, { add: true, alt: true });
    expect(ED().selectedIds).toEqual([a, c, g1]);
    expect(ED().selectedId).toBe(g1);
    selectRange([], null, { add: true });
    expect(ED().selectedIds).toEqual([a, c, g1]);
    selectRange([], null);
    expect(ED().selectedIds).toEqual([]);
  });

  it('never touches the document or the history', () => {
    const doc = W().doc, steps = W().past.length;
    selectRange([a, b, g1], b);
    expect(W().doc).toBe(doc);
    expect(W().past.length).toBe(steps);
  });
});

describe('keyboard ownership (static)', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  it('the global editor shortcuts bind none of the outliner\'s keys', () => {
    // ↑ ↓ Home End act on the focused outliner only; a global binding of one of them would fire twice or be swallowed.
    expect(read('app/hotkeys.ts')).not.toMatch(/arrow(up|down)|case 'home'|case 'end'/i);
  });

  it('the list takes the keyboard in the editor only (during a run the arrow keys drive the live vehicle)', () => {
    expect(read('ui/Inspector/VehicleControls.tsx')).toMatch(/ArrowUp/); // the reason
    const outliner = read('ui/ObjectPalette/Outliner.tsx');
    expect(outliner).toMatch(/tabIndex=\{editing \? 0 : undefined\}/);
    expect(outliner).toMatch(/if \(!editing \|\| !step/);
  });
});
