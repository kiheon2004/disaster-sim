/**
 * Phase 37 (§8, §11, §13, §20): planning — what a canonical command becomes on a document. Positions and values are
 * checked against the rules (frontage 1 m behind the sidewalk facing the road, lane centres, exact heights …), not
 * against a recorded output.
 */
import { describe, expect, it } from 'vitest';
import type { WorldDocument, WorldObject } from '@/core/model';
import { identityTransform, type Vec3 } from '@/core/types';
import { designParams } from '@/buildings/design';
import { presetDesign } from '@/buildings/presetDesign';
import { footprintHalves } from '@/editor/snap/snapEngine';
import { catalogOf } from '@/phenomena/catalog';
import { phenomena } from '@/phenomena/registry';
import { createInstance } from '@/phenomena/schedule';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { EventSpec } from '@/events/specs';
import { sectionAt } from '@/roads/crossSection';
import { nearest } from '@/roads/curve';
import { drawRoad, segmentLine } from '@/roads/network';
import { defaultProfile, PROFILE_PRESETS, type RoadProfile } from '@/roads/types';
import { yawOf } from '@/terrain/groundPlacement';
import { createEmptyDocument } from '@/world/WorldDocument';
import { defaultTownObjects, defaultTownRoads } from '@/world/defaultTown';
import { scratchWorld } from '@/world/worldStore';
import { parseCanonical } from './canonical';
import { emptyContext, envOf, orderedObjects, type CommandContext } from './context';
import { planIntent } from './plan';
import { applyOps } from './run';
import type { Plan, PlanResult } from './planTypes';

const profile = (preset: string): RoadProfile => ({ ...defaultProfile(), ...PROFILE_PRESETS[preset] });
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });

/** An empty flat world with one straight street from (−60, 0) to (60, 0). */
function street(a: [number, number] = [-60, 0], b: [number, number] = [60, 0], preset = 'street') {
  const st = scratchWorld(createEmptyDocument());
  st.getState().applyEdit({ roads: drawRoad(st.getState().doc.roads, [a, b], { curved: false, profile: profile(preset) }).network });
  return st;
}
function town() {
  const st = scratchWorld(createEmptyDocument());
  st.getState().applyEdit({ roads: defaultTownRoads(), add: defaultTownObjects() });
  return st;
}

function plan(doc: WorldDocument, text: string, ctx: CommandContext = emptyContext()): PlanResult {
  const r = parseCanonical(text);
  if (!r.ok) throw new Error(`not canonical: ${text} ${JSON.stringify(r.error)}`);
  return planIntent(r.intent, envOf(doc, ctx), { seed: doc.settings.simulation.seed });
}
function ok(doc: WorldDocument, text: string, ctx?: CommandContext): Plan {
  const r = plan(doc, text, ctx);
  if (!r.ok) throw new Error(`${text} → ${JSON.stringify('error' in r ? r.error : r.clarify.question)}`);
  return r.plan;
}
const errorKey = (r: PlanResult) => (!r.ok && 'error' in r ? r.error.key : r.ok ? 'ok' : 'clarify');
const added = (p: Plan) => p.ops.flatMap((op) => (op.op === 'edit' ? op.edit.add ?? [] : op.op === 'stamp' ? op.inputs : []));
const updated = (p: Plan) => p.ops.flatMap((op) => (op.op === 'edit' ? op.edit.update ?? [] : []));
const keys = (list: { key: string }[]) => list.map((m) => m.key);

describe('place along a road', () => {
  const house = footprintHalves('building', designParams(presetDesign('house', 2)!));

  it('three houses on the north side, 2 m apart: frontage snap, 1 m behind the sidewalk, facing the road', () => {
    const doc = street().getState().doc;
    const p = ok(doc, 'place building:house count=3 along=road:main side=north gap=2 floors=2');
    const inputs = added(p);
    expect(inputs.length).toBe(3);
    expect(p.counts).toEqual({ create: 3, change: 0, remove: 0 });
    // Street: 7 m carriageway + 2 m sidewalks → the sidewalk's outer edge 5.5 m from the axis; setback 1 m.
    const z = -(3.5 + 2 + 1 + house[1]);
    inputs.forEach((input, k) => {
      expect(input.transform.position[2]).toBeCloseTo(z, 6);
      // From the west end of the road: footprints side by side with 2 m between them.
      expect(input.transform.position[0]).toBeCloseTo(-60 + house[0] + k * (2 * house[0] + 2), 6);
      // A building's front is its local +z: on the north side it looks south, at the road — heading 0.
      expect(yawOf(input.transform.rotation)).toBeCloseTo(0, 9);
      expect(input.building?.spec.floors).toBe(2);
      expect(typeof input.seed).toBe('number');
    });
    expect(p.items.map((x) => [x.status, x.snap])).toEqual([['ok', 'roadFront'], ['ok', 'roadFront'], ['ok', 'roadFront']]);
    expect(keys(p.notes)).toContain('cmd37.note.side');
    expect(p.immediate).toBe(false);
    // The same command on the same document: the same plan, value for value.
    expect(added(ok(doc, 'place building:house count=3 along=road:main side=north gap=2 floors=2'))).toEqual(inputs);
  });

  it('the south side faces north; left / right are relative to the road from its west end', () => {
    const doc = street().getState().doc;
    const south = added(ok(doc, 'place building:house count=2 along=road:main side=south'));
    expect(south[0].transform.position[2]).toBeCloseTo(3.5 + 2 + 1 + house[1], 6);
    expect(Math.abs(yawOf(south[0].transform.rotation))).toBeCloseTo(Math.PI, 9);
    // No gap said: buildings touch (the default, said in a note).
    expect(south[1].transform.position[0] - south[0].transform.position[0]).toBeCloseTo(2 * house[0], 6);
    // West → east travel: right = south, left = north — whichever way the road was drawn.
    for (const st of [street([-60, 0], [60, 0]), street([60, 0], [-60, 0])]) {
      const d2 = st.getState().doc;
      expect(added(ok(d2, 'place building:house along=road:main side=right'))[0].transform.position[2]).toBeGreaterThan(0);
      expect(added(ok(d2, 'place building:house along=road:main side=left'))[0].transform.position[2]).toBeLessThan(0);
      expect(added(ok(d2, 'place building:house along=road:main side=north'))[0].transform.position[2]).toBeLessThan(0);
    }
  });

  it('not enough road: as many as fit, and it says so', () => {
    const doc = street([-12, 0], [12, 0]).getState().doc;
    const p = ok(doc, 'place building:house count=10 along=road:main side=north gap=2');
    const fit = Math.floor((24 + 2) / (2 * house[0] + 2));
    expect(added(p).length).toBe(fit);
    expect(fit).toBeGreaterThan(0);
    expect(fit).toBeLessThan(10);
    expect(p.warnings).toContainEqual({ key: 'cmd37.warn.room', params: { placed: fit, count: 10 } });
    // Every house is within the road's ends.
    for (const input of added(p)) expect(Math.abs(input.transform.position[0]) + house[0]).toBeLessThanOrEqual(12 + 1e-6);
  });

  it('no side said, or a compass side the road does not have: a question with the two sides', () => {
    const doc = street().getState().doc;
    const q = plan(doc, 'place building:house count=3 along=road:main');
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.question.key).toBe('cmd37.ask.side');
    expect(q.clarify.options.map((o) => o.canonical)).toEqual(['place building:house count=3 along=road:main side=left', 'place building:house count=3 along=road:main side=right']);
    // Each option is a complete command that plans.
    for (const o of q.clarify.options) expect(planIntent(o.intent, envOf(doc, emptyContext()), { seed: 1 }).ok).toBe(true);
    // A road running north–south has an east and a west side: "north" is one of its ends.
    const ns = street([0, -60], [0, 60]).getState().doc;
    expect(errorKey(plan(ns, 'place building:house along=road:main side=north'))).toBe('clarify');
    expect(added(ok(ns, 'place building:house along=road:main side=east'))[0].transform.position[0]).toBeGreaterThan(0);
  });

  it('the mouth of a side road is left free on its side only', () => {
    const doc = town().getState().doc; // main street west–east, side street south from (−23, 0)
    // (the town's frontages are built up: overlaps are warnings, not what is tested here)
    const south = added(ok(doc, 'place building:house count=40 along=road:main side=south'));
    const north = added(ok(doc, 'place building:house count=40 along=road:main side=north'));
    const nearMouth = (x: number) => Math.abs(x + 23) < 3.5 + 2 + 1 + house[0] - 1e-6;
    expect(south.some((i) => nearMouth(i.transform.position[0]))).toBe(false);
    expect(north.some((i) => nearMouth(i.transform.position[0]))).toBe(true);
    expect(south.length).toBeLessThan(north.length);
  });

  it('cars stand on a lane, heading the lane\'s way; people on the sidewalk', () => {
    const doc = street().getState().doc;
    const seg = Object.values(doc.roads.segments)[0];
    const line = segmentLine(doc.roads, seg);
    const cars = ok(doc, 'place car count=5 along=road:main');
    expect(added(cars).length).toBe(5);
    expect(cars.items.every((x) => x.snap === 'roadLane' && x.status === 'ok')).toBe(true);
    const lanes = sectionAt(doc.roads, seg, 10).lanes;
    for (const c of added(cars)) {
      const h = nearest(line, c.transform.position[0], c.transform.position[2]);
      // On a lane centre of the road …
      expect(lanes.some((lat) => lat !== null && Math.abs(Math.abs(lat) - h.dist) < 1e-6)).toBe(true);
      // … the right-hand lane of west → east travel (south of the axis), heading east (a car's front is local +x).
      expect(c.transform.position[2]).toBeGreaterThan(0);
      expect(yawOf(c.transform.rotation)).toBeCloseTo(0, 9);
    }
    // 3 m between cars when no gap is said.
    const xs = added(cars).map((c) => c.transform.position[0]);
    expect(xs[1] - xs[0]).toBeCloseTo(4.5 + 3, 6);
    // The other side: the lane of the other direction, heading west.
    const left = added(ok(doc, 'place car count=2 along=road:main side=left'));
    expect(left[0].transform.position[2]).toBeLessThan(0);
    expect(Math.abs(yawOf(left[0].transform.rotation))).toBeCloseTo(Math.PI, 9);
    // People: between the kerb (3.5 m) and the sidewalk's outer edge (5.5 m).
    const people = added(ok(doc, 'place human count=4 along=road:main'));
    expect(people.length).toBe(4);
    for (const h of people) {
      expect(Math.abs(h.transform.position[2])).toBeGreaterThan(3.5);
      expect(Math.abs(h.transform.position[2])).toBeLessThan(5.5);
    }
  });

  it('where a road narrows the outer lanes end: no car stands on an ended lane, the row goes on in the open kerb lane', () => {
    // Four lanes narrowing to two: the outer lanes end in the taper.
    const st = scratchWorld(createEmptyDocument());
    let net = drawRoad(st.getState().doc.roads, [[-80, 0], [0, 0]], { curved: false, profile: profile('avenue') }).network;
    net = drawRoad(net, [[0, 0], [80, 0]], { curved: false, profile: profile('street') }).network;
    st.getState().applyEdit({ roads: net });
    const doc = st.getState().doc;
    const node = (x: number) => Object.values(doc.roads.nodes).find((n) => n.x === x && n.z === 0)!.id;
    const p = ok(doc, `place car count=30 along=road:${node(-80)}-${node(80)}`);
    expect(added(p).length).toBeGreaterThan(10);
    for (const c of added(p)) {
      const seg = Object.values(doc.roads.segments).map((s) => ({ s, h: nearest(segmentLine(doc.roads, s), c.transform.position[0], c.transform.position[2]) })).sort((a, b) => a.h.dist - b.h.dist)[0];
      const lanes = sectionAt(doc.roads, seg.s, seg.h.s).lanes.filter((l): l is number => l !== null);
      expect(lanes.some((lat) => Math.abs(Math.abs(lat) - seg.h.dist) < 0.05), `car at ${c.transform.position[0]}`).toBe(true);
    }
    // 160 m of road, 4.5 m cars 3 m apart: 21 fit — on the outer lane of the avenue (5.25 m from its axis), then, where
    // that lane has ended, on the street's one lane (1.75 m).
    expect(added(p).length).toBe(21);
    const zs = added(p).map((c) => Math.round(c.transform.position[2] * 100) / 100);
    expect(zs[0]).toBe(5.25);
    expect(zs[zs.length - 1]).toBe(1.75);
    expect(p.items.filter((x) => x.status === 'rejected')).toEqual([]);
  });
});

describe('place at a place', () => {
  it('one object at the place; several in a row from west to east; a heading as the Inspector shows it', () => {
    const doc = createEmptyDocument();
    const one = added(ok(doc, 'place building:house at=10,-20 heading=90'));
    expect(one[0].transform.position).toEqual([10, 0, -20]);
    expect(yawOf(one[0].transform.rotation)).toBeCloseTo(Math.PI / 2, 9);
    const row = ok(doc, 'place tree count=3 at=0,0 gap=4');
    const xs = added(row).map((t) => t.transform.position[0]);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 6);
    expect(xs[0] + xs[2]).toBeCloseTo(0, 6);
    expect(keys(row.notes)).toContain('cmd37.note.row');
    // "Here" needs the mouse to have been over the map; without a place at all the planner asks where.
    expect(errorKey(plan(doc, 'place tree at=cursor'))).toBe('cmd37.err.noCursor');
    expect(added(ok(doc, 'place tree at=cursor', { ...emptyContext(), cursor: [7, 8] }))[0].transform.position).toEqual([7, 0, 8]);
    const q = plan(doc, 'place tree count=2', { ...emptyContext(), cursor: [7, 8] });
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.options.map((o) => o.canonical)).toEqual(['place tree count=2 at=cursor', 'place tree count=2 at=center']);
  });

  it('outside the world: that item is rejected; when nothing is left the command fails', () => {
    const doc = createEmptyDocument();
    // A row of three centred on x = 92 (8.4 m wide houses, 2 m apart): 81.6, 92 and 102.4 — the last one is outside ±100.
    const p = ok(doc, 'place building:house count=3 at=92,0 gap=2');
    expect(p.items.map((x) => x.status)).toEqual(['ok', 'ok', 'rejected']);
    expect(p.items[2].reasons).toEqual(['outside']);
    expect(added(p).length).toBe(2);
    expect(p.warnings).toContainEqual({ key: 'cmd37.warn.rejected', params: { count: 1 } });
    expect(errorKey(plan(doc, 'place building:house at=150,0'))).toBe('cmd37.err.nothingPlaced');
  });

  it('overlap and water are warnings (orange), not rejections', () => {
    const st = scratchWorld(createEmptyDocument());
    st.getState().applyEdit({ add: [{ type: 'building', building: presetDesign('house', 2)!, transform: at(0, 0), seed: 1 }] });
    const p = ok(st.getState().doc, 'place building:house at=2,1');
    expect(p.items).toMatchObject([{ status: 'warn', reasons: ['overlap'] }]);
    expect(added(p).length).toBe(1);
    expect(keys(p.warnings)).toContain('cmd37.warn.placement');
  });

  it('kinds, presets and floors', () => {
    const doc = createEmptyDocument();
    // A bare type is its default preset — and the plan says which.
    const b = ok(doc, 'place building at=0,0');
    expect(added(b)[0].building?.preset).toBe('house');
    expect(b.notes).toContainEqual({ key: 'cmd37.note.defaultPreset', params: { kind: 'building:house' } });
    expect(added(ok(doc, 'place building:apartment at=0,0 floors=4'))[0].building?.spec.floors).toBe(4);
    expect(added(ok(doc, 'place car:truck at=0,0'))[0].params).toMatchObject({ variant: 'truck' });
    expect(added(ok(doc, 'place building:boxHouse at=0,0 floors=3'))[0]).toMatchObject({ params: { floors: 3 } });
    expect(added(ok(doc, 'place building:boxHouse at=0,0'))[0].building).toBeUndefined();
    expect(errorKey(plan(doc, 'place building:house at=0,0 floors=99'))).toBe('cmd37.err.floors');
    expect(errorKey(plan(doc, 'place tree at=0,0 floors=2'))).toBe('cmd37.err.floorsNotBuilding');
    expect(errorKey(plan(doc, 'place spaceship at=0,0'))).toBe('cmd37.err.unknownKind');
    expect(errorKey(plan(doc, 'place road at=0,0'))).toBe('cmd37.err.placeRoad');
    expect(errorKey(plan(doc, 'place tree count=5000 at=0,0'))).toBe('cmd37.err.tooMany');
  });

  it('trees vary from a seed made of the document seed and the command text — never from Math.random', () => {
    const doc = createEmptyDocument();
    const a = added(ok(doc, 'place tree count=4 at=0,0')), b = added(ok(doc, 'place tree count=4 at=0,0'));
    expect(a).toEqual(b);
    expect(new Set(a.map((t) => t.seed)).size).toBe(4);
    expect(added(ok(doc, 'place tree count=4 at=0,1'))[0].seed).not.toBe(a[0].seed);
    const other = { ...doc, settings: { ...doc.settings, simulation: { ...doc.settings.simulation, seed: doc.settings.simulation.seed + 1 } } };
    expect(added(ok(other, 'place tree count=4 at=0,0'))[0].seed).not.toBe(a[0].seed);
  });
});

describe('edits of existing objects', () => {
  const setup = () => {
    const st = town();
    const S = () => st.getState();
    const all = () => orderedObjects(S().doc);
    const of = (type: string) => all().filter((o) => o.type === type);
    return { st, S, all, of };
  };
  const sel = (objs: WorldObject[], primary?: WorldObject): CommandContext => ({ ...emptyContext(), selection: objs.map((o) => o.id), primary: (primary ?? objs[0])?.id ?? null });

  it('select / add / remove are effects; hidden and locked objects are part of a selection and it is said', () => {
    const { S, of } = setup();
    const trees = of('tree'), cars = of('car');
    S().applyEdit({ update: [{ ...trees[0], hidden: true }, { ...trees[1], locked: true }] });
    const p = ok(S().doc, 'select type:tree');
    expect(p.ops).toEqual([]);
    expect(p.immediate).toBe(true);
    expect(p.effects).toMatchObject([{ fx: 'select' }]);
    expect((p.effects[0] as { ids: string[] }).ids.length).toBe(trees.length);
    expect(p.notes).toContainEqual({ key: 'cmd37.note.selectFlags', params: { hidden: 1, locked: 1 } });
    const add = ok(S().doc, 'add type:car', sel(trees.slice(0, 2)));
    expect((add.effects[0] as { ids: string[] }).ids.length).toBe(2 + cars.length);
    const rem = ok(S().doc, 'remove type:tree', sel([...trees.slice(0, 2), cars[0]]));
    expect((rem.effects[0] as { ids: string[] }).ids).toEqual([cars[0].id]);
    expect(ok(S().doc, 'select none').effects).toEqual([{ fx: 'select', ids: [], primary: null }]);
  });

  it('move by an offset / to a place; rotate; scale', () => {
    const { S, of } = setup();
    const cars = of('car').slice(0, 2);
    const moved = updated(ok(S().doc, 'move selection by=5,0,-3', sel(cars)));
    moved.forEach((o, k) => {
      expect(o.transform.position[0]).toBeCloseTo(cars[k].transform.position[0] + 5, 6);
      expect(o.transform.position[2]).toBeCloseTo(cars[k].transform.position[2] - 3, 6);
    });
    // Up by half a metre: lifted (not re-seated).
    expect(updated(ok(S().doc, 'move selection by=0,0.5,0', sel(cars)))[0].transform.position[1]).toBeCloseTo(cars[0].transform.position[1] + 0.5, 6);
    // To a place: the pivot (centre of the two) goes there, their layout is kept.
    const to = updated(ok(S().doc, 'move selection to=0,40', sel(cars)));
    expect((to[0].transform.position[0] + to[1].transform.position[0]) / 2).toBeCloseTo(0, 6);
    expect(to[1].transform.position[0] - to[0].transform.position[0]).toBeCloseTo(cars[1].transform.position[0] - cars[0].transform.position[0], 6);
    // Rotation: +90° is counter-clockwise seen from above, the sign of the Inspector's Y heading.
    const turned = updated(ok(S().doc, 'rotate selection by=90', sel([cars[0]])));
    expect(yawOf(turned[0].transform.rotation) - yawOf(cars[0].transform.rotation)).toBeCloseTo(Math.PI / 2, 6);
    const big = ok(S().doc, 'scale selection x2', sel([cars[0], of('building')[0]]));
    expect(updated(big).find((o) => o.type === 'car')!.transform.scale).toEqual([2, 2, 2]);
    expect(keys(big.notes)).toContain('cmd37.note.modularScale');
  });

  it('locked objects are never changed; hidden ones only when they are named', () => {
    const { S, of } = setup();
    const trees = of('tree');
    S().applyEdit({ update: [{ ...trees[0], hidden: true }, { ...trees[1], locked: true }] });
    const swept = ok(S().doc, 'move type:tree by=1,0,0');
    expect(updated(swept).length).toBe(trees.length - 2);
    expect(swept.notes).toContainEqual({ key: 'cmd37.note.lockedSkipped', params: { count: 1 } });
    expect(swept.notes).toContainEqual({ key: 'cmd37.note.hiddenSkipped', params: { count: 1 } });
    // Named by the selection: the hidden one moves, the locked one still does not.
    const named = ok(S().doc, 'move selection by=1,0,0', sel(orderedObjects(S().doc).filter((o) => o.type === 'tree').slice(0, 3)));
    expect(updated(named).length).toBe(2);
    expect(updated(ok(S().doc, 'delete type:tree where hidden').ops.length ? ok(S().doc, 'move type:tree where hidden by=1,0,0') : swept).length).toBe(1);
    expect(errorKey(plan(S().doc, 'move type:tree where locked by=1,0,0'))).toBe('cmd37.err.nothingEditable');
    // Flags themselves can always be changed (how else would one unlock).
    expect(updated(ok(S().doc, 'unlock type:tree where locked')).length).toBe(1);
  });

  it('a move that would leave the world: those objects stay, and it is said; all of them → an error', () => {
    const { S, of } = setup();
    const cars = of('car');
    // 70 m east: the truck (at x = 32, 8 m long) would end at 102 ± 4 — outside ±100; the SUV at 24 ends at 94 ± 2.4.
    const p = ok(S().doc, 'move type:car by=70,0,0');
    expect(updated(p).length).toBe(cars.length - 1);
    expect(updated(p).some((o) => (o.params as { variant?: string }).variant === 'truck')).toBe(false);
    expect(p.warnings).toContainEqual({ key: 'cmd37.warn.outside', params: { count: 1 } });
    expect(errorKey(plan(S().doc, 'move type:car by=500,0,0'))).toBe('cmd37.err.allOutside');
  });

  it('align by a world axis or by the fronts; distribute; match; copy', () => {
    const { S, of } = setup();
    const north = of('building').filter((b) => b.transform.position[2] < 0); // all face south (the street)
    const aligned = updated(ok(S().doc, 'align selection axis=z mode=max ref=footprint', sel(north)));
    expect(aligned.length).toBeGreaterThan(0);
    // "Fronts": they all face south → the south edges, said in a note.
    const fronts = ok(S().doc, 'align selection edge=front ref=footprint', sel(north));
    expect(updated(fronts)).toEqual(aligned);
    expect(fronts.notes).toContainEqual({ key: 'cmd37.note.alignEdge', params: { edge: '@cmd37.edge.front', compass: '@cmd37.dir.south' } });
    // Buildings of both sides of the street face opposite ways: which edges? — a question with the four.
    const q = plan(S().doc, 'align selection edge=front ref=footprint', sel(of('building')));
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.options.map((o) => o.canonical)).toEqual([
      'align selection axis=z mode=min ref=footprint', 'align selection axis=z mode=max ref=footprint', 'align selection axis=x mode=min ref=footprint', 'align selection axis=x mode=max ref=footprint',
    ]);
    expect(errorKey(plan(S().doc, 'align selection axis=x mode=min', sel(north.slice(0, 1))))).toBe('cmd37.err.needTwo');
    // Already aligned objects: nothing changes, no operation.
    S().applyEdit({ update: aligned });
    const again = ok(S().doc, 'align selection axis=z mode=max ref=footprint', sel(orderedObjects(S().doc).filter((o) => north.some((n) => n.id === o.id))));
    expect(again.ops).toEqual([]);
    expect(keys(again.notes)).toContain('cmd37.note.noChange');
    // Distribute: the axis they are spread along (x for a row along the street), said.
    const dist = ok(S().doc, 'distribute selection axis=auto gaps', sel(north));
    expect(dist.notes).toContainEqual({ key: 'cmd37.note.axisAuto', params: { axis: '@cmd37.axis.x' } });
    expect(errorKey(plan(S().doc, 'distribute selection axis=x', sel(north.slice(0, 2))))).toBe('cmd37.err.needThree');
    // Match: the reference is the primary selection, or the one named.
    const cars = of('car');
    const m = ok(S().doc, 'match selection heading', sel(cars, cars[8]));
    expect(updated(m).every((o) => Math.abs(Math.abs(yawOf(o.transform.rotation)) - Math.abs(yawOf(cars[8].transform.rotation))) < 1e-6)).toBe(true);
    expect(keys(m.notes)).toContain('cmd37.note.referencePrimary');
    expect(errorKey(plan(S().doc, 'match selection heading', { ...sel(cars), primary: null }))).toBe('cmd37.err.noReference');
    expect(ok(S().doc, `match selection scale to=#${cars[0].id}`, sel(cars)).ops).toEqual([]);
    // Copy: applied where it applies, skipped (and counted) where it does not.
    const b = of('building');
    const c = ok(S().doc, `copy structure from=#${b[0].id} to=selection`, sel([...b.slice(1, 3), cars[0]]));
    expect(c.notes.find((n) => n.key === 'cmd37.note.copied')?.params).toMatchObject({ skipped: 1 });
  });

  it('group with a name = two operations of one command; ungroup; rename', () => {
    const { S, of } = setup();
    const trees = of('tree').slice(0, 3);
    const g = ok(S().doc, 'group selection name="북쪽 블록"', sel(trees));
    expect(g.ops.map((o) => o.op)).toEqual(['edit', 'groupName']);
    const id = (g.ops[1] as { group: string }).group;
    expect(updated(g).every((o) => o.group === id)).toBe(true);
    // The id comes from the command (the same command plans the same id) and is free in the document.
    expect((ok(S().doc, 'group selection name="북쪽 블록"', sel(trees)).ops[1] as { group: string }).group).toBe(id);
    expect(errorKey(plan(S().doc, 'group selection', sel(trees.slice(0, 1))))).toBe('cmd37.err.needTwo');
    S().applyEdit({ update: updated(g) });
    S().setGroupName(id, '북쪽 블록');
    expect((ok(S().doc, 'group selection name="북쪽 블록"', sel(of('car').slice(0, 2))).ops[1] as { group: string }).group).not.toBe(id);
    // Rename: a whole group → its name; one object → its name; a mix → not one thing to name.
    expect(ok(S().doc, 'rename group:"북쪽 블록" "North block"').ops).toEqual([{ op: 'groupName', group: id, name: 'North block' }]);
    const one = ok(S().doc, `rename #${of('car')[0].id} "Taxi"`);
    expect(updated(one)[0].name).toBe('Taxi');
    expect(errorKey(plan(S().doc, 'rename type:car "Taxi"'))).toBe('cmd37.err.renameMany');
    expect(updated(ok(S().doc, 'ungroup group:"북쪽 블록"')).every((o) => o.group === undefined)).toBe(true);
    expect(errorKey(plan(S().doc, 'ungroup type:car'))).toBe('cmd37.err.notGrouped');
  });

  it('hide drops the hidden objects from the selection; delete says when a group is cut; duplicate is a stamp', () => {
    const { S, of } = setup();
    const trees = of('tree');
    const h = ok(S().doc, 'hide type:tree', sel([trees[0], of('car')[0]]));
    expect(updated(h).every((o) => o.hidden === true)).toBe(true);
    expect(h.effects).toEqual([{ fx: 'select', ids: [of('car')[0].id], primary: of('car')[0].id }]);
    expect(ok(S().doc, 'show type:tree').ops).toEqual([]);
    S().applyEdit({ update: trees.slice(0, 3).map((o) => ({ ...o, group: 'g1' })) });
    const del = ok(S().doc, 'delete selection', sel([trees[0]]));
    // (the selection means whole groups, as in the editor: all three go)
    expect((del.ops[0] as { edit: { remove: string[] } }).edit.remove.length).toBe(3);
    expect(del.immediate).toBe(false);
    const part = ok(S().doc, `delete #${trees[0].id}`);
    expect(part.counts.remove).toBe(1);
    expect(keys(part.warnings)).toContain('cmd37.warn.partialGroup');
    const dup = ok(S().doc, 'duplicate selection offset=0,30', sel(of('car').slice(0, 2)));
    expect(dup.ops[0]).toMatchObject({ op: 'stamp', keys: ['0', '1'], cars: null });
    expect(added(dup).map((c) => c.transform.position[2])).toEqual(of('car').slice(0, 2).map((c) => c.transform.position[2] + 30));
    expect(errorKey(plan(S().doc, 'duplicate selection offset=0,200', sel(of('car').slice(0, 2))))).toBe('cmd37.err.stampOutside');
  });

  it('set: the same value into a field of every object — the multi-selection Inspector\'s common fields', () => {
    const { S, of } = setup();
    const cars = of('car').slice(0, 3);
    const p = ok(S().doc, 'set selection x=40 heading=90', sel(cars));
    expect(updated(p).map((o) => o.transform.position[0])).toEqual([40, 40, 40]);
    expect(updated(p).every((o) => Math.abs(yawOf(o.transform.rotation) - Math.PI / 2) < 1e-3)).toBe(true);
    // z is left alone; the cars stood on the road and stand on the ground where they land.
    expect(updated(p).map((o) => o.transform.position[2])).toEqual(cars.map((c) => c.transform.position[2]));
    // Height above the ground under each object.
    const lifted = updated(ok(S().doc, 'set selection lift=0.5', sel(cars)));
    lifted.forEach((o, k) => expect(o.transform.position[1] - cars[k].transform.position[1]).toBeCloseTo(0.5, 6));
    // Out of range: a height below the lowest terrain is limited (and said); a position whose footprint would leave
    // the world is refused; modular buildings keep their size under scale.
    const deep = ok(S().doc, 'set selection y=-100', sel(cars.slice(0, 1)));
    expect(updated(deep)[0].transform.position[1]).toBe(-40);
    expect(deep.warnings).toContainEqual({ key: 'cmd37.warn.setClamped', params: { fields: 'y' } });
    expect(errorKey(plan(S().doc, 'set selection x=500', sel(cars.slice(0, 1))))).toBe('cmd37.err.allOutside');
    const scaled = ok(S().doc, 'set selection scale=1.5', sel([cars[0], of('building')[0]]));
    expect(updated(scaled).length).toBe(1);
    expect(keys(scaled.notes)).toContain('cmd37.note.modularScale');
    // The value they already have: nothing to do.
    expect(ok(S().doc, `set selection z=${cars[0].transform.position[2]}`, sel(cars.slice(0, 1))).ops).toEqual([]);
    // Locked objects are skipped and counted.
    S().applyEdit({ update: [{ ...cars[0], locked: true }] });
    const two = ok(S().doc, 'set selection x=41', sel(cars));
    expect(updated(two).length).toBe(2);
    expect(two.notes).toContainEqual({ key: 'cmd37.note.lockedSkipped', params: { count: 1 } });
  });

  it('a rank that ends in a tie: a question for an edit, all of them for a query', () => {
    const { S } = setup();
    const q = plan(S().doc, 'delete type:car:sedan largest');
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.question).toEqual({ key: 'cmd37.ask.tie', params: { count: 7 } });
    expect(q.clarify.options.every((o) => /^delete #car_/.test(o.canonical))).toBe(true);
    expect(ok(S().doc, 'count type:car:sedan largest').table?.ids.length).toBe(7);
    expect(ok(S().doc, 'delete type:building tallest').counts.remove).toBe(1);
  });
});

describe('terrain, roads, forests', () => {
  it('terrain plans a per-vertex program stroke with a feathered edge', () => {
    const doc = createEmptyDocument();
    const p = ok(doc, 'terrain raise circle 0,0 r=10 by=2');
    const stroke = (p.ops[0] as { stroke: { cells: { x: number; z: number; w: number }[]; op: string; by: number } }).stroke;
    expect(p.ops.length).toBe(1);
    expect(stroke).toMatchObject({ op: 'raise', by: 2 });
    // π r² ≈ 314 vertices on the 1 m grid; the centre at full weight, the rim eased, nothing outside.
    expect(stroke.cells.length).toBeGreaterThan(290);
    expect(stroke.cells.length).toBeLessThan(330);
    const cell = (x: number, z: number) => stroke.cells.find((c) => c.x === 100 + x && c.z === 100 + z);
    expect(cell(0, 0)?.w).toBe(1);
    expect(cell(7, 0)?.w).toBe(1); // 3 m inside the edge
    expect(cell(9, 0)!.w).toBeGreaterThan(0);
    expect(cell(9, 0)!.w).toBeLessThan(1);
    expect(cell(11, 0)).toBeUndefined();
    // No height said → 1 m, said; flatten takes the ground at the middle; the area must be on the map.
    expect(ok(doc, 'terrain lower rect -5,-5,5,5').notes).toContainEqual({ key: 'cmd37.note.defaultRaise', params: { by: 1 } });
    expect((ok(doc, 'terrain flatten circle 20,20 r=5').ops[0] as { stroke: { to: number } }).stroke.to).toBe(0);
    expect((ok(doc, 'terrain flatten circle 20,20 r=5 to=3.456').ops[0] as { stroke: { to: number } }).stroke.to).toBe(3.46);
    expect(errorKey(plan(doc, 'terrain raise circle 300,300 r=5'))).toBe('cmd37.err.areaEmpty');
    expect(ok(doc, 'terrain smooth rect -80,-80,80,80').confirm).toEqual({ key: 'cmd37.confirm.area', params: { percent: 64 } });
    expect((ok(doc, 'paint circle 0,0 r=4 ground=asphalt').ops[0] as { stroke: { op: string; ground: number } }).stroke).toMatchObject({ op: 'paint', ground: 3 });
    expect(errorKey(plan(doc, 'paint circle 0,0 r=4 ground=lava'))).toBe('cmd37.err.unknownGround');
  });

  it('a road between two places, with the road tool\'s own rules; presets by name', () => {
    const doc = street().getState().doc;
    const p = ok(doc, 'road 0,0 -> 0,50 preset=avenue');
    const net = (p.ops[0] as { edit: { roads: WorldDocument['roads'] } }).edit.roads;
    // The start is on the street: it is split there (a T junction) — 3 segments now.
    expect(Object.keys(net.segments).length).toBe(3);
    expect(Object.values(net.segments).filter((s) => s.profile.lanes === 4).length).toBe(1);
    expect(p.notes.find((n) => n.key === 'cmd37.note.road')?.params).toMatchObject({ splits: 1, preset: 'avenue' });
    expect(Object.values((ok(doc, 'road node:n1 -> -60,40').ops[0] as { edit: { roads: WorldDocument['roads'] } }).edit.roads.segments).length).toBe(2);
    expect(errorKey(plan(doc, 'road 0,0 -> 0,150'))).toBe('cmd37.err.outside');
    expect(errorKey(plan(doc, 'road 0,0 -> 0,50 preset=motorway'))).toBe('cmd37.err.unknownRoadPreset');
    expect(errorKey(plan(doc, 'road 0,30 -> 0.5,30'))).toBe('cmd37.err.road');
    expect(errorKey(plan(doc, 'road node:n9 -> 0,50'))).toBe('cmd37.err.unknownNode');
  });

  it('a forest: the same command gives the same trees; density by word or number; rejected spots are counted by reason', () => {
    const doc = street().getState().doc;
    const p = ok(doc, 'forest circle 0,0 r=25 density=low');
    const trees = added(p);
    expect(trees.length).toBeGreaterThan(3);
    expect(trees.every((t) => t.type === 'tree' && Math.hypot(t.transform.position[0], t.transform.position[2]) <= 25)).toBe(true);
    expect(added(ok(doc, 'forest circle 0,0 r=25 density=low'))).toEqual(trees);
    expect(added(ok(doc, 'forest circle 0,0 r=25 density=low seed=7'))).not.toEqual(trees);
    expect(added(ok(doc, 'forest circle 0,0 r=25 density=high')).length).toBeGreaterThan(trees.length);
    // The street runs through the circle: no tree on it, and the summary says how many spots that cost.
    expect(trees.every((t) => Math.abs(t.transform.position[2]) > 5.5)).toBe(true);
    expect(keys(p.warnings)).toContain('cmd37.forest.road');
    expect(errorKey(plan(doc, 'forest circle 0,0 r=25 density=jungle'))).toBe('cmd37.err.density');
    expect(errorKey(plan(doc, 'forest rect -3,-3,3,3 density=0.05'))).toBe('cmd37.err.forestEmpty');
  });
});

describe('disasters and run control', () => {
  const instances = (p: Plan) => (p.ops[0] as { instances: PhenomenonInstance[] }).instances;

  it('a placed disaster is the instance a mouse placement makes: defaults, placement policy, id, start', () => {
    const doc = street().getState().doc;
    const p = ok(doc, 'disaster blast at=node:n2 energy=1.8e9 start=5');
    const def = phenomena.implemented('blast')!;
    // What a click at n2 with this template gives (the pure part of placeAt: placement.set → createInstance).
    const template = { ...def.defaults(), energy: 1.8e9 } as EventSpec;
    const expected = createInstance('blast', [], { ...catalogOf('blast')!.placement.set(template, [60, 0], 100), startTime: 5 } as EventSpec);
    expect(instances(p)).toEqual([expected]);
    expect(expected).toMatchObject({ id: 'p1', start: { at: 5 }, spec: { energy: 1.8e9, position: [60, 0] } });
    expect(p.effects).toEqual([]);
    expect(p.immediate).toBe(false);
    expect(keys(p.notes)).toContain('cmd37.note.startEditor');
    // Positions are rounded to 0.1 m like the mouse's.
    expect((instances(ok(doc, 'disaster fire at=1.234,5.678'))[0].spec as { position: number[] }).position).toEqual([1.2, 5.7]);
  });

  it('values out of range are clamped and reported; unknown values and types are refused; the schema has the last word', () => {
    const doc = createEmptyDocument();
    const p = ok(doc, 'disaster blast at=0,0 energy=5e13');
    expect((instances(p)[0].spec as { energy: number }).energy).toBe(1e12);
    expect(p.warnings).toContainEqual({ key: 'cmd37.warn.clamped', params: { field: 'energy', from: 5e13, to: 1e12, min: 1e3, max: 1e12 } });
    expect(errorKey(plan(doc, 'disaster blast at=0,0 megatons=3'))).toBe('cmd37.err.unknownField');
    expect(errorKey(plan(doc, 'disaster blast at=0,0 energy=big'))).toBe('cmd37.err.fieldNumber');
    expect(errorKey(plan(doc, 'disaster meteorstorm at=0,0'))).toBe('cmd37.err.unknownDisaster');
    expect(errorKey(plan(doc, 'disaster blast at=300,0'))).toBe('cmd37.err.outside');
    expect(errorKey(plan(doc, 'disaster blast at=0,0 start=90000'))).toBe('cmd37.err.start');
    // An epicentre may lie outside the map.
    expect(plan(doc, 'disaster earthquake at=300,0 magnitude=7').ok).toBe(true);
    // Every planned instance passes its type's schema.
    for (const text of ['disaster earthquake at=0,0 magnitude=6.5 pga=0.4', 'disaster fire at=0,0 radius=2', 'disaster rain intensity=80', 'disaster wind direction=E speed=40', 'disaster tornado at=5,5']) {
      const inst = instances(ok(doc, text))[0];
      expect(phenomena.implemented(inst.type)!.schema.safeParse(inst.spec).success, text).toBe(true);
    }
  });

  it('no place said: a question — except map-wide kinds, and "now" (the type\'s default place, said)', () => {
    const doc = createEmptyDocument();
    const q = plan(doc, 'disaster blast energy=1e9', { ...emptyContext(), view: [3, 4] });
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.options.map((o) => o.canonical)).toEqual(['disaster blast at=view energy=1e9', 'disaster blast at=center energy=1e9']);
    expect(keys(ok(doc, 'disaster rain intensity=80').notes)).toContain('cmd37.note.mapWide');
    expect(keys(ok(doc, 'disaster wind speed=30 at=5,5').notes)).toContain('cmd37.note.noPosition');
    const now = ok(doc, 'disaster blast now');
    expect(now.effects).toEqual([{ fx: 'runInstances', ids: ['p1'] }]);
    expect(now.immediate).toBe(true);
    expect(keys(now.notes)).toContain('cmd37.note.defaultPosition');
  });

  it('one wind, one map-wide rain, one rising water per edge: a second one is allowed and said to take over', () => {
    const st = scratchWorld(createEmptyDocument());
    st.getState().setExperiment({ instances: instances(ok(st.getState().doc, 'disaster rain intensity=80')) });
    const second = ok(st.getState().doc, 'disaster rain intensity=20');
    expect(instances(second).map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(second.warnings).toContainEqual({ key: 'cmd37.warn.replaces', params: { type: 'rain', ids: 'p1' } });
    // A local rain is its own thing.
    expect(keys(ok(st.getState().doc, 'disaster rain at=10,10').warnings)).not.toContain('cmd37.warn.replaces');
  });

  it('placed disasters: move, delete; stop / pause / resume need a run and a type that supports them', () => {
    const st = scratchWorld(createEmptyDocument());
    const S = () => st.getState();
    for (const text of ['disaster fire at=0,0', 'disaster earthquake at=10,10', 'disaster blast at=20,20']) S().setExperiment({ instances: instances(ok(S().doc, text)) });
    const moved = ok(S().doc, 'disaster p1 move to=30,-30');
    expect((instances(moved)[0].spec as { position: number[] }).position).toEqual([30, -30]);
    expect(instances(ok(S().doc, 'disaster fire delete')).map((x) => x.id)).toEqual(['p2', 'p3']);
    expect(instances(ok(S().doc, 'disaster all delete'))).toEqual([]);
    expect(errorKey(plan(S().doc, 'disaster all move to=0,0'))).toBe('cmd37.err.moveOne');
    // Not running: stop is refused with the list of types that can.
    const stopped = plan(S().doc, 'disaster earthquake stop');
    expect(errorKey(stopped)).toBe('cmd37.err.notRunning');
    // Running: the earthquake can pause and stop; the fire cannot be stopped once started; a pending blast is cancelled.
    const running: CommandContext = {
      ...emptyContext(), simulating: true,
      runtime: { time: 3, summary: {}, instances: [{ key: 'p1', type: 'fire', status: 'active', stop: false, pause: false }, { key: 'p2', type: 'earthquake', status: 'active', stop: true, pause: true }, { key: 'p3', type: 'blast', status: 'pending', stop: false, pause: false }] },
    };
    expect(ok(S().doc, 'disaster earthquake pause', running).effects).toEqual([{ fx: 'control', key: 'p2', op: 'pause' }]);
    expect(ok(S().doc, 'disaster p2 stop', running).effects).toEqual([{ fx: 'control', key: 'p2', op: 'stop' }]);
    expect(errorKey(plan(S().doc, 'disaster fire stop', running))).toBe('cmd37.err.unsupportedControl');
    expect(ok(S().doc, 'disaster p3 stop', running).effects).toEqual([{ fx: 'control', key: 'p3', op: 'cancel' }]);
    const all = ok(S().doc, 'disaster all stop', running);
    expect(all.effects).toEqual([{ fx: 'control', key: 'p2', op: 'stop' }, { fx: 'control', key: 'p3', op: 'cancel' }]);
    expect(keys(all.notes)).toContain('cmd37.note.controlSkipped');
    expect(errorKey(plan(S().doc, 'disaster earthquake resume', running))).toBe('cmd37.err.nothingToControl');
    // Deleting during a run: cancelled / stopped where possible, and said where it stays in the run.
    const del = ok(S().doc, 'disaster all delete', running);
    expect(del.effects).toEqual([{ fx: 'control', key: 'p2', op: 'stop' }, { fx: 'control', key: 'p3', op: 'cancel' }]);
    expect(keys(del.warnings)).toEqual(expect.arrayContaining(['cmd37.warn.staysInRun', 'cmd37.warn.noHistory']));
    expect(errorKey(plan(S().doc, 'disaster p1 move to=1,1', running))).toBe('cmd37.err.instanceRunning');
  });

  it('run control is effects only; editing commands are refused while a simulation runs', () => {
    const doc = town().getState().doc;
    expect(ok(doc, 'run')).toMatchObject({ ops: [], effects: [{ fx: 'sim', op: 'run' }], immediate: true });
    expect(ok(doc, 'run').notes).toEqual([]);
    // With disasters placed, "run" from the editor says that they start with it (disabled ones are not counted);
    // during a run it is a plain resume.
    const st = town();
    for (const line of ['disaster rain', 'disaster blast at=0,30 start=5']) applyOps(st, ok(st.getState().doc, line).ops);
    const placed = st.getState().doc;
    expect(placed.scenario.experiment.instances.length).toBe(2);
    expect(ok(placed, 'run').notes).toEqual([{ key: 'cmd37.note.runWith', params: { count: 2 } }]);
    expect(ok(placed, 'run', { ...emptyContext(), simulating: true }).notes).toEqual([]);
    expect(ok(placed, 'pause').notes).toEqual([]);
    expect(ok(doc, 'speed=2').effects).toEqual([{ fx: 'speed', value: 2 }]);
    expect(errorKey(plan(doc, 'speed=3'))).toBe('cmd37.err.speed');
    expect(ok(doc, 'undo').effects).toEqual([{ fx: 'undo' }]);
    const sim: CommandContext = { ...emptyContext(), simulating: true, runtime: { time: 1, summary: { collapsed: 2 }, instances: [] } };
    for (const text of ['place tree at=0,0', 'move type:car by=1,0,0', 'delete type:tree', 'terrain raise circle 0,0 r=5', 'road 0,30 -> 30,30', 'group type:tree', 'undo']) {
      expect(errorKey(plan(doc, text, sim)), text).toBe('cmd37.err.simulating');
    }
    for (const text of ['count type:building', 'focus type:building tallest', 'pause', 'select type:tree', 'disaster blast at=0,0', 'info sim']) expect(plan(doc, text, sim).ok, text).toBe(true);
    expect(keys(ok(doc, 'disaster blast at=0,0', sim).warnings)).toContain('cmd37.warn.noHistory');
    expect(errorKey(plan(doc, 'info sim'))).toBe('cmd37.err.simNotRunning');
  });
});

describe('queries and the camera', () => {
  const doc = town().getState().doc;

  it('count, list, info, measure: tables of existing values, no operations', () => {
    const count = ok(doc, 'count type:building');
    expect(count).toMatchObject({ ops: [], effects: [], immediate: true });
    expect(count.table?.title).toEqual({ key: 'cmd37.sum.count', params: { count: 9 } });
    expect(count.table?.ids.length).toBe(9);
    expect(count.table?.rows.find((r) => r.cells.kind === 'building:house')?.cells.count).toBe(2);
    const list = ok(doc, 'list type:building where floors>=5');
    expect(list.table?.rows.map((r) => r.cells.floors).sort()).toEqual([12, 5, 9]);
    expect(list.table?.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['kind', 'id', 'x', 'z', 'floors']));
    const info = ok(doc, 'info type:building tallest');
    expect(info.table?.rows[0].cells).toMatchObject({ kind: 'building:apartment', floors: 12, structure: 'rcFrame', lift: 0 });
    const tall = ok(doc, 'measure type:building tallest');
    expect(tall.table?.rows[0].cells.height).toBeGreaterThan(30);
    const dist = ok(doc, 'measure 0,0 30,40');
    expect(dist.table?.rows[0].cells).toMatchObject({ dist: 50, east: 30, south: 40, rise: 0 });
    expect(ok(doc, 'count roads').table?.title).toMatchObject({ key: 'cmd37.sum.countRoads', params: { count: 3, nodes: 4 } });
    expect(ok(doc, 'list roads').table?.rows.length).toBe(3);
    expect(ok(doc, 'count groups').table?.title).toEqual({ key: 'cmd37.sum.countGroups', params: { count: 0 } });
    expect(ok(doc, 'list disasters').table?.rows).toEqual([]);
  });

  it('"show me the tallest building": a camera effect, the selection is not touched', () => {
    const p = ok(doc, 'focus type:building tallest');
    expect(p.ops).toEqual([]);
    expect(p.effects).toMatchObject([{ fx: 'focus' }]);
    expect((p.effects[0] as { ids: string[] }).ids.length).toBe(1);
    expect(ok(doc, 'focus at=node:n1').effects).toEqual([{ fx: 'focusAt', x: -56, z: 0 }]);
  });
});

describe('questions about nothing', () => {
  it('"how many …?" answers 0 and "which …?" an empty list when nothing matches; editing nothing is still refused', () => {
    const doc = town().getState().doc;
    const none = ok(doc, 'count type:barrel');
    expect(none.table!.title).toEqual({ key: 'cmd37.sum.count', params: { count: 0 } });
    expect(none.table!.rows).toEqual([]);
    expect(none.ops).toEqual([]);
    expect(ok(doc, 'count all where hidden').table!.title).toEqual({ key: 'cmd37.sum.count', params: { count: 0 } });
    const list = ok(doc, 'list type:barrel');
    expect(list.table!.title).toEqual({ key: 'cmd37.sum.list', params: { count: 0 } });
    expect(list.table!.rows).toEqual([]);
    // (a count of something that exists is unchanged)
    expect(ok(doc, 'count type:tree').table!.title).toEqual({ key: 'cmd37.sum.count', params: { count: 24 } });
    // Commands that act on the set still stop: nothing to select, delete, measure or describe.
    expect(errorKey(plan(doc, 'select type:barrel'))).toBe('cmd37.err.noMatch');
    expect(errorKey(plan(doc, 'delete type:barrel'))).toBe('cmd37.err.noMatch');
    expect(errorKey(plan(doc, 'measure type:barrel'))).toBe('cmd37.err.noMatch');
    expect(errorKey(plan(doc, 'info type:barrel'))).toBe('cmd37.err.noMatch');
    // "How many are selected?" with no selection says so (there is no set to count).
    expect(errorKey(plan(doc, 'count selection'))).toBe('cmd37.err.noSelection');
  });
});
