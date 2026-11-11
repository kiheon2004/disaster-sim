/**
 * Phase 37 (§10): `worldStore.batch(fn)` — one command = one undo step. Objects, a road, two terrain strokes, a placed
 * disaster, a group name and car settings are edited in one batch; undo gives back the document bit for bit, redo the
 * document after the batch. Nothing changed → no step; an exception → everything is put back and no step; refused while
 * a stroke / transaction is open or the document is locked.
 */
import { describe, expect, it } from 'vitest';
import type { WorldDocument } from '@/core/model';
import { identityTransform, type Vec3 } from '@/core/types';
import { drawRoad } from '@/roads/network';
import { defaultProfile, type RoadNetwork } from '@/roads/types';
import { applyPatch, changedRect, createFlatTerrain, makePatch, snapshotLayers } from '@/terrain/TerrainData';
import { defaultExperiment, type PhenomenonInstance } from '@/phenomena/types';
import { createEmptyDocument } from './WorldDocument';
import { HISTORY_BYTES, historyEntryBytes, scratchWorld } from './worldStore';

const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });

/** Every part of the document the history restores, as bytes / canonical text (meta and revision counters excluded). */
function snap(doc: WorldDocument) {
  const t = doc.terrain, l = doc.landscape;
  const bytes = (a: Float32Array | Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  return {
    heights: bytes(t.heights), ground: bytes(t.ground), soil: bytes(t.soil), terrainSettings: JSON.stringify(t.settings),
    baseHeights: bytes(l.base.heights), baseGround: bytes(l.base.ground), sculpt: bytes(l.sculpt), paint: bytes(l.paint),
    naturalHeights: bytes(l.natural.heights), naturalGround: bytes(l.natural.ground), culvert: bytes(l.natural.culvert), roadBase: bytes(l.natural.roadBase),
    features: JSON.stringify(l.features), next: l.next,
    objects: JSON.stringify(doc.objects), roads: JSON.stringify(doc.roads),
    scenario: JSON.stringify(doc.scenario), settings: JSON.stringify(doc.settings), groups: JSON.stringify(doc.groups ?? null),
  };
}

const blast = (id: string, x: number, z: number): PhenomenonInstance => ({
  id, type: 'blast', spec: { event: 'blast', position: [x, z], energy: 1.8e9, height: 1 } as never, enabled: true, start: { at: 5 }, visualize: true,
});

/** A world that already has history: a road, objects on ground that will change, one earlier stroke. */
function world() {
  const st = scratchWorld(createEmptyDocument());
  const S = () => st.getState();
  S().applyEdit({ roads: drawRoad(S().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
  S().applyEdit({ add: [{ type: 'wall', transform: at(30, 30) }, { type: 'tree', transform: at(32, 28) }, { type: 'car', transform: at(-20, 1.75) }] });
  S().beginTerrainStroke();
  for (let k = 0; k < 6; k++) S().terrainDab({ op: 'raise', x: -40, z: 40, brush: { radius: 7, strength: 1 }, dt: 0.05 });
  S().endTerrainStroke();
  return { st, S };
}

/** One command's worth of edits of every kind (called inside a batch). Returns the ids it made. */
function everything(S: () => ReturnType<ReturnType<typeof scratchWorld>['getState']>) {
  const ids = S().applyEdit({ add: [{ type: 'building', transform: at(-30, 14) }, { type: 'building', transform: at(-18, 14) }, { type: 'building', transform: at(-6, 14) }] });
  const car = S().applyEdit({ add: [{ type: 'car', transform: at(10, -1.75) }] })[0];
  S().applyEdit({ roads: drawRoad(S().doc.roads, [[0, 0], [0, 70]], { curved: false, profile: defaultProfile() }).network });
  // Two strokes far apart: two patches → one merged patch over their union rectangle.
  S().beginTerrainStroke();
  for (let k = 0; k < 8; k++) S().terrainDab({ op: 'raise', x: 30, z: 30, brush: { radius: 8, strength: 1 }, dt: 0.05 });
  S().endTerrainStroke();
  S().beginTerrainStroke();
  for (let k = 0; k < 8; k++) S().terrainDab({ op: 'lower', x: -50, z: -50, brush: { radius: 5, strength: 1 }, dt: 0.05 });
  for (let k = 0; k < 4; k++) S().terrainDab({ op: 'paint', x: -50, z: -50, brush: { radius: 4, strength: 1 }, dt: 0.05, groundType: 5 });
  S().endTerrainStroke();
  S().setExperiment({ instances: [...(S().doc.scenario.experiment ?? defaultExperiment()).instances, blast('p1', 0, 0)] });
  S().applyEdit({ update: ids.map((id) => ({ ...S().doc.objects[id], group: 'g_north' })) });
  S().setGroupName('g_north', '북쪽 블록');
  S().updateSimulationSettings({ vehicles: { model: 'dynamics', cars: { [car]: { drive: 'awd' } } } as never });
  return { ids, car };
}

describe('batch: one command = one undo step (§10)', () => {
  it('objects + road + terrain + disaster + group name + car settings: undo and redo are bit-identical', () => {
    const { S } = world();
    const before = snap(S().doc);
    const steps = S().past.length;

    const res = S().batch(() => everything(S));
    expect(res.ok && res.changed).toBe(true);
    if (!res.ok) return;
    const after = snap(S().doc);
    expect(S().past.length).toBe(steps + 1);
    expect(S().future).toEqual([]);
    expect(S().busy()).toBe(false);
    // Everything really happened.
    expect(res.value.ids.every((id) => S().doc.objects[id]?.group === 'g_north')).toBe(true);
    expect(S().doc.groups?.g_north.name).toBe('북쪽 블록');
    expect(S().doc.scenario.experiment?.instances.map((i) => i.id)).toEqual(['p1']);
    expect(Object.keys(S().doc.roads.segments).length).toBeGreaterThan(1);
    expect(S().doc.settings.simulation.vehicles?.cars?.[res.value.car]).toMatchObject({ drive: 'awd' });
    expect(after.heights).not.toBe(before.heights);
    expect(after.sculpt).not.toBe(before.sculpt);
    expect(after.paint).not.toBe(before.paint);
    // The objects that stood on the raised ground followed it, in the same step.
    const wall = Object.values(S().doc.objects).find((o) => o.type === 'wall')!;
    expect(wall.transform.position[1]).toBeGreaterThan(0.05);

    S().undo();
    expect(snap(S().doc)).toEqual(before);
    expect(S().past.length).toBe(steps);
    S().redo();
    expect(snap(S().doc)).toEqual(after);
    S().undo();
    expect(snap(S().doc)).toEqual(before);
    S().redo();
    expect(snap(S().doc)).toEqual(after);
    expect(S().past.length).toBe(steps + 1);
  });

  it('the step holds one terrain patch over the rectangle that changed; the terrain view gets that rectangle', () => {
    const { S } = world();
    const res = S().batch(() => everything(S));
    expect(res.ok).toBe(true);
    const entry = S().past[S().past.length - 1];
    const r = entry.terrain!.rect;
    const t = S().doc.terrain;
    const ix = (x: number) => Math.round((x - t.originX) / t.cellSize);
    // Covers both strokes (around 30, 30 and −50, −50) and the new road up to z = 70.
    expect(r.x0).toBeLessThanOrEqual(ix(-52));
    expect(r.x1).toBeGreaterThanOrEqual(ix(35));
    expect(r.z0).toBeLessThanOrEqual(ix(-52));
    expect(r.z1).toBeGreaterThanOrEqual(ix(65));
    // … and nothing more than what differs: the corner of the map the batch never touched is outside.
    expect(r.x0).toBeGreaterThan(0);
    expect(r.z0).toBeGreaterThan(0);
    expect(S().terrainRect).toEqual(r);
    const n = (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1);
    expect(entry.terrain!.heightsBefore.length).toBe(n);
    // 12 B per vertex of terrain + the layer patch; under the history cap.
    expect(historyEntryBytes(entry)).toBeGreaterThanOrEqual(12 * n);
    expect(historyEntryBytes(entry)).toBeLessThan(HISTORY_BYTES);
    // Settings (the car) and the scenario (the blast) both changed: both halves; the group names too.
    expect(entry.config?.settings).toBeDefined();
    expect(entry.config?.scenario).toBeDefined();
    expect(entry.groupNames).toBeDefined();
  });

  it('nothing changed → no step, and the redo side is kept', () => {
    const { S } = world();
    S().undo();
    const past = S().past, future = S().future;
    expect(future.length).toBe(1);
    const res = S().batch(() => 7);
    expect(res).toEqual({ ok: true, value: 7, changed: false });
    expect(S().past).toBe(past);
    expect(S().future).toBe(future);
    // Calls that end up changing nothing (same group name, unknown ids) are not a step either.
    const res2 = S().batch(() => {
      S().setGroupName('nobody', '');
      S().applyEdit({ remove: ['missing'] });
    });
    expect(res2.ok && res2.changed).toBe(false);
    expect(S().past).toBe(past);
    expect(S().future).toBe(future);
  });

  it('edits that rebuild the same values are no step: same objects, an equal road network, the same plan, a move there and back', () => {
    const { S } = world();
    S().setExperiment({ instances: [blast('p1', 3, 3)] });
    const doc = S().doc;
    const past = S().past;
    const tree = Object.values(doc.objects).find((o) => o.type === 'tree')!;
    const res = S().batch(() => {
      // The same object values again (what align does to objects that are already aligned).
      S().applyEdit({ update: Object.values(S().doc.objects) });
      // A new network object with the same content.
      S().applyEdit({ roads: structuredClone(S().doc.roads) });
      // The same experiment plan (a new object every time).
      S().setExperiment({ instances: [blast('p1', 3, 3)] });
      S().updateSimulationSettings({});
      // There and back: the value the object had (as a new object) — not the same reference, so this one is a change…
      S().updateTransform(tree.id, { position: [50, 0, 50] }, { history: false });
      S().applyEdit({ update: [tree] });
    });
    expect(res).toEqual({ ok: true, value: undefined, changed: false });
    expect(S().past).toBe(past);
    // … and the document is the one from before, reference for reference (nothing for subscribers to redo, no new save).
    expect(S().doc.objects).toBe(doc.objects);
    expect(S().doc.roads).toBe(doc.roads);
    expect(S().doc.scenario).toBe(doc.scenario);
    expect(S().doc.settings).toBe(doc.settings);
    expect(S().doc.meta).toBe(doc.meta);
    expect(snap(S().doc)).toEqual(snap(doc));
  });

  it('only what changed is in the step: undoing a placed disaster leaves later settings edits alone', () => {
    const { S } = world();
    const res = S().batch(() => S().setExperiment({ instances: [blast('p1', 3, 3)] }));
    expect(res.ok && res.changed).toBe(true);
    const entry = S().past[S().past.length - 1];
    expect(entry.config?.scenario).toBeDefined();
    expect(entry.config?.settings).toBeUndefined();
    // The same outside a batch: a placed disaster records the scenario only.
    S().setExperiment({ instances: [blast('p1', 3, 3), blast('p2', 9, 9)] });
    expect(S().past[S().past.length - 1].config?.settings).toBeUndefined();
    // A settings edit is not an undo step of its own …
    S().updateSimulationSettings({ seed: 4242 });
    S().undo();
    S().undo();
    // … and the two disaster undos did not take it back.
    expect(S().doc.scenario.experiment?.instances ?? []).toEqual([]);
    expect(S().doc.settings.simulation.seed).toBe(4242);
    S().redo();
    expect(S().doc.scenario.experiment?.instances.map((i) => i.id)).toEqual(['p1']);
    expect(S().doc.settings.simulation.seed).toBe(4242);
  });

  it('an exception part-way → the document from before, no step, redo side kept', () => {
    const { S } = world();
    S().undo();
    S().redo();
    S().applyEdit({ add: [{ type: 'sign', transform: at(50, 50) }] });
    S().undo(); // future = [the sign]
    const before = snap(S().doc);
    const past = S().past, future = S().future;
    const meta = S().doc.meta;

    const res = S().batch(() => {
      everything(S);
      throw new Error('boom');
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('error');
    expect((res.error as Error).message).toBe('boom');
    expect(snap(S().doc)).toEqual(before);
    expect(S().doc.meta).toBe(meta);
    expect(S().past).toBe(past);
    expect(S().future).toBe(future);
    expect(S().busy()).toBe(false);
    // The store works as before: redo the sign, then a normal edit.
    S().redo();
    expect(Object.values(S().doc.objects).some((o) => o.type === 'sign')).toBe(true);
    const n = S().past.length;
    S().applyEdit({ add: [{ type: 'wall', transform: at(1, 60) }] });
    expect(S().past.length).toBe(n + 1);
  });

  it('a validation failure (invalid road network) and an open stroke roll back too', () => {
    const { S } = world();
    const before = snap(S().doc);
    const past = S().past;
    const bad: RoadNetwork = { ...S().doc.roads, segments: { ...S().doc.roads.segments, sX: { ...Object.values(S().doc.roads.segments)[0], id: 'sX', a: 'nowhere' } } };
    const res = S().batch(() => {
      S().applyEdit({ add: [{ type: 'wall', transform: at(5, 20) }] });
      S().beginTerrainStroke();
      for (let k = 0; k < 5; k++) S().terrainDab({ op: 'raise', x: 60, z: -60, brush: { radius: 6, strength: 1 }, dt: 0.05 });
      S().endTerrainStroke();
      S().applyEdit({ roads: bad });
    });
    expect(res.ok).toBe(false);
    expect(snap(S().doc)).toEqual(before);
    expect(S().past).toBe(past);

    // A stroke left open by the failing code is dropped with the batch.
    const res2 = S().batch(() => {
      S().beginTerrainStroke();
      for (let k = 0; k < 5; k++) S().terrainDab({ op: 'raise', x: 60, z: -60, brush: { radius: 6, strength: 1 }, dt: 0.05 });
      throw new Error('mid-stroke');
    });
    expect(res2.ok).toBe(false);
    expect(snap(S().doc)).toEqual(before);
    expect(S().busy()).toBe(false);
    expect(S().strokeHeights()).toBeNull();

    // … and a stroke that is simply never ended is an error, not a half-recorded step.
    const res3 = S().batch(() => {
      S().beginTerrainStroke();
      S().terrainDab({ op: 'raise', x: 0, z: 50, brush: { radius: 6, strength: 1 }, dt: 0.05 });
    });
    expect(res3.ok).toBe(false);
    expect(snap(S().doc)).toEqual(before);
    expect(S().past).toBe(past);
  });

  it('rollback does not depend on the edits inside being atomic: arrays written without a recorded step come back too', () => {
    const { S } = world();
    const before = snap(S().doc);
    const past = S().past;
    const res = S().batch(() => {
      S().applyEdit({ add: [{ type: 'wall', transform: at(5, 20) }] });
      // What a road bake or a brush commit leaves behind when it dies half-way: the arrays changed in place, no step.
      const t = S().doc.terrain, l = S().doc.landscape;
      t.heights[1234] = 12.5;
      t.ground[77] = 5;
      t.soil[78] = t.soil[78] === 2 ? 3 : 2;
      t.settings = { ...t.settings, waterLevel: 3 };
      l.sculpt[4321] = 1.25;
      l.paint[10] = 4;
      l.natural.heights[20] = -3;
      l.natural.roadBase[21] = 7;
      l.base.heights[22] = 9;
      throw new Error('died inside');
    });
    expect(res.ok).toBe(false);
    expect(snap(S().doc)).toEqual(before);
    expect(S().past).toBe(past);
    // The terrain view is told what to redraw: the rectangle around the vertices written (indices 77, 78 and 1234).
    const t = S().doc.terrain;
    expect(t.nx).toBe(201);
    expect(S().terrainRect).toEqual({ x0: 1234 % 201, z0: 0, x1: 78, z1: Math.floor(1234 / 201) });
  });

  it('refused while a stroke or a transaction is open, and while the document is locked', () => {
    const { S } = world();
    let ran = 0;
    S().beginTransaction();
    expect(S().batch(() => ran++)).toEqual({ ok: false, reason: 'busy' });
    S().cancelTransaction();
    S().beginTerrainStroke();
    expect(S().batch(() => ran++)).toEqual({ ok: false, reason: 'busy' });
    S().cancelTerrainStroke();
    S().setLocked(true);
    expect(S().batch(() => ran++)).toEqual({ ok: false, reason: 'locked' });
    S().setLocked(false);
    expect(ran).toBe(0);
    expect(S().batch(() => ran++).ok).toBe(true);
    expect(ran).toBe(1);
  });

  it('undo / redo are refused inside; replacing the document inside is an error', () => {
    const { S } = world();
    const before = snap(S().doc);
    const steps = S().past.length;
    const res = S().batch(() => {
      expect(S().busy()).toBe(true);
      S().applyEdit({ add: [{ type: 'wall', transform: at(5, 20) }] });
      S().undo(); // refused: would tear the batch
      S().redo();
      expect(S().past.length).toBe(steps);
      return Object.keys(S().doc.objects).length;
    });
    expect(res.ok && res.value).toBe(Object.keys(S().doc.objects).length);
    expect(S().past.length).toBe(steps + 1);
    S().undo();
    expect(snap(S().doc)).toEqual(before);

    const version = S().docVersion;
    const res2 = S().batch(() => {
      S().applyEdit({ add: [{ type: 'wall', transform: at(5, 20) }] });
      S().newDocument();
    });
    expect(res2.ok).toBe(false);
    expect(S().docVersion).toBe(version);
    expect(snap(S().doc)).toEqual(before);
  });

  it('a batch inside a batch joins it: one step; an inner exception rolls the outer batch back', () => {
    const { S } = world();
    const before = snap(S().doc);
    const steps = S().past.length;
    const res = S().batch(() => {
      S().applyEdit({ add: [{ type: 'wall', transform: at(5, 20) }] });
      const inner = S().batch(() => S().applyEdit({ add: [{ type: 'wall', transform: at(9, 20) }] }));
      expect(inner.ok).toBe(true);
      expect(S().past.length).toBe(steps);
    });
    expect(res.ok).toBe(true);
    expect(S().past.length).toBe(steps + 1);
    S().undo();
    expect(snap(S().doc)).toEqual(before);

    const res2 = S().batch(() => {
      S().applyEdit({ add: [{ type: 'wall', transform: at(5, 20) }] });
      S().batch(() => {
        S().setGroupName('g1', 'x');
        throw new Error('inner');
      });
    });
    expect(res2.ok).toBe(false);
    expect(snap(S().doc)).toEqual(before);
    expect(S().past.length).toBe(steps);
  });

  it('more sub-steps than the history holds are still one step; the older history is untouched', () => {
    const { S } = world();
    const before = snap(S().doc);
    const past = S().past;
    const res = S().batch(() => {
      for (let k = 0; k < 150; k++) S().applyEdit({ add: [{ type: 'crate', transform: at(-90 + k, -80) }] });
    });
    expect(res.ok).toBe(true);
    expect(S().past.length).toBe(past.length + 1);
    expect(S().past.slice(0, -1)).toEqual(past);
    S().undo();
    expect(snap(S().doc)).toEqual(before);
    expect(S().past).toEqual(past);
  });

  it('writes without history and a transaction inside a batch are part of its one step', () => {
    const { S } = world();
    const before = snap(S().doc);
    const steps = S().past.length;
    const id = Object.values(S().doc.objects).find((o) => o.type === 'tree')!.id;
    const res = S().batch(() => {
      S().updateTransform(id, { position: [40, 0, 40] }, { history: false });
      S().beginTransaction();
      S().updateTransform(id, { position: [41, 0, 41] }, { history: false });
      S().commitTransaction();
    });
    expect(res.ok && res.changed).toBe(true);
    expect(S().past.length).toBe(steps + 1);
    expect(S().doc.objects[id].transform.position[0]).toBe(41);
    S().undo();
    expect(snap(S().doc)).toEqual(before);
  });
});

describe('changedRect', () => {
  it('is the smallest rectangle around every vertex that differs; null when none does', () => {
    const t = createFlatTerrain(24, 1);
    const before = snapshotLayers(t);
    expect(changedRect(t, before)).toBeNull();
    t.heights[3 * t.nx + 5] = 1;
    expect(changedRect(t, before)).toEqual({ x0: 5, z0: 3, x1: 5, z1: 3 });
    t.ground[10 * t.nx + 2] = 4;
    t.soil[7 * t.nx + 20] = t.soil[7 * t.nx + 20] === 2 ? 3 : 2;
    expect(changedRect(t, before)).toEqual({ x0: 2, z0: 3, x1: 20, z1: 10 });
    // One patch over it restores the first and the last state exactly.
    const last = snapshotLayers(t);
    const patch = makePatch(t, before, changedRect(t, before)!);
    applyPatch(t, patch, 'before');
    expect(snapshotLayers(t)).toEqual(before);
    applyPatch(t, patch, 'after');
    expect(snapshotLayers(t)).toEqual(last);
    // −0 and 0 are different bits: a height that became −0 counts as changed (bit-identical undo).
    const u = createFlatTerrain(8, 1);
    const b2 = snapshotLayers(u);
    u.heights[0] = -0;
    expect(changedRect(u, b2)).toEqual({ x0: 0, z0: 0, x1: 0, z1: 0 });
  });
});
