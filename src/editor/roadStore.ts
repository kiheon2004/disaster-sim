import { create } from 'zustand';
import type { P2 } from '@/roads/curve';
import { defaultProfile, PROFILE_PRESETS, type LinkPolicy, type RoadProfile, type ZoneType } from '@/roads/types';
import type { NeighborhoodKind } from '@/roads/city';

/**
 * Road Editing Mode (Phase 18) — the 'road' editor tool. One mode owns the viewport at a time:
 *   draw    click points: straight legs (polyline); double-click / Enter finishes. Starting or
 *           ending on a road end extends it, on a road connects (T-junction), crossing a road
 *           makes a 4-way junction.
 *   curve   click points: the interior points are curve control points (one smooth segment)
 *   edit    click a road to select it (Shift adds), drag node / control-point handles
 *   split   click a road to split it there
 *   delete  click a road to delete it (orphan nodes go with it)
 *   zone    click inside a city block to assign the selected zone type
 */
export type RoadMode = 'draw' | 'curve' | 'edit' | 'split' | 'delete' | 'zone';
export const ROAD_MODES: readonly RoadMode[] = ['draw', 'curve', 'edit', 'split', 'delete', 'zone'];

export interface RoadSelection {
  segments: string[];
  node: string | null;
}

interface RoadState {
  mode: RoadMode;
  /** Profile used for new roads (presets fill it; every field stays editable). */
  profile: RoadProfile;
  preset: string | null;
  /** Points placed so far in draw / curve mode. */
  draft: P2[];
  selection: RoadSelection;
  /** What happens to linked objects when a road is edited (applied to new links). */
  linkPolicy: LinkPolicy;
  zoneType: ZoneType;
  /** Selected city block (zone mode). */
  block: string | null;
  /** Grid snap of drawn points (m; 0 = off). */
  gridSnap: number;
  /** Neighbourhood preset waiting for a click in the viewport (null = none). */
  hood: { kind: NeighborhoodKind; yaw: number; seed: number } | null;

  setMode: (m: RoadMode) => void;
  setProfile: (patch: Partial<RoadProfile>) => void;
  applyPreset: (key: string) => void;
  addPoint: (p: P2) => void;
  popPoint: () => void;
  clearDraft: () => void;
  select: (sel: Partial<RoadSelection>) => void;
  setLinkPolicy: (p: LinkPolicy) => void;
  setZoneType: (z: ZoneType) => void;
  setBlock: (b: string | null) => void;
  setGridSnap: (v: number) => void;
  setHood: (h: RoadState['hood']) => void;
}

export const EMPTY_SELECTION: RoadSelection = { segments: [], node: null };

export const useRoadStore = create<RoadState>((set, get) => ({
  mode: 'draw',
  profile: defaultProfile(),
  preset: 'street',
  draft: [],
  selection: EMPTY_SELECTION,
  linkPolicy: 'follow',
  zoneType: 'residential',
  block: null,
  gridSnap: 0,
  hood: null,

  setMode: (mode) => set({ mode, draft: [], hood: null, ...(mode === 'edit' ? {} : { selection: EMPTY_SELECTION }) }),
  setProfile: (patch) => set({ profile: { ...get().profile, ...patch }, preset: null }),
  applyPreset: (key) => set({ profile: { ...defaultProfile(), ...(PROFILE_PRESETS[key] ?? {}) }, preset: key }),
  addPoint: (p) => set({ draft: [...get().draft, p] }),
  popPoint: () => set({ draft: get().draft.slice(0, -1) }),
  clearDraft: () => set({ draft: [] }),
  select: (sel) => set({ selection: { ...get().selection, ...sel } }),
  setLinkPolicy: (linkPolicy) => set({ linkPolicy }),
  setZoneType: (zoneType) => set({ zoneType }),
  setBlock: (block) => set({ block }),
  setGridSnap: (gridSnap) => set({ gridSnap }),
  setHood: (hood) => set({ hood, draft: [] }),
}));
