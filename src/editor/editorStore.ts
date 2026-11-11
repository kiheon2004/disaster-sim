import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { GroundTypeId, SoilProfileId } from '@/core/model';

export type AppMode = 'editor' | 'simulation';
/**
 * Exactly one tool owns viewport input at a time (Phase 16): select (click / Shift+click /
 * Shift+drag box, gizmo), place (single click), brush (drag to scatter), line (click points),
 * area (drag a rectangle / circle or paint a region, then apply), paste (clipboard ghost),
 * terrain (Terrain Editing Mode), road (Road Editing Mode, Phase 18 — modes in roadStore),
 * blueprint (Phase 20: drawing a capture area / placing a blueprint — session in blueprintStore).
 * Switching tools ends the previous tool's session.
 */
export type EditorTool = 'select' | 'place' | 'brush' | 'line' | 'area' | 'paste' | 'terrain' | 'building' | 'road' | 'blueprint';
/** Tools that place the armed palette preset. */
export const PLACEMENT_TOOLS: readonly EditorTool[] = ['place', 'brush', 'line', 'area'];
export const isPlacementTool = (t: EditorTool) => (PLACEMENT_TOOLS as readonly string[]).includes(t);
/** Terrain Editing Mode tools: sculpt, paint ground, or read values at a point. */
export type TerrainToolId =
  | 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint' | 'soil' | 'inspect'
  // Phase 19 landscape brushes
  | 'plateau' | 'ridge' | 'valley' | 'slope' | 'noise' | 'erode'
  // Phase 19 natural features (placed / drawn in the viewport)
  | 'mountain' | 'hill' | 'ridgeLine' | 'valleyLine' | 'canyon' | 'river' | 'lake' | 'coast' | 'forest' | 'feature';

export const BRUSH_RADIUS_RANGE: [number, number] = [1, 40];
export type TransformMode = 'translate' | 'rotate' | 'scale';

interface EditorState {
  mode: AppMode;
  tool: EditorTool;
  /** Palette preset armed for placement. */
  placeItemId: string | null;
  /** Yaw (rad) applied to the placement ghost. */
  ghostYaw: number;
  /** Primary selection (inspector, gizmo, camera focus) — the last clicked of `selectedIds`. */
  selectedId: EntityId | null;
  /** Every selected object (Phase 16 multi-selection), primary included. */
  selectedIds: EntityId[];
  hoveredId: EntityId | null;
  transformMode: TransformMode;
  /** Phase 36 §11: gizmo frame for moves (rotate / scale are always local) and an axis lock (X / Y / Z keys). */
  transformSpace: 'world' | 'local';
  axisLock: 'x' | 'y' | 'z' | null;
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
  /** Soil profile painted by the 'soil' tool (Phase 13). */
  soilType: SoilProfileId;
  /** Point picked with the inspect tool (world x/z). */
  terrainProbe: { x: number; z: number } | null;
  /** Phase 19 brush settings. */
  brushFalloff: import('@/terrain/TerrainEditor').BrushFalloff;
  brushShape: import('@/terrain/TerrainEditor').BrushShape;
  brushSeed: number;
  /** Height limits of raising / lowering brushes (null = none). */
  brushMin: number | null;
  brushMax: number | null;
  /** Height change of the current / last stroke (m): max raise, max lowering, touched area (m²). */
  strokeDelta: { up: number; down: number; area: number } | null;
  /** Phase 36: predicted change of 1 s of the brush at the cursor (before pressing), same shape as strokeDelta. */
  brushPreview: { up: number; down: number; area: number } | null;
  /** Building Edit Mode (Phase 17): the modular building whose members are being edited. */
  buildingId: EntityId | null;

  setMode: (m: AppMode) => void;
  /** Arm a preset for the current placement tool (place by default); null/same id = back to select. */
  armPlacement: (itemId: string | null) => void;
  /** Switch tool. Placement tools keep the armed preset; select / paste clear it. */
  setTool: (tool: Exclude<EditorTool, 'terrain' | 'building' | 'road' | 'blueprint'>) => void;
  /** Enter / leave Road Editing Mode (Phase 18). */
  setRoadEdit: (on: boolean) => void;
  /** Give / take viewport input to the blueprint capture / placement tool (Phase 20). */
  setBlueprintTool: (on: boolean) => void;
  rotateGhost: (delta: number) => void;
  select: (id: EntityId | null) => void;
  /** Replace the selection (primary = `primary` if given and included, else the last id). */
  setSelection: (ids: EntityId[], primary?: EntityId | null) => void;
  hover: (id: EntityId | null) => void;
  setTransformMode: (m: TransformMode) => void;
  setTransformSpace: (s: 'world' | 'local') => void;
  setAxisLock: (a: 'x' | 'y' | 'z' | null) => void;
  toggleSnap: () => void;
  toggleRandomize: () => void;
  setDragging: (d: boolean) => void;
  /** Enter Terrain Editing Mode with a tool (null = back to select). */
  setTerrainTool: (t: TerrainToolId | null) => void;
  setBrush: (patch: { radius?: number; strength?: number }) => void;
  setBrushOptions: (patch: Partial<Pick<EditorState, 'brushFalloff' | 'brushShape' | 'brushSeed' | 'brushMin' | 'brushMax'>>) => void;
  setStrokeDelta: (d: EditorState['strokeDelta']) => void;
  setBrushPreview: (d: EditorState['brushPreview']) => void;
  setPaintType: (t: GroundTypeId) => void;
  setSoilType: (t: SoilProfileId) => void;
  setTerrainProbe: (p: { x: number; z: number } | null) => void;
  /** Enter Building Edit Mode on a modular building (null = back to select, building selected). */
  setBuildingEdit: (id: EntityId | null) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  mode: 'editor',
  tool: 'select',
  placeItemId: null,
  ghostYaw: 0,
  selectedId: null,
  selectedIds: [],
  hoveredId: null,
  transformMode: 'translate',
  transformSpace: 'world',
  axisLock: null,
  snap: true,
  randomize: true,
  dragging: false,
  terrainTool: 'raise',
  brushRadius: 8,
  brushStrength: 0.5,
  paintType: 3,
  soilType: 2,
  terrainProbe: null,
  brushFalloff: 'smooth',
  brushShape: 'circle',
  brushSeed: 1,
  brushMin: null,
  brushMax: null,
  strokeDelta: null,
  brushPreview: null,
  buildingId: null,

  setMode: (mode) => set({ mode, tool: 'select', placeItemId: null, hoveredId: null, buildingId: null }),
  armPlacement: (placeItemId) => {
    const cur = get();
    if (placeItemId && placeItemId !== cur.placeItemId) {
      set({ placeItemId, tool: isPlacementTool(cur.tool) ? cur.tool : 'place', selectedId: null, selectedIds: [], buildingId: null });
    } else set({ placeItemId: null, tool: 'select', buildingId: null });
  },
  setTool: (tool) => {
    if (isPlacementTool(tool)) set({ tool, selectedId: null, selectedIds: [], hoveredId: null, buildingId: null });
    else set({ tool, placeItemId: null, hoveredId: null, buildingId: null });
  },
  rotateGhost: (delta) => set({ ghostYaw: (get().ghostYaw + delta) % (Math.PI * 2) }),
  select: (selectedId) => set({ selectedId, selectedIds: selectedId ? [selectedId] : [] }),
  setSelection: (ids, primary) => {
    const unique = [...new Set(ids)];
    const p = primary && unique.includes(primary) ? primary : unique[unique.length - 1] ?? null;
    set({ selectedIds: unique, selectedId: p });
  },
  hover: (hoveredId) => (get().hoveredId !== hoveredId ? set({ hoveredId }) : undefined),
  setTransformMode: (transformMode) => set({ transformMode, axisLock: null }),
  setTransformSpace: (transformSpace) => set({ transformSpace }),
  setAxisLock: (axisLock) => set({ axisLock }),
  toggleSnap: () => set({ snap: !get().snap }),
  toggleRandomize: () => set({ randomize: !get().randomize }),
  setDragging: (dragging) => set({ dragging }),
  setTerrainTool: (t) =>
    set(t ? { tool: 'terrain', terrainTool: t, placeItemId: null, selectedId: null, selectedIds: [], hoveredId: null, buildingId: null } : { tool: 'select' }),
  setBrush: ({ radius, strength }) =>
    set({
      brushRadius: radius === undefined ? get().brushRadius : Math.min(BRUSH_RADIUS_RANGE[1], Math.max(BRUSH_RADIUS_RANGE[0], radius)),
      brushStrength: strength === undefined ? get().brushStrength : Math.min(1, Math.max(0.05, strength)),
    }),
  setPaintType: (paintType) => set({ paintType }),
  setBrushOptions: (patch) => set(patch),
  setStrokeDelta: (strokeDelta) => set({ strokeDelta }),
  setBrushPreview: (brushPreview) => set({ brushPreview }),
  setSoilType: (soilType) => set({ soilType }),
  setTerrainProbe: (terrainProbe) => set({ terrainProbe }),
  setRoadEdit: (on) =>
    set(on ? { tool: 'road', placeItemId: null, selectedId: null, selectedIds: [], hoveredId: null, buildingId: null } : { tool: 'select' }),
  setBlueprintTool: (on) =>
    set(on ? { tool: 'blueprint', placeItemId: null, hoveredId: null, buildingId: null } : get().tool === 'blueprint' ? { tool: 'select' } : {}),
  setBuildingEdit: (id) =>
    set(id
      ? { tool: 'building', buildingId: id, placeItemId: null, selectedId: id, selectedIds: [id], hoveredId: null }
      : { tool: 'select', buildingId: null, hoveredId: null }),
}));
