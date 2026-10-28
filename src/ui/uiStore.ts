import { create } from 'zustand';

/** Purely UI state (dialogs) — separate from world/editor/simulation state. */
interface UiState {
  resultsOpen: boolean;
  setResultsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  resultsOpen: false,
  setResultsOpen: (resultsOpen) => set({ resultsOpen }),
}));
