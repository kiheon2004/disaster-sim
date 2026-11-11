import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CoastFeature, LakeFeature, LineLandformFeature, P2, PeakFeature, RiverFeature } from '@/landscape/types';

/**
 * Natural-feature tools (Phase 19, Terrain Editing Mode): the parameters used for NEW features,
 * the points of the feature being drawn, the selected feature and the forest brush settings.
 */
export interface NatureParams {
  mountain: Pick<PeakFeature, 'radius' | 'height' | 'roughness' | 'seed'>;
  hill: Pick<PeakFeature, 'radius' | 'height' | 'roughness' | 'seed'>;
  ridge: Pick<LineLandformFeature, 'width' | 'height' | 'roughness' | 'seed'>;
  valley: Pick<LineLandformFeature, 'width' | 'height' | 'roughness' | 'seed'>;
  canyon: Pick<LineLandformFeature, 'width' | 'height' | 'roughness' | 'seed'>;
  river: Omit<RiverFeature, 'id' | 'kind' | 'points'>;
  lake: Omit<LakeFeature, 'id' | 'kind' | 'points' | 'surface'> & { /** Surface below the lowest shoreline point (m). */ freeboard: number };
  coast: Omit<CoastFeature, 'id' | 'kind' | 'points'>;
}

export type ForestSpecies = 'broadleaf' | 'conifer';

export interface ForestSettings {
  /** Share of conifers 0–1 (the rest broadleaf). */
  coniferShare: number;
  /** Trees per 100 m². */
  density: number;
  /** Minimum trunk distance (m). */
  spacing: number;
  radius: number;
  seed: number;
  /** Max terrain slope (°). */
  slopeLimit: number;
  /** Elevation band (m). */
  minElevation: number;
  maxElevation: number;
  /** Height variation (random size) on / off. */
  variation: boolean;
  // Phase 36 (§18) site conditions — optional: absent = the Phase 19 rules (scripts / presets / templates pass none,
  // so their forests stay exactly as they were).
  /** Surface (ground) types where no tree grows: paved ground, bare rock … */
  excludeGround?: number[];
  /** Soil profiles where no tree grows. */
  excludeSoil?: number[];
  /** Clear distance from water — lakes, rivers, the sea (m). Absent: only in-water spots and 0.5 m of a river channel. */
  waterClearance?: number;
  /** Clear distance of a tree's footprint from road footprints (carriageway + sidewalks, m). Absent: 0.2 m. */
  roadMargin?: number;
}

export const DEFAULT_NATURE: NatureParams = {
  mountain: { radius: 45, height: 25, roughness: 0.35, seed: 7 },
  hill: { radius: 35, height: 6, roughness: 0.15, seed: 3 },
  ridge: { width: 30, height: 10, roughness: 0.3, seed: 5 },
  valley: { width: 40, height: 6, roughness: 0.2, seed: 5 },
  canyon: { width: 24, height: 10, roughness: 0.25, seed: 5 },
  river: {
    width: 6, depth: 1.5, bankSlope: 2, material: 8,
    meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'downhill', crossing: 'culvert',
    water: { fill: 0.6, inflow: 2, downstream: 'open' },
  },
  lake: { depth: 3, shoreWidth: 8, material: 7, filled: true, freeboard: 0.3 },
  coast: { seaSide: 1, beachSlope: 0.06, beachWidth: 14, offshoreSlope: 0.08, maxDepth: 6, material: 2 },
};

export const DEFAULT_FOREST: ForestSettings = {
  coniferShare: 0.4, density: 1.6, spacing: 3.5, radius: 12, seed: 1, slopeLimit: 35, minElevation: -5, maxElevation: 80, variation: true,
  // Asphalt, concrete (paved) and bare rock carry no trees; 1 m from water, 0.5 m from roads.
  excludeGround: [3, 4, 6], excludeSoil: [], waterClearance: 1, roadMargin: 0.5,
};

interface NatureState {
  params: NatureParams;
  forest: ForestSettings;
  /** Points of the line / polygon being drawn. */
  draft: P2[];
  /** Selected feature (edit tool). */
  selected: string | null;
  setParams: <K extends keyof NatureParams>(kind: K, patch: Partial<NatureParams[K]>) => void;
  setForest: (patch: Partial<ForestSettings>) => void;
  addPoint: (p: P2) => void;
  popPoint: () => void;
  clearDraft: () => void;
  select: (id: string | null) => void;
}

/** Browser persistence of the nature tools: the forest brush settings only. */
export const NATURE_PERSIST = {
  name: 'ds.nature',
  version: 1,
  partialize: (s: NatureState) => ({ forest: s.forest }),
  // Fields added later get their defaults (never trust a stored shape blindly).
  merge: (stored: unknown, cur: NatureState): NatureState => ({ ...cur, forest: { ...cur.forest, ...((stored as Partial<NatureState> | undefined)?.forest ?? {}) } }),
};

/**
 * Phase 36: the forest brush settings (seed included) persist in the browser like the build settings (buildStore) —
 * with the stroke-derived seeds (natureActions) the same stroke gives the same trees in a later session. Feature
 * parameters, the draft and the selection stay per session.
 */
export const useNatureStore = create<NatureState>()(
  persist(
    (set, get) => ({
      params: DEFAULT_NATURE,
      forest: DEFAULT_FOREST,
      draft: [],
      selected: null,
      setParams: (kind, patch) => set({ params: { ...get().params, [kind]: { ...get().params[kind], ...patch } } }),
      setForest: (patch) => set({ forest: { ...get().forest, ...patch } }),
      addPoint: (p) => set({ draft: [...get().draft, p] }),
      popPoint: () => set({ draft: get().draft.slice(0, -1) }),
      clearDraft: () => set({ draft: [] }),
      select: (selected) => set({ selected }),
    }),
    NATURE_PERSIST,
  ),
);
