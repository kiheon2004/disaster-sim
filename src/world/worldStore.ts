import { create } from 'zustand';
import type { EntityId, Transform } from '@/core/types';
import type { ObjectParams, PhysicalProperties, WindModelSettings, WorldDocument, WorldObject } from '@/core/model';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';
import {
  applyParams,
  createEmptyDocument,
  createWorldObject,
  nextSerial,
  type CreateObjectInput,
} from './WorldDocument';

const HISTORY_LIMIT = 100;

type Objects = WorldDocument['objects'];

export interface MutationOptions {
  /** Record an undo step (default true). Use false for continuous edits (gizmo drags, scrubbing). */
  history?: boolean;
}

interface WorldState {
  doc: WorldDocument;
  past: Objects[];
  future: Objects[];
  /** Incremented when the whole document is replaced (new/load), so views can reset. */
  docVersion: number;

  addObject: (input: CreateObjectInput) => EntityId;
  addObjects: (inputs: CreateObjectInput[]) => EntityId[];
  updateTransform: (id: EntityId, patch: Partial<Transform>, opts?: MutationOptions) => void;
  updateParams: (id: EntityId, patch: ObjectParams, opts?: MutationOptions) => void;
  updatePhysics: (id: EntityId, patch: Partial<PhysicalProperties>, opts?: MutationOptions) => void;
  resetPhysics: (id: EntityId) => void;
  rename: (id: EntityId, name: string) => void;
  remove: (ids: EntityId[]) => void;
  duplicate: (id: EntityId) => EntityId | null;
  setProjectName: (name: string) => void;
  updateSimulationSettings: (patch: { seed?: number; wind?: Partial<WindModelSettings> }) => void;
  replaceDocument: (doc: WorldDocument) => void;
  newDocument: () => void;
  /** Record the current state as an undo step (call once before a continuous edit). */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
}

const touch = (doc: WorldDocument, objects: Objects): WorldDocument => ({
  ...doc,
  objects,
  meta: { ...doc.meta, updatedAt: new Date().toISOString() },
});

export const useWorldStore = create<WorldState>((set, get) => {
  /** Shared write path: optionally records history, then replaces objects immutably. */
  const commit = (next: Objects, opts?: MutationOptions) => {
    const { doc, past } = get();
    if (opts?.history === false) {
      set({ doc: touch(doc, next) });
    } else {
      set({ doc: touch(doc, next), past: [...past, doc.objects].slice(-HISTORY_LIMIT), future: [] });
    }
  };

  const patchObject = (id: EntityId, fn: (o: WorldObject) => WorldObject, opts?: MutationOptions) => {
    const objects = get().doc.objects;
    const obj = objects[id];
    if (!obj) return;
    commit({ ...objects, [id]: fn(obj) }, opts);
  };

  return {
    doc: createEmptyDocument(),
    past: [],
    future: [],
    docVersion: 0,

    addObject: (input) => get().addObjects([input])[0],

    addObjects: (inputs) => {
      const objects = { ...get().doc.objects };
      const ids: EntityId[] = [];
      for (const input of inputs) {
        const obj = createWorldObject(input, nextSerial(objects, input.type));
        objects[obj.id] = obj;
        ids.push(obj.id);
      }
      commit(objects);
      return ids;
    },

    updateTransform: (id, patch, opts) =>
      patchObject(id, (o) => ({ ...o, transform: { ...o.transform, ...patch } }), opts),

    updateParams: (id, patch, opts) => patchObject(id, (o) => applyParams(o, patch), opts),

    updatePhysics: (id, patch, opts) =>
      patchObject(id, (o) => ({ ...o, physics: { ...o.physics, ...patch } }), opts),

    resetPhysics: (id) =>
      patchObject(id, (o) => ({ ...o, physics: getDefinition(o.type).defaultPhysics(o.params) })),

    rename: (id, name) => patchObject(id, (o) => ({ ...o, name })),

    remove: (ids) => {
      const objects = { ...get().doc.objects };
      let changed = false;
      for (const id of ids) if (objects[id]) { delete objects[id]; changed = true; }
      if (changed) commit(objects);
    },

    duplicate: (id) => {
      const objects = get().doc.objects;
      const src = objects[id];
      if (!src) return null;
      const [x, y, z] = src.transform.position;
      const copy: WorldObject = structuredClone(src);
      copy.id = createId(src.type);
      copy.serial = nextSerial(objects, src.type);
      copy.name = src.name;
      copy.transform.position = [x + 2, y, z + 2];
      commit({ ...objects, [copy.id]: copy });
      return copy.id;
    },

    setProjectName: (name) => {
      const doc = get().doc;
      set({ doc: { ...doc, meta: { ...doc.meta, name, updatedAt: new Date().toISOString() } } });
    },

    updateSimulationSettings: (patch) => {
      const doc = get().doc;
      const cur = doc.settings.simulation;
      set({
        doc: {
          ...doc,
          settings: {
            ...doc.settings,
            simulation: { seed: patch.seed ?? cur.seed, wind: { ...cur.wind, ...(patch.wind ?? {}) } },
          },
          meta: { ...doc.meta, updatedAt: new Date().toISOString() },
        },
      });
    },

    replaceDocument: (doc) => set({ doc, past: [], future: [], docVersion: get().docVersion + 1 }),

    newDocument: () =>
      set({ doc: createEmptyDocument(), past: [], future: [], docVersion: get().docVersion + 1 }),

    checkpoint: () => {
      const { doc, past } = get();
      set({ past: [...past, doc.objects].slice(-HISTORY_LIMIT), future: [] });
    },

    undo: () => {
      const { doc, past, future } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      set({ doc: touch(doc, prev), past: past.slice(0, -1), future: [doc.objects, ...future] });
    },

    redo: () => {
      const { doc, past, future } = get();
      const next = future[0];
      if (!next) return;
      set({ doc: touch(doc, next), past: [...past, doc.objects], future: future.slice(1) });
    },
  };
});

/** Convenience selectors */
export const selectObjectList = (s: WorldState) => s.doc.objects;
