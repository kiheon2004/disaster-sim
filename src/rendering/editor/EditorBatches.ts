/**
 * Edit-mode instanced rendering (Phase 16): the world document drawn through the same
 * SimRenderAdapter batches the simulation uses (Phase 11), instead of one React component and
 * one mesh per object part. Draw calls no longer grow with the object count, and bulk edits
 * do not mount hundreds of components.
 *
 * Objects are split into a few chunks (by a stable hash of their id); an edit rebuilds only
 * the chunks whose objects changed. Objects being edited (the selection) are hidden in their
 * chunk and drawn by the editor separately — so dragging a gizmo never rebuilds batches.
 *
 * No React here.
 */
import * as THREE from 'three';
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { hashString, quatFromEuler } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import type { RuntimeEntity, SimulationRuntime } from '@/simulation/SimulationRuntime';
import { DamageState } from '@/simulation/damage/DamageState';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { SimRenderAdapter } from '../sim/SimRenderAdapter';

/** Read-only runtime view of a static world object (what the adapter reads). */
export function staticEntity(o: WorldObject): RuntimeEntity {
  const def = getDefinition(o.type);
  const d = def.getDimensions(o.params);
  const k = o.transform.scale;
  const pose = { position: [...o.transform.position] as [number, number, number], quaternion: quatFromEuler(o.transform.rotation) };
  return {
    id: o.id,
    source: o,
    def,
    profile: def.physicsProfile,
    body: null,
    dynamic: false,
    pose,
    initialPose: pose,
    dims: [d[0] * k[0], d[1] * k[1], d[2] * k[2]],
    components: o.components.map((spec) => ({ spec, state: DamageState.NORMAL, health: 1, condition: 'intact' as const, loadRatio: 0 })),
    visual: { swayAngle: 0, swayAxis: [0, 0, 0], brace: 0, foliageLoss: 0, swayVel: 0 },
    flags: {},
    rev: 0,
  } as unknown as RuntimeEntity;
}

export function staticRuntime(objs: Iterable<WorldObject>): SimulationRuntime {
  const entities = new Map<EntityId, RuntimeEntity>();
  for (const o of objs) if (o.type !== 'road') entities.set(o.id, staticEntity(o));
  return { entities } as unknown as SimulationRuntime;
}

/** Objects per chunk the chunk count aims for (rebuild cost vs. draw calls). */
const CHUNK_TARGET = 300;
const MAX_CHUNKS = 8;

export function chunkCountFor(n: number): number {
  let c = 1;
  while (c < MAX_CHUNKS && n / c > CHUNK_TARGET) c *= 2;
  return c;
}

interface Chunk {
  adapter: SimRenderAdapter;
  /** Object references the chunk was built from (identity = unchanged). */
  built: Map<EntityId, WorldObject>;
  /** Phase 36: the terrain under one of its buildings changed (its foundation plinth must be rebuilt). */
  dirty?: boolean;
}

/** World box of the vertices whose height differs from `prev` (null = none). */
function changedBox(t: TerrainSampler['data'], prev: Float32Array): [number, number, number, number] | null {
  const h = t.heights;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] === prev[i]) continue;
    const ix = i % t.nx, iz = (i - ix) / t.nx;
    const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return Number.isFinite(x0) ? [x0, z0, x1, z1] : null;
}

/** A building of the chunk whose footprint (+ a cell of the plinth scan) reaches into the box. */
function buildingIn(chunk: Chunk, box: [number, number, number, number], cell: number): boolean {
  for (const o of chunk.built.values()) {
    if (o.type !== 'building') continue;
    const d = getDefinition(o.type).getDimensions(o.params), k = o.transform.scale;
    const r = Math.hypot(d[0] * k[0], d[2] * k[2]) / 2 + cell;
    const [x, , z] = o.transform.position;
    if (x + r >= box[0] && x - r <= box[2] && z + r >= box[1] && z - r <= box[3]) return true;
  }
  return false;
}

export interface EditorBatchStats {
  chunks: number;
  rebuilds: number;
  lastRebuildMs: number;
  instances: number;
}

const tmpCam = new THREE.PerspectiveCamera();

export class EditorBatches {
  readonly root = new THREE.Group();
  private chunks: (Chunk | null)[] = [];
  private hidden = new Set<EntityId>();
  stats: EditorBatchStats = { chunks: 0, rebuilds: 0, lastRebuildMs: 0, instances: 0 };

  /** Phase 36: heights / grid / flatness at the last terrain the batches were built on. */
  private heights: Float32Array;
  private shape: string;
  private flat: boolean;

  constructor(private terrain: TerrainSampler) {
    this.root.name = 'editor-batches';
    this.heights = terrain.data.heights.slice();
    this.shape = EditorBatches.shapeOf(terrain);
    this.flat = terrain.flat;
  }

  private static shapeOf(t: TerrainSampler) {
    const d = t.data;
    return `${d.nx},${d.nz},${d.originX},${d.originZ},${d.cellSize}`;
  }

  /**
   * New terrain. Only foundation plinths depend on it (SimRenderAdapter), so Phase 36 rebuilds only the chunks with a
   * building over the heights that changed (every chunk before: a brush stroke rebuilt the whole world's batches); a
   * new grid or a flat ↔ relief change still rebuilds everything. Moved objects are new objects: their chunks rebuild
   * through `sync` anyway.
   */
  setTerrain(t: TerrainSampler) {
    if (t === this.terrain) return;
    this.terrain = t;
    const shape = EditorBatches.shapeOf(t);
    const same = shape === this.shape && t.flat === this.flat && this.heights.length === t.data.heights.length;
    const box = same ? changedBox(t.data, this.heights) : null;
    if (same) this.heights.set(t.data.heights);
    else this.heights = t.data.heights.slice();
    this.shape = shape;
    this.flat = t.flat;
    if (!same) {
      this.disposeChunks();
      return;
    }
    if (box) for (const c of this.chunks) if (c && buildingIn(c, box, t.data.cellSize)) c.dirty = true;
  }

  /** Rebuild every chunk on the next sync (the pre-Phase-36 terrain behaviour; benchmarks). */
  invalidateAll() {
    this.disposeChunks();
  }

  /**
   * Bring the batches up to date with `objects`, hiding the ids in `hide`. A chunk is rebuilt
   * when objects were added to / removed from it, or a visible member changed; changes to
   * hidden members are picked up when they become visible again.
   */
  sync(objects: Readonly<Record<EntityId, WorldObject>>, hide: ReadonlySet<EntityId>, camera?: THREE.Camera) {
    const list = Object.values(objects).filter((o) => o.type !== 'road');
    const n = chunkCountFor(list.length);
    if (n !== this.chunks.length) {
      this.disposeChunks();
      this.chunks = new Array(n).fill(null);
    }
    const members: WorldObject[][] = Array.from({ length: n }, () => []);
    for (const o of list) members[hashString(o.id) % n].push(o);
    let instances = 0;
    for (let c = 0; c < n; c++) {
      const chunk = this.chunks[c];
      const m = members[c];
      if (!chunk || this.stale(chunk, m, hide)) this.rebuild(c, m, hide, camera);
      else this.applyHidden(chunk, hide);
      instances += m.length;
    }
    this.hidden = new Set(hide);
    this.stats.chunks = n;
    this.stats.instances = instances;
  }

  private stale(chunk: Chunk, m: WorldObject[], hide: ReadonlySet<EntityId>): boolean {
    if (chunk.dirty || chunk.built.size !== m.length) return true;
    for (const o of m) {
      const b = chunk.built.get(o.id);
      if (!b) return true;
      if (b !== o && !hide.has(o.id)) return true;
    }
    return false;
  }

  private rebuild(c: number, m: WorldObject[], hide: ReadonlySet<EntityId>, camera?: THREE.Camera) {
    const t0 = performance.now();
    const old = this.chunks[c];
    if (old) {
      this.root.remove(old.adapter.root);
      old.adapter.dispose();
    }
    const adapter = new SimRenderAdapter(staticRuntime(m), this.terrain);
    adapter.root.name = `editor-chunk-${c}`;
    // One full update writes every static transform; afterwards only LOD changes per frame.
    adapter.update(camera ?? tmpCam, 0, 0);
    adapter.cullEmpty();
    const chunk: Chunk = { adapter, built: new Map(m.map((o) => [o.id, o])) };
    for (const o of m) if (hide.has(o.id)) adapter.setHidden(o.id, true);
    this.chunks[c] = chunk;
    this.root.add(adapter.root);
    this.stats.rebuilds++;
    this.stats.lastRebuildMs = performance.now() - t0;
  }

  private applyHidden(chunk: Chunk, hide: ReadonlySet<EntityId>) {
    for (const id of this.hidden) if (!hide.has(id) && chunk.built.has(id)) chunk.adapter.setHidden(id, false);
    for (const id of hide) if (chunk.built.has(id)) chunk.adapter.setHidden(id, true);
  }

  updateLod(camera: THREE.Camera) {
    for (const c of this.chunks) c?.adapter.updateLodOnly(camera);
  }

  /** Entity id under a picked batch instance. */
  pick(object: THREE.Object3D, id: number | undefined): EntityId | null {
    for (const c of this.chunks) {
      const hit = c?.adapter.pick(object, id);
      if (hit) return hit;
    }
    return null;
  }

  private disposeChunks() {
    for (const c of this.chunks) {
      if (!c) continue;
      this.root.remove(c.adapter.root);
      c.adapter.dispose();
    }
    this.chunks = [];
  }

  dispose() {
    this.disposeChunks();
    this.root.clear();
  }
}
