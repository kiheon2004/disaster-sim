import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { drawRoad, deleteSegments, moveNode, splitSegment } from './network';
import { measureLink } from './links';
import { defaultProfile, emptyNetwork, type RoadNetwork } from './types';
import { ROAD_MATERIAL_PROPS } from './materials';

const S = () => useWorldStore.getState();
const P = defaultProfile();
const draw = (n: RoadNetwork, pts: [number, number][]) => drawRoad(n, pts, { curved: false, profile: P }).network;
const at = (x: number, z: number) => {
  const t = S().doc.terrain;
  return Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);
};

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('road store integration', () => {
  it('a road edit bakes terrain and is one undo step (redo identical)', () => {
    const before = S().doc.terrain.ground.slice();
    S().applyEdit({ roads: draw(S().doc.roads, [[-40, 0], [40, 0]]) });
    expect(Object.keys(S().doc.roads.segments)).toHaveLength(1);
    expect(S().doc.terrain.ground[at(0, 0)]).toBe(ROAD_MATERIAL_PROPS.asphalt.ground);
    const baked = S().doc.terrain.heights.slice();
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(Object.keys(S().doc.roads.segments)).toHaveLength(0);
    expect(Array.from(S().doc.terrain.ground)).toEqual(Array.from(before));
    S().redo();
    expect(Object.keys(S().doc.roads.segments)).toHaveLength(1);
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(baked));
  });

  it('an invalid network is refused without touching anything', () => {
    S().applyEdit({ roads: draw(emptyNetwork(), [[-40, 0], [40, 0]]) });
    const doc = S().doc;
    const bad: RoadNetwork = { ...doc.roads, segments: { ...doc.roads.segments, s99: { id: 's99', a: 'n1', b: 'nX', control: [], profile: P } } };
    expect(() => S().applyEdit({ roads: bad, add: [{ type: 'tree', transform: { position: [5, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } }] })).toThrow();
    expect(S().doc).toBe(doc);
    expect(S().past).toHaveLength(1);
  });

  it('save / load round-trips roads, underlay, terrain and links exactly', () => {
    let n = draw(S().doc.roads, [[-40, 0], [40, 0]]);
    n = draw(n, [[0, -40], [0, 40]]);
    S().applyEdit({ roads: n });
    const link = measureLink(S().doc.roads, 10, 8, 0, 'follow')!;
    S().applyEdit({ add: [{ type: 'streetLight', transform: { position: [10, 0, 8], rotation: [0, 0, 0], scale: [1, 1, 1] } }] });
    const id = Object.keys(S().doc.objects)[0];
    S().applyEdit({ update: [{ ...S().doc.objects[id], roadLink: link }] });
    const json = serializeDocument(S().doc);
    const res = parseDocument(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.roads).toEqual({ droppedNodes: 0, droppedSegments: 0, underlayLost: false });
    expect(res.doc.roads).toEqual(S().doc.roads);
    expect(Array.from(res.doc.terrain.heights)).toEqual(Array.from(S().doc.terrain.heights));
    expect(res.doc.objects[id].roadLink).toEqual(link);
    expect(serializeDocument(res.doc)).toBe(json);
  });

  it('a damaged file drops invalid segments and re-bakes consistently', () => {
    let n = draw(S().doc.roads, [[-40, 0], [40, 0]]);
    n = draw(n, [[-40, 30], [40, 30]]);
    S().applyEdit({ roads: n });
    const raw = JSON.parse(serializeDocument(S().doc));
    const second = Object.keys(raw.roads.segments)[1];
    raw.roads.segments[second].b = 'n999';
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.roads.droppedSegments).toBe(1);
    expect(Object.keys(res.doc.roads.segments)).toHaveLength(1);
    // The dropped road's ground is natural again (grass), the remaining road is intact.
    const t = res.doc.terrain;
    const i = (x: number, z: number) => Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);
    expect(t.ground[i(0, 30)]).toBe(0);
    expect(t.ground[i(0, 0)]).toBe(ROAD_MATERIAL_PROPS.asphalt.ground);
  });

  it('v5 files load with an empty network and an unchanged terrain', () => {
    const raw = JSON.parse(serializeDocument(S().doc));
    raw.schemaVersion = 5;
    delete raw.roads;
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok && Object.keys(res.doc.roads.segments).length).toBe(0);
  });

  it('linked objects follow / preserve / detach on road edits; nothing is deleted', () => {
    S().applyEdit({ roads: draw(S().doc.roads, [[-40, 0], [40, 0]]) });
    const mk = (x: number, policy: 'follow' | 'preserve' | 'detach') => ({ type: 'streetLight' as const, transform: { position: [x, 0, 6] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } , policy });
    const specs = [mk(-20, 'follow'), mk(0, 'preserve'), mk(20, 'detach')];
    const ids = S().applyEdit({ add: specs });
    S().applyEdit({ update: ids.map((id, k) => {
      const o = S().doc.objects[id];
      return { ...o, roadLink: measureLink(S().doc.roads, o.transform.position[0], o.transform.position[2], 0, specs[k].policy)! };
    }) });
    // Move the east end 20 m south: the road rotates.
    const end = Object.values(S().doc.roads.nodes).find((x) => x.x === 40)!;
    S().applyEdit({ roads: moveNode(S().doc.roads, end.id, 40, 20) });
    const [f, p, d] = ids.map((id) => S().doc.objects[id]);
    expect(f.transform.position[2]).toBeGreaterThan(6.5); // followed the road
    expect(p.transform.position[0]).toBe(0);
    expect(p.transform.position[2]).toBe(6); // stayed in the world
    expect(p.roadLink).toBeDefined();
    expect(d.roadLink).toBeUndefined(); // link dropped, object kept
    expect(d.transform.position[0]).toBe(20);
    // Splitting / deleting keeps every object.
    const seg = Object.keys(S().doc.roads.segments)[0];
    S().applyEdit({ roads: splitSegment(S().doc.roads, seg, 0, 10).network });
    expect(S().doc.objects[ids[0]].roadLink).toBeDefined();
    S().applyEdit({ roads: deleteSegments(S().doc.roads, Object.keys(S().doc.roads.segments)) });
    expect(Object.keys(S().doc.objects)).toHaveLength(3);
    // Undo restores links and positions in one step each.
    S().undo();
    expect(Object.keys(S().doc.roads.segments).length).toBeGreaterThan(0);
  });

  it('sculpting under a road re-bakes it (natural ground updated, road intact)', () => {
    S().applyEdit({ roads: draw(S().doc.roads, [[-40, 0], [40, 0]]) });
    const roadH = S().doc.terrain.heights[at(0, 0)];
    S().beginTerrainStroke();
    for (let k = 0; k < 10; k++) S().terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 10, strength: 1 }, dt: 0.1 });
    S().endTerrainStroke();
    const t = S().doc.terrain;
    // Asphalt is still there, the road was re-graded over the raised natural ground.
    expect(t.ground[at(0, 0)]).toBe(ROAD_MATERIAL_PROPS.asphalt.ground);
    const k = S().doc.roads.underlay.idx.indexOf(at(0, 0));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(S().doc.roads.underlay.h[k]).toBeGreaterThan(0.1);
    expect(t.heights[at(0, 0)]).toBeGreaterThan(roadH);
    S().undo();
    expect(S().doc.terrain.heights[at(0, 0)]).toBe(roadH);
  });

  it('a simulation lock refuses road edits', () => {
    S().setLocked(true);
    S().applyEdit({ roads: draw(S().doc.roads, [[-40, 0], [40, 0]]) });
    expect(Object.keys(S().doc.roads.segments)).toHaveLength(0);
    S().setLocked(false);
  });
});
