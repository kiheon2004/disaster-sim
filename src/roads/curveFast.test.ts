import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/random';
import { centerlineOf, nearest, nearestFast } from './curve';

describe('nearestFast', () => {
  it('matches the exhaustive nearest point on long, winding lines', () => {
    const rng = new Rng(5);
    const pts: [number, number][] = [];
    for (let k = 0; k < 14; k++) pts.push([-300 + k * 45, rng.spread(80)]);
    const line = centerlineOf(pts);
    expect(line.samples.length).toBeGreaterThan(200);
    for (let i = 0; i < 2000; i++) {
      const x = rng.spread(320), z = rng.spread(150);
      const a = nearest(line, x, z), b = nearestFast(line, x, z);
      expect(b.dist).toBeCloseTo(a.dist, 9);
      if (a.dist > 1e-6) expect(b.side).toBe(a.side);
    }
  });
});
