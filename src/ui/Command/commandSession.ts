/**
 * Phase 37 — the command bar's state (UI state only; nothing here reaches the document or a simulation result).
 * The actions that change it are in app/commandActions.ts; components and the input policy read / cancel through it.
 *
 *   text ──Enter──► plan (preview open: ghosts, summary) ──Enter──► confirmed (one undo step) │ Esc → plan dropped
 *        └ typing: a draft plan follows the text (not confirmable until Enter makes it the open plan)
 */
import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { Highlight, Msg } from '@/command/context';
import type { Intent } from '@/command/intent';
import type { PlanClarifyOption } from '@/command/planTypes';
import type { LineOutcome, Preview } from '@/command/run';

export interface OpenPlan {
  /** The text (bar) or script the plan was made from. */
  text: string;
  intents: Intent[];
  /** Canonical text of each intent ("understood as …"). */
  canonical: string[];
  /** The run on a fork of the document, and what it would change. `preview.result.ok` is true here. */
  preview: Preview;
  /** Made by Enter (the open plan, confirmable) — false: a draft that follows the text while typing. */
  armed: boolean;
  /** A large edit needs one more Enter: the message to show, and whether that Enter was given. */
  confirm: Msg | null;
  confirmed: boolean;
  /** Said once when the document changed under the open plan and it was planned again with another result. */
  notice: Msg | null;
  /** One undo step per script line instead of one for the whole script. */
  perLine: boolean;
}

export type Feedback =
  | { k: 'none' }
  /** The sentence was not understood: nearest canonical commands. */
  | { k: 'unknown'; reason: Msg; suggestions: string[] }
  /** One piece is missing from the sentence. */
  | { k: 'ask'; question: Msg; understood: string }
  /** Several candidates: choose one (each option is the complete command). */
  | { k: 'clarify'; question: Msg; options: PlanClarifyOption[]; intents: Intent[]; index: number; text: string; perLine: boolean }
  | { k: 'error'; error: Msg; notes: Msg[]; line: number }
  /** What the last command did (tables of queries, counts, notes). */
  | { k: 'done'; lines: LineOutcome[]; changed: boolean };

export interface CommandSettings {
  /** Small edits are applied on the first Enter (never deletes, terrain, roads or more than 20 objects). */
  applySmall: boolean;
  /** A script records one undo step per line instead of one for all of it. */
  scriptPerLine: boolean;
}

const HISTORY = 'ds.commands.history';
const SETTINGS = 'ds.commands.settings';
/** Remembered commands (↑ / ↓). */
export const HISTORY_SIZE = 50;

function load<T>(key: string, fallback: T): T {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: the session keeps working */
  }
}

interface CommandSessionState {
  text: string;
  plan: OpenPlan | null;
  feedback: Feedback;
  /** Result sets of confirmed commands, newest last ("the ones just made"). */
  results: EntityId[][];
  /** The last ground point under the mouse over the viewport (x, z); null = never over it. */
  cursor: [number, number] | null;
  history: string[];
  settings: CommandSettings;
  /** How long the last draft plan took (ms) — the bar stops planning while typing when this is over its budget. */
  draftMs: number;
  /** The canonical commands the current text is understood as (null: not understood yet / empty). */
  understood: string[] | null;
  setUnderstood: (understood: string[] | null) => void;
  setText: (text: string) => void;
  setPlan: (plan: OpenPlan | null) => void;
  setFeedback: (feedback: Feedback) => void;
  setResults: (results: EntityId[][]) => void;
  setCursor: (cursor: [number, number] | null) => void;
  setDraftMs: (ms: number) => void;
  remember: (text: string) => void;
  setSettings: (patch: Partial<CommandSettings>) => void;
  /** Drop the open plan (mode switch, document replaced, a tool or a disaster placement armed, Esc). */
  cancelPlan: () => void;
  /** What the clarify option under the pointer / keyboard focus points at (the viewport emphasises it); null = none. */
  hover: Highlight | null;
  setHover: (hover: Highlight | null) => void;
}

export const useCommandSession = create<CommandSessionState>((set, get) => ({
  text: '',
  plan: null,
  feedback: { k: 'none' },
  results: [],
  cursor: null,
  history: load<string[]>(HISTORY, []).filter((x) => typeof x === 'string').slice(-HISTORY_SIZE),
  settings: { applySmall: false, scriptPerLine: false, ...load<Partial<CommandSettings>>(SETTINGS, {}) },
  draftMs: 0,
  understood: null,
  setUnderstood: (understood) => set({ understood }),
  setText: (text) => {
    // Editing the text of an open plan makes it a draft again: Enter then makes a new plan, it does not confirm.
    const plan = get().plan;
    set({ text, ...(plan && plan.text !== text ? { plan: null } : {}) });
  },
  setPlan: (plan) => set({ plan }),
  setFeedback: (feedback) => set({ feedback }),
  setResults: (results) => set({ results }),
  setCursor: (cursor) => set({ cursor }),
  setDraftMs: (draftMs) => set({ draftMs }),
  remember: (text) => {
    const t = text.trim();
    if (!t) return;
    const history = [...get().history.filter((x) => x !== t), t].slice(-HISTORY_SIZE);
    set({ history });
    save(HISTORY, history);
  },
  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    save(SETTINGS, settings);
  },
  cancelPlan: () => {
    if (get().plan) set({ plan: null });
  },
  hover: null,
  setHover: (hover) => set({ hover }),
}));
