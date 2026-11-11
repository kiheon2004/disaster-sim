/**
 * Small object edits as pure functions (Phase 37: taken out of app/buildActions.ts so that the editor's actions and the
 * command planner share them): editor flags, putting objects in a group, taking them out. Each returns ONLY the
 * objects that change — callers do one `applyEdit({ update })`, and nothing at all when the list is empty.
 */
import type { WorldObject } from '@/core/model';

/**
 * Lock / unlock, hide / show (Phase 36 §44). Only `true` is stored — unlocking / showing removes the key — so a
 * document that never used the flags stays byte-identical.
 */
export function withFlags(objs: readonly WorldObject[], flags: { locked?: boolean; hidden?: boolean }): WorldObject[] {
  const out: WorldObject[] = [];
  for (const o of objs) {
    const next: WorldObject = { ...o };
    for (const k of ['locked', 'hidden'] as const) {
      if (flags[k] === undefined) continue;
      if (flags[k]) next[k] = true;
      else delete next[k];
    }
    if (next.locked !== o.locked || next.hidden !== o.hidden) out.push(next);
  }
  return out;
}

/** The objects as members of one group (leaving any group they were in). */
export function withGroup(objs: readonly WorldObject[], group: string): WorldObject[] {
  return objs.filter((o) => o.group !== group).map((o) => ({ ...o, group }));
}

/** The grouped ones among the objects, without their group. */
export function withoutGroup(objs: readonly WorldObject[]): WorldObject[] {
  return objs.filter((o) => o.group).map((o) => {
    const { group: _drop, ...rest } = o;
    void _drop;
    return rest as WorldObject;
  });
}
