/**
 * Phase 37 (§9): the command preview's model — the plan's difference turned into what the viewport draws. Plans are
 * made with the real pipeline (canonical text → intents → previewIntents on a fork); the model is checked against the
 * difference it came from.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId, Vec3 } from '@/core/types';
import { identityTransform } from '@/core/types';
import { parseCanonical } from '@/command/canonical';
import { emptyContext, type CommandContext } from '@/command/context';
import type { Intent } from '@/command/intent';
import type { PlanItem } from '@/command/planTypes';
import { previewIntents, type Preview } from '@/command/run';
import { getDefinition } from '@/objects/registry';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { worldFingerprint, terrainBitsHash } from '@/world/fingerprint';
import { scratchWorld } from '@/world/worldStore';
import { boxOf, buildPreviewModel, commandPins, countsOf, drawsAnything, emptyCounts, highlightMarks, NO_COMMAND_PINS, NODE_RING, pinMark, plannedOf, POINT_RING, previewKey, SETTLE_DISTANCE, settledOnly, warningsOf } from './previewModel';

const intents = (...lines: string[]): Intent[] =>
  lines.map((l) => {
    const r = parseCanonical(l);
    if (!r.ok) throw new Error(`not canonical: ${l} ${JSON.stringify(r.error)}`);
    return r.intent;
  });

/** An empty world with one straight street from (−60, 0) to (60, 0). */
function street() {
  const st = scratchWorld(createEmptyDocument());
  st.getState().applyEdit({ roads: drawRoad(st.getState().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
  return st;
}
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });

function plan(st: ReturnType<typeof street>, ctx: CommandContext, ...lines: string[]): Preview {
  const p = previewIntents(st.getState().doc, intents(...lines), ctx);
  if (!p.result.ok) throw new Error(JSON.stringify(p.result.failure));
  return p;
}
const bits = (st: ReturnType<typeof street>) => `${worldFingerprint(st.getState().doc)} ${terrainBitsHash(st.getState().doc)}`;

describe('added objects → ghosts', () => {
  it('three houses along the road: three ghosts that ARE the objects of the plan (type, seed, transform, design), three snap markers', () => {
    const st = street();
    const before = bits(st);
    const p = plan(st, emptyContext(), 'place building:house count=3 along=road:main side=north gap=2');
    const m = buildPreviewModel(p);
    expect(bits(st)).toBe(before); // building the model writes nothing
    const added = p.diff!.added;
    expect(added.length).toBe(3);
    expect(m.ghosts.length).toBe(3);
    expect(m.added).toBe(3);
    m.ghosts.forEach((g, k) => {
      expect(g.ok).toBe(true);
      expect(g.input.type).toBe('building');
      expect(g.input.seed).toBe(added[k].seed);
      expect(g.input.transform).toBe(added[k].transform);
      expect(g.input.building).toBe(added[k].building);
      expect(g.input.params).toBe(added[k].params);
    });
    // The ghost renderer builds each ghost with createWorldObject(input): with the seed passed through it is the same
    // object as the one the plan places (same generated parts), not a random sibling.
    const rebuilt = createWorldObject(m.ghosts[0].input, 0);
    expect(rebuilt.seed).toBe(added[0].seed);
    expect(rebuilt.components).toEqual(added[0].components);
    expect(rebuilt.params).toEqual(added[0].params);
    // Road frontage snap at every house.
    expect(m.snaps.map((s) => s.kind)).toEqual(['roadFront', 'roadFront', 'roadFront']);
    m.snaps.forEach((s, k) => {
      expect(s.x).toBeCloseTo(added[k].transform.position[0], 6);
      expect(s.z).toBeCloseTo(added[k].transform.position[2], 6);
    });
    expect(m.rejected).toEqual([]);
    expect(m.moved).toEqual([]);
    expect(m.removed).toEqual([]);
    expect(m.terrain).toBeNull();
    expect(countsOf(m, null)).toEqual({ ...emptyCounts(), ghosts: 3, snaps: 3 });
  });

  it('a ghost on top of an existing object is a warned ghost (the orange material); the count follows the plan items', () => {
    const st = street();
    st.getState().applyEdit({ add: [{ type: 'crate', transform: at(10, 30) }] });
    const p = plan(st, emptyContext(), 'place crate at=10,30', 'place crate at=40,30');
    const items = p.result.ok ? p.result.lines.flatMap((l) => l.plan.items) : [];
    expect(items.map((i) => i.status)).toEqual(['warn', 'ok']);
    const m = buildPreviewModel(p);
    expect(m.ghosts.length).toBe(2);
    expect(m.warned).toBe(1);
    const warned = m.ghosts.filter((g) => g.warnings.length > 0);
    expect(warned.length).toBe(1);
    expect(warned[0].input.transform.position[0]).toBe(10);
    expect(warned[0].warnings).toContain('overlap');
    expect(countsOf(m, null).warned).toBe(1);
  });

  it('an item outside the world is rejected: a marker at its place and no ghost', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'place crate count=3 at=99,30 gap=2');
    const items = p.result.ok ? p.result.lines[0].plan.items : [];
    const rejected = items.filter((i) => i.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.length).toBeLessThan(3);
    const m = buildPreviewModel(p);
    expect(m.rejected).toEqual(rejected.map((i) => ({ x: i.x, z: i.z })));
    expect(m.ghosts.length).toBe(3 - rejected.length);
    expect(m.ghosts.length).toBe(p.diff!.added.length);
    // No ghost stands where a rejected marker is.
    for (const r of m.rejected) expect(m.ghosts.some((g) => g.input.transform.position[0] === r.x && g.input.transform.position[2] === r.z)).toBe(false);
  });

  it('warningsOf: placement warnings of a warned item; nothing for ok / rejected / missing items', () => {
    const item = (status: PlanItem['status'], reasons: PlanItem['reasons']): PlanItem => ({ status, x: 0, z: 0, reasons });
    expect(warningsOf(item('warn', ['overlap', 'slope']))).toEqual(['overlap', 'slope']);
    expect(warningsOf(item('ok', []))).toEqual([]);
    expect(warningsOf(item('rejected', ['outside']))).toEqual([]);
    expect(warningsOf(undefined)).toEqual([]);
    // (a warned item is orange even when its reason is not one of the placement check's)
    expect(warningsOf(item('warn', ['room'])).length).toBe(1);
  });
});

describe('moved, removed, changed objects', () => {
  function crates() {
    const st = street();
    const ids = st.getState().applyEdit({ add: [{ type: 'crate', transform: at(10, 30) }, { type: 'crate', transform: at(20, 30) }, { type: 'barrel', transform: at(30, 30) }] });
    return { st, ids };
  }

  it('move: a ghost at the new transform and a link from the old box to the new one, per moved object', () => {
    const { st, ids } = crates();
    const p = plan(st, { ...emptyContext(), selection: [ids[0], ids[1]], primary: ids[0] }, 'move selection by=5,0,-3');
    const m = buildPreviewModel(p);
    expect(p.diff!.moved.length).toBe(2);
    expect(m.moved.length).toBe(2);
    expect(m.added).toBe(0);
    expect(m.ghosts.length).toBe(2);
    m.moved.forEach((link, k) => {
      const d = p.diff!.moved[k];
      expect(link.from.position).toEqual(d.before.transform.position);
      expect(link.to.position).toEqual(d.after.transform.position);
      expect(link.to.position[0] - link.from.position[0]).toBeCloseTo(5, 6);
      expect(link.to.position[2] - link.from.position[2]).toBeCloseTo(-3, 6);
      expect(m.ghosts[k].input.transform).toBe(d.after.transform);
      expect(m.ghosts[k].input.seed).toBe(d.after.seed);
    });
    const c = countsOf(m, null);
    expect([c.ghosts, c.moved, c.removed, c.changed]).toEqual([2, 2, 0, 0]);
  });

  it('delete: one box per removed object (size = dimensions × scale), nothing else', () => {
    const { st, ids } = crates();
    const p = plan(st, emptyContext(), 'delete type:crate');
    const m = buildPreviewModel(p);
    expect(m.removed.map((b) => b.id).sort()).toEqual([ids[0], ids[1]].sort());
    const o = st.getState().doc.objects[ids[0]];
    const d = getDefinition('crate').getDimensions(o.params);
    const box = m.removed.find((b) => b.id === ids[0])!;
    expect(box.size).toEqual([d[0], d[1], d[2]]);
    expect(box.position).toEqual(o.transform.position);
    expect(box.position).not.toBe(o.transform.position); // a copy: the model never hands out the document's arrays
    expect(m.ghosts).toEqual([]);
    expect(m.changed).toEqual([]);
    expect(countsOf(m, null).removed).toBe(2);
  });

  it('hide (a flag, not a move): changed boxes — not ghosts, not removed', () => {
    const { st, ids } = crates();
    const p = plan(st, emptyContext(), 'hide type:crate');
    const m = buildPreviewModel(p);
    expect(m.changed.map((b) => b.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(m.ghosts).toEqual([]);
    expect(m.removed).toEqual([]);
    expect(m.moved).toEqual([]);
    expect(countsOf(m, null).changed).toBe(2);
  });

  it('an object that only settles (moved by less than 5 cm) is marked as changed: no ghost flickering inside it, no arrow', () => {
    const o = createWorldObject({ type: 'crate', transform: at(10, 30) }, 1);
    const shift = (dx: number, dy: number, ry = 0) => ({ ...o, transform: { ...o.transform, position: [10 + dx, dy, 30] as Vec3, rotation: [0, ry, 0] as Vec3 } });
    expect(settledOnly(o, shift(0, 0.03))).toBe(true);
    expect(settledOnly(o, shift(0.03, 0.03))).toBe(true);
    expect(settledOnly(o, shift(0, 0.05))).toBe(false);
    expect(settledOnly(o, shift(0, 0, 0.02))).toBe(false);
    expect(settledOnly(o, { ...o, transform: { ...o.transform, scale: [1, 1.01, 1] } })).toBe(false);
    expect(SETTLE_DISTANCE).toBe(0.05);

    // In a plan: a crate lifted 3 cm and one lifted 1 m.
    const { st, ids } = crates();
    const low = buildPreviewModel(plan(st, { ...emptyContext(), selection: [ids[0]], primary: ids[0] }, 'move selection by=0,0.03,0'));
    expect([low.moved.length, low.ghosts.length, low.changed.map((b) => b.id)]).toEqual([0, 0, [ids[0]]]);
    const high = buildPreviewModel(plan(st, { ...emptyContext(), selection: [ids[0]], primary: ids[0] }, 'move selection by=0,1,0'));
    expect([high.moved.length, high.ghosts.length, high.changed.length]).toEqual([1, 1, 0]);
  });

  it('boxOf scales the box with the object', () => {
    const o = createWorldObject({ type: 'crate', transform: { position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [2, 3, 4] } }, 1);
    const d = getDefinition('crate').getDimensions(o.params);
    expect(boxOf(o)).toEqual({ id: o.id, position: [1, 2, 3], rotation: [0, 0.5, 0], size: [d[0] * 2, d[1] * 3, d[2] * 4] });
  });

  it('plannedOf passes the seed, the design and the slope alignment through', () => {
    const o = { ...createWorldObject({ type: 'tree', transform: at(0, 0), seed: 1234 }, 1), terrainAlign: 0.5 };
    const p = plannedOf(o);
    expect(p.input).toEqual({ type: 'tree', params: o.params, seed: 1234, transform: o.transform, terrainAlign: 0.5 });
    expect(p.ok).toBe(true);
    expect(p.warnings).toEqual([]);
  });
});

describe('terrain, roads, disasters', () => {
  it('terrain raise: the diff\'s rectangle and per-vertex change; down in the sign the heat-map mesh takes; the counts keep the diff\'s numbers', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'terrain raise circle -40,45 r=12 by=3');
    const t = p.diff!.terrain!;
    const m = buildPreviewModel(p);
    expect(m.terrain!.rect).toBe(t.rect);
    expect(m.terrain!.dh).toBe(t.dh);
    expect(m.terrain!.up).toBeCloseTo(3, 3);
    expect(m.terrain!.down).toBe(0);
    expect(Object.is(m.terrain!.down, -0)).toBe(false);
    expect(Array.from(m.terrain!.paint).every((v) => v === -1)).toBe(true);
    expect(countsOf(m, null).terrain).toEqual({ up: t.up, down: t.down, area: t.area });
    const low = buildPreviewModel(plan(st, emptyContext(), 'terrain lower circle -40,45 r=12 by=2'));
    expect(low.terrain!.down).toBeCloseTo(-2, 3);
    expect(countsOf(low, null).terrain!.down).toBeCloseTo(2, 3);
    expect(countsOf(low, null, 'pins').terrain).toBeNull();
  });

  it('paint: every painted vertex carries the ground type of the stroke, with one vertex of margin around the patch', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'paint circle 30,40 r=6 ground=sand');
    const stroke = p.result.ok ? p.result.lines[0].plan.ops.find((o) => o.op === 'terrain') : undefined;
    const ground = stroke && stroke.op === 'terrain' ? stroke.stroke.ground! : -1;
    expect(ground).toBeGreaterThan(0);
    const m = buildPreviewModel(p).terrain!;
    const painted = Array.from(m.painted);
    expect(painted.some((v) => v === 1)).toBe(true);
    painted.forEach((v, k) => { if (v) expect(m.paint[k]).toBe(ground); });
    // Around the patch: a margin in the same type, further out nothing.
    const values = new Set(Array.from(m.paint));
    expect([...values].sort()).toEqual([-1, ground].sort());
    expect(Array.from(m.paint).filter((v) => v === ground).length).toBeGreaterThanOrEqual(painted.filter((v) => v === 1).length);
  });

  it('road: the new segment\'s centre line from a to b with its width; a removed segment is listed from the document before', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'road 20,30 -> 20,70 preset=street');
    const m = buildPreviewModel(p);
    expect(m.roads.added.length).toBe(p.diff!.roads!.added.length);
    const seg = m.roads.added.find((r) => r.points[0][0] === 20 && r.points[0][1] === 30)!;
    expect(seg).toBeDefined();
    expect(seg.points[seg.points.length - 1]).toEqual([20, 70]);
    expect(seg.points.length).toBeGreaterThan(30); // about a point per metre
    expect(seg.width).toBe(p.diff!.roads!.network.segments[seg.id].profile.width);
    expect(countsOf(m, null).roads).toBe(m.roads.added.length);

    // A road that ends ON the street splits it: the old segment is removed (taken from the document before the plan).
    const tee = plan(st, emptyContext(), 'road 0,40 -> 0,0 preset=street');
    const mt = buildPreviewModel(tee);
    expect(tee.diff!.roads!.removed.length + tee.diff!.roads!.added.length).toBeGreaterThan(1);
    expect(mt.roads.removed.map((r) => r.id)).toEqual(tee.diff!.roads!.removed);
    for (const r of mt.roads.removed) expect(st.getState().doc.roads.segments[r.id]).toBeDefined();
    expect(countsOf(mt, null).roads).toBe(mt.roads.added.length + mt.roads.removed.length);
  });

  it('disaster: a ghost pin where the instance will be, with its footprint; the ground point is highlighted, the pin is not drawn twice', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'disaster blast at=12.34,-20 energy=1.8e9 start=5');
    const m = buildPreviewModel(p);
    const inst = p.diff!.instances.added[0];
    expect(m.pins).toEqual([{ id: inst.id, type: 'blast', category: 'impactBlast', at: [12.3, -20], footprint: m.pins[0].footprint, state: 'added' }]);
    expect(m.pins[0].footprint!.radius).toBeGreaterThan(0);
    expect(m.highlight.rings).toEqual([{ x: 12.3, z: -20, r: POINT_RING, of: 'point' }]);
    expect(m.highlight.pins).toEqual([]); // (the plan highlights its own instance: already a ghost pin)
    const c = countsOf(m, null);
    expect([c.pins, c.highlight, c.ghosts]).toEqual([1, 1, 0]);
    // The simulation scene's scope draws the same pin and ring.
    expect(countsOf(m, null, 'pins')).toEqual({ ...emptyCounts(), pins: 1, highlight: 1 });
  });

  it('moving and deleting a placed disaster: a "changed" pin at the new place, a "removed" pin at the old one', () => {
    const st = street();
    const first = previewIntents(st.getState().doc, intents('disaster fire at=10,20'), emptyContext());
    expect(first.result.ok).toBe(true);
    st.getState().setExperiment({ instances: first.diff!.instances.added });
    const id = first.diff!.instances.added[0].id;
    const moved = buildPreviewModel(plan(st, emptyContext(), `disaster ${id} move to=30,40`));
    expect(moved.pins.map((x) => [x.id, x.state, x.at, x.from])).toEqual([[id, 'changed', [30, 40], [10, 20]]]);
    const gone = buildPreviewModel(plan(st, emptyContext(), `disaster ${id} delete`));
    expect(gone.pins.map((x) => [x.id, x.state, x.at, x.from])).toEqual([[id, 'removed', [10, 20], undefined]]);
  });

  it('a disabled instance has no pin (the pin layer draws none for it)', () => {
    const st = street();
    const first = previewIntents(st.getState().doc, intents('disaster fire at=10,20'), emptyContext());
    const inst = first.diff!.instances.added[0];
    expect(pinMark(inst, 'highlight')).not.toBeNull();
    expect(pinMark({ ...inst, enabled: false }, 'highlight')).toBeNull();
  });

  it('a disaster without a place on the map (wind) has no pin', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'disaster wind speed=20');
    expect(p.diff!.instances.added.length).toBe(1);
    expect(buildPreviewModel(p).pins).toEqual([]);
  });
});

describe('highlights', () => {
  it('ids → boxes, segments → centre lines, nodes / points → ground rings, instances → pins; unknown ids are skipped, nothing twice', () => {
    const st = street();
    const [a] = st.getState().applyEdit({ add: [{ type: 'crate', transform: at(10, 30) }] });
    const first = previewIntents(st.getState().doc, intents('disaster fire at=10,20'), emptyContext());
    st.getState().setExperiment({ instances: first.diff!.instances.added });
    const doc = st.getState().doc;
    const seg = Object.keys(doc.roads.segments)[0], node = Object.keys(doc.roads.nodes)[0];
    const inst = doc.scenario.experiment!.instances[0].id;
    const h = highlightMarks([
      { ids: [a, 'nope' as EntityId], segments: [seg, 's999'], nodes: [node, 'n999'], points: [[5, 6]], instances: [inst, 'p999'] },
      { ids: [a], points: [[5, 6], [7, 8]] },
      null,
    ], { doc });
    expect(h.boxes.map((b) => b.id)).toEqual([a]);
    expect(h.lines.map((l) => l.id)).toEqual([seg]);
    expect(h.lines[0].points[0]).toEqual([-60, 0]);
    expect(h.rings).toEqual([
      { x: doc.roads.nodes[node].x, z: doc.roads.nodes[node].z, r: NODE_RING, of: 'node' },
      { x: 5, z: 6, r: POINT_RING, of: 'point' },
      { x: 7, z: 8, r: POINT_RING, of: 'point' },
    ]);
    expect(h.pins.map((x) => [x.id, x.state, x.at])).toEqual([[inst, 'highlight', [10, 20]]]);
    expect(countsOf(null, h).highlight).toBe(6);
    expect(countsOf(null, h, 'pins').highlight).toBe(5); // (no object boxes in the simulation scene)
  });

  it('what a plan already marks (removed / changed / moved) gets no second, white box over the marking', () => {
    const st = street();
    const ids = st.getState().applyEdit({ add: [{ type: 'crate', transform: at(10, 30) }, { type: 'crate', transform: at(20, 30) }] });
    const del = plan(st, emptyContext(), 'delete type:crate');
    // (the plan itself does highlight the ids it removes)
    expect(del.result.ok && del.result.lines[0].plan.highlight.ids?.slice().sort()).toEqual([...ids].sort());
    const m = buildPreviewModel(del);
    expect(m.removed.length).toBe(2);
    expect(m.highlight.boxes).toEqual([]);
    expect(buildPreviewModel(plan(st, emptyContext(), 'hide type:crate')).highlight.boxes).toEqual([]);
    expect(buildPreviewModel(plan(st, { ...emptyContext(), selection: ids, primary: ids[0] }, 'move selection by=5,0,0')).highlight.boxes).toEqual([]);
    // A highlight of other objects is kept.
    const h = highlightMarks([{ ids }], { doc: st.getState().doc, marked: new Set([ids[0]]) });
    expect(h.boxes.map((b) => b.id)).toEqual([ids[1]]);
  });
});

describe('commandPins — which real disaster pins a command shows', () => {
  const none = { k: 'none' } as const;

  it('nothing open, nothing done: no pins are asked for (the pin layer behaves as before Phase 37)', () => {
    expect(commandPins(null, none, null)).toBe(NO_COMMAND_PINS);
    const st = street();
    // A plan without disasters does not show the pins either.
    expect(commandPins(plan(st, emptyContext(), 'place crate at=10,30'), none, null)).toBe(NO_COMMAND_PINS);
  });

  it('a plan that places a disaster: every placed pin is shown while it is open', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'disaster blast at=12,-20 energy=1.8e9');
    const c = commandPins(p, none, null);
    expect(c.all).toBe(true);
    expect(c.removing).toEqual([]);
  });

  it('a plan that deletes a disaster: its pin is marked as going; one that moves it marks nothing', () => {
    const st = street();
    const first = previewIntents(st.getState().doc, intents('disaster fire at=10,20', 'disaster blast at=40,20'), emptyContext());
    st.getState().setExperiment({ instances: first.diff!.instances.added });
    const [fire] = first.diff!.instances.added;
    const del = commandPins(plan(st, emptyContext(), `disaster ${fire.id} delete`), none, null);
    expect(del).toEqual({ all: true, show: [fire.id], removing: [fire.id], emphasis: [fire.id] });
    const move = commandPins(plan(st, emptyContext(), `disaster ${fire.id} move to=30,40`), none, null);
    expect(move.all).toBe(true);
    expect(move.removing).toEqual([]);
  });

  it('after the confirm: the pin of the disaster the command just placed is shown — from the command\'s result, with nothing selected', () => {
    const st = street();
    const p = plan(st, emptyContext(), 'disaster blast at=12,-20 energy=1.8e9');
    const lines = p.result.ok ? p.result.lines : [];
    const id = p.diff!.instances.added[0].id;
    const c = commandPins(null, { k: 'done', lines }, null);
    expect(c).toEqual({ all: false, show: [id], removing: [], emphasis: [] });
    // Another kind of feedback (a question, an error) shows nothing of an earlier result.
    expect(commandPins(null, { k: 'error', lines }, null)).toBe(NO_COMMAND_PINS);
  });

  it('the option under the pointer in a question: its instances are shown and emphasised without a plan', () => {
    expect(commandPins(null, none, { instances: ['p2'] })).toEqual({ all: false, show: ['p2'], removing: [], emphasis: ['p2'] });
    expect(commandPins(null, none, { ids: [] })).toBe(NO_COMMAND_PINS);
  });
});

describe('keys and counts', () => {
  it('the same plan on the same document has the same key (typing on, or Enter, rebuilds nothing); another plan or another document does not', () => {
    const st = street();
    const a = plan(st, emptyContext(), 'place crate at=10,30');
    const b = plan(st, emptyContext(), 'place crate at=10,30');
    const c = plan(st, emptyContext(), 'place crate at=11,30');
    expect(a).not.toBe(b);
    expect(previewKey(a)).toBe(previewKey(b));
    expect(previewKey(c)).not.toBe(previewKey(a));
    st.getState().applyEdit({ add: [{ type: 'barrel', transform: at(-30, -30) }] });
    const d = plan(st, emptyContext(), 'place crate at=10,30');
    expect(d.result.ok && a.result.ok && d.result.hash === a.result.hash).toBe(true);
    expect(previewKey(d)).not.toBe(previewKey(a));
  });

  it('nothing to draw: an empty model draws nothing', () => {
    expect(drawsAnything(emptyCounts())).toBe(false);
    expect(drawsAnything(countsOf(null, null))).toBe(false);
    const st = street();
    const m = buildPreviewModel(plan(st, emptyContext(), 'place crate at=10,30'));
    expect(drawsAnything(countsOf(m, null))).toBe(true);
    expect(drawsAnything(countsOf(m, null, 'pins'))).toBe(false); // an object plan draws nothing in the pins scope
    expect(drawsAnything({ ...emptyCounts(), terrain: { up: 1, down: 0, area: 4 } })).toBe(true);
  });

  it('a script: every line\'s part is in one model', () => {
    const st = street();
    const p = plan(st, emptyContext(),
      'place building:house count=3 along=road:main side=north gap=2',
      'terrain raise circle -40,45 r=12 by=3',
      'road 20,30 -> 20,70 preset=street',
      'disaster blast at=40,-30 energy=1.8e9',
    );
    const m = buildPreviewModel(p);
    const c = countsOf(m, null);
    expect(c.ghosts).toBe(3);
    expect(c.terrain).not.toBeNull();
    expect(c.roads).toBeGreaterThan(0);
    expect(c.pins).toBe(1);
    expect(c.snaps).toBe(3);
  });
});
