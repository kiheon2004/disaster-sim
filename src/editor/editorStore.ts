import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { GroundTypeId } from '@/core/model';

export type AppMode = 'editor' | 'simulation';
export type EditorTool = 'select' | 'place' | 'terrain';
/** Terrain Editing Mode tools: sculpt, paint ground, or read values at a point. */
export type TerrainToolId = 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint' | 'inspect';

export const BRUSH_RADIUS_RANGE: [number, number] = [1, 40];
export type TransformMode = 'translate' | 'rotate' | 'scale';

interface EditorState {
  mode: AppMode;
  tool: EditorTool;
  /** Palette preset armed for placement. */
  placeItemId: string | null;
  /** Yaw (rad) applied to the placement ghost. */
  ghostYaw: number;
  selectedId: EntityId | null;
  hoveredId: EntityId | null;
  transformMode: TransformMode;
  snap: boolean;
  /** Natural variation (size/color) when placing nature & people presets. */
  randomize: boolean;
  /** True while a gizmo drag is in progress (used to suppress click-selection). */
  dragging: boolean;
  terrainTool: TerrainToolId;
  /** Brush radius (m) and strength (0–1). */
  brushRadius: number;
  brushStrength: number;
  paintType: GroundTypeId;
  /** Point picked with the inspect tool (world x/z). */
  terrainProbe: { x: number; z: number } | null;

  setMode: (m: AppMode) => void;
  armPlacement: (itemId: string | null) => void;
  rotateGhost: (delta: number) => void;
  select: (id: EntityId | null) => void;
  hover: (id: EntityId | null) => void;
  setTransformMode: (m: TransformMode) => void;
  toggleSnap: () => void;
  toggleRandomize: () => void;
  setDragging: (d: boolean) => void;
  /** Enter Terrain Editing Mode with a tool (null = back to select). */
  setTerrainTool: (t: TerrainToolId | null) => void;
  setBrush: (patch: { radius?: number; strength?: number }) => void;
  setPaintType: (t: GroundTypeId) => void;
  setTerrainProbe: (p: { x: number; z: number } | null) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  mode: 'editor',
  tool: 'select',
  placeItemId: null,
  ghostYaw: 0,
  selectedId: null,
  hoveredId: null,
  transformMode: 'translate',
  snap: true,
  randomize: true,
  dragging: false,
  terrainTool: 'raise',
  brushRadius: 8,
  brushStrength: 0.5,
  paintType: 3,
  terrainProbe: null,

  setMode: (mode) => set({ mode, tool: 'select', placeItemId: null, hoveredId: null }),
  armPlacement: (placeItemId) =>
    set(placeItemId && placeItemId !== get().placeItemId
      ? { placeItemId, tool: 'place', selectedId: null }
      : { placeItemId: null, tool: 'select' }),
  rotateGhost: (delta) => set({ ghostYaw: (get().ghostYaw + delta) % (Math.PI * 2) }),
  select: (selectedId) => set({ selectedId }),
  hover: (hoveredId) => (get().hoveredId !== hoveredId ? set({ hoveredId }) : undefined),
  setTransformMode: (transformMode) => set({ transformMode }),
  toggleSnap: () => set({ snap: !get().snap }),
  toggleRandomize: () => set({ randomize: !get().randomize }),
  setDragging: (dragging) => set({ dragging }),
  setTerrainTool: (t) =>
    set(t ? { tool: 'terrain', terrainTool: t, placeItemId: null, selectedId: null, hoveredId: null } : { tool: 'select' }),
  setBrush: ({ radius, strength }) =>
    set({
      brushRadius: radius === undefined ? get().brushRadius : Math.min(BRUSH_RADIUS_RANGE[1], Math.max(BRUSH_RADIUS_RANGE[0], radius)),
      brushStrength: strength === undefined ? get().brushStrength : Math.min(1, Math.max(0.05, strength)),
    }),
  setPaintType: (paintType) => set({ paintType }),
  setTerrainProbe: (terrainProbe) => set({ terrainProbe }),
}));
