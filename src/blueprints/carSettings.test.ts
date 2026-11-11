/**
 * Phase 37 (§17): the stamp data carries the simulation settings of its cars — the copy / paste payload (v1,
 * editor/build/blueprint.ts) and the unified Blueprint (v2) — through capture, the file formats and the placement plan.
 * The copy rule itself: src/vehicle/carCopies.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { flatSampler } from '@/terrain/TerrainSampler';
import { createBlueprint, instantiateBlueprint, parseBlueprint, serializeBlueprint, stampKeys } from '@/editor/build/blueprint';
import type { VehicleCar } from '@/vehicle/settings';
import { captureBlueprint } from './capture';
import { defaultPlacement, planPlacement } from './place';
import { blueprintHash, exportValue, parseBlueprintText, parseBlueprintValue, serializeBlueprint as serializeUnified } from './schema';

const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });
const flat = flatSampler();

/** carA: drive + controls + program + autopilot. carB: a driver (p) and a front passenger (q). */
const CARS = (): Record<string, VehicleCar> => ({
  carA: { level: 'vehicle', drive: 'awd', abs: false, controls: { throttle: 0.4, gear: 'D' }, program: [{ t: 0, throttle: 1 }, { t: 4, brake: 1 }], autopilot: { path: [[0, 0], [40, 0], [40, 30]], speed: 8, loop: true } },
  carB: { drive: 'rwd', occupants: [{ human: 'p', seat: 'driver', restrained: true }, { human: 'q', seat: 'front', restrained: false }] },
});

/** Two cars, the driver of the second, a wall — with ids so the source order is known. */
function sourceObjects() {
  const mk = (type: 'car' | 'human' | 'wall' | 'tree', id: string, serial: number, x: number) => ({ ...createWorldObject({ type, transform: at(x, 0) }, serial), id });
  return [mk('wall', 'w', 1, 12), mk('human', 'p', 1, 6), mk('car', 'carB', 2, 4), mk('car', 'carA', 1, 0)];
}

describe('copy / paste payload (v1) carries the car settings', () => {
  it('keyed by the object\'s index in the blueprint; instantiate order = blueprint order', () => {
    const objs = sourceObjects();
    const bp = createBlueprint(objs, flat, '', undefined, CARS());
    // Sorted by type → serial → id: carA, carB, human, wall.
    expect(bp.objects.map((o) => o.type)).toEqual(['car', 'car', 'human', 'wall']);
    expect(Object.keys(bp.cars!)).toEqual(['0', '1']);
    expect(bp.cars!['0']).toEqual(CARS().carA);
    expect(bp.cars!['1']).toEqual({ drive: 'rwd', occupants: [{ human: '2', seat: 'driver', restrained: true }] }); // q was not copied
    expect(stampKeys(bp)).toEqual(['0', '1', '2', '3']);
    expect(instantiateBlueprint(bp, 50, 50, 0, flat).map((i) => i.type)).toEqual(bp.objects.map((o) => o.type));
  });

  it('absent when no copied car has settings: the blueprint serializes as before', () => {
    const objs = sourceObjects();
    const plain = createBlueprint(objs, flat);
    expect('cars' in plain).toBe(false);
    expect(serializeBlueprint(plain)).not.toContain('"cars"');
    // Settings of cars that were NOT copied do not travel either.
    const wallOnly = createBlueprint(objs.filter((o) => o.type === 'wall'), flat, '', undefined, CARS());
    expect('cars' in wallOnly).toBe(false);
    expect(serializeBlueprint(createBlueprint(objs, flat, '', undefined, {}))).toBe(serializeBlueprint(plain));
  });

  it('JSON round trip keeps them; an invalid entry is dropped alone; entries follow their objects when one is left out', () => {
    const bp = createBlueprint(sourceObjects(), flat, '', undefined, CARS());
    const text = serializeBlueprint(bp);
    const back = parseBlueprint(text)!;
    expect(back).toEqual(bp);
    expect(serializeBlueprint(parseBlueprint(serializeBlueprint(back))!)).toBe(serializeBlueprint(back));
    const raw = JSON.parse(text);
    raw.cars['0'] = { drive: 'hover' }; // not a drive
    expect(parseBlueprint(JSON.stringify(raw))!.cars).toEqual({ '1': bp.cars!['1'] });
    // An object of an unknown type in front: the others move down one index, and so do the car entries.
    const shifted = JSON.parse(text);
    shifted.objects.unshift({ ...shifted.objects[3], type: 'spaceship' });
    shifted.cars = { '1': bp.cars!['0'], '2': { ...bp.cars!['1'], occupants: [{ human: '3', seat: 'driver', restrained: true }] } };
    const p = parseBlueprint(JSON.stringify(shifted))!;
    expect(p.objects.map((o) => o.type)).toEqual(['car', 'car', 'human', 'wall']);
    expect(p.cars).toEqual(bp.cars);
  });
});

describe('unified Blueprint (v2) carries the car settings', () => {
  function worldDoc() {
    const doc = createEmptyDocument();
    for (const o of sourceObjects()) doc.objects[o.id] = o;
    doc.objects.q = { ...createWorldObject({ type: 'human', transform: at(60, 60) }, 2), id: 'q' };
    doc.settings.simulation.vehicles = { model: 'dynamics', cars: CARS() };
    return doc;
  }
  const capture = (doc = worldDoc()) => captureBlueprint(doc, { shape: null, objects: ['carA', 'carB', 'p', 'w'] }, { id: 'bp_cars', now: '2026-11-11T00:00:00.000Z' }).blueprint;

  it('capture: keyed by local object ids, occupants only of captured people', () => {
    const bp = capture();
    const local = (type: string, n = 0) => bp.objects.filter((o) => o.type === type)[n].id;
    expect(Object.keys(bp.cars!).sort()).toEqual([local('car', 0), local('car', 1)].sort());
    expect(bp.cars![local('car', 0)]).toEqual(CARS().carA);
    expect(bp.cars![local('car', 1)]).toEqual({ drive: 'rwd', occupants: [{ human: local('human'), seat: 'driver', restrained: true }] });
  });

  it('save → parse → save is byte-identical; a blueprint without car settings has no `cars` field and the same hash as before', () => {
    const bp = capture();
    const text = serializeUnified(bp);
    const r = parseBlueprintText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.unsupported).toEqual([]);
    expect(r.blueprint.cars).toEqual(bp.cars);
    expect(serializeUnified(r.blueprint)).toBe(text);
    // The same world without vehicle settings: no field, and the hash does not see the new format.
    const doc = worldDoc();
    const { vehicles: _v, ...simulation } = doc.settings.simulation;
    void _v;
    const plain = capture({ ...doc, settings: { ...doc.settings, simulation } });
    expect('cars' in plain).toBe(false);
    expect('cars' in exportValue(plain)).toBe(false);
    expect(serializeUnified(plain)).not.toContain('"cars"');
    const { cars: _c, ...stripped } = capture(doc);
    void _c;
    expect(blueprintHash(stripped)).toBe(blueprintHash(plain));
    expect(blueprintHash(capture(doc))).not.toBe(blueprintHash(plain));
  });

  it('a file: invalid entries and entries of objects that are not in the blueprint are left out and reported', () => {
    const bp = capture();
    const raw = JSON.parse(serializeUnified(bp));
    const [carKey] = Object.keys(bp.cars!).filter((k) => !bp.cars![k].occupants);
    raw.cars[carKey] = { autopilot: { path: [[0, 0]], speed: 5 } }; // a path needs two points
    raw.cars.o99 = { drive: 'awd' };
    const r = parseBlueprintValue(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.blueprint.cars!)).toEqual(Object.keys(bp.cars!).filter((k) => k !== carKey));
    expect(r.report.unsupported).toEqual(['cars[] (invalid entry or missing object, dropped)']);
    // The whole field unreadable: the blueprint still loads, without car settings.
    const broken = parseBlueprintValue({ ...JSON.parse(serializeUnified(bp)), cars: 'yes' });
    expect(broken.ok && !('cars' in broken.blueprint)).toBe(true);
    expect(broken.ok && broken.report.unsupported).toEqual(['cars[] (invalid entry or missing object, dropped)']);
  });

  it('placement plan: `items` names the blueprint item of every added object (left-out items have none)', () => {
    const doc = worldDoc();
    const bp = capture(doc);
    const plan = planPlacement(doc, bp, { ...defaultPlacement(), x: 40, z: -40 });
    expect(plan.items).toEqual(bp.objects.map((o) => o.id));
    expect(plan.items).toHaveLength(plan.edit.add.length);
    plan.items.forEach((id, k) => expect(plan.edit.add[k].type).toBe(bp.objects.find((o) => o.id === id)!.type));
    // Half outside the world: only the items inside are planned, and `items` still lines up with `add`.
    const edge = planPlacement(doc, bp, { ...defaultPlacement(), x: 99, z: 0 });
    expect(edge.report.warnings.some((w) => w.code === 'objectsOutside')).toBe(true);
    expect(edge.items.length).toBe(edge.edit.add.length);
    expect(edge.items.length).toBeLessThan(bp.objects.length);
    edge.items.forEach((id, k) => expect(edge.edit.add[k].type).toBe(bp.objects.find((o) => o.id === id)!.type));
  });

  it('a v1 payload migrated to v2 keeps the car settings under the local ids', () => {
    const v1 = createBlueprint(sourceObjects(), flat, 'legacy', undefined, CARS());
    const r = parseBlueprintText(serializeBlueprint(v1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.migratedFrom).toBe('v1');
    const bp = r.blueprint;
    expect(bp.objects.map((o) => o.type)).toEqual(['car', 'car', 'human', 'wall']);
    expect(bp.cars).toEqual({ o1: CARS().carA, o2: { drive: 'rwd', occupants: [{ human: 'o3', seat: 'driver', restrained: true }] } });
  });
});
