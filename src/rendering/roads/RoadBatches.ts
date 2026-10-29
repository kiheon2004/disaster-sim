/**
 * Batched road rendering (Phase 18). The network is cut into CHUNK × CHUNK m chunks; each chunk
 * draws its road pieces as at most three merged meshes (surface, markings, sidewalks/curbs),
 * so the draw-call count depends on the area covered by roads, never on the segment count.
 *
 * Updates are dirty-tracked per chunk: a chunk is rebuilt only when one of its pieces changed
 * (segment / node / trim signature) or the terrain under it changed (height comparison of the
 * bounds of each piece against the last build — follow roads and graded profiles depend on it).
 */
import * as THREE from 'three';
import type { TerrainData } from '@/core/model';
import { samplerFor } from '@/terrain/TerrainSampler';
import { intersectionsOf } from '@/roads/intersections';
import { intersectionPiece, segmentPiece, type MeshData, type RoadPiece } from '@/roads/mesh';
import { segmentLine } from '@/roads/network';
import { segmentBounds } from '@/roads/bake';
import { roadStats } from '@/roads/stats';
import type { RoadNetwork } from '@/roads/types';

export const CHUNK = 50;

type Layer = 'surface' | 'marking' | 'walk';
const LAYERS: Layer[] = ['surface', 'marking', 'walk'];

interface ChunkState {
  key: string;
  /** Piece signatures of the last build. */
  sigs: Map<string, string>;
  meshes: Partial<Record<Layer, THREE.Mesh>>;
}

function materials() {
  const common = { vertexColors: true, roughness: 0.92, metalness: 0 } as const;
  return {
    surface: new THREE.MeshStandardMaterial({ ...common, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    marking: new THREE.MeshStandardMaterial({ ...common, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    walk: new THREE.MeshStandardMaterial({ ...common, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
  } satisfies Record<Layer, THREE.Material>;
}

const chunkKey = (x: number, z: number) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;

function merge(parts: MeshData[]): THREE.BufferGeometry | null {
  let n = 0;
  for (const p of parts) n += p.pos.length;
  if (!n) return null;
  const pos = new Float32Array(n), nrm = new Float32Array(n), col = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    pos.set(p.pos, o);
    nrm.set(p.nrm, o);
    col.set(p.col, o);
    o += p.pos.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

export class RoadBatches {
  readonly root = new THREE.Group();
  private mats = materials();
  private chunks = new Map<string, ChunkState>();
  /** Terrain heights at the last build (per chunk comparisons). */
  private heights: Float32Array | null = null;
  private terrainShape = '';
  drawCalls = 0;
  triangles = 0;

  constructor() {
    this.root.name = 'roads';
  }

  /** Bring the meshes up to date with a network on a terrain (the terrain already baked). */
  sync(n: RoadNetwork, t: TerrainData) {
    const t0 = performance.now();
    // Piece signatures (geometry inputs except the terrain) grouped by chunk.
    const ints = intersectionsOf(n);
    const want = new Map<string, Map<string, string>>();
    const bounds = new Map<string, [number, number, number, number][]>();
    const add = (ck: string, key: string, sig: string, box: [number, number, number, number]) => {
      let m = want.get(ck);
      if (!m) want.set(ck, (m = new Map()));
      m.set(key, sig);
      let b = bounds.get(ck);
      if (!b) bounds.set(ck, (b = []));
      b.push(box);
    };
    for (const s of Object.values(n.segments)) {
      const a = n.nodes[s.a], b = n.nodes[s.b];
      const line = segmentLine(n, s);
      const mid = line.samples[Math.floor(line.samples.length / 2)];
      const sig = `${a.x},${a.z},${a.y}|${b.x},${b.z},${b.y}|${s.control.join(';')}|${JSON.stringify(s.profile)}|${ints.get(s.a)?.trim.get(s.id) ?? 0}|${ints.get(s.b)?.trim.get(s.id) ?? 0}`;
      add(chunkKey(mid.x, mid.z), `s:${s.id}`, sig, segmentBounds(n, s));
    }
    for (const ix of ints.values()) {
      const node = n.nodes[ix.node];
      const sig = `${node.x},${node.z},${node.y}|${ix.surface.flat().join(',')}|${ix.crosswalks.length}|${ix.material}|${ix.corners.map((c) => c.curb).join(',')}`;
      const xs = ix.surface.map((p) => p[0]).concat(ix.corners.flatMap((c) => c.poly.map((p) => p[0])));
      const zs = ix.surface.map((p) => p[1]).concat(ix.corners.flatMap((c) => c.poly.map((p) => p[1])));
      add(chunkKey(node.x, node.z), `i:${ix.node}`, sig, [Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1]);
    }
    // Where the terrain changed since the last build (one world rectangle: edits are local).
    const shape = `${t.nx},${t.nz},${t.originX},${t.originZ},${t.cellSize}`;
    const fresh = !this.heights || shape !== this.terrainShape;
    let changed: [number, number, number, number] | null = null;
    if (!fresh) {
      const h = t.heights, p = this.heights!;
      for (let i = 0; i < h.length; i++) {
        if (h[i] === p[i]) continue;
        const ix = i % t.nx, iz = (i - ix) / t.nx;
        const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
        changed = changed ? [Math.min(changed[0], x), Math.min(changed[1], z), Math.max(changed[2], x), Math.max(changed[3], z)] : [x, z, x, z];
      }
    }
    const touched = (ck: string) => !!changed && (bounds.get(ck) ?? []).some((b) => b[0] <= changed![2] + 1 && b[2] >= changed![0] - 1 && b[1] <= changed![3] + 1 && b[3] >= changed![1] - 1);
    this.heights = t.heights.slice();
    this.terrainShape = shape;
    const sampler = samplerFor(t);
    const ctx = { network: n, terrain: t, sampler };
    for (const [ck, sigs] of want) {
      const cur = this.chunks.get(ck);
      const same = cur && !fresh && !touched(ck) && cur.sigs.size === sigs.size && [...sigs].every(([k, v]) => cur.sigs.get(k) === v);
      if (same) continue;
      const pieces: RoadPiece[] = [];
      for (const key of [...sigs.keys()].sort()) {
        if (key.startsWith('s:')) pieces.push(segmentPiece(ctx, n.segments[key.slice(2)]));
        else pieces.push(intersectionPiece(ctx, ints.get(key.slice(2))!));
      }
      this.build(ck, sigs, pieces);
    }
    for (const ck of [...this.chunks.keys()]) if (!want.has(ck)) this.drop(ck);
    this.count();
    roadStats.meshBuilds++;
    roadStats.lastMeshMs = performance.now() - t0;
    roadStats.meshMs += roadStats.lastMeshMs;
  }

  private build(ck: string, sigs: Map<string, string>, pieces: RoadPiece[]) {
    this.drop(ck);
    const st: ChunkState = { key: ck, sigs, meshes: {} };
    for (const layer of LAYERS) {
      const g = merge(pieces.map((p) => p[layer]));
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this.mats[layer]);
      mesh.name = `roads:${layer}:${ck}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      // Roads are ground: never in the way of picking objects or the terrain tools.
      mesh.raycast = () => {};
      this.root.add(mesh);
      st.meshes[layer] = mesh;
    }
    this.chunks.set(ck, st);
  }

  private drop(ck: string) {
    const st = this.chunks.get(ck);
    if (!st) return;
    for (const m of Object.values(st.meshes)) {
      this.root.remove(m!);
      m!.geometry.dispose();
    }
    this.chunks.delete(ck);
  }

  private count() {
    let calls = 0, tris = 0;
    for (const st of this.chunks.values()) {
      for (const m of Object.values(st.meshes)) {
        calls++;
        tris += m!.geometry.getAttribute('position').count / 3;
      }
    }
    this.drawCalls = calls;
    this.triangles = tris;
  }

  /** Chunk keys (tests / benchmarks). */
  get chunkCount() {
    return this.chunks.size;
  }

  dispose() {
    for (const ck of [...this.chunks.keys()]) this.drop(ck);
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
