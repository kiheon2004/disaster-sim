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
import { alignObjects, distributeObjects, selectionPivot, transformObjects, type AlignAxis, type AlignMode, type RigidDelta } from '@/editor/build/groupTransform';
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
 * Shift: add / remove it (and its group). Alt: just this object, ignoring its group.
 */
export function clickSelect(id: EntityId, mods: { shift?: boolean; alt?: boolean } = {}) {
  const ed = editor();
  const unit = mods.alt ? [id] : expandGroups([id]);
  if (mods.shift) {
    const cur = new Set(ed.selectedIds);
    const remove = unit.every((u) => cur.has(u));
    for (const u of unit) (remove ? cur.delete(u) : cur.add(u));
    ed.setSelection([...cur], remove ? ed.selectedId : id);
  } else ed.setSelection(unit, id);
}

/** Box selection result (Shift+drag). `add` keeps the current selection. */
export function boxSelect(ids: EntityId[], add: boolean) {
  const ed = editor();
  const unit = expandGroups(ids);
  ed.setSelection(add ? [...ed.selectedIds, ...unit] : unit, ed.selectedId && add ? ed.selectedId : unit[unit.length - 1] ?? null);
}

export function selectAll(category?: ObjectCategory) {
  const ids = Object.values(world().doc.objects).filter((o) => !category || getDefinition(o.type).category === category).map((o) => o.id);
  editor().setSelection(ids);
}

export function clearSelection() {
  editor().setSelection([]);
}

// ── Group editing ────────────────────────────────────────────────────────

export function deleteSelection() {
  if (!editable()) return;
  const ids = editor().selectedIds;
  if (!ids.length) return;
  world().applyEdit({ remove: ids });
  editor().setSelection([]);
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
  const objs = selectedObjects();
  if (!objs.length) return;
  const terrain = samplerFor(world().doc.terrain);
  world().applyEdit({ update: transformObjects(objs, pivot ?? selectionPivot(objs), d, terrain) });
}

export function alignSelection(axis: AlignAxis, mode: AlignMode) {
  if (!editable()) return;
  const objs = selectedObjects();
  if (objs.length < 2) return;
  world().applyEdit({ update: alignObjects(objs, axis, mode, samplerFor(world().doc.terrain)) });
}

export function distributeSelection(axis: AlignAxis) {
  if (!editable()) return;
  const objs = selectedObjects();
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
  const objs = selectedObjects();
  if (!objs.length) return false;
  useBuildStore.getState().setClipboard(createBlueprint(objs, samplerFor(world().doc.terrain)));
  toast('info', { key: 'build.toast.copied', params: { count: objs.length } });
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
  const ids = world().applyEdit({ add: instantiateBlueprint(b.clipboard, x, z, b.pasteYaw, samplerFor(world().doc.terrain)) });
  editor().setSelection(ids);
  return ids;
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
