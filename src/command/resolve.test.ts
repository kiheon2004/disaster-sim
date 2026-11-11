/**
 * Phase 37 (§7, §20): reference resolution on the default town (a wide main street west–east with a T junction, a side
 * street going south, nine modular buildings, street trees, a park, parked cars, people).
 */
import { describe, expect, it } from 'vitest';
import type { WorldDocument, WorldObject } from '@/core/model';
import { identityTransform, type Vec3 } from '@/core/types';
import type { PeakFeature } from '@/landscape/types';
import type { PhenomenonInstance } from '@/phenomena/types';
import { createEmptyDocument } from '@/world/WorldDocument';
import { defaultTownObjects, defaultTownRoads } from '@/world/defaultTown';
import { scratchWorld } from '@/world/worldStore';
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import { emptyContext, envOf, orderedObjects, pruneResults, pushResult, type CommandContext } from './context';
import { parsePlace, parseRoad, parseCanonical } from './canonical';
import type { AreaRef, InstanceRef, PlaceRef, RoadRef, TargetRef } from './intent';
import { areaContains, chainsOf, junctions, resolveArea, resolveInstances, resolvePlace, resolveRoad, resolveTarget } from './resolve';

function town() {
  const st = scratchWorld(createEmptyDocument());
  st.getState().applyEdit({ roads: defaultTownRoads(), add: defaultTownObjects() });
  return st;
}

const place = (s: string): PlaceRef => parsePlace(s)!;
const road = (s: string): RoadRef => parseRoad(s)!;
/** The target of `select <text>`. */
const target = (s: string): TargetRef => {
  const r = parseCanonical(`select ${s}`);
  if (!r.ok || r.intent.kind !== 'select') throw new Error(`bad target ${s}`);
  return r.intent.target;
};
const area = (s: string): AreaRef => {
  const r = parseCanonical(`terrain flatten ${s}`);
  if (!r.ok || r.intent.kind !== 'terrain') throw new Error(`bad area ${s}`);
  return r.intent.area;
};
const nodeAt = (doc: WorldDocument, x: number, z: number) => Object.values(doc.roads.nodes).find((n) => n.x === x && n.z === z)!.id;
const ids = (objs: readonly WorldObject[]) => objs.map((o) => o.id);
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });

describe('places', () => {
  const st = town();
  const doc = st.getState().doc;
  const west = nodeAt(doc, -56, 0), east = nodeAt(doc, 56, 0), tee = nodeAt(doc, -23, 0), south = nodeAt(doc, -23, 46);
  const ctx: CommandContext = { ...emptyContext(), cursor: [12, 34], view: [-5, 6] };
  const env = envOf(doc, ctx);

  it('coordinates, the centre, the cursor, the view, nodes, points on segments', () => {
    expect(resolvePlace(place('40,60'), env)).toMatchObject({ ok: true, value: { x: 40, z: 60 } });
    expect(resolvePlace(place('center'), env)).toMatchObject({ ok: true, value: { x: 0, z: 0 } });
    expect(resolvePlace(place('cursor'), env)).toMatchObject({ ok: true, value: { x: 12, z: 34 } });
    expect(resolvePlace(place('view'), env)).toMatchObject({ ok: true, value: { x: -5, z: 6 } });
    expect(resolvePlace(place(`node:${tee}`), env)).toMatchObject({ ok: true, value: { x: -23, z: 0 } });
    expect(resolvePlace(place(`node:${tee.toUpperCase()}`), env)).toMatchObject({ ok: true, value: { x: -23, z: 0 } });
    // The side street runs from the T (z = 0) to z = 46: a quarter of the way is z = 11.5.
    const side = Object.values(doc.roads.segments).find((s) => [s.a, s.b].includes(south))!;
    const quarter = resolvePlace(place(`seg:${side.id}@${side.a === tee ? 0.25 : 0.75}`), env);
    expect(quarter.ok && quarter.value.x).toBeCloseTo(-23, 6);
    expect(quarter.ok && quarter.value.z).toBeCloseTo(11.5, 6);
  });

  it('without a cursor / view the reference is an error, never a guess', () => {
    const bare = envOf(doc, emptyContext());
    expect(resolvePlace(place('cursor'), bare)).toMatchObject({ ok: false, error: { key: 'cmd37.err.noCursor' } });
    expect(resolvePlace(place('view'), bare)).toMatchObject({ ok: false, error: { key: 'cmd37.err.noView' } });
    expect(resolvePlace(place('node:n99'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownNode' } });
    expect(resolvePlace(place('seg:s99'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownSegment' } });
    expect(resolvePlace(place('#nothing_here'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownId' } });
    expect(resolvePlace(place('selection'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.noSelection' } });
    expect(resolvePlace(place('last'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.noLast' } });
  });

  it('"the junction": the one T of the town, with a note saying which node', () => {
    expect(junctions(doc.roads).map((n) => n.id)).toEqual([tee]);
    const r = resolvePlace(place('junction'), env);
    expect(r).toMatchObject({ ok: true, value: { x: -23, z: 0 } });
    expect(r.ok && r.notes).toEqual([{ key: 'cmd37.note.junction', params: { id: tee } }]);
    // No junction: an error; two junctions: a question whose options are the nodes.
    expect(resolvePlace(place('junction'), envOf(createEmptyDocument(), ctx))).toMatchObject({ ok: false, error: { key: 'cmd37.err.noJunction' } });
    void west; void east;
  });

  it('north / south / east / west of an object: clear of its footprint; of a point: a distance', () => {
    const house = orderedObjects(doc).find((o) => o.building?.preset === 'house' && o.transform.position[2] < 0)!;
    const [hx, , hz] = house.transform.position;
    const half = 3.6; // the modular house's footprint is ~7.2 m deep (members, not the 7 m design depth)
    const north = resolvePlace(place(`north(#${house.id})`), env, 1.5);
    expect(north.ok && north.value.x).toBeCloseTo(hx, 6);
    // Its north edge, a 2 m gap (the default, noted), and the 1.5 m half extent of what is placed.
    expect(north.ok && hz - north.value.z).toBeGreaterThan(half + 2 + 1.5 - 0.6);
    expect(north.ok && hz - north.value.z).toBeLessThan(half + 2 + 1.5 + 0.6);
    expect(north.ok && north.notes.map((n) => n.key)).toEqual(['cmd37.note.defaultGap']);
    const gap5 = resolvePlace(place(`north(#${house.id},5)`), env, 1.5);
    expect(gap5.ok && north.ok && north.value.z - gap5.value.z).toBeCloseTo(3, 6);
    expect(gap5.ok && gap5.notes).toEqual([]);
    // "Next to" = its east side (said in a note).
    const next = resolvePlace(place(`next(#${house.id})`), env, 0);
    expect(next.ok && next.value.x).toBeGreaterThan(hx + 3);
    expect(next.ok && next.value.z).toBeCloseTo(hz, 6);
    expect(next.ok && next.notes.map((n) => n.key)).toEqual(['cmd37.note.defaultGap', 'cmd37.note.nextEast']);
    // From a point: 10 m when no distance is said (noted), else the distance; −z is north, +x east.
    expect(resolvePlace(place(`north(node:${tee})`), env)).toMatchObject({ ok: true, value: { x: -23, z: -10 }, notes: [{ key: 'cmd37.note.defaultOffset' }] });
    expect(resolvePlace(place(`east(node:${tee},12)`), env)).toMatchObject({ ok: true, value: { x: -11, z: 0 }, notes: [] });
    expect(resolvePlace(place('south(west(0,0,5),3)'), env)).toMatchObject({ ok: true, value: { x: -5, z: 3 } });
    // An id may be given by a unique prefix.
    expect(resolvePlace(place(`#${house.id.slice(0, house.id.length - 2)}`), env).ok).toBe(true);
  });

  it('the selection / the last result as a place = their pivot', () => {
    const trees = orderedObjects(doc).filter((o) => o.type === 'tree').slice(0, 2);
    const env2 = envOf(doc, { ...ctx, selection: ids(trees), results: [[trees[0].id]] });
    const sel = resolvePlace(place('selection'), env2);
    expect(sel.ok && sel.value.x).toBeCloseTo((trees[0].transform.position[0] + trees[1].transform.position[0]) / 2, 6);
    expect(resolvePlace(place('last'), env2)).toMatchObject({ ok: true, value: { x: trees[0].transform.position[0], z: trees[0].transform.position[2] } });
  });
});

describe('roads', () => {
  const st = town();
  const doc = st.getState().doc;
  const west = nodeAt(doc, -56, 0), east = nodeAt(doc, 56, 0), tee = nodeAt(doc, -23, 0), south = nodeAt(doc, -23, 46);
  const env = envOf(doc, emptyContext());

  it('the main road = the widest road, through its T junction, from its west end', () => {
    const r = resolveRoad(road('road:main'), env);
    expect(r.ok && [r.value.from, r.value.to]).toEqual([west, east]);
    expect(r.ok && r.value.parts.length).toBe(2);
    // Travel order: each part starts where the previous one ended.
    if (r.ok) {
      let node = r.value.from;
      for (const p of r.value.parts) {
        expect(p.reversed ? p.seg.b : p.seg.a).toBe(node);
        node = p.reversed ? p.seg.a : p.seg.b;
      }
      expect(node).toBe(east);
      expect(r.value.parts.every((p) => p.seg.profile.width === 10)).toBe(true);
    }
  });

  it('"the road" with two roads on the map is a question; each option names a road exactly', () => {
    const r = resolveRoad(road('road:any'), env);
    expect(r.ok).toBe(false);
    if (r.ok || !('clarify' in r)) throw new Error('expected a question');
    expect(r.clarify.options.length).toBe(2);
    const runs = r.clarify.options.map((o) => resolveRoad(o.value as RoadRef, env));
    expect(runs.map((x) => x.ok && x.value.parts.length).sort()).toEqual([1, 2]);
    // Chains: the main street is ONE run through its T junction; the side street ends at the T.
    const runs2 = chainsOf(doc.roads, Object.keys(doc.roads.segments));
    expect(runs2.map((x) => [x.from, x.to])).toEqual(expect.arrayContaining([[west, east], [tee, south]]));
    expect(runs2.length).toBe(2);
    // A map with one road has no question; four equal arms of a crossing pair up straight across.
    const one = scratchWorld(createEmptyDocument());
    one.getState().applyEdit({ roads: drawRoad(emptyNetwork(), [[-40, 0], [40, 0]], { curved: false, profile: defaultProfile() }).network });
    expect(resolveRoad(road('road:any'), envOf(one.getState().doc, emptyContext())).ok).toBe(true);
    const cross = drawRoad(one.getState().doc.roads, [[0, -40], [0, 40]], { curved: false, profile: defaultProfile() }).network;
    const arms = chainsOf(cross, Object.keys(cross.segments));
    expect(arms.length).toBe(2);
    expect(arms.map((x) => x.parts.length)).toEqual([2, 2]);
    // West → east and north → south, whatever order they were drawn in.
    for (const x of arms) expect(cross.nodes[x.from].x < cross.nodes[x.to].x || cross.nodes[x.from].z < cross.nodes[x.to].z).toBe(true);
  });

  it('between two nodes (the path with the fewest segments), one segment, the nearest road', () => {
    const through = resolveRoad(road(`road:${west}-${east}`), env);
    expect(through.ok && through.value.parts.length).toBe(2);
    const back = resolveRoad(road(`road:${east}-${west}`), env);
    expect(back.ok && [back.value.from, back.value.to]).toEqual([east, west]);
    expect(back.ok && back.value.parts.every((p, i) => through.ok && p.seg.id === through.value.parts[1 - i].seg.id && p.reversed !== through.value.parts[1 - i].reversed)).toBe(true);
    const corner = resolveRoad(road(`road:${west}-${south}`), env);
    expect(corner.ok && corner.value.parts.map((p) => (p.reversed ? p.seg.a : p.seg.b))).toEqual([tee, south]);
    const near = resolveRoad({ r: 'nearest', at: { p: 'xz', x: -20, z: 30 } }, env);
    expect(near.ok && [near.value.from, near.value.to].sort()).toEqual([tee, south].sort());
    expect(near.ok && near.notes[0].key).toBe('cmd37.note.nearestRoad');
    expect(resolveRoad(road('seg:s99'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownSegment' } });
    expect(resolveRoad(road(`road:${west}-n99`), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownNode' } });
    expect(resolveRoad(road('road:main'), envOf(createEmptyDocument(), emptyContext()))).toMatchObject({ ok: false, error: { key: 'cmd37.err.noRoads' } });
  });
});

describe('targets', () => {
  const st = town();
  const S = () => st.getState();
  const all = () => orderedObjects(S().doc);
  const count = (type: string) => all().filter((o) => o.type === type).length;
  const run = (s: string, ctx: CommandContext = emptyContext()) => resolveTarget(target(s), envOf(S().doc, ctx));
  const n = (s: string, ctx?: CommandContext) => {
    const r = run(s, ctx);
    return r.ok ? r.value.objects.length : -1;
  };

  it('kinds and presets', () => {
    expect(n('type:building')).toBe(9);
    expect(n('type:building:house')).toBe(2);
    expect(n('type:building:warehouse')).toBe(1);
    expect(n('type:tree')).toBe(count('tree'));
    expect(n('type:tree:conifer') + n('type:tree:broadleaf')).toBe(count('tree'));
    expect(n('type:car:truck')).toBe(1);
    expect(n('type:car')).toBe(9);
    expect(n('type:Car:SUV')).toBe(1);
    expect(n('all')).toBe(all().length);
    expect(run('type:spaceship')).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownType' } });
    expect(run('type:car:limo')).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownPreset' } });
    expect(run('type:crate')).toMatchObject({ ok: false, error: { key: 'cmd37.err.noMatch' } });
    // Presets that differ only in size cannot be told apart: the whole type, and the note says so.
    const signs = run('type:sign:billboard');
    expect(signs.ok && signs.value.objects.length).toBe(count('sign'));
    expect(signs.ok && signs.notes.map((x) => x.key)).toEqual(['cmd37.note.presetInexact']);
  });

  it('filters: floors, height, slope, near, on a road', () => {
    expect(n('type:building where floors>=5')).toBe(3); // office 9, RC 5, apartment 12
    expect(n('type:building where floors=2')).toBe(3); // two houses and the two-storey RC building
    expect(n('type:building where floors>=5 and floors<10')).toBe(2);
    expect(n('all where floors>=1')).toBe(9); // only buildings have floors
    expect(n('type:building where height>30')).toBe(2);
    expect(run('type:tree where slope>20')).toMatchObject({ ok: false, error: { key: 'cmd37.err.noMatch' } }); // flat town
    expect(n('type:tree where slope>=0')).toBe(count('tree'));
    // The park's nine trees are within 12 m of (33, 23); nothing else of the kind is.
    expect(n('type:tree where near 33,23 r=12')).toBe(9);
    // Parked cars stand on the shoulders of the main street; people on the sidewalks do not.
    expect(n('type:car where on road')).toBe(9);
    expect(run('type:human where on road')).toMatchObject({ ok: false });
    const side = Object.values(S().doc.roads.segments).find((s) => s.profile.width === 7)!;
    expect(run(`type:car where on road seg:${side.id}`)).toMatchObject({ ok: false, error: { key: 'cmd37.err.noMatch' } });
  });

  it('ranks, limits and ties', () => {
    const tallest = run('type:building tallest');
    expect(tallest.ok && tallest.value.objects.length).toBe(1);
    expect(tallest.ok && tallest.value.objects[0].building?.preset).toBe('apartment');
    expect(tallest.ok && tallest.value.tie).toBeNull();
    const largest = run('type:building largest');
    expect(largest.ok && largest.value.objects[0].building?.preset).toBe('apartment'); // 14 × 14 m
    const nearest = run('type:building nearest -8,32');
    expect(nearest.ok && nearest.value.objects[0].building?.preset).toBe('warehouse');
    expect(n('type:building first 3')).toBe(3);
    expect(run('type:building first 3').ok && ids((run('type:building first 3') as { value: { objects: WorldObject[] } }).value.objects)).toEqual(ids(all().filter((o) => o.type === 'building').slice(0, 3)));
    const two = run('type:building tallest first 2');
    expect(two.ok && two.value.objects.map((o) => o.building?.spec.floors)).toEqual([12, 9]);
    // Seven sedans of the same size: a tie — the caller decides (all of them, or a question).
    const sedans = run('type:car:sedan largest');
    expect(sedans.ok && sedans.value.objects.length).toBe(7);
    expect(sedans.ok && sedans.value.tie?.length).toBe(7);
    // With a limit, ties are broken in command order (type, running number, id).
    const one = run('type:car:sedan largest first 1');
    expect(one.ok && one.value.objects[0].serial).toBe(Math.min(...all().filter((o) => o.type === 'car').map((o) => o.serial)));
  });

  it('the selection, the last result, "it"', () => {
    const trees = all().filter((o) => o.type === 'tree').slice(0, 3);
    const cars = all().filter((o) => o.type === 'car').slice(0, 2);
    expect(run('selection')).toMatchObject({ ok: false, error: { key: 'cmd37.err.noSelection' } });
    expect(run('last')).toMatchObject({ ok: false, error: { key: 'cmd37.err.noLast' } });
    expect(run('it')).toMatchObject({ ok: false, error: { key: 'cmd37.err.noIt' } });
    const sel = { ...emptyContext(), selection: ids(trees), results: [ids(cars)] };
    expect(n('selection', sel)).toBe(3);
    expect(n('last', sel)).toBe(2);
    const it1 = run('it', sel);
    expect(it1.ok && ids(it1.value.objects)).toEqual(ids(trees));
    expect(it1.ok && it1.notes[0].key).toBe('cmd37.note.itSelection');
    const it2 = run('it', { ...sel, selection: [] });
    expect(it2.ok && ids(it2.value.objects)).toEqual(ids(cars));
    expect(it2.ok && it2.notes[0].key).toBe('cmd37.note.itLast');
    // Filters apply to them like to anything else; ids that no longer exist are dropped.
    expect(n('selection where near 0,0 r=500', { ...sel, selection: [...ids(trees), 'gone_1'] })).toBe(3);
    expect(pruneResults(pushResult(sel, ['gone_1']), S().doc.objects).results).toEqual([ids(cars)]);
    expect(pushResult(emptyContext(), []).results).toEqual([]);
    let deep = emptyContext();
    for (let k = 0; k < 14; k++) deep = pushResult(deep, [trees[0].id]);
    expect(deep.results.length).toBe(10);
  });

  it('groups by name (same-named groups → a question by group id), objects by name, flags', () => {
    const b = all().filter((o) => o.type === 'building');
    S().applyEdit({ update: [...b.slice(0, 3).map((o) => ({ ...o, group: 'g_a' })), ...b.slice(3, 5).map((o) => ({ ...o, group: 'g_b' })), ...b.slice(5, 7).map((o) => ({ ...o, group: 'g_c' })), { ...b[7], name: 'Depot', locked: true }, { ...b[8], name: 'North block', hidden: true }] });
    S().setGroupName('g_a', '북쪽 블록');
    S().setGroupName('g_b', 'North block');
    S().setGroupName('g_c', 'North block');
    S().setGroupName('g_empty', 'Ghost'); // a name without members
    expect(n('group:"북쪽 블록"')).toBe(3);
    expect(n('group:"북쪽"')).toBe(3); // part of the name
    expect(run('group:"Ghost"')).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownGroup' } });
    const q = run('group:"North block"');
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.options.map((o) => o.value)).toEqual([{ b: 'groupId', id: 'g_b' }, { b: 'groupId', id: 'g_c' }]);
    expect(n('group:g_c')).toBe(2);
    // name: objects first, then groups; an object and groups of that name → a question over all of them.
    expect(n('name:"Depot"')).toBe(1);
    expect(n('name:"depot"')).toBe(1);
    const q2 = run('name:"North block"');
    if (q2.ok || !('clarify' in q2)) throw new Error('expected a question');
    expect(q2.clarify.options.length).toBe(3);
    expect(n('name:"북쪽 블록"')).toBe(3);
    expect(run('name:"Nobody"')).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownName' } });
    // Hidden / locked objects are part of every set (what an edit does with them is the planner's rule).
    expect(n('type:building')).toBe(9);
    expect(n('all where hidden')).toBe(1);
    expect(n('type:building where locked')).toBe(1);
    expect(n('type:building where visible and unlocked')).toBe(7);
    const hidden = run('type:building where hidden');
    expect(hidden.ok && hidden.value.explicit).toBe(true);
    expect((run('type:building') as { value: { explicit: boolean } }).value.explicit).toBe(false);
  });

  it('structural warnings: any warning, or by code', () => {
    // Every modular building of the town analyses without brace warnings.
    expect(run('type:building where warning=brace')).toMatchObject({ ok: false, error: { key: 'cmd37.err.noMatch' } });
    const any = run('type:building where warning');
    expect(any.ok ? any.value.objects.every((o) => !!o.building) : true).toBe(true);
  });

  it('the order of a set does not depend on the order objects were added in', () => {
    const a = scratchWorld(createEmptyDocument()), b = scratchWorld(createEmptyDocument());
    const inputs = [{ type: 'tree' as const, transform: at(1, 1), seed: 1 }, { type: 'car' as const, transform: at(2, 2), seed: 2 }, { type: 'tree' as const, transform: at(3, 3), seed: 3 }, { type: 'wall' as const, transform: at(4, 4), seed: 4 }];
    a.getState().applyEdit({ add: inputs });
    // The same objects put into the map in another order (as a load from a file may).
    const objs = Object.values(a.getState().doc.objects);
    b.getState().replaceDocument({ ...createEmptyDocument(), objects: Object.fromEntries([...objs].reverse().map((o) => [o.id, o])) });
    const order = (doc: WorldDocument) => orderedObjects(doc).map((o) => `${o.type}${o.serial}`);
    expect(order(b.getState().doc)).toEqual(order(a.getState().doc));
    expect(order(a.getState().doc)).toEqual(['car1', 'tree1', 'tree2', 'wall1']);
  });
});

describe('areas and placed disasters', () => {
  const st = town();
  const S = () => st.getState();
  const hill = (id: string, x: number, z: number): PeakFeature => ({ id, kind: 'hill', x, z, radius: 12, height: 4, roughness: 0, seed: 1 });

  it('rectangles (corners in any order), circles, around objects, terrain features', () => {
    const env = envOf(S().doc, { ...emptyContext(), cursor: [10, 10] });
    const rect = resolveArea(area('rect 20,30,-5,10'), env);
    expect(rect.ok && rect.value.box).toEqual([-5, 10, 20, 30]);
    expect(rect.ok && areaContains(rect.value, 0, 20)).toBe(true);
    expect(rect.ok && areaContains(rect.value, 0, 31)).toBe(false);
    const circle = resolveArea(area('circle cursor r=10'), env);
    expect(circle.ok && areaContains(circle.value, 17, 17)).toBe(true);
    expect(circle.ok && areaContains(circle.value, 18, 18)).toBe(false);
    const around = resolveArea(area('around type:building:warehouse r=4'), env);
    expect(around.ok && areaContains(around.value, -8, 32)).toBe(true);
    expect(around.ok && around.value.shapes.length).toBe(1);
    expect(resolveArea(area('feature:hill'), env)).toMatchObject({ ok: false, error: { key: 'cmd37.err.noFeatureKind' } });
    S().setFeatures([hill('f1', 60, 60)], 2);
    const one = resolveArea(area('feature:hill'), envOf(S().doc, emptyContext()));
    expect(one.ok && one.value.shapes[0]).toMatchObject({ k: 'circle', x: 60, z: 60, r: 12 });
    expect(resolvePlace({ p: 'feature', id: 'f1' }, envOf(S().doc, emptyContext()))).toMatchObject({ ok: true, value: { x: 60, z: 60 } });
    S().setFeatures([hill('f1', 60, 60), hill('f2', -60, 60)], 3);
    const two = resolveArea(area('feature:hill'), envOf(S().doc, emptyContext()));
    if (two.ok || !('clarify' in two)) throw new Error('expected a question');
    expect(two.clarify.options.map((o) => o.value)).toEqual([{ a: 'feature', id: 'f1' }, { a: 'feature', id: 'f2' }]);
    expect(resolveArea(area('feature:f2'), envOf(S().doc, emptyContext())).ok).toBe(true);
    expect(resolveArea(area('feature:f9'), envOf(S().doc, emptyContext()))).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownFeature' } });
  });

  it('placed disasters: by id, by type, "#n" = the id or the n-th of the type', () => {
    const inst = (id: string, type: string): PhenomenonInstance => ({ id, type, spec: { event: type } as never, enabled: true, start: { at: 0 }, visualize: true });
    const run = (ref: InstanceRef) => resolveInstances(ref, envOf(S().doc, emptyContext()));
    expect(run({ i: 'all' })).toMatchObject({ ok: false, error: { key: 'cmd37.err.noInstances' } });
    S().setExperiment({ instances: [inst('p1', 'fire'), inst('p2', 'earthquake'), inst('p3', 'fire'), inst('p5', 'fire')] });
    expect(run({ i: 'all' }).ok && (run({ i: 'all' }) as { value: PhenomenonInstance[] }).value.length).toBe(4);
    expect(run({ i: 'id', id: 'P2' })).toMatchObject({ ok: true, value: [{ id: 'p2' }] });
    expect(run({ i: 'id', id: 'p9' })).toMatchObject({ ok: false, error: { key: 'cmd37.err.unknownInstance' } });
    expect(run({ i: 'type', type: 'earthquake' })).toMatchObject({ ok: true, value: [{ id: 'p2' }] });
    expect(run({ i: 'type', type: 'blast' })).toMatchObject({ ok: false, error: { key: 'cmd37.err.noInstanceOfType' } });
    // Three fires and no number: a question.
    const q = run({ i: 'type', type: 'fire' });
    if (q.ok || !('clarify' in q)) throw new Error('expected a question');
    expect(q.clarify.options.map((o) => o.value)).toEqual([{ i: 'id', id: 'p1' }, { i: 'id', id: 'p3' }, { i: 'id', id: 'p5' }]);
    // fire#1: p1 is the first fire — no doubt. fire#3: p3 is a fire but the THIRD fire is p5 — ask.
    expect(run({ i: 'type', type: 'fire', nth: 1 })).toMatchObject({ ok: true, value: [{ id: 'p1' }] });
    const q3 = run({ i: 'type', type: 'fire', nth: 3 });
    if (q3.ok || !('clarify' in q3)) throw new Error('expected a question');
    expect(q3.clarify.options.map((o) => o.value)).toEqual([{ i: 'id', id: 'p3' }, { i: 'id', id: 'p5' }]);
    // fire#2: p2 is an earthquake, the second fire is p3. fire#5: only the id p5. fire#7: nothing.
    expect(run({ i: 'type', type: 'fire', nth: 2 })).toMatchObject({ ok: true, value: [{ id: 'p3' }] });
    expect(run({ i: 'type', type: 'fire', nth: 5 })).toMatchObject({ ok: true, value: [{ id: 'p5' }] });
    expect(run({ i: 'type', type: 'fire', nth: 7 })).toMatchObject({ ok: false, error: { key: 'cmd37.err.noInstanceNth' } });
  });
});
