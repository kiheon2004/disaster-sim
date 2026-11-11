/**
 * Phase 36 (§18): forest brush site conditions — surface and soil exclusions, clearance from water (lakes, rivers, sea)
 * and from roads as parameters — and reproducible strokes (seeds from the stroke's start point, not a session counter;
 * the settings persist like the build settings).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { useNatureStore, DEFAULT_FOREST, NATURE_PERSIST, type ForestSettings } from '@/editor/natureStore';
import { beginForestStroke, forestDab, forestStrokeKey, planForest } from '@/app/natureActions';
import { samplerFor } from '@/terrain/TerrainSampler';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { footprintOnRoad } from '@/roads/city';
import { footprintOf } from '@/editor/build/footprint';
import type { WorldObject } from '@/core/model';
import type { LakeFeature, PeakFeature, RiverFeature } from './types';
import { polygonDistance } from './features';
import { waterFeatureAvoid } from './hydrology';

const S = () => useWorldStore.getState();
const grid = (step = 4, half = 92): [number, number][] => {
  const out: [number, number][] = [];
  for (let x = -half; x <= half; x += step) for (let z = -half; z <= half; z += step) out.push([x + 0.37, z - 0.21]);
  return out;
};
const base: ForestSettings = { coniferShare: 0.5, density: 1, spacing: 2, radius: 10, seed: 4, slopeLimit: 35, minElevation: -20, maxElevation: 80, variation: false };
const lake: LakeFeature = { id: 'f1', kind: 'lake', points: [[30, 30], [70, 30], [70, 70], [30, 70]], surface: -0.5, depth: 3, shoreWidth: 6, material: 7, filled: true };
const river: RiverFeature = {
  id: 'f2', kind: 'river', points: [[-90, -40], [90, -40]], width: 6, depth: 1.5, bankSlope: 2, material: 8,
  meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0.5, inflow: 0, downstream: 'open' },
};
const pos = (r: ReturnType<typeof planForest>) => r.inputs.map((i) => i.transform.position);

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('Phase 36 forest site conditions', () => {
  it('surface and soil exclusions: no tree on excluded ground; without them the same spots are planted', () => {
    const t = S().doc.terrain;
    // West half rock (ground 6), north-east quarter reclaimed soil (soil 3).
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
      if (ix < 100) t.ground[iz * t.nx + ix] = 6;
      if (ix > 100 && iz < 100) t.soil[iz * t.nx + ix] = 3;
    }
    t.revision++;
    const free = planForest(grid(), base);
    const excl = planForest(grid(), { ...base, excludeGround: [6], excludeSoil: [3] });
    expect(pos(free).some(([x]) => x < -1)).toBe(true);
    expect(pos(free).some(([x, , z]) => x > 1 && z < -1)).toBe(true);
    const s = samplerFor(S().doc.terrain);
    for (const [x, , z] of pos(excl)) {
      expect(s.sampleGroundType(x, z)).not.toBe(6);
      expect(s.sampleSoilType(x, z)).not.toBe(3);
    }
    expect(excl.reasons.ground).toBeGreaterThan(0);
    expect(excl.reasons.soil).toBeGreaterThan(0);
  });

  it('water clearance: no tree within the distance of a lake, a river or the sea', () => {
    S().setFeatures([lake, river], 3);
    S().setWaterLevel(-1.5);
    const near = planForest(grid(), base);
    const clear = planForest(grid(), { ...base, waterClearance: 6 });
    const avoid = waterFeatureAvoid([lake, river]);
    const s = samplerFor(S().doc.terrain);
    expect(near.inputs.some((i) => avoid(i.transform.position[0], i.transform.position[2], 5))).toBe(true);
    for (const [x, , z] of pos(clear)) {
      expect(avoid(x, z, 5.9), `(${x}, ${z}) near lake / river`).toBe(false);
      expect(polygonDistance(lake.points, x, z).inside).toBe(false);
      expect(s.sampleHeight(x, z)).toBeGreaterThanOrEqual(-1.55);
    }
    expect(clear.inputs.length).toBeLessThan(near.inputs.length);
    expect(clear.reasons.water).toBeGreaterThan(near.reasons.water);
  });

  it('road clearance is a parameter (was a fixed 0.2 m)', () => {
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-90, 0], [90, 0]], { curved: false, profile: defaultProfile() }).network });
    const roads = S().doc.roads;
    const close = planForest(grid(1.5), base);
    const wide = planForest(grid(1.5), { ...base, roadMargin: 4 });
    const fp = (p: [number, number, number]) => footprintOf({ type: 'tree', params: { species: 'broadleaf', height: 8, canopyRadius: 3, trunkRadius: 0.28 }, transform: { position: p, rotation: [0, 0, 0], scale: [1, 1, 1] } } as unknown as WorldObject)!;
    expect(close.inputs.some((i) => footprintOnRoad(roads, fp(i.transform.position as [number, number, number]), 3.9))).toBe(true);
    for (const i of wide.inputs) expect(footprintOnRoad(roads, footprintOf({ type: 'tree', params: i.params, transform: i.transform } as WorldObject)!, 3.9)).toBe(false);
  });

  it('with the default settings no tree stands in water, on a road, on rock or on too steep ground', () => {
    S().setFeatures([lake, { id: 'f3', kind: 'mountain', x: -50, z: 50, radius: 25, height: 30, roughness: 0, seed: 1 } as PeakFeature], 4);
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-90, -20], [90, -20]], { curved: false, profile: defaultProfile() }).network });
    const t = S().doc.terrain;
    for (let iz = 150; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.ground[iz * t.nx + ix] = 6;
    t.revision++;
    const r = planForest(grid(3), DEFAULT_FOREST);
    const s = samplerFor(S().doc.terrain);
    expect(r.inputs.length).toBeGreaterThan(100);
    for (const i of r.inputs) {
      const [x, , z] = i.transform.position;
      expect(polygonDistance(lake.points, x, z).inside).toBe(false);
      expect(s.sampleGroundType(x, z)).not.toBe(6);
      expect([3, 4]).not.toContain(s.sampleGroundType(x, z));
      expect(footprintOnRoad(S().doc.roads, footprintOf({ type: 'tree', params: i.params, transform: i.transform } as WorldObject)!, 0.4)).toBe(false);
      expect(s.sampleSlope(x, z)).toBeLessThanOrEqual(DEFAULT_FOREST.slopeLimit);
    }
    expect(r.reasons.placement).toBeGreaterThan(0); // the mountain flanks are too steep
  });
});

describe('Phase 36 reproducible forest strokes', () => {
  /** One stroke as the brush makes it: start, dabs along a path, the plan with the stroke's key. */
  const strokeAt = (x: number, z: number) => {
    beginForestStroke(x, z);
    const pts = [...forestDab(x, z), ...forestDab(x + 6, z), ...forestDab(x + 12, z + 3)];
    return planForest(pts, useNatureStore.getState().forest, undefined, forestStrokeKey(x, z));
  };

  it('the same stroke with the same seed gives the same trees, whatever was painted before', () => {
    useNatureStore.getState().setForest({ ...DEFAULT_FOREST, seed: 77 });
    const first = JSON.stringify(strokeAt(10, 10).inputs);
    strokeAt(-40, 20);
    strokeAt(30, -50);
    expect(JSON.stringify(strokeAt(10, 10).inputs)).toBe(first);
    // Another start point or another seed: other trees.
    expect(JSON.stringify(strokeAt(10.5, 10).inputs)).not.toBe(first);
    useNatureStore.getState().setForest({ seed: 78 });
    expect(JSON.stringify(strokeAt(10, 10).inputs)).not.toBe(first);
    expect(forestStrokeKey(10, 10)).toBeGreaterThan(0);
  });

  it('the forest settings persist (browser storage, like the build settings); missing fields get their defaults', () => {
    // (Node has no localStorage, so the store runs without its persist API here: the options are tested directly.)
    const opts = NATURE_PERSIST;
    expect(opts.name).toBe('ds.nature');
    const saved = opts.partialize(useNatureStore.getState()) as { forest: ForestSettings };
    expect(Object.keys(saved)).toEqual(['forest']);
    expect(saved.forest.seed).toBe(useNatureStore.getState().forest.seed);
    const merged = opts.merge({ forest: { seed: 5, density: 2 } }, useNatureStore.getState()) as { forest: ForestSettings };
    expect(merged.forest.seed).toBe(5);
    expect(merged.forest.roadMargin).toBe(useNatureStore.getState().forest.roadMargin);
  });
});
