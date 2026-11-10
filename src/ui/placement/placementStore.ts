/**
 * Disaster placement mode (Phase 35.5) — UI state only: what is being placed, how, the selected placed instance, the
 * pointer, the placement undo stack, favourites / recent disasters. Placed disasters themselves are ordinary experiment
 * instances in the world document (doc.scenario.experiment); nothing here changes a simulation result.
 *
 *   inactive ──arm(type)──► preview (pointer over the map) ──click──► placed (continuous: stays armed) ──Esc / Done──► inactive
 */
import { create } from 'zustand';
import type { EventSpec } from '@/events/specs';
import type { PhenomenonInstance } from '@/phenomena/types';

export type RunMode = 'now' | 'plan';

/** One undoable placement edit (before the instance runs). */
export type PlacementOp =
  | { kind: 'add'; inst: PhenomenonInstance }
  | { kind: 'remove'; inst: PhenomenonInstance; index: number }
  | { kind: 'move'; id: string; from: EventSpec; to: EventSpec };

const FAV = 'ds.disasterFavorites';
const RECENT = 'ds.disasterRecent';
const PREFS = 'ds.placement';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

interface PlacementState {
  /** Phenomenon type being placed (null = placement mode inactive). */
  type: string | null;
  /** Spec of the next placement (the type's defaults, edited in the placement bar). */
  template: EventSpec | null;
  runMode: RunMode;
  continuous: boolean;
  /** Placed instance selected on the map / in the list (Delete removes it, drag moves it). */
  selected: string | null;
  /** Map point under the pointer while armed (x, z), or null off the map. */
  hover: [number, number] | null;
  /** Instance being dragged and its current point. */
  drag: { id: string; p: [number, number] } | null;
  undo: PlacementOp[];
  redo: PlacementOp[];
  favorites: string[];
  recent: string[];
  arm: (type: string, template: EventSpec) => void;
  disarm: () => void;
  setTemplate: (spec: EventSpec) => void;
  setRunMode: (m: RunMode) => void;
  setContinuous: (v: boolean) => void;
  select: (id: string | null) => void;
  setHover: (p: [number, number] | null) => void;
  setDrag: (d: { id: string; p: [number, number] } | null) => void;
  record: (op: PlacementOp) => void;
  toggleFavorite: (type: string) => void;
  noteRecent: (type: string) => void;
  clearHistory: () => void;
}

const prefs = load<{ runMode?: RunMode; continuous?: boolean }>(PREFS, {});

export const usePlacementStore = create<PlacementState>((set, get) => ({
  type: null,
  template: null,
  runMode: prefs.runMode ?? 'plan',
  continuous: prefs.continuous ?? true,
  selected: null,
  hover: null,
  drag: null,
  undo: [],
  redo: [],
  favorites: load<string[]>(FAV, []),
  recent: load<string[]>(RECENT, []),
  arm: (type, template) => set({ type, template, hover: null }),
  disarm: () => set({ type: null, template: null, hover: null }),
  setTemplate: (template) => set({ template }),
  setRunMode: (runMode) => {
    set({ runMode });
    save(PREFS, { runMode, continuous: get().continuous });
  },
  setContinuous: (continuous) => {
    set({ continuous });
    save(PREFS, { runMode: get().runMode, continuous });
  },
  select: (selected) => set({ selected }),
  setHover: (hover) => set({ hover }),
  setDrag: (drag) => set({ drag }),
  record: (op) => set((s) => ({ undo: [...s.undo.slice(-99), op], redo: [] })),
  toggleFavorite: (type) => {
    const cur = get().favorites;
    const favorites = cur.includes(type) ? cur.filter((t) => t !== type) : [...cur, type];
    set({ favorites });
    save(FAV, favorites);
  },
  noteRecent: (type) => {
    const recent = [type, ...get().recent.filter((t) => t !== type)].slice(0, 6);
    set({ recent });
    save(RECENT, recent);
  },
  clearHistory: () => set({ undo: [], redo: [] }),
}));
