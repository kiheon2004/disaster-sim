/**
 * Phase 37 — planning the edits of existing objects: selection, move / rotate / scale, align / distribute / match,
 * property copy, groups and names, hide / lock, delete, duplicate. Every change is computed by the pure functions the
 * editor's own actions use (editor/build/groupTransform.ts, propertyCopy.ts, objectEdits.ts, blueprint.ts) and becomes
 * one `applyEdit`.
 *
 * Locked objects are never moved, changed or deleted (Phase 36's rule for the selection); hidden objects are left
 * alone by commands that sweep objects up by kind ("delete all trees") and are included when they are named — by id,
 * by the selection, by a `hidden` filter. What was left out is said in the notes.
 */
import type { EntityId, Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { degToRad, hashString } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import { createBlueprint, instantiateBlueprint, stampKeys } from '@/editor/build/blueprint';
import { setCommonTransform } from '@/editor/build/numericTransform';
import { subSeed } from '@/editor/build/distribution';
import { FootprintIndex } from '@/editor/build/footprint';
import { alignObjects, distributeGaps, distributeObjects, matchObjects, selectionPivot, transformObjects } from '@/editor/build/groupTransform';
import { withFlags, withGroup, withoutGroup } from '@/editor/build/objectEdits';
import { checkStamp } from '@/editor/build/placementCheck';
import { copyProperties, type CopyProp } from '@/editor/build/propertyCopy';
import { isInsideWorld } from '@/editor/placement';
import { yawOf } from '@/terrain/groundPlacement';
import { sameObjectValue } from '@/world/sameObject';
import { expandGroups, msg, sortIds, type Env } from './context';
import { formatCanonical } from './canonical';
import type { Intent, IntentOf, TargetRef } from './intent';
import { CONFIRM_ITEMS, MAX_ITEMS, need, PlanStop, stop, type Draft, type PlanOptions } from './planTypes';
import { footprintBounds, resolvePlace, resolveTarget, tieQuestion, type TargetSet } from './resolve';

type Compass = 'north' | 'south' | 'east' | 'west';

/** A target's objects; a rank that ended in a tie is a question for editing commands (`askTie`) and "all of them" otherwise. */
export function targetOf(ref: TargetRef, env: Env, d: Draft, askTie: boolean): TargetSet {
  const set = need(resolveTarget(ref, env), d.notes);
  if (set.tie && askTie) throw new PlanStop({ clarify: tieQuestion(ref, set.tie) });
  if (set.tie) d.notes.push(msg('cmd37.note.tie', { count: set.tie.length }));
  return set;
}

/** The objects of a set an edit may change: without the locked ones, and without hidden ones that were only swept up. */
export function editable(set: TargetSet, d: Draft, opts: { locked?: boolean } = {}): WorldObject[] {
  let objs = set.objects;
  if (!opts.locked) {
    const free = objs.filter((o) => !o.locked);
    if (free.length < objs.length) d.notes.push(msg('cmd37.note.lockedSkipped', { count: objs.length - free.length }));
    objs = free;
  }
  if (!set.explicit) {
    const shown = objs.filter((o) => !o.hidden);
    if (shown.length < objs.length) d.notes.push(msg('cmd37.note.hiddenSkipped', { count: objs.length - shown.length }));
    objs = shown;
  }
  if (!objs.length) stop(msg('cmd37.err.nothingEditable'));
  if (objs.length > MAX_ITEMS) stop(msg('cmd37.err.tooMany', { count: objs.length, max: MAX_ITEMS }));
  return objs;
}

const ids = (objs: readonly WorldObject[]): EntityId[] => objs.map((o) => o.id);

/** Whether an object's footprint is inside the world square. */
function inWorld(o: WorldObject): boolean {
  const dims = getDefinition(o.type).getDimensions(o.params);
  const k = o.transform.scale;
  return isInsideWorld(o.transform.position, [dims[0] * k[0], dims[1] * k[1], dims[2] * k[2]] as Vec3, yawOf(o.transform.rotation));
}

/**
 * Record an update of existing objects: only the ones that really changed (by value), minus the ones that would leave
 * the world (reported, left where they are).
 */
function update(d: Draft, before: readonly WorldObject[], after: readonly WorldObject[]): void {
  const changed = after.filter((o, k) => !sameObjectValue(o, before[k]));
  const inside = changed.filter(inWorld);
  if (inside.length < changed.length) d.warnings.push(msg('cmd37.warn.outside', { count: changed.length - inside.length }));
  if (!inside.length) {
    if (changed.length) stop(msg('cmd37.err.allOutside'));
    d.notes.push(msg('cmd37.note.noChange'));
    return;
  }
  d.ops.push({ op: 'edit', edit: { update: inside }, result: 'updated' });
  d.counts.change = inside.length;
  d.resultIds = ids(inside);
  d.highlight = { ids: ids(inside) };
  if (inside.length >= CONFIRM_ITEMS) d.confirm = msg('cmd37.confirm.many', { count: inside.length });
}

// ── Selection ────────────────────────────────────────────────────────────────────────

export function planSelect(i: IntentOf<'select'>, env: Env, d: Draft): void {
  const set = targetOf(i.target, env, d, false);
  const hit = ids(set.objects);
  // Like "select all in the list" of the outliner: hidden and locked objects are part of it — and it is said.
  const hidden = set.objects.filter((o) => o.hidden).length, locked = set.objects.filter((o) => o.locked).length;
  if (hidden || locked) d.notes.push(msg('cmd37.note.selectFlags', { hidden, locked }));
  const cur = sortIds(env.doc, expandGroups(env.doc, env.ctx.selection));
  let next: EntityId[];
  if (i.mode === 'set') next = hit;
  else if (i.mode === 'add') next = [...new Set([...cur, ...hit])];
  else {
    const drop = new Set(hit);
    next = cur.filter((id) => !drop.has(id));
  }
  d.effects.push({ fx: 'select', ids: next, primary: next.includes(env.ctx.primary ?? '') ? env.ctx.primary : next[0] ?? null });
  d.immediate = true;
  d.highlight = { ids: next };
  d.table = { title: msg('cmd37.sum.selected', { count: next.length }), columns: [], rows: [], ids: next };
}

export function planDeselect(d: Draft): void {
  d.effects.push({ fx: 'select', ids: [], primary: null });
  d.immediate = true;
}

// ── Transforms ───────────────────────────────────────────────────────────────────────

export function planMove(i: IntentOf<'move'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  const pivot = selectionPivot(objs);
  let dx: number, dy: number, dz: number;
  if (i.by) [dx, dy, dz] = i.by;
  else {
    const [x0, z0, x1, z1] = footprintBounds(objs);
    const to = need(resolvePlace(i.to!, env, Math.max(x1 - x0, z1 - z0) / 2), d.notes);
    dx = to.x - pivot.x; dy = 0; dz = to.z - pivot.z;
  }
  update(d, objs, transformObjects(objs, pivot, { dx, dy, dz, dyaw: 0 }, env.terrain));
}

export function planRotate(i: IntentOf<'rotate'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  update(d, objs, transformObjects(objs, selectionPivot(objs), { dx: 0, dy: 0, dz: 0, dyaw: degToRad(i.by) }, env.terrain));
}

export function planScale(i: IntentOf<'scale'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  const modular = objs.filter((o) => o.building).length;
  if (modular) d.notes.push(msg('cmd37.note.modularScale', { count: modular }));
  update(d, objs, transformObjects(objs, selectionPivot(objs), { dx: 0, dy: 0, dz: 0, dyaw: 0, scale: i.factor }, env.terrain));
}

/**
 * The same value into a transform field of every object — the multi-selection Inspector's common fields
 * (`setCommonTransform`): x / z inside the world square, objects that stood on the ground are seated again where they
 * land, lifted ones keep their height; `lift` = height above the ground under each object.
 */
export function planSet(i: IntentOf<'set'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  const { kind: _kind, target: _target, ...patch } = i;
  void _kind; void _target;
  const r = setCommonTransform(objs, patch, env.terrain);
  if (r.clamped.length) d.warnings.push(msg('cmd37.warn.setClamped', { fields: r.clamped.join(', ') }));
  if (r.keptSize) d.notes.push(msg('cmd37.note.modularScale', { count: r.keptSize }));
  const byId = new Map(objs.map((o) => [o.id, o]));
  update(d, r.objects.map((o) => byId.get(o.id) ?? o), r.objects);
}

// ── Align · distribute · match · copy ────────────────────────────────────────────────

/** The compass side an object's front points to (buildings and people face local +z, vehicles local +x). */
function frontOf(o: WorldObject): Compass {
  const yaw = yawOf(o.transform.rotation);
  const [x, z] = o.type === 'car' ? [Math.cos(yaw), -Math.sin(yaw)] : [Math.sin(yaw), Math.cos(yaw)];
  return Math.abs(x) >= Math.abs(z) ? (x >= 0 ? 'east' : 'west') : z >= 0 ? 'south' : 'north';
}

const EDGE: Record<Compass, { axis: 'x' | 'z'; mode: 'min' | 'max' }> = {
  north: { axis: 'z', mode: 'min' }, south: { axis: 'z', mode: 'max' }, west: { axis: 'x', mode: 'min' }, east: { axis: 'x', mode: 'max' },
};
const OPPOSITE: Record<Compass, Compass> = { north: 'south', south: 'north', east: 'west', west: 'east' };

export function planAlign(i: IntentOf<'align'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  if (objs.length < 2) stop(msg('cmd37.err.needTwo'));
  let axis = i.axis, mode = i.mode;
  if (i.edge) {
    // Fronts: the side the objects face — when they all face the same compass side; else a question.
    const fronts = new Set(objs.map(frontOf));
    if (fronts.size !== 1) {
      throw new PlanStop({
        planClarify: {
          question: msg('cmd37.ask.alignEdge'),
          options: (['north', 'south', 'west', 'east'] as const).map((c) => {
            const { edge: _edge, ...rest } = i;
            void _edge;
            const intent: Intent = { ...rest, ...EDGE[c] };
            return { label: msg('cmd37.opt.edge', { compass: `@cmd37.dir.${c}` }), intent, canonical: formatCanonical(intent), highlight: { ids: ids(objs) } };
          }),
        },
      });
    }
    const side = i.edge === 'front' ? [...fronts][0] : OPPOSITE[[...fronts][0]];
    ({ axis, mode } = EDGE[side]);
    d.notes.push(msg('cmd37.note.alignEdge', { edge: `@cmd37.edge.${i.edge}`, compass: `@cmd37.dir.${side}` }));
  }
  update(d, objs, alignObjects(objs, axis!, mode!, env.terrain, i.ref === 'footprint' ? 'bounds' : 'origin'));
}

export function planDistribute(i: IntentOf<'distribute'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  if (objs.length < 3) stop(msg('cmd37.err.needThree'));
  let axis: 'x' | 'z';
  if (i.axis === 'auto') {
    const xs = objs.map((o) => o.transform.position[0]), zs = objs.map((o) => o.transform.position[2]);
    axis = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs) ? 'x' : 'z';
    d.notes.push(msg('cmd37.note.axisAuto', { axis: `@cmd37.axis.${axis}` }));
  } else axis = i.axis;
  update(d, objs, i.gaps ? distributeGaps(objs, axis, env.terrain) : distributeObjects(objs, axis, env.terrain));
}

/** The one object a reference names (a question when it names several). */
function single(ref: TargetRef, env: Env, d: Draft): WorldObject {
  const set = need(resolveTarget(ref, env), d.notes);
  if (set.objects.length === 1) return set.objects[0];
  throw new PlanStop({ clarify: tieQuestion(ref, set.objects) });
}

export function planMatch(i: IntentOf<'match'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  const primary = env.ctx.primary ? env.doc.objects[env.ctx.primary] : undefined;
  const ref = i.to ? single(i.to, env, d) : primary ?? stop(msg('cmd37.err.noReference'));
  if (!i.to) d.notes.push(msg('cmd37.note.referencePrimary', { id: ref.id }));
  update(d, objs, matchObjects(objs, ref, i.what === 'heading' ? 'rotation' : i.what, env.terrain));
}

export function planCopy(i: IntentOf<'copy'>, env: Env, d: Draft): void {
  const ref = single(i.from, env, d);
  const objs = editable(targetOf(i.target, env, d, true), d).filter((o) => o.id !== ref.id);
  if (!objs.length) stop(msg('cmd37.err.nothingEditable'));
  const r = copyProperties(ref, objs, new Set<CopyProp>(i.props), env.terrain);
  d.notes.push(msg('cmd37.note.copied', { applied: r.applied, skipped: r.skipped }));
  const byId = new Map(objs.map((o) => [o.id, o]));
  update(d, r.objects.map((o) => byId.get(o.id) ?? o), r.objects);
}

// ── Groups, names, flags ─────────────────────────────────────────────────────────────

/** A group id made from the command (not random: the same command gives the same plan), free in this document. */
function groupId(env: Env, o: PlanOptions, canonical: string): string {
  const taken = new Set<string>(Object.keys(env.doc.groups ?? {}));
  for (const x of Object.values(env.doc.objects)) if (x.group) taken.add(x.group);
  for (let k = 0; ; k++) {
    const id = `grp_c${subSeed(o.seed, 'group', hashString(canonical) + k).toString(36)}`;
    if (!taken.has(id)) return id;
  }
}

export function planGroup(i: IntentOf<'group'>, env: Env, o: PlanOptions, d: Draft): void {
  const objs = targetOf(i.target, env, d, true).objects;
  if (objs.length < 2) stop(msg('cmd37.err.needTwo'));
  if (objs.length > MAX_ITEMS) stop(msg('cmd37.err.tooMany', { count: objs.length, max: MAX_ITEMS }));
  const id = groupId(env, o, formatCanonical(i));
  d.ops.push({ op: 'edit', edit: { update: withGroup(objs, id) }, result: 'updated' });
  if (i.name !== undefined) d.ops.push({ op: 'groupName', group: id, name: i.name });
  d.counts.change = objs.length;
  d.resultIds = ids(objs);
  d.highlight = { ids: ids(objs) };
}

export function planUngroup(i: IntentOf<'ungroup'>, env: Env, d: Draft): void {
  const objs = withoutGroup(targetOf(i.target, env, d, true).objects);
  if (!objs.length) stop(msg('cmd37.err.notGrouped'));
  d.ops.push({ op: 'edit', edit: { update: objs }, result: 'updated' });
  d.counts.change = objs.length;
  d.resultIds = ids(objs);
  d.highlight = { ids: ids(objs) };
}

export function planRename(i: IntentOf<'rename'>, env: Env, d: Draft): void {
  const objs = targetOf(i.target, env, d, true).objects;
  const groups = new Set(objs.map((o) => o.group));
  const group = groups.size === 1 ? [...groups][0] : undefined;
  // One whole group → the group's name; one object → the object's name; anything else is not one thing to name.
  if (group && objs.length > 1 && Object.values(env.doc.objects).filter((o) => o.group === group).length === objs.length) {
    d.ops.push({ op: 'groupName', group, name: i.name });
    d.counts.change = 1;
    d.resultIds = ids(objs);
    d.highlight = { ids: ids(objs) };
    return;
  }
  if (objs.length !== 1) stop(msg('cmd37.err.renameMany', { count: objs.length }));
  if (objs[0].name === i.name) {
    d.notes.push(msg('cmd37.note.noChange'));
    return;
  }
  d.ops.push({ op: 'edit', edit: { update: [{ ...objs[0], name: i.name }] }, result: 'updated' });
  d.counts.change = 1;
  d.resultIds = ids(objs);
  d.highlight = { ids: ids(objs) };
}

export function planFlag(i: IntentOf<'flag'>, env: Env, d: Draft): void {
  const objs = targetOf(i.target, env, d, true).objects;
  const flags = i.op === 'hide' ? { hidden: true } : i.op === 'show' ? { hidden: false } : i.op === 'lock' ? { locked: true } : { locked: false };
  const changed = withFlags(objs, flags);
  if (!changed.length) {
    d.notes.push(msg('cmd37.note.noChange'));
    return;
  }
  d.ops.push({ op: 'edit', edit: { update: changed }, result: 'updated' });
  d.counts.change = changed.length;
  d.resultIds = ids(changed);
  d.highlight = { ids: ids(changed) };
  if (i.op === 'hide') {
    // A hidden object leaves the viewport selection (as when it is hidden from the outliner).
    const gone = new Set(ids(changed));
    const sel = env.ctx.selection.filter((id) => !gone.has(id));
    if (sel.length !== env.ctx.selection.length) d.effects.push({ fx: 'select', ids: sel, primary: sel.includes(env.ctx.primary ?? '') ? env.ctx.primary : sel[0] ?? null });
  }
}

// ── Delete · duplicate ───────────────────────────────────────────────────────────────

export function planDelete(i: IntentOf<'delete'>, env: Env, d: Draft): void {
  const objs = editable(targetOf(i.target, env, d, true), d);
  const gone = new Set(ids(objs));
  // A group that loses only some of its members is said (the rest stays a group).
  const partial = new Set<string>();
  for (const o of objs) if (o.group && Object.values(env.doc.objects).some((x) => x.group === o.group && !gone.has(x.id))) partial.add(o.group);
  if (partial.size) d.warnings.push(msg('cmd37.warn.partialGroup', { count: partial.size }));
  d.ops.push({ op: 'edit', edit: { remove: ids(objs) }, result: 'none' });
  d.counts.remove = objs.length;
  d.highlight = { ids: ids(objs) };
  if (objs.length >= CONFIRM_ITEMS) d.confirm = msg('cmd37.confirm.delete', { count: objs.length });
}

/** Offset of a copy when none is said (m east, m south) — the editor's Ctrl+D. */
export const DUPLICATE_OFFSET: [number, number] = [2, 2];

export function planDuplicate(i: IntentOf<'duplicate'>, env: Env, d: Draft): void {
  const objs = targetOf(i.target, env, d, true).objects;
  if (objs.length > MAX_ITEMS) stop(msg('cmd37.err.tooMany', { count: objs.length, max: MAX_ITEMS }));
  const [dx, dz] = i.offset ?? DUPLICATE_OFFSET;
  if (!i.offset) d.notes.push(msg('cmd37.note.duplicateOffset', { dx, dz }));
  // The copied cars take their simulation settings along (occupants: only people copied with them).
  const bp = createBlueprint(objs, env.terrain, '', undefined, env.doc.settings.simulation.vehicles?.cars);
  const pivot = selectionPivot(objs);
  const inputs = instantiateBlueprint(bp, pivot.x + dx, pivot.z + dz, 0, env.terrain);
  // Like a paste: a stamp that reaches outside the world is refused; overlaps are warnings.
  const check = checkStamp(inputs, FootprintIndex.fromObjects(Object.values(env.doc.objects)));
  if (!check.ok) stop(msg('cmd37.err.stampOutside'));
  const overlaps = check.items.filter((x) => x.warnings.includes('overlap')).length;
  if (overlaps) d.warnings.push(msg('cmd37.warn.overlap', { count: overlaps }));
  inputs.forEach((input, k) => d.items.push({ status: check.items[k].warnings.length ? 'warn' : 'ok', x: input.transform.position[0], z: input.transform.position[2], reasons: check.items[k].warnings }));
  if (bp.cars) d.notes.push(msg('cmd37.note.carSettings', { count: Object.keys(bp.cars).length }));
  d.ops.push({ op: 'stamp', inputs, cars: bp.cars ?? null, keys: stampKeys(bp) });
  d.counts.create = inputs.length;
  if (inputs.length >= CONFIRM_ITEMS) d.confirm = msg('cmd37.confirm.many', { count: inputs.length });
}
