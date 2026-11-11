/**
 * Disaster placement mode (Phase 35.5) — UI state only: what is being placed, how, the selected placed instance, the
 * pointer, favourites / recent disasters (Phase 36: placement edits are undone in the WORLD history, one stack for
 * everything — this store no longer keeps its own). Placed disasters themselves are ordinary experiment
 * instances in the world document (doc.scenario.experiment); nothing here changes a simulation result.
 *
 *   inactive ──arm(type)──► preview (pointer over the map) ──click──► placed (continuous: stays armed) ──Esc / Done──► inactive
 */
import { create } from 'zustand';
import type { EventSpec } from '@/events/specs';

export type RunMode = 'now' | 'plan';

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
  toggleFavorite: (type: string) => void;
  noteRecent: (type: string) => void;
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
}));
