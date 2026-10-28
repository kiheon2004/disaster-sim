import { hashString } from './math';

/**
 * Seeded PRNG (mulberry32). Every source of randomness inside the simulation core goes through
 * an Rng so that the same world + settings + seed reproduce the same damage sequence.
 * `fork(label)` derives an independent, stable stream (e.g. one per system) so adding a random
 * draw in one system does not shift the numbers seen by another.
 */
export class Rng {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform in [-spread, spread]. */
  spread(spread: number): number {
    return (this.next() * 2 - 1) * spread;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  fork(label: string): Rng {
    return new Rng((this.seed ^ hashString(label)) >>> 0);
  }
}

export function randomSeed(): number {
  // Only used to *propose* a new seed in the UI; the simulation itself never calls this.
  return Math.floor(Math.random() * 1_000_000);
}
