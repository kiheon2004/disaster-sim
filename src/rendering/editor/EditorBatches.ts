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

  constructor(private terrain: TerrainSampler) {
    this.root.name = 'editor-batches';
  }

  /** New terrain: every chunk is rebuilt on the next sync (foundation plinths depend on it). */
  setTerrain(t: TerrainSampler) {
    if (t === this.terrain) return;
    this.terrain = t;
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
    if (chunk.built.size !== m.length) return true;
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
