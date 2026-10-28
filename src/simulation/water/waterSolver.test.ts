/**
 * Water model (Phase 14): solver-level tests on small synthetic terrains.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultWaterSettings, type BoundarySide, type TerrainData, type WaterBoundaryType, type WaterSettings } from '@/core/model';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField, relativeError, type Footprint } from './WaterField';
import { WaterForcing } from './WaterForcing';
import { WaterSolver } from './WaterSolver';
import { mmPerHour } from './waterParams';

function terrain(size: number, height: (x: number, z: number) => number, ground = 0): TerrainData {
  const t = createFlatTerrain(size, 1);
  for (let iz = 0; iz < t.nz; iz++) {
    for (let ix = 0; ix < t.nx; ix++) {
      t.heights[iz * t.nx + ix] = Math.round(height(t.originX + ix, t.originZ + iz) * 100) / 100;
      t.ground[iz * t.nx + ix] = ground;
    }
  }
  t.revision++;
  return t;
}

function settings(boundary: WaterBoundaryType = 'closed', extra: Partial<WaterSettings> = {}): WaterSettings {
  const s = defaultWaterSettings();
  for (const side of ['N', 'E', 'S', 'W'] as BoundarySide[]) s.boundaries[side] = { type: boundary };
  s.infiltration = false;
  s.drainageCapacity = 0;
  return { ...s, ...extra };
}

function setup(t: TerrainData, s: WaterSettings, obstacles: Footprint[] = []) {
  const field = new WaterField(new TerrainSampler(t), s, obstacles);
  const forcing = new WaterForcing(s, t);
  return { field, forcing, solver: () => new WaterSolver(field, forcing) };
}

/** Put a block of water (surface `eta`) on the cells within `r` of (x, z). */
function mound(field: WaterField, x: number, z: number, r: number, depth: number) {
  for (let iz = 0; iz < field.nz; iz++) {
    for (let ix = 0; ix < field.nx; ix++) {
      if (Math.hypot(field.cellX(ix) - x, field.cellZ(iz) - z) <= r) {
        field.h[iz * field.nx + ix] = depth;
        field.touch(ix, iz);
      }
    }
  }
  field.budget.initial = field.totalVolume();
  field.updateStats();
}

function run(solver: WaterSolver, seconds: number, dt: number) {
  for (let t = 0; t < seconds - 1e-9; t += dt) solver.step(dt);
}

const hashH = (f: WaterField) => createHash('sha256').update(Buffer.from(f.h.buffer)).digest('hex');

describe('water solver: mass conservation', { timeout: 120_000 }, () => {
  it('closed basin on uneven ground keeps its volume (relative error < 1e-10)', () => {
    const t = terrain(40, (x, z) => 0.8 * Math.sin(x / 5) * Math.cos(z / 7) + 0.02 * x);
    const { field, solver } = setup(t, settings('closed'));
    mound(field, -5, 3, 6, 1.5);
    const s = solver();
    const v0 = field.totalVolume();
    run(s, 120, 1 / 15);
    expect(field.budget.boundaryIn + field.budget.boundaryOut).toBe(0);
    expect(Math.abs(field.totalVolume() - v0) / v0).toBeLessThan(1e-10);
    expect(relativeError(field.budget)).toBeLessThan(1e-10);
  });

  it('every budget term closes with rain, a source, infiltration, drainage and open edges', () => {
    const t = terrain(40, (x) => 0.03 * x, 0);
    for (let i = 0; i < t.ground.length; i += 3) t.ground[i] = 3; // some asphalt
    const s = settings('open', { infiltration: true, drainageCapacity: 20 });
    const { field, forcing, solver } = setup(t, s);
    const sv = solver();
    forcing.addRain(field, 'r', mmPerHour(120), null);
    forcing.addSource(field, 's', 0.5, [5, 0], 2);
    run(sv, 300, 1 / 15);
    const b = field.budget;
    expect(b.rain).toBeCloseTo(mmPerHour(120) * 300 * 40 * 40, 3);
    expect(b.sources).toBeCloseTo(0.5 * 300, 3);
    expect(b.infiltration).toBeGreaterThan(0);
    expect(b.drainage).toBeGreaterThan(0);
    expect(b.boundaryOut).toBeGreaterThan(0);
    expect(b.boundaryIn).toBe(0); // open edges never let water in
    expect(relativeError(b)).toBeLessThan(1e-10);
  });
});

describe('water solver: flow', { timeout: 120_000 }, () => {
  it('water flows from the high surface to the low one and settles level', () => {
    const t = terrain(30, () => 0);
    const { field, solver } = setup(t, settings('closed'));
    // Dam-break: deep water in the west half, dry east half.
    for (let iz = 0; iz < field.nz; iz++) for (let ix = 0; ix < 10; ix++) field.h[iz * field.nx + ix] = 1;
    field.touch(0, 0);
    field.touch(9, field.nz - 1);
    field.budget.initial = field.totalVolume();
    field.updateStats();
    const s = solver();
    s.step(1 / 15);
    // Flow goes east (+x) through the first wet/dry front.
    expect(field.qx[15 * (field.nx + 1) + 10]).toBeGreaterThan(0);
    run(s, 400, 1 / 15);
    // Settled: uniform surface ≈ volume / area.
    const mean = field.totalVolume() / (30 * 30);
    let dev = 0;
    for (let i = 0; i < field.count; i++) dev = Math.max(dev, Math.abs(field.h[i] - mean));
    expect(mean).toBeCloseTo(1 / 3, 6);
    expect(dev).toBeLessThan(0.01);
  });

  it('water collects in the lowest ground (a depression) and leaves the slopes dry', () => {
    const t = terrain(40, (x, z) => 0.002 * (x * x + z * z) - 1.5);
    const { field, forcing, solver } = setup(t, settings('closed'));
    const s = solver();
    forcing.addRain(field, 'r', mmPerHour(200), null);
    run(s, 120, 1 / 15);
    forcing.removeRain('r');
    run(s, 600, 1 / 15);
    const center = field.indexAt(0.5, 0.5);
    const rim = field.indexAt(18.5, 0.5);
    expect(field.h[center]).toBeGreaterThan(0.05);
    expect(field.h[rim]).toBeLessThan(0.005);
    // The pond surface is level.
    const etaC = field.bed[center] + field.h[center];
    const near = field.indexAt(3.5, -2.5);
    expect(Math.abs(field.bed[near] + field.h[near] - etaC)).toBeLessThan(0.005);
  });

  it('flow goes around a ridge instead of through it', () => {
    // A 1.5 m ridge across the middle (along z = 0) with a gap at x > 10.
    const t = terrain(40, (x, z) => (Math.abs(z) < 2 && x < 10 ? 1.5 : 0));
    const { field, solver } = setup(t, settings('closed'));
    mound(field, -10, -12, 6, 1.4);
    const s = solver();
    run(s, 400, 1 / 15);
    // Water reached the south side only by passing the gap (x > 10).
    const south = field.indexAt(-10.5, 12.5);
    expect(field.h[south]).toBeGreaterThan(0.01);
    for (let ix = 0; ix < field.nx; ix++) {
      const i = field.indexAt(field.cellX(ix), 0.5);
      if (field.cellX(ix) < 9) expect(field.h[i]).toBe(0); // the ridge crest stays dry
    }
  });

  it('buildings block the flow; their roof rain drains to the nearest street', () => {
    const t = terrain(30, () => 0);
    const house: Footprint = { id: 'b1', center: [0, 0], half: [4, 4], yaw: 0.3 };
    const { field, forcing, solver } = setup(t, settings('closed'), [house]);
    const s = solver();
    forcing.addRain(field, 'r', mmPerHour(100), null);
    run(s, 60, 1 / 15);
    const inside = field.indexAt(0.5, 0.5);
    expect(field.blocked[inside]).toBe(1);
    expect(field.h[inside]).toBe(0);
    expect(relativeError(field.budget)).toBeLessThan(1e-10);
    // A collapsed building no longer blocks.
    expect(field.removeObstacle('b1')).toBe(true);
    expect(field.blocked[inside]).toBe(0);
  });
});

describe('water solver: boundaries', { timeout: 120_000 }, () => {
  it('closed edges hold water; open edges let it leave', () => {
    const t = terrain(30, (x) => -0.02 * x);
    const closed = setup(t, settings('closed'));
    mound(closed.field, 0, 0, 8, 1);
    const sc = closed.solver();
    run(sc, 200, 1 / 15);
    expect(closed.field.budget.boundaryOut).toBe(0);

    const open = setup(t, settings('open'));
    mound(open.field, 0, 0, 8, 1);
    const so = open.solver();
    run(so, 200, 1 / 15);
    expect(open.field.budget.boundaryOut).toBeGreaterThan(0.2 * open.field.budget.initial);
    expect(relativeError(open.field.budget)).toBeLessThan(1e-10);
  });

  it('a fixed-level edge fills the low ground behind it up to that level', () => {
    const t = terrain(40, (x) => 0.05 * (x + 20) - 1); // −1 m at the west edge → +1 m east
    const s = settings('closed');
    s.boundaries.W = { type: 'fixedLevel', level: 0.3 };
    const { field, solver } = setup(t, s);
    const sv = solver();
    run(sv, 600, 1 / 15);
    const lowIdx = field.indexAt(-18.5, 0.5);
    const highIdx = field.indexAt(15.5, 0.5);
    expect(field.bed[lowIdx] + field.h[lowIdx]).toBeCloseTo(0.3, 1);
    // At most the residual film left by the inflow surge's run-up (below the flow threshold).
    expect(field.h[highIdx]).toBeLessThan(1e-3);
    expect(field.budget.boundaryIn).toBeGreaterThan(0);
    expect(relativeError(field.budget)).toBeLessThan(1e-10);
  });
});

describe('water solver: sources and stability', { timeout: 120_000 }, () => {
  it('rainfall input = intensity × area × time; a local source adds exactly its inflow', () => {
    const t = terrain(20, () => 0);
    const { field, forcing, solver } = setup(t, settings('closed'));
    const s = solver();
    forcing.addRain(field, 'r', mmPerHour(80), { center: [0, 0], radius: 5 });
    forcing.addSource(field, 'src', 2, [6, 6], 1.5);
    run(s, 60, 1 / 60);
    const cellsInArea = forcing.rains[0].cells!.length;
    expect(field.budget.rain).toBeCloseTo(mmPerHour(80) * 60 * cellsInArea, 9);
    expect(field.budget.sources).toBeCloseTo(120, 9);
    expect(field.totalVolume()).toBeCloseTo(field.budget.rain + 120, 6);
  });

  it('never produces negative depth, NaN or runaway velocities at wet/dry fronts', () => {
    const t = terrain(40, (x, z) => 0.6 * Math.sin(x / 3) + 0.4 * Math.cos(z / 2.3) + 0.1 * x);
    const { field, forcing, solver } = setup(t, settings('open', { infiltration: true }));
    const s = solver();
    forcing.addRain(field, 'r', mmPerHour(150), null);
    forcing.addSource(field, 'src', 3, [-10, 0], 2);
    for (let k = 0; k < 900; k++) {
      s.step(1 / 15);
      if (k % 50 === 0) {
        for (let i = 0; i < field.count; i++) {
          expect(field.h[i]).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(field.h[i])).toBe(true);
        }
        expect(field.stats.maxSpeed).toBeLessThan(15);
      }
    }
    expect(relativeError(field.budget)).toBeLessThan(1e-9);
  });

  it('stable for very different caller time steps (adaptive CFL substeps), with similar results', () => {
    const outcomes: number[] = [];
    for (const dt of [1 / 60, 1 / 15, 0.5, 2]) {
      const t = terrain(30, (x) => 0.04 * x);
      const { field, solver } = setup(t, settings('closed'));
      mound(field, -6, 0, 5, 2);
      const s = solver();
      run(s, 60, dt);
      for (let i = 0; i < field.count; i++) expect(Number.isFinite(field.h[i]) && field.h[i] >= 0).toBe(true);
      expect(relativeError(field.budget)).toBeLessThan(1e-10);
      if (dt >= 0.5) expect(s.substeps).toBeGreaterThan(1);
      outcomes.push(field.h[field.indexAt(-12.5, 0.5)]);
    }
    // Same physical time → close states regardless of the caller's step.
    for (const o of outcomes) expect(Math.abs(o - outcomes[0])).toBeLessThan(0.05);
  });

  it('is deterministic: same inputs → bit-identical water state', () => {
    const go = () => {
      const t = terrain(30, (x, z) => 0.3 * Math.sin(x / 4 + z / 5));
      const { field, forcing, solver } = setup(t, settings('open', { infiltration: true }));
      const s = solver();
      forcing.addRain(field, 'r', mmPerHour(90), null);
      forcing.addSource(field, 'src', 1, [0, 0], 2);
      run(s, 90, 1 / 15);
      return hashH(field);
    };
    expect(go()).toBe(go());
  });
});
