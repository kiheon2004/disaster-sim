import { create } from 'zustand';

/** Right context panel tabs (Phase 35.5). */
export type RightTab = 'selection' | 'phenomena' | 'analysis' | 'settings';
const RIGHT_TABS: readonly RightTab[] = ['selection', 'phenomena', 'analysis', 'settings'];

function stored<T extends string>(key: string, ok: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (ok as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function put(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/** The legacy hazard tab preference ('ds.hazardTab', set by older sessions and the verification scripts) opens the disasters tab. */
function initialRightTab(): RightTab {
  const t = stored<RightTab | ''>('ds.rightTab', [...RIGHT_TABS, ''], '');
  if (t) return t;
  try {
    return localStorage.getItem('ds.hazardTab') ? 'phenomena' : 'selection';
  } catch {
    return 'selection';
  }
}

/** Purely UI state (dialogs, panels) — separate from world/editor/simulation state; never changes a result. */
interface UiState {
  resultsOpen: boolean;
  setResultsOpen: (open: boolean) => void;
  /** Experiment comparison dialog (Phase 15). */
  compareOpen: boolean;
  setCompareOpen: (open: boolean) => void;
  /** Phase 35.5: right context panel — open, active tab; the command console drawer under the timeline. */
  rightOpen: boolean;
  setRightOpen: (open: boolean) => void;
  rightTab: RightTab;
  setRightTab: (tab: RightTab) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  /** Viewport overlays: the live information panels (top right) and the display options (bottom right). */
  hudOpen: boolean;
  setHudOpen: (open: boolean) => void;
  overlayOpen: boolean;
  setOverlayOpen: (open: boolean) => void;
}

/** Display options start folded for a new user; an existing preference (or the legacy hazard tab key) keeps them open. */
function initialOverlayOpen(): boolean {
  try {
    const v = localStorage.getItem('ds.overlayOpen');
    if (v === '1' || v === '0') return v === '1';
    return localStorage.getItem('ds.hazardTab') !== null;
  } catch {
    return true;
  }
}

export const useUiStore = create<UiState>((set) => ({
  resultsOpen: false,
  setResultsOpen: (resultsOpen) => set({ resultsOpen }),
  compareOpen: false,
  setCompareOpen: (compareOpen) => set({ compareOpen }),
  rightOpen: stored<'1' | '0'>('ds.rightOpen', ['1', '0'], '1') === '1',
  setRightOpen: (rightOpen) => {
    set({ rightOpen });
    put('ds.rightOpen', rightOpen ? '1' : '0');
  },
  rightTab: initialRightTab(),
  setRightTab: (rightTab) => {
    set({ rightTab, rightOpen: true });
    put('ds.rightTab', rightTab);
    put('ds.rightOpen', '1');
  },
  commandOpen: stored<'1' | '0'>('ds.commandOpen', ['1', '0'], '0') === '1',
  setCommandOpen: (commandOpen) => {
    set({ commandOpen });
    put('ds.commandOpen', commandOpen ? '1' : '0');
  },
  hudOpen: stored<'1' | '0'>('ds.hudOpen', ['1', '0'], '1') === '1',
  setHudOpen: (hudOpen) => {
    set({ hudOpen });
    put('ds.hudOpen', hudOpen ? '1' : '0');
  },
  overlayOpen: initialOverlayOpen(),
  setOverlayOpen: (overlayOpen) => {
    set({ overlayOpen });
    put('ds.overlayOpen', overlayOpen ? '1' : '0');
  },
}));
