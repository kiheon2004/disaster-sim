/**
 * Phase 37 (§6, §14) — what a key does in the command bar, as pure functions of the key and the bar's state (the
 * component only carries the answer out). Kept apart so the rules can be tested without a browser:
 *
 *  - Inside an IME composition (Korean …) Enter / Tab / ↑ / ↓ / Esc belong to the IME: nothing is submitted,
 *    completed, recalled or cancelled. Three signs are checked because browsers differ — `isComposing` of the key
 *    event, key code 229 ("the IME is handling this key": Safari reports it on the Enter that ends a composition,
 *    after `compositionend`), and the bar's own flag between `compositionstart` and `compositionend`.
 *  - Esc closes the completion list before it cancels anything; Enter accepts the list before it submits.
 */

export interface KeyFacts {
  key: string;
  keyCode: number;
  isComposing: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
}

export interface BarFacts {
  /** Between the input's `compositionstart` and `compositionend`. */
  composing: boolean;
  /** The completion list is shown. */
  listOpen: boolean;
  text: string;
  /** An open question with options: how many, and the text it was asked about. */
  clarify: { options: number; text: string } | null;
}

export type BarKey =
  /** Not the bar's: the browser's default. */
  | { do: 'pass' }
  /** The IME's: ignored, and not prevented. */
  | { do: 'ime' }
  | { do: 'submit' }
  | { do: 'cancel' }
  | { do: 'history'; dir: -1 | 1 }
  /** Tab: open the completion list / go to the next (previous) candidate. */
  | { do: 'complete'; dir: -1 | 1 }
  | { do: 'listMove'; dir: -1 | 1 }
  | { do: 'listAccept' }
  | { do: 'listClose' }
  /** Answer the open question with option `k` (0-based). */
  | { do: 'choose'; k: number };

/** The key event belongs to an IME composition. */
export function inComposition(k: Pick<KeyFacts, 'isComposing' | 'keyCode'>, composing: boolean): boolean {
  return composing || k.isComposing || k.keyCode === 229;
}

const PASS = { do: 'pass' } as const;
const IME = { do: 'ime' } as const;

/** A key pressed in the bar's input. */
export function barKey(k: KeyFacts, bar: BarFacts): BarKey {
  const mod = k.ctrl || k.meta || k.alt;
  const ime = inComposition(k, bar.composing);
  switch (k.key) {
    case 'Enter':
      if (ime) return IME;
      return bar.listOpen ? { do: 'listAccept' } : { do: 'submit' };
    case 'Escape':
      if (ime) return IME;
      return bar.listOpen ? { do: 'listClose' } : { do: 'cancel' };
    case 'Tab':
      if (mod) return PASS;
      if (ime) return IME;
      return { do: 'complete', dir: k.shift ? -1 : 1 };
    case 'ArrowUp':
    case 'ArrowDown': {
      if (mod || k.shift) return PASS;
      if (ime) return IME;
      const dir = k.key === 'ArrowUp' ? -1 : 1;
      return bar.listOpen ? { do: 'listMove', dir } : { do: 'history', dir };
    }
  }
  // 1 – 9 answer a question while the text is still the one it was asked about (or empty): typing goes on otherwise.
  if (bar.clarify && !mod && !k.shift && /^[1-9]$/.test(k.key) && !bar.listOpen) {
    if (ime) return IME;
    const n = Number(k.key);
    if (n <= bar.clarify.options && (bar.text === '' || bar.text === bar.clarify.text)) return { do: 'choose', k: n - 1 };
  }
  return PASS;
}

export type ScriptKey = { do: 'pass' } | { do: 'ime' } | { do: 'run' } | { do: 'cancel' };

/** A key pressed in the script editor: Ctrl / ⌘ + Enter runs, Esc cancels — never inside a composition. */
export function scriptKey(k: KeyFacts, composing: boolean): ScriptKey {
  const ime = inComposition(k, composing);
  if (k.key === 'Enter' && (k.ctrl || k.meta) && !k.alt) return ime ? IME : { do: 'run' };
  if (k.key === 'Escape') return ime ? IME : { do: 'cancel' };
  return PASS;
}

// ── History (↑ / ↓) ──────────────────────────────────────────────────────────────────

export interface Walk {
  /** Index into the history while walking it; null = at the text being written. */
  at: number | null;
  /** The unfinished text to come back to. */
  stash: string;
}

export const WALK_START: Walk = { at: null, stash: '' };

/**
 * One step through the remembered commands (oldest first): ↑ goes back from the text being written, ↓ comes forward
 * and ends at that text again. Null = nowhere to go (the key does nothing).
 */
export function walkHistory(history: readonly string[], walk: Walk, dir: -1 | 1, text: string): { walk: Walk; text: string } | null {
  if (!history.length) return null;
  // (the history may have changed under an index: keep it inside)
  const at = walk.at === null ? null : Math.min(walk.at, history.length - 1);
  if (dir < 0) {
    if (at === null) return { walk: { at: history.length - 1, stash: text }, text: history[history.length - 1] };
    if (at === 0) return null;
    return { walk: { at: at - 1, stash: walk.stash }, text: history[at - 1] };
  }
  if (at === null) return null;
  if (at >= history.length - 1) return { walk: WALK_START, text: walk.stash };
  return { walk: { at: at + 1, stash: walk.stash }, text: history[at + 1] };
}

// ── Planning while typing (§19, §22) ─────────────────────────────────────────────────

/** Wait after the last key before the draft plan is made (ms). */
export const DRAFT_DELAY = 150;
/** The same when the last draft was slow. */
export const DRAFT_DELAY_SLOW = 400;
/** A draft slower than this (ms) makes the next ones wait longer … */
export const DRAFT_SLOW_MS = 50;
/** … and slower than this, planning while typing stops (Enter still plans) until the bar is empty again. */
export const DRAFT_PAUSE_MS = 300;

/** How long to wait before drafting, given how long the last draft took; null = live preview paused. */
export function draftDelay(lastDraftMs: number): number | null {
  if (lastDraftMs > DRAFT_PAUSE_MS) return null;
  return lastDraftMs > DRAFT_SLOW_MS ? DRAFT_DELAY_SLOW : DRAFT_DELAY;
}
