import { create } from 'zustand';
import type { EntityId } from '@/core/types';

export type AppMode = 'editor' | 'simulation';
export type EditorTool = 'select' | 'place';
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

  setMode: (m: AppMode) => void;
  armPlacement: (itemId: string | null) => void;
  rotateGhost: (delta: number) => void;
  select: (id: EntityId | null) => void;
  hover: (id: EntityId | null) => void;
  setTransformMode: (m: TransformMode) => void;
  toggleSnap: () => void;
  toggleRandomize: () => void;
  setDragging: (d: boolean) => void;
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
}));
