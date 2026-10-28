import { describe, expect, it } from 'vitest';
import { GRAVITY } from '@/core/units';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { resolveEarthquake, assumedPga, defaultDuration } from '@/events/earthquake/resolveEarthquake';
import type { EarthquakeEventSpec } from '@/events/specs';
import { createGroundMotionSample, createWaveform, GroundMotionField } from './GroundMotionField';
import { AXIS_H1, AXIS_H2, AXIS_V, WAVE_RATE } from './SyntheticWaveform';

const SPEC: EarthquakeEventSpec = { event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 30, dominantFrequency: 2, seed: 7 };

function field(spec = SPEC, terrain = new TerrainSampler(createFlatTerrain())) {
  const q = resolveEarthquake(spec, 1);
  const f = new GroundMotionField(terrain);
  f.start(q, createWaveform(q), 0);
  return { f, q };
}

/** Time history of the horizontal acceleration magnitude at a point. */
function history(f: GroundMotionField, x: number, z: number, dur: number, dt = 1 / WAVE_RATE) {
  const s = createGroundMotionSample();
  const out: number[] = [];
  for (let t = 0; t < dur; t += dt) {
    f.sample(x, z, t, s);
    out.push(Math.hypot(s.a[0], s.a[2]));
  }
  return out;
}

describe('ground motion: determinism', () => {
  it('same scenario + seed → bit-identical waveform; different seed → different', () => {
    const a = createWaveform(resolveEarthquake(SPEC, 1)).soil(1).a[AXIS_H1];
    const b = createWaveform(resolveEarthquake(SPEC, 1)).soil(1).a[AXIS_H1];
    expect(Array.from(b)).toEqual(Array.from(a));
    const c = createWaveform(resolveEarthquake({ ...SPEC, seed: 8 }, 1)).soil(1).a[AXIS_H1];
    expect(Array.from(c)).not.toEqual(Array.from(a));
  });

  it('the event seed defaults to the simulation seed', () => {
    const { seed: _s, ...noSeed } = SPEC;
    expect(resolveEarthquake(noSeed, 99).seed).toBe(99);
  });
});

describe('ground motion: acceleration', () => {
  it('peak horizontal acceleration on the reference soil equals the requested PGA', () => {
    const { f } = field();
    const peak = Math.max(...history(f, 0, 0, 30));
    expect(peak / GRAVITY).toBeCloseTo(0.3, 2);
  });

  it('amplitude builds up, peaks and decays (not full strength from the start)', () => {
    const { f } = field();
    const h = history(f, 0, 0, 30, 0.01);
    const rms = (a: number, b: number) => Math.sqrt(h.slice(a * 100, b * 100).reduce((s, v) => s + v * v, 0) / ((b - a) * 100));
    const onset = rms(0, 2);
    const strong = rms(8, 14);
    const coda = rms(25, 30);
    expect(onset).toBeLessThan(strong * 0.3);
    expect(coda).toBeLessThan(strong * 0.3);
    expect(h[0]).toBe(0);
    expect(h[h.length - 1]).toBeLessThan(1e-6);
  });

  it('velocity and displacement are consistent with acceleration (no drift)', () => {
    const w = createWaveform(resolveEarthquake(SPEC, 1));
    const t = w.soil(1);
    for (const axis of [AXIS_H1, AXIS_H2, AXIS_V]) {
      let v = 0;
      let d = 0;
      let maxErr = 0;
      let maxV = 0;
      for (let i = 1; i < w.samples; i++) {
        v += ((t.a[axis][i - 1] + t.a[axis][i]) / 2) / WAVE_RATE;
        d += ((t.v[axis][i - 1] + t.v[axis][i]) / 2) / WAVE_RATE;
        maxErr = Math.max(maxErr, Math.abs(v - t.v[axis][i]));
        maxV = Math.max(maxV, Math.abs(t.v[axis][i]));
      }
      expect(maxErr).toBeLessThan(maxV * 0.03);
      // Displacement returns to zero at the end (envelope → 0): no baseline drift.
      expect(Math.abs(t.d[axis][w.samples - 3])).toBeLessThan(1e-4);
    }
  });

  it('vertical motion arrives first (P wave) and peaks at the vertical ratio', () => {
    const { f, q } = field({ ...SPEC, depth: 30 });
    const s = createGroundMotionSample();
    let firstV = -1;
    let firstH = -1;
    let peakV = 0;
    for (let t = 0; t < 30; t += 0.005) {
      f.sample(0, 0, t, s);
      if (firstV < 0 && Math.abs(s.a[1]) > 1e-3) firstV = t;
      if (firstH < 0 && Math.hypot(s.a[0], s.a[2]) > 1e-3) firstH = t;
      peakV = Math.max(peakV, Math.abs(s.a[1]));
    }
    expect(firstV).toBeLessThan(firstH);
    expect(peakV / GRAVITY).toBeCloseTo(q.pga * q.verticalRatio, 2);
  });

  it('the principal axis follows the direction (bearing)', () => {
    const { f } = field({ ...SPEC, direction: 0 }); // N–S shaking
    const s = createGroundMotionSample();
    let ex = 0;
    let ez = 0;
    for (let t = 0; t < 30; t += 0.01) {
      f.sample(0, 0, t, s);
      ex += s.a[0] ** 2;
      ez += s.a[2] ** 2;
    }
    expect(ez).toBeGreaterThan(ex);
  });
});

describe('soil amplification', () => {
  it('soft soil and reclaimed ground shake more than dense soil, rock less', () => {
    const t = createFlatTerrain();
    // Paint the four soils in quadrants far from their boundaries.
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.soil[iz * t.nx + ix] = (ix < 100 ? 0 : 2) + (iz < 100 ? 0 : 1);
    t.revision++;
    const sampler = new TerrainSampler(t);
    const { f } = field(SPEC, sampler);
    const peak = (x: number, z: number) => Math.max(...history(f, x, z, 30));
    const rock = peak(-50, -50);
    const dense = peak(-50, 50);
    const soft = peak(50, -50);
    const reclaimed = peak(50, 50);
    expect(rock).toBeLessThan(dense);
    expect(soft).toBeGreaterThan(dense * 1.15);
    expect(reclaimed).toBeGreaterThan(dense * 1.3);
  });

  it('properties blend smoothly across a soil boundary', () => {
    const t = createFlatTerrain();
    for (let i = 0; i < t.soil.length; i++) t.soil[i] = i % t.nx < 100 ? 1 : 2;
    t.revision++;
    const s = new TerrainSampler(t);
    const w = new Float64Array(4);
    s.sampleSoilWeights(-1.5, 0, w); // between two dense-soil vertices
    expect(w[1]).toBeCloseTo(1);
    s.sampleSoilWeights(-0.5, 0, w); // halfway between dense (x = −1) and soft (x = 0)
    expect(w[1]).toBeCloseTo(0.5);
    expect(w[2]).toBeCloseTo(0.5);
    s.sampleSoilWeights(0.5, 0, w);
    expect(w[2]).toBeCloseTo(1);
  });
});

describe('earthquake defaults and assumptions', () => {
  it('magnitude alone → duration/frequency/PGA filled in and every default is listed', () => {
    const q = resolveEarthquake({ event: 'earthquake', magnitude: 6.5 }, 1);
    expect(q.pgaAssumed).toBe(true);
    expect(q.duration).toBe(defaultDuration(6.5));
    expect(q.pga).toBe(assumedPga(6.5, 10));
    const keys = q.assumptions.map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(['eq.assume.pga', 'eq.assume.duration', 'eq.assume.frequency', 'eq.assume.depth', 'eq.assume.epicenter', 'eq.assume.direction']));
  });

  it('an explicit PGA is used as given (magnitude does not override it)', () => {
    const q = resolveEarthquake({ event: 'earthquake', magnitude: 8, pga: 0.1 }, 1);
    expect(q.pga).toBe(0.1);
    expect(q.pgaAssumed).toBe(false);
  });
});
