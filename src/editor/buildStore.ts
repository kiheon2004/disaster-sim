/**
 * Creative Build Mode settings (Phase 16): tool options, placement assistance and the palette's
 * recent / favorite presets. Editor preferences live in the browser (per user), NOT in the
 * world file — a project looks the same for everyone who opens it.
 *
 * The clipboard (a blueprint) and the line / area tools' in-progress session are transient.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PLACEMENT, type PlacementSettings } from './build/placementPlan';
import type { AreaShape, LineOrient, Vec2 } from './build/distribution';
import type { Blueprint } from './build/blueprint';

export type GridSize = 'auto' | 0.25 | 0.5 | 1 | 2 | 5;
export const GRID_SIZES: GridSize[] = ['auto', 0.25, 0.5, 1, 2, 5];
export const ROTATION_STEPS = [5, 15, 45, 90] as const;
export type AreaShapeKind = 'rect' | 'circle' | 'brush';

export interface BrushSettings {
  radius: number;
  /** Objects per 100 m². */
  density: number;
  /** Minimum distance between placed objects (m). */
  spacing: number;
}

export interface LineSettings {
  spacing: number;
  orient: LineOrient;
  offset: number;
  bothSides: boolean;
}

export interface AreaSettings {
  shape: AreaShapeKind;
  mode: 'grid' | 'random';
  spacing: number;
  density: number;
  jitter: number;
}

export interface SnapSettings {
  /** Grid step for placement and gizmo moves ('auto' = 1 m for large, 0.5 m for small objects). */
  grid: GridSize;
  /** Rotation snap step (deg) for the gizmo and R in placement. */
  rotationStep: number;
  /** Seat new objects on the terrain surface (category rules). Off = at height 0. */
  surface: boolean;
  /** Tint the place ghost when it overlaps another object or sits badly on a slope. */
  collisionWarning: boolean;
}

export const BRUSH_LIMITS = { radius: [1, 40], density: [0.1, 40], spacing: [0, 30] } as const;
export const RECENT_LIMIT = 8;

/** Line tool session: clicked points (ground x / z). */
export interface LineSession {
  points: Vec2[];
}

/** Area tool session: the shape being defined / waiting for Apply. */
export interface AreaSession {
  shape: AreaShape | null;
  /** True while the pointer is still dragging the shape. */
  dragging: boolean;
}

interface BuildState {
  placement: PlacementSettings;
  brush: BrushSettings;
  line: LineSettings;
  area: AreaSettings;
  snapping: SnapSettings;
  recent: string[];
  favorites: string[];

  /** Transient (not persisted). */
  clipboard: Blueprint | null;
  pasteYaw: number;
  lineSession: LineSession;
  areaSession: AreaSession;
  /** Last bulk-placement summary for the tool options panel. */
  lastResult: { placed: number; skipped: number; reasons: Record<string, number> } | null;

  setPlacement: (patch: Partial<PlacementSettings>) => void;
  setBrushSettings: (patch: Partial<BrushSettings>) => void;
  setLine: (patch: Partial<LineSettings>) => void;
  setArea: (patch: Partial<AreaSettings>) => void;
  setSnapping: (patch: Partial<SnapSettings>) => void;
  /** New random seed for bulk placement. */
  rerollSeed: () => void;
  pushRecent: (itemId: string) => void;
  toggleFavorite: (itemId: string) => void;
  setClipboard: (bp: Blueprint | null) => void;
  rotatePaste: (delta: number) => void;
  setLineSession: (s: LineSession) => void;
  setAreaSession: (s: AreaSession) => void;
  clearSessions: () => void;
  setLastResult: (r: BuildState['lastResult']) => void;
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export const useBuildStore = create<BuildState>()(
  persist(
    (set, get) => ({
      placement: { ...DEFAULT_PLACEMENT, seed: 1 },
      brush: { radius: 8, density: 2, spacing: 3 },
      line: { spacing: 6, orient: 'along', offset: 0, bothSides: false },
      area: { shape: 'rect', mode: 'random', spacing: 4, density: 2, jitter: 0.2 },
      snapping: { grid: 'auto', rotationStep: 15, surface: true, collisionWarning: true },
      recent: [],
      favorites: [],
      clipboard: null,
      pasteYaw: 0,
      lineSession: { points: [] },
      areaSession: { shape: null, dragging: false },
      lastResult: null,

      setPlacement: (patch) => set({ placement: { ...get().placement, ...patch } }),
      setBrushSettings: (patch) => {
        const b = { ...get().brush, ...patch };
        set({ brush: { radius: clamp(b.radius, BRUSH_LIMITS.radius), density: clamp(b.density, BRUSH_LIMITS.density), spacing: clamp(b.spacing, BRUSH_LIMITS.spacing) } });
      },
      setLine: (patch) => set({ line: { ...get().line, ...patch } }),
      setArea: (patch) => set({ area: { ...get().area, ...patch } }),
      setSnapping: (patch) => set({ snapping: { ...get().snapping, ...patch } }),
      rerollSeed: () => set({ placement: { ...get().placement, seed: 1 + Math.floor(Math.random() * 999_999) } }),
      pushRecent: (id) => set({ recent: [id, ...get().recent.filter((r) => r !== id)].slice(0, RECENT_LIMIT) }),
      toggleFavorite: (id) => {
        const f = get().favorites;
        set({ favorites: f.includes(id) ? f.filter((x) => x !== id) : [...f, id] });
      },
      setClipboard: (clipboard) => set({ clipboard, pasteYaw: 0 }),
      rotatePaste: (delta) => set({ pasteYaw: (get().pasteYaw + delta) % (Math.PI * 2) }),
      setLineSession: (lineSession) => set({ lineSession }),
      setAreaSession: (areaSession) => set({ areaSession }),
      clearSessions: () => set({ lineSession: { points: [] }, areaSession: { shape: null, dragging: false } }),
      setLastResult: (lastResult) => set({ lastResult }),
    }),
    {
      name: 'ds.build',
      version: 1,
      partialize: (s) => ({ placement: s.placement, brush: s.brush, line: s.line, area: s.area, snapping: s.snapping, recent: s.recent, favorites: s.favorites }),
      // Fill fields added later with defaults (never trust stored shapes blindly).
      merge: (stored, cur) => {
        const s = (stored ?? {}) as Partial<BuildState>;
        return {
          ...cur,
          placement: { ...cur.placement, ...(s.placement ?? {}) },
          brush: { ...cur.brush, ...(s.brush ?? {}) },
          line: { ...cur.line, ...(s.line ?? {}) },
          area: { ...cur.area, ...(s.area ?? {}) },
          snapping: { ...cur.snapping, ...(s.snapping ?? {}) },
          recent: Array.isArray(s.recent) ? s.recent.filter((x) => typeof x === 'string') : cur.recent,
          favorites: Array.isArray(s.favorites) ? s.favorites.filter((x) => typeof x === 'string') : cur.favorites,
        };
      },
    },
  ),
);

/** Grid step for an object of the given footprint ('auto' keeps the pre-Phase-16 rule). */
export function gridStep(grid: GridSize, footprint: number): number {
  return grid === 'auto' ? (footprint >= 3 ? 1 : 0.5) : grid;
}
