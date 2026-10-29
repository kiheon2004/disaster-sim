import { create } from 'zustand';
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

export const DEFAULT_FOREST: ForestSettings = { coniferShare: 0.4, density: 1.6, spacing: 3.5, radius: 12, seed: 1, slopeLimit: 35, minElevation: -5, maxElevation: 80, variation: true };

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

export const useNatureStore = create<NatureState>((set, get) => ({
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
}));
