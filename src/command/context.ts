/**
 * Phase 37 — what a command is planned against (§4): a read-only document and a small Context of UI state (selection,
 * cursor ground point, camera look-at, the result sets of earlier commands). The Context goes into PLANS only — which
 * objects "these" are, where "here" is; nothing of it reaches the simulation.
 */
import type { EntityId } from '@/core/types';
import type { WorldDocument, WorldObject } from '@/core/model';
import type { I18nMessage, MessageKey, TranslateParams } from '@/i18n/i18n';
import { samplerFor, type TerrainSampler } from '@/terrain/TerrainSampler';

/** A message kept as data (translated when shown): summaries, notes, errors, questions. */
export type Msg = I18nMessage;
export const msg = (key: MessageKey, params?: TranslateParams): Msg => (params ? { key, params } : { key });

/** Things a preview / a clarifying question points at in the viewport. */
export interface Highlight {
  ids?: EntityId[];
  segments?: string[];
  nodes?: string[];
  points?: [number, number][];
  instances?: string[];
}

/** One disaster of the current run, as the planner needs it (read from SimulationController.instances()). */
export interface RuntimeInstance {
  key: string;
  type: string;
  status: string;
  /** Whether this instance can be stopped / paused right now. */
  stop: boolean;
  pause: boolean;
}

/** Read-only view of a running simulation (null in the editor). */
export interface RuntimeView {
  time: number;
  instances: RuntimeInstance[];
  /** Numbers the results panel already shows (damaged / collapsed counts …), by their own keys. */
  summary: Record<string, number>;
}

export interface CommandContext {
  /** Selected object ids (as the editor has them: whole groups). */
  selection: readonly EntityId[];
  primary: EntityId | null;
  /** The last ground point under the mouse (kept after the pointer leaves the viewport); null = never over it. */
  cursor: readonly [number, number] | null;
  /** Where the middle of the view meets the ground; null = unknown. */
  view: readonly [number, number] | null;
  /** Result sets of earlier confirmed commands, newest last (at most RESULT_DEPTH). */
  results: readonly (readonly EntityId[])[];
  /** A simulation runs on the document (it is locked). */
  simulating: boolean;
  runtime: RuntimeView | null;
}

export const RESULT_DEPTH = 10;

export function emptyContext(): CommandContext {
  return { selection: [], primary: null, cursor: null, view: null, results: [], simulating: false, runtime: null };
}

/** The context after a command made / changed `ids` ("the ones just made"). Empty sets are not recorded. */
export function pushResult(ctx: CommandContext, ids: readonly EntityId[]): CommandContext {
  if (!ids.length) return ctx;
  return { ...ctx, results: [...ctx.results, [...ids]].slice(-RESULT_DEPTH) };
}

/** Result sets without the ids that no longer exist (undo, delete); emptied sets are dropped. */
export function pruneResults(ctx: CommandContext, objects: WorldDocument['objects']): CommandContext {
  let changed = false;
  const results = ctx.results
    .map((set) => {
      const kept = set.filter((id) => objects[id]);
      if (kept.length !== set.length) changed = true;
      return kept;
    })
    .filter((set) => set.length > 0);
  return changed ? { ...ctx, results } : ctx;
}

/** What `resolve` and `plan` read. */
export interface Env {
  doc: WorldDocument;
  ctx: CommandContext;
  terrain: TerrainSampler;
}

export const envOf = (doc: WorldDocument, ctx: CommandContext): Env => ({ doc, ctx, terrain: samplerFor(doc.terrain) });

/** Half size of the map (m): the same number disaster placement uses for the map edge. */
export const mapHalf = (doc: WorldDocument): number => ((doc.terrain.nx - 1) * doc.terrain.cellSize) / 2;

const byOrder = (a: WorldObject, b: WorldObject) =>
  (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || a.serial - b.serial || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const orderCache = new WeakMap<WorldDocument['objects'], readonly WorldObject[]>();

/**
 * The objects in the order commands see them: by type, then by the running number of the type, then by id — never in
 * the object map's insertion order, and not by id alone (ids are random: a script run twice makes other ids, the
 * running numbers are the same). "First 3" and every tie are decided in this order.
 */
export function orderedObjects(doc: WorldDocument): readonly WorldObject[] {
  let hit = orderCache.get(doc.objects);
  if (!hit) {
    hit = Object.values(doc.objects).sort(byOrder);
    orderCache.set(doc.objects, hit);
  }
  return hit;
}

/** Ids in command order (see orderedObjects). */
export function sortIds(doc: WorldDocument, ids: Iterable<EntityId>): EntityId[] {
  const out: WorldObject[] = [];
  for (const id of new Set(ids)) {
    const o = doc.objects[id];
    if (o) out.push(o);
  }
  return out.sort(byOrder).map((o) => o.id);
}

/** All members of the groups of `ids` (plus the ungrouped ids themselves) — the editor's selection unit. */
export function expandGroups(doc: WorldDocument, ids: readonly EntityId[]): EntityId[] {
  const groups = new Set<string>();
  for (const id of ids) {
    const g = doc.objects[id]?.group;
    if (g) groups.add(g);
  }
  if (!groups.size) return ids.filter((id) => doc.objects[id]);
  const out = new Set(ids.filter((id) => doc.objects[id]));
  for (const o of orderedObjects(doc)) if (o.group && groups.has(o.group)) out.add(o.id);
  return [...out];
}
