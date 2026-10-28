import { create } from 'zustand';
import type { Vec3 } from '@/core/types';
import type { TerrainViewMode } from './terrain/TerrainSurface';

export interface QuakeViz {
  /** Ground-motion surface (displacement + acceleration colors). */
  ground: boolean;
  /** Horizontal ground-acceleration arrows. */
  arrows: boolean;
  /** Tint structures by their current drift demand. */
  stress: boolean;
  epicenter: boolean;
  /** Visual exaggeration of ground / structural displacement (1 = true scale). */
  exaggeration: number;
  /** Optional camera shake — a visual effect only, separate from the simulation. */
  cameraShake: boolean;
}

export const QUAKE_EXAGGERATIONS = [1, 5, 10, 25] as const;

/**
 * Small bridge between the 3D view and DOM overlays (compass, focus requests).
 * Kept separate from world/editor state on purpose.
 */
interface ViewState {
  /** Camera azimuth in degrees, clockwise from North (0 = looking north). */
  azimuthDeg: number;
  focusRequest: { target: Vec3; distance: number; nonce: number } | null;
  /** Simulation overlays */
  showDamage: boolean;
  showWind: boolean;
  /** Which wind visualization layers are drawn when showWind is on. */
  windViz: 'arrows' | 'particles' | 'both';
  /** Height (m) of the arrow sampling plane. */
  arrowHeight: number;
  /** Entity the camera follows in simulation mode. */
  followId: string | null;
  /** Terrain coloring: ground types (shaded), elevation tint + contours, or flat ground-type map. */
  terrainView: TerrainViewMode;
  setTerrainView: (m: TerrainViewMode) => void;
  /** Earthquake visualization (render-only; never affects the simulation). */
  quakeViz: QuakeViz;
  setQuakeViz: (patch: Partial<QuakeViz>) => void;
  /** Developer performance HUD (off by default; `?perf` or Shift+P). */
  showPerfHud: boolean;
  togglePerfHud: () => void;
  setAzimuth: (deg: number) => void;
  toggleDamage: () => void;
  toggleWind: () => void;
  setWindViz: (v: 'arrows' | 'particles' | 'both') => void;
  setArrowHeight: (h: number) => void;
  setFollow: (id: string | null) => void;
  requestFocus: (target: Vec3, distance?: number) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  azimuthDeg: 0,
  focusRequest: null,
  showDamage: true,
  showWind: true,
  windViz: 'both',
  arrowHeight: 3,
  followId: null,
  terrainView: 'surface',
  setTerrainView: (terrainView) => set({ terrainView }),
  quakeViz: { ground: true, arrows: true, stress: true, epicenter: true, exaggeration: 10, cameraShake: false },
  setQuakeViz: (patch) => set((s) => ({ quakeViz: { ...s.quakeViz, ...patch } })),
  showPerfHud: typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf'),
  togglePerfHud: () => set((s) => ({ showPerfHud: !s.showPerfHud })),
  setAzimuth: (azimuthDeg) => set({ azimuthDeg }),
  toggleDamage: () => set((s) => ({ showDamage: !s.showDamage })),
  toggleWind: () => set((s) => ({ showWind: !s.showWind })),
  setWindViz: (windViz) => set({ windViz }),
  setArrowHeight: (arrowHeight) => set({ arrowHeight }),
  setFollow: (followId) => set({ followId }),
  requestFocus: (target, distance = 30) =>
    set({ focusRequest: { target, distance, nonce: Math.random() } }),
}));
