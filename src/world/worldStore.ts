import { create } from 'zustand';
import type { EntityId, Transform } from '@/core/types';
import type { FloodScenario, FoundationSpec, ObjectParams, PhysicalProperties, StructuralSpec, TerrainData, TerrainPresetId, WaterSettings, WindModelSettings, WorldDocument, WorldObject } from '@/core/model';
import { defaultFloodScenario, defaultWaterSettings } from '@/core/model';
import { defaultExperiment, type ExperimentSettings } from '@/phenomena/types';
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
import { preserveOnTerrainEdit, releasePlinth } from '@/buildings/foundation';
import type { RoadNetwork } from '@/roads/types';
import { assertValid } from '@/roads/network';
import { bakeRegion, dirtyRect } from '@/roads/bake';
import { followRoads } from '@/roads/links';
import { rebakeAfterTerrainEdit, rebakeAll } from '@/roads/sync';
import { roadStats } from '@/roads/stats';

const HISTORY_LIMIT = 100;

type Objects = WorldDocument['objects'];

/**
 * One undo step: the objects as they were, plus — for terrain edits — the touched terrain
 * rectangle before/after (objects standing on edited ground move with it in the same step),
 * plus the road network as it was (Phase 18; immutable, so a reference costs nothing).
 */
export interface HistoryEntry {
  objects: Objects;
  terrain: TerrainPatch | null;
  roads: RoadNetwork;
}

/** Live brush stroke (terrain arrays are edited in place; one history entry at the end). */
interface TerrainStroke {
  before: ReturnType<typeof snapshotLayers>;
  rect: GridRect | null;
}
let stroke: TerrainStroke | null = null;

/**
 * One atomic world edit (Phase 16): bulk placement, multi-object transforms, duplicate, delete,
 * group / ungroup. The next object map is built completely before anything is committed, so an
 * exception leaves the world untouched (no partially created objects), and the whole edit is
 * ONE undo step.
 */
export interface WorldEdit {
  add?: CreateObjectInput[];
  /** Replacement objects (matched by id; unknown ids are ignored). */
  update?: WorldObject[];
  remove?: EntityId[];
  /**
   * The new road network (Phase 18). It is validated and baked into the terrain (only the
   * changed rectangle), linked objects follow their policies and grounded objects are re-seated
   * — all in the same single undo step as the object changes.
   */
  roads?: RoadNetwork;
}

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
  /**
   * Object / terrain edits are refused while a simulation runs on a snapshot of this document
   * (Phase 16): the original world can never pick up simulation state or half-done edits.
   */
  locked: boolean;
  setLocked: (locked: boolean) => void;
  /** Apply a WorldEdit atomically as one undo step. Returns the ids of the added objects. */
  applyEdit: (edit: WorldEdit, opts?: MutationOptions) => EntityId[];

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
  updateSimulationSettings: (patch: { seed?: number; wind?: Partial<WindModelSettings>; water?: Partial<WaterSettings>; interactions?: boolean }) => void;
  /** The experiment plan (Phase 15). Not an undo step (like settings). */
  setExperiment: (patch: Partial<ExperimentSettings>) => void;
  /** Structural / foundation properties of an object (earthquake). */
  updateSeismic: (id: EntityId, patch: { structure?: Partial<StructuralSpec>; foundation?: Partial<FoundationSpec> }, opts?: MutationOptions) => void;
  /** The earthquake saved with the project (null = none). Not an undo step (like settings). */
  setEarthquakeScenario: (spec: EarthquakeEventSpec | null) => void;
  /** The flood events saved with the project (Phase 14). Not an undo step (like settings). */
  setFloodScenario: (patch: Partial<FloodScenario>) => void;
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
function followTerrain(objects: Objects, before: TerrainSampler, after: TerrainSampler, area?: [number, number, number, number]): Objects {
  let out: Objects | null = null;
  for (const o of Object.values(objects)) {
    // Only objects near the changed area can be affected (largest footprints ≈ 60 m).
    if (area) {
      const [x, , z] = o.transform.position;
      if (x < area[0] - 40 || x > area[2] + 40 || z < area[1] - 40 || z > area[3] + 40) continue;
    }
    if (!isGrounded(o, before)) continue;
    // Phase 17 foundation policy 'preserve': keep the world transform, freeze the plinth.
    if (o.building?.options.foundationPolicy === 'preserve') {
      const kept = preserveOnTerrainEdit(o, before);
      if (kept !== o) {
        out ??= { ...objects };
        out[o.id] = kept;
      }
      continue;
    }
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
    const { doc, past, locked } = get();
    if (locked) return;
    if (opts?.history === false) {
      set({ doc: touch(doc, next) });
    } else {
      set({ doc: touch(doc, next), past: [...past, { objects: doc.objects, terrain: null, roads: doc.roads }].slice(-HISTORY_LIMIT), future: [] });
    }
  };

  /**
   * Finish a terrain change made in place: roads over the edited ground are re-baked (unless the
   * caller already did), objects follow, one history entry, new doc.
   */
  const commitTerrain = (before: ReturnType<typeof snapshotLayers>, rect: GridRect, roadsAfter?: RoadNetwork) => {
    const { doc, past } = get();
    // (Terrain arrays are edited in place: callers check `locked` before touching them.)
    const t = doc.terrain;
    let roads = roadsAfter ?? doc.roads;
    if (!roadsAfter) {
      const r = rebakeAfterTerrainEdit(t, doc.roads, before, rect);
      roads = r.roads;
      rect = r.rect;
    }
    const patch = makePatch(t, before, rect);
    const objects = followTerrain(doc.objects, samplerOver(t, before), samplerFor(t));
    set({
      doc: { ...touch(doc, objects), terrain: { ...t }, roads },
      past: [...past, { objects: doc.objects, terrain: patch, roads: doc.roads }].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /** Undo/redo: swap objects + roads, and apply the terrain side of the patch if there is one. */
  const travel = (entry: HistoryEntry, side: 'before' | 'after'): WorldDocument => {
    const doc = get().doc;
    if (!entry.terrain) return { ...touch(doc, entry.objects), roads: entry.roads };
    applyPatch(doc.terrain, entry.terrain, side);
    return { ...touch(doc, entry.objects), terrain: { ...doc.terrain }, roads: entry.roads };
  };

  /**
   * Road part of an atomic edit: bake prev → next into the terrain (dirty rectangle only), then
   * linked objects follow their policies and grounded objects are re-seated. Mutates the terrain
   * in place; returns what the caller commits. Throws (before touching anything) on an invalid
   * network.
   */
  const bakeRoads = (doc: WorldDocument, objects: Objects, next: RoadNetwork) => {
    assertValid(next);
    const t0 = performance.now();
    const t = doc.terrain;
    const prev = doc.roads;
    const rect = dirtyRect(t, prev, next);
    if (!rect) return { objects, roads: { ...next, underlay: prev.underlay }, patch: null };
    const before = snapshotLayers(t);
    const res = bakeRegion(t, prev, next, rect);
    const roads: RoadNetwork = { ...next, underlay: res.underlay };
    const beforeSampler = samplerOver(t, before);
    const after = samplerFor(t);
    let out = followRoads(objects, prev, roads, beforeSampler, after);
    if (res.rect) {
      const area: [number, number, number, number] = [
        t.originX + res.rect.x0 * t.cellSize, t.originZ + res.rect.z0 * t.cellSize,
        t.originX + res.rect.x1 * t.cellSize, t.originZ + res.rect.z1 * t.cellSize,
      ];
      out = followTerrain(out, beforeSampler, after, area);
    }
    roadStats.bakes++;
    roadStats.bakeMs += performance.now() - t0;
    roadStats.lastBakeMs = performance.now() - t0;
    return { objects: out, roads, patch: res.rect ? makePatch(t, before, res.rect) : null };
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

    locked: false,
    setLocked: (locked) => set({ locked }),

    addObject: (input) => get().addObjects([input])[0],

    addObjects: (inputs) => get().applyEdit({ add: inputs }),

    applyEdit: (edit, opts) => {
      if (get().locked) return [];
      const objects = { ...get().doc.objects };
      let changed = false;
      for (const id of edit.remove ?? []) {
        if (objects[id]) {
          delete objects[id];
          changed = true;
        }
      }
      for (const o of edit.update ?? []) {
        if (!objects[o.id]) continue;
        objects[o.id] = o;
        changed = true;
      }
      const ids: EntityId[] = [];
      if (edit.roads) assertValid(edit.roads); // refuse before anything changes
      if (edit.add?.length) {
        // Running serial numbers per type, computed once (not O(n) per added object).
        const serial = new Map<string, number>();
        for (const o of Object.values(objects)) if (o.serial > (serial.get(o.type) ?? 0)) serial.set(o.type, o.serial);
        for (const input of edit.add) {
          const n = (serial.get(input.type) ?? 0) + 1;
          serial.set(input.type, n);
          const obj = createWorldObject(input, n);
          if (objects[obj.id]) throw new Error(`Duplicate object id ${obj.id}`);
          objects[obj.id] = obj;
          ids.push(obj.id);
        }
        changed = true;
      }
      if (edit.roads && edit.roads !== get().doc.roads) {
        const doc = get().doc;
        const r = bakeRoads(doc, objects, edit.roads);
        const entry: HistoryEntry = { objects: doc.objects, terrain: r.patch, roads: doc.roads };
        set({
          doc: { ...touch(doc, r.objects), terrain: r.patch ? { ...doc.terrain } : doc.terrain, roads: r.roads },
          // Always an undo step: the terrain patch and the network must travel together
          // (road tools preview drags without committing and commit once on release).
          past: [...get().past, entry].slice(-HISTORY_LIMIT),
          future: [],
        });
        return ids;
      }
      if (changed) commit(objects, opts);
      return ids;
    },

    updateTransform: (id, patch, opts) =>
      patchObject(id, (o) => releasePlinth({ ...o, transform: { ...o.transform, ...patch } }), opts),

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
      if (get().locked) return null;
      const objects = get().doc.objects;
      const src = objects[id];
      if (!src) return null;
      const [x, y, z] = src.transform.position;
      const copy: WorldObject = structuredClone(src);
      copy.id = createId(src.type);
      copy.serial = nextSerial(objects, src.type);
      copy.name = src.name;
      copy.transform.position = [x + 2, y, z + 2];
      // A single copy is not part of the source's group.
      delete copy.group;
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
            simulation: {
              seed: patch.seed ?? cur.seed,
              wind: { ...cur.wind, ...(patch.wind ?? {}) },
              water: { ...(cur.water ?? defaultWaterSettings()), ...(patch.water ?? {}) },
              interactions: { enabled: patch.interactions ?? cur.interactions?.enabled ?? true },
            },
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

    setExperiment: (patch) => {
      const doc = get().doc;
      const experiment = { ...(doc.scenario.experiment ?? defaultExperiment()), ...structuredClone(patch) };
      set({ doc: { ...doc, scenario: { ...doc.scenario, experiment }, meta: { ...doc.meta, updatedAt: new Date().toISOString() } } });
    },

    setFloodScenario: (patch) => {
      const doc = get().doc;
      const flood = { ...(doc.scenario.flood ?? defaultFloodScenario()), ...structuredClone(patch) };
      set({ doc: { ...doc, scenario: { ...doc.scenario, flood }, meta: { ...doc.meta, updatedAt: new Date().toISOString() } } });
    },

    replaceDocument: (doc) => {
      if (get().locked) return;
      stroke = null;
      set({ doc, past: [], future: [], docVersion: get().docVersion + 1 });
    },

    newDocument: () => {
      if (get().locked) return;
      stroke = null;
      set({ doc: createEmptyDocument(), past: [], future: [], docVersion: get().docVersion + 1 });
    },

    beginTerrainStroke: () => {
      if (get().locked) return;
      stroke = { before: snapshotLayers(get().doc.terrain), rect: null };
    },

    terrainDab: (opts) => {
      if (get().locked) return null;
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
      if (get().locked) return;
      const t = get().doc.terrain;
      const before = snapshotLayers(t);
      const next = generateTerrain(preset, seed, t);
      t.heights.set(next.heights);
      t.ground.set(next.ground);
      t.soil.set(next.soil);
      t.settings = next.settings;
      t.revision++;
      // The whole ground is new and natural: roads are baked onto it from scratch.
      commitTerrain(before, fullRect(t), rebakeAll(t, get().doc.roads));
    },

    setWaterLevel: (level) => {
      if (get().locked) return;
      const t = get().doc.terrain;
      const before = snapshotLayers(t);
      t.settings = { ...t.settings, waterLevel: level };
      t.revision++;
      // Settings-only change: a 1-vertex patch still carries settings before/after for undo.
      commitTerrain(before, { x0: 0, z0: 0, x1: 0, z1: 0 }, get().doc.roads);
    },

    checkpoint: () => {
      const { doc, past, locked } = get();
      if (locked) return;
      set({ past: [...past, { objects: doc.objects, terrain: null, roads: doc.roads }].slice(-HISTORY_LIMIT), future: [] });
    },

    undo: () => {
      const { doc, past, future, locked } = get();
      const prev = past[past.length - 1];
      if (!prev || stroke || locked) return;
      const current: HistoryEntry = { objects: doc.objects, terrain: prev.terrain, roads: doc.roads };
      set({ doc: travel(prev, 'before'), past: past.slice(0, -1), future: [current, ...future] });
    },

    redo: () => {
      const { doc, past, future, locked } = get();
      const next = future[0];
      if (!next || stroke || locked) return;
      const current: HistoryEntry = { objects: doc.objects, terrain: next.terrain, roads: doc.roads };
      set({ doc: travel(next, 'after'), past: [...past, current], future: future.slice(1) });
    },
  };
});

/** Convenience selectors */
export const selectObjectList = (s: WorldState) => s.doc.objects;
