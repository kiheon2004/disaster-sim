/**
 * Phase 37 (§9, §14) — what the command bar's one summary line says, as pure functions of the session: the state
 * (a symbol and a word — never a colour alone), what an open plan would change, and what Enter / Esc do right now.
 */
import { msg, type Msg } from '@/command/context';
import type { DocDiff } from '@/command/diff';
import type { Plan } from '@/command/planTypes';
import type { Feedback, OpenPlan } from './commandSession';

export const BAR_STATES = ['idle', 'draft', 'plan', 'confirm', 'question', 'error', 'done'] as const;
export type BarState = (typeof BAR_STATES)[number];

/** The mark shown before the state's word. */
export const STATE_SYMBOL: Record<BarState, string> = { idle: '○', draft: '◇', plan: '◆', confirm: '◈', question: '?', error: '✕', done: '✓' };

export interface BarFacts {
  text: string;
  plan: OpenPlan | null;
  feedback: Feedback;
  /** The text is no longer the one the feedback was given for (and not empty): the question / message is about another text. */
  stale: boolean;
}

/**
 * The bar's state. An open (armed) plan comes first; then a question or a message about the text as it stands; then
 * the text being written; then the result of the last command.
 */
export function barState({ text, plan, feedback, stale }: BarFacts): BarState {
  if (plan?.armed) return plan.confirm && plan.confirmed ? 'confirm' : 'plan';
  if (!stale && (feedback.k === 'clarify' || feedback.k === 'ask')) return 'question';
  if (!stale && (feedback.k === 'error' || feedback.k === 'unknown')) return 'error';
  if (text.trim()) return 'draft';
  return feedback.k === 'done' ? 'done' : 'idle';
}

/** The plans of an open plan's lines (one per canonical command). */
export function planLines(plan: OpenPlan | null): Plan[] {
  return plan && plan.preview.result.ok ? plan.preview.result.lines.map((l) => l.plan) : [];
}

export interface DiffCounts {
  created: number;
  /** Moved or changed in another way. */
  changed: number;
  removed: number;
  /** Changed ground (m²); 0 = none. */
  terrainArea: number;
  roadsAdded: number;
  roadsRemoved: number;
  disastersAdded: number;
  disastersChanged: number;
  disastersRemoved: number;
}

/** What a plan would really change: counted from the difference the preview found, not from what the plan intends. */
export function diffCounts(diff: DocDiff | null): DiffCounts {
  return {
    created: diff?.added.length ?? 0,
    changed: (diff?.moved.length ?? 0) + (diff?.changed.length ?? 0),
    removed: diff?.removed.length ?? 0,
    terrainArea: diff?.terrain?.area ?? 0,
    roadsAdded: diff?.roads?.added.length ?? 0,
    roadsRemoved: diff?.roads?.removed.length ?? 0,
    disastersAdded: diff?.instances.added.length ?? 0,
    disastersChanged: diff?.instances.changed.length ?? 0,
    disastersRemoved: diff?.instances.removed.length ?? 0,
  };
}

/** Warnings of a plan: the planners' own, plus one for each item that was placed with a warning or rejected. */
export function warningCount(plans: readonly Plan[]): number {
  let n = 0;
  for (const p of plans) n += p.warnings.length + p.items.filter((i) => i.status !== 'ok').length;
  return n;
}

export interface HintFacts extends BarFacts {
  understood: readonly string[] | null;
  /** The first Enter applies the draft at once (nothing to preview, or a small edit the user allowed). */
  appliesAtOnce: boolean;
  /** Planning while typing is paused (the last draft was too slow). */
  paused: boolean;
}

/** Verbs that act at once, without a preview (§9): queries, selection, the camera, run control, undo / redo. */
const AT_ONCE = new Set(['select', 'add', 'remove', 'focus', 'run', 'pause', 'reset', 'undo', 'redo', 'count', 'list', 'measure', 'info']);

/**
 * Whether commands (canonical lines) act at once, judged by their verbs alone — for the hint when no draft plan says
 * it exactly (after Esc, or while the live preview is paused). A disaster ending in `now` starts at once too.
 */
export function actAtOnce(canonical: readonly string[]): boolean {
  return canonical.length > 0 && canonical.every((line) => {
    const verb = line.split(' ', 1)[0];
    return AT_ONCE.has(verb) || verb.startsWith('speed=') || (verb === 'disaster' && / (now|stop|pause|resume)$/.test(line));
  });
}

/** What Enter and Esc do now — the words at the end of the summary line. */
export function hints(f: HintFacts): Msg[] {
  const esc = msg('cmd37.ui.hint.esc');
  switch (barState(f)) {
    case 'plan':
      return [msg(f.plan?.confirm ? 'cmd37.ui.hint.confirmTwice' : 'cmd37.ui.hint.confirm'), esc];
    case 'confirm':
      return [msg('cmd37.ui.hint.confirmOnce'), esc];
    case 'question':
      return f.feedback.k === 'clarify' ? [msg('cmd37.ui.hint.choose', { count: Math.min(9, f.feedback.options.length) }), esc] : [msg('cmd37.ui.hint.answer'), esc];
    case 'error':
      return [msg('cmd37.ui.hint.dismiss')];
    case 'draft':
      if (f.paused) return [msg(f.understood ? 'cmd37.ui.hint.paused' : 'cmd37.ui.hint.pausedUnknown')];
      if (f.plan) return [msg(f.appliesAtOnce ? 'cmd37.ui.hint.applyNow' : 'cmd37.ui.hint.plan')];
      if (!f.understood) return [msg('cmd37.ui.hint.notUnderstood')];
      return [msg(actAtOnce(f.understood) ? 'cmd37.ui.hint.run' : 'cmd37.ui.hint.plan')];
    case 'done':
    case 'idle':
      return [msg('cmd37.ui.hint.idle')];
  }
}

/** Whether a finished command has more to show than its one line (a table, notes, warnings, several lines). */
export function richResult(feedback: Feedback): boolean {
  if (feedback.k !== 'done') return false;
  return feedback.lines.length > 1 || feedback.lines.some((l) => (l.plan.table?.rows.length ?? 0) > 0 || l.plan.notes.length > 0 || l.plan.warnings.length > 0 || l.plan.items.some((i) => i.status !== 'ok'));
}
