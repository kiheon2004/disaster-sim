/**
 * Phase 37 — from text to intents (§4): the one entry the command bar, scripts and the dev hooks call. A line is read
 * as a canonical command, as a Korean / English sentence (the rule parser), or — for the older "make it rain" run-now
 * sentences — by the legacy grammar; anything else is "not understood" with the nearest commands, never a guess.
 */
import type { Msg } from './context';
import type { Intent } from './intent';
import { parseCommand } from './parse';

/** The slots a sentence can be missing (the user is asked for exactly that piece). */
export type AskSlot = 'direction' | 'amount' | 'target' | 'kind' | 'name' | 'field' | 'axis' | 'place';

export type Interpretation =
  | { kind: 'ok'; intents: Intent[]; canonical: string[]; source: 'canonical' | 'rules' | 'legacy' | 'provider'; notes: Msg[] }
  | { kind: 'ask'; slot: AskSlot; question: Msg; understood: string }
  | { kind: 'unknown'; reason: Msg; suggestions: string[] };

export function interpret(text: string): Interpretation {
  return parseCommand(text);
}

/** Most lines one script may have (§15). */
export const MAX_SCRIPT_LINES = 500;

export interface ScriptLine {
  /** Line number in the script text (1-based). */
  n: number;
  text: string;
}

/**
 * A comment line of a script: `#` alone, or `#` followed by a space. `#` directly followed by a character is NOT a
 * comment — it is an object id ("#building_ab12에 화재", "#tree_1 delete"): such a line is a command, and one that is
 * neither ("#todo") is reported as not understood rather than silently skipped.
 */
export function isScriptComment(line: string): boolean {
  const t = line.trim();
  return t === '#' || /^#\s/.test(t);
}

/** The command lines of a script: blank lines and comment lines (`# …`) are left out. */
export function scriptLines(text: string): ScriptLine[] {
  const out: ScriptLine[] = [];
  text.split(/\r?\n/).forEach((line, k) => {
    const t = line.trim();
    if (t && !isScriptComment(t)) out.push({ n: k + 1, text: t });
  });
  return out;
}
