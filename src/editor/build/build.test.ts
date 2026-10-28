import { beforeEach, describe, expect, it } from 'vitest';
import type { WorldObject } from '@/core/model';
import { WORLD_HALF } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { flatSampler, samplerFor, TerrainSampler } from '@/terrain/TerrainSampler';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { groundPose, isGrounded, yawOf } from '@/terrain/groundPlacement';
import { BrushScatter, areaFill, brushScatter, lineLayout, pathLength, shapeContains, type Vec2 } from './distribution';
import { FootprintIndex, collisionFootprint, footprintOf, footprintsOverlap } from './footprint';
import { DEFAULT_PLACEMENT, acceptedInputs, planPlacement, type PlacementSettings } from './placementPlan';
import { checkPlacement } from './placementCheck';
import { alignObjects, distributeObjects, selectionPivot, transformObjects } from './groupTransform';
import { createBlueprint, instantiateBlueprint, parseBlueprint, serializeBlueprint } from './blueprint';

const TREE = { type: 'tree' as const, params: { species: 'broadleaf', height: 8, canopyRadius: 2.6, trunkRadius: 0.3 }, randomize: true };
const flat = flatSampler();
const settings = (patch: Partial<PlacementSettings> = {}): PlacementSettings => ({ ...DEFAULT_PLACEMENT, seed: 7, ...patch });

function stroke(): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= 40; i++) out.push([-40 + i * 2, Math.sin(i / 6) * 12]);
  return out;
}

function resetWorld() {
  useWorldStore.setState({ locked: false });
  useWorldStore.getState().replaceDocument(createEmptyDocument('test'));
}

describe('brush placement', () => {
  it('scatters points inside the brush path with the minimum spacing', () => {
    const pts = brushScatter(stroke(), { radius: 8, density: 3, spacing: 3, seed: 1 });
    expect(pts.length).toBeGreaterThan(25);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThanOrEqual(3 - 1e-9);
    }
    // Every point lies within the radius of the path.
    const path = stroke();
    for (const p of pts) {
      const d = Math.min(...path.map((q, k) => (k ? segDist(p, path[k - 1], q) : Infinity)));
      expect(d).toBeLessThanOrEqual(8 + 1e-6);
    }
  });

  it('density is uniform: a slow stroke (many pointer moves) adds no more than a fast one', () => {
    const fast = brushScatter([[-30, 0], [30, 0]], { radius: 6, density: 4, spacing: 0.5, seed: 3 });
    const slow: Vec2[] = [];
    for (let x = -30; x <= 30; x += 0.05) slow.push([x, 0]);
    const s = brushScatter(slow, { radius: 6, density: 4, spacing: 0.5, seed: 3 });
    // Fixed arc-length resampling: the same stamps (up to float rounding) → about the same count.
    expect(Math.abs(s.length - fast.length)).toBeLessThanOrEqual(Math.ceil(fast.length * 0.1));
    const area = 60 * 12 + Math.PI * 36;
    expect(s.length / area * 100).toBeGreaterThan(2.5);
    expect(s.length / area * 100).toBeLessThan(5.5);
  });
});

describe('deterministic distribution', () => {
  it('same seed + same input path → identical points; incremental == batch', () => {
    const o = { radius: 7, density: 2.5, spacing: 2, seed: 42 };
    const a = brushScatter(stroke(), o);
    const b = brushScatter(stroke(), o);
    expect(a).toEqual(b);
    const inc = new BrushScatter(o);
    const added: Vec2[] = [];
    for (const p of stroke()) added.push(...inc.extend(p));
    expect(added).toEqual(a);
    expect(brushScatter(stroke(), { ...o, seed: 43 })).not.toEqual(a);
  });

  it('the planned objects (params, heading, scale, seeds) are identical for the same seed', () => {
    const pts = brushScatter(stroke(), { radius: 7, density: 2.5, spacing: 2, seed: 5 }).map(([x, z]) => ({ x, z }));
    const s = settings({ scaleMin: 0.8, scaleMax: 1.3 });
    const a = planPlacement(TREE, pts, s, { terrain: flat, existing: null });
    const b = planPlacement(TREE, pts, s, { terrain: flat, existing: null });
    expect(a).toEqual(b);
    const c = planPlacement(TREE, pts, { ...s, seed: 8 }, { terrain: flat, existing: null });
    expect(c.map((p) => p.input.seed)).not.toEqual(a.map((p) => p.input.seed));
    for (const p of a) {
      expect(p.input.transform.scale[0]).toBeGreaterThanOrEqual(0.8);
      expect(p.input.transform.scale[0]).toBeLessThanOrEqual(1.3);
    }
  });

  it('random scale is clamped to the valid bounds', () => {
    const plan = planPlacement(TREE, [{ x: 0, z: 0 }, { x: 20, z: 0 }], settings({ scaleMin: 0.01, scaleMax: 50 }), { terrain: flat, existing: null });
    for (const p of plan) {
      expect(p.input.transform.scale[0]).toBeGreaterThanOrEqual(0.5);
      expect(p.input.transform.scale[0]).toBeLessThanOrEqual(2);
    }
  });
});

describe('line placement', () => {
  it('places objects every `spacing` meters along a polyline, facing along it', () => {
    const pts = lineLayout([[0, 0], [20, 0], [20, 10]], { spacing: 5, orient: 'along', yaw: 0, offset: 0 });
    expect(pathLength([[0, 0], [20, 0], [20, 10]])).toBe(30);
    expect(pts.map((p) => [round(p.x), round(p.z)])).toEqual([[0, 0], [5, 0], [10, 0], [15, 0], [20, 0], [20, 5], [20, 10]]);
    expect(round(pts[1].yaw)).toBe(0); // east: local +x along +x
    expect(round(pts[5].yaw)).toBe(round(-Math.PI / 2)); // south (+z)
  });

  it('across orientation, side offset and both sides', () => {
    const pts = lineLayout([[0, 0], [10, 0]], { spacing: 10, orient: 'across', yaw: 0, offset: 3, bothSides: true });
    expect(pts).toHaveLength(4);
    expect(pts.map((p) => round(p.z))).toEqual([3, -3, 3, -3]);
    expect(round(pts[0].yaw)).toBe(round(Math.PI / 2));
  });

  it('fixed heading ignores the path direction', () => {
    const pts = lineLayout([[0, 0], [0, 12]], { spacing: 4, orient: 'fixed', yaw: 1.25, offset: 0 });
    expect(pts).toHaveLength(4);
    for (const p of pts) expect(p.yaw).toBe(1.25);
  });
});

describe('area fill', () => {
  it('grid fill of a rectangle', () => {
    const pts = areaFill({ kind: 'rect', x0: 0, z0: 0, x1: 20, z1: 10 }, { mode: 'grid', spacing: 5, density: 0, jitter: 0, seed: 1 });
    expect(pts).toHaveLength(5 * 3);
    expect(pts[0]).toEqual([0, 0]);
  });

  it('random fill of a circle has about the requested density and respects spacing', () => {
    const shape = { kind: 'circle' as const, x: 10, z: -5, r: 25 };
    const pts = areaFill(shape, { mode: 'random', spacing: 1, density: 2, jitter: 0, seed: 9 });
    const per100 = (pts.length / (Math.PI * 625)) * 100;
    expect(per100).toBeGreaterThan(1.6);
    expect(per100).toBeLessThan(2.4);
    for (const p of pts) expect(shapeContains(shape, p[0], p[1])).toBe(true);
    expect(areaFill(shape, { mode: 'random', spacing: 1, density: 2, jitter: 0, seed: 9 })).toEqual(pts);
  });

  it('brush-painted (mask) area and world bounds', () => {
    const mask = { kind: 'mask' as const, discs: [{ x: WORLD_HALF - 2, z: 0, r: 6 }, { x: WORLD_HALF - 8, z: 4, r: 6 }] };
    const pts = areaFill(mask, { mode: 'grid', spacing: 2, density: 0, jitter: 0.3, seed: 2 });
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) {
      expect(shapeContains(mask, p[0], p[1])).toBe(true);
      expect(Math.abs(p[0])).toBeLessThanOrEqual(WORLD_HALF);
    }
  });

  it('slope limit skips steep ground', () => {
    const terrain = new TerrainSampler(generateTerrain('valley', 3));
    const pts = areaFill({ kind: 'rect', x0: -90, z0: -90, x1: 90, z1: 90 }, { mode: 'grid', spacing: 6, density: 0, jitter: 0, seed: 1 }).map(([x, z]) => ({ x, z }));
    const plan = planPlacement(TREE, pts, settings({ slopeLimit: 8, avoidCollisions: false }), { terrain, existing: null });
    const steep = plan.filter((p) => p.rejected === 'slope');
    expect(steep.length).toBeGreaterThan(0);
    for (const p of plan.filter((q) => q.ok)) expect(terrain.sampleSlope(p.input.transform.position[0], p.input.transform.position[2])).toBeLessThanOrEqual(8);
  });
});

describe('collision avoidance', () => {
  it('oriented footprints overlap test', () => {
    const a = { x: 0, z: 0, hx: 2, hz: 0.5, yaw: 0 };
    expect(footprintsOverlap(a, { x: 3.9, z: 0, hx: 2, hz: 0.5, yaw: 0 })).toBe(true);
    expect(footprintsOverlap(a, { x: 4.1, z: 0, hx: 2, hz: 0.5, yaw: 0 })).toBe(false);
    // Rotated 90°: a thin bar crossing the other one.
    expect(footprintsOverlap(a, { x: 0, z: 1.2, hx: 2, hz: 0.2, yaw: Math.PI / 2 })).toBe(true);
    expect(footprintsOverlap(a, { x: 0, z: 2.6, hx: 2, hz: 0.2, yaw: 0 })).toBe(false);
  });

  it('planned objects never overlap each other or existing objects when avoidance is on', () => {
    const existing = new FootprintIndex();
    const house = collisionFootprint('building', { floors: 2, width: 10, depth: 10 }, [1, 1, 1], 0, 0, 0)!;
    existing.add(house, 'house');
    const pts = areaFill({ kind: 'rect', x0: -20, z0: -20, x1: 20, z1: 20 }, { mode: 'random', spacing: 0.5, density: 8, jitter: 0, seed: 4 }).map(([x, z]) => ({ x, z }));
    const car = { type: 'car' as const, params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45 } };
    const plan = planPlacement(car, pts, settings(), { terrain: flat, existing });
    const ok = plan.filter((p) => p.ok);
    expect(ok.length).toBeGreaterThan(5);
    expect(plan.some((p) => p.rejected === 'collision')).toBe(true);
    const fps = ok.map((p) => collisionFootprint('car', p.input.params!, p.input.transform.scale, p.input.transform.position[0], p.input.transform.position[2], p.input.transform.rotation[1])!);
    for (let i = 0; i < fps.length; i++) {
      expect(footprintsOverlap(fps[i], house)).toBe(false);
      for (let j = i + 1; j < fps.length; j++) expect(footprintsOverlap(fps[i], fps[j])).toBe(false);
    }
    // Avoidance off: overlaps are allowed but reported.
    const loose = planPlacement(car, pts, settings({ avoidCollisions: false }), { terrain: flat, existing });
    expect(loose.every((p) => p.ok)).toBe(true);
    expect(loose.some((p) => p.warnings.includes('overlap'))).toBe(true);
  });
});

describe('placement on sloped terrain', () => {
  const terrain = new TerrainSampler(generateTerrain('gentleHills', 11));

  it('every planned object is seated by its category rule (no floating, nothing under the ground)', () => {
    const pts = areaFill({ kind: 'rect', x0: -80, z0: -80, x1: 80, z1: 80 }, { mode: 'grid', spacing: 9, density: 0, jitter: 0.4, seed: 3 }).map(([x, z]) => ({ x, z }));
    for (const item of [TREE, { type: 'human' as const }, { type: 'car' as const }, { type: 'wall' as const }, { type: 'streetLight' as const }, { type: 'building' as const, params: { floors: 3, width: 8, depth: 8 } }]) {
      const plan = planPlacement(item, pts, settings({ slopeLimit: 90, avoidCollisions: false }), { terrain, existing: null });
      for (const p of plan.filter((q) => q.ok)) {
        const obj = { type: item.type, params: p.input.params!, transform: p.input.transform };
        expect(isGrounded(obj, terrain)).toBe(true);
        const [x, y, z] = p.input.transform.position;
        // The base never sinks below the ground at the object's center (center / foundation
        // rules; 'min' walls & poles and 'mean' wheel planes are lower by design).
        if (item.type === 'tree' || item.type === 'human' || item.type === 'building') expect(y).toBeGreaterThanOrEqual(terrain.sampleHeight(x, z) - 1e-6);
        expect(checkPlacement(obj, terrain).warnings).not.toContain('floating');
      }
    }
  });

  it('terrain alignment: upright stays level, surface follows the slope', () => {
    // Find a sloped spot.
    let spot = { x: 0, z: 0 };
    for (let x = -80; x <= 80; x += 4) for (let z = -80; z <= 80; z += 4) if (terrain.sampleSlope(x, z) > terrain.sampleSlope(spot.x, spot.z)) spot = { x, z };
    expect(terrain.sampleSlope(spot.x, spot.z)).toBeGreaterThan(3);
    const [up] = planPlacement({ type: 'wall' }, [spot], settings({ align: 'upright', randomRotation: false, slopeLimit: 90 }), { terrain, existing: null });
    const [tilt] = planPlacement({ type: 'wall' }, [spot], settings({ align: 'surface', randomRotation: false, slopeLimit: 90 }), { terrain, existing: null });
    expect(Math.abs(up.input.transform.rotation[0]) + Math.abs(up.input.transform.rotation[2])).toBeLessThan(1e-9);
    expect(Math.abs(tilt.input.transform.rotation[0]) + Math.abs(tilt.input.transform.rotation[2])).toBeGreaterThan(0.02);
  });

  it('flags a corner floating above steep ground for level objects', () => {
    const steep = new TerrainSampler(generateTerrain('valley', 2));
    let spot = { x: 0, z: 0 };
    for (let x = -80; x <= 80; x += 3) for (let z = -80; z <= 80; z += 3) if (steep.sampleSlope(x, z) > steep.sampleSlope(spot.x, spot.z)) spot = { x, z };
    const human = { type: 'human' as const, params: { height: 1.75 }, transform: { position: [spot.x, 0, spot.z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [6, 6, 6] as [number, number, number] } };
    const pose = groundPose(human, spot.x, spot.z, 0, steep);
    const c = checkPlacement({ ...human, transform: { ...human.transform, position: pose.position } }, steep, 10);
    expect(c.warnings).toContain('slope');
    expect(c.gap).toBeGreaterThan(0);
  });
});

describe('multi-object edits in the world store', () => {
  beforeEach(resetWorld);

  it('a brush stroke of 100 trees is ONE undo step; redo restores the identical objects', () => {
    const pts = areaFill({ kind: 'rect', x0: -60, z0: -60, x1: 60, z1: 60 }, { mode: 'grid', spacing: 12, density: 0, jitter: 0, seed: 1 }).slice(0, 100).map(([x, z]) => ({ x, z }));
    const inputs = acceptedInputs(planPlacement(TREE, pts, settings(), { terrain: flat, existing: null }));
    expect(inputs).toHaveLength(100);
    const w = useWorldStore.getState();
    const ids = w.applyEdit({ add: inputs });
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    const placed = useWorldStore.getState().doc.objects;
    expect(useWorldStore.getState().past).toHaveLength(1);
    useWorldStore.getState().undo();
    expect(Object.keys(useWorldStore.getState().doc.objects)).toHaveLength(0);
    useWorldStore.getState().redo();
    expect(useWorldStore.getState().doc.objects).toEqual(placed);
  });

  it('an exception in the middle of an edit leaves no partially created objects', () => {
    const w = useWorldStore.getState();
    w.applyEdit({ add: [{ type: 'tree', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] });
    const before = useWorldStore.getState().doc;
    const pastLen = useWorldStore.getState().past.length;
    const bad = [
      { type: 'tree' as const, transform: { position: [5, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } },
      { type: 'nope' as never, transform: { position: [6, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } },
    ];
    expect(() => useWorldStore.getState().applyEdit({ add: bad })).toThrow();
    expect(useWorldStore.getState().doc).toBe(before);
    expect(useWorldStore.getState().past).toHaveLength(pastLen);
  });

  it('multi-object move, group rotation, duplicate and delete are single undo steps', () => {
    const pts = [[0, 0], [10, 0], [10, 10]].map(([x, z]) => ({ x, z }));
    const ids = useWorldStore.getState().applyEdit({ add: acceptedInputs(planPlacement({ type: 'car' }, pts, settings({ randomRotation: false }), { terrain: flat, existing: null })) });
    const objs = () => ids.map((id) => useWorldStore.getState().doc.objects[id]);
    const start = objs();
    const pivot = selectionPivot(start);
    const moved = transformObjects(start, pivot, { dx: 5, dy: 0, dz: -3, dyaw: 0 }, flat);
    useWorldStore.getState().applyEdit({ update: moved });
    const rotated = transformObjects(objs(), selectionPivot(objs()), { dx: 0, dy: 0, dz: 0, dyaw: Math.PI / 2 }, flat);
    useWorldStore.getState().applyEdit({ update: rotated });
    expect(useWorldStore.getState().past).toHaveLength(3);
    // Relative layout preserved by the rotation: pairwise distances unchanged.
    const d = (a: WorldObject, b: WorldObject) => Math.hypot(a.transform.position[0] - b.transform.position[0], a.transform.position[2] - b.transform.position[2]);
    expect(d(objs()[0], objs()[1])).toBeCloseTo(d(start[0], start[1]), 9);
    expect(d(objs()[0], objs()[2])).toBeCloseTo(d(start[0], start[2]), 9);
    for (const o of objs()) expect(yawOf(o.transform.rotation)).toBeCloseTo(Math.PI / 2, 9);
    useWorldStore.getState().undo();
    useWorldStore.getState().undo();
    expect(objs()).toEqual(start);
    useWorldStore.getState().applyEdit({ remove: ids });
    expect(Object.keys(useWorldStore.getState().doc.objects)).toHaveLength(0);
    useWorldStore.getState().undo();
    expect(objs()).toEqual(start);
  });

  it('edits are refused while the world is locked for a simulation', () => {
    useWorldStore.getState().setLocked(true);
    expect(useWorldStore.getState().applyEdit({ add: [{ type: 'tree', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] })).toEqual([]);
    useWorldStore.getState().undo();
    expect(Object.keys(useWorldStore.getState().doc.objects)).toHaveLength(0);
    useWorldStore.getState().setLocked(false);
  });
});

describe('group transform', () => {
  it('align and distribute', () => {
    resetWorld();
    const ids = useWorldStore.getState().applyEdit({
      add: [[0, 3], [7, -2], [20, 9]].map(([x, z]) => ({ type: 'human' as const, transform: { position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } })),
    });
    const objs = ids.map((id) => useWorldStore.getState().doc.objects[id]);
    const aligned = alignObjects(objs, 'z', 'max', flat);
    expect(aligned.map((o) => o.transform.position[2])).toEqual([9, 9, 9]);
    expect(aligned.map((o) => o.transform.position[0])).toEqual([0, 7, 20]);
    const spread = distributeObjects(objs, 'x', flat);
    expect(spread.map((o) => o.transform.position[0])).toEqual([0, 10, 20]);
  });

  it('on terrain, grounded members are re-seated after a group move', () => {
    const terrain = new TerrainSampler(generateTerrain('gentleHills', 4));
    const pts = [[-30, -30], [-22, -30], [-30, -20]].map(([x, z]) => ({ x, z }));
    const inputs = acceptedInputs(planPlacement({ type: 'car' }, pts, settings({ avoidCollisions: false, slopeLimit: 90 }), { terrain, existing: null }));
    const objs = inputs.map((inp, i) => ({ ...inp, id: `c${i}`, name: '', serial: i + 1, seed: 1, physics: {} as never, params: inp.params!, components: [] }) as WorldObject);
    const moved = transformObjects(objs, selectionPivot(objs), { dx: 40, dy: 0, dz: 35, dyaw: 0.7 }, terrain);
    for (const o of moved) expect(isGrounded(o, terrain)).toBe(true);
  });
});

describe('copy / paste (blueprint)', () => {
  beforeEach(resetWorld);

  it('preserves params, physics, seismic, relative transforms; new unique ids; groups remapped', () => {
    const w = useWorldStore.getState();
    const ids = w.applyEdit({
      add: [
        { type: 'building', params: { floors: 4, width: 9, depth: 7, color: '#aa3322' }, transform: { position: [0, 0, 0], rotation: [0, 0.4, 0], scale: [1, 1, 1] }, group: 'grpA' },
        { type: 'tree', transform: { position: [8, 0, 3], rotation: [0, 1, 0], scale: [1.2, 1.2, 1.2] }, group: 'grpA' },
        { type: 'streetLight', transform: { position: [-6, 2, 1], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    });
    const src = ids.map((id) => useWorldStore.getState().doc.objects[id]);
    src[0] = { ...src[0], physics: { ...src[0].physics, windResistance: 61 }, seismic: { ...src[0].seismic!, structure: { ...src[0].seismic!.structure, system: 'masonry' } } };
    useWorldStore.getState().applyEdit({ update: [src[0]] });
    const bp = parseBlueprint(serializeBlueprint(createBlueprint(src, flat)))!;
    expect(bp).not.toBeNull();
    const pasted1 = useWorldStore.getState().applyEdit({ add: instantiateBlueprint(bp, 50, 40, 0, flat) });
    const pasted2 = useWorldStore.getState().applyEdit({ add: instantiateBlueprint(bp, -50, 40, Math.PI / 2, flat) });
    const all = Object.keys(useWorldStore.getState().doc.objects);
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
    for (const id of [...pasted1, ...pasted2]) expect(ids).not.toContain(id);
    const get = (id: string) => useWorldStore.getState().doc.objects[id];
    const copies = pasted1.map(get);
    const b = copies.find((o) => o.type === 'building')!;
    expect(b.params.color).toBe('#aa3322');
    expect(b.params.floors).toBe(4);
    expect(b.physics.windResistance).toBe(61);
    expect(b.seismic!.structure.system).toBe('masonry');
    const lamp = copies.find((o) => o.type === 'streetLight')!;
    expect(lamp.transform.position[1]).toBeCloseTo(2, 9); // lifted object keeps its height
    const tree = copies.find((o) => o.type === 'tree')!;
    expect(tree.transform.scale).toEqual([1.2, 1.2, 1.2]);
    // Relative layout preserved (translation only).
    expect(tree.transform.position[0] - b.transform.position[0]).toBeCloseTo(8, 9);
    expect(tree.transform.position[2] - b.transform.position[2]).toBeCloseTo(3, 9);
    // Groups: copies form a NEW group, different per paste.
    expect(b.group).toBeDefined();
    expect(b.group).toBe(tree.group);
    expect(b.group).not.toBe('grpA');
    expect(get(pasted2.find((id) => get(id).type === 'building')!).group).not.toBe(b.group);
    expect(lamp.group).toBeUndefined();
    // Rotated paste: relative distance preserved, heading turned.
    const copies2 = pasted2.map(get);
    const b2 = copies2.find((o) => o.type === 'building')!;
    const t2 = copies2.find((o) => o.type === 'tree')!;
    expect(Math.hypot(t2.transform.position[0] - b2.transform.position[0], t2.transform.position[2] - b2.transform.position[2])).toBeCloseTo(Math.hypot(8, 3), 9);
    expect(yawOf(b2.transform.rotation)).toBeCloseTo(0.4 + Math.PI / 2, 9);
    // One undo removes one whole paste.
    useWorldStore.getState().undo();
    expect(Object.keys(useWorldStore.getState().doc.objects)).toHaveLength(6);
  });

  it('pasted grounded objects sit on the terrain at the new spot', () => {
    const terrain = samplerFor(generateTerrain('gentleHills', 6));
    const objs = acceptedInputs(planPlacement({ type: 'human' }, [{ x: -20, z: -20 }, { x: -16, z: -18 }], settings({ slopeLimit: 90 }), { terrain, existing: null }))
      .map((inp, i) => ({ ...inp, id: `h${i}`, name: '', serial: i + 1, seed: 1, physics: {} as never, params: inp.params!, components: [] }) as WorldObject);
    const bp = createBlueprint(objs, terrain);
    for (const inp of instantiateBlueprint(bp, 30, 25, 0.3, terrain)) {
      expect(isGrounded({ type: inp.type, params: inp.params!, transform: inp.transform }, terrain)).toBe(true);
    }
    expect(footprintOf({ type: 'road', params: {}, transform: objs[0].transform })).toBeNull();
  });
});

function round(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
}
