/**
 * Phase 37 — the command bar's own view state (what its result area shows, the script being written, the context
 * menu) and the way to its input for the shortcuts. Purely UI: nothing here reaches a plan, the document or a result.
 */
import { create } from 'zustand';

/** What the result area shows: the plan / question / result of the session, the help, or the script editor. */
export type BarPanel = 'results' | 'help' | 'script';

/** The script text is kept in the browser (spec §18: `ds.commands.*`), never in the document. */
const SCRIPT = 'ds.commands.script';

function loadScript(): string {
  try {
    return (typeof localStorage === 'undefined' ? null : localStorage.getItem(SCRIPT)) ?? '';
  } catch {
    return '';
  }
}

export interface ContextMenuState {
  /** Where the menu opens (client px). */
  x: number;
  y: number;
  /** The ground point under the pointer (x, z); null = not known (the entries are disabled). */
  point: [number, number] | null;
}

interface BarState {
  panel: BarPanel;
  setPanel: (panel: BarPanel) => void;
  script: string;
  setScript: (script: string) => void;
  menu: ContextMenuState | null;
  openMenu: (menu: ContextMenuState) => void;
  closeMenu: () => void;
}

export const useBarStore = create<BarState>((set, get) => ({
  panel: 'results',
  setPanel: (panel) => set({ panel }),
  script: loadScript(),
  setScript: (script) => {
    set({ script });
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(SCRIPT, script);
    } catch {
      /* storage full or blocked: the editor keeps working */
    }
  },
  menu: null,
  openMenu: (menu) => set({ menu }),
  closeMenu: () => {
    if (get().menu) set({ menu: null });
  },
}));

// ── The way to the input (the `/` and Ctrl / ⌘ + K shortcuts, the context menu) ──────────────

let input: HTMLInputElement | null = null;

/** The mounted bar registers its input (null on unmount). */
export function registerBarInput(el: HTMLInputElement | null): void {
  input = el;
}

/** Put the keyboard in the command bar (selecting its text, so typing replaces it). False = no bar is mounted. */
export function focusCommandBar(select = true): boolean {
  if (!input) return false;
  input.focus();
  if (select) input.select();
  return true;
}
