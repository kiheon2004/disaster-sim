/**
 * Phase 37: the command preview's markings as geometry — one object per kind for any number of things, positions
 * that follow the object's transform, and everything freed on dispose. (three.js objects are built without a renderer.)
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@/core/types';
import {
  BOX_CROSS_VERTICES, BOX_EDGE_VERTICES, boxEdges, boxMatrix, changedMarks, DRAFT_STRENGTH, groundArrow, highlightSet, MarkSet, moveLinks, movedMarks, pinLinks, plateMatrix,
  rejectedMarks, removedMarks, ringLines, roadLines, roadMarks, roadRibbon,
} from './marks';
import type { BoxMark, PinMark, RoadMark } from './previewModel';

const box = (over: Partial<BoxMark> = {}): BoxMark => ({ id: 'b1' as EntityId, position: [10, 2, -5], rotation: [0, 0, 0], size: [4, 6, 2], ...over });
const flat = () => 0;
const slope = (x: number, z: number) => 0.1 * x + 0.05 * z;
const pts = (a: Float32Array) => Array.from({ length: a.length / 3 }, (_, k) => [a[3 * k], a[3 * k + 1], a[3 * k + 2]]);
const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-5);

describe('box maths', () => {
  it('the unit cube becomes the object\'s box standing on its origin (padded all round)', () => {
    const m = boxMatrix(box(), 0.2);
    const low = new THREE.Vector3(-0.5, -0.5, -0.5).applyMatrix4(m), high = new THREE.Vector3(0.5, 0.5, 0.5).applyMatrix4(m);
    expect(close(low.toArray(), [10 - 2.1, 2 + 3 - 3.1, -5 - 1.1])).toBe(true);
    expect(close(high.toArray(), [10 + 2.1, 2 + 3 + 3.1, -5 + 1.1])).toBe(true);
  });

  it('follows the object\'s rotation (a quarter turn about y swaps the box\'s x and z extent)', () => {
    const m = boxMatrix(box({ rotation: [0, Math.PI / 2, 0] }), 0);
    const b = new THREE.Box3();
    for (let k = 0; k < 8; k++) b.expandByPoint(new THREE.Vector3(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5).applyMatrix4(m));
    expect(close(b.min.toArray(), [10 - 1, 2, -5 - 2])).toBe(true);
    expect(close(b.max.toArray(), [10 + 1, 2 + 6, -5 + 2])).toBe(true);
  });

  it('a tilted object: the box tilts with it (it stands on the object\'s base, not on the world\'s up)', () => {
    const m = boxMatrix(box({ rotation: [0, 0, Math.PI / 2], position: [0, 0, 0], size: [2, 10, 2] }), 0);
    const top = new THREE.Vector3(0, 0.5, 0).applyMatrix4(m);
    expect(close(top.toArray(), [-10, 0, 0])).toBe(true);
  });

  it('the plate lies under the object: its footprint, a few centimetres thick', () => {
    const m = plateMatrix(box(), 0.9, 0.1);
    const b = new THREE.Box3();
    for (let k = 0; k < 8; k++) b.expandByPoint(new THREE.Vector3(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5).applyMatrix4(m));
    expect(close(b.min.toArray(), [10 - 2.45, 2.03, -5 - 1.45])).toBe(true);
    expect(close(b.max.toArray(), [10 + 2.45, 2.13, -5 + 1.45])).toBe(true);
  });

  it('box edges: 12 edges per box, each between two corners of the box; the cross adds two diagonals on the top face', () => {
    const boxes = [box(), box({ id: 'b2' as EntityId, position: [0, 0, 0] })];
    const plain = boxEdges(boxes, 0);
    expect(plain.length).toBe(boxes.length * BOX_EDGE_VERTICES * 3);
    const first = pts(plain).slice(0, BOX_EDGE_VERTICES);
    for (const p of first) {
      expect(Math.abs(Math.abs(p[0] - 10) - 2)).toBeLessThan(1e-5);
      expect(Math.min(Math.abs(p[1] - 2), Math.abs(p[1] - 8))).toBeLessThan(1e-5);
      expect(Math.abs(Math.abs(p[2] + 5) - 1)).toBeLessThan(1e-5);
    }
    // Each edge runs along exactly one axis.
    for (let k = 0; k < first.length; k += 2) {
      const d = [0, 1, 2].filter((i) => Math.abs(first[k][i] - first[k + 1][i]) > 1e-6);
      expect(d.length).toBe(1);
    }
    const crossed = boxEdges(boxes, 0, true);
    expect(crossed.length).toBe(boxes.length * (BOX_EDGE_VERTICES + BOX_CROSS_VERTICES) * 3);
    const cross = pts(crossed).slice(BOX_EDGE_VERTICES, BOX_EDGE_VERTICES + BOX_CROSS_VERTICES);
    for (const p of cross) expect(p[1]).toBeCloseTo(8, 5); // on the top face
    expect(cross[0][0]).not.toBeCloseTo(cross[1][0], 3); // a diagonal: both x and z differ
    expect(cross[0][2]).not.toBeCloseTo(cross[1][2], 3);
  });
});

describe('moved objects', () => {
  it('old footprint (4 lines) + a line to the new place + two arrow barbs at the new end', () => {
    const from = box({ position: [0, 0, 0] }), to = box({ position: [10, 1, 0] });
    const a = moveLinks([{ from, to }]);
    expect(a.length / 6).toBe(4 + 1 + 2);
    const p = pts(a);
    // The link: from the old middle to the new middle.
    expect(close(p[8], [0, 0.08, 0])).toBe(true);
    expect(close(p[9], [10, 1.08, 0])).toBe(true);
    // Both barbs start at the new end and point back toward the old place.
    for (const k of [10, 12]) {
      expect(close(p[k], [10, 1.08, 0])).toBe(true);
      expect(p[k + 1][0]).toBeLessThan(10);
    }
    expect(p[11][2]).toBeCloseTo(-p[13][2], 5); // one either side of the line
  });

  it('a move straight up (re-seated on raised ground) has no arrow head — nothing to point along', () => {
    const a = moveLinks([{ from: box({ position: [0, 0, 0] }), to: box({ position: [0, 3, 0] }) }]);
    expect(a.length / 6).toBe(4 + 1);
  });
});

describe('lines on the ground', () => {
  it('rings are draped on the ground; a point also gets a plus at its middle', () => {
    const node = ringLines([{ x: 10, z: 20, r: 2, of: 'node' }], slope);
    const point = ringLines([{ x: 10, z: 20, r: 2, of: 'point' }], slope);
    expect(point.length - node.length).toBe(4 * 3);
    for (const p of pts(node)) {
      expect(Math.hypot(p[0] - 10, p[2] - 20)).toBeCloseTo(2, 4);
      expect(p[1]).toBeCloseTo(slope(p[0], p[2]) + 0.16, 5);
    }
    // Closed: the last vertex is the first.
    const all = pts(node);
    expect(close(all[all.length - 1], all[0])).toBe(true);
  });

  const road: RoadMark = { id: 's1', width: 6, points: Array.from({ length: 21 }, (_, k) => [k, 0] as [number, number]) };

  it('a road: centre line and both edges half a width away, closed at the ends', () => {
    const a = roadLines([road], flat);
    expect(a.length / 6).toBe(3 * 20 + 2);
    const zs = new Set(pts(a).map((p) => Math.round(p[2] * 1000) / 1000));
    expect([...zs].sort((x, y) => x - y)).toEqual([-3, 0, 3]);
  });

  it('a removed road is crossed out: the same lines plus crosses over the carriageway', () => {
    const plain = roadLines([road], flat), crossed = roadLines([road], flat, true);
    const extra = (crossed.length - plain.length) / 6;
    expect(extra).toBeGreaterThanOrEqual(6); // a cross (2 lines) about every 6 m of 20 m
    expect(extra % 2).toBe(0);
  });

  it('the ribbon covers the carriageway (two triangles per metre), a little under the lines', () => {
    const a = roadRibbon([road], flat);
    expect(a.length / 9).toBe(2 * 20);
    for (const p of pts(a)) {
      expect(Math.abs(p[2])).toBeCloseTo(3, 5);
      expect(p[1]).toBeCloseTo(0.12, 5);
    }
  });

  it('a pin\'s move: an arrow along the ground from the old place to the new one; none for no move', () => {
    const a = pts(groundArrow([0, 0], [10, 0], slope));
    expect(close(a[0], [0, 0.16, 0])).toBe(true);
    expect(a.some((p) => close(p, [10, 1.16, 0]))).toBe(true);
    for (const p of a) expect(p[1]).toBeCloseTo(slope(p[0], p[2]) + 0.16, 5);
    expect(groundArrow([3, 3], [3, 3], flat).length).toBe(0);
  });
});

describe('mark sets — one object per kind, freed together', () => {
  const many = Array.from({ length: 2000 }, (_, k) => box({ id: `b${k}` as EntityId, position: [k % 50, 0, Math.floor(k / 50)] }));

  it('2000 removed objects are one instanced mesh and one line object', () => {
    const set = removedMarks(many);
    expect(set.objects.length).toBe(2);
    const fill = set.objects[0] as THREE.InstancedMesh;
    expect(fill).toBeInstanceOf(THREE.InstancedMesh);
    expect(fill.count).toBe(2000);
    const lines = set.objects[1] as THREE.LineSegments;
    expect(lines.geometry.attributes.position.count).toBe(2000 * (BOX_EDGE_VERTICES + BOX_CROSS_VERTICES));
    // The 1234th instance sits where the 1234th object is.
    const m = new THREE.Matrix4();
    fill.getMatrixAt(1234, m);
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    expect(close(c.toArray(), [1234 % 50, 3, Math.floor(1234 / 50)])).toBe(true);
    set.dispose();
  });

  it('changed objects differ from removed ones in shape and pattern, not only colour: a plate + DASHED edges without a cross', () => {
    const removed = removedMarks([box()]), changed = changedMarks([box()]);
    const rl = removed.objects[1] as THREE.LineSegments, cl = changed.objects[1] as THREE.LineSegments;
    expect(rl.material).toBeInstanceOf(THREE.LineBasicMaterial);
    expect(cl.material).toBeInstanceOf(THREE.LineDashedMaterial);
    expect(cl.geometry.attributes.lineDistance).toBeDefined();
    expect(cl.geometry.attributes.position.count).toBe(BOX_EDGE_VERTICES);
    expect(rl.geometry.attributes.position.count).toBe(BOX_EDGE_VERTICES + BOX_CROSS_VERTICES);
    // The fills: a full box against a thin plate.
    const size = (o: THREE.Object3D) => {
      const m = new THREE.Matrix4();
      (o as THREE.InstancedMesh).getMatrixAt(0, m);
      return new THREE.Vector3().setFromMatrixScale(m).y;
    };
    expect(size(removed.objects[0])).toBeGreaterThan(6);
    expect(size(changed.objects[0])).toBeLessThan(0.2);
    expect(((removed.objects[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHexString()).not.toBe(((changed.objects[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHexString());
    removed.dispose();
    changed.dispose();
  });

  it('nothing to mark → an empty set (no object in the scene)', () => {
    for (const set of [removedMarks([]), changedMarks([]), movedMarks([]), rejectedMarks([], flat), roadMarks([], [], flat), highlightSet({ boxes: [], lines: [], rings: [], pins: [] }, flat), pinLinks([], flat)]) {
      expect(set.empty).toBe(true);
      expect(set.objects).toEqual([]);
      set.dispose();
    }
  });

  it('rejected items: one instanced marker each, standing on the ground', () => {
    const set = rejectedMarks([{ x: 5, z: 6 }, { x: 50, z: -20 }], slope);
    expect(set.objects.length).toBe(1);
    const mesh = set.objects[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(1, m);
    expect(close(new THREE.Vector3().setFromMatrixPosition(m).toArray(), [50, slope(50, -20), -20])).toBe(true);
    set.dispose();
  });

  it('roads: new = a ribbon and lines, removed = one crossed-out line object', () => {
    const road: RoadMark = { id: 's1', width: 6, points: [[0, 0], [1, 0], [2, 0], [3, 0]] };
    const both = roadMarks([road], [road], flat);
    expect(both.objects.map((o) => o.type)).toEqual(['Mesh', 'LineSegments', 'LineSegments']);
    expect(roadMarks([], [road], flat).objects.length).toBe(1);
    both.dispose();
  });

  it('highlights: boxes (fill + edges) and one line object for road lines and rings together', () => {
    const set = highlightSet({ boxes: [box()], lines: [{ id: 's1', width: 6, points: [[0, 0], [1, 0]] }], rings: [{ x: 0, z: 0, r: 2, of: 'point' }], pins: [] }, flat);
    expect(set.objects.map((o) => o.type)).toEqual(['Mesh', 'LineSegments', 'LineSegments']);
    set.dispose();
  });

  it('pin links: only pins a plan MOVES get an arrow', () => {
    const pin = (state: PinMark['state'], from?: [number, number]): PinMark => ({ id: 'p1', type: 'fire', category: 'fireHeat', at: [10, 0], footprint: null, state, ...(from ? { from } : {}) });
    expect(pinLinks([pin('added'), pin('removed'), pin('changed')], flat).empty).toBe(true);
    const set = pinLinks([pin('changed', [0, 0])], flat);
    expect(set.objects.length).toBe(1);
    set.dispose();
  });

  it('nothing is picked, nothing is culled away; a draft is the same objects at a lower opacity', () => {
    const set = removedMarks([box()]);
    const hits: THREE.Intersection[] = [];
    const ray = new THREE.Raycaster(new THREE.Vector3(10, 50, -5), new THREE.Vector3(0, -1, 0));
    for (const o of set.objects) {
      o.raycast(ray, hits);
      expect(o.frustumCulled).toBe(false);
    }
    expect(hits).toEqual([]);
    const fill = (set.objects[0] as THREE.Mesh).material as THREE.Material, line = (set.objects[1] as THREE.LineSegments).material as THREE.Material;
    const open = [fill.opacity, line.opacity];
    set.setStrength(DRAFT_STRENGTH);
    expect(fill.opacity).toBeCloseTo(open[0] * DRAFT_STRENGTH, 6);
    expect(line.opacity).toBeCloseTo(open[1] * DRAFT_STRENGTH, 6);
    set.setStrength(1);
    expect([fill.opacity, line.opacity]).toEqual(open);
    set.dispose();
  });

  it('dispose frees every geometry and material of the set', () => {
    const set = new MarkSet();
    const sets = [removedMarks([box()]), changedMarks([box()]), movedMarks([{ from: box(), to: box({ position: [20, 0, 0] }) }]), rejectedMarks([{ x: 0, z: 0 }], flat)];
    expect(set.empty).toBe(true);
    for (const s of sets) {
      let freed = 0, owned = 0;
      for (const o of s.objects) {
        const mesh = o as THREE.Mesh;
        owned += 2;
        mesh.geometry.addEventListener('dispose', () => freed++);
        (mesh.material as THREE.Material).addEventListener('dispose', () => freed++);
      }
      s.dispose();
      expect(freed).toBe(owned);
    }
  });
});
