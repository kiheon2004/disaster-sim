import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { WorldObject } from '@/core/model';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { stressScene } from '@/world/stressScene';
import { flatSampler } from '@/terrain/TerrainSampler';
import { EditorBatches, chunkCountFor } from './EditorBatches';

function world(n: number): Record<string, WorldObject> {
  const doc = createEmptyDocument('batches');
  for (const input of stressScene(n)) {
    const o = createWorldObject(input, nextSerial(doc.objects, input.type));
    doc.objects[o.id] = o;
  }
  return doc.objects;
}

function batchMeshes(b: EditorBatches) {
  const out: THREE.BatchedMesh[] = [];
  b.root.traverse((o) => (o as THREE.BatchedMesh).isBatchedMesh && out.push(o as THREE.BatchedMesh));
  return out;
}

describe('edit-mode batches (Phase 16)', { timeout: 60_000 }, () => {
  it('chunk count grows slowly with the object count', () => {
    expect(chunkCountFor(100)).toBe(1);
    expect(chunkCountFor(500)).toBe(2);
    expect(chunkCountFor(1000)).toBe(4);
    expect(chunkCountFor(2000)).toBe(8);
    expect(chunkCountFor(100000)).toBe(8);
  });

  it('every object is drawn by an instance that picks back to its id', () => {
    const objs = world(300);
    const b = new EditorBatches(flatSampler());
    b.sync(objs, new Set());
    const seen = new Set<string>();
    for (const m of batchMeshes(b)) for (let i = 0; i < m.instanceCount; i++) {
      const id = b.pick(m, i);
      expect(id).not.toBeNull();
      seen.add(id!);
    }
    for (const o of Object.values(objs)) if (o.type !== 'road') expect(seen.has(o.id)).toBe(true);
    // A handful of meshes, independent of the object count.
    expect(batchMeshes(b).length).toBeLessThanOrEqual(8 * chunkCountFor(300));
    b.dispose();
  });

  it('rebuilds only chunks whose objects changed; hidden (selected) objects never trigger rebuilds', () => {
    const objs = world(1000);
    const b = new EditorBatches(flatSampler());
    b.sync(objs, new Set());
    const r0 = b.stats.rebuilds;
    expect(r0).toBe(chunkCountFor(Object.keys(objs).length));
    // Same objects → nothing rebuilt.
    b.sync({ ...objs }, new Set());
    expect(b.stats.rebuilds).toBe(r0);
    // Select one object, then "drag" it every frame: hidden in its chunk, no rebuilds.
    const id = Object.keys(objs)[10];
    b.sync(objs, new Set([id]));
    let cur = objs;
    for (let k = 0; k < 20; k++) {
      cur = { ...cur, [id]: { ...cur[id], transform: { ...cur[id].transform, position: [k, 0, k] } } };
      b.sync(cur, new Set([id]));
    }
    expect(b.stats.rebuilds).toBe(r0);
    // Deselect: exactly its chunk is rebuilt once with the new transform.
    b.sync(cur, new Set());
    expect(b.stats.rebuilds).toBe(r0 + 1);
    // Delete one object → one chunk.
    const { [id]: _gone, ...rest } = cur;
    b.sync(rest, new Set());
    expect(b.stats.rebuilds).toBe(r0 + 2);
    b.dispose();
  });

  it('hiding an object hides its instances; showing restores them', () => {
    const objs = world(120);
    const b = new EditorBatches(flatSampler());
    b.sync(objs, new Set());
    const building = Object.values(objs).find((o) => o.type === 'building')!;
    const visibleOf = () => {
      let n = 0;
      for (const m of batchMeshes(b)) for (let i = 0; i < m.instanceCount; i++) if (b.pick(m, i) === building.id && m.getVisibleAt(i)) n++;
      return n;
    };
    const shown = visibleOf();
    expect(shown).toBeGreaterThan(0);
    b.sync(objs, new Set([building.id]));
    expect(visibleOf()).toBe(0);
    b.sync(objs, new Set());
    expect(visibleOf()).toBe(shown);
    b.dispose();
  });
});
