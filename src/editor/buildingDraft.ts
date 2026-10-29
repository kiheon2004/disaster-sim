/**
 * Building Creator preview (Phase 17): while the parameters of a placed building are being
 * edited, the editor draws this draft object instead of the document's — nothing is committed
 * until Apply (Cancel just drops the draft).
 */
import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import type { ConversionNote } from '@/buildings/convert';

interface DraftState {
  id: EntityId | null;
  obj: WorldObject | null;
  set: (obj: WorldObject | null) => void;
  /** Report of the last legacy → modular conversion (shown in the Creator). */
  report: { id: EntityId; notes: ConversionNote[] } | null;
  setReport: (r: { id: EntityId; notes: ConversionNote[] } | null) => void;
}

export const useBuildingDraft = create<DraftState>((set) => ({
  id: null,
  obj: null,
  set: (obj) => set({ id: obj?.id ?? null, obj }),
  report: null,
  setReport: (report) => set({ report }),
}));
