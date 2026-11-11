/**
 * Phase 36 (roads 2): near-collinear joints (a turn below the bend-patch threshold, ~9.9°) are mitred in the mesh and
 * the bake. Before, both roads were cut on their own end planes: a wedge gap on the outer side (natural ground in the
 * heightfield, up to ~1 m wide at the outer sidewalk edge for wide2) and two overlapping, z-fighting surfaces inside.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TerrainData } from '@/core/model';
import { createEmptyDocument } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { RoadBatches } from '@/rendering/roads/RoadBatches';
import { bakeRegion } from './bake';
import { transitionsOf } from './crossSection';
import { intersectionsOf, mitresOf } from './intersections';
import { segmentPiece, type MeshData } from './mesh';
import { drawRoad, findNode, moveNode } from './network';
import { defaultProfile, emptyNetwork, PROFILE_PRESETS, type RoadNetwork, type RoadProfile } from './types';

const prof = (k: string, extra: Partial<RoadProfile> = {}): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[k] ?? {}), ...extra });
// 9.5°: just below the bend-patch threshold (cos 9.93° = 0.985); on the 1 m grid the old outer wedge then holds a vertex.
const TURN = (9.5 * Math.PI) / 180;
const FAR: [number, number] = [Math.round(60 * Math.cos(TURN) * 100) / 100, Math.round(60 * Math.sin(TURN) * 100) / 100];

/** Two wide2 roads meeting at (0, 0) with a 9.5° turn (below the bend-patch threshold). */
function kinkNet(p = prof('wide')): RoadNetwork {
  let n = drawRoad(emptyNetwork(), [[-60, 0], [0, 0]], { curved: false, profile: p }).network;
  n = drawRoad(n, [[0, 0], FAR], { curved: false, profile: p }).network;
  return n;
}

function kinkWorld() {
  const st = scratchWorld(createEmptyDocument(''));
  st.getState().applyEdit({ roads: kinkNet() });
  const doc = st.getState().doc;
  const node = findNode(doc.roads, 0, 0, 0.5)!.id;
  const [west, east] = ['a', 'b'].map((e) => Object.values(doc.roads.segments).find((s) => (e === 'a' ? s.b : s.a) === node)!);
  return { st, doc, node, west, east };
}

const vertices = (m: MeshData) => {
  const out: [number, number][] = [];
  for (let i = 0; i < m.pos.length; i += 3) out.push([m.pos[i], m.pos[i + 2]]);
  return out;
};

describe('Phase 36 mitre joins at near-collinear nodes', () => {
  it('a 9.5° joint has no patch and no transition, but a mitre (the bisector of the two roads)', () => {
    const { doc, node } = kinkWorld();
    expect(intersectionsOf(doc.roads).has(node)).toBe(false);
    expect(transitionsOf(doc.roads).size).toBe(0);
    const T = mitresOf(doc.roads).get(node)!;
    expect(Math.atan2(T.tz * Math.sign(T.tx), T.tx * Math.sign(T.tx))).toBeCloseTo(TURN / 2, 3);
    // A joint that continues exactly straight keeps its plain butt ends.
    const straight = drawRoad(drawRoad(emptyNetwork(), [[-60, 0], [0, 0]], { curved: false, profile: prof('wide') }).network, [[0, 0], [60, 0]], { curved: false, profile: prof('wide') }).network;
    expect(mitresOf(straight).size).toBe(0);
  });

  it('mesh: both roads end on the mitre line with the same corner points (no wedge gap, no overlap)', () => {
    const { doc, west, east } = kinkWorld();
    const ctx = { network: doc.roads, terrain: doc.terrain, sampler: samplerFor(doc.terrain) };
    // The bisector from the geometry (west road along +x, east road along FAR), oriented from west into east.
    const a = Math.atan2(FAR[1], FAR[0]) / 2;
    const T = { tx: Math.cos(a), tz: Math.sin(a) };
    const pw = segmentPiece(ctx, west), pe = segmentPiece(ctx, east);
    const along = ([x, z]: [number, number]) => x * T.tx + z * T.tz;
    // No vertex of either road lies on the other road's side of the mitre line (the inner overlap is gone).
    for (const m of [pw.surface, pw.walk]) for (const v of vertices(m)) expect(along(v)).toBeLessThan(1e-9);
    for (const m of [pe.surface, pe.walk]) for (const v of vertices(m)) expect(along(v)).toBeGreaterThan(-1e-9);
    // The end cross-sections coincide: the outer sidewalk corners (7.5 m off the axis) are the same points.
    const onMitre = (m: MeshData) => vertices(m).filter((v) => Math.abs(along(v)) < 1e-9);
    const key = ([x, z]: [number, number]) => `${x.toFixed(6)},${z.toFixed(6)}`;
    const ends = [onMitre(pw.walk), onMitre(pe.walk)].map((vs) => new Set(vs.map(key)));
    expect(ends[0].size).toBeGreaterThanOrEqual(4);
    expect([...ends[0]].sort()).toEqual([...ends[1]].sort());
    const reach = Math.max(...onMitre(pw.walk).map(([x, z]) => Math.hypot(x, z)));
    expect(reach).toBeCloseTo(7.5 / Math.cos(Math.atan2(FAR[1], FAR[0]) / 2), 9);
  });

  it('bake: the outer wedge is road, not natural ground (no hole in the collider), and the surface is smooth', () => {
    const { doc } = kinkWorld();
    const t: TerrainData = doc.terrain;
    let checked = 0;
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
      const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
      if (Math.hypot(x, z) > 7) continue;
      checked++;
      // Within 7 m of the node everything is carriageway (asphalt, 3) or sidewalk (concrete, 4).
      expect(t.ground[iz * t.nx + ix], `(${x}, ${z})`).toBeGreaterThanOrEqual(3);
    }
    expect(checked).toBeGreaterThan(100);
    // The sidewalk band on the outer side (z < 0 side of the bend) stays at its curb height through the joint.
    const H = (x: number, z: number) => t.heights[Math.round(z - t.originZ) * t.nx + Math.round(x - t.originX)];
    for (const x of [-2, -1, 0, 1, 2]) expect(H(x, -6)).toBeGreaterThan(0.04);
    // (1, −7) lay in the old wedge (beyond the west road's end plane, before the east road's): natural grass at 0 m.
    expect(t.ground[Math.round(-7 - t.originZ) * t.nx + Math.round(1 - t.originX)]).toBe(4);
    expect(H(1, -7)).toBeGreaterThan(0.04);
  });

  it('the unchanged road is rebuilt (mesh and bake) when the neighbour turns the joint', () => {
    // Follow roads without sidewalks on flat ground: moving the far node changes no height, so only the batch signature
    // can trigger the rebuild of the unchanged west road.
    const t = createFlatTerrain();
    const p = prof('wide', { elevation: 'follow', sidewalk: 'none' });
    let n = kinkNet(p);
    n = { ...n, underlay: bakeRegion(t, emptyNetwork(), n, fullRect(t)).underlay };
    const far = findNode(n, FAR[0], FAR[1], 0.5)!.id;
    const m = moveNode(n, far, 60, 9.5);
    const b = new RoadBatches();
    const surface = () => b.root.children.find((c) => c.name === 'roads:surface:-1,0') as THREE.Mesh;
    b.sync(n, t);
    const before = surface().geometry;
    b.sync(m, t);
    expect(surface().geometry).not.toBe(before);
    b.dispose();
    // Incremental bake of the edit = full bake of the new network.
    const st = scratchWorld(createEmptyDocument(''));
    st.getState().applyEdit({ roads: kinkNet() });
    const node = findNode(st.getState().doc.roads, FAR[0], FAR[1], 0.5)!.id;
    st.getState().applyEdit({ roads: moveNode(st.getState().doc.roads, node, 60, 9.5) });
    const fresh = scratchWorld(createEmptyDocument(''));
    fresh.getState().applyEdit({ roads: { ...st.getState().doc.roads, underlay: emptyNetwork().underlay } });
    expect(Array.from(st.getState().doc.terrain.heights)).toEqual(Array.from(fresh.getState().doc.terrain.heights));
    expect(Array.from(st.getState().doc.terrain.ground)).toEqual(Array.from(fresh.getState().doc.terrain.ground));
  });
});
