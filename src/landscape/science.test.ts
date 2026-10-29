/**
 * Phase 19 scientific consistency checks: one terrain for collider / water bed / rendering /
 * placement after layered edits, water flows from the higher to the lower water surface, and
 * a Rapier ray hits the composed terrain.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { terrainColliderDesc } from '@/terrain/TerrainPhysicsAdapter';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { defaultWaterSettings, type BoundarySide } from '@/core/model';
import { WaterField } from '@/simulation/water/WaterField';
import { WaterSolver } from '@/simulation/water/WaterSolver';
import { WaterForcing } from '@/simulation/water/WaterForcing';
import { RapierEngine } from '@/physics/RapierEngine';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import type { Feature } from './types';

const S = () => useWorldStore.getState();
beforeEach(() => { S().setLocked(false); S().newDocument(); });

const features: Feature[] = [
  { id: 'f1', kind: 'mountain', x: -40, z: -40, radius: 40, height: 18, roughness: 0.3, seed: 2 },
  { id: 'f2', kind: 'river', points: [[-99, 20], [0, 30], [99, 25]], width: 6, depth: 1.5, bankSlope: 2, material: 8, meander: { amplitude: 5, wavelength: 60, seed: 2 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0, inflow: 0, downstream: 'open' } },
  { id: 'f3', kind: 'lake', points: [[30, -70], [70, -70], [70, -30], [30, -30]], surface: -0.3, depth: 3, shoreWidth: 6, material: 7, filled: true },
];

describe('one terrain for collider, water bed and rendering', { timeout: 120_000 }, () => {
  it('after layer + road + sculpt edits the collider heights ARE the terrain heights and the water bed is their cell mean', () => {
    S().setFeatures(features, 4);
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-90, -10], [90, 0]], { curved: false, profile: defaultProfile() }).network });
    S().beginTerrainStroke();
    for (let k = 0; k < 8; k++) S().terrainDab({ op: 'raise', x: 20, z: 60, brush: { radius: 10, strength: 1 }, dt: 0.05 });
    S().endTerrainStroke();
    const t = S().doc.terrain;
    const desc = terrainColliderDesc(t)!;
    expect(desc.heights).toBe(t.heights); // the same array: the collider is built from it
    const f = new WaterField(new TerrainSampler(t), defaultWaterSettings());
    for (let k = 0; k < 500; k++) {
      const ix = (k * 37) % f.nx, iz = (k * 53) % f.nz, v = iz * t.nx + ix, h = t.heights;
      expect(f.bed[iz * f.nx + ix]).toBeCloseTo((h[v] + 2 * h[v + 1] + 2 * h[v + t.nx] + h[v + t.nx + 1]) / 6, 9);
    }
    // Rendering / placement sampler reads the same heights.
    const s = new TerrainSampler(t);
    expect(s.sampleHeight(t.originX + 50, t.originZ + 50)).toBe(t.heights[50 * t.nx + 50]);
  });

  it('a Rapier ray lands on the composed (natural + roads) terrain', async () => {
    S().setFeatures(features, 4);
    const t = S().doc.terrain;
    const engine = new RapierEngine();
    await engine.init(-9.81, terrainColliderDesc(t));
    for (const [x, z] of [[-40, -40], [0, 30], [50, -50], [80, 80]]) {
      const toi = engine.castGroundRay([x, 200, z], [0, -1, 0], 400);
      expect(toi).not.toBeNull();
      expect(Math.abs(200 - toi! - new TerrainSampler(t).sampleHeight(x, z))).toBeLessThan(0.05);
    }
    engine.dispose();
  });
});

describe('water flows from the higher to the lower water surface', { timeout: 120_000 }, () => {
  it('two basins connected by a channel equalize toward a common level; mass conserved', () => {
    S().setFeatures([
      { id: 'f1', kind: 'lake', points: [[-80, -20], [-40, -20], [-40, 20], [-80, 20]], surface: 0, depth: 3, shoreWidth: 4, material: 7, filled: false },
      { id: 'f2', kind: 'lake', points: [[40, -20], [80, -20], [80, 20], [40, 20]], surface: 0, depth: 3, shoreWidth: 4, material: 7, filled: false },
      { id: 'f3', kind: 'river', points: [[-45, 0], [45, 0]], width: 4, depth: 2, bankSlope: 1.5, material: 8, meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'follow', crossing: 'culvert', water: { fill: 0, inflow: 0, downstream: 'closed' } },
    ], 4);
    const t = S().doc.terrain;
    const w = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0 };
    for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: 'closed' };
    const f = new WaterField(new TerrainSampler(t), w);
    // West basin full to −0.5 m, east basin empty.
    for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) {
      const x = f.cellX(ix), z = f.cellZ(iz), i = iz * f.nx + ix;
      if (x > -80 && x < -40 && z > -20 && z < 20 && f.bed[i] < -0.5) {
        f.h[i] = -0.5 - f.bed[i];
        f.touch(ix, iz);
      }
    }
    f.budget.initial = f.totalVolume();
    const solver = new WaterSolver(f, new WaterForcing(w, t));
    const eta = (x: number) => f.sampleSurface(x, 0);
    const before = { west: eta(-60), east: eta(60) };
    for (let k = 0; k < 600; k++) solver.step(0.5);
    const after = { west: eta(-60), east: eta(60) };
    expect(before.west).toBeGreaterThan(-0.6);
    expect(after.west).toBeLessThan(before.west - 0.05); // the high side went down
    expect(f.sampleDepth(60, 0)).toBeGreaterThan(0.05); // water reached the low basin
    expect(Math.abs(f.totalVolume() - f.budget.initial) / f.budget.initial).toBeLessThan(1e-6);
  });
});
