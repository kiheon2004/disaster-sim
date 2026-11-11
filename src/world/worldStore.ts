import { defaultFireSettings } from '@/fire/types';
import { defaultThermalSettings } from '@/thermal/ThermalWorld';
import { create, type StateCreator } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { EntityId, Transform } from '@/core/types';
import type { FloodScenario, FoundationSpec, ObjectParams, PhysicalProperties, StructuralSpec, TerrainData, TerrainPresetId, WaterSettings, WindModelSettings, WorldDocument, WorldObject } from '@/core/model';
import { defaultFloodScenario, defaultWaterSettings } from '@/core/model';
import { defaultExperiment, type ExperimentSettings } from '@/phenomena/types';
import type { EarthquakeEventSpec } from '@/events/specs';
import { normalizeSeismic, seismicOf } from '@/simulation/seismic/structuralProps';
import { createId } from '@/core/id';
import { sameObjectValue } from './sameObject';
import { getDefinition } from '@/objects/registry';
import {
  applyParams,
  createEmptyDocument,
  createWorldObject,
  nextSerial,
  type CreateObjectInput,
} from './WorldDocument';
import { applyPatch, changedRect, makePatch, restoreLayers, snapshotLayers, unionRect, type GridRect, type TerrainPatch } from '@/terrain/TerrainData';
import { applyDab, type DabOptions } from '@/terrain/TerrainEditor';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler, samplerFor } from '@/terrain/TerrainSampler';
import { groundFollowOf, groundPose, isGrounded, reseat, yawOf } from '@/terrain/groundPlacement';
import { terrainStats } from '@/terrain/terrainStats';
import { preserveOnTerrainEdit, releasePlinth } from '@/buildings/foundation';
import type { RoadNetwork } from '@/roads/types';
import { assertValid } from '@/roads/network';
import { bakeRegion, dirtyRect } from '@/roads/bake';
import { followRoads, relinkMoved } from '@/roads/links';
import type { Feature } from '@/landscape/types';
import { NO_PAINT } from '@/landscape/types';
import { expandForRivers, featureChangeRect, fullGridRect, unionRects } from '@/landscape/compose';
import { adoptTerrain, ALL_LAYERS, applyLayerPatch, diffLayerPatch, makeLayerPatch, makeLayerPatchFromRect, naturalProvider, recompose, restoreLandscape, snapshotLandscape, snapshotLandscapeRect, type LayerPatch, type LayerSnapshot, type RectLayerSnapshot } from '@/landscape/apply';
import { roadStats } from '@/roads/stats';

const HISTORY_LIMIT = 100;
/**
 * Phase 36 (§23): the history is bounded by memory as well as by count. A terrain step holds its before / after patch
 * (12 B per vertex of the changed rectangle, + 30 B per vertex of recomposed layers); a full-map step on a 1 km map is
 * ~42 MB, so 100 such steps would not fit in a browser tab. The oldest steps are dropped beyond this many bytes.
 */
export const HISTORY_BYTES = 64 * 1024 * 1024;

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
  /** Terrain layers (Phase 19): features as they were + the layer arrays' patch (if any). */
  landscape: LandscapeEntry;
  /**
   * Phase 21: environment settings and the saved scenario (experiment / hazard setup) as they
   * were — present only on steps that changed them (template applied to the current world), so
   * undo / redo restore the whole world configuration together with its geometry. Phase 37: each half
   * only when THAT half changed in the step — undoing a placed disaster (scenario) no longer puts back
   * the simulation settings as they were at that step (settings edits are not undo steps of their own).
   */
  config?: { settings?: WorldDocument['settings']; scenario?: WorldDocument['scenario'] };
  /** Phase 36: the group names as they were — present only on steps that renamed a group. */
  groupNames?: { value: WorldDocument['groups'] };
}

export interface LandscapeEntry {
  features: Feature[];
  next: number;
  patch: LayerPatch | null;
}

const entryBytes = new WeakMap<HistoryEntry, number>();

/**
 * Bytes a history entry holds on its own: its terrain and layer patch arrays. Objects, roads and features are immutable
 * values shared with the document and the neighbouring steps, so they are not counted.
 */
export function historyEntryBytes(e: HistoryEntry): number {
  const hit = entryBytes.get(e);
  if (hit !== undefined) return hit;
  let b = 0;
  const p = e.terrain;
  if (p) b += p.heightsBefore.byteLength + p.heightsAfter.byteLength + p.groundBefore.byteLength + p.groundAfter.byteLength + p.soilBefore.byteLength + p.soilAfter.byteLength;
  for (const l of e.landscape.patch?.layers ?? []) b += l.before.byteLength + l.after.byteLength;
  entryBytes.set(e, b);
  return b;
}

/** Append an undo step, keeping at most `limit` steps and `bytes` of patches (the newest step is always kept). */
export function pushHistory(past: readonly HistoryEntry[], entry: HistoryEntry, limit = HISTORY_LIMIT, bytes = HISTORY_BYTES): HistoryEntry[] {
  const out = [...past, entry].slice(-limit);
  let total = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    total += historyEntryBytes(out[i]);
    if (total > bytes && i < out.length - 1) return out.slice(i + 1);
  }
  return out;
}

/** Landscape part of a WorldEdit (Phase 19). */
export interface LandscapeEdit {
  /** The new feature list (immutable values; unchanged features keep their object). */
  features?: Feature[];
  next?: number;
  /** Replace the base terrain (environment presets); sculpt and paint are cleared. */
  base?: { heights: Float32Array; ground: Uint8Array; soil?: Uint8Array; settings?: TerrainData['settings'] };
  /**
   * Sculpt to ADD and paint to SET in a rectangle (nature regions, Phase 20 blueprints). `soil`
   * (Phase 20): soil profile to SET (255 = keep) — a terrain layer, recorded in the same patch.
   */
  layers?: { rect: GridRect; sculpt: Float32Array | null; paint: Uint8Array | null; soil?: Uint8Array | null };
}

/** Live brush stroke (terrain arrays are edited in place; one history entry at the end). */
interface TerrainStroke {
  before: ReturnType<typeof snapshotLayers>;
  rect: GridRect | null;
}

/**
 * Open object transaction (Phase 36): a continuous edit (gizmo drag, field scrub) writes with
 * `history: false`; the state it started from is kept here and becomes ONE undo step on commit —
 * or comes back on cancel. Nothing is recorded when nothing changed (no empty undo steps).
 */
interface ObjectTransaction {
  objects: Objects;
  docVersion: number;
}

/**
 * Open batch (Phase 37): every undo step recorded while it is open lands in `entries` instead of the history. The
 * document as it was when the batch opened is kept — the immutable parts by reference, the terrain and layer arrays
 * (edited in place) as full copies (27 B per vertex: 1.1 MB on the 200 m map). Commit compares the document with it and
 * records ONE history entry of what really changed; a failure copies everything back — whatever the edits inside did
 * or left half done (road baking and brush commits change the terrain in place before they record their step).
 */
interface Batch {
  entries: HistoryEntry[];
  /** The document when the batch opened (put back as it is when the batch turns out to have changed nothing). */
  doc: WorldDocument;
  terrain: ReturnType<typeof snapshotLayers>;
  layers: LayerSnapshot;
  objects: Objects;
  roads: RoadNetwork;
  features: Feature[];
  next: number;
  settings: WorldDocument['settings'];
  scenario: WorldDocument['scenario'];
  groups: WorldDocument['groups'];
  meta: WorldDocument['meta'];
}

/**
 * Result of `batch(fn)` (Phase 37). `changed` is false when the batch recorded nothing (no undo step was added).
 * A refused or failed batch leaves the document and the history exactly as they were: `locked` — a simulation runs on
 * the document; `busy` — a brush stroke or an object transaction is open; `error` — `fn` threw (rolled back).
 */
export type BatchResult<T> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; reason: 'locked' | 'busy' | 'error'; error?: unknown };

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
  /** Terrain layer changes (Phase 19), applied before the roads (roads bake on the new natural ground). */
  landscape?: LandscapeEdit;
  /**
   * Phase 20 (blueprint placement), parallel to `add`: the ground pose of each added object is
   * computed on the terrain AFTER this edit's terrain / road changes — `lift` m above the ground
   * (0 = standing on it), heading kept; null = keep the given transform (rigid placement).
   * Without it, objects are created where given and only follow ground they stood on before.
   */
  addSeat?: (number | null)[];
  /**
   * Phase 21: replace the environment settings (wind / water / simulation seed …) and / or the
   * saved scenario (earthquake, flood, experiment plan) in the SAME undo step.
   */
  settings?: WorldDocument['settings'];
  scenario?: WorldDocument['scenario'];
}

export interface MutationOptions {
  /** Record an undo step (default true). Use false for continuous edits (gizmo drags, scrubbing). */
  history?: boolean;
}

export interface WorldState {
  doc: WorldDocument;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Incremented when the whole document is replaced (new/load), so views can reset. */
  docVersion: number;
  /** Vertex rectangle of the last committed terrain change (null = unknown / everything). */
  terrainRect: GridRect | null;
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
  updateSimulationSettings: (patch: { seed?: number; wind?: Partial<WindModelSettings>; water?: Partial<WaterSettings>; interactions?: boolean; vegetation?: Partial<NonNullable<WorldDocument['settings']['simulation']['vegetation']>>; thermal?: Partial<NonNullable<WorldDocument['settings']['simulation']['thermal']>>; fire?: Partial<NonNullable<WorldDocument['settings']['simulation']['fire']>>; humans?: NonNullable<WorldDocument['settings']['simulation']['humans']> | null; physiology?: NonNullable<WorldDocument['settings']['simulation']['physiology']> | null; vehicles?: NonNullable<WorldDocument['settings']['simulation']['vehicles']> | null; structure?: NonNullable<WorldDocument['settings']['simulation']['structure']> | null }) => void;
  /** Name an editing group (Phase 36; '' removes the name). One undo step. */
  setGroupName: (group: string, name: string) => void;
  /**
   * The experiment plan (Phase 15). Phase 36: ONE undo step per edit (placed / moved / deleted
   * disasters, experiment-panel changes) in the same history as the geometry — except while a
   * simulation runs on the document (locked: applied, not recorded) or with `history: false`.
   */
  setExperiment: (patch: Partial<ExperimentSettings>, opts?: MutationOptions) => void;
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
  /**
   * Phase 36: drop the stroke in progress (Esc / pointercancel) — the terrain from before it comes
   * back, no undo step. Returns the restored vertex rectangle (the renderer refreshes it like a dab).
   */
  cancelTerrainStroke: () => GridRect | null;
  /** Height change of the stroke in progress: max raise / lowering (m) and changed area (m²). */
  strokeDelta: () => { up: number; down: number; area: number } | null;
  /** Phase 36: the heights at the start of the open stroke (read-only view of its snapshot; null = no stroke). */
  strokeHeights: () => Float32Array | null;
  applyTerrainPreset: (preset: TerrainPresetId, seed: number) => void;
  setWaterLevel: (level: number | null) => void;
  /** Replace the natural features (one undo step; the terrain is recomposed locally). */
  setFeatures: (features: Feature[], next?: number) => void;
  /** Record the current state as an undo step (call once before a continuous edit). Prefer begin/commitTransaction. */
  checkpoint: () => void;
  /**
   * Continuous object edit (Phase 36): begin → writes with `{ history: false }` → commit (one undo
   * step, none if nothing changed) or cancel (the objects from before come back, no step).
   * Undo / redo are refused while a transaction or a terrain stroke is open.
   */
  beginTransaction: () => void;
  commitTransaction: () => boolean;
  cancelTransaction: () => void;
  /** A terrain stroke, an object transaction or a batch is open (undo / redo would tear it). */
  busy: () => boolean;
  /**
   * Phase 37: run `fn` and record everything it edits — objects, roads, terrain, terrain layers, group names, the
   * scenario (placed disasters) and the settings (car settings …) — as ONE undo step. `fn` is synchronous and calls the
   * ordinary edit functions (`applyEdit`, `setExperiment`, `setGroupName`, `updateSimulationSettings`, terrain
   * strokes, transactions). Nothing changed → no step. `fn` throws → the document is put back as it was (terrain
   * arrays included) and no step is recorded. Refused while the document is locked or a stroke / transaction is open;
   * `undo` / `redo` are refused inside. A batch inside a batch joins the outer one (its exception rolls back the
   * outer batch).
   */
  batch: <T>(fn: () => T) => BatchResult<T>;
  undo: () => void;
  redo: () => void;
}

/** Same plain value (settings, scenario, features, a road network: small JSON-like data). */
const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Same object map: the same ids holding the same object values (a new object that says the same is not a change). */
function sameEntries(a: Objects, b: Objects): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k] && (!b[k] || !sameObjectValue(a[k], b[k]))) return false;
  return true;
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
    // Phase 36: the explicit per-category policy (groundPlacement.ts); lifted objects keep their absolute height.
    const policy = groundFollowOf(o, before);
    if (policy === 'keep') continue;
    // Phase 17 foundation policy 'preserve': keep the world transform, freeze the plinth.
    if (policy === 'preserve') {
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

const seaLevel = (t: TerrainData) => t.settings.waterLevel ?? 0;

/** Seat added objects on the (final) terrain: WorldEdit.addSeat (Phase 20 blueprint placement). */
type Seater = (objects: Objects, terrain: TerrainSampler) => Objects;
function seater(ids: readonly EntityId[], lifts: readonly (number | null)[] | undefined): Seater | undefined {
  if (!lifts?.some((l) => l !== null && l !== undefined)) return undefined;
  return (objects, terrain) => {
    const out = { ...objects };
    ids.forEach((id, k) => {
      const lift = lifts[k];
      const o = out[id];
      if (lift === null || lift === undefined || !o) return;
      const [x, , z] = o.transform.position;
      const pose = groundPose(o, x, z, yawOf(o.transform.rotation), terrain);
      out[id] = {
        ...o,
        transform: { ...o.transform, position: [x, pose.position[1] + lift, z], rotation: lift === 0 && !terrain.flat ? pose.rotation : o.transform.rotation },
      };
    });
    return out;
  };
}

const landEntry = (doc: WorldDocument, patch: LayerPatch | null): LandscapeEntry => ({ features: doc.landscape.features, next: doc.landscape.next, patch });

/** World-space box of a vertex rectangle. */
function rectArea(t: TerrainData, r: GridRect): [number, number, number, number] {
  return [t.originX + r.x0 * t.cellSize, t.originZ + r.z0 * t.cellSize, t.originX + r.x1 * t.cellSize, t.originZ + r.z1 * t.cellSize];
}

/** Sampler over a copy of the layers (the terrain as it was before an edit). */
function samplerOver(t: TerrainData, layers: ReturnType<typeof snapshotLayers>): TerrainSampler {
  return new TerrainSampler({ ...t, heights: layers.heights, ground: layers.ground, soil: layers.soil, settings: layers.settings, revision: -1 });
}

/**
 * The world store's behaviour as a creator (Phase 20): the app's store and headless scratch
 * stores (world templates, built-in blueprints) run the very same edit pipeline — layer
 * composition, road baking, seating, history.
 */
const worldStoreCreator: StateCreator<WorldState> = (set, get) => {
  // Per store (Phase 36): the scratch stores that build templates / built-in blueprints must not
  // share — and clear — the app store's open brush stroke (it was module-level before).
  let stroke: TerrainStroke | null = null;
  let tx: ObjectTransaction | null = null;
  let batch: Batch | null = null;
  /**
   * Record an undo step: the state change that appends it to the history (and clears the redo side) — or, inside a
   * batch (Phase 37), nothing: the step is kept by the batch and the history is written once, when the batch commits.
   */
  const record = (entry: HistoryEntry): { past: HistoryEntry[]; future: HistoryEntry[] } | Record<string, never> => {
    if (batch) {
      batch.entries.push(entry);
      return {};
    }
    return { past: pushHistory(get().past, entry), future: [] };
  };
  /** Shared write path: optionally records history, then replaces objects immutably. */
  const commit = (next: Objects, opts?: MutationOptions) => {
    const { doc, locked } = get();
    if (locked) return;
    if (opts?.history === false) {
      set({ doc: touch(doc, next) });
    } else {
      set({ doc: touch(doc, next), ...record({ objects: doc.objects, terrain: null, roads: doc.roads, landscape: landEntry(doc, null) }) });
    }
  };

  /**
   * Finish a terrain change made in place (brush stroke): the change of the final terrain is
   * folded into the layers — height into the sculpt layer, ground into the paint layer — then
   * the natural terrain is recomposed and the roads re-baked over it. One history entry.
   */
  const commitTerrain = (before: ReturnType<typeof snapshotLayers>, rect: GridRect) => {
    const { doc } = get();
    // (Terrain arrays are edited in place: callers check `locked` before touching them.)
    const t = doc.terrain;
    const land = doc.landscape;
    // Phase 36: before-copies of the layers in the rectangle the commit changes (the stroke grown by the rivers that
    // recompose re-flows), not of the whole map.
    const layerRect = unionRects(rect, expandForRivers(land, t, rect))!;
    const lb = snapshotLandscapeRect(land, t.nx, layerRect);
    for (let iz = rect.z0; iz <= rect.z1; iz++) {
      for (let ix = rect.x0; ix <= rect.x1; ix++) {
        const i = iz * t.nx + ix;
        const dh = t.heights[i] - before.heights[i];
        // (cm steps, like the heights: the layer saves and reloads exactly)
        if (dh !== 0) land.sculpt[i] = Math.round((land.sculpt[i] + dh) * 100) / 100;
        if (t.ground[i] !== before.ground[i]) land.paint[i] = t.ground[i];
      }
    }
    const r = recompose(t, land, doc.roads, rect, seaLevel(t));
    const finalRect = unionRects(rect, r.final)!;
    // (recompose re-flows exactly expandForRivers(rect): the snapshot covers its natural rectangle.)
    finishLayered(doc, before, lb, finalRect, layerRect, r.roads, doc.objects);
  };

  /** Commit after the terrain / layers were changed in place: patches, objects follow, history. */
  const finishLayered = (
    doc: WorldDocument, before: ReturnType<typeof snapshotLayers>, lb: LayerSnapshot | RectLayerSnapshot | null,
    finalRect: GridRect, layerRect: GridRect | null, roads: RoadNetwork, objects: Objects, featuresBefore = doc.landscape.features, nextBefore = doc.landscape.next, seat?: Seater,
  ) => {
    const t = doc.terrain;
    const land = doc.landscape;
    const patch = makePatch(t, before, finalRect);
    const lpatch = lb && layerRect ? ('kind' in lb && lb.kind === 'rect' ? makeLayerPatchFromRect(land, t.nx, lb as RectLayerSnapshot) : makeLayerPatch(land, t.nx, lb as LayerSnapshot, layerRect)) : null;
    const area = rectArea(t, finalRect);
    let out = followTerrain(objects, samplerOver(t, before), samplerFor(t), area);
    if (seat) out = seat(out, samplerFor(t));
    set({
      doc: { ...touch(doc, out), terrain: { ...t }, roads, landscape: { ...land } },
      terrainRect: finalRect,
      ...record({ objects: doc.objects, terrain: patch, roads: doc.roads, landscape: { features: featuresBefore, next: nextBefore, patch: lpatch } }),
    });
  };

  /** Undo/redo: swap objects + roads, and apply the terrain side of the patch if there is one. */
  const travel = (entry: HistoryEntry, side: 'before' | 'after'): WorldDocument => {
    const doc = get().doc;
    const l = entry.landscape;
    if (l.patch) applyLayerPatch(doc.landscape, doc.terrain.nx, l.patch, side);
    const landscape = { ...doc.landscape, features: l.features, next: l.next };
    const config: Partial<WorldDocument> = {};
    if (entry.config?.settings) config.settings = entry.config.settings;
    if (entry.config?.scenario) config.scenario = entry.config.scenario;
    if (entry.groupNames) config.groups = entry.groupNames.value;
    if (!entry.terrain) return { ...touch(doc, entry.objects), roads: entry.roads, landscape, ...config };
    applyPatch(doc.terrain, entry.terrain, side);
    return { ...touch(doc, entry.objects), terrain: { ...doc.terrain }, roads: entry.roads, landscape, ...config };
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
    const res = bakeRegion(t, prev, next, rect, naturalProvider(doc.landscape));
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

  /**
   * Landscape edit (+ optional roads) as ONE atomic step: layers first, then the roads bake on
   * the new natural terrain, objects follow. On any error every array is restored and the
   * error is re-thrown — no half-changed terrain.
   */
  const applyLandscapeEdit = (objects: Objects, e: LandscapeEdit, nextRoads?: RoadNetwork, seat?: Seater) => {
    const { doc } = get();
    const t = doc.terrain;
    const land = doc.landscape;
    const before = snapshotLayers(t);
    const lb = snapshotLandscape(land, e.base ? ['baseHeights', 'baseGround', 'sculpt', 'paint', 'naturalHeights', 'naturalGround', 'naturalCulvert', 'naturalRoadBase'] : undefined);
    const featuresBefore = land.features, nextBefore = land.next;
    try {
      let rect: GridRect | null = null;
      if (e.base) {
        land.base.heights.set(e.base.heights);
        land.base.ground.set(e.base.ground);
        land.sculpt.fill(0);
        land.paint.fill(NO_PAINT);
        if (e.base.soil) t.soil.set(e.base.soil);
        if (e.base.settings) t.settings = { ...e.base.settings };
        rect = fullGridRect(t);
      }
      if (e.layers) {
        const { rect: r, sculpt, paint } = e.layers;
        const w = r.x1 - r.x0 + 1;
        for (let iz = r.z0; iz <= r.z1; iz++) for (let ix = r.x0; ix <= r.x1; ix++) {
          const i = iz * t.nx + ix, k = (iz - r.z0) * w + (ix - r.x0);
          if (sculpt && sculpt[k] !== 0) land.sculpt[i] = Math.round((land.sculpt[i] + sculpt[k]) * 100) / 100;
          if (paint && paint[k] !== NO_PAINT) land.paint[i] = paint[k];
          if (e.layers.soil && e.layers.soil[k] !== NO_PAINT) t.soil[i] = e.layers.soil[k];
        }
        rect = unionRects(rect, r);
      }
      if (e.features) {
        rect = unionRects(rect, featureChangeRect(land, t, land.features, e.features));
        land.features = e.features;
      }
      if (e.next !== undefined) land.next = Math.max(land.next, e.next);
      let roads = doc.roads;
      let finalRect: GridRect | null = null, layerRect: GridRect | null = null;
      if (rect) {
        const r = recompose(t, land, roads, rect, seaLevel(t));
        roads = r.roads;
        finalRect = r.final;
        layerRect = r.natural;
      }
      let out = objects;
      if (nextRoads && nextRoads !== doc.roads) {
        assertValid(nextRoads);
        const rr = dirtyRect(t, roads, nextRoads);
        if (rr) {
          const res = bakeRegion(t, roads, nextRoads, rr, naturalProvider(land));
          finalRect = unionRects(finalRect, rr);
          out = followRoads(out, roads, { ...nextRoads, underlay: res.underlay }, samplerOver(t, before), samplerFor(t));
          roads = { ...nextRoads, underlay: res.underlay };
        } else roads = { ...nextRoads, underlay: roads.underlay };
      }
      finishLayered(doc, before, lb, finalRect ?? { x0: 0, z0: 0, x1: 0, z1: 0 }, layerRect, roads, out, featuresBefore, nextBefore, seat);
    } catch (err) {
      // Roll back every array touched so far.
      t.heights.set(before.heights);
      t.ground.set(before.ground);
      t.soil.set(before.soil);
      t.settings = before.settings;
      for (const [k, v] of Object.entries(lb) as [string, Float32Array | Uint8Array][]) {
        const dst = k === 'baseHeights' ? land.base.heights : k === 'baseGround' ? land.base.ground : k === 'sculpt' ? land.sculpt : k === 'paint' ? land.paint : k === 'naturalHeights' ? land.natural.heights : k === 'naturalGround' ? land.natural.ground : k === 'naturalCulvert' ? land.natural.culvert : land.natural.roadBase;
        dst.set(v);
      }
      land.features = featuresBefore;
      land.next = nextBefore;
      t.revision++;
      throw err;
    }
  };

  /** The geometric part of an atomic edit (objects, roads, terrain layers) — see applyEdit. */
  const applyGeometry = (edit: WorldEdit, opts?: MutationOptions): EntityId[] => {
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
        // Phase 36: an object edit that moves a road-linked object re-measures its link (road edits move linked
        // objects themselves, through followRoads, and are left alone here).
        objects[o.id] = edit.roads ? o : relinkMoved(objects[o.id], o, get().doc.roads);
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
      const seat = seater(ids, edit.addSeat);
      if (edit.landscape) {
        applyLandscapeEdit(objects, edit.landscape, edit.roads, seat);
        return ids;
      }
      if (edit.roads && edit.roads !== get().doc.roads) {
        const doc = get().doc;
        const r = bakeRoads(doc, objects, edit.roads);
        if (seat) r.objects = seat(r.objects, samplerFor(doc.terrain));
        const entry: HistoryEntry = { objects: doc.objects, terrain: r.patch, roads: doc.roads, landscape: landEntry(doc, null) };
        set({
          terrainRect: r.patch?.rect ?? null,
          doc: { ...touch(doc, r.objects), terrain: r.patch ? { ...doc.terrain } : doc.terrain, roads: r.roads },
          // Always an undo step: the terrain patch and the network must travel together
          // (road tools preview drags without committing and commit once on release).
          ...record(entry),
        });
        return ids;
      }
      if (changed) commit(seat ? seat(objects, samplerFor(get().doc.terrain)) : objects, opts);
      return ids;
      };

  /**
   * Close a batch (Phase 37): compare the document with the one the batch opened on and record ONE history entry of
   * what changed — objects / roads / features (by content, not by reference: an edit that rebuilt the same values is
   * not a change), the terrain and the layers over the smallest rectangle that really differs, and the settings / the
   * scenario / the group names only when they changed. Parts that did not change get their old references back.
   * Returns false when nothing changed (no step; the document is the one from before, reference for reference).
   */
  const commitBatch = (b: Batch): boolean => {
    const doc = get().doc;
    const t = doc.terrain;
    const land = doc.landscape;
    // Terrain arrays change only through edits that record a step: without one there is nothing to compare.
    const touched = b.entries.some((e) => e.terrain || e.landscape.patch);
    const rect = touched ? changedRect(t, b.terrain) : null;
    const terrainSettings = touched && !sameValue(t.settings, b.terrain.settings);
    // (settings-only terrain steps carry a one-vertex patch, like setWaterLevel outside a batch)
    const terrain = rect || terrainSettings ? makePatch(t, b.terrain, rect ?? { x0: 0, z0: 0, x1: 0, z1: 0 }) : null;
    const patch = touched ? diffLayerPatch(land, t.nx, b.layers) : null;
    const objects = sameEntries(doc.objects, b.objects) ? b.objects : doc.objects;
    const roads = doc.roads === b.roads || (!terrain && sameValue({ ...doc.roads, underlay: 0 }, { ...b.roads, underlay: 0 })) ? b.roads : doc.roads;
    const features = land.features === b.features || sameValue(land.features, b.features) ? b.features : land.features;
    const next = features === b.features ? b.next : land.next;
    const settings = doc.settings === b.settings || sameValue(doc.settings, b.settings) ? b.settings : doc.settings;
    const scenario = doc.scenario === b.scenario || sameValue(doc.scenario, b.scenario) ? b.scenario : doc.scenario;
    const groups = doc.groups === b.groups || sameValue(doc.groups ?? null, b.groups ?? null) ? b.groups : doc.groups;
    const changed = !!terrain || !!patch || objects !== b.objects || roads !== b.roads || features !== b.features || settings !== b.settings || scenario !== b.scenario || groups !== b.groups;
    const out: WorldDocument = { ...doc, objects, roads, settings, scenario, meta: changed ? doc.meta : b.meta, landscape: features === land.features && next === land.next ? land : { ...land, features, next } };
    if (groups) out.groups = groups;
    else delete out.groups;
    if (!changed) {
      // Nothing changed: the very document from before (same references — nothing for a view or the autosave to redo).
      if (doc !== b.doc) set({ doc: b.doc });
      return false;
    }
    const entry: HistoryEntry = { objects: b.objects, terrain, roads: b.roads, landscape: { features: b.features, next: b.next, patch } };
    if (settings !== b.settings || scenario !== b.scenario) entry.config = { ...(settings !== b.settings ? { settings: b.settings } : {}), ...(scenario !== b.scenario ? { scenario: b.scenario } : {}) };
    if (groups !== b.groups) entry.groupNames = { value: b.groups };
    // The terrain view refreshes `terrainRect` only: one rectangle for everything the batch changed.
    set({ doc: out, past: pushHistory(get().past, entry), future: [], ...(terrain ? { terrainRect: terrain.rect } : {}) });
    return true;
  };

  /**
   * Put the document back as it was when the batch opened: the terrain and layer arrays are copied back in place
   * (whatever was written to them, recorded or not), everything else returns by reference. No history is touched.
   */
  const rollbackBatch = (b: Batch) => {
    stroke = null;
    tx = null;
    const doc = get().doc;
    const t = doc.terrain;
    const land = doc.landscape;
    const rect = changedRect(t, b.terrain);
    const dirty = rect !== null || !sameValue(t.settings, b.terrain.settings);
    if (dirty) restoreLayers(t, b.terrain);
    restoreLandscape(land, b.layers);
    const next: WorldDocument = {
      ...doc, objects: b.objects, roads: b.roads, settings: b.settings, scenario: b.scenario, meta: b.meta,
      terrain: dirty ? { ...t } : doc.terrain,
      landscape: { ...land, features: b.features, next: b.next },
    };
    if (b.groups) next.groups = b.groups;
    else delete next.groups;
    set({ doc: next, ...(rect ? { terrainRect: rect } : {}) });
  };

  const patchObject = (id: EntityId, fn: (o: WorldObject) => WorldObject, opts?: MutationOptions) => {
    const objects = get().doc.objects;
    const obj = objects[id];
    if (!obj) return;
    commit({ ...objects, [id]: relinkMoved(obj, fn(obj), get().doc.roads) }, opts);
  };

  return {
    doc: createEmptyDocument(),
    past: [],
    future: [],
    docVersion: 0,
    terrainRect: null,

    locked: false,
    setLocked: (locked) => set({ locked }),

    addObject: (input) => get().addObjects([input])[0],

    addObjects: (inputs) => get().applyEdit({ add: inputs }),

    applyEdit: (edit, opts) => {
      if (get().locked) return [];
      if (!edit.settings && !edit.scenario) return applyGeometry(edit, opts);
      // Configuration travels in the same undo step as the geometry (Phase 21).
      const before = get().doc;
      const lastBefore = get().past[get().past.length - 1];
      const ids = applyGeometry(edit, opts);
      const d = get().doc;
      const doc: WorldDocument = { ...d, settings: edit.settings ? structuredClone(edit.settings) : d.settings, scenario: edit.scenario ? structuredClone(edit.scenario) : d.scenario };
      // Inside a batch the settings / scenario from before it are restored by the batch's one step.
      if (batch) {
        set({ doc });
        return ids;
      }
      const config = { ...(edit.settings ? { settings: before.settings } : {}), ...(edit.scenario ? { scenario: before.scenario } : {}) };
      const past = get().past;
      const last = past[past.length - 1];
      const nextPast = last && last !== lastBefore
        ? [...past.slice(0, -1), { ...last, config }]
        : pushHistory(past, { objects: d.objects, terrain: null, roads: d.roads, landscape: landEntry(d, null), config });
      set({ doc, past: nextPast, future: [] });
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
      // Phase 36: the copy is not locked (it is meant to be moved) and its road link is measured where it is.
      delete copy.locked;
      const next = { ...objects, [copy.id]: relinkMoved(src, copy, get().doc.roads) };
      // A car's own simulation settings (drive, controls, autopilot) go with the copy, in the same undo step; occupants
      // do not (a person cannot sit in two cars).
      const doc0 = get().doc;
      const car = doc0.settings.simulation.vehicles?.cars?.[src.id];
      if (car && !get().locked) {
        const { occupants: _o, ...rest } = structuredClone(car);
        void _o;
        const vehicles = { ...doc0.settings.simulation.vehicles!, cars: { ...doc0.settings.simulation.vehicles!.cars, [copy.id]: rest } };
        const settings = { ...doc0.settings, simulation: { ...doc0.settings.simulation, vehicles } };
        const entry: HistoryEntry = { objects: doc0.objects, terrain: null, roads: doc0.roads, landscape: landEntry(doc0, null), config: { settings: doc0.settings } };
        set({ doc: { ...touch(doc0, next), settings }, ...record(entry) });
        return copy.id;
      }
      commit(next);
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
              ...(patch.thermal || cur.thermal ? { thermal: { ...defaultThermalSettings(), ...(cur.thermal ?? {}), ...(patch.thermal ?? {}) } } : {}),
              ...(patch.fire || cur.fire ? { fire: { ...defaultFireSettings(), ...(cur.fire ?? {}), ...(patch.fire ?? {}) } } : {}),
              ...(patch.vegetation || cur.vegetation ? { vegetation: { canopyShelter: false, floodResponse: false, ...(cur.vegetation ?? {}), ...(patch.vegetation ?? {}) } } : {}),
              // Phase 33: extended human model (null in the patch switches it off; kept when other settings change).
              ...(patch.humans !== undefined ? (patch.humans ? { humans: patch.humans } : {}) : cur.humans ? { humans: cur.humans } : {}),
              // Phase 34: physiology (null switches it off; needs the extended human model — dropped with it).
              ...((patch.humans !== undefined ? patch.humans : cur.humans) ? (patch.physiology !== undefined ? (patch.physiology ? { physiology: patch.physiology } : {}) : cur.physiology ? { physiology: cur.physiology } : {}) : {}),
              // Phase 35: vehicle dynamics (null switches it off).
              ...(patch.vehicles !== undefined ? (patch.vehicles ? { vehicles: patch.vehicles } : {}) : cur.vehicles ? { vehicles: cur.vehicles } : {}),
              // Phase 35.5: structural behaviour v2 (null switches back to the Phase 25 behaviour).
              ...(patch.structure !== undefined ? (patch.structure ? { structure: patch.structure } : {}) : cur.structure ? { structure: cur.structure } : {}),
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

    setGroupName: (group, name) => {
      const { doc, locked } = get();
      if (locked) return;
      const clean = name.trim().slice(0, 80);
      const cur = doc.groups?.[group]?.name ?? '';
      if (clean === cur) return;
      const groups = { ...(doc.groups ?? {}) };
      if (clean) groups[group] = { name: clean };
      else delete groups[group];
      const entry: HistoryEntry = { objects: doc.objects, terrain: null, roads: doc.roads, landscape: landEntry(doc, null), groupNames: { value: doc.groups } };
      const next: WorldDocument = { ...doc, meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
      if (Object.keys(groups).length) next.groups = groups;
      else delete next.groups;
      set({ doc: next, ...record(entry) });
    },

    setExperiment: (patch, opts) => {
      const { doc, locked } = get();
      const experiment = { ...(doc.scenario.experiment ?? defaultExperiment()), ...structuredClone(patch) };
      const next = { ...doc, scenario: { ...doc.scenario, experiment }, meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
      if (locked || opts?.history === false) {
        set({ doc: next });
        return;
      }
      const entry: HistoryEntry = { objects: doc.objects, terrain: null, roads: doc.roads, landscape: landEntry(doc, null), config: { scenario: doc.scenario } };
      set({ doc: next, ...record(entry) });
    },

    setFloodScenario: (patch) => {
      const doc = get().doc;
      const flood = { ...(doc.scenario.flood ?? defaultFloodScenario()), ...structuredClone(patch) };
      set({ doc: { ...doc, scenario: { ...doc.scenario, flood }, meta: { ...doc.meta, updatedAt: new Date().toISOString() } } });
    },

    replaceDocument: (doc) => {
      if (get().locked) return;
      if (batch) throw new Error('The document cannot be replaced inside a batch');
      stroke = null;
      tx = null;
      // Layers must compose to the terrain (documents built by older code paths may not).
      const landscape = adoptTerrain(doc.terrain, doc.roads, doc.landscape);
      if (landscape !== doc.landscape) doc = { ...doc, landscape };
      set({ doc, past: [], future: [], docVersion: get().docVersion + 1, terrainRect: null });
    },

    newDocument: () => {
      if (get().locked) return;
      if (batch) throw new Error('The document cannot be replaced inside a batch');
      stroke = null;
      tx = null;
      set({ doc: createEmptyDocument(), past: [], future: [], docVersion: get().docVersion + 1, terrainRect: null });
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

    strokeDelta: () => {
      const s = stroke;
      if (!s?.rect) return null;
      const t = get().doc.terrain;
      let up = 0, down = 0, n = 0;
      const r = s.rect;
      for (let iz = r.z0; iz <= r.z1; iz++) for (let ix = r.x0; ix <= r.x1; ix++) {
        const i = iz * t.nx + ix;
        const d = t.heights[i] - s.before.heights[i];
        if (d > up) up = d;
        if (d < down) down = d;
        if (d !== 0 || t.ground[i] !== s.before.ground[i]) n++;
      }
      return { up, down, area: n * t.cellSize * t.cellSize };
    },

    strokeHeights: () => stroke?.before.heights ?? null,

    endTerrainStroke: () => {
      const s = stroke;
      stroke = null;
      if (s?.rect) commitTerrain(s.before, s.rect);
    },

    cancelTerrainStroke: () => {
      const s = stroke;
      stroke = null;
      if (!s?.rect) return null;
      // The dabs edited the final terrain in place; nothing reached the layers yet — copy the
      // touched rectangle back from the stroke's snapshot.
      const t = get().doc.terrain;
      const r = s.rect;
      for (let iz = r.z0; iz <= r.z1; iz++) {
        const a = iz * t.nx + r.x0, b = iz * t.nx + r.x1 + 1;
        t.heights.set(s.before.heights.subarray(a, b), a);
        t.ground.set(s.before.ground.subarray(a, b), a);
        t.soil.set(s.before.soil.subarray(a, b), a);
      }
      t.revision++;
      return r;
    },

    applyTerrainPreset: (preset, seed) => {
      if (get().locked) return;
      // A preset is a new BASE terrain: sculpt and paint are cleared, natural features stay.
      const next = generateTerrain(preset, seed, get().doc.terrain);
      applyLandscapeEdit(get().doc.objects, { base: { heights: next.heights, ground: next.ground, soil: next.soil, settings: next.settings } });
    },

    setWaterLevel: (level) => {
      if (get().locked) return;
      const { doc } = get();
      const t = doc.terrain;
      const before = snapshotLayers(t);
      t.settings = { ...t.settings, waterLevel: level };
      t.revision++;
      // Coastlines are shaped from the sea level: recompose the map; otherwise settings only
      // (a 1-vertex patch still carries the settings before / after for undo).
      if (doc.landscape.features.some((f) => f.kind === 'coast')) {
        const lb = snapshotLandscape(doc.landscape);
        const r = recompose(t, doc.landscape, doc.roads, fullGridRect(t), seaLevel(t));
        finishLayered(doc, before, lb, r.final, r.natural, r.roads, doc.objects);
      } else finishLayered(doc, before, null, { x0: 0, z0: 0, x1: 0, z1: 0 }, null, doc.roads, doc.objects);
    },

    checkpoint: () => {
      const { doc, locked } = get();
      if (locked) return;
      set(record({ objects: doc.objects, terrain: null, roads: doc.roads, landscape: landEntry(doc, null) }));
    },

    beginTransaction: () => {
      const { doc, locked, docVersion } = get();
      if (locked) return;
      tx = { objects: doc.objects, docVersion };
    },

    commitTransaction: () => {
      const t0 = tx;
      tx = null;
      const { doc, locked, docVersion } = get();
      if (!t0 || locked || t0.docVersion !== docVersion) return false;
      if (doc.objects === t0.objects) return false;
      // The step restores the objects from before the gesture (object transactions edit nothing else).
      set(record({ objects: t0.objects, terrain: null, roads: doc.roads, landscape: landEntry(doc, null) }));
      return true;
    },

    cancelTransaction: () => {
      const t0 = tx;
      tx = null;
      const { doc, locked, docVersion } = get();
      if (!t0 || locked || t0.docVersion !== docVersion) return;
      if (doc.objects === t0.objects) return;
      set({ doc: touch(doc, t0.objects) });
    },

    busy: () => stroke !== null || tx !== null || batch !== null,

    batch: <T,>(fn: () => T): BatchResult<T> => {
      // Joins the open batch; an exception goes up to it (and rolls the whole batch back).
      if (batch) return { ok: true, value: fn(), changed: true };
      if (get().locked) return { ok: false, reason: 'locked' };
      if (stroke || tx) return { ok: false, reason: 'busy' };
      const d0 = get().doc;
      const b: Batch = {
        entries: [], doc: d0, terrain: snapshotLayers(d0.terrain), layers: snapshotLandscape(d0.landscape, [...ALL_LAYERS]),
        objects: d0.objects, roads: d0.roads, features: d0.landscape.features, next: d0.landscape.next,
        settings: d0.settings, scenario: d0.scenario, groups: d0.groups, meta: d0.meta,
      };
      batch = b;
      let value: T;
      try {
        value = fn();
        if (stroke) throw new Error('A terrain stroke was left open inside a batch');
        if (tx) throw new Error('An object transaction was left open inside a batch');
      } catch (error) {
        batch = null;
        rollbackBatch(b);
        return { ok: false, reason: 'error', error };
      }
      batch = null;
      let changed: boolean;
      try {
        changed = commitBatch(b);
      } catch (error) {
        rollbackBatch(b);
        return { ok: false, reason: 'error', error };
      }
      return { ok: true, value, changed };
    },

    setFeatures: (features, next) => {
      if (get().locked) return;
      get().applyEdit({ landscape: { features, next } });
    },

    undo: () => {
      const { doc, past, future, locked } = get();
      const prev = past[past.length - 1];
      if (!prev || stroke || tx || batch || locked) return;
      const current: HistoryEntry = { objects: doc.objects, terrain: prev.terrain, roads: doc.roads, landscape: { features: doc.landscape.features, next: doc.landscape.next, patch: prev.landscape.patch } };
      if (prev.config) current.config = { ...(prev.config.settings ? { settings: doc.settings } : {}), ...(prev.config.scenario ? { scenario: doc.scenario } : {}) };
      if (prev.groupNames) current.groupNames = { value: doc.groups };
      set({ doc: travel(prev, 'before'), past: past.slice(0, -1), future: [current, ...future], terrainRect: prev.terrain?.rect ?? null });
    },

    redo: () => {
      const { doc, past, future, locked } = get();
      const next = future[0];
      if (!next || stroke || tx || batch || locked) return;
      const current: HistoryEntry = { objects: doc.objects, terrain: next.terrain, roads: doc.roads, landscape: { features: doc.landscape.features, next: doc.landscape.next, patch: next.landscape.patch } };
      if (next.config) current.config = { ...(next.config.settings ? { settings: doc.settings } : {}), ...(next.config.scenario ? { scenario: doc.scenario } : {}) };
      if (next.groupNames) current.groupNames = { value: doc.groups };
      set({ doc: travel(next, 'after'), past: [...past, current], future: future.slice(1), terrainRect: next.terrain?.rect ?? null });
    },
  };
};

export const useWorldStore = create<WorldState>(worldStoreCreator);

/** A separate, headless world store (never the app's): build documents with the full edit pipeline. */
export function scratchWorld(doc?: WorldDocument) {
  const store = createStore<WorldState>(worldStoreCreator);
  if (doc) store.getState().replaceDocument(doc);
  return store;
}

/** Convenience selectors */
export const selectObjectList = (s: WorldState) => s.doc.objects;
