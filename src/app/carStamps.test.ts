/**
 * Phase 37 (§17, S18): the simulation settings of cars follow every stamp path — duplicate of a selection (Ctrl+D),
 * copy / paste, Blueprint capture → placement, a template applied over the current world. The copies get the settings
 * in the SAME undo step as the objects; occupants are kept only for people copied along (re-pointed to the copy).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EntityId, Vec3 } from '@/core/types';
import { identityTransform } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { emptyPlace, useBlueprintStore } from '@/editor/blueprintStore';
import { captureBlueprint } from '@/blueprints/capture';
import { parseBlueprintText, serializeBlueprint } from '@/blueprints/schema';
import { MemoryBackend, useLibraryStore } from '@/blueprints/library';
import { createTemplate } from '@/templates/template';
import type { VehicleCar } from '@/vehicle/settings';
import { applyStamp } from '@/world/stamp';
import { clickSelect, copySelection, duplicateSelection, pasteAt } from './buildActions';
import { applyTemplate, confirmPlacement } from './blueprintActions';

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
});

const W = () => useWorldStore.getState();
const ED = () => useEditorStore.getState();
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });
const carsOf = (doc: WorldDocument = W().doc) => doc.settings.simulation.vehicles?.cars ?? {};
const typeIds = (ids: readonly EntityId[], type: string) => ids.filter((id) => W().doc.objects[id].type === type);

const AUTOPILOT = { path: [[0, 0], [40, 0], [40, 30]] as [number, number][], speed: 8, loop: true };

interface Scene { carA: EntityId; carB: EntityId; driver: EntityId; passenger: EntityId; wall: EntityId; group: EntityId[] }

/**
 * A group of two cars and the driver of the second: carA drives an autopilot path, carB has a driver (in the group)
 * and a front passenger (NOT in the group). A wall stands apart. `vehicles: false` = a document with legacy cars.
 */
function scene(vehicles = true): Scene {
  const [carA, carB, driver, passenger, wall] = W().applyEdit({ add: [
    { type: 'car', transform: at(0, 0) },
    { type: 'car', transform: at(0, 6) },
    { type: 'human', transform: at(3, 6) },
    { type: 'human', transform: at(30, 30) },
    { type: 'wall', transform: at(-30, -30) },
  ] });
  const objs = W().doc.objects;
  const group = [carA, carB, driver];
  W().applyEdit({ update: group.map((id) => ({ ...objs[id], group: 'grp_cars' })) });
  if (vehicles) {
    const cars: Record<string, VehicleCar> = {
      [carA]: { drive: 'awd', controls: { throttle: 0.3, gear: 'D' }, autopilot: structuredClone(AUTOPILOT) },
      [carB]: { drive: 'rwd', abs: false, occupants: [{ human: driver, seat: 'driver', restrained: true }, { human: passenger, seat: 'front', restrained: false }] },
    };
    W().updateSimulationSettings({ vehicles: { model: 'dynamics', cars } });
  }
  return { carA, carB, driver, passenger, wall, group };
}

/** The copies of a stamp, by role: cars in source order (carA's copy stands at the smaller z), and the person. */
function copies(ids: readonly EntityId[]) {
  const cars = typeIds(ids, 'car').sort((a, b) => W().doc.objects[a].transform.position[2] - W().doc.objects[b].transform.position[2]);
  return { carA: cars[0], carB: cars[1], driver: typeIds(ids, 'human')[0] };
}

/** What every stamp of the group must give: settings on the new ids, the driver re-pointed, the passenger dropped. */
function expectCopied(s: Scene, ids: readonly EntityId[], sourceCars: Record<string, VehicleCar> = carsOf()) {
  expect(ids).toHaveLength(3);
  const c = copies(ids);
  const cars = carsOf();
  expect(cars[c.carA]).toEqual({ drive: 'awd', controls: { throttle: 0.3, gear: 'D' }, autopilot: AUTOPILOT });
  expect(cars[c.carB]).toEqual({ drive: 'rwd', abs: false, occupants: [{ human: c.driver, seat: 'driver', restrained: true }] });
  expect(c.driver).not.toBe(s.driver);
  // The copies own their values.
  expect(cars[c.carA].autopilot).not.toBe(sourceCars[s.carA]?.autopilot);
  // No entry was made for the person or anything else.
  expect(cars[c.driver]).toBeUndefined();
  return c;
}

beforeEach(() => {
  W().setLocked(false);
  W().replaceDocument(createEmptyDocument());
  ED().setMode('editor');
  ED().setTool('select');
  ED().setSelection([]);
  useBuildStore.getState().setClipboard(null);
  useBlueprintStore.getState().setPlace(emptyPlace());
});

describe('Ctrl+D on a group with cars', () => {
  it('settings on the new ids, the driver re-pointed, the passenger dropped — ONE undo step; undo removes objects AND settings, redo restores both', () => {
    const s = scene();
    const settings0 = W().doc.settings;
    const source0 = JSON.stringify(carsOf());
    const objects0 = Object.keys(W().doc.objects).length;
    const steps = W().past.length;
    clickSelect(s.carA); // a click on a grouped object selects its group
    expect(new Set(ED().selectedIds)).toEqual(new Set(s.group));

    duplicateSelection();
    const ids = [...ED().selectedIds];
    const c = expectCopied(s, ids);
    expect(W().past.length).toBe(steps + 1);
    expect(Object.keys(W().doc.objects)).toHaveLength(objects0 + 3);
    // The source cars are untouched: the same entries, both occupants still on carB.
    expect(JSON.stringify({ [s.carA]: carsOf()[s.carA], [s.carB]: carsOf()[s.carB] })).toBe(source0);
    expect(carsOf()[s.carB].occupants!.map((o) => o.human)).toEqual([s.driver, s.passenger]);
    expect(Object.keys(carsOf())).toHaveLength(4);
    const after = JSON.stringify(W().doc.settings);
    const afterObjects = W().doc.objects;

    W().undo();
    expect(Object.keys(W().doc.objects)).toHaveLength(objects0);
    for (const id of ids) expect(W().doc.objects[id]).toBeUndefined();
    expect(W().doc.settings).toBe(settings0);
    expect(JSON.stringify(carsOf())).toBe(source0);
    expect(W().past.length).toBe(steps);

    W().redo();
    expect(W().doc.objects).toBe(afterObjects);
    expect(JSON.stringify(W().doc.settings)).toBe(after);
    expectCopied(s, ids);
    expect(carsOf()[c.carB].occupants![0].human).toBe(c.driver);
    expect(W().past.length).toBe(steps + 1);
  });

  it('the copied settings survive save → load', () => {
    const s = scene();
    clickSelect(s.carA);
    duplicateSelection();
    const ids = [...ED().selectedIds];
    const r = parseDocument(serializeDocument(W().doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    W().replaceDocument(r.doc);
    expectCopied(s, ids);
  });

  it('a document without vehicle settings: nothing is added, the step holds no settings and the file is as before', () => {
    const s = scene(false);
    const settings0 = W().doc.settings;
    const file0 = serializeDocument({ ...W().doc, meta: { ...W().doc.meta, updatedAt: '' } }, false);
    clickSelect(s.carA);
    duplicateSelection();
    expect(ED().selectedIds).toHaveLength(3);
    expect(W().doc.settings).toBe(settings0);
    expect(W().doc.settings.simulation.vehicles).toBeUndefined();
    expect(W().past[W().past.length - 1].config).toBeUndefined();
    W().undo();
    expect(serializeDocument({ ...W().doc, meta: { ...W().doc.meta, updatedAt: '' } }, false)).toBe(file0);
  });

  it('vehicle settings but no entry for the copied cars: the plain one-step path (no settings in the step)', () => {
    const s = scene();
    W().updateSimulationSettings({ vehicles: { model: 'dynamics' } });
    const settings0 = W().doc.settings;
    clickSelect(s.carA);
    duplicateSelection();
    expect(W().doc.settings).toBe(settings0);
    expect(W().past[W().past.length - 1].config).toBeUndefined();
  });

  it('one ungrouped car (the Phase 36 path) follows the same rule: settings copied, occupants not', () => {
    const [car, person] = W().applyEdit({ add: [{ type: 'car', transform: at(0, 0) }, { type: 'human', transform: at(4, 0) }] });
    W().updateSimulationSettings({ vehicles: { model: 'dynamics', cars: { [car]: { drive: 'fwd', occupants: [{ human: person, seat: 'driver', restrained: true }] } } } });
    const steps = W().past.length;
    ED().setSelection([car]);
    duplicateSelection();
    const copy = ED().selectedId!;
    expect(copy).not.toBe(car);
    expect(carsOf()[copy]).toEqual({ drive: 'fwd' });
    expect(carsOf()[car].occupants).toHaveLength(1);
    expect(W().past.length).toBe(steps + 1);
  });

  it('refused while a gizmo drag is open (the stamp cannot be one step then): nothing changes', () => {
    const s = scene();
    const doc0 = W().doc;
    clickSelect(s.carA);
    W().beginTransaction();
    duplicateSelection();
    expect(W().doc).toBe(doc0);
    expect(new Set(ED().selectedIds)).toEqual(new Set(s.group));
    // Paste and Blueprint placement answer the same way: no ids, nothing written, the selection as it was.
    W().cancelTransaction();
    copySelection();
    const { blueprint } = captureBlueprint(W().doc, { shape: null, objects: s.group });
    useBlueprintStore.getState().setPlace({ ...emptyPlace(), blueprint, pinned: [40, 40] });
    W().beginTransaction();
    expect(pasteAt(40, 40)).toEqual([]);
    expect(confirmPlacement()).toEqual([]);
    expect(W().doc).toBe(doc0);
    expect(new Set(ED().selectedIds)).toEqual(new Set(s.group));
    expect(applyStamp(useWorldStore, { add: [{ type: 'wall', transform: at(1, 1) }] }, { k: { drive: 'awd' } }, ['k'])).toBeNull();
    W().cancelTransaction();
    // A stamp WITHOUT car settings is the plain edit it always was.
    expect(applyStamp(useWorldStore, { add: [{ type: 'wall', transform: at(1, 1) }] }, undefined, ['k'])).toHaveLength(1);
  });
});

describe('copy / paste of a group with cars', () => {
  it('the clipboard holds the settings as they were when copied; every paste is its own undo step with its own driver', () => {
    const s = scene();
    clickSelect(s.carA);
    expect(copySelection()).toBe(true);
    expect(Object.keys(useBuildStore.getState().clipboard!.cars!)).toHaveLength(2);
    // After copying: the source car is retuned and the other source car is deleted — the clipboard does not follow.
    const cur = W().doc.settings.simulation.vehicles!;
    W().updateSimulationSettings({ vehicles: { ...cur, cars: { ...cur.cars, [s.carA]: { drive: 'fwd' } } } });
    W().applyEdit({ remove: [s.carB] });
    const settings0 = W().doc.settings;
    const steps = W().past.length;

    const first = pasteAt(40, 40);
    expect(ED().selectedIds).toEqual(first);
    const c1 = expectCopied(s, first);
    expect(W().past.length).toBe(steps + 1);
    expect(carsOf()[s.carA]).toEqual({ drive: 'fwd' }); // the source keeps its own (changed) settings

    const second = pasteAt(-40, 40);
    const c2 = expectCopied(s, second);
    expect(W().past.length).toBe(steps + 2);
    expect(c2.driver).not.toBe(c1.driver);
    expect(carsOf()[c1.carB].occupants![0].human).toBe(c1.driver); // the first paste is untouched by the second

    W().undo();
    for (const id of second) expect(W().doc.objects[id]).toBeUndefined();
    expect(carsOf()[c2.carA]).toBeUndefined();
    expect(carsOf()[c1.carA]).toBeDefined();
    W().undo();
    for (const id of first) expect(W().doc.objects[id]).toBeUndefined();
    expect(W().doc.settings).toBe(settings0);
    W().redo();
    expectCopied(s, first);
  });

  it('pasting into a document without vehicle settings adds none; a clipboard of a legacy world carries none', () => {
    const s = scene();
    clickSelect(s.carA);
    copySelection();
    W().replaceDocument(createEmptyDocument());
    ED().setMode('editor');
    const settings0 = W().doc.settings;
    const ids = pasteAt(10, 10);
    expect(ids).toHaveLength(3);
    expect(W().doc.settings).toBe(settings0);
    expect(W().past[W().past.length - 1].config).toBeUndefined();

    W().replaceDocument(createEmptyDocument());
    const legacy = scene(false);
    clickSelect(legacy.carA);
    copySelection();
    expect('cars' in useBuildStore.getState().clipboard!).toBe(false);
  });

  it('a paste outside the world is refused before anything is written', () => {
    const s = scene();
    clickSelect(s.carA);
    copySelection();
    const doc0 = W().doc;
    expect(pasteAt(99.5, 99.5)).toEqual([]);
    expect(W().doc).toBe(doc0);
  });
});

describe('Blueprint capture → placement of a group with cars', () => {
  /** Capture the group, send it through its file format, pin it at (x, z). */
  function pinBlueprint(s: Scene, x: number, z: number) {
    const { blueprint } = captureBlueprint(W().doc, { shape: null, objects: s.group }, { id: 'bp_cars', now: '2026-11-11T00:00:00.000Z' });
    const parsed = parseBlueprintText(serializeBlueprint(blueprint));
    if (!parsed.ok) throw new Error(parsed.detail);
    useBlueprintStore.getState().setPlace({ ...emptyPlace(), blueprint: parsed.blueprint, pinned: [x, z] });
    return parsed.blueprint;
  }

  it('settings on the new ids in ONE undo step; undo / redo move objects and settings together', () => {
    const s = scene();
    const bp = pinBlueprint(s, 50, -50);
    expect(Object.keys(bp.cars!)).toHaveLength(2);
    const settings0 = W().doc.settings;
    const steps = W().past.length;

    const ids = confirmPlacement();
    expect(ids).toHaveLength(3);
    const c = expectCopied(s, ids);
    expect(W().past.length).toBe(steps + 1);
    expect(carsOf()[s.carA]).toEqual(settings0.simulation.vehicles!.cars![s.carA]);
    expect(carsOf()[s.carB]).toEqual(settings0.simulation.vehicles!.cars![s.carB]);
    const after = JSON.stringify(W().doc.settings);

    W().undo();
    for (const id of ids) expect(W().doc.objects[id]).toBeUndefined();
    expect(W().doc.settings).toBe(settings0);
    W().redo();
    expect(JSON.stringify(W().doc.settings)).toBe(after);
    expect(carsOf()[c.carB].occupants![0].human).toBe(c.driver);

    // A second copy of the same blueprint: its own ids, its own driver.
    useBlueprintStore.getState().setPlace({ pinned: [-50, -50] });
    const again = confirmPlacement();
    const c2 = expectCopied(s, again);
    expect(c2.driver).not.toBe(c.driver);
    expect(W().past.length).toBe(steps + 2);
  });

  it('a person left out of the placement (outside the world) is not seated: the car comes without that occupant', () => {
    const s = scene();
    const bp = pinBlueprint(s, 0, 0);
    // The driver stands 3 m east of the cars: pin so that the cars end inside the world edge (x = 100) and the driver beyond it.
    const car = bp.objects.find((o) => o.type === 'car')!;
    useBlueprintStore.getState().setPlace({ pinned: [97.25 - car.offset[0], 0] });
    const steps = W().past.length;
    const ids = confirmPlacement();
    expect(ids.map((id) => W().doc.objects[id].type)).toEqual(['car', 'car']);
    const c = copies(ids);
    expect(carsOf()[c.carA]).toEqual({ drive: 'awd', controls: { throttle: 0.3, gear: 'D' }, autopilot: AUTOPILOT });
    expect(carsOf()[c.carB]).toEqual({ drive: 'rwd', abs: false });
    expect(W().past.length).toBe(steps + 1);
  });

  it('placing into a document without vehicle settings adds none', () => {
    const s = scene();
    const bp = pinBlueprint(s, 20, 20);
    W().replaceDocument(createEmptyDocument());
    ED().setMode('editor');
    useBlueprintStore.getState().setPlace({ ...emptyPlace(), blueprint: bp, pinned: [20, 20] });
    const settings0 = W().doc.settings;
    expect(confirmPlacement()).toHaveLength(3);
    expect(W().doc.settings).toBe(settings0);
    expect(W().past[W().past.length - 1].config).toBeUndefined();
  });
});

describe('a template applied over the current world', () => {
  beforeEach(async () => {
    try { localStorage.clear(); } catch { /* node */ }
    await useLibraryStore.getState().init(new MemoryBackend());
  });

  it('the template\'s car settings are re-keyed to the new object ids in the same undo step (no orphan entries)', async () => {
    const s = scene();
    const template = createTemplate(W().doc, { name: 'cars' }, false, { id: 'tpl_cars', now: '2026-11-11T00:00:00.000Z' });
    await useLibraryStore.getState().saveTemplate(template);

    // The current world: something else, with its own (different) settings.
    W().replaceDocument(createEmptyDocument());
    ED().setMode('editor');
    const [old] = W().applyEdit({ add: [{ type: 'car', transform: at(70, 70) }] });
    W().updateSimulationSettings({ vehicles: { model: 'dynamics', cars: { [old]: { drive: 'fwd' } } } });
    const settings0 = W().doc.settings;
    const steps = W().past.length;

    expect(await applyTemplate('tpl_cars', 1, 'replace')).toBe(true);
    expect(W().past.length).toBe(steps + 1);
    const objs = Object.values(W().doc.objects);
    expect(objs).toHaveLength(5);
    const ids = objs.map((o) => o.id);
    // Every object got a new id; every car entry is keyed by an object of the world.
    for (const id of [s.carA, s.carB, s.driver, s.passenger, s.wall, old]) expect(ids).not.toContain(id);
    const cars = carsOf();
    expect(Object.keys(cars)).toHaveLength(2);
    for (const k of Object.keys(cars)) expect(W().doc.objects[k]?.type).toBe('car');
    const carB = Object.keys(cars).find((k) => cars[k].occupants)!;
    const carA = Object.keys(cars).find((k) => !cars[k].occupants)!;
    expect(cars[carA]).toEqual({ drive: 'awd', controls: { throttle: 0.3, gear: 'D' }, autopilot: AUTOPILOT });
    // The whole world was copied: both occupants come along, pointed at the new people.
    expect(cars[carB].occupants!.map((o) => W().doc.objects[o.human]?.type)).toEqual(['human', 'human']);
    expect(cars[carB].occupants!.map((o) => o.seat)).toEqual(['driver', 'front']);
    const seated = cars[carB].occupants!.map((o) => W().doc.objects[o.human].transform.position[0]);
    expect(seated).toEqual([3, 30]); // the driver stood at x = 3, the passenger at x = 30

    W().undo();
    expect(W().doc.settings).toBe(settings0);
    expect(Object.keys(W().doc.objects)).toEqual([old]);
    W().redo();
    expect(Object.keys(carsOf()).sort()).toEqual([carA, carB].sort());
    expect(Object.keys(W().doc.objects)).toHaveLength(5);
  });

  it('a template without car settings takes the one-edit path as before (one undo step)', async () => {
    scene(false);
    await useLibraryStore.getState().saveTemplate(createTemplate(W().doc, { name: 'plain' }, false, { id: 'tpl_plain', now: '2026-11-11T00:00:00.000Z' }));
    W().replaceDocument(createEmptyDocument());
    ED().setMode('editor');
    W().applyEdit({ add: [{ type: 'wall', transform: at(0, 0) }] });
    const steps = W().past.length;
    expect(await applyTemplate('tpl_plain', 1, 'replace')).toBe(true);
    expect(W().past.length).toBe(steps + 1);
    expect(Object.keys(W().doc.objects)).toHaveLength(5);
    expect(W().doc.settings.simulation.vehicles).toBeUndefined();
  });
});
