import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { drawRoad, moveNode } from '@/roads/network';
import { bakeRegion, dirtyRect } from '@/roads/bake';
import { defaultProfile, emptyNetwork, type RoadNetwork } from '@/roads/types';
import { RoadBatches } from './RoadBatches';

function grid(k: number) {
  const t = createFlatTerrain();
  let n = emptyNetwork();
  const span = 180, step = span / (k - 1);
  const p = { ...defaultProfile(), width: 6, sidewalkWidth: 1.5 };
  for (let i = 0; i < k; i++) n = drawRoad(n, [[-span / 2, -span / 2 + i * step], [span / 2, -span / 2 + i * step]], { curved: false, profile: p }).network;
  for (let i = 0; i < k; i++) n = drawRoad(n, [[-span / 2 + i * step, -span / 2], [-span / 2 + i * step, span / 2]], { curved: false, profile: p }).network;
  const r = bakeRegion(t, emptyNetwork(), n, fullRect(t));
  return { t, n: { ...n, underlay: r.underlay } as RoadNetwork };
}

describe('road batches', () => {
  it('draw calls depend on the covered area, not on the segment count', { timeout: 60_000 }, () => {
    const counts: number[] = [];
    for (const k of [6, 11, 16]) {
      const { t, n } = grid(k);
      const b = new RoadBatches();
      b.sync(n, t);
      expect(b.drawCalls).toBeLessThanOrEqual(16 * 3);
      counts.push(b.drawCalls);
      // Every mesh is a valid indexed-free triangle list with normals and colors.
      b.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position');
        expect(pos.count % 3).toBe(0);
        expect(m.geometry.getAttribute('normal').count).toBe(pos.count);
        expect(m.geometry.getAttribute('color').count).toBe(pos.count);
      });
      b.dispose();
    }
    expect(new Set(counts).size).toBe(1);
  });

  it('an edit rebuilds only the chunks it touches', () => {
    const { t, n } = grid(11);
    const b = new RoadBatches();
    b.sync(n, t);
    const before = new Map(b.root.children.map((c) => [c.name, (c as THREE.Mesh).geometry]));
    const node = Object.values(n.nodes).find((x) => x.x > 50 && x.z > 50)!;
    const moved = moveNode(n, node.id, node.x + 2, node.z);
    const r = bakeRegion(t, n, moved, dirtyRect(t, n, moved)!);
    b.sync({ ...moved, underlay: r.underlay }, t);
    let kept = 0, rebuilt = 0;
    for (const c of b.root.children) {
      if (before.get(c.name) === (c as THREE.Mesh).geometry) kept++;
      else rebuilt++;
    }
    expect(rebuilt).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(rebuilt * 2);
    // No change → nothing rebuilt.
    const geoms = b.root.children.map((c) => (c as THREE.Mesh).geometry);
    b.sync({ ...moved, underlay: r.underlay }, t);
    expect(b.root.children.map((c) => (c as THREE.Mesh).geometry)).toEqual(geoms);
    b.dispose();
  });

  it('markings are hidden far from the camera (LOD)', () => {
    const { t, n } = grid(6);
    const b = new RoadBatches();
    b.sync(n, t);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 60, 0);
    const near = b.updateLod(cam);
    cam.position.set(0, 800, 0);
    const far = b.updateLod(cam);
    expect(near).toBeGreaterThan(0);
    expect(far).toBe(0);
    b.dispose();
  });
});
