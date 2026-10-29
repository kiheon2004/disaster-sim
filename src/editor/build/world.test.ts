/**
 * Phase 16: worlds built with the Creative Build tools — selection, ids, save / load, legacy
 * files, original-world isolation, simulation reset, and every hazard running on them.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { createEmptyDocument, SCHEMA_VERSION } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { samplerFor } from '@/terrain/TerrainSampler';
import { SimulationController } from '@/simulation/SimulationController';
import { boxSelect, clickSelect, copySelection, duplicateSelection, expandGroups, groupSelection, pasteAt, selectAll, ungroupSelection } from '@/app/buildActions';
import { useBuildStore } from '@/editor/buildStore';
import { objectsInRect } from '@/editor/MarqueeSelect';
import { areaFill, brushScatter, lineLayout } from './distribution';
import { FootprintIndex } from './footprint';
import { DEFAULT_PLACEMENT, acceptedInputs, planPlacement } from './placementPlan';

/** A small town made only with the Phase 16 tools (brush forest, line of lamps / walls, area of cars + houses). */
function builtWorld(terrain?: 'gentleHills' | 'lowland'): WorldDocument {
  useWorldStore.setState({ locked: false });
  const doc = createEmptyDocument('built');
  if (terrain) doc.terrain = generateTerrain(terrain, 5);
  useWorldStore.getState().replaceDocument(doc);
  const w = useWorldStore.getState;
  const ctx = () => ({ terrain: samplerFor(w().doc.terrain), existing: FootprintIndex.fromObjects(Object.values(w().doc.objects)) });
  const s = { ...DEFAULT_PLACEMENT, seed: 21, slopeLimit: 60 };
  // Houses on a grid.
  const houses = areaFill({ kind: 'rect', x0: -50, z0: -50, x1: 10, z1: -10 }, { mode: 'grid', spacing: 18, density: 0, jitter: 0, seed: 1 });
  w().applyEdit({ add: acceptedInputs(planPlacement({ type: 'building', params: { floors: 3, width: 9, depth: 8 } }, houses.map(([x, z]) => ({ x, z })), { ...s, randomRotation: false }, ctx())) });
  // Brush forest.
  const forest = brushScatter([[20, 20], [40, 30], [60, 25], [70, 45]], { radius: 10, density: 2.5, spacing: 3.5, seed: 4 });
  w().applyEdit({ add: acceptedInputs(planPlacement({ type: 'tree', randomize: true }, forest.map(([x, z]) => ({ x, z })), { ...s, scaleMin: 0.85, scaleMax: 1.2 }, ctx())) });
  // Street lights and a wall along a line.
  w().applyEdit({ add: acceptedInputs(planPlacement({ type: 'streetLight' }, lineLayout([[-60, 5], [10, 5]], { spacing: 10, orient: 'along', yaw: 0, offset: 0 }), { ...s, randomRotation: false }, ctx())) });
  w().applyEdit({ add: acceptedInputs(planPlacement({ type: 'wall', params: { length: 6, height: 2, thickness: 0.3 } }, lineLayout([[-60, 15], [-20, 15]], { spacing: 6.5, orient: 'along', yaw: 0, offset: 0 }), { ...s, randomRotation: false }, ctx())) });
  // Cars and people scattered in an area.
  const lot = areaFill({ kind: 'circle', x: -20, z: 35, r: 18 }, { mode: 'random', spacing: 5, density: 3, jitter: 0, seed: 8 });
  w().applyEdit({ add: acceptedInputs(planPlacement({ type: 'car' }, lot.map(([x, z]) => ({ x, z })), s, ctx())) });
  const crowd = areaFill({ kind: 'circle', x: 30, z: -30, r: 10 }, { mode: 'random', spacing: 1.5, density: 6, jitter: 0, seed: 9 });
  w().applyEdit({ add: acceptedInputs(planPlacement({ type: 'human', randomize: true }, crowd.map(([x, z]) => ({ x, z })), s, ctx())) });
  return structuredClone(w().doc);
}

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, i]));
  const c = new SimulationController();
  await c.load(d);
  for (const sp of specs) c.addEvent(sp);
  c.advance(seconds);
  const events = c.getDamageEvents();
  const lines = events.map((e) => [e.time, index.get(e.objectId), e.componentId ?? '', e.eventType, e.hazard, e.force, e.damageAfter].join('|'));
  const ents = [...c.getRuntime()!.entities.values()];
  const finite = ents.every((e) => e.pose.position.every(Number.isFinite) && Number.isFinite(e.health));
  const hash = createHash('sha256').update(lines.join('\n') + '#' + ents.map((e) => [index.get(e.id), e.state, e.health, ...e.pose.position].join('|')).join('\n')).digest('hex');
  const byHazard = { wind: 0, earthquake: 0, flood: 0 } as Record<string, number>;
  for (const e of events) byHazard[e.hazard]++;
  const flood = c.getMetrics()?.flood?.peakFloodedArea ?? 0;
  return { c, events: events.length, hash, finite, byHazard, flood };
}

const WIND: EventSpec = { event: 'wind', speed: 48, direction: 'E', duration: 30, gustStrength: 0.3, rampDuration: 2 };
const QUAKE: EventSpec = { event: 'earthquake', magnitude: 7, pga: 0.55, duration: 12, seed: 3 };
const RAIN: EventSpec = { event: 'rain', intensity: 150, duration: 60 };
const RISE: EventSpec = { event: 'risingWater', boundary: 'S', level: 1.4, riseRate: 8, duration: 60 };

describe('multi-selection', () => {
  beforeEach(() => {
    useWorldStore.setState({ locked: false });
    useWorldStore.getState().replaceDocument(createEmptyDocument('sel'));
    useEditorStore.getState().setSelection([]);
  });
  const add = (n: number, type: 'car' | 'tree' = 'car') =>
    useWorldStore.getState().applyEdit({ add: Array.from({ length: n }, (_, i) => ({ type, transform: { position: [i * 8 - 40, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } })) });

  it('Shift+click adds / removes, plain click replaces, primary follows the last click', () => {
    const ids = add(4);
    clickSelect(ids[0]);
    clickSelect(ids[2], { shift: true });
    clickSelect(ids[3], { shift: true });
    expect(useEditorStore.getState().selectedIds).toEqual([ids[0], ids[2], ids[3]]);
    expect(useEditorStore.getState().selectedId).toBe(ids[3]);
    clickSelect(ids[2], { shift: true });
    expect(useEditorStore.getState().selectedIds).toEqual([ids[0], ids[3]]);
    clickSelect(ids[1]);
    expect(useEditorStore.getState().selectedIds).toEqual([ids[1]]);
  });

  it('groups: clicking a member selects the group, Alt+click one member; ungroup', () => {
    const ids = add(5);
    useEditorStore.getState().setSelection(ids.slice(0, 3));
    groupSelection();
    useEditorStore.getState().setSelection([]);
    clickSelect(ids[1]);
    expect(new Set(useEditorStore.getState().selectedIds)).toEqual(new Set(ids.slice(0, 3)));
    clickSelect(ids[1], { alt: true });
    expect(useEditorStore.getState().selectedIds).toEqual([ids[1]]);
    expect(expandGroups([ids[4]])).toEqual([ids[4]]);
    useEditorStore.getState().setSelection(ids.slice(0, 3));
    ungroupSelection();
    clickSelect(ids[0]);
    expect(useEditorStore.getState().selectedIds).toEqual([ids[0]]);
    // Group + ungroup are undo steps.
    expect(useWorldStore.getState().past.length).toBe(3);
  });

  it('select all within a category and box selection by screen rectangle', () => {
    const cars = add(3, 'car');
    const trees = add(2, 'tree');
    selectAll('nature');
    expect(new Set(useEditorStore.getState().selectedIds)).toEqual(new Set(trees));
    selectAll('vehicles');
    expect(new Set(useEditorStore.getState().selectedIds)).toEqual(new Set(cars));
    // Top-down camera: the left half of the screen holds the objects with x < 0.
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 120, 0.001);
    camera.lookAt(0, 0, 0);
    const inside = objectsInRect(Object.values(useWorldStore.getState().doc.objects), camera, [-1, -1], [0, 1]);
    const expected = Object.values(useWorldStore.getState().doc.objects).filter((o) => o.transform.position[0] < 0).map((o) => o.id);
    expect(new Set(inside)).toEqual(new Set(expected));
    useEditorStore.getState().setSelection([cars[0]]);
    boxSelect(inside, true);
    expect(useEditorStore.getState().selectedIds).toContain(cars[0]);
  });
});

describe('ID uniqueness', () => {
  it('duplicate, copy / paste and bulk placement never reuse an id', () => {
    builtWorld();
    selectAll();
    const n = useEditorStore.getState().selectedIds.length;
    duplicateSelection();
    copySelection();
    pasteAt(20, 20);
    pasteAt(-20, 20);
    const ids = Object.keys(useWorldStore.getState().doc.objects);
    expect(ids.length).toBe(n * 4);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [id, o] of Object.entries(useWorldStore.getState().doc.objects)) expect(o.id).toBe(id);
    useBuildStore.getState().setClipboard(null);
  });
});

describe('save / load', () => {
  it('a built world round-trips exactly (groups included), schema v6 since Phase 18', () => {
    builtWorld('gentleHills');
    selectAll('nature');
    groupSelection();
    const doc = useWorldStore.getState().doc;
    const json = serializeDocument(doc);
    const raw = JSON.parse(json);
    expect(raw.schemaVersion).toBe(6);
    expect(SCHEMA_VERSION).toBe(6);
    const res = parseDocument(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.objects).toEqual(doc.objects);
    expect(worldFingerprint(res.doc)).toBe(worldFingerprint(doc));
    const groups = new Set(Object.values(res.doc.objects).filter((o) => o.type === 'tree').map((o) => o.group));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toBeTruthy();
    // Editor preferences / clipboard are NOT part of the world file.
    expect(json).not.toContain('"brush"');
    expect(json).not.toContain('clipboard');
  });

  it('legacy v1–v4 files load (no groups) and can be edited with the new tools', () => {
    const doc = builtWorld();
    for (const v of [1, 2, 3, 4]) {
      const raw = JSON.parse(serializeDocument(doc));
      raw.schemaVersion = v;
      if (v === 1) raw.terrain = { kind: 'flat' };
      if (v <= 4) delete raw.scenario?.experiment;
      if (v <= 2) delete raw.scenario;
      for (const o of Object.values(raw.objects) as Record<string, unknown>[]) delete o.group;
      const res = parseDocument(JSON.stringify(raw));
      expect(res.ok, `v${v}`).toBe(true);
      if (!res.ok) continue;
      expect(Object.keys(res.doc.objects).length).toBe(Object.keys(doc.objects).length);
      for (const o of Object.values(res.doc.objects)) expect(o.group).toBeUndefined();
      useWorldStore.getState().replaceDocument(res.doc);
      useEditorStore.getState().setSelection(Object.keys(res.doc.objects).slice(0, 5));
      groupSelection();
      duplicateSelection();
      expect(Object.keys(useWorldStore.getState().doc.objects).length).toBe(Object.keys(doc.objects).length + 5);
    }
  });

  it('an invalid group field is dropped, not fatal', () => {
    const doc = builtWorld();
    const raw = JSON.parse(serializeDocument(doc));
    const first = Object.values(raw.objects)[0] as Record<string, unknown>;
    first.group = 42;
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.doc.objects[first.id as string].group).toBeUndefined();
  });
});

describe('original world & experiment isolation', { timeout: 300_000 }, () => {
  it('a destructive run never touches the document; the next experiment starts from the original', async () => {
    const doc = builtWorld();
    const before = worldFingerprint(doc);
    const json = serializeDocument(doc);
    // 1) earthquake that damages the town
    const quake = await run(doc, [QUAKE], 12);
    expect(quake.events).toBeGreaterThan(0);
    quake.c.unload();
    // The document handed to the controller is unchanged (bit for bit).
    expect(worldFingerprint(doc)).toBe(before);
    expect(serializeDocument(doc)).toBe(json);
    // 2) typhoon on the restored original == typhoon on a fresh copy of the saved original
    const fromOriginal = await run(doc, [WIND], 8);
    fromOriginal.c.unload();
    const reloaded = parseDocument(json);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    const fresh = await run(reloaded.doc, [WIND], 8);
    fresh.c.unload();
    expect(fromOriginal.hash).toBe(fresh.hash);
  });

  it('the world store is locked while simulating (UI flow) and unlocked after', async () => {
    builtWorld();
    const { enterSimulation, exitSimulation } = await import('@/app/actions');
    const fp = worldFingerprint(useWorldStore.getState().doc);
    await enterSimulation();
    expect(useWorldStore.getState().locked).toBe(true);
    useWorldStore.getState().applyEdit({ remove: Object.keys(useWorldStore.getState().doc.objects) });
    useWorldStore.getState().undo();
    useWorldStore.getState().newDocument();
    expect(worldFingerprint(useWorldStore.getState().doc)).toBe(fp);
    exitSimulation();
    expect(useWorldStore.getState().locked).toBe(false);
    expect(worldFingerprint(useWorldStore.getState().doc)).toBe(fp);
  });

  it('simulation reset reproduces the initial conditions exactly', async () => {
    const doc = builtWorld();
    const c = new SimulationController();
    await c.load(doc);
    c.addEvent(WIND);
    c.advance(6);
    const first = c.getDamageEvents().map((e) => [e.time, e.objectId, e.eventType, e.force].join('|'));
    expect(first.length).toBeGreaterThan(0);
    await c.reset();
    // Same scenario replayed from t = 0 on the same snapshot.
    expect(c.getTime()).toBe(0);
    for (const e of c.getRuntime()!.entities.values()) {
      expect(e.pose.position).toEqual(e.initialPose.position);
      expect(e.state).toBe(0);
    }
    c.advance(6);
    const second = c.getDamageEvents().map((e) => [e.time, e.objectId, e.eventType, e.force].join('|'));
    expect(second).toEqual(first);
    c.unload();
  });
});

describe('hazards on a world built with the new tools', { timeout: 600_000 }, () => {
  it('wind regression: runs, damages, deterministic', async () => {
    const doc = builtWorld();
    const a = await run(doc, [WIND], 8);
    const b = await run(doc, [WIND], 8);
    a.c.unload(); b.c.unload();
    expect(a.finite).toBe(true);
    expect(a.byHazard.wind).toBeGreaterThan(0);
    expect(a.hash).toBe(b.hash);
  });

  it('earthquake regression on sloped terrain: runs, damages, deterministic', async () => {
    const doc = builtWorld('gentleHills');
    const a = await run(doc, [QUAKE], 10);
    const b = await run(doc, [QUAKE], 10);
    a.c.unload(); b.c.unload();
    expect(a.finite).toBe(true);
    expect(a.byHazard.earthquake).toBeGreaterThan(0);
    expect(a.hash).toBe(b.hash);
  });

  it('flood regression on lowland: water spreads over the built objects, deterministic', async () => {
    const doc = builtWorld('lowland');
    const a = await run(doc, [RAIN, RISE], 30);
    const b = await run(doc, [RAIN, RISE], 30);
    a.c.unload(); b.c.unload();
    expect(a.finite).toBe(true);
    expect(a.flood).toBeGreaterThan(0);
    expect(a.hash).toBe(b.hash);
  });

  it('multi-hazard regression (wind + earthquake + flood): every hazard contributes, deterministic', async () => {
    const doc = builtWorld('lowland');
    const specs: EventSpec[] = [WIND, { ...QUAKE, startTime: 4 } as EventSpec, RAIN, RISE];
    const a = await run(doc, specs, 16);
    const b = await run(doc, specs, 16);
    a.c.unload(); b.c.unload();
    expect(a.finite).toBe(true);
    expect(a.byHazard.wind).toBeGreaterThan(0);
    expect(a.byHazard.earthquake).toBeGreaterThan(0);
    expect(a.flood).toBeGreaterThan(0);
    expect(a.hash).toBe(b.hash);
  });
});
