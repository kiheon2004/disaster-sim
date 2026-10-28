import { describe, expect, it } from 'vitest';
import { stressScene } from './stressScene';
import { WORLD_HALF } from '@/core/units';

describe('stressScene', () => {
  it.each([100, 500, 1000])('creates ~%i objects inside the world, deterministically', (n) => {
    const a = stressScene(n);
    const b = stressScene(n);
    expect(a.length).toBeGreaterThan(n * 0.9);
    expect(a.length).toBeLessThanOrEqual(n);
    for (const o of a) {
      expect(Math.abs(o.transform.position[0])).toBeLessThan(WORLD_HALF);
      expect(Math.abs(o.transform.position[2])).toBeLessThan(WORLD_HALF);
    }
    expect(b).toEqual(a);
  });
});
