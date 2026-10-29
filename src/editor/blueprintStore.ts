/**
 * Blueprint Mode session state (Phase 20): library browsing, capture (selection → blueprint)
 * and placement (ghost preview → confirm). Transient editor state — never saved with the world.
 * The library contents live in blueprints/library.ts.
 */
import { create } from 'zustand';
import type { P2 } from '@/landscape/types';
import type { SelectionShape } from '@/blueprints/selection';
import type { CaptureReport } from '@/blueprints/capture';
import type { PlacementOptions, PlacementPlan } from '@/blueprints/place';
import { defaultPlacement } from '@/blueprints/place';
import { ALL_INCLUDED, type BlueprintCategory, type BoundaryPolicy, type CaptureInclude, type UnifiedBlueprint } from '@/blueprints/types';
import type { ImportCheck, LibraryCategory } from '@/blueprints/library';

export type BlueprintMode = 'library' | 'capture' | 'place';
export type CaptureShapeKind = 'rect' | 'polygon' | 'selection';
export type LibraryFilter = 'all' | 'favorites' | LibraryCategory;

export interface CaptureSession {
  kind: CaptureShapeKind;
  shape: SelectionShape | null;
  /** Polygon points being clicked. */
  draft: P2[];
  include: CaptureInclude;
  roads: BoundaryPolicy;
  nature: BoundaryPolicy;
  name: string;
  description: string;
  category: BlueprintCategory | 'auto';
  tags: string;
  /** Explicit selections taken when the capture started ('selection' kind / mixed). */
  selection: { objects: string[]; segments: string[]; features: string[] };
  result: { blueprint: UnifiedBlueprint; report: CaptureReport } | null;
}

export type PlaceOptions = Omit<PlacementOptions, 'x' | 'z' | 'yaw'>;

export interface PlaceSession {
  entryId: string | null;
  blueprint: UnifiedBlueprint | null;
  options: PlaceOptions;
  yaw: number;
  /** Cursor position (ghost follows it) and the clicked (pinned) position. */
  hover: P2 | null;
  pinned: P2 | null;
  /** Full plan (validation, policies) for the pinned / last resting position. */
  plan: PlacementPlan | null;
}

const placeDefaults = (): PlaceOptions => {
  const { x: _x, z: _z, yaw: _y, ...rest } = defaultPlacement();
  void _x; void _z; void _y;
  return rest;
};

export const emptyCapture = (): CaptureSession => ({
  kind: 'rect', shape: null, draft: [], include: { ...ALL_INCLUDED }, roads: 'clip', nature: 'clip',
  name: '', description: '', category: 'auto', tags: '', selection: { objects: [], segments: [], features: [] }, result: null,
});

export const emptyPlace = (): PlaceSession => ({ entryId: null, blueprint: null, options: placeDefaults(), yaw: 0, hover: null, pinned: null, plan: null });

interface BlueprintUiState {
  mode: BlueprintMode;
  query: string;
  filter: LibraryFilter;
  selectedId: string | null;
  capture: CaptureSession;
  place: PlaceSession;
  /** Import dialog (checked file waiting for confirmation). */
  importCheck: ImportCheck | null;
  wizardOpen: boolean;
  templateDialog: boolean;
  setMode: (m: BlueprintMode) => void;
  setQuery: (q: string) => void;
  setFilter: (f: LibraryFilter) => void;
  select: (id: string | null) => void;
  setCapture: (patch: Partial<CaptureSession>) => void;
  setPlace: (patch: Partial<PlaceSession>) => void;
  setPlaceOptions: (patch: Partial<PlaceOptions>) => void;
  setImportCheck: (c: ImportCheck | null) => void;
  setWizardOpen: (open: boolean) => void;
  setTemplateDialog: (open: boolean) => void;
}

export const useBlueprintStore = create<BlueprintUiState>((set, get) => ({
  mode: 'library',
  query: '',
  filter: 'all',
  selectedId: null,
  capture: emptyCapture(),
  place: emptyPlace(),
  importCheck: null,
  wizardOpen: false,
  templateDialog: false,
  setMode: (mode) => set({ mode }),
  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),
  select: (selectedId) => set({ selectedId }),
  setCapture: (patch) => set({ capture: { ...get().capture, ...patch } }),
  setPlace: (patch) => set({ place: { ...get().place, ...patch } }),
  setPlaceOptions: (patch) => set({ place: { ...get().place, options: { ...get().place.options, ...patch }, plan: null } }),
  setImportCheck: (importCheck) => set({ importCheck }),
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  setTemplateDialog: (templateDialog) => set({ templateDialog }),
}));
