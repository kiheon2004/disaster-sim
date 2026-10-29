import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { applyDab, TALUS } from '@/terrain/TerrainEditor';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { defaultWaterSettings, type BoundarySide } from '@/core/model';
import { WaterField } from '@/simulation/water/WaterField';
import { SimulationController } from '@/simulation/SimulationController';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { hydrologyPlan, initialWater } from './hydrology';
import { planForest } from '@/app/natureActions';
import type { LakeFeature, PeakFeature, RiverFeature } from './types';

const S = () => useWorldStore.getState();
const at = (x: number, z: number) => {
  const t = S().doc.terrain;
  return Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);
};

const river = (id: string, extra: Partial<RiverFeature> = {}): RiverFeature => ({
  id, kind: 'river', points: [[-99, 0], [0, 0], [99, 0]], width: 6, depth: 1.5, bankSlope: 2, material: 8,
  meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0, inflow: 0, downstream: 'open' }, ...extra,
});
const lake = (id: string, extra: Partial<LakeFeature> = {}): LakeFeature => ({ id, kind: 'lake', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]], surface: -0.3, depth: 2.5, shoreWidth: 6, material: 7, filled: true, ...extra });

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('landscape brushes', () => {
  const dab = (op: Parameters<typeof applyDab>[1]['op'], extra: Partial<Parameters<typeof applyDab>[1]> = {}, t = createFlatTerrain()) => {
    applyDab(t, { op, x: 0, z: 0, brush: { radius: 10, strength: 1 }, dt: 0.1, ...extra });
    return t;
  };
  const h = (t: ReturnType<typeof createFlatTerrain>, x: number, z: number) => t.heights[Math.round(z - t.originZ) * t.nx + Math.round(x - t.originX)];

  it('plateau only cuts what stands above the level', () => {
    const t = dab('raise');
    for (let k = 0; k < 5; k++) applyDab(t, { op: 'raise', x: 0, z: 0, brush: { radius: 10, strength: 1 }, dt: 0.1 });
    const before = t.heights.slice();
    for (let k = 0; k < 20; k++) applyDab(t, { op: 'plateau', x: 0, z: 0, brush: { radius: 10, strength: 1 }, dt: 0.1, targetHeight: 2 });
    for (let i = 0; i < t.heights.length; i++) {
      expect(t.heights[i]).toBeLessThanOrEqual(before[i] + 1e-6);
      if (before[i] <= 2) expect(t.heights[i]).toBe(before[i]);
    }
    expect(h(t, 0, 0)).toBeCloseTo(2, 1);
  });

  it('ridge is sharper than raise; height limits cap what the brush adds', () => {
    const r = dab('ridge'), u = dab('raise');
    expect(h(r, 6, 0) / h(r, 0, 0)).toBeLessThan(h(u, 6, 0) / h(u, 0, 0));
    const capped = createFlatTerrain();
    for (let k = 0; k < 30; k++) applyDab(capped, { op: 'raise', x: 0, z: 0, brush: { radius: 10, strength: 1 }, dt: 0.1, maxHeight: 1.5 });
    expect(Math.max(...capped.heights)).toBeLessThanOrEqual(1.5);
  });

  it('noise is deterministic per seed and differs between seeds', () => {
    const a = dab('noise', { seed: 4 }), b = dab('noise', { seed: 4 }), c = dab('noise', { seed: 5 });
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
    expect(Array.from(a.heights)).not.toEqual(Array.from(c.heights));
  });

  it('slope makes a straight ramp between the two ends', () => {
    const t = createFlatTerrain();
    for (let k = 0; k < 40; k++) applyDab(t, { op: 'slope', x: 0, z: 0, brush: { radius: 30, strength: 1 }, dt: 0.1, slope: { ax: -20, az: 0, ah: 0, bx: 20, bz: 0, bh: 4 } });
    expect(h(t, -10, 0)).toBeCloseTo(1, 1);
    expect(h(t, 10, 0)).toBeCloseTo(3, 1);
  });

  it('erosion moves material downhill only where steeper than the talus slope; volume is conserved', () => {
    const t = createFlatTerrain();
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) if (ix > 100) t.heights[iz * t.nx + ix] = 3; // 3 m cliff
    t.ground.fill(2); // sand: erodible
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    const v0 = sum(t.heights);
    for (let k = 0; k < 50; k++) applyDab(t, { op: 'erode', x: 0, z: 0, brush: { radius: 12, strength: 1 }, dt: 0.1 });
    expect(Math.abs(sum(t.heights) - v0) / v0).toBeLessThan(1e-4); // (1 cm quantization per step)
    let steep = 0;
    for (let ix = 92; ix <= 108; ix++) steep = Math.max(steep, t.heights[100 * t.nx + ix + 1] - t.heights[100 * t.nx + ix]);
    expect(steep).toBeLessThan(3);
    expect(steep).toBeGreaterThanOrEqual(TALUS - 0.05);
  });
});

describe('river / lake hydrology', { timeout: 120_000 }, () => {
  it('a filled lake starts with water up to its surface inside the basin only', () => {
    S().setFeatures([lake('f1')], 2);
    const w = initialWater(S().doc.landscape, S().doc.terrain)!;
    const t = S().doc.terrain;
    const cell = (x: number, z: number) => Math.floor((z - t.originZ) / t.cellSize) * (t.nx - 1) + Math.floor((x - t.originX) / t.cellSize);
    expect(w[cell(0, 0)]).toBeCloseTo(2.5, 1);
    expect(w[cell(50, 50)]).toBe(0);
  });

  it('lake water stays in its basin: mass is conserved, nothing flows out', async () => {
    S().setFeatures([lake('f1')], 2);
    const d = structuredClone(S().doc);
    d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    const c = new SimulationController();
    await c.load(d);
    c.advance(20);
    const f = (c as unknown as { env: { flood: { field: WaterField } } }).env.flood.field;
    expect(f).toBeTruthy();
    const v0 = f.budget.initial;
    expect(v0).toBeGreaterThan(1000);
    expect(Math.abs(f.totalVolume() - v0) / v0).toBeLessThan(1e-6);
    expect(f.sampleDepth(50, 50)).toBe(0);
    c.unload();
  });

  it('river inflow flows downstream and leaves at the open edge; a changed path changes the flow', async () => {
    const run = async (points: [number, number][]) => {
      S().newDocument();
      // A valley falling 1 % toward +x (the base terrain layer).
      const t0 = S().doc.terrain;
      const heights = new Float32Array(t0.heights.length);
      for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = Math.round(-0.01 * (t0.originX + ix) * 100) / 100;
      S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
      S().setFeatures([river('f1', { points, water: { fill: 0, inflow: 6, downstream: 'open' } })], 2);
      const d = structuredClone(S().doc);
      const w = defaultWaterSettings();
      for (const side of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[side] = { type: 'closed' };
      d.settings.simulation.water = { ...w, infiltration: false, drainageCapacity: 0 };
      const c = new SimulationController();
      await c.load(d);
      c.advance(150);
      const f = (c as unknown as { env: { flood: { field: WaterField } } }).env.flood.field;
      return { c, f };
    };
    const a = await run([[-99, 0], [0, 0], [99, 0]]);
    const v: [number, number] = [0, 0];
    a.f.sampleVelocity(40, 0, v);
    expect(a.f.sampleDepth(40, 0)).toBeGreaterThan(0.05);
    expect(v[0]).toBeGreaterThan(0.05); // downstream = +x
    expect(a.f.budget.boundaryOut).toBeGreaterThan(0);
    expect(Math.abs(a.f.budget.error)).toBeLessThan(1e-6 * Math.max(1, a.f.totalVolume()));
    expect(a.f.sampleDepth(0, 60)).toBe(0);
    a.c.unload();
    const b = await run([[-99, 0], [0, 40], [99, 60]]);
    expect(b.f.sampleDepth(0, 40)).toBeGreaterThan(0.05);
    expect(b.f.sampleDepth(40, 0)).toBe(0);
    b.c.unload();
  });

  it('inflow on a fixed-level edge is refused; inflow without an outlet is warned about', () => {
    S().setFeatures([river('f1', { water: { fill: 0, inflow: 5, downstream: 'closed' } })], 2);
    const w = defaultWaterSettings();
    w.boundaries.W = { type: 'fixedLevel', level: 0.5 };
    const p = hydrologyPlan(S().doc.landscape, S().doc.terrain, w);
    expect(p.sources).toHaveLength(0);
    expect(p.issues.map((i) => i.code)).toContain('sourceAtFixedEdge');
    const q = hydrologyPlan(S().doc.landscape, S().doc.terrain, defaultWaterSettings());
    expect(q.sources).toHaveLength(1);
    expect(q.issues.map((i) => i.code)).toContain('noOutlet');
  });

  it('culvert keeps the channel open under a road; an embankment blocks it', () => {
    const roadNet = () => drawRoad(S().doc.roads, [[0, -60], [0, 60]], { curved: false, profile: { ...defaultProfile(), elevation: 'graded' } }).network;
    S().setFeatures([river('f1')], 2);
    S().applyEdit({ roads: roadNet() });
    const culvert = S().doc.terrain.heights[at(0, 0)];
    expect(culvert).toBeLessThan(-1);
    S().newDocument();
    S().setFeatures([river('f1', { crossing: 'embankment' })], 2);
    S().applyEdit({ roads: roadNet() });
    expect(S().doc.terrain.heights[at(0, 0)]).toBeGreaterThan(culvert + 1);
  });
});

describe('materials and vegetation', () => {
  it('infiltration differs by surface material in the water model', () => {
    const t = createFlatTerrain();
    t.ground.fill(2); // sand
    for (let i = 0; i < t.nx * 100; i++) t.ground[i] = 6; // rock in the north half
    const f = new WaterField(new TerrainSampler(t), defaultWaterSettings());
    const cell = (z: number) => Math.floor((z - t.originZ)) * f.nx + 100;
    expect(f.infilRate[cell(50)]).toBeGreaterThan(f.infilRate[cell(-50)] * 5);
  });

  it('forest planning is deterministic and keeps out of lakes, roads and steep ground', () => {
    S().setFeatures([lake('f1'), { id: 'f2', kind: 'mountain', x: 60, z: 60, radius: 30, height: 40, roughness: 0, seed: 1 } as PeakFeature], 3);
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-90, -60], [90, -60]], { curved: false, profile: defaultProfile() }).network });
    const pts: [number, number][] = [];
    for (let x = -90; x <= 90; x += 7) for (let z = -90; z <= 90; z += 7) pts.push([x, z]);
    const settings = { coniferShare: 0.5, density: 1, spacing: 3, radius: 10, seed: 4, slopeLimit: 25, minElevation: -5, maxElevation: 80, variation: true };
    const a = planForest(pts, settings), b = planForest(pts, settings);
    expect(JSON.stringify(a.inputs)).toBe(JSON.stringify(b.inputs));
    expect(a.inputs.length).toBeGreaterThan(200);
    for (const i of a.inputs) {
      const [x, , z] = i.transform.position;
      expect(Math.abs(x) < 29 && Math.abs(z) < 29).toBe(false); // not in the lake
      expect(Math.abs(z + 60) < 5.5).toBe(false); // not on the road
    }
    expect(new Set(a.inputs.map((i) => i.params?.species)).size).toBe(2);
    expect(a.rejected).toBeGreaterThan(0);
  });
});
