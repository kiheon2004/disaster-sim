/**
 * Phase 37 — command bar actions: text → interpretation → plan (preview on a fork) → confirm (ONE undo step) → effects.
 * The only place that writes the world store for commands is `runIntents` (command/run.ts), called from `commit`
 * here; everything before it is pure. Components call these functions; they never wire stores together themselves.
 */
import type { EntityId } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { getDefinition } from '@/objects/registry';
import { resolveSchedule } from '@/phenomena/schedule';
import { simulationController } from '@/simulation/SimulationController';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useViewStore } from '@/rendering/viewStore';
import { emptyContext, msg, pruneResults, type CommandContext, type Msg, type RuntimeView } from '@/command/context';
import { interpret, MAX_SCRIPT_LINES, scriptLines } from '@/command/interpret';
import type { Intent } from '@/command/intent';
import { SMALL_EDIT_ITEMS, type Effect, type Plan } from '@/command/planTypes';
import { previewIntents, runIntents, type Preview, type RunFailure, type RunResult } from '@/command/run';
import { useCommandSession, type OpenPlan } from '@/ui/Command/commandSession';
import { enterSimulation, phenomenonContext, resetSimulation, runExperiment, runSimulation } from './actions';

const S = () => useCommandSession.getState();
const W = () => useWorldStore.getState();
const E = () => useEditorStore.getState();

/** Where the middle of the view meets the ground — registered by the camera rig (null outside a browser). */
let viewPoint: (() => [number, number] | null) | null = null;
export function registerViewPoint(get: (() => [number, number] | null) | null): void {
  viewPoint = get;
}

function runtimeView(): RuntimeView | null {
  if (E().mode !== 'simulation' || !simulationController.isLoaded()) return null;
  const m = simulationController.getMetrics();
  // The numbers the results panel shows (simulation/analysis/MetricsRecorder.ts) — nothing is estimated here.
  const summary: Record<string, number> = m
    ? { objectsDamaged: m.objectsDamaged, objectsDestroyed: m.objectsDestroyed, buildingsDamaged: m.buildingsDamaged, treesFallen: m.treesFallen, vehiclesMoved: m.vehiclesMoved, humansFallen: m.humansFallen, totalDamageEvents: m.totalDamageEvents }
    : {};
  return {
    time: simulationController.getTime(),
    instances: simulationController.instances().map((i) => ({ key: i.key, type: i.spec.event, status: i.status, stop: i.stop, pause: i.pause })),
    summary,
  };
}

/** The Context a plan is made with: selection, cursor, view, result sets, whether a simulation runs. */
export function commandContext(): CommandContext {
  const ed = E();
  return {
    ...emptyContext(),
    selection: ed.selectedIds,
    primary: ed.selectedId,
    cursor: S().cursor,
    view: viewPoint?.() ?? null,
    results: S().results,
    simulating: ed.mode === 'simulation' || W().locked,
    runtime: runtimeView(),
  };
}

// ── Effects outside the document ─────────────────────────────────────────────────────

/** Camera to some objects without touching the selection (a query must not change what is selected). */
function focusIds(ids: readonly EntityId[]): void {
  const objs = ids.map((id) => W().doc.objects[id]).filter((o) => !!o);
  if (!objs.length) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity;
  for (const o of objs) {
    const d = getDefinition(o.type).getDimensions(o.params);
    const r = Math.max(d[0] * o.transform.scale[0], d[2] * o.transform.scale[2]) / 2;
    const [x, y, z] = o.transform.position;
    x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
    top = Math.max(top, y + d[1] * o.transform.scale[1]);
  }
  useViewStore.getState().setFollow(null);
  useViewStore.getState().requestFocus([(x0 + x1) / 2, top * 0.4, (z0 + z1) / 2], Math.max(12, Math.hypot(x1 - x0, z1 - z0) * 1.2, (top - Math.min(...objs.map((o) => o.transform.position[1]))) * 2.2));
}

/**
 * Start placed instances now: each at its own start time — after the simulation starts when it is entered for them,
 * from now when one is already running (the resolved spec goes to `runSimulation` directly, so a delay is kept in
 * both cases). Instances already in the run are not added again.
 */
async function runPlaced(ids: readonly string[]): Promise<void> {
  const all = W().doc.scenario.experiment?.instances ?? [];
  const inSim = E().mode === 'simulation' && simulationController.isLoaded();
  const running = new Set(inSim ? simulationController.instances().map((i) => i.key) : []);
  const mine = all.filter((i) => ids.includes(i.id) && i.enabled && !running.has(i.id)).map((i) => ('at' in i.start ? i : { ...i, start: { at: 0 } }));
  const sched = resolveSchedule(mine, phenomenonContext(), inSim ? simulationController.getTime() : 0);
  if (sched.items.length) await runSimulation(sched.items.map((r) => r.spec as EventSpec), sched.items.map((r) => r.instance.id));
}

async function carryOut(effects: readonly Effect[], finalSelection: { ids: readonly EntityId[]; primary: EntityId | null } | null): Promise<void> {
  if (finalSelection) E().setSelection([...finalSelection.ids], finalSelection.primary);
  for (const fx of effects) {
    switch (fx.fx) {
      case 'select': case 'selectAdded': break; // the run's final selection was applied above, once
      case 'focus': focusIds(fx.ids); break;
      case 'focusAt':
        useViewStore.getState().setFollow(null);
        useViewStore.getState().requestFocus([fx.x, samplerFor(W().doc.terrain).sampleHeight(fx.x, fx.z), fx.z], 30);
        break;
      case 'sim':
        if (fx.op === 'run') {
          // From the editor "run" starts the placed disasters too (what "Run experiment" does — a run started by the
          // play button alone has none of them, and "stop the rain" would find nothing); with none placed, or during
          // a run, it is the play button.
          const placed = (W().doc.scenario.experiment?.instances ?? []).some((x) => x.enabled);
          if (E().mode === 'editor' && placed) await runExperiment();
          if (E().mode === 'editor') await enterSimulation();
          if (simulationController.isLoaded()) simulationController.play();
        } else if (fx.op === 'pause') simulationController.pause();
        else if (simulationController.isLoaded()) await resetSimulation();
        break;
      case 'speed': simulationController.setSpeed(fx.value as Parameters<typeof simulationController.setSpeed>[0]); break;
      case 'control': simulationController.controlEvent(fx.key, fx.op); break;
      case 'runInstances': await runPlaced(fx.ids); break;
      case 'undo': W().undo(); break;
      case 'redo': W().redo(); break;
    }
  }
}

// ── Plans ────────────────────────────────────────────────────────────────────────────

function failureFeedback(f: RunFailure, intents: Intent[], text: string, perLine: boolean): void {
  if ('clarify' in f) S().setFeedback({ k: 'clarify', question: f.clarify.question, options: f.clarify.options, intents, index: f.index, text, perLine });
  else S().setFeedback({ k: 'error', error: f.error, notes: f.notes, line: f.index });
}

const plansOf = (r: RunResult): Plan[] => r.lines.map((l) => l.plan);

/** Whether the first Enter may apply the plan at once: nothing to preview, or a small edit the user allowed. */
function immediate(preview: Preview): boolean {
  if (!preview.result.ok) return false;
  const plans = plansOf(preview.result);
  if (plans.every((p) => p.immediate || (p.ops.length === 0 && p.effects.length === 0))) return true;
  if (!S().settings.applySmall || plans.length !== 1) return false;
  const p = plans[0];
  const kind = p.intent.kind;
  const n = p.counts.create + p.counts.change;
  return !p.confirm && p.counts.remove === 0 && n <= SMALL_EDIT_ITEMS && kind !== 'terrain' && kind !== 'paint' && kind !== 'road' && kind !== 'delete';
}

function makePlan(text: string, intents: Intent[], canonical: string[], armed: boolean, perLine: boolean): OpenPlan | null {
  const preview = previewIntents(W().doc, intents, commandContext());
  if (!preview.result.ok) {
    if (armed) failureFeedback(preview.result.failure, intents, text, perLine);
    return null;
  }
  const confirm = plansOf(preview.result).map((p) => p.confirm).find((c) => c !== null) ?? null;
  return { text, intents, canonical, preview, armed, confirm, confirmed: false, notice: null, perLine };
}

/**
 * Apply intents to the document: ONE undo step (or one per line), then the effects. The selection is put back when
 * the run fails (the store's subscribers may have pruned it while the run was being rolled back).
 */
async function commit(text: string, intents: Intent[], perLine: boolean): Promise<boolean> {
  const sel = { ids: E().selectedIds, primary: E().selectedId };
  const runs: RunResult[] = [];
  let ctx = commandContext();
  const groups = perLine ? intents.map((i) => [i]) : [intents];
  let offset = 0;
  for (const group of groups) {
    const r = runIntents(useWorldStore, group, ctx);
    if (!r.ok) {
      if (E().selectedIds !== sel.ids && !runs.length) E().setSelection(sel.ids, sel.primary);
      S().setPlan(null);
      const f = r.failure;
      failureFeedback({ ...f, index: f.index + offset }, intents, text, perLine);
      return false;
    }
    runs.push(r);
    ctx = { ...r.ctx, runtime: ctx.runtime, simulating: ctx.simulating };
    offset += group.length;
  }
  const lines = runs.flatMap((r) => (r.ok ? r.lines : []));
  const effects = runs.flatMap((r) => (r.ok ? r.effects : []));
  S().setPlan(null);
  S().setResults(ctx.results.map((set) => [...set]));
  const changedSelection = effects.some((fx) => fx.fx === 'select' || fx.fx === 'selectAdded');
  await carryOut(effects, changedSelection ? { ids: ctx.selection, primary: ctx.primary } : null);
  S().setFeedback({ k: 'done', lines, changed: runs.some((r) => r.ok && r.changed) });
  S().remember(text);
  return true;
}

/** Interpret a text (one line, or a script of several) into intents; feedback is set when it cannot be. */
function read(text: string, quiet: boolean): { intents: Intent[]; canonical: string[]; script: boolean } | null {
  const lines = scriptLines(text);
  if (!lines.length) {
    // Only comments ("# …"): said, so that Enter is never silently nothing.
    if (!quiet && text.trim()) S().setFeedback({ k: 'error', error: msg('cmd37.err.onlyComments'), notes: [], line: 0 });
    return null;
  }
  if (lines.length > MAX_SCRIPT_LINES) {
    if (!quiet) S().setFeedback({ k: 'error', error: msg('cmd37.err.scriptTooLong', { count: lines.length, max: MAX_SCRIPT_LINES }), notes: [], line: 0 });
    return null;
  }
  const intents: Intent[] = [], canonical: string[] = [];
  for (const line of lines) {
    const r = interpret(line.text);
    if (r.kind !== 'ok') {
      if (!quiet) {
        if (r.kind === 'ask') S().setFeedback({ k: 'ask', question: r.question, understood: r.understood });
        else S().setFeedback({ k: 'unknown', reason: lines.length > 1 ? msg('cmd37.err.scriptLine', { line: line.n, text: line.text }) : r.reason, suggestions: r.suggestions });
      }
      return null;
    }
    intents.push(...r.intents);
    canonical.push(...r.canonical);
  }
  return { intents, canonical, script: lines.length > 1 };
}

/**
 * While typing: the draft plan of the current text (ghosts, summary) — never confirmable by itself, never an error
 * message for a half-typed sentence. Returns the time it took (ms).
 */
export function draftCommand(): number {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const text = S().text;
  const open = S().plan;
  if (open?.armed) return 0;
  const r = text.trim() ? read(text, true) : null;
  // "Understood as …" follows the text; a draft plan only for what would open a preview (commands that act at once
  // — queries, the camera, run control — are not run by typing them).
  S().setUnderstood(r ? r.canonical : null);
  const plan = r ? makePlan(text, r.intents, r.canonical, false, false) : null;
  S().setPlan(plan && plan.preview.diff?.any ? plan : null);
  const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  S().setDraftMs(ms);
  return ms;
}

/**
 * Enter. Nothing open: make the plan — and apply it at once when there is nothing to preview (queries, the camera,
 * selection, run control, run-now disasters; small edits when the user allows). An open plan of this text: confirm it
 * (a large one asks for one more Enter first). Returns what happened.
 */
export async function submitCommand(perLine = false): Promise<'planned' | 'applied' | 'confirm' | 'replanned' | 'feedback' | 'empty'> {
  const text = S().text;
  if (!text.trim()) return 'empty';
  const open = S().plan;
  if (open?.armed && open.text === text) return confirmPlan();
  S().setFeedback({ k: 'none' });
  const r = read(text, false);
  if (!r) return 'feedback';
  const plan = makePlan(text, r.intents, r.canonical, true, perLine || (r.script && S().settings.scriptPerLine));
  if (!plan) return 'feedback';
  if (immediate(plan.preview)) {
    const ok = await commit(text, plan.intents, plan.perLine);
    if (ok) S().setText('');
    return ok ? 'applied' : 'feedback';
  }
  S().setPlan(plan);
  return 'planned';
}

/** Confirm the open plan. The document changed since it was planned → planned again first; another result → shown, not applied. */
export async function confirmPlan(): Promise<'applied' | 'confirm' | 'replanned' | 'feedback' | 'empty'> {
  let plan = S().plan;
  if (!plan?.armed) return 'empty';
  if (W().doc !== plan.preview.doc) {
    const again = makePlan(plan.text, plan.intents, plan.canonical, true, plan.perLine);
    if (!again) {
      S().setPlan(null);
      return 'feedback';
    }
    const before = plan.preview.result.ok ? plan.preview.result.hash : '';
    const after = again.preview.result.ok ? again.preview.result.hash : '';
    if (before !== after) {
      S().setPlan({ ...again, notice: msg('cmd37.notice.replanned') });
      return 'replanned';
    }
    plan = { ...again, confirmed: plan.confirmed };
  }
  if (plan.confirm && !plan.confirmed) {
    S().setPlan({ ...plan, confirmed: true });
    return 'confirm';
  }
  const ok = await commit(plan.text, plan.intents, plan.perLine);
  if (ok) S().setText('');
  return ok ? 'applied' : 'feedback';
}

/** Esc: the open plan first, then any question / message; returns false when there was nothing to cancel (the bar closes). */
export function cancelCommand(): boolean {
  const s = S();
  if (s.plan) {
    s.setPlan(null);
    return true;
  }
  if (s.feedback.k === 'clarify' || s.feedback.k === 'ask' || s.feedback.k === 'unknown' || s.feedback.k === 'error') {
    s.setFeedback({ k: 'none' });
    return true;
  }
  return false;
}

/** Choose an option of a question: the command with that reference becomes the text and is planned. */
export async function chooseOption(k: number): Promise<void> {
  const f = S().feedback;
  if (f.k !== 'clarify' || !f.options[k]) return;
  const intents = f.intents.map((i, n) => (n === f.index ? f.options[k].intent : i));
  const lines = scriptLines(f.text);
  // One intent per line (the usual case): the chosen command replaces that line; else the canonical text of all.
  const text = lines.length === intents.length
    ? lines.map((l, n) => (n === f.index ? f.options[k].canonical : l.text)).join('\n')
    : f.options[k].canonical;
  S().setFeedback({ k: 'none' });
  S().setText(text);
  await submitCommand(f.perLine);
}

/** Run a script (several lines): planned as a whole, previewed, confirmed like one command. */
export async function runScript(text: string, perLine = S().settings.scriptPerLine): Promise<'planned' | 'applied' | 'confirm' | 'replanned' | 'feedback' | 'empty'> {
  S().setText(text);
  return submitCommand(perLine);
}

/** The history as a script: one confirmed command per line, oldest first. */
export const historyScript = (): string => S().history.join('\n');

// ── For the bar's own controls (Phase 37 ui) ─────────────────────────────────────────

/**
 * Put a command in the bar without running it (the context menu's "place here …", a suggestion, a help example): it
 * becomes the text and is drafted like typed text — Enter then plans it, on the same path as every command.
 */
export function proposeCommand(text: string): void {
  S().setText(text);
  draftCommand();
}

/**
 * While typing with the live preview paused (the last draft plan was too slow — §19, §22): only the parser side runs,
 * so "understood as …" still follows the text; no plan is made until Enter. Nothing but `understood` is written.
 */
export function understandCommand(): void {
  if (S().plan?.armed) return;
  const text = S().text;
  const r = text.trim() ? read(text, true) : null;
  S().setUnderstood(r ? r.canonical : null);
}

/** Whether Enter would apply the draft of the current text at once (nothing to preview, or a small edit the user allowed). */
export function enterAppliesAtOnce(): boolean {
  const p = S().plan;
  return !!p && !p.armed && p.text === S().text && immediate(p.preview);
}

/**
 * Esc pressed outside the bar (the viewport has the keyboard): an open plan made by Enter, or an open question, is
 * cancelled before the editor's own Esc chain (placement, deselect …). False = Esc is free for that chain.
 */
export function escapeCommand(): boolean {
  const s = S();
  if (!s.plan?.armed && s.feedback.k !== 'clarify' && s.feedback.k !== 'ask') return false;
  return cancelCommand();
}

/** Keep "the ones just made" true: ids that no longer exist drop out; a new document starts with none. */
let installed = false;
export function installCommandSession(): void {
  if (installed) return;
  installed = true;
  useWorldStore.subscribe((s, p) => {
    if (s.docVersion !== p.docVersion) {
      S().setResults([]);
      S().cancelPlan();
      return;
    }
    if (s.doc.objects !== p.doc.objects && S().results.length) {
      const ctx = pruneResults({ ...emptyContext(), results: S().results }, s.doc.objects);
      if (ctx.results.length !== S().results.length || ctx.results.some((set, k) => set.length !== S().results[k].length)) S().setResults(ctx.results.map((set) => [...set]));
    }
  });
}

export type { Msg };
