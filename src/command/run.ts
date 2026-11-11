/**
 * Phase 37 — running plans (§4, §9, §10): intents are planned and applied one after the other on a world store, all of
 * them as ONE undo step (`worldStore.batch`); any error or question on the way leaves the document as it was.
 *
 * The same function runs on a FORK of the document for the preview (`previewIntents`: nothing of the edited document
 * is touched; the result is the difference between the document and the fork) and on the document when the user
 * confirms (`runIntents`). Later intents see what earlier ones made: "them" is the result of the line before.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { EntityId } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { BuildingDesign } from '@/buildings/types';
import { forkDocument } from '@/world/fork';
import { scratchWorld, type WorldState } from '@/world/worldStore';
import { envOf, msg, pruneResults, pushResult, type CommandContext, type Msg } from './context';
import { diffDocuments, type DocDiff } from './diff';
import type { Intent } from './intent';
import { planIntent } from './plan';
import type { Effect, Plan, PlanClarify, PlanOp } from './planTypes';
import { programDabs } from './planWorld';

export type WorldStore = Pick<StoreApi<WorldState>, 'getState'>;

/** Carry out a plan's operations on a store (inside the caller's batch). Returns the ids of the objects they add. */
export function applyOps(store: WorldStore, ops: readonly PlanOp[]): EntityId[] {
  const added: EntityId[] = [];
  for (const op of ops) {
    const S = store.getState();
    switch (op.op) {
      case 'edit': {
        const ids = S.applyEdit(op.edit);
        if (op.result === 'added') added.push(...ids);
        break;
      }
      case 'stamp':
        added.push(...S.applyEdit({ add: op.inputs }));
        break;
      case 'groupName':
        S.setGroupName(op.group, op.name);
        break;
      case 'experiment':
        S.setExperiment({ instances: op.instances });
        break;
      case 'terrain':
        S.beginTerrainStroke();
        for (const dab of programDabs(S.doc.terrain, op.stroke)) store.getState().terrainDab(dab);
        store.getState().endTerrainStroke();
        break;
    }
  }
  return added;
}

export interface LineOutcome {
  plan: Plan;
  /** Ids of the objects the plan's operations added. */
  added: EntityId[];
}

export type RunFailure = { index: number; error: Msg; notes: Msg[] } | { index: number; clarify: PlanClarify };

export type RunResult =
  | { ok: true; lines: LineOutcome[]; ctx: CommandContext; effects: Effect[]; changed: boolean; hash: string }
  | { ok: false; failure: RunFailure; lines: LineOutcome[] };

class RunAbort extends Error {
  constructor(readonly failure: RunFailure) {
    super('command stopped');
  }
}

// ── Plan hash ────────────────────────────────────────────────────────────────────────

function fnv(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const designDigest = new WeakMap<BuildingDesign, string>();

/** A plan as text: what it would do, with building designs by content hash (they are large shared values). */
function planText(plan: Plan): string {
  return JSON.stringify({ c: plan.canonical, ops: plan.ops, fx: plan.effects }, (key, value: unknown) => {
    if (key === 'building' && value && typeof value === 'object') {
      const design = value as BuildingDesign;
      let h = designDigest.get(design);
      if (!h) designDigest.set(design, (h = fnv(JSON.stringify(design))));
      return h;
    }
    if (key === 'underlay') return undefined;
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
    return value;
  });
}

/**
 * Names for the ids a run makes: object ids are random (and group ids of copies), so the plan of a later line — which
 * names what an earlier line made — differs between the preview's fork and the document, and between two runs. In the
 * hash they are called by the order they appear in.
 */
class Names {
  private readonly map = new Map<string, string>();
  private objects = 0;
  private groups = 0;
  constructor(private readonly startGroups: ReadonlySet<string>) {}
  object(id: EntityId) { if (!this.map.has(id)) this.map.set(id, `new#${++this.objects}`); }
  group(id: string | undefined) { if (id && !this.startGroups.has(id) && !this.map.has(id)) this.map.set(id, `group#${++this.groups}`); }
  apply(text: string): string {
    let out = text;
    for (const [id, name] of [...this.map.entries()].sort((a, b) => b[0].length - a[0].length)) if (out.includes(id)) out = out.split(id).join(name);
    return out;
  }
}

function groupsOf(doc: WorldDocument): Set<string> {
  const out = new Set(Object.keys(doc.groups ?? {}));
  for (const o of Object.values(doc.objects)) if (o.group) out.add(o.group);
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────────────

/**
 * Plan and apply `intents` in order on `store`, as one undo step. Stops at the first error or question: the document
 * is then exactly as before (and no step is recorded). Effects outside the document (camera, run control, selection)
 * are returned for the caller to carry out — except that a selection made by one line is what the next line sees.
 * While a simulation runs on the document it is locked: only disasters are written (as the mouse does — without undo).
 */
export function runIntents(store: WorldStore, intents: readonly Intent[], ctx0: CommandContext): RunResult {
  const lines: LineOutcome[] = [];
  const effects: Effect[] = [];
  const texts: string[] = [];
  let ctx = ctx0;
  const names = new Names(groupsOf(store.getState().doc));
  const body = () => {
    intents.forEach((intent, index) => {
      const doc = store.getState().doc;
      const r = planIntent(intent, envOf(doc, ctx), { seed: doc.settings.simulation.seed });
      if (!r.ok) throw new RunAbort('error' in r ? { index, error: r.error, notes: r.notes } : { index, clarify: r.clarify });
      for (const op of r.plan.ops) {
        if (op.op === 'stamp') for (const input of op.inputs) names.group(input.group);
        if (op.op === 'edit') for (const input of op.edit.add ?? []) names.group(input.group);
      }
      const added = applyOps(store, r.plan.ops);
      for (const id of added) names.object(id);
      texts.push(names.apply(planText(r.plan)));
      lines.push({ plan: r.plan, added });
      const result = [...r.plan.resultIds, ...added];
      if (result.length) ctx = pushResult(ctx, result);
      for (const fx of r.plan.effects) {
        if (fx.fx === 'select') ctx = { ...ctx, selection: fx.ids, primary: fx.primary };
        else if (fx.fx === 'selectAdded') ctx = { ...ctx, selection: added, primary: added[0] ?? null };
        effects.push(fx);
      }
      // What a line removed is gone from "them" and from the selection of the lines after it.
      const objects = store.getState().doc.objects;
      ctx = pruneResults(ctx, objects);
      if (ctx.selection.some((id) => !objects[id])) {
        const selection = ctx.selection.filter((id) => objects[id]);
        ctx = { ...ctx, selection, primary: ctx.primary && objects[ctx.primary] ? ctx.primary : selection[0] ?? null };
      }
    });
  };
  const fail = (failure: RunFailure): RunResult => ({ ok: false, failure, lines });
  if (store.getState().locked) {
    // (planIntent has refused every editing command; what is left writes nothing or the experiment plan)
    try {
      body();
    } catch (e) {
      if (e instanceof RunAbort) return fail(e.failure);
      throw e;
    }
    return { ok: true, lines, ctx, effects, changed: lines.some((l) => l.plan.ops.length > 0), hash: fnv(texts.join('\n')) };
  }
  const res = store.getState().batch(body);
  if (!res.ok) {
    if (res.reason === 'busy') return fail({ index: 0, error: msg('cmd37.err.busy'), notes: [] });
    if (res.reason === 'locked') return fail({ index: 0, error: msg('cmd37.err.simulating'), notes: [] });
    if (res.error instanceof RunAbort) return fail(res.error.failure);
    return fail({ index: Math.min(lines.length, intents.length - 1), error: msg('cmd37.err.internal', { message: res.error instanceof Error ? res.error.message : String(res.error) }), notes: [] });
  }
  return { ok: true, lines, ctx, effects, changed: res.changed, hash: fnv(texts.join('\n')) };
}

// ── Preview ──────────────────────────────────────────────────────────────────────────

export interface Preview {
  /** The document the preview was made on (by reference: a different one means "plan again"). */
  doc: WorldDocument;
  result: RunResult;
  /** What would change: the document compared with the fork the plans ran on (null when the run failed). */
  diff: DocDiff | null;
}

/** Run the intents on a fork of the document: the document itself is not touched. */
export function previewIntents(doc: WorldDocument, intents: readonly Intent[], ctx: CommandContext): Preview {
  const fork = scratchWorld(forkDocument(doc));
  const result = runIntents(fork, intents, ctx);
  return { doc, result, diff: result.ok ? diffDocuments(doc, fork.getState().doc) : null };
}
