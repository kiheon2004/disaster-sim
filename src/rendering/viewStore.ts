import { create } from 'zustand';
import type { Vec3 } from '@/core/types';

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
