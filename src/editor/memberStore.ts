/**
 * Building Edit Mode state (Phase 17): member selection and tool options. Transient — the
 * members themselves live in the world document (every change is one undo step there).
 */
import { create } from 'zustand';
import type { MemberType } from '@/buildings/types';

export type MemberGizmo = 'translate' | 'rotate';

interface MemberState {
  /** Selected member ids of the building being edited. */
  selected: string[];
  /** Member type being added (click to place), or null = select. */
  adding: MemberType | null;
  gizmo: MemberGizmo;
  /** Show interior members (x-ray). */
  xray: boolean;
  /** Draw the load path (supports, utilization, unsupported members). */
  loadPath: boolean;
  /** Show stories up to this one only (cutaway), null = all. */
  cut: number | null;
  snap: { grid: boolean; floor: boolean; structure: boolean };
  /** Grid step for member moves (m). */
  gridStep: number;
  /** Removal preview of the building being edited (Phase 25) — for this design object only. */
  preview: { design: import('@/buildings/types').BuildingDesign; result: import('@/structure/preview').RemovalPreview } | null;
  setPreview: (p: MemberState['preview']) => void;
  /** Heading (rad) of the member being added (R turns it 90°). */
  addYaw: number;
  /** Phase 36: first joint of the brace being placed (joint → joint), building-local; null = none picked yet. */
  braceFrom: [number, number, number] | null;
  setBraceFrom: (p: [number, number, number] | null) => void;
  rotateAdd: () => void;
  select: (ids: string[]) => void;
  toggle: (id: string) => void;
  setAdding: (t: MemberType | null) => void;
  setGizmo: (g: MemberGizmo) => void;
  setXray: (v: boolean) => void;
  setLoadPath: (v: boolean) => void;
  setCut: (v: number | null) => void;
  setSnap: (patch: Partial<MemberState['snap']>) => void;
  setGridStep: (v: number) => void;
  reset: () => void;
}

export const useMemberStore = create<MemberState>((set, get) => ({
  selected: [],
  adding: null,
  gizmo: 'translate',
  xray: true,
  loadPath: false,
  cut: null,
  snap: { grid: true, floor: true, structure: true },
  gridStep: 0.5,
  addYaw: 0,
  braceFrom: null,
  setBraceFrom: (braceFrom) => set({ braceFrom }),
  preview: null,
  setPreview: (preview) => set({ preview }),
  rotateAdd: () => set({ addYaw: (get().addYaw + Math.PI / 2) % (Math.PI * 2) }),
  select: (selected) => set({ selected: [...new Set(selected)] }),
  toggle: (id) => {
    const cur = get().selected;
    set({ selected: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  setAdding: (adding) => set({ adding, selected: adding ? [] : get().selected, braceFrom: null }),
  setGizmo: (gizmo) => set({ gizmo }),
  setXray: (xray) => set({ xray }),
  setLoadPath: (loadPath) => set({ loadPath }),
  setCut: (cut) => set({ cut }),
  setSnap: (patch) => set({ snap: { ...get().snap, ...patch } }),
  setGridStep: (gridStep) => set({ gridStep }),
  reset: () => set({ selected: [], adding: null, cut: null, preview: null, braceFrom: null }),
}));
