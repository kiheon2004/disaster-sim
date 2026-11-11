/**
 * Phase 37 (audit U4 / U5): the cursor ground point and the view point — ray maths against a real terrain sampler,
 * rounding, and when the tracker looks the point up.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundPoint, ndcOf, newPointerState, round1, roundPoint, samePoint, shouldSample, viewPoint, type GroundRay } from './pointMath';

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Ray from `from` through `to`. */
const ray = (from: Vec3, to: Vec3): [Vec3, Vec3] => [from, norm([to[0] - from[0], to[1] - from[1], to[2] - from[2]])];

/** A hill: 6 m high at (20, −10), 12 m wide. */
function hill() {
  const t = createFlatTerrain();
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
    const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
    t.heights[iz * t.nx + ix] = 6 * Math.max(0, 1 - Math.hypot(x - 20, z + 10) / 12);
  }
  return t;
}

describe('rounding', () => {
  it('rounds to 0.1 m and never writes −0', () => {
    expect(round1(12.34)).toBe(12.3);
    expect(round1(-7.25)).toBe(-7.2); // (Math.round rounds halves up: −72.5 → −72)
    expect(round1(0.04)).toBe(0);
    expect(Object.is(round1(-0.04), 0)).toBe(true);
    expect(roundPoint(1.26, -3.94)).toEqual([1.3, -3.9]);
  });
  it('samePoint compares values, not arrays', () => {
    expect(samePoint([1, 2], [1, 2])).toBe(true);
    expect(samePoint([1, 2], [1, 2.1])).toBe(false);
    expect(samePoint(null, null)).toBe(true);
    expect(samePoint(null, [0, 0])).toBe(false);
  });
});

describe('ndcOf', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  it('maps the canvas rectangle to −1 … 1 with y up', () => {
    expect(ndcOf(500, 350, rect)).toEqual([0, 0]);
    expect(ndcOf(100, 50, rect)).toEqual([-1, 1]);
    expect(ndcOf(900, 650, rect)).toEqual([1, -1]);
  });
  it('is null outside the canvas and for a canvas without size', () => {
    expect(ndcOf(99, 350, rect)).toBeNull();
    expect(ndcOf(500, 651, rect)).toBeNull();
    expect(ndcOf(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});

describe('groundPoint (cursor)', () => {
  it('flat ground: the point the ray is aimed at, rounded to 0.1 m', () => {
    const g = samplerFor(createFlatTerrain());
    const [o, d] = ray([48, 42, 62], [12.34, 0, -7.86]);
    expect(groundPoint(g, o, d, 100)).toEqual([12.3, -7.9]);
  });
  it('a hill: the ray stops on the slope facing the camera, not on the flat ground behind it', () => {
    const t = hill();
    const g = samplerFor(t);
    // Aimed at the flat-ground point behind the hill top as seen from the east.
    const [o, d] = ray([60, 12, -10], [10, 0, -10]);
    const p = groundPoint(g, o, d, 100)!;
    expect(p).not.toBeNull();
    expect(p[0]).toBeGreaterThan(20); // on the east slope
    expect(p[0]).toBeLessThan(32);
    expect(p[1]).toBe(-10);
    // The hit is ON the surface: the ray's height there equals the ground height (0.1 m rounding of x → small slack).
    const tHit = (o[0] - p[0]) / -d[0];
    expect(Math.abs(o[1] + d[1] * tHit - g.sampleHeight(p[0], p[1]))).toBeLessThan(0.1);
  });
  it('null when the ray goes to the sky, and when it meets the ground outside the map (the caller keeps its last point)', () => {
    const g = samplerFor(createFlatTerrain());
    expect(groundPoint(g, [0, 10, 0], norm([1, 0.2, 0]), 100)).toBeNull();
    const [o, d] = ray([0, 30, 0], [150, 0, 0]);
    expect(groundPoint(g, o, d, 100)).toBeNull();
    // (the edge itself is on the map)
    const [o2, d2] = ray([0, 30, 0], [100, 0, 0]);
    expect(groundPoint(g, o2, d2, 100)).toEqual([100, 0]);
  });
  it('a broken ray gives no point', () => {
    const bad: GroundRay = { raycast: (_o, _d, _m, out) => { out[0] = NaN; out[2] = 0; return true; } };
    expect(groundPoint(bad, [0, 1, 0], [0, -1, 0], 100)).toBeNull();
  });
});

describe('viewPoint (camera look-at)', () => {
  it('where the middle ray meets the ground — not the orbit target when that floats above it', () => {
    const g = samplerFor(createFlatTerrain());
    // The camera looks at a target 8 m above the ground (a focused building): the view point is the ground behind it.
    const [o, d] = ray([40, 28, 40], [10, 8, 10]);
    const p = viewPoint(g, o, d, [10, 10])!;
    expect(p[0]).toBeCloseTo(-2, 5);
    expect(p[1]).toBeCloseTo(-2, 5);
  });
  it('falls back to the orbit target (x, z) when the ray meets no ground; null with neither', () => {
    const g = samplerFor(createFlatTerrain());
    const up = norm([1, 0.1, 0]);
    expect(viewPoint(g, [0, 5, 0], up, [33.33, -4.44])).toEqual([33.3, -4.4]);
    expect(viewPoint(g, [0, 5, 0], up, null)).toBeNull();
  });
  it('is the same for the same camera (no clock, no randomness)', () => {
    const g = samplerFor(hill());
    const [o, d] = ray([60, 30, 30], [20, 3, -10]);
    expect(viewPoint(g, o, d, [20, -10])).toEqual(viewPoint(g, o, d, [20, -10]));
  });
});

describe('when the tracker looks', () => {
  it('only over the canvas, with no button down, and only when the pointer or the camera moved', () => {
    const s = newPointerState();
    expect(shouldSample(s, true)).toBe(false); // never over the canvas
    s.inside = true;
    expect(shouldSample(s, false)).toBe(false); // nothing moved
    s.dirty = true;
    expect(shouldSample(s, false)).toBe(true);
    s.dirty = false;
    expect(shouldSample(s, true)).toBe(true); // wheel zoom under a still pointer
    s.held = true;
    s.dirty = true;
    expect(shouldSample(s, true)).toBe(false); // camera drag / gesture
    s.held = false;
    s.inside = false;
    expect(shouldSample(s, true)).toBe(false); // left for the command bar: the last point stays
  });
});
