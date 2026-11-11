/**
 * Phase 36 (terrain editing): brush preview before applying (§22), stroke interpolation, the memory-bounded history and
 * rectangle-only layer snapshots (§23), the ground-follow policy (§24), and consistency of every reader of the terrain
 * after an edit plus partial batch rebuilds (§25).
 */
import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TerrainData, WorldObject } from '@/core/model';
import { createEmptyDocument } from '@/world/WorldDocument';
import { historyEntryBytes, HISTORY_BYTES, pushHistory, scratchWorld, useWorldStore, type HistoryEntry } from '@/world/worldStore';
import { stressScene } from '@/world/stressScene';
import { snapshotDocument, runtimeTerrain } from '@/simulation/SimulationController';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { samplerFor } from '@/terrain/TerrainSampler';
import { composeAll } from '@/landscape/compose';
import { initialWater } from '@/landscape/hydrology';
import { naturalProvider, snapshotLandscape } from '@/landscape/apply';
import type { LakeFeature, RiverFeature } from '@/landscape/types';
import { bakeRegion } from '@/roads/bake';
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import { RoadBatches } from '@/rendering/roads/RoadBatches';
import { SURFACE_LIFT } from '@/roads/mesh';
import { EditorBatches } from '@/rendering/editor/EditorBatches';
import { applyDab, dabPath, paintCore, previewDab, type DabOptions, type TerrainBrushOp } from './TerrainEditor';
import { groundFollowOf, reseat } from './groundPlacement';

const S = () => useWorldStore.getState();
const vi = (t: TerrainData, x: number, z: number) => Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);

/** A rolling test terrain with rough, steep spots (smooth / erode act on it), cm heights like every terrain. */
function hills(): TerrainData {
  const t = createFlatTerrain();
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
    const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
    const rough = ((ix * 7919 + iz * 104729) % 97) / 97;
    t.heights[iz * t.nx + ix] = Math.round((3 * Math.sin(x / 17) + 2 * Math.cos(z / 13) + 1.6 * rough) * 100) / 100;
  }
  return t;
}
const copyOf = (t: TerrainData): TerrainData => ({ ...t, heights: t.heights.slice(), ground: t.ground.slice(), soil: t.soil.slice() });

const river = (id: string): RiverFeature => ({
  id, kind: 'river', points: [[-90, -20], [0, 0], [90, 20]], width: 6, depth: 2, bankSlope: 2, material: 8,
  meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0, inflow: 0, downstream: 'open' },
});
const lake = (id: string): LakeFeature => ({ id, kind: 'lake', points: [[30, 30], [70, 30], [70, 70], [30, 70]], surface: -0.5, depth: 3, shoreWidth: 6, material: 7, filled: true });

function stroke(op: TerrainBrushOp, x: number, z: number, seconds = 0.5, radius = 8) {
  S().beginTerrainStroke();
  for (let k = 0; k < Math.round(seconds / 0.05); k++) S().terrainDab({ op, x, z, brush: { radius, strength: 1 }, dt: 0.05 });
  S().endTerrainStroke();
}

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('§22 brush preview before applying', () => {
  const base = (op: TerrainBrushOp, extra: Partial<DabOptions> = {}): DabOptions => ({ op, x: 10.3, z: -4.6, brush: { radius: 9, strength: 0.7 }, dt: 0.05, targetHeight: 1.2, ...extra });

  it('predicts exactly what holding the brush for 1 s does (real dab code on a scratch copy), document untouched', () => {
    for (const [op, extra] of [
      ['raise', {}], ['lower', { shape: 'square', minHeight: -1 }], ['flatten', { falloff: 'flat' }], ['smooth', {}], ['plateau', {}],
      ['ridge', {}], ['valley', { maxHeight: 2 }], ['noise', { seed: 7 }], ['erode', {}],
    ] as [TerrainBrushOp, Partial<DabOptions>][]) {
      const t = hills();
      const keep = t.heights.slice(), rev = t.revision;
      const p = previewDab(t, base(op, extra))!;
      expect(Array.from(t.heights), `${op}: document unchanged`).toEqual(Array.from(keep));
      expect(t.revision).toBe(rev);
      // Reference: the same 20 frame-sized dabs on a full copy of the terrain.
      const ref = copyOf(t);
      for (let k = 0; k < 20; k++) applyDab(ref, base(op, { ...extra, dt: 0.05 }));
      const w = p.rect.x1 - p.rect.x0 + 1;
      let changed = 0;
      for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
        const i = iz * t.nx + ix, d = ref.heights[i] - t.heights[i];
        const inside = ix >= p.rect.x0 && ix <= p.rect.x1 && iz >= p.rect.z0 && iz <= p.rect.z1;
        if (!inside) { expect(d, `${op}: change outside the preview rect`).toBe(0); continue; }
        expect(p.dh[(iz - p.rect.z0) * w + (ix - p.rect.x0)], `${op} at ${ix},${iz}`).toBe(d);
        if (d !== 0) changed++;
      }
      expect(changed, op).toBeGreaterThan(0);
    }
  });

  it('paint preview marks exactly the core the brush paints (square shape: the max-norm square)', () => {
    const t = hills();
    const o: DabOptions = { op: 'paint', x: 0, z: 0, brush: { radius: 10, strength: 0.5 }, dt: 0.05, groundType: 5, shape: 'square' };
    const p = previewDab(t, o)!;
    const ref = copyOf(t);
    applyDab(ref, o);
    const w = p.rect.x1 - p.rect.x0 + 1, core = paintCore(10, 0.5);
    for (let iz = p.rect.z0; iz <= p.rect.z1; iz++) for (let ix = p.rect.x0; ix <= p.rect.x1; ix++) {
      const x = t.originX + ix, z = t.originZ + iz;
      const painted = p.painted[(iz - p.rect.z0) * w + (ix - p.rect.x0)] === 1;
      expect(painted).toBe(ref.ground[iz * t.nx + ix] === 5);
      expect(painted).toBe(Math.max(Math.abs(x), Math.abs(z)) <= core);
    }
    expect(p.area).toBe((2 * Math.floor(core) + 1) ** 2);
  });

  it('stroke interpolation: dabs every ≤ r/4 along a fast drag, so the raised band has no gap', () => {
    const path = dabPath(0, 0, 30, 0, 8, 1);
    expect(path).toHaveLength(15);
    expect(path[path.length - 1]).toEqual([30, 0]);
    for (let k = 1; k < path.length; k++) expect(path[k][0] - path[k - 1][0]).toBeLessThanOrEqual(2 + 1e-9);
    expect(dabPath(0, 0, 0.1, 0, 8, 1)).toEqual([[0.1, 0]]);
    // One frame jumping 30 m with a 4 m brush: two dabs leave the middle untouched; the path raises all of it.
    const gap = createFlatTerrain(), band = createFlatTerrain();
    const dab = (t: TerrainData, x: number, dt: number) => applyDab(t, { op: 'raise', x, z: 0, brush: { radius: 4, strength: 1 }, dt });
    dab(gap, -15, 0.05); dab(gap, 15, 0.05);
    dab(band, -15, 0.05);
    const pts = dabPath(-15, 0, 15, 0, 4, 1);
    for (const [x] of pts) dab(band, x, 0.05 / pts.length);
    expect(gap.heights[vi(gap, 0, 0)]).toBe(0);
    for (let x = -14; x <= 14; x++) expect(band.heights[vi(band, x, 0)], `x ${x}`).toBeGreaterThan(0);
  });
});

describe('§23 history memory bound', () => {
  const entry = (bytes: number): HistoryEntry => ({
    objects: {}, roads: emptyNetwork(), landscape: { features: [], next: 1, patch: null },
    terrain: { rect: { x0: 0, z0: 0, x1: 0, z1: 0 }, heightsBefore: new Float32Array(bytes / 8), heightsAfter: new Float32Array(bytes / 8), groundBefore: new Uint8Array(0), groundAfter: new Uint8Array(0), soilBefore: new Uint8Array(0), soilAfter: new Uint8Array(0), settingsBefore: createFlatTerrain().settings, settingsAfter: createFlatTerrain().settings },
  });

  it('drops the oldest steps beyond the byte cap (the newest is always kept) and still caps the count', () => {
    let past: HistoryEntry[] = [];
    for (let k = 0; k < 10; k++) past = pushHistory(past, entry(16 * 1024 * 1024));
    expect(past).toHaveLength(4);
    expect(past.reduce((a, e) => a + historyEntryBytes(e), 0)).toBeLessThanOrEqual(HISTORY_BYTES);
    expect(pushHistory([], entry(HISTORY_BYTES * 2))).toHaveLength(1);
    let small: HistoryEntry[] = [];
    for (let k = 0; k < 150; k++) small = pushHistory(small, entry(8));
    expect(small).toHaveLength(100);
  });

  it('a brush commit patches only the stroke rectangle (+ rivers), and undo / redo restore every layer exactly', () => {
    S().setFeatures([river('f1')], 2);
    const land0 = snapshotLandscape(S().doc.landscape);
    const t0 = S().doc.terrain.heights.slice();
    stroke('raise', 0, 4, 0.5);
    const e = S().past[S().past.length - 1];
    // The layer patch covers the river's box (expandForRivers), not the whole map; a full map would be 201 × 201.
    const r = e.landscape.patch!.rect;
    expect((r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1)).toBeLessThan(201 * 201);
    const land1 = snapshotLandscape(S().doc.landscape), t1 = S().doc.terrain.heights.slice();
    S().undo();
    const back = snapshotLandscape(S().doc.landscape);
    for (const k of Object.keys(land0) as (keyof typeof land0)[]) expect(Array.from(back[k]!), `undo ${k}`).toEqual(Array.from(land0[k]!));
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(t0));
    S().redo();
    const again = snapshotLandscape(S().doc.landscape);
    for (const k of Object.keys(land1) as (keyof typeof land1)[]) expect(Array.from(again[k]!), `redo ${k}`).toEqual(Array.from(land1[k]!));
    expect(Array.from(S().doc.terrain.heights)).toEqual(Array.from(t1));
  });
});

describe('§24 ground-follow policy', () => {
  it('grounded objects follow, lifted ones keep their height, preserve buildings keep their transform', () => {
    S().applyEdit({ add: [
      { type: 'tree', transform: { position: [5, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'car', transform: { position: [-5, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'tree', transform: { position: [5, 3, -5], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'building', transform: { position: [60, 0, 60], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ] });
    const [tree, car, lifted, house] = Object.values(S().doc.objects);
    const sampler = samplerFor(S().doc.terrain);
    expect(groundFollowOf(tree, sampler)).toBe('follow');
    expect(groundFollowOf(car, sampler)).toBe('follow');
    expect(groundFollowOf(lifted, sampler)).toBe('keep');
    expect(groundFollowOf(house, sampler)).toBe('follow');
    const preserved = { ...house, building: { options: { foundationPolicy: 'preserve' } } } as unknown as WorldObject;
    expect(groundFollowOf(preserved, sampler)).toBe('preserve');
    stroke('raise', 0, 0, 0.5, 14);
    const after = S().doc.objects, s2 = samplerFor(S().doc.terrain);
    expect(after[tree.id].transform.position[1]).toBeCloseTo(reseat(after[tree.id], s2).position[1], 9);
    expect(after[tree.id].transform.position[1]).toBeGreaterThan(0.5);
    expect(after[car.id].transform.position[1]).toBeGreaterThan(0.5);
    expect(after[lifted.id].transform.position).toEqual(lifted.transform.position);
  });
});

describe('§25 every reader sees the same terrain after an edit', () => {
  it('sampler, picking, layers + road bake, road mesh, hydrology and the runtime copy agree', () => {
    S().setFeatures([lake('f1')], 2);
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-60, 0], [0, 0]], { curved: false, profile: { ...defaultProfile(), elevation: 'follow' } }).network });
    const batches = new RoadBatches();
    batches.sync(S().doc.roads, S().doc.terrain);
    stroke('raise', -30, 8, 1, 10);
    stroke('lower', 50, 50, 0.3, 6);
    const doc = S().doc, t = doc.terrain, s = samplerFor(t);
    // Sampler and picking (placement, editor tools) read the committed heights.
    for (const [x, z] of [[-30, 8], [-30, 4], [50, 50]]) {
      expect(s.sampleHeight(x, z)).toBe(t.heights[vi(t, x, z)]);
      const hit: [number, number, number] = [0, 0, 0];
      expect(s.raycast([x, 200, z], [0, -1, 0], 1000, hit)).toBe(true);
      expect(hit[1]).toBeCloseTo(t.heights[vi(t, x, z)], 3);
    }
    // Final terrain = bake(roads, compose(layers)) from scratch: the layers and the road bake are consistent.
    const fresh = { ...t, heights: t.heights.slice(), ground: t.ground.slice() };
    const land = { ...doc.landscape, natural: { heights: new Float32Array(t.heights.length), ground: new Uint8Array(t.heights.length), culvert: new Uint8Array(t.heights.length), roadBase: new Float32Array(t.heights.length) } };
    composeAll(land, fresh, t.settings.waterLevel ?? 0);
    bakeRegion(fresh, doc.roads, doc.roads, fullRect(fresh), naturalProvider(land));
    expect(Array.from(fresh.heights)).toEqual(Array.from(t.heights));
    expect(Array.from(fresh.ground)).toEqual(Array.from(t.ground));
    // The road mesh follows the edited ground (follow road: sampled 35 % inside the curb at each cross-section).
    batches.sync(doc.roads, t);
    let near = 0;
    batches.root.traverse((o) => {
      const m = o as unknown as { isMesh?: boolean; name: string; geometry: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } };
      if (!m.isMesh || !m.name.startsWith('roads:surface')) return;
      const p = m.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        if (Math.abs(x + 30) > 3 || Math.abs(z) > 0.01) continue;
        expect(p.getY(i)).toBeCloseTo(s.sampleHeight(x, z) + SURFACE_LIFT, 6);
        near++;
      }
    });
    expect(near).toBeGreaterThan(0);
    expect(s.sampleHeight(-30, 0)).toBeGreaterThan(0.3);
    batches.dispose();
    // Hydrology: the lake's initial water is measured from the edited bed.
    const depth = initialWater(doc.landscape, t)!;
    const ix = 50 - t.originX, iz = 50 - t.originZ, v = iz * t.nx + ix;
    const bed = (t.heights[v] + 2 * t.heights[v + 1] + 2 * t.heights[v + t.nx] + t.heights[v + t.nx + 1]) / 6;
    expect(depth[iz * (t.nx - 1) + ix]).toBeCloseTo(-0.5 - bed, 9);
    // The simulation's copy (heightfield collider, water bed) is the same terrain.
    const run = runtimeTerrain(snapshotDocument(doc).terrain);
    expect(Array.from(run.heights)).toEqual(Array.from(t.heights));
  });

  it('a terrain commit rebuilds only the batch chunks with a building over the changed ground (measured, 1000 objects)', () => {
    const st = scratchWorld(createEmptyDocument(''));
    st.getState().applyEdit({ landscape: { base: { heights: hills().heights, ground: new Uint8Array(201 * 201) } } });
    st.getState().applyEdit({ add: stressScene(1000) });
    const doc = st.getState().doc;
    const b = new EditorBatches(samplerFor(doc.terrain));
    b.sync(doc.objects, new Set());
    const fullBuilds = b.stats.rebuilds;
    // Sculpt an empty corner of the map (no object within the brush): commit path + batch update, then the old way.
    const corner = (() => {
      for (const [x, z] of [[-92, -92], [92, -92], [-92, 92], [92, 92]]) if (!Object.values(doc.objects).some((o) => Math.hypot(o.transform.position[0] - x, o.transform.position[2] - z) < 30)) return [x, z];
      return [-92, -92];
    })();
    // (Twice: the second one is the steady state, without first-call compilation.)
    let commitMs = 0, partialMs = 0, partial = 0;
    for (let run = 0; run < 2; run++) {
      const t0 = performance.now();
      st.getState().beginTerrainStroke();
      for (let k = 0; k < 10; k++) st.getState().terrainDab({ op: 'raise', x: corner[0], z: corner[1], brush: { radius: 6, strength: 1 }, dt: 0.05 });
      st.getState().endTerrainStroke();
      commitMs = performance.now() - t0;
      const r0 = b.stats.rebuilds;
      const t1 = performance.now();
      b.setTerrain(samplerFor(st.getState().doc.terrain));
      b.sync(st.getState().doc.objects, new Set());
      partialMs = performance.now() - t1;
      partial = b.stats.rebuilds - r0;
    }
    // (The first commit may snap an object that stood within the 5 cm "grounded" tolerance onto its exact seat.)
    expect(partial).toBe(0);
    const after = st.getState().doc;
    const t2 = performance.now();
    b.invalidateAll();
    b.sync(after.objects, new Set());
    const fullMs = performance.now() - t2;
    // A stroke through the town: only the chunks whose buildings (or re-seated objects) are under it rebuild.
    const r1 = b.stats.rebuilds;
    st.getState().beginTerrainStroke();
    for (let k = 0; k < 10; k++) st.getState().terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 6, strength: 1 }, dt: 0.05 });
    st.getState().endTerrainStroke();
    b.setTerrain(samplerFor(st.getState().doc.terrain));
    b.sync(st.getState().doc.objects, new Set());
    const townChunks = b.stats.rebuilds - r1;
    expect(townChunks).toBeLessThanOrEqual(fullBuilds);
    const t3 = performance.now();
    for (let k = 0; k < 5; k++) snapshotLandscape(after.landscape);
    const fullSnapMs = (performance.now() - t3) / 5;
    if (process.env.P36_MEASURE) writeFileSync(process.env.P36_MEASURE, JSON.stringify({ objects: Object.keys(after.objects).length, chunks: fullBuilds, commitMs, partialMs, partialRebuilds: partial, fullMs, fullRebuilds: fullBuilds, townChunks, fullLayerSnapshotMs: fullSnapMs }, null, 1));
    b.dispose();
  });
});
