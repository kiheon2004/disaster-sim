/**
 * Phase 37 (§17): common-field editing of a multi-selection — `setCommonTransform` / `commonTransform`
 * (numericTransform.ts), shared by the MultiInspector fields and the command `set <target> x=…`, and the selection
 * action that commits it as one undo step.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { WORLD_HALF } from '@/core/units';
import { createEmptyDocument, createWorldObject, type CreateObjectInput } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { createFlatTerrain, MIN_ELEVATION } from '@/terrain/TerrainData';
import { TerrainSampler, flatSampler, samplerFor } from '@/terrain/TerrainSampler';
import { groundPose, isGrounded, yawOf } from '@/terrain/groundPlacement';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { setSelectionCommon } from '@/app/buildActions';
import { moveTo } from './groupTransform';
import { commonTransform, displayRotation, heightAboveGround, MAX_TYPED_Y, sanitizePosition, setCommonTransform, storedRotation, withHeightAboveGround } from './numericTransform';

const flat = flatSampler();
let serial = 0;
const obj = (type: CreateObjectInput['type'], x: number, y: number, z: number, extra: Partial<CreateObjectInput> = {}, id = `${type}${++serial}`): WorldObject =>
  ({ ...createWorldObject({ type, transform: { ...identityTransform(), position: [x, y, z] as Vec3 }, ...extra }, serial), id });
const byId = (objs: readonly WorldObject[]) => new Map(objs.map((o) => [o.id, o]));

/** The plane y = 0.1·x + 10 (a 10 % slope rising toward +x). */
function slope(): TerrainSampler {
  const t = createFlatTerrain();
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = 0.1 * (t.originX + ix * t.cellSize) + 10;
  t.revision++;
  return new TerrainSampler(t);
}
const ground = (x: number) => 0.1 * x + 10;

describe('setCommonTransform — values', () => {
  it('x / z / y: the same value in that field of every object; other fields and unchanged objects are left alone', () => {
    const a = obj('wall', 1, 0, 2), b = obj('tree', -4, 0, 9), c = obj('crate', 7, 3, -5);
    const rx = setCommonTransform([a, b, c], { x: 7 }, flat);
    expect(rx.objects.map((o) => o.id)).toEqual([a.id, b.id]); // c is already at x = 7
    for (const o of rx.objects) expect(o.transform.position[0]).toBe(7);
    expect(byId(rx.objects).get(a.id)!.transform.position).toEqual([7, 0, 2]);
    expect(byId(rx.objects).get(b.id)!.transform).toEqual({ ...b.transform, position: [7, 0, 9] });
    const rz = setCommonTransform([a, b, c], { z: -1.5 }, flat);
    expect(rz.objects.map((o) => o.transform.position)).toEqual([[1, 0, -1.5], [-4, 0, -1.5], [7, 3, -1.5]]);
    const ry = setCommonTransform([a, b, c], { y: 3 }, flat);
    expect(ry.objects.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(ry.objects.map((o) => o.transform.position[1])).toEqual([3, 3]);
    // Several fields at once; the inputs are never modified.
    const all = setCommonTransform([a, b, c], { x: 0, z: 0, y: 1 }, flat);
    expect(all.objects.map((o) => o.transform.position)).toEqual([[0, 1, 0], [0, 1, 0], [0, 1, 0]]);
    expect(a.transform.position).toEqual([1, 0, 2]);
    expect(setCommonTransform([a, b, c], {}, flat)).toEqual({ objects: [], locked: 0, clamped: [], rejected: [], keptSize: 0 });
  });

  it('heading: the Y heading the Inspector shows — each object keeps its own tilt', () => {
    const upright = obj('wall', 0, 0, 0);
    const tilted = obj('crate', 5, 4, 0, { transform: { ...identityTransform(), position: [5, 4, 0], rotation: storedRotation([20, 45, -10]) } });
    const r = setCommonTransform([upright, tilted], { heading: 120 }, flat);
    expect(r.objects).toHaveLength(2);
    const [u, t] = r.objects.map((o) => displayRotation(o.transform.rotation));
    expect(u[0]).toBeCloseTo(0, 9); expect(u[1]).toBeCloseTo(120, 9); expect(u[2]).toBeCloseTo(0, 9);
    expect(t[0]).toBeCloseTo(20, 9); expect(t[1]).toBeCloseTo(120, 9); expect(t[2]).toBeCloseTo(-10, 9);
    // Exactly what the single-object field writes.
    expect(r.objects[1].transform.rotation).toEqual(storedRotation([displayRotation(tilted.transform.rotation)[0], 120, displayRotation(tilted.transform.rotation)[2]]));
    // Position untouched; the same heading again (also a whole turn later) changes nothing.
    expect(r.objects[1].transform.position).toEqual([5, 4, 0]);
    expect(setCommonTransform(r.objects, { heading: 120 }, flat).objects).toEqual([]);
    expect(setCommonTransform(r.objects, { heading: 480 }, flat).objects).toEqual([]);
    expect(setCommonTransform(r.objects, { heading: -240 }, flat).objects).toEqual([]);
  });

  it('scale: one factor on all three axes; modular buildings keep their size', () => {
    const a = obj('crate', 0, 0, 0), b = obj('tree', 4, 0, 0, { transform: { ...identityTransform(), position: [4, 0, 0], scale: [1, 2, 3] } });
    const house = obj('building', 20, 0, 0, { building: createDesign(presetSpec('house')!, 'house') });
    const r = setCommonTransform([a, b, house], { scale: 1.5 }, flat);
    expect(r.objects.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(r.objects.map((o) => o.transform.scale)).toEqual([[1.5, 1.5, 1.5], [1.5, 1.5, 1.5]]);
    expect(r.keptSize).toBe(1);
    // …but the building takes a position like everything else.
    const moved = setCommonTransform([a, house], { x: 9 }, flat);
    expect(moved.objects.map((o) => o.transform.position[0])).toEqual([9, 9]);
    expect(moved.keptSize).toBe(0);
  });

  it('lift: the height above the ground under EACH object (0 = standing on it)', () => {
    const s = slope();
    const low = obj('human', -50, ground(-50), 0), high = obj('human', 50, ground(50) + 2, 0);
    const r = setCommonTransform([low, high], { lift: 0.5 }, s);
    expect(r.objects).toHaveLength(2);
    expect(r.objects[0].transform.position[1]).toBeCloseTo(ground(-50) + 0.5, 6);
    expect(r.objects[1].transform.position[1]).toBeCloseTo(ground(50) + 0.5, 6);
    expect(r.objects[1].transform.position).toEqual(withHeightAboveGround(high, 0.5, s)); // the single-object rule
    for (const o of r.objects) expect(heightAboveGround(o, s)).toBeCloseTo(0.5, 6);
    // lift 0 puts both on the ground; given together with y, lift wins (applied last).
    const down = setCommonTransform([low, high], { y: 99, lift: 0 }, s);
    expect(down.objects.map((o) => o.id)).toEqual([high.id]);
    expect(down.objects[0].transform.position[1]).toBeCloseTo(ground(50), 6);
  });
});

describe('setCommonTransform — bounds and bad input', () => {
  it('x / z stay inside the world square, y / lift inside the elevation range; what was limited is named', () => {
    const a = obj('wall', 1, 0, 2), b = obj('tree', -4, 0, 9);
    const r = setCommonTransform([a, b], { x: 500, z: -1e9 }, flat);
    expect(r.objects.map((o) => o.transform.position)).toEqual([[WORLD_HALF, 0, -WORLD_HALF], [WORLD_HALF, 0, -WORLD_HALF]]);
    expect(r.clamped).toEqual(['x', 'z']);
    // The single-object rule, value for value.
    expect(r.objects[0].transform.position).toEqual(sanitizePosition([500, 0, -1e9], a.transform.position).value);
    const low = setCommonTransform([a, b], { y: -999 }, flat);
    expect(low.objects.map((o) => o.transform.position[1])).toEqual([MIN_ELEVATION, MIN_ELEVATION]);
    expect(low.clamped).toEqual(['y']);
    const high = setCommonTransform([a, b], { lift: 1e6 }, flat);
    expect(high.objects.map((o) => o.transform.position[1])).toEqual([MAX_TYPED_Y, MAX_TYPED_Y]);
    expect(high.clamped).toEqual(['lift']);
    expect(setCommonTransform([a, b], { x: 99.5 }, flat).clamped).toEqual([]);
  });

  it('scale is limited to 0.1–10', () => {
    const a = obj('crate', 0, 0, 0);
    const big = setCommonTransform([a], { scale: 50 }, flat);
    expect(big.objects[0].transform.scale).toEqual([10, 10, 10]);
    expect(big.clamped).toEqual(['scale']);
    expect(setCommonTransform([a], { scale: 0 }, flat).objects[0].transform.scale).toEqual([0.1, 0.1, 0.1]);
    expect(setCommonTransform([a], { scale: 1 }, flat)).toMatchObject({ objects: [], clamped: [] });
  });

  it('a value that is not a number is ignored and named; the other fields of the patch still apply', () => {
    const a = obj('wall', 1, 0, 2), b = obj('tree', -4, 0, 9);
    const r = setCommonTransform([a, b], { x: NaN, y: Infinity, heading: NaN, scale: -Infinity, lift: NaN }, flat);
    expect(r.objects).toEqual([]);
    expect(r.rejected).toEqual(['x', 'y', 'lift', 'heading', 'scale']);
    const mixed = setCommonTransform([a, b], { x: NaN, z: 4 }, flat);
    expect(mixed.rejected).toEqual(['x']);
    expect(mixed.objects.map((o) => o.transform.position)).toEqual([[1, 0, 4], [-4, 0, 4]]);
    for (const o of mixed.objects) for (const v of [...o.transform.position, ...o.transform.rotation, ...o.transform.scale]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('setCommonTransform — locked objects', () => {
  it('are skipped and counted; the others take the value', () => {
    const a = obj('wall', 1, 0, 2), locked = { ...obj('wall', 2, 0, 2), locked: true }, hidden = { ...obj('wall', 3, 0, 2), hidden: true };
    const r = setCommonTransform([a, locked, hidden], { x: 10, heading: 90, scale: 2, lift: 1 }, flat);
    expect(r.locked).toBe(1);
    expect(r.objects.map((o) => o.id)).toEqual([a.id, hidden.id]); // hidden objects are edited like the visible ones
    expect(setCommonTransform([locked], { x: 10 }, flat)).toMatchObject({ objects: [], locked: 1 });
  });
});

describe('setCommonTransform — the ground', () => {
  it('x / z changed on a slope: objects that stood on the ground are re-seated at the new spot, lifted ones keep their height', () => {
    const s = slope();
    const person = obj('human', -40, ground(-40), 5);
    const wall = obj('wall', -20, 0, 20);
    const seatedWall = { ...wall, transform: { ...wall.transform, ...groundPose(wall, -20, 20, 0, s) } };
    const drone = obj('crate', -30, ground(-30) + 6, -10); // lifted 6 m
    expect(isGrounded(person, s) && isGrounded(seatedWall, s)).toBe(true);
    expect(isGrounded(drone, s)).toBe(false);

    const r = setCommonTransform([person, seatedWall, drone], { x: 30 }, s);
    const m = byId(r.objects);
    expect(r.objects).toHaveLength(3);
    // The person stands on the ground 7 m higher up the slope.
    expect(m.get(person.id)!.transform.position[0]).toBe(30);
    expect(m.get(person.id)!.transform.position[1]).toBeCloseTo(ground(30), 6);
    expect(m.get(person.id)!.transform.position[1] - person.transform.position[1]).toBeCloseTo(7, 6);
    // Every grounded object is still grounded, by its own seat rule (a wall sits on its lowest footprint corner).
    for (const o of [m.get(person.id)!, m.get(seatedWall.id)!]) expect(isGrounded(o, s)).toBe(true);
    expect(m.get(seatedWall.id)!.transform.position).toEqual(groundPose(seatedWall, 30, 20, 0, s).position);
    // The lifted one keeps its absolute height (it is now 0 m, not 6 m, above the slope there).
    expect(m.get(drone.id)!.transform.position).toEqual([30, ground(-30) + 6, -10]);
    // The same rule as a group move / align (`moveTo`), object for object.
    for (const o of [person, seatedWall, drone]) expect(m.get(o.id)).toEqual(moveTo(o, 30, o.transform.position[2], s));
  });

  it('a car follows the slope where it lands; with a new heading in the same edit it is seated for that heading', () => {
    const s = slope();
    const car0 = obj('car', -40, 0, 0);
    const car = { ...car0, transform: { ...car0.transform, ...groundPose(car0, -40, 0, 0, s) } };
    expect(car.transform.rotation).not.toEqual([0, 0, 0]); // tilted with the slope
    const moved = setCommonTransform([car], { z: 30 }, s).objects[0];
    expect(moved.transform).toEqual({ ...car.transform, ...groundPose(car, -40, 30, yawOf(car.transform.rotation), s) });
    const turned = setCommonTransform([car], { x: 10, heading: 90 }, s).objects[0];
    expect(yawOf(turned.transform.rotation)).toBeCloseTo(Math.PI / 2, 6);
    expect(isGrounded(turned, s)).toBe(true);
    expect(turned.transform.position[1]).toBeCloseTo(ground(10), 6);
  });

  it('heading alone does not seat the object again (the single-object field rule): the typed heading reads back exactly', () => {
    const s = slope();
    const car0 = obj('car', -40, 0, 0);
    const car = { ...car0, transform: { ...car0.transform, ...groundPose(car0, -40, 0, 0, s) } };
    const d = displayRotation(car.transform.rotation);
    const turned = setCommonTransform([car], { heading: 37.5 }, s).objects[0];
    expect(turned.transform.position).toBe(car.transform.position);
    expect(turned.transform.rotation).toEqual(storedRotation([d[0], 37.5, d[2]]));
    expect(commonTransform([turned], s).heading).toBeCloseTo(37.5, 9);
    // Scale alone leaves the position alone too.
    const scaled = setCommonTransform([car], { scale: 2 }, s).objects[0];
    expect(scaled.transform.position).toBe(car.transform.position);
    expect(scaled.transform.rotation).toBe(car.transform.rotation);
  });

  it('on flat ground a move keeps the rotation exactly (also a tilt the user gave)', () => {
    const tilted = obj('wall', 0, 0, 0, { transform: { ...identityTransform(), position: [0, 0, 0], rotation: storedRotation([0, 30, 8]) } });
    const r = setCommonTransform([tilted], { x: 12, z: -3 }, flat).objects[0];
    expect(r.transform.rotation).toBe(tilted.transform.rotation);
    expect(r.transform.position).toEqual([12, 0, -3]);
  });

  it('a moved building lets go of a frozen foundation plinth (as every user move does)', () => {
    const design = createDesign(presetSpec('house')!, 'house');
    const frozen = obj('building', 0, 0, 0, { building: { ...design, options: { ...design.options, plinthDepth: 0.4 } } });
    expect(frozen.building!.options.plinthDepth).toBe(0.4);
    const r = setCommonTransform([frozen], { x: 6 }, flat);
    expect(r.objects[0].building!.options.plinthDepth).toBeNull();
    expect(setCommonTransform([frozen], { heading: 90 }, flat).objects[0].building!.options.plinthDepth).toBeNull();
    expect(setCommonTransform([frozen], { x: 0 }, flat).objects).toEqual([]); // nothing changed → nothing released
  });
});

describe('commonTransform — what a field shows', () => {
  it('the value when every object agrees, null (mixed) when they differ', () => {
    const a = obj('wall', 3, 0, 2), b = obj('tree', 3, 0, 9), c = obj('crate', 3, 4, -5, { transform: { ...identityTransform(), position: [3, 4, -5], scale: [2, 2, 2] } });
    expect(commonTransform([a, b], flat)).toEqual({ x: 3, y: 0, z: null, lift: 0, heading: 0, scale: 1 });
    expect(commonTransform([a, b, c], flat)).toEqual({ x: 3, y: null, z: null, lift: null, heading: 0, scale: null });
    expect(commonTransform([], flat)).toEqual({ x: null, y: null, z: null, lift: null, heading: null, scale: null });
    expect(commonTransform([c], flat)).toMatchObject({ x: 3, y: 4, z: -5, lift: 4, scale: 2 });
  });

  it('headings agree up to whole turns; a non-uniform scale is mixed; float noise is not a difference', () => {
    const turn = (deg: number) => obj('wall', 0, 0, 0, { transform: { ...identityTransform(), rotation: storedRotation([0, deg, 0]) } });
    expect(commonTransform([turn(180), turn(-180)], flat).heading).not.toBeNull();
    expect(commonTransform([turn(30), turn(31)], flat).heading).toBeNull();
    const stretched = obj('crate', 0, 0, 0, { transform: { ...identityTransform(), scale: [1, 2, 1] } });
    expect(commonTransform([stretched], flat).scale).toBeNull();
    const noisy = obj('wall', 0.1 + 0.2, 0, 0), exact = obj('wall', 0.3, 0, 0);
    expect(commonTransform([noisy, exact], flat).x).toBeCloseTo(0.3, 9);
  });

  it('after a common edit the field reads the value back (on a slope too)', () => {
    const s = slope();
    const objs = [obj('human', -40, ground(-40), 5), obj('crate', 20, ground(20) + 3, -8), obj('wall', 0, 30, 0)];
    const apply = (list: WorldObject[], patch: Parameters<typeof setCommonTransform>[1]) => {
      const changed = byId(setCommonTransform(list, patch, s).objects);
      return list.map((o) => changed.get(o.id) ?? o);
    };
    let cur = apply(objs, { lift: 1.25 });
    expect(commonTransform(cur, s).lift).toBeCloseTo(1.25, 6);
    expect(commonTransform(cur, s).y).toBeNull();
    cur = apply(cur, { heading: -45 });
    expect(commonTransform(cur, s).heading).toBeCloseTo(-45, 6);
    cur = apply(cur, { scale: 0.5 });
    expect(commonTransform(cur, s).scale).toBe(0.5);
    cur = apply(cur, { x: 12, z: 12 });
    expect(commonTransform(cur, s)).toMatchObject({ x: 12, z: 12 });
  });
});

describe('setSelectionCommon — the selection action (MultiInspector fields)', () => {
  const W = () => useWorldStore.getState();
  const ED = () => useEditorStore.getState();
  const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });
  beforeEach(() => {
    W().setLocked(false);
    W().replaceDocument(createEmptyDocument());
    ED().setMode('editor');
    ED().setSelection([]);
  });

  it('one undo step for the whole selection; locked objects stay; nothing changed → no step', () => {
    const ids = W().applyEdit({ add: [{ type: 'wall', transform: at(1, 2) }, { type: 'tree', transform: at(-4, 9) }, { type: 'crate', transform: at(7, -5) }] });
    W().applyEdit({ update: [{ ...W().doc.objects[ids[2]], locked: true }] });
    ED().setSelection(ids);
    const objects0 = W().doc.objects;
    const steps = W().past.length;

    const r = setSelectionCommon({ x: 20 })!;
    expect(r.locked).toBe(1);
    expect(W().past.length).toBe(steps + 1);
    expect(ids.map((id) => W().doc.objects[id].transform.position[0])).toEqual([20, 20, 7]);
    expect(commonTransform(ids.slice(0, 2).map((id) => W().doc.objects[id]), samplerFor(W().doc.terrain)).x).toBe(20);

    expect(setSelectionCommon({ x: 20 })!.objects).toEqual([]);
    expect(W().past.length).toBe(steps + 1); // already there: no empty step
    W().undo();
    expect(W().doc.objects).toBe(objects0);
    W().redo();
    expect(ids.map((id) => W().doc.objects[id].transform.position[0])).toEqual([20, 20, 7]);
  });

  it('a label scrub is one transaction: live writes record nothing, the release is one step (none when nothing moved)', () => {
    const ids = W().applyEdit({ add: [{ type: 'wall', transform: at(1, 2) }, { type: 'tree', transform: at(-4, 9) }] });
    ED().setSelection(ids);
    const steps = W().past.length;
    W().beginTransaction();
    for (const v of [0.5, 1, 1.5, 2]) setSelectionCommon({ lift: v }, true);
    expect(W().past.length).toBe(steps);
    expect(W().commitTransaction()).toBe(true);
    expect(W().past.length).toBe(steps + 1);
    expect(ids.map((id) => W().doc.objects[id].transform.position[1])).toEqual([2, 2]);
    W().undo();
    expect(ids.map((id) => W().doc.objects[id].transform.position[1])).toEqual([0, 0]);
    W().beginTransaction();
    setSelectionCommon({ lift: 0 }, true);
    expect(W().commitTransaction()).toBe(false);
    expect(W().past.length).toBe(steps);
  });

  it('a road-linked object moved by a common field has its link re-measured by the store', () => {
    const net = drawRoad(W().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() });
    W().applyEdit({ roads: net.network });
    const seg = net.segments[0];
    const ids = W().applyEdit({ add: [
      { type: 'streetLight', transform: at(-20, 6), roadLink: { segment: seg, t: 0.33, lateral: 6, yaw: 0, policy: 'follow' } },
      { type: 'streetLight', transform: at(-10, 6), roadLink: { segment: seg, t: 0.42, lateral: 6, yaw: 0, policy: 'follow' } },
    ] });
    ED().setSelection(ids);
    setSelectionCommon({ x: 25 });
    for (const id of ids) expect(W().doc.objects[id].roadLink!.t).toBeGreaterThan(0.6);
    setSelectionCommon({ z: 80 }); // far from every road: the links are dropped, the objects stay
    for (const id of ids) expect(W().doc.objects[id].roadLink).toBeUndefined();
  });

  it('refused outside the editor and while a simulation holds the document', () => {
    const ids = W().applyEdit({ add: [{ type: 'wall', transform: at(1, 2) }, { type: 'tree', transform: at(-4, 9) }] });
    ED().setSelection(ids);
    const doc0 = W().doc;
    W().setLocked(true);
    expect(setSelectionCommon({ x: 5 })).toBeNull();
    W().setLocked(false);
    ED().setMode('simulation');
    expect(setSelectionCommon({ x: 5 })).toBeNull();
    expect(W().doc).toBe(doc0);
    ED().setMode('editor');
  });
});
