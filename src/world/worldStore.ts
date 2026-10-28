import { create } from 'zustand';
import type { EntityId, Transform } from '@/core/types';
import type { FoundationSpec, ObjectParams, PhysicalProperties, StructuralSpec, TerrainData, TerrainPresetId, WindModelSettings, WorldDocument, WorldObject } from '@/core/model';
import type { EarthquakeEventSpec } from '@/events/specs';
import { normalizeSeismic, seismicOf } from '@/simulation/seismic/structuralProps';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';
import {
  applyParams,
  createEmptyDocument,
  createWorldObject,
  nextSerial,
  type CreateObjectInput,
} from './WorldDocument';
import { applyPatch, fullRect, makePatch, snapshotLayers, unionRect, type GridRect, type TerrainPatch } from '@/terrain/TerrainData';
import { applyDab, type DabOptions } from '@/terrain/TerrainEditor';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler, samplerFor } from '@/terrain/TerrainSampler';
import { isGrounded, reseat } from '@/terrain/groundPlacement';
import { terrainStats } from '@/terrain/terrainStats';

const HISTORY_LIMIT = 100;

type Objects = WorldDocument['objects'];

/**
 * One undo step: the objects as they were, plus — for terrain edits — the touched terrain
 * rectangle before/after (objects standing on edited ground move with it in the same step).
 */
export interface HistoryEntry {
  objects: Objects;
  terrain: TerrainPatch | null;
}

/** Live brush stroke (terrain arrays are edited in place; one history entry at the end). */
interface TerrainStroke {
  before: ReturnType<typeof snapshotLayers>;
  rect: GridRect | null;
}
let stroke: TerrainStroke | null = null;

export interface MutationOptions {
  /** Record an undo step (default true). Use false for continuous edits (gizmo drags, scrubbing). */
  history?: boolean;
}

interface WorldState {
  doc: WorldDocument;
  past: HistoryEntry[];
  future: HistoryEntry[];
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
  /** Structural / foundation properties of an object (earthquake). */
  updateSeismic: (id: EntityId, patch: { structure?: Partial<StructuralSpec>; foundation?: Partial<FoundationSpec> }, opts?: MutationOptions) => void;
  /** The earthquake saved with the project (null = none). Not an undo step (like settings). */
  setEarthquakeScenario: (spec: EarthquakeEventSpec | null) => void;
  replaceDocument: (doc: WorldDocument) => void;
  newDocument: () => void;
  /** Terrain brush stroke: begin → dab (every frame while held) → end (one undo step). */
  beginTerrainStroke: () => void;
  terrainDab: (opts: DabOptions) => GridRect | null;
  endTerrainStroke: () => void;
  applyTerrainPreset: (preset: TerrainPresetId, seed: number) => void;
  setWaterLevel: (level: number | null) => void;
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

/**
 * Objects that stood on the ground before a terrain change, re-seated on the new ground
 * (heading kept). Lifted objects stay where they are.
 */
function followTerrain(objects: Objects, before: TerrainSampler, after: TerrainSampler): Objects {
  let out: Objects | null = null;
  for (const o of Object.values(objects)) {
    if (!isGrounded(o, before)) continue;
    const p = reseat(o, after);
    const t = o.transform;
    if (p.position[1] === t.position[1] && p.rotation.every((v, i) => v === t.rotation[i])) continue;
    out ??= { ...objects };
    out[o.id] = { ...o, transform: { ...t, position: p.position, rotation: p.rotation } };
  }
  return out ?? objects;
}

/** Sampler over a copy of the layers (the terrain as it was before an edit). */
function samplerOver(t: TerrainData, layers: ReturnType<typeof snapshotLayers>): TerrainSampler {
  return new TerrainSampler({ ...t, heights: layers.heights, ground: layers.ground, soil: layers.soil, settings: layers.settings, revision: -1 });
}

export const useWorldStore = create<WorldState>((set, get) => {
  /** Shared write path: optionally records history, then replaces objects immutably. */
  const commit = (next: Objects, opts?: MutationOptions) => {
    const { doc, past } = get();
    if (opts?.history === false) {
      set({ doc: touch(doc, next) });
    } else {
      set({ doc: touch(doc, next), past: [...past, { objects: doc.objects, terrain: null }].slice(-HISTORY_LIMIT), future: [] });
    }
  };

  /** Finish a terrain change made in place: objects follow, one history entry, new doc. */
  const commitTerrain = (before: ReturnType<typeof snapshotLayers>, rect: GridRect) => {
    const { doc, past } = get();
    const t = doc.terrain;
    const patch = makePatch(t, before, rect);
    const objects = followTerrain(doc.objects, samplerOver(t, before), samplerFor(t));
    set({
      doc: { ...touch(doc, objects), terrain: { ...t } },
      past: [...past, { objects: doc.objects, terrain: patch }].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /** Undo/redo: swap objects, and apply the terrain side of the patch if there is one. */
  const travel = (entry: HistoryEntry, side: 'before' | 'after'): WorldDocument => {
    const doc = get().doc;
    if (!entry.terrain) return touch(doc, entry.objects);
    applyPatch(doc.terrain, entry.terrain, side);
    return { ...touch(doc, entry.objects), terrain: { ...doc.terrain } };
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
      const terrain = samplerFor(get().doc.terrain);
      if (isGrounded(src, terrain)) {
        const p = reseat(copy, terrain);
        copy.transform.position = p.position;
        copy.transform.rotation = p.rotation;
      }
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

    updateSeismic: (id, patch, opts) =>
      patchObject(id, (o) => {
        const cur = seismicOf(o);
        if (!cur) return o;
        const seismic = normalizeSeismic(o.type, { structure: { ...cur.structure, ...(patch.structure ?? {}) }, foundation: { ...cur.foundation, ...(patch.foundation ?? {}) } });
        return { ...o, seismic };
      }, opts),

    setEarthquakeScenario: (spec) => {
      const doc = get().doc;
      set({ doc: { ...doc, scenario: { ...doc.scenario, earthquake: spec ? { ...spec } : null }, meta: { ...doc.meta, updatedAt: new Date().toISOString() } } });
    },

    replaceDocument: (doc) => {
      stroke = null;
      set({ doc, past: [], future: [], docVersion: get().docVersion + 1 });
    },

    newDocument: () => {
      stroke = null;
      set({ doc: createEmptyDocument(), past: [], future: [], docVersion: get().docVersion + 1 });
    },

    beginTerrainStroke: () => {
      stroke = { before: snapshotLayers(get().doc.terrain), rect: null };
    },

    terrainDab: (opts) => {
      if (!stroke) get().beginTerrainStroke();
      const t0 = performance.now();
      const rect = applyDab(get().doc.terrain, opts);
      terrainStats.dabs++;
      terrainStats.dabMs += performance.now() - t0;
      stroke!.rect = unionRect(stroke!.rect, rect);
      return rect;
    },

    endTerrainStroke: () => {
      const s = stroke;
      stroke = null;
      if (s?.rect) commitTerrain(s.before, s.rect);
    },

    applyTerrainPreset: (preset, seed) => {
      const t = get().doc.terrain;
      const before = snapshotLayers(t);
      const next = generateTerrain(preset, seed, t);
      t.heights.set(next.heights);
      t.ground.set(next.ground);
      t.soil.set(next.soil);
      t.settings = next.settings;
      t.revision++;
      commitTerrain(before, fullRect(t));
    },

    setWaterLevel: (level) => {
      const t = get().doc.terrain;
      const before = snapshotLayers(t);
      t.settings = { ...t.settings, waterLevel: level };
      t.revision++;
      // Settings-only change: a 1-vertex patch still carries settings before/after for undo.
      commitTerrain(before, { x0: 0, z0: 0, x1: 0, z1: 0 });
    },

    checkpoint: () => {
      const { doc, past } = get();
      set({ past: [...past, { objects: doc.objects, terrain: null }].slice(-HISTORY_LIMIT), future: [] });
    },

    undo: () => {
      const { doc, past, future } = get();
      const prev = past[past.length - 1];
      if (!prev || stroke) return;
      const current: HistoryEntry = { objects: doc.objects, terrain: prev.terrain };
      set({ doc: travel(prev, 'before'), past: past.slice(0, -1), future: [current, ...future] });
    },

    redo: () => {
      const { doc, past, future } = get();
      const next = future[0];
      if (!next || stroke) return;
      const current: HistoryEntry = { objects: doc.objects, terrain: next.terrain };
      set({ doc: travel(next, 'after'), past: [...past, current], future: future.slice(1) });
    },
  };
});

/** Convenience selectors */
export const selectObjectList = (s: WorldState) => s.doc.objects;
