/**
 * Terrain deformation engine (Phase 21) — pure parts: shapes, time profiles, validation,
 * superposition, determinism, analytic volumes and grid convergence.
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { terrainDeformationSchema } from '@/events/deformation/deformationSchema';
import { DeformationEngine, PrescribedSource } from './engine';
import { amplitude, eventDuration, shapeAt, shapeGrid, timeFactor, validateDeformation } from './field';
import { groundResponseFor, groundResponseModels } from './groundModel';
import type { TerrainDeformationSpec } from './types';

const spec = (extra: Partial<TerrainDeformationSpec> = {}): TerrainDeformationSpec => ({
  event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 20, amount: 2, duration: 10, profile: 'linear', falloff: 'smooth', ...extra,
});
/** A grid of any spacing over the same 200 m world (grid convergence). */
const grid = (cell: number) => ({ nx: Math.round(200 / cell) + 1, nz: Math.round(200 / cell) + 1, cellSize: cell, originX: -100, originZ: -100 });
const volumeOn = (s: TerrainDeformationSpec, cell: number) => {
  const g = shapeGrid(s, grid(cell), 1)!;
  let v = 0;
  for (const x of g.values) v += x;
  return v * cell * cell;
};

describe('spatial shapes', () => {
  it('signs, peak at the centre, exactly zero outside the radius', () => {
    expect(amplitude(spec())).toBe(-2);
    expect(amplitude(spec({ kind: 'uplift' }))).toBe(2);
    expect(amplitude(spec({ kind: 'ridge' }))).toBe(2);
    for (const falloff of ['smooth', 'linear', 'steep'] as const) {
      const s = spec({ falloff });
      expect(shapeAt(s, 0, 0, 1)).toBeCloseTo(1, 12);
      expect(shapeAt(s, 20, 0, 1)).toBe(0);
      expect(shapeAt(s, 30, 5, 1)).toBe(0);
      // Monotone non-increasing along a radius.
      let prev = 1;
      for (let r = 0; r <= 20; r += 0.5) {
        const v = shapeAt(s, r, 0, 1);
        expect(v).toBeLessThanOrEqual(prev + 1e-12);
        prev = v;
      }
    }
    // Steep: flat floor to half the radius.
    expect(shapeAt(spec({ falloff: 'steep' }), 9.9, 0, 1)).toBe(1);
    expect(shapeAt(spec({ kind: 'depression' }), 9.9, 0, 1)).toBe(1);
  });

  it('analytic volumes: smooth bowl A·πR²(½ − 2/π²), cone A·πR²/3 — within 0.5 % on the 1 m grid', () => {
    const R = 20, A = 2;
    expect(volumeOn(spec(), 1)).toBeCloseTo(-A * Math.PI * R * R * (0.5 - 2 / Math.PI ** 2), -1);
    expect(Math.abs(volumeOn(spec(), 1) / (-A * Math.PI * R * R * (0.5 - 2 / Math.PI ** 2)) - 1)).toBeLessThan(0.005);
    expect(Math.abs(volumeOn(spec({ falloff: 'linear' }), 1) / (-A * Math.PI * R * R / 3) - 1)).toBeLessThan(0.005);
  });

  it('grid convergence: the volume error shrinks as the grid is refined (≈ 2nd order)', () => {
    const exact = -2 * Math.PI * 400 * (0.5 - 2 / Math.PI ** 2);
    const e4 = Math.abs(volumeOn(spec({ falloff: 'linear' }), 4) - (-2 * Math.PI * 400 / 3));
    const e2 = Math.abs(volumeOn(spec({ falloff: 'linear' }), 2) - (-2 * Math.PI * 400 / 3));
    const e1 = Math.abs(volumeOn(spec({ falloff: 'linear' }), 1) - (-2 * Math.PI * 400 / 3));
    expect(e2).toBeLessThan(e4);
    expect(e1).toBeLessThan(e2);
    const s4 = Math.abs(volumeOn(spec(), 4) - exact), s1 = Math.abs(volumeOn(spec(), 1) - exact);
    expect(s1).toBeLessThan(s4);
  });

  it('ridge: along its bearing, tapered at both ends, zero beyond half its length', () => {
    const r = spec({ kind: 'ridge', radius: 8, length: 60, bearing: 90 });
    expect(shapeAt(r, 0, 0, 1)).toBeCloseTo(1, 12);
    expect(shapeAt(r, 20, 0, 1)).toBeGreaterThan(0.5); // along the axis (east)
    expect(shapeAt(r, 0, 20, 1)).toBe(0); // across, beyond its half width
    expect(shapeAt(r, 31, 0, 1)).toBe(0);
    expect(shapeAt(r, 29, 0, 1)).toBeLessThan(shapeAt(r, 20, 0, 1)); // taper
    const n = spec({ kind: 'ridge', radius: 8, length: 60, bearing: 0 });
    expect(shapeAt(n, 0, -20, 1)).toBeCloseTo(shapeAt(r, 20, 0, 1), 9); // rotated 90°
  });

  it('distributed settlement: deterministic per seed, varies with the seed, never reverses sign', () => {
    const s = spec({ kind: 'settlement', radius: 60, variability: 0.6 });
    const a = shapeGrid(s, grid(1), 7)!, b = shapeGrid(s, grid(1), 7)!, c = shapeGrid(s, grid(1), 8)!;
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
    expect(Array.from(a.values)).not.toEqual(Array.from(c.values));
    expect(Math.max(...a.values)).toBeLessThanOrEqual(0);
    // The spec's own seed overrides the project seed.
    expect(Array.from(shapeGrid({ ...s, seed: 8 }, grid(1), 7)!.values)).toEqual(Array.from(c.values));
  });

  it('prescribed field: bilinear between the given values, its own sign, zero outside', () => {
    const s = spec({ kind: 'prescribed', field: { x0: 0, z0: 0, cell: 10, nx: 2, nz: 2, values: [1, -1, 3, 0] } });
    expect(amplitude(s)).toBe(1);
    expect(shapeAt(s, 0, 0, 1)).toBeCloseTo(1, 12);
    expect(shapeAt(s, 10, 0, 1)).toBeCloseTo(-1, 12);
    expect(shapeAt(s, 5, 5, 1)).toBeCloseTo((1 - 1 + 3 + 0) / 4, 12);
    expect(shapeAt(s, -1, 0, 1)).toBe(0);
  });
});

describe('time profiles', () => {
  it('instant / linear / smooth / staged / cyclic; deformation persists after the end', () => {
    const f = (profile: TerrainDeformationSpec['profile'], tau: number, extra: Partial<TerrainDeformationSpec> = {}) => timeFactor(spec({ profile, ...extra }), tau);
    expect(f('instant', 0)).toBe(1);
    expect(f('instant', -0.01)).toBe(0);
    expect(eventDuration(spec({ profile: 'instant' }))).toBeCloseTo(1 / 60, 12);
    expect(f('linear', 5)).toBeCloseTo(0.5, 12);
    expect(f('linear', 100)).toBe(1);
    expect(f('smooth', 5)).toBeCloseTo(0.5, 12);
    expect(f('smooth', 1)).toBeLessThan(0.1); // slow start
    expect(f('staged', 0, { stages: 4 })).toBe(0);
    expect(f('staged', 2.6, { stages: 4 })).toBe(0.25);
    expect(f('staged', 9.99, { stages: 4 })).toBe(0.75);
    expect(f('staged', 10, { stages: 4 })).toBe(1);
    expect(f('cyclic', 2, { period: 4 })).toBeCloseTo(1, 12);
    expect(f('cyclic', 4, { period: 4 })).toBeCloseTo(0, 12);
    // After the duration it holds the value it reached (period 4, duration 10 → phase 2.5/4).
    expect(f('cyclic', 50, { period: 4 })).toBeCloseTo(f('cyclic', 10, { period: 4 }), 12);
  });
});

describe('validation', () => {
  const t = createFlatTerrain();
  const codes = (s: TerrainDeformationSpec) => validateDeformation(s, t, 1).issues.map((i) => `${i.severity}:${i.code}`);
  it('refuses values outside the hard limits — with a reason, never clamped', () => {
    expect(codes(spec({ radius: 1 }))).toContain('error:radius');
    expect(codes(spec({ amount: 31 }))).toContain('error:amount');
    expect(codes(spec({ duration: -1 }))).toContain('error:duration');
    expect(codes(spec({ profile: 'staged', stages: 0 }))).toContain('error:stages');
    expect(codes(spec({ kind: 'prescribed' }))).toContain('error:field');
    expect(terrainDeformationSchema.safeParse(spec({ radius: 1 })).success).toBe(false);
    expect(terrainDeformationSchema.safeParse(spec()).success).toBe(true);
  });
  it('warns about steep / very steep / large / edge / outside, and reports the numbers', () => {
    expect(codes(spec())).toEqual([]);
    expect(codes(spec({ amount: 10, radius: 10 }))).toContain('warning:steep');
    expect(codes(spec({ kind: 'depression', amount: 20, radius: 6 }))).toContain('warning:verySteep');
    expect(codes(spec({ amount: 12, radius: 100 }))).toContain('warning:large');
    expect(codes(spec({ center: [95, 0] }))).toContain('warning:edge');
    expect(codes(spec({ center: [400, 0] }))).toContain('warning:outside');
    const v = validateDeformation(spec(), t, 1);
    expect(v.maxAbs).toBeCloseTo(2, 6);
    expect(v.volume).toBeLessThan(0);
    // Smooth bowl: steepest slope A·π/(2R).
    expect(v.maxSlope).toBeCloseTo((2 * Math.PI) / 40, 2);
  });
});

describe('runtime deformation layer', () => {
  const run = (sources: TerrainDeformationSpec[], times: number[], seed = 1) => {
    const t = createFlatTerrain();
    const e = new DeformationEngine(t);
    sources.forEach((s, i) => e.add(new PrescribedSource(`s${i}`, `p${i}`, s, s.startTime ?? 0, t, seed)));
    for (const time of times) e.update(time);
    return { t, e };
  };

  it('H = H0 + W; the original copy is never written; only the source rectangle changes', () => {
    const t = createFlatTerrain();
    for (let i = 0; i < t.heights.length; i++) t.heights[i] = (i % 7) * 0.1;
    const h0 = t.heights.slice();
    const e = new DeformationEngine(t);
    e.add(new PrescribedSource('a', 'p', spec(), 0, t, 1));
    const u = e.update(10)!;
    expect(u.rect.x1 - u.rect.x0).toBeLessThanOrEqual(41);
    for (let i = 0; i < t.heights.length; i++) expect(t.heights[i]).toBeCloseTo(h0[i] + e.field[i], 5);
    expect(Array.from(e.original)).toEqual(Array.from(h0));
    const ix = Math.round(60 - t.originX), iz = Math.round(0 - t.originZ);
    expect(t.heights[iz * t.nx + ix]).toBe(h0[iz * t.nx + ix]); // outside the rectangle: untouched
    expect(e.displacementAt(0, 0)).toBeCloseTo(-2, 5);
    expect(e.originalAt(0, 0)).toBeCloseTo(h0[iz * t.nx + Math.round(0 - t.originX)], 5);
  });

  it('linear superposition: overlapping sources add, independent of order', () => {
    const a = spec({ center: [-8, 0] }), b = spec({ kind: 'uplift', amount: 1, center: [8, 0], radius: 25 });
    const ab = run([a, b], [10]), ba = run([b, a], [10]), onlyA = run([a], [10]), onlyB = run([b], [10]);
    for (let i = 0; i < ab.e.field.length; i += 97) {
      expect(ab.e.field[i]).toBeCloseTo(onlyA.e.field[i] + onlyB.e.field[i], 5);
      expect(ab.e.field[i]).toBeCloseTo(ba.e.field[i], 6);
    }
  });

  it('time integration does not depend on how often it is updated (dt independence)', () => {
    const s = spec({ profile: 'smooth' });
    const coarse = run([s], [3, 10]);
    const fine = run([s], Array.from({ length: 100 }, (_, i) => (i + 1) * 0.1));
    for (let i = 0; i < coarse.e.field.length; i += 53) expect(fine.e.field[i]).toBeCloseTo(coarse.e.field[i], 5);
    const mid = run([s], [5]), midFine = run([s], [1, 2, 3, 4, 5]);
    expect(midFine.e.displacementAt(0, 0)).toBeCloseTo(mid.e.displacementAt(0, 0), 6);
  });

  it('determinism: same specs and seed → bit-identical field', () => {
    const s = [spec({ kind: 'settlement', radius: 50, variability: 0.5 }), spec({ kind: 'ridge', center: [10, 10], radius: 6, length: 40, bearing: 30, amount: 1 })];
    const a = run(s, [2, 4, 10], 99), b = run(s, [2, 4, 10], 99);
    expect(Array.from(a.e.field)).toEqual(Array.from(b.e.field));
    expect(Array.from(a.t.heights)).toEqual(Array.from(b.t.heights));
  });

  it('updates only when a source changed; reports the changed rectangle and dirty regions', () => {
    const { e } = run([spec()], [10]);
    expect(e.wants(11)).toBe(false);
    expect(e.update(11)).toBeNull();
    const rev = e.rev;
    expect(e.dirtySince(rev)).toBeNull();
    expect(e.dirtySince(rev - 1)).not.toBeNull();
    expect(e.dirtySince(-100)).toEqual({ x0: 0, z0: 0, x1: e.terrain.nx - 1, z1: e.terrain.nz - 1 });
  });

  it('a source outside the grid is ignored; support is a separate, explicit quantity', () => {
    const { e } = run([spec({ center: [500, 0] })], [10]);
    expect(e.active).toBe(false);
    const s = run([spec()], [10]).e;
    expect(s.supportAt(0, 0, 10)).toBe(1); // displacement alone does not reduce support
    const l = run([spec({ supportLoss: 0.5 })], [10]).e;
    expect(l.supportAt(0, 0, 10)).toBeCloseTo(0.5, 9);
    expect(l.supportAt(50, 0, 10)).toBe(1);
  });

  it('instant source: a newly added source is urgent (applied in the step it starts)', () => {
    const t = createFlatTerrain();
    const e = new DeformationEngine(t);
    e.add(new PrescribedSource('a', 'p', spec({ profile: 'instant' }), 0, t, 1));
    expect(e.urgent).toBe(true);
    const u = e.update(0)!;
    expect(u.discontinuous).toBe(true);
    expect(e.displacementAt(0, 0)).toBeCloseTo(-2, 5);
    expect(e.urgent).toBe(false);
  });
});

describe('ground material extension point', () => {
  it('no soil response model is registered: the prescribed displacement is used as is', () => {
    expect(groundResponseModels()).toHaveLength(0);
    for (const soil of [0, 1, 2, 3] as const) expect(groundResponseFor(soil)).toBeNull();
  });
});

describe('sources that report their changed part (Phase 22)', () => {
  /** A whole-grid source whose field changes in a few local patches over time. */
  const patchy = (t: ReturnType<typeof createFlatTerrain>, report: boolean) => {
    const G = new Float32Array(t.nx * t.nz);
    let rev = 0;
    let dirty: { x0: number; z0: number; x1: number; z1: number } | null = null;
    const src = {
      id: 'g', phenomenon: 'g', kind: 'groundFailure', model: 'physics' as const, startTime: 0, duration: Infinity,
      rect: { x0: 0, z0: 0, x1: t.nx - 1, z1: t.nz - 1 },
      version: () => rev,
      sample: (_tau: number, out: Float32Array) => { out.set(G); dirty = null; },
      ...(report ? { changedRect: () => dirty } : {}),
    };
    const poke = (x0: number, z0: number, w: number, v: number) => {
      for (let iz = z0; iz < z0 + w; iz++) for (let ix = x0; ix < x0 + w; ix++) G[iz * t.nx + ix] += v;
      const r = { x0, z0, x1: x0 + w - 1, z1: z0 + w - 1 };
      dirty = dirty ? { x0: Math.min(dirty.x0, r.x0), z0: Math.min(dirty.z0, r.z0), x1: Math.max(dirty.x1, r.x1), z1: Math.max(dirty.z1, r.z1) } : r;
      rev++;
    };
    return { src, poke };
  };

  it('diffing only the changed part gives the same terrain as the whole rect; the update reports only that part', () => {
    const results = [true, false].map((report) => {
      const t = createFlatTerrain();
      for (let i = 0; i < t.heights.length; i++) t.heights[i] = (i % 5) * 0.05;
      const e = new DeformationEngine(t);
      const { src, poke } = patchy(t, report);
      e.add(src);
      const rects: number[] = [];
      const steps: [number, number, number, number][] = [[10, 10, 4, -1], [100, 50, 6, 0.5], [12, 11, 3, 0.25], [150, 150, 2, -2]];
      steps.forEach(([x, z, w, v], k) => {
        poke(x, z, w, v);
        const u = e.update(k + 1)!;
        rects.push((u.rect.x1 - u.rect.x0 + 1) * (u.rect.z1 - u.rect.z0 + 1));
      });
      expect(e.update(10)).toBeNull(); // nothing changed since
      return { h: t.heights.slice(), W: e.field.slice(), rects };
    });
    expect(results[0].h).toEqual(results[1].h);
    expect(results[0].W).toEqual(results[1].W);
    expect(results[0].rects).toEqual([16, 36, 9, 4]);
    expect(results[1].rects.every((n) => n === 201 * 201)).toBe(true);
  });
});
