/**
 * Phase 37 — the planner (§4): one intent + a read-only document + the Context → a Plan (what will be edited, what
 * the user is shown, what is asked) — or an error, or a question. Pure: no store is written, no clock, no randomness;
 * the same intent on the same document with the same Context gives the same plan.
 */
import { msg, type Env } from './context';
import { formatCanonical } from './canonical';
import { intentProblem, type Intent } from './intent';
import { planDisaster, planInstance, planSim, planSpeed } from './planDisaster';
import { planAlign, planCopy, planDelete, planDeselect, planDistribute, planDuplicate, planFlag, planGroup, planMatch, planMove, planRename, planRotate, planScale, planSelect, planSet, planUngroup } from './planEdit';
import { planPlace } from './planPlace';
import { planFocus, planQuery } from './planQuery';
import { newDraft, PlanStop, type Draft, type Plan, type PlanClarify, type PlanOptions, type PlanResult } from './planTypes';
import { planForestCommand, planPaint, planRoad, planTerrain } from './planWorld';
import type { Clarify } from './resolve';

/** A copy of a value with one node (found by identity, anywhere inside) replaced. */
function replaceNode<T>(value: T, node: object, by: unknown): T {
  if (value === node) return by as T;
  if (Array.isArray(value)) return value.map((v) => replaceNode(v, node, by)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceNode(v, node, by)])) as T;
  return value;
}

/** A resolver's question about one reference → the same question as whole intents to choose from. */
function clarifyIntent(intent: Intent, c: Clarify): PlanClarify {
  return {
    question: c.question,
    options: c.options.map((o) => {
      const next = replaceNode(intent, c.at, o.value);
      return { label: o.label, intent: next, canonical: formatCanonical(next), ...(o.highlight ? { highlight: o.highlight } : {}) };
    }),
  };
}

function dispatch(i: Intent, env: Env, o: PlanOptions, d: Draft): void {
  switch (i.kind) {
    case 'place': return planPlace(i, env, o, d);
    case 'select': return planSelect(i, env, d);
    case 'deselect': return planDeselect(d);
    case 'move': return planMove(i, env, d);
    case 'rotate': return planRotate(i, env, d);
    case 'scale': return planScale(i, env, d);
    case 'set': return planSet(i, env, d);
    case 'align': return planAlign(i, env, d);
    case 'distribute': return planDistribute(i, env, d);
    case 'match': return planMatch(i, env, d);
    case 'copy': return planCopy(i, env, d);
    case 'group': return planGroup(i, env, o, d);
    case 'ungroup': return planUngroup(i, env, d);
    case 'rename': return planRename(i, env, d);
    case 'flag': return planFlag(i, env, d);
    case 'delete': return planDelete(i, env, d);
    case 'duplicate': return planDuplicate(i, env, d);
    case 'terrain': return planTerrain(i, env, d);
    case 'paint': return planPaint(i, env, d);
    case 'road': return planRoad(i, env, d);
    case 'forest': return planForestCommand(i, env, o, d);
    case 'disaster': return planDisaster(i, env, d);
    case 'instance': return planInstance(i, env, d);
    case 'sim': return planSim(i, d);
    case 'speed': return planSpeed(i, d);
    case 'focus': return planFocus(i, env, d);
    case 'query': return planQuery(i, env, d);
    case 'undo': case 'redo':
      d.effects.push({ fx: i.kind });
      d.immediate = true;
      return;
  }
}

/** Kinds that may run while a simulation runs on the document (it is locked): everything that does not edit it. */
const WHILE_SIMULATING = new Set<Intent['kind']>(['select', 'deselect', 'sim', 'speed', 'focus', 'query', 'disaster', 'instance']);

export function planIntent(intent: Intent, env: Env, o: PlanOptions): PlanResult {
  const problem = intentProblem(intent);
  if (problem) return { ok: false, error: msg('cmd37.err.invalidIntent', { problem }), notes: [] };
  // A simulation runs on a snapshot of the document: editing commands wait until it is over (queries, the camera,
  // run control and disasters — which the mouse can place during a run too — go on).
  if (env.ctx.simulating && !WHILE_SIMULATING.has(intent.kind)) return { ok: false, error: msg('cmd37.err.simulating'), notes: [] };
  if (env.ctx.simulating && (intent.kind === 'undo' || intent.kind === 'redo')) return { ok: false, error: msg('cmd37.err.simulating'), notes: [] };
  const d = newDraft();
  try {
    dispatch(intent, env, o, d);
  } catch (e) {
    if (!(e instanceof PlanStop)) throw e;
    if ('error' in e.stop) return { ok: false, error: e.stop.error, notes: d.notes };
    return { ok: false, clarify: 'planClarify' in e.stop ? e.stop.planClarify : clarifyIntent(intent, e.stop.clarify) };
  }
  const plan: Plan = {
    intent, canonical: formatCanonical(intent), ops: d.ops, effects: d.effects, counts: d.counts, items: d.items, notes: d.notes, warnings: d.warnings,
    resultIds: d.resultIds, immediate: d.immediate, confirm: d.confirm, highlight: d.highlight, ...(d.table ? { table: d.table } : {}),
  };
  return { ok: true, plan };
}
