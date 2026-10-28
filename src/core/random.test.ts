import { describe, expect, it } from 'vitest';
import { Rng } from './random';

describe('Rng', () => {
  it('same seed → same sequence; forks are independent and stable', () => {
    const a = new Rng(5), b = new Rng(5);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    const f1 = new Rng(5).fork('wind').next();
    const f2 = new Rng(5).fork('wind').next();
    expect(f1).toBe(f2);
    expect(new Rng(5).fork('other').next()).not.toBe(f1);
  });
  it('helpers stay in range', () => {
    const r = new Rng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.range(2, 3);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(3);
      expect(Math.abs(r.spread(0.5))).toBeLessThanOrEqual(0.5);
      expect(r.int(4)).toBeLessThan(4);
    }
  });
});
