import { describe, expect, it } from 'vitest';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { centerlineOf, minRadius, nearest } from './curve';
import {
  assertValid, deleteSegments, degree, drawRoad, mergeAtNode, moveNode, networkWarnings, setProfile, splitSegment, structuralIssues,
} from './network';
import { bakeRegion, dirtyRect, naturalOf, segmentSlopes } from './bake';
import { intersectionsOf } from './intersections';
import { networkPieces } from './mesh';
import { ROAD_MATERIAL_PROPS, SIDEWALK_GROUND } from './materials';
import { defaultProfile, emptyNetwork, type RoadNetwork } from './types';

const P = defaultProfile();
const draw = (n: RoadNetwork, pts: [number, number][], curved = false, profile = P) => drawRoad(n, pts, { curved, profile }).network;
const idx = (t: ReturnType<typeof createFlatTerrain>, x: number, z: number) =>
  Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);

describe('road curves', () => {
  it('straight centerline is exact and uniformly sampled', () => {
    const c = centerlineOf([[0, 0], [10, 0]]);
    expect(c.length).toBeCloseTo(10, 6);
    expect(c.samples.length).toBe(11);
    expect(minRadius(c)).toBe(Infinity);
    const h = nearest(c, 5, 2);
    expect(h.s).toBeCloseTo(5, 6);
    expect(h.dist).toBeCloseTo(2, 6);
    expect(h.side).toBe(1); // +z (south) is right of travel along +x
  });
  it('curves pass through their control points and have finite radius', () => {
    const c = centerlineOf([[0, 0], [10, 10], [20, 0]]);
    expect(nearest(c, 10, 10).dist).toBeLessThan(0.1); // 1 m resampling chord error
    expect(minRadius(c)).toBeLessThan(50);
    for (const s of c.samples) expect(Math.hypot(s.tx, s.tz)).toBeCloseTo(1, 6);
  });
});

describe('road network', () => {
  it('draws a straight road with two nodes and validates', () => {
    const n = draw(emptyNetwork(), [[0, 0], [30, 0]]);
    expect(Object.keys(n.nodes)).toHaveLength(2);
    expect(Object.keys(n.segments)).toHaveLength(1);
    expect(structuralIssues(n)).toEqual([]);
  });
  it('polyline creates one segment per leg sharing nodes', () => {
    const n = draw(emptyNetwork(), [[0, 0], [30, 0], [30, 30]]);
    expect(Object.keys(n.segments)).toHaveLength(2);
    expect(Object.keys(n.nodes)).toHaveLength(3);
  });
  it('a curve is one segment with control points', () => {
    const n = draw(emptyNetwork(), [[0, 0], [15, 10], [30, 0]], true);
    const s = Object.values(n.segments);
    expect(s).toHaveLength(1);
    expect(s[0].control.length).toBe(1);
  });
  it('endpoint snapping reuses nodes (no duplicates)', () => {
    let n = draw(emptyNetwork(), [[0, 0], [30, 0]]);
    n = draw(n, [[31, 1], [30, 30]]); // within SNAP_NODE of (30,0)
    expect(Object.keys(n.nodes)).toHaveLength(3);
    const corner = Object.values(n.nodes).find((x) => x.x === 30 && x.z === 0)!;
    expect(degree(n, corner.id)).toBe(2);
  });
  it('ending on a road makes a T-junction (split)', () => {
    let n = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    const r = drawRoad(n, [[20, 30], [20, 0.5]], { curved: false, profile: P });
    n = r.network;
    expect(r.splits).toHaveLength(1);
    expect(Object.keys(n.segments)).toHaveLength(3);
    const j = Object.values(n.nodes).find((x) => degree(n, x.id) === 3)!;
    expect(j.x).toBeCloseTo(20, 1);
    assertValid(n);
    const ix = intersectionsOf(n).get(j.id)!;
    expect(ix.junction).toBe(true);
    expect(ix.roads).toHaveLength(3);
  });
  it('crossing roads become a 4-way junction', () => {
    let n = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    n = draw(n, [[20, -20], [20, 20]]);
    expect(Object.keys(n.segments)).toHaveLength(4);
    const j = Object.values(n.nodes).filter((x) => degree(n, x.id) === 4);
    expect(j).toHaveLength(1);
    const ix = intersectionsOf(n).get(j[0].id)!;
    expect(ix.warnings).toEqual([]);
    expect(ix.crosswalks).toHaveLength(4);
    for (const t of ix.trim.values()) expect(t).toBeGreaterThan(3.5);
  });
  it('acute junctions are warned about, never "fixed"', () => {
    let n = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    n = draw(n, [[0, 0], [40, 10]]);
    const before = JSON.stringify(n);
    expect(networkWarnings(n).some((w) => w.code === 'acute')).toBe(true);
    intersectionsOf(n);
    expect(JSON.stringify(n)).toBe(before);
  });
  it('split / merge round-trip', () => {
    const n0 = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    const id = Object.keys(n0.segments)[0];
    const { network: n1, node } = splitSegment(n0, id, 20, 0);
    expect(Object.keys(n1.segments)).toHaveLength(2);
    const n2 = mergeAtNode(n1, node)!;
    expect(n2).not.toBeNull();
    expect(Object.keys(n2.segments)).toHaveLength(1);
    const s = Object.values(n2.segments)[0];
    expect(Math.hypot(n2.nodes[s.b].x - n2.nodes[s.a].x, n2.nodes[s.b].z - n2.nodes[s.a].z)).toBeCloseTo(40, 3);
  });
  it('merge refuses different profiles', () => {
    const n0 = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    const { network: n1, node } = splitSegment(n0, Object.keys(n0.segments)[0], 20, 0);
    const n2 = setProfile(n1, [Object.keys(n1.segments)[0]], { material: 'gravel' });
    expect(mergeAtNode(n2, node)).toBeNull();
  });
  it('delete removes orphan nodes only', () => {
    let n = draw(emptyNetwork(), [[0, 0], [30, 0], [30, 30]]);
    const first = Object.values(n.segments).find((s) => n.nodes[s.a].x === 0 || n.nodes[s.b].x === 0)!;
    n = deleteSegments(n, [first.id]);
    expect(Object.keys(n.segments)).toHaveLength(1);
    expect(Object.keys(n.nodes)).toHaveLength(2);
  });
  it('operations are pure (input network unchanged)', () => {
    const n0 = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    const snap = JSON.stringify(n0);
    draw(n0, [[20, -20], [20, 20]]);
    moveNode(n0, Object.keys(n0.nodes)[0], 2, 2);
    setProfile(n0, Object.keys(n0.segments), { width: 10 });
    expect(JSON.stringify(n0)).toBe(snap);
  });
  it('ids are deterministic', () => {
    const a = draw(draw(emptyNetwork(), [[0, 0], [40, 0]]), [[20, -20], [20, 20]]);
    const b = draw(draw(emptyNetwork(), [[0, 0], [40, 0]]), [[20, -20], [20, 20]]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('profile values are sanitized to limits', () => {
    const n0 = draw(emptyNetwork(), [[0, 0], [40, 0]]);
    const n1 = setProfile(n0, Object.keys(n0.segments), { width: 1000, lanes: -3 });
    const p = Object.values(n1.segments)[0].profile;
    expect(p.width).toBeLessThanOrEqual(30);
    expect(p.lanes).toBeGreaterThanOrEqual(1);
  });
});

describe('road bake', () => {
  const setup = (profile = P, slope = 0) => {
    const t = createFlatTerrain(100);
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = Math.round(slope * ix * 100) / 100;
    const before = { h: t.heights.slice(), g: t.ground.slice() };
    const n0 = emptyNetwork();
    const n1 = draw(n0, [[-30, 0], [30, 0]], false, profile);
    const r = bakeRegion(t, n0, n1, fullRect(t));
    const n1b = { ...n1, underlay: r.underlay };
    return { t, before, n0, n1: n1b, r };
  };
  it('paints carriageway and sidewalk ground types', () => {
    const { t } = setup();
    expect(t.ground[idx(t, 0, 0)]).toBe(ROAD_MATERIAL_PROPS.asphalt.ground);
    expect(t.ground[idx(t, 0, 4.5)]).toBe(SIDEWALK_GROUND);
    expect(t.ground[idx(t, 0, 10)]).toBe(0);
  });
  it('raises sidewalks by the curb height', () => {
    const { t } = setup();
    // Sidewalk = gutter (centerline − crown fall) + curb.
    const fall = ROAD_MATERIAL_PROPS.asphalt.crossFall * (P.width / 2);
    expect(t.heights[idx(t, 0, 5)] - t.heights[idx(t, 0, 0)]).toBeCloseTo(P.curbHeight - fall, 2);
  });
  it('graded roads smooth a slope, follow roads keep heights', () => {
    const g = setup({ ...P, elevation: 'graded', sidewalk: 'none' }, 0.1);
    const f = setup({ ...P, elevation: 'follow', sidewalk: 'none' }, 0.1);
    expect(f.t.heights[idx(f.t, 10, 0)]).toBeCloseTo(f.before.h[idx(f.t, 10, 0)], 5);
    // Graded: symmetric crown — both edges equal, the centerline 2 % above them.
    const hl = g.t.heights[idx(g.t, 10, -3)], hr = g.t.heights[idx(g.t, 10, 3)], hc = g.t.heights[idx(g.t, 10, 0)];
    expect(hl).toBeCloseTo(hr, 2);
    expect(hc - hl).toBeCloseTo(0.02 * 3, 2);
    const s = segmentSlopes(g.t, naturalOf(g.t, g.n1), g.n1, Object.values(g.n1.segments)[0]);
    expect(s.crossSlope).toBe(ROAD_MATERIAL_PROPS.asphalt.crossFall);
  });
  it('removing the road restores the original terrain exactly', () => {
    const { t, before, n1 } = setup({ ...P, elevation: 'graded' }, 0.05);
    const n2 = deleteSegments(n1, Object.keys(n1.segments));
    const r = bakeRegion(t, n1, n2, fullRect(t));
    expect(r.underlay.idx).toHaveLength(0);
    expect(Array.from(t.heights)).toEqual(Array.from(before.h));
    expect(Array.from(t.ground)).toEqual(Array.from(before.g));
  });
  it('moving a node re-bakes only the dirty rect and stays consistent with a full bake', () => {
    const { t, n1 } = setup();
    const end = Object.values(n1.nodes).find((x) => x.x === 30)!;
    const n2 = moveNode(n1, end.id, 30, 20);
    const rect = dirtyRect(t, n1, n2)!;
    expect(rect).not.toBeNull();
    bakeRegion(t, n1, n2, rect);
    // Reference: bake from scratch on a clean terrain.
    const ref = createFlatTerrain(100);
    bakeRegion(ref, emptyNetwork(), { ...n2, underlay: emptyNetwork().underlay }, fullRect(ref));
    expect(Array.from(t.ground)).toEqual(Array.from(ref.ground));
    expect(Array.from(t.heights)).toEqual(Array.from(ref.heights));
  });
  it('bake is idempotent', () => {
    const { t, n1 } = setup();
    const h = t.heights.slice();
    const r = bakeRegion(t, n1, n1, fullRect(t));
    expect(r.rect).toBeNull();
    expect(Array.from(t.heights)).toEqual(Array.from(h));
  });
});

describe('road mesh', () => {
  const meshOf = (n: RoadNetwork) => {
    const t = createFlatTerrain(120);
    const r = bakeRegion(t, emptyNetwork(), n, fullRect(t));
    const net = { ...n, underlay: r.underlay };
    return networkPieces({ network: net, terrain: t, sampler: new TerrainSampler(t) });
  };
  const check = (pieces: ReturnType<typeof meshOf>) => {
    let tris = 0;
    for (const p of pieces.values()) {
      for (const m of [p.surface, p.marking, p.walk]) {
        expect(m.pos.length % 9).toBe(0);
        expect(m.nrm.length).toBe(m.pos.length);
        expect(m.uv.length / 2).toBe(m.pos.length / 3);
        for (const v of m.pos) expect(Number.isFinite(v)).toBe(true);
        for (const v of m.uv) expect(Number.isFinite(v)).toBe(true);
        tris += m.triangles;
      }
      // Surfaces face up (no flipped triangles).
      for (let i = 1; i < p.surface.nrm.length; i += 3) expect(p.surface.nrm[i]).toBeGreaterThan(0.2);
    }
    return tris;
  };
  it('straight, curved and junction meshes are valid', () => {
    let n = draw(emptyNetwork(), [[-40, 0], [40, 0]]);
    n = draw(n, [[0, -40], [0, 40]]);
    n = draw(n, [[-40, 30], [-10, 45], [20, 30]], true);
    const pieces = meshOf(n);
    expect(check(pieces)).toBeGreaterThan(100);
    expect([...pieces.keys()].some((k) => k.startsWith('i:'))).toBe(true);
  });
  it('tight curves do not fold over', () => {
    const n = draw(emptyNetwork(), [[-10, 0], [0, 6], [10, 0]], true, { ...P, width: 12 });
    check(meshOf(n));
  });
});
