/**
 * Creative Build Mode actions (Phase 16): selection, group editing, copy / paste and committing
 * bulk placement. Every world change goes through worldStore.applyEdit → one undo step each.
 * UI components and hotkeys call these; they never wire stores together themselves.
 */
import type { EntityId, ObjectCategory } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import type { CreateObjectInput } from '@/world/WorldDocument';
import { samplerFor } from '@/terrain/TerrainSampler';
import { createBlueprint, instantiateBlueprint } from '@/editor/build/blueprint';
import { useRoadStore } from '@/editor/roadStore';
import { pasteRoads } from '@/roads/blueprintRoads';
import { measureLink } from '@/roads/links';
import { yawOf } from '@/terrain/groundPlacement';
import { alignObjects, distributeGaps, distributeObjects, matchObjects, selectionPivot, transformObjects, type AlignAxis, type AlignMode, type AlignRef, type MatchWhat, type RigidDelta } from '@/editor/build/groupTransform';
import type { PlannedObject } from '@/editor/build/placementPlan';
import { toast } from '@/ui/common/toast';

const world = () => useWorldStore.getState();
const editor = () => useEditorStore.getState();
const editable = () => editor().mode === 'editor' && !world().locked;

export function selectedObjects(): WorldObject[] {
  const objs = world().doc.objects;
  return editor().selectedIds.map((id) => objs[id]).filter((o): o is WorldObject => !!o);
}

/** All members of the groups of `ids` (plus the ungrouped ids themselves). */
export function expandGroups(ids: readonly EntityId[]): EntityId[] {
  const objs = world().doc.objects;
  const groups = new Set(ids.map((id) => objs[id]?.group).filter((g): g is string => !!g));
  if (!groups.size) return [...ids];
  const out = new Set(ids);
  for (const o of Object.values(objs)) if (o.group && groups.has(o.group)) out.add(o.id);
  return [...out];
}

/**
 * Viewport click on an object. Plain click: select it (its whole group if grouped).
 * Shift or Ctrl/⌘ (Phase 36): add / remove it (and its group). Alt: just this object, ignoring its group.
 */
export function clickSelect(id: EntityId, mods: { shift?: boolean; alt?: boolean; toggle?: boolean } = {}) {
  const ed = editor();
  const unit = mods.alt ? [id] : expandGroups([id]);
  if (mods.shift || mods.toggle) {
    const cur = new Set(ed.selectedIds);
    const remove = unit.every((u) => cur.has(u));
    for (const u of unit) (remove ? cur.delete(u) : cur.add(u));
    ed.setSelection([...cur], remove ? ed.selectedId : id);
  } else ed.setSelection(unit, id);
}

/**
 * Lock / unlock, hide / show objects (Phase 36 §44) — one undo step. Only `true` is stored (unlocking / showing
 * removes the key), so a document that never used the flags stays byte-identical.
 */
export function setObjectFlags(ids: readonly EntityId[], flags: { locked?: boolean; hidden?: boolean }): void {
  if (!editable()) return;
  const objs = world().doc.objects;
  const update: WorldObject[] = [];
  for (const id of ids) {
    const o = objs[id];
    if (!o) continue;
    const next: WorldObject = { ...o };
    for (const k of ['locked', 'hidden'] as const) {
      if (flags[k] === undefined) continue;
      if (flags[k]) next[k] = true;
      else delete next[k];
    }
    if (next.locked !== o.locked || next.hidden !== o.hidden) update.push(next);
  }
  if (update.length) world().applyEdit({ update });
  // A hidden object leaves the viewport selection (it cannot be seen / dragged there).
  if (flags.hidden) editor().setSelection(editor().selectedIds.filter((id) => !ids.includes(id)));
}

/**
 * Box selection result (Shift+drag). `add` (true / 'add') keeps the current selection; 'subtract' (Phase 36:
 * Shift+Ctrl/⌘+drag) removes the boxed objects (and their groups) from it; false / 'replace' replaces it.
 */
export function boxSelect(ids: EntityId[], add: boolean | 'add' | 'subtract' | 'replace') {
  const ed = editor();
  const unit = expandGroups(ids);
  if (add === 'subtract') {
    const drop = new Set(unit);
    const kept = ed.selectedIds.filter((i) => !drop.has(i));
    ed.setSelection(kept, ed.selectedId && kept.includes(ed.selectedId) ? ed.selectedId : undefined);
    return;
  }
  const keep = add === true || add === 'add';
  ed.setSelection(keep ? [...ed.selectedIds, ...unit] : unit, ed.selectedId && keep ? ed.selectedId : unit[unit.length - 1] ?? null);
}

/**
 * Objects of the same kind as the primary selection (Phase 36 §10): the same object type, and for buildings the same
 * modular preset (or legacy box buildings together). Hidden / locked objects are not picked up.
 */
export function selectSameType(): number {
  const ed = editor();
  const objs = world().doc.objects;
  const ref = ed.selectedId ? objs[ed.selectedId] : undefined;
  if (!ref) return 0;
  const kind = (o: WorldObject) => (o.type === 'building' ? `building:${o.building ? o.building.preset ?? 'custom' : 'legacy'}` : o.type);
  const k = kind(ref);
  const ids = Object.values(objs).filter((o) => kind(o) === k && !o.hidden && !o.locked).map((o) => o.id);
  ed.setSelection(ids, ref.id);
  return ids.length;
}

let lastPick: { x: number; y: number; ids: string; at: number } | null = null;

/**
 * Click on overlapping objects (Phase 36 §10): `hits` = the objects under the cursor, nearest first. A click picks the
 * nearest one; clicking AGAIN at the same spot (≤ 5 px, within 1.5 s) picks the next one under the cursor, cycling —
 * so an object behind a tree or inside another can be selected without moving the camera.
 */
export function selectFromHits(hits: readonly EntityId[], mods: { shift?: boolean; alt?: boolean; toggle?: boolean }, screen: [number, number]): EntityId | null {
  const objs = world().doc.objects;
  const list = hits.filter((id, i) => objs[id] && !objs[id].locked && !objs[id].hidden && hits.indexOf(id) === i);
  if (!list.length) return null;
  const key = list.join(',');
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let pick = list[0];
  const cur = editor().selectedId;
  if (!mods.shift && !mods.toggle && lastPick && lastPick.ids === key && Math.hypot(lastPick.x - screen[0], lastPick.y - screen[1]) <= 5 && now - lastPick.at < 1500 && cur && list.includes(cur)) {
    pick = list[(list.indexOf(cur) + 1) % list.length];
  }
  lastPick = { x: screen[0], y: screen[1], ids: key, at: now };
  clickSelect(pick, mods);
  return pick;
}

export function selectAll(category?: ObjectCategory) {
  const ids = Object.values(world().doc.objects).filter((o) => !category || getDefinition(o.type).category === category).map((o) => o.id);
  editor().setSelection(ids);
}

export function clearSelection() {
  editor().setSelection([]);
}

// ── Group editing ────────────────────────────────────────────────────────

/** Selected objects that may be moved / deleted (Phase 36: locked ones are skipped, with a note). */
function unlockedSelection(): WorldObject[] {
  const objs = selectedObjects();
  const free = objs.filter((o) => !o.locked);
  if (free.length < objs.length) toast('info', { key: 'ed36.lockedSkipped', params: { count: objs.length - free.length } });
  return free;
}

export function deleteSelection() {
  if (!editable()) return;
  const free = unlockedSelection();
  if (!free.length) return;
  world().applyEdit({ remove: free.map((o) => o.id) });
  const gone = new Set(free.map((o) => o.id));
  editor().setSelection(editor().selectedIds.filter((id) => !gone.has(id)));
}

/** Copies 2 m south-east of the originals, groups preserved as new groups, one undo step. */
export function duplicateSelection() {
  if (!editable()) return;
  const objs = selectedObjects();
  if (!objs.length) return;
  if (objs.length === 1 && !objs[0].group) {
    // Single object: the pre-Phase-16 behavior (keeps the exact copy semantics).
    const copy = world().duplicate(objs[0].id);
    if (copy) editor().select(copy);
    return;
  }
  const terrain = samplerFor(world().doc.terrain);
  const bp = createBlueprint(objs, terrain);
  const pivot = selectionPivot(objs);
  const ids = world().applyEdit({ add: instantiateBlueprint(bp, pivot.x + 2, pivot.z + 2, 0, terrain) });
  editor().setSelection(ids);
}

/** Move / rotate the selection as one rigid unit about its pivot (one undo step). */
export function transformSelection(d: RigidDelta, pivot?: { x: number; z: number }) {
  if (!editable()) return;
  const objs = unlockedSelection();
  if (!objs.length) return;
  const terrain = samplerFor(world().doc.terrain);
  world().applyEdit({ update: transformObjects(objs, pivot ?? selectionPivot(objs), d, terrain) });
}

export function alignSelection(axis: AlignAxis, mode: AlignMode, ref: AlignRef = 'origin') {
  if (!editable()) return;
  const objs = unlockedSelection();
  if (objs.length < 2) return;
  world().applyEdit({ update: alignObjects(objs, axis, mode, samplerFor(world().doc.terrain), ref) });
}

/** Equal gaps between footprints along an axis (Phase 36), one undo step. */
export function distributeGapsSelection(axis: AlignAxis) {
  if (!editable()) return;
  const objs = unlockedSelection();
  if (objs.length < 3) return;
  world().applyEdit({ update: distributeGaps(objs, axis, samplerFor(world().doc.terrain)) });
}

/** Same heading / height above ground / scale as the primary selected object (Phase 36), one undo step. */
export function matchSelection(what: MatchWhat) {
  if (!editable()) return;
  const ref = editor().selectedId ? world().doc.objects[editor().selectedId!] : undefined;
  const objs = unlockedSelection();
  if (!ref || objs.length < 1) return;
  world().applyEdit({ update: matchObjects(objs, ref, what, samplerFor(world().doc.terrain)) });
}

export function distributeSelection(axis: AlignAxis) {
  if (!editable()) return;
  const objs = unlockedSelection();
  if (objs.length < 3) return;
  world().applyEdit({ update: distributeObjects(objs, axis, samplerFor(world().doc.terrain)) });
}

/** Put the selected objects in one new group (leaving any previous group). */
export function groupSelection() {
  if (!editable()) return;
  const objs = selectedObjects();
  if (objs.length < 2) return;
  const group = createId('grp');
  world().applyEdit({ update: objs.map((o) => ({ ...o, group })) });
  toast('success', { key: 'build.toast.grouped', params: { count: objs.length } });
}

export function ungroupSelection() {
  if (!editable()) return;
  const objs = selectedObjects().filter((o) => o.group);
  if (!objs.length) return;
  world().applyEdit({
    update: objs.map((o) => {
      const { group: _drop, ...rest } = o;
      return rest as WorldObject;
    }),
  });
  toast('info', { key: 'build.toast.ungrouped', params: { count: objs.length } });
}

// ── Copy / paste ─────────────────────────────────────────────────────────

export function copySelection(): boolean {
  // Road Editing Mode (Phase 18): the selected roads + the objects linked to them.
  if (editor().tool === 'road') return copyRoadSelection();
  const objs = selectedObjects();
  if (!objs.length) return false;
  useBuildStore.getState().setClipboard(createBlueprint(objs, samplerFor(world().doc.terrain)));
  toast('info', { key: 'build.toast.copied', params: { count: objs.length } });
  return true;
}

/** Copy the selected road segments with every object linked to them (one blueprint). */
export function copyRoadSelection(): boolean {
  const segs = useRoadStore.getState().selection.segments;
  if (!segs.length) return false;
  const doc = world().doc;
  const set = new Set(segs);
  const objs = Object.values(doc.objects).filter((o) => o.roadLink && set.has(o.roadLink.segment));
  useBuildStore.getState().setClipboard(createBlueprint(objs, samplerFor(doc.terrain), '', { network: doc.roads, segments: segs }));
  toast('info', { key: 'road.toast.copied', params: { roads: segs.length, count: objs.length } });
  return true;
}

/** Arm the paste tool (the clipboard follows the cursor; click places a copy). */
export function startPaste() {
  if (!editable()) return;
  if (!useBuildStore.getState().clipboard) {
    toast('warn', { key: 'build.toast.clipboardEmpty' });
    return;
  }
  editor().setTool('paste');
}

/** Place the clipboard with its anchor at (x, z). Returns the new ids (selected). */
export function pasteAt(x: number, z: number): EntityId[] {
  const b = useBuildStore.getState();
  if (!editable() || !b.clipboard) return [];
  const terrain = samplerFor(world().doc.terrain);
  const inputs = instantiateBlueprint(b.clipboard, x, z, b.pasteYaw, terrain);
  if (!b.clipboard.roads) {
    const ids = world().applyEdit({ add: inputs });
    editor().setSelection(ids);
    return ids;
  }
  // Roads (Phase 18): fresh ids, the chosen connection policy, links re-measured on the copy.
  try {
    const r = pasteRoads(world().doc.roads, b.clipboard.roads, x, z, b.pasteYaw, b.roadPaste, terrain.sampleHeight(x, z));
    b.clipboard.objects.forEach((o, i) => {
      if (!o.roadLink) return;
      const ids = r.segments[o.roadLink.segment] ?? [];
      const p = inputs[i].transform.position;
      const link = measureLink(r.network, p[0], p[2], yawOf(inputs[i].transform.rotation), o.roadLink.policy, ids.length === 1 ? ids[0] : undefined);
      if (link && ids.includes(link.segment)) inputs[i].roadLink = link;
    });
    const ids = world().applyEdit({ roads: r.network, add: inputs });
    if (r.unconnectedCrossings) toast('warn', { key: 'road.toast.unconnected', params: { n: r.unconnectedCrossings } });
    useRoadStore.getState().select({ segments: r.segments.flat(), node: null });
    if (editor().tool !== 'road') editor().setSelection(ids);
    return ids;
  } catch (e) {
    toast('error', { key: 'road.error.invalid' }, (e as Error).message);
    return [];
  }
}

// ── Bulk placement ───────────────────────────────────────────────────────

/** Commit the accepted entries of a placement plan (brush stroke, line, area) as ONE undo step. */
export function commitPlan(plan: readonly PlannedObject[], itemId: string | null): EntityId[] {
  const inputs: CreateObjectInput[] = plan.filter((p) => p.ok).map((p) => p.input);
  const reasons: Record<string, number> = {};
  for (const p of plan) if (!p.ok && p.rejected) reasons[p.rejected] = (reasons[p.rejected] ?? 0) + 1;
  const b = useBuildStore.getState();
  b.setLastResult({ placed: inputs.length, skipped: plan.length - inputs.length, reasons });
  if (!editable() || !inputs.length) return [];
  let ids: EntityId[] = [];
  try {
    ids = world().applyEdit({ add: inputs });
  } catch (err) {
    // applyEdit builds the whole edit before committing: nothing was added.
    console.error(err);
    toast('error', { key: 'build.toast.failed' }, String(err));
    return [];
  }
  if (itemId) b.pushRecent(itemId);
  toast('success', { key: 'build.toast.placed', params: { count: ids.length, skipped: plan.length - ids.length } });
  return ids;
}
