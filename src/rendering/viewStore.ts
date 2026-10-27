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
  setAzimuth: (deg: number) => void;
  requestFocus: (target: Vec3, distance?: number) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  azimuthDeg: 0,
  focusRequest: null,
  setAzimuth: (azimuthDeg) => set({ azimuthDeg }),
  requestFocus: (target, distance = 30) =>
    set({ focusRequest: { target, distance, nonce: Math.random() } }),
}));
