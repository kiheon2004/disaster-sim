/**
 * Phase 36 precision editing: one undo history for geometry and placed disasters, numeric transform rules, road links of
 * moved objects, locked / hidden objects, selection modes (toggle, box subtract, same type, overlap cycling) and the save
 * format of the new editor metadata (absent by default → older documents round-trip unchanged).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { identityTransform, type Vec3 } from '@/core/types';
import { useEditorStore } from '@/editor/editorStore';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { deleteInstance, moveInstance, placeAt, redoPlacement, undoPlacement } from './placementActions';
import { boxSelect, clickSelect, deleteSelection, selectFromHits, selectSameType, transformSelection } from './buildActions';
import { displayRotation, droppedTransform, heightAboveGround, sanitizePosition, storedRotation, withHeightAboveGround } from '@/editor/build/numericTransform';
import { samplerFor } from '@/terrain/TerrainSampler';
import { drawRoad, segmentLine } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { objectsInRect } from '@/editor/MarqueeSelect';
import * as THREE from 'three';

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
});

const W = () => useWorldStore.getState();
const ED = () => useEditorStore.getState();
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });
const instances = () => W().doc.scenario.experiment?.instances ?? [];

beforeEach(() => {
  W().replaceDocument(createEmptyDocument());
  ED().setMode('editor');
  ED().select(null);
  usePlacementStore.getState().disarm();
  usePlacementStore.getState().select(null);
});

describe('one history for geometry and placed disasters', () => {
  it('placing, moving and deleting a disaster are world undo steps, in order with object edits', () => {
    const id = W().addObject({ type: 'wall', transform: at(5, 5) });
    const steps = W().past.length;
    usePlacementStore.getState().arm('blast', { event: 'blast', position: [0, 0], energy: 4.184e6, height: 1 } as never);
    const p = placeAt([10, 20])!;
    expect(instances().map((i) => i.id)).toEqual([p]);
    expect(W().past.length).toBe(steps + 1);
    expect(moveInstance(p, [30, 40])).toBe(true);
    expect(W().past.length).toBe(steps + 2);

    // Undo: the move, then the placement, then the object — one stack.
    W().undo();
    expect((instances()[0].spec as { position: number[] }).position).toEqual([10, 20]);
    expect(undoPlacement()).toBe(true); // the PlacementBar button = the same world undo
    expect(instances()).toEqual([]);
    W().undo();
    expect(W().doc.objects[id]).toBeUndefined();
    W().redo();
    expect(redoPlacement()).toBe(true);
    expect(instances().map((i) => i.id)).toEqual([p]);

    deleteInstance(p);
    expect(instances()).toEqual([]);
    W().undo();
    expect(instances().map((i) => i.id)).toEqual([p]);
  });

  it('replacing the document clears the history (no undo across projects); a locked world applies without recording', () => {
    W().setExperiment({ compareDuration: 30 });
    expect(W().past.length).toBe(1);
    W().replaceDocument(createEmptyDocument());
    expect(W().past.length).toBe(0);
    W().setLocked(true);
    W().setExperiment({ compareDuration: 45 });
    expect(W().past.length).toBe(0);
    expect(W().doc.scenario.experiment?.compareDuration).toBe(45);
    W().setLocked(false);
  });
});

describe('numeric transform rules', () => {
  it('positions stay finite, inside the world square and the elevation range (below 0 allowed)', () => {
    const s = sanitizePosition([150, -12, Number.NaN], [1, 2, 3]);
    expect(s.value).toEqual([100, -12, 3]);
    expect(s.clamped).toEqual(['x']);
    expect(s.rejected).toEqual(['z']);
    expect(sanitizePosition([0, -90, 0], [0, 0, 0]).value[1]).toBe(-40);
  });

  it('height above ground and drop to ground on a slope', () => {
    const doc = createEmptyDocument();
    const t = doc.terrain;
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = (t.originX + ix * t.cellSize) * 0.2; // 20 % slope along x
    t.revision++;
    const s = samplerFor(t);
    const obj = { type: 'human' as const, params: {}, transform: { ...identityTransform(), position: [10, 7, 0] as Vec3 } };
    const ground = s.sampleHeight(10, 0);
    expect(heightAboveGround(obj, s)).toBeCloseTo(7 - ground, 5);
    const p = withHeightAboveGround(obj, 1.5, s);
    expect(p[1]).toBeCloseTo(ground + 1.5, 5);
    const d = droppedTransform(obj, s);
    expect(d.position[1]).toBeCloseTo(ground, 5);
  });

  it('rotation shows as tilt · heading · tilt; a 120° heading reads 120 and stores back exactly', () => {
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (120 * Math.PI) / 180), 'XYZ');
    const shown = displayRotation([e.x, e.y, e.z]);
    expect(shown[0]).toBeCloseTo(0, 6);
    expect(shown[1]).toBeCloseTo(120, 6);
    expect(shown[2]).toBeCloseTo(0, 6);
    const back = storedRotation(shown);
    const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(...back));
    const q0 = new THREE.Quaternion().setFromEuler(e);
    expect(Math.abs(q1.dot(q0))).toBeCloseTo(1, 9);
  });
});

describe('road links of moved objects', () => {
  it('moving a linked object re-measures its link; the next road edit does not snap it back', () => {
    const net = drawRoad(W().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() });
    W().applyEdit({ roads: net.network });
    const seg = net.segments[0];
    const line = segmentLine(W().doc.roads, W().doc.roads.segments[seg]);
    void line;
    const id = W().addObject({ type: 'streetLight', transform: at(-20, 6), roadLink: { segment: seg, t: 0.33, lateral: 6, yaw: 0, policy: 'follow' } as never });
    W().updateTransform(id, { position: [25, 0, 6] });
    const link = W().doc.objects[id].roadLink!;
    expect(link).toBeTruthy();
    expect(link.t).toBeGreaterThan(0.6); // measured where it now is, not 0.33
    // A road edit (move the far end a little): the light follows from ITS NEW place.
    const r = W().doc.roads;
    const b = r.segments[seg].b;
    W().applyEdit({ roads: { ...r, nodes: { ...r.nodes, [b]: { ...r.nodes[b], z: 2 } } } });
    expect(W().doc.objects[id].transform.position[0]).toBeGreaterThan(15);
    // Far from every road: the link is dropped (the object stays).
    W().updateTransform(id, { position: [25, 0, 80] });
    expect(W().doc.objects[id].roadLink).toBeUndefined();
  });
});

describe('locked and hidden objects', () => {
  it('locked objects are not deleted / moved; locked and hidden objects are not picked by click or box', () => {
    const [a, b, c] = W().addObjects([{ type: 'wall', transform: at(0, 0) }, { type: 'wall', transform: at(5, 0) }, { type: 'wall', transform: at(10, 0) }]);
    W().applyEdit({ update: [{ ...W().doc.objects[a], locked: true }, { ...W().doc.objects[c], hidden: true }] });
    ED().setSelection([a, b]);
    transformSelection({ dx: 3, dy: 0, dz: 0, dyaw: 0, scale: 1 });
    expect(W().doc.objects[a].transform.position[0]).toBe(0);
    expect(W().doc.objects[b].transform.position[0]).toBeCloseTo(8, 6);
    deleteSelection();
    expect(W().doc.objects[a]).toBeTruthy();
    expect(W().doc.objects[b]).toBeUndefined();
    expect(selectFromHits([a, c], {}, [0, 0])).toBe(null);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(5, 80, 0.01);
    cam.lookAt(5, 0, 0);
    cam.updateMatrixWorld();
    expect(objectsInRect(Object.values(W().doc.objects), cam, [-1, -1], [1, 1])).toEqual([]);
  });
});

describe('selection modes', () => {
  it('Ctrl/⌘ toggles like Shift; box subtract; same type; clicking again at the same spot cycles', () => {
    const [w1, w2, h1] = W().addObjects([{ type: 'wall', transform: at(0, 0) }, { type: 'wall', transform: at(4, 0) }, { type: 'human', transform: at(8, 0) }]);
    clickSelect(w1);
    clickSelect(w2, { toggle: true });
    expect(ED().selectedIds).toEqual([w1, w2]);
    clickSelect(w1, { toggle: true });
    expect(ED().selectedIds).toEqual([w2]);
    boxSelect([w1, w2, h1], 'add');
    boxSelect([w2], 'subtract');
    expect(ED().selectedIds.sort()).toEqual([w1, h1].sort());
    ED().select(w1);
    expect(selectSameType()).toBe(2);
    expect(ED().selectedIds.sort()).toEqual([w1, w2].sort());
    // Overlap cycling: the same hit list clicked twice at the same spot → the next object.
    expect(selectFromHits([h1, w1], {}, [100, 100])).toBe(h1);
    expect(selectFromHits([h1, w1], {}, [101, 100])).toBe(w1);
    expect(selectFromHits([h1, w1], {}, [101, 101])).toBe(h1);
    expect(selectFromHits([h1, w1], {}, [300, 300])).toBe(h1); // elsewhere: the nearest again
  });
});

describe('save format of the editor metadata', () => {
  it('flags and group names round-trip; documents without them serialize exactly as before', () => {
    const plain = createEmptyDocument('p');
    W().replaceDocument(plain);
    W().addObjects([{ type: 'wall', transform: at(0, 0) }, { type: 'wall', transform: at(3, 0), group: 'g1' }, { type: 'wall', transform: at(6, 0), group: 'g1' }]);
    const text0 = serializeDocument(W().doc);
    expect(text0).not.toMatch(/"locked"|"hidden"|"groups"/);
    const r0 = parseDocument(text0);
    expect(r0.ok && serializeDocument(r0.doc)).toBe(text0);

    const ids = Object.keys(W().doc.objects);
    W().applyEdit({ update: [{ ...W().doc.objects[ids[0]], locked: true, hidden: true }] });
    const doc = { ...W().doc, groups: { g1: { name: 'Block A' }, gone: { name: 'old' } } };
    const r = parseDocument(serializeDocument(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.objects[ids[0]].locked).toBe(true);
    expect(r.doc.objects[ids[0]].hidden).toBe(true);
    expect(r.doc.groups).toEqual({ g1: { name: 'Block A' } }); // names of groups without members are dropped
  });
});

import { alignObjects, distributeGaps, footprintHalf, matchObjects } from '@/editor/build/groupTransform';
import { yawOf } from '@/terrain/groundPlacement';

describe('alignment (§14)', () => {
  const flat = () => samplerFor(createEmptyDocument().terrain);
  const wall = (id: string, x: number, z: number, len: number, yawDeg = 0) => ({
    ...createEmptyDocument().objects, id, type: 'wall', name: '', serial: 1, seed: 1, components: [],
    params: { length: len, height: 2, thickness: 0.3 },
    physics: { mass: 1, windResistance: 1, durability: 1, breakThreshold: 1, dragCoefficient: 1, friction: 0.5, restitution: 0, anchored: true },
    transform: { position: [x, 0, z] as Vec3, rotation: [0, (yawDeg * Math.PI) / 180, 0] as Vec3, scale: [1, 1, 1] as Vec3 },
  }) as never as import('@/core/model').WorldObject;

  it('footprint edges flush (bounds) vs origins; rotation counted in the footprint', () => {
    const a = wall('a', 0, 0, 4), b = wall('b', 10, 3, 8);
    expect(footprintHalf(a, 0)).toBeCloseTo(2, 6);
    expect(footprintHalf(wall('r', 0, 0, 4, 90), 0)).toBeCloseTo(0.15, 6);
    const byOrigin = alignObjects([a, b], 'x', 'min', flat(), 'origin');
    expect(byOrigin.map((o) => o.transform.position[0])).toEqual([0, 0]);
    const byBounds = alignObjects([a, b], 'x', 'min', flat(), 'bounds');
    // Left edges at −2: a stays (centre 0), b moves to −2 + 4 = 2.
    expect(byBounds.map((o) => o.transform.position[0])).toEqual([0, 2]);
  });

  it('equal gaps between footprints of different sizes', () => {
    const objs = [wall('a', 0, 0, 2), wall('b', 3, 0, 6), wall('c', 20, 0, 4)];
    const out = distributeGaps(objs, 'x', flat());
    const xs = out.map((o) => o.transform.position[0]);
    const gap1 = xs[1] - 3 - (xs[0] + 1), gap2 = xs[2] - 2 - (xs[1] + 3);
    expect(gap1).toBeCloseTo(gap2, 9);
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(20);
  });

  it('same heading / height / scale as the reference', () => {
    const ref = { ...wall('r', 0, 0, 4, 120), transform: { ...wall('r', 0, 0, 4, 120).transform, position: [0, 3, 0] as Vec3, scale: [2, 1, 1] as Vec3 } };
    const o = wall('o', 10, 0, 4, 10);
    const [, rot] = matchObjects([ref, o], ref, 'rotation', flat());
    expect((yawOf(rot.transform.rotation) * 180) / Math.PI).toBeCloseTo(120, 6);
    expect(matchObjects([ref, o], ref, 'height', flat())[1].transform.position[1]).toBeCloseTo(3, 6);
    expect(matchObjects([ref, o], ref, 'scale', flat())[1].transform.scale).toEqual([2, 1, 1]);
  });
});

describe('group names', () => {
  it('naming a group is one undo step; undo / redo restore the name', () => {
    W().addObjects([{ type: 'wall', transform: at(0, 0), group: 'g1' }, { type: 'wall', transform: at(3, 0), group: 'g1' }]);
    const n = W().past.length;
    W().setGroupName('g1', '  Block A  ');
    expect(W().doc.groups).toEqual({ g1: { name: 'Block A' } });
    expect(W().past.length).toBe(n + 1);
    W().setGroupName('g1', 'Block A'); // unchanged: no step
    expect(W().past.length).toBe(n + 1);
    W().undo();
    expect(W().doc.groups).toBeUndefined();
    W().redo();
    expect(W().doc.groups?.g1.name).toBe('Block A');
    W().setGroupName('g1', '');
    expect(W().doc.groups).toBeUndefined();
  });
});

import { setObjectFlags } from './buildActions';

describe('outliner flags', () => {
  it('lock / hide store only true; showing / unlocking removes the key; hiding drops the selection', () => {
    const [a, b] = W().addObjects([{ type: 'wall', transform: at(0, 0) }, { type: 'wall', transform: at(3, 0) }]);
    ED().setSelection([a, b]);
    setObjectFlags([a], { hidden: true, locked: true });
    expect(W().doc.objects[a]).toMatchObject({ hidden: true, locked: true });
    expect(ED().selectedIds).toEqual([b]);
    const steps = W().past.length;
    setObjectFlags([a], { hidden: false, locked: false });
    expect('hidden' in W().doc.objects[a] || 'locked' in W().doc.objects[a]).toBe(false);
    expect(W().past.length).toBe(steps + 1);
    setObjectFlags([a], { hidden: false }); // no change: no step
    expect(W().past.length).toBe(steps + 1);
  });
});

import { copyProperties } from '@/editor/build/propertyCopy';

describe('property copy (§20)', () => {
  it('applies only compatible properties; counts the skipped ones; modular structure via member materials', () => {
    const flatS = samplerFor(createEmptyDocument().terrain);
    const [w1, w2, h] = W().addObjects([
      { type: 'wall', transform: { ...at(0, 0), scale: [2, 1, 1] }, params: { length: 9 } },
      { type: 'wall', transform: at(5, 0) },
      { type: 'human', transform: at(9, 0) },
    ]);
    const o = W().doc.objects;
    const r = copyProperties(o[w1], [o[w1], o[w2], o[h]], new Set(['params', 'scale']), flatS);
    expect(r.applied).toBe(3); // params → wall only; scale → wall + human
    expect(r.skipped).toBe(1); // params → human
    const w2n = r.objects.find((x) => x.id === w2)!;
    expect(w2n.params.length).toBe(9);
    expect(w2n.transform.scale).toEqual([2, 1, 1]);
    expect(r.objects.find((x) => x.id === h)!.params).toEqual(o[h].params);
  });
});

import { checkPlacement } from '@/editor/build/placementCheck';
import { getDefinition } from '@/objects/registry';
import { groundPose } from '@/terrain/groundPlacement';

describe('placement checks for vehicles and people (§16, §19)', () => {
  it('wheel off the ground on a ridge, steep slope, off-road, under water', () => {
    const doc = createEmptyDocument();
    const t = doc.terrain;
    const car = createWorldObject({ type: 'car', transform: identityTransform() }, 1);
    const d = getDefinition('car').getDimensions(car.params);
    const wx = (d[0] / 2) * 0.78, wz = (d[2] / 2) * 0.85;
    // A bump under ONE wheel (front right): the plane through the footprint corners leaves that wheel off it. Plus a
    // steep slope beyond x = 60.
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
      const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
      t.heights[iz * t.nx + ix] = Math.max(0, 0.9 - Math.hypot(x - wx, z - wz) * 0.6) + Math.max(0, x - 60) * 0.7;
    }
    t.revision++;
    const s = samplerFor(t);
    const seat = groundPose(car, 0, 0, 0, s);
    const onRidge = checkPlacement({ ...car, transform: { ...car.transform, ...seat } }, s);
    expect(onRidge.warnings).toContain('wheelContact');
    expect(onRidge.warnings).toContain('offRoad');
    const flatSeat = groundPose(car, -50, 40, 0, s);
    expect(checkPlacement({ ...car, transform: { ...car.transform, ...flatSeat } }, s).warnings).not.toContain('wheelContact');
    const human = createWorldObject({ type: 'human', transform: identityTransform() }, 1);
    const steepSeat = groundPose(human, 80, 40, 0, s);
    expect(checkPlacement({ ...human, transform: { ...human.transform, ...steepSeat } }, s).warnings).toContain('steep');
    t.settings = { ...t.settings, waterLevel: 0.5 };
    t.revision++;
    const wet = groundPose(human, -50, 40, 0, samplerFor(t));
    expect(checkPlacement({ ...human, transform: { ...human.transform, ...wet } }, samplerFor(t)).warnings).toContain('inWater');
  });
});

import { checkStamp } from '@/editor/build/placementCheck';

describe('paste stamps are checked (§16)', () => {
  it('outside the world refuses the stamp; overlaps are warnings', () => {
    const inside = [{ type: 'wall' as const, transform: at(0, 0) }, { type: 'wall' as const, transform: at(0.2, 0) }];
    const r = checkStamp(inside, null);
    expect(r.ok).toBe(true);
    expect(r.items[1].warnings).toContain('overlap');
    expect(checkStamp([{ type: 'wall', transform: at(99.9, 0) }], null).ok).toBe(false);
  });
});

import { setType, TYPE_SWAPS } from '@/buildings/edit';
import { presetDesign } from '@/roads/city';

describe('member type changes (§36)', () => {
  it('only window ↔ door; other members are left alone', () => {
    const d = presetDesign('office', 2)!;
    const win = d.members.find((m) => m.type === 'window')!;
    const col = d.members.find((m) => m.type === 'column')!;
    const out = setType(d, [win.id, col.id], 'door');
    expect(out.members.find((m) => m.id === win.id)!.type).toBe('door');
    expect(out.members.find((m) => m.id === col.id)!.type).toBe('column');
    expect(TYPE_SWAPS.column).toBeUndefined();
  });
});

import { structureLabObjects, structureLabRoads } from '@/world/defaultTown';
import { typeOfMaterial } from '@/buildings/structuralType';
import { FootprintIndex, collisionFootprint } from '@/editor/build/footprint';

describe('structure lab preset (§51)', () => {
  it('one building of each load-bearing structural type, clear of the road and of each other', () => {
    W().replaceDocument(createEmptyDocument());
    W().applyEdit({ roads: structureLabRoads() });
    W().addObjects(structureLabObjects());
    const objs = Object.values(W().doc.objects);
    const types = objs.filter((o) => o.type === 'building').map((o) => typeOfMaterial(o.building!.spec.structureMaterial)).sort();
    expect(types).toEqual(['masonry', 'rc', 'steel', 'timber']);
    const idx = new FootprintIndex();
    for (const o of objs.filter((o) => o.type === 'building')) {
      const fp = collisionFootprint(o.type, o.params, o.transform.scale, o.transform.position[0], o.transform.position[2], 0)!;
      expect(idx.overlaps(fp)).toBe(false);
      idx.add(fp);
      expect(Math.abs(o.transform.position[2]) - o.building!.spec.depth / 2).toBeGreaterThan(5.5); // behind the sidewalk
    }
  });
});
