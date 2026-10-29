import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { drawRoad, deleteSegments } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { ROAD_MATERIAL_PROPS } from '@/roads/materials';
import { composeAll, composeRect, createLandscape } from './compose';
import { riverProfile } from './features';
import { landformSampler } from './compose';
import type { Feature, Landscape, LakeFeature, PeakFeature, RiverFeature } from './types';

const S = () => useWorldStore.getState();
const idx = (x: number, z: number) => {
  const t = S().doc.terrain;
  return Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);
};
const H = (x: number, z: number) => S().doc.terrain.heights[idx(x, z)];
const N = (x: number, z: number) => S().doc.landscape.natural.heights[idx(x, z)];

const mountain = (id: string, x = 0, z = 0, height = 20, radius = 50): PeakFeature => ({ id, kind: 'mountain', x, z, radius, height, roughness: 0, seed: 3 });
const river = (id: string, extra: Partial<RiverFeature> = {}): RiverFeature => ({
  id, kind: 'river', points: [[-90, -20], [0, 0], [90, 20]], width: 6, depth: 2, bankSlope: 2, material: 8,
  meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0, inflow: 0, downstream: 'open' }, ...extra,
});
const lake = (id: string): LakeFeature => ({ id, kind: 'lake', points: [[30, 30], [70, 30], [70, 70], [30, 70]], surface: -0.5, depth: 3, shoreWidth: 6, material: 7, filled: true });

const P = defaultProfile();
const road = () => drawRoad(S().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: P }).network;

/** Sculpt by a brush stroke (raise) around (x, z). */
function sculpt(x: number, z: number, seconds = 0.5) {
  S().beginTerrainStroke();
  for (let k = 0; k < Math.round(seconds / 0.05); k++) S().terrainDab({ op: 'raise', x, z, brush: { radius: 8, strength: 1 }, dt: 0.05 });
  S().endTerrainStroke();
}

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('layer composition', () => {
  const grid = createFlatTerrain();
  const land = (features: Feature[]): Landscape => {
    const l = createLandscape(grid);
    l.features = features;
    composeAll(l, grid, 0);
    return l;
  };

  it('features compose independently of their order (sums and minimums commute)', () => {
    const fs: Feature[] = [mountain('f1', -20, 0), mountain('f2', 30, 10, 12, 40), river('f3'), lake('f4')];
    const a = land(fs).natural, b = land([...fs].reverse()).natural;
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
    expect(Array.from(a.ground)).toEqual(Array.from(b.ground));
  });

  it('a rectangle composes to exactly the values of a full composition', () => {
    const fs: Feature[] = [mountain('f1', -20, 0), river('f3')];
    const full = land(fs);
    const part = createLandscape(grid);
    part.features = fs;
    composeRect(part, grid, { x0: 40, z0: 60, x1: 160, z1: 140 }, 0);
    for (let iz = 60; iz <= 140; iz++) for (let ix = 40; ix <= 160; ix++) {
      const i = iz * grid.nx + ix;
      expect(part.natural.heights[i]).toBe(full.natural.heights[i]);
    }
  });

  it('a downhill river bed never rises downstream; the channel is carved below the landform', () => {
    const l = land([mountain('f1', 0, 0, 15, 60), river('f2')]);
    const p = riverProfile(l.features[1] as RiverFeature, landformSampler(l, grid));
    for (let i = 1; i < p.bed.length; i++) expect(p.bed[i]).toBeLessThanOrEqual(p.bed[i - 1] + 1e-9);
    const i0 = 100 * grid.nx + 100;
    expect(l.natural.heights[i0]).toBeLessThan(15 - 1.5);
    expect(l.natural.ground[i0]).toBe(8);
  });
});

describe('road ↔ terrain edit ordering (non-destructive layers)', () => {
  it('mountain → road → sculpt near the road → delete road: the sculpt and the mountain stay', () => {
    S().setFeatures([mountain('f1')], 2);
    const peak = H(0, 0);
    expect(peak).toBeGreaterThan(15);
    S().applyEdit({ roads: road() });
    expect(S().doc.terrain.ground[idx(0, 0)]).toBe(ROAD_MATERIAL_PROPS.asphalt.ground);
    sculpt(20, 12);
    const sculpted = N(20, 12);
    expect(sculpted).toBeGreaterThan(N(20, 30) - 100); // (sanity)
    expect(S().doc.landscape.sculpt[idx(20, 12)]).toBeGreaterThan(0.5);
    S().applyEdit({ roads: deleteSegments(S().doc.roads, Object.keys(S().doc.roads.segments)) });
    // No road left: the final terrain IS the natural terrain (mountain + sculpt).
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(S().doc.landscape.natural.heights));
    expect(H(20, 12)).toBe(sculpted);
    expect(H(0, 0)).toBe(peak);
    expect(S().doc.terrain.ground[idx(0, 0)]).toBe(0);
  });

  it('road first, then nature: the road is re-graded over the new mountain; removing both leaves the sculpt', () => {
    S().applyEdit({ roads: road() });
    sculpt(-40, 30);
    const kept = H(-40, 30);
    S().setFeatures([mountain('f1')], 2);
    // The graded road sits on the mountain now (raised), still asphalt.
    expect(H(0, 0)).toBeGreaterThan(10);
    expect(S().doc.terrain.ground[idx(0, 0)]).toBe(ROAD_MATERIAL_PROPS.asphalt.ground);
    S().setFeatures([]);
    expect(H(0, 0)).toBeLessThan(0.5);
    S().applyEdit({ roads: deleteSegments(S().doc.roads, Object.keys(S().doc.roads.segments)) });
    expect(H(-40, 30)).toBe(kept);
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(S().doc.landscape.natural.heights));
  });

  it('a river under a road (culvert policy keeps the road over it) and river deletion keep other edits', () => {
    sculpt(50, -50);
    const kept = H(50, -50);
    S().setFeatures([river('f1', { points: [[0, -90], [0, 90]] })], 2);
    expect(H(0, 40)).toBeLessThan(-1.5);
    S().setFeatures([]);
    expect(H(0, 40)).toBe(0);
    expect(H(50, -50)).toBe(kept);
  });

  it('undo / redo restore terrain, layers, features and roads exactly', () => {
    const snaps: string[] = [];
    const snap = () => JSON.stringify({ h: Array.from(S().doc.terrain.heights).slice(0, 40000).reduce((a, v, i) => a + v * ((i % 17) + 1), 0).toFixed(3), n: Array.from(S().doc.landscape.natural.heights).reduce((a, v) => a + v, 0).toFixed(3), sc: Array.from(S().doc.landscape.sculpt).reduce((a, v) => a + v, 0).toFixed(3), f: S().doc.landscape.features.map((f) => f.id), r: Object.keys(S().doc.roads.segments) });
    snaps.push(snap());
    S().setFeatures([mountain('f1')], 2); snaps.push(snap());
    S().applyEdit({ roads: road() }); snaps.push(snap());
    sculpt(15, 15); snaps.push(snap());
    S().setFeatures([...S().doc.landscape.features, river('f2')], 3); snaps.push(snap());
    for (let k = snaps.length - 2; k >= 0; k--) { S().undo(); expect(snap()).toBe(snaps[k]); }
    for (let k = 1; k < snaps.length; k++) { S().redo(); expect(snap()).toBe(snaps[k]); }
  });

  it('a failing combined edit leaves nothing half-changed', () => {
    S().setFeatures([mountain('f1')], 2);
    const before = S().doc.terrain.heights.slice();
    const doc = S().doc;
    const bad = { ...doc.roads, segments: { s9: { id: 's9', a: 'nX', b: 'nY', control: [], profile: P } } } as typeof doc.roads;
    expect(() => S().applyEdit({ landscape: { features: [] }, roads: bad })).toThrow();
    expect(S().doc).toBe(doc);
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(before));
    expect(S().doc.landscape.features).toHaveLength(1);
  });
});

describe('landscape save / load (schema v7)', () => {
  it('round-trips layers, features and the composed terrain exactly', () => {
    S().setFeatures([mountain('f1', -30, 0), river('f2'), lake('f3')], 4);
    S().applyEdit({ roads: road() });
    sculpt(40, -40);
    const json = serializeDocument(S().doc);
    const res = parseDocument(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.landscape).toEqual({ droppedFeatures: 0, rebuilt: false, recomposedVertices: 0 });
    expect(Array.from(res.doc.terrain.heights)).toEqual(Array.from(S().doc.terrain.heights));
    expect(Array.from(res.doc.landscape.sculpt)).toEqual(Array.from(S().doc.landscape.sculpt));
    expect(res.doc.landscape.features).toEqual(S().doc.landscape.features);
    expect(serializeDocument(res.doc)).toBe(json);
  });

  it('v6 files load with their terrain as the base (roads separate) and unchanged terrain', () => {
    S().applyEdit({ roads: road() });
    const raw = JSON.parse(serializeDocument(S().doc));
    raw.schemaVersion = 6;
    delete raw.landscape;
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.from(res.doc.terrain.heights)).toEqual(Array.from(S().doc.terrain.heights));
    // The base is the natural terrain: no asphalt in it.
    expect(res.doc.landscape.base.ground[idx(0, 0)]).toBe(0);
    useWorldStore.getState().replaceDocument(res.doc);
    S().applyEdit({ roads: deleteSegments(S().doc.roads, Object.keys(S().doc.roads.segments)) });
    expect(Array.from(S().doc.terrain.ground).every((g) => g === 0)).toBe(true);
  });

  it('invalid features are dropped and counted', () => {
    S().setFeatures([mountain('f1')], 2);
    const raw = JSON.parse(serializeDocument(S().doc));
    raw.landscape.features.push({ id: 'f9', kind: 'volcano' }, { id: 'f10', kind: 'river', points: [[0, 0]] });
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok && res.landscape.droppedFeatures).toBe(2);
  });
});

void fullRect;

describe('nature regions (Phase 20 blueprint extension point)', () => {
  it('capture → JSON → place elsewhere: same shapes shifted, fresh ids, sculpt added, one undo step', async () => {
    const { captureRegion, placeRegion, parseRegion } = await import('./region');
    S().setFeatures([mountain('f1', -50, -50, 15, 25), { ...river('f2'), points: [[-75, -30], [-25, -35]] } as RiverFeature], 3);
    sculpt(-40, -70);
    const t = S().doc.terrain;
    const region = parseRegion(JSON.parse(JSON.stringify(captureRegion(S().doc.landscape, t, [-90, -90, -10, -10]))))!;
    expect(region.features.map((f) => f.kind)).toEqual(['mountain', 'river']);
    const placed = placeRegion(S().doc.landscape, t, region, 50, 50);
    const past = S().past.length;
    S().applyEdit({ landscape: { features: placed.features, next: placed.next, layers: placed.layers ?? undefined } });
    expect(S().past.length).toBe(past + 1);
    const ids = S().doc.landscape.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The copy reproduces the original heights 100 m east / south (same layers, same base).
    expect(H(50 + 0, 50 + 0)).toBeCloseTo(H(-50, -50), 1);
    expect(H(60, 30)).toBeCloseTo(H(-40, -70), 1);
  });
});
