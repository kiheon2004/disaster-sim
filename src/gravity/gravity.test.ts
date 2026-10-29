import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { GravityField, experimentBlend, globalVector, type GravityExperiment } from './field';
import { blendAt, smoother } from './profiles';
import { presetSpec, scenarioDefaults } from './presets';
import { GRAVITY_SCENARIOS, EARTH_G, defaultGravitySpec, gravityIssues, type GravitySourceSpec, type GravitySpec } from './types';

const spec = (p: Partial<GravitySpec>): GravitySpec => ({ ...defaultGravitySpec(), ...p });
const exp = (id: string, s: GravitySpec, start = 0): GravityExperiment => ({ id, spec: s, start });
const g = (f: GravityField, p: Vec3 = [0, 0, 0]) => f.sample(p[0], p[1], p[2], [0, 0, 0]);
const radial = (p: Partial<GravitySourceSpec> = {}): GravitySourceSpec => ({ kind: 'radial', center: [0, 0, 0], radius: 30, falloff: 'smooth', edge: 10, strength: 10, r0: 5, law: 'inverseSquare', softening: 2, ...p });

describe('gravity profiles', () => {
  it('blend is a pure function of time: any step size samples the same values', () => {
    const p = { profile: 'smooth' as const, duration: 100, ramp: 30 };
    const coarse: number[] = [], fine: number[] = [];
    for (let t = 0; t <= 100; t += 5) coarse.push(blendAt(p, t));
    for (let k = 0; k <= 100 * 64; k++) if (k % 320 === 0) fine.push(blendAt(p, k / 64));
    expect(fine).toEqual(coarse);
  });
  it('smootherstep has zero slope and curvature at both ends', () => {
    const h = 1e-4;
    for (const x of [0, 1]) {
      const d1 = (smoother(Math.min(1, x + h)) - smoother(Math.max(0, x - h))) / (x === 0 || x === 1 ? h : 2 * h);
      expect(Math.abs(d1)).toBeLessThan(1e-6);
    }
    expect(smoother(0.5)).toBeCloseTo(0.5, 12);
  });
  it('pulse: square pulses and quintic edges', () => {
    const p = { profile: 'pulse' as const, duration: 60, period: 10, pulseWidth: 4, ramp: 0 };
    expect(blendAt(p, 1)).toBe(1);
    expect(blendAt(p, 5)).toBe(0);
    expect(blendAt(p, 11)).toBe(1);
    const q = { ...p, ramp: 1 };
    expect(blendAt(q, 0)).toBe(0);
    expect(blendAt(q, 0.5)).toBeCloseTo(0.5, 12);
    expect(blendAt(q, 2)).toBe(1);
    expect(blendAt(q, 3.5)).toBeCloseTo(0.5, 12);
  });
  it('staged and scheduled', () => {
    expect(blendAt({ profile: 'staged', duration: 30, stages: [[10, 0.5], [20, 1]] }, 15)).toBe(0.5);
    expect(blendAt({ profile: 'staged', duration: 30, stages: [[10, 0.5], [20, 1]] }, 5)).toBe(0);
    expect(blendAt({ profile: 'scheduled', duration: 30, windows: [[5, 10]] }, 7)).toBe(1);
    expect(blendAt({ profile: 'scheduled', duration: 30, windows: [[5, 10]] }, 10)).toBe(0);
  });
});

describe('gravity spec validation', () => {
  it('every preset is valid', () => {
    for (const s of GRAVITY_SCENARIOS) if (s !== 'custom') expect(gravityIssues(presetSpec(s)), s).toEqual([]);
    expect(gravityIssues(defaultGravitySpec())).toEqual([]);
  });
  it('rejects contradictory input with a reason', () => {
    expect(gravityIssues(spec({ magnitude: -1 }))).toContain('gravity.invalid.magnitude');
    expect(gravityIssues(spec({ magnitude: 500 }))).toContain('gravity.invalid.magnitude');
    expect(gravityIssues(spec({ direction: [0, 0, 0] }))).toContain('gravity.invalid.direction');
    expect(gravityIssues(spec({ profile: 'linear', ramp: 1000 }))).toContain('gravity.invalid.ramp');
    expect(gravityIssues(spec({ global: false, sources: [] }))).toContain('gravity.invalid.empty');
    // An unsoftened point mass would be infinite at its centre.
    expect(gravityIssues(spec({ sources: [radial({ softening: 0 })] }))).toContain('gravity.invalid.softening');
    expect(gravityIssues(spec({ sources: [radial({ strength: 50, r0: 30, softening: 1 })] }))).toContain('gravity.invalid.core');
  });
  it('Moon / Mars presets set the magnitude only', () => {
    expect(scenarioDefaults('moon').magnitude).toBe(1.62);
    expect(scenarioDefaults('mars').magnitude).toBe(3.71);
    expect(scenarioDefaults('double').magnitude).toBe(2 * EARTH_G);
  });
});

describe('gravity field composition', () => {
  it('no experiment: exactly the project gravity, uniform', () => {
    const f = new GravityField(9.81).prepare(3);
    expect(g(f)).toEqual([0, -9.81, 0]);
    expect(f.uniform).toBe(true);
    expect(f.potential(0, 2, 0)).toBeCloseTo(9.81 * 2, 12);
  });
  it('a global experiment replaces the project gravity (no double gravity) and restores after its window', () => {
    const f = new GravityField(9.81);
    f.add(exp('a', spec({ magnitude: 1.62, profile: 'constant', duration: 10 }), 2));
    expect(g(f.prepare(1))).toEqual([0, -9.81, 0]);
    expect(g(f.prepare(5))[1]).toBeCloseTo(-1.62, 12);
    expect(g(f.prepare(12))).toEqual([0, -9.81, 0]);
  });
  it('restore with a ramp profile ramps back symmetrically inside the window', () => {
    const e = exp('a', spec({ magnitude: 0, profile: 'linear', ramp: 10, duration: 40, end: 'restore' }));
    expect(experimentBlend(e, 5)).toBeCloseTo(0.5, 12);
    expect(experimentBlend(e, 20)).toBe(1);
    expect(experimentBlend(e, 35)).toBeCloseTo(0.5, 12);
    expect(experimentBlend(e, 40)).toBeNull();
    const h = exp('b', spec({ magnitude: 0, profile: 'linear', ramp: 10, duration: 40, end: 'hold' }));
    expect(experimentBlend(h, 100)).toBe(1);
  });
  it('the later experiment wins the global part and starts from the field in force (continuous)', () => {
    const f = new GravityField(9.81);
    f.add(exp('a', spec({ magnitude: 3.71, profile: 'constant', duration: 100, end: 'hold' }), 0));
    f.add(exp('b', spec({ magnitude: 20, profile: 'linear', ramp: 10, duration: 50 }), 10));
    expect(g(f.prepare(10))[1]).toBeCloseTo(-3.71, 12);
    expect(g(f.prepare(15))[1]).toBeCloseTo(-(3.71 + 0.5 * (20 - 3.71)), 12);
  });
  it('vector transition of a reversal passes through zero; rotate keeps |g| on a sideways turn', () => {
    const rev = spec({ magnitude: 9.81, direction: [0, 1, 0], transition: 'vector' });
    const v = globalVector(rev, [0, -9.81, 0], 0.5, [0, 0, 0]);
    expect(Math.hypot(...v)).toBeLessThan(1e-12);
    const side = spec({ magnitude: 9.81, direction: [1, 0, 0], transition: 'rotate' });
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      const w = globalVector(side, [0, -9.81, 0], s, [0, 0, 0]);
      expect(Math.hypot(...w)).toBeCloseTo(9.81, 10);
    }
    expect(globalVector(side, [0, -9.81, 0], 1, [0, 0, 0])[0]).toBeCloseTo(9.81, 10);
    // Antiparallel rotate (reversal at constant |g|) turns through the horizontal.
    const flip = globalVector(spec({ magnitude: 9.81, direction: [0, 1, 0], transition: 'rotate' }), [0, -9.81, 0], 0.5, [0, 0, 0]);
    expect(Math.abs(flip[1])).toBeLessThan(1e-9);
    expect(Math.hypot(...flip)).toBeCloseTo(9.81, 10);
  });
  it('local sources add on top of the global part; creation order never changes the result (bitwise)', () => {
    const a = spec({ global: false, sources: [radial({ center: [3, 1, -2] }), { kind: 'region', center: [0, 0, 0], radius: 12, falloff: 'linear', edge: 4, shape: 'sphere', mode: 'add', accel: [0.3, 2, -0.7] }] });
    const b = spec({ global: true, magnitude: 5, sources: [radial({ center: [-4, 2, 1], strength: -6 })] });
    const f1 = new GravityField(9.81), f2 = new GravityField(9.81);
    f1.add(exp('x', a, 1)); f1.add(exp('y', b, 1));
    f2.add(exp('y', b, 1)); f2.add(exp('x', { ...a, sources: [...a.sources].reverse() }, 1));
    for (const p of [[0.4, 1.1, -0.3], [5, 3, 2], [-7, 0.5, 4], [11, 2, -1]] as Vec3[]) {
      expect(g(f2.prepare(4), p)).toEqual(g(f1.prepare(4), p));
    }
    expect(f1.uniform).toBe(false);
  });
  it('a replace region sets the total field inside (local zero gravity) and tapers to the outside', () => {
    const f = new GravityField(9.81);
    f.add(exp('z', spec({ global: false, profile: 'constant', sources: [{ kind: 'region', center: [0, 0, 0], radius: 10, edge: 2, falloff: 'linear', shape: 'column', mode: 'replace', accel: [0, 0, 0] }] })));
    f.prepare(1);
    expect(Math.hypot(...g(f, [0, 50, 0]))).toBe(0); // column: any height
    expect(g(f, [9, 0, 0])[1]).toBeCloseTo(-9.81 * 0.5, 12);
    expect(g(f, [11, 0, 0])).toEqual([0, -9.81, 0]);
    expect(f.potentialDefined).toBe(false);
    expect(f.potential(0, 0, 0)).toBeNaN();
  });
  it('radial source: g = −∇Φ (central differences) everywhere incl. the tapered edge', () => {
    for (const law of ['inverseSquare', 'linear', 'constant'] as const) {
      const f = new GravityField(9.81);
      f.add(exp('r', spec({ magnitude: 0, profile: 'constant', sources: [radial({ law, center: [1, 2, 3] })] })));
      f.prepare(1);
      expect(f.potentialDefined).toBe(true);
      const h = 1e-4;
      for (const p of [[4, 2, 3], [1, 9, 3], [10, -5, 9], [1 + 25, 2, 3], [1 + 21, 2 + 1, 3]] as Vec3[]) {
        const gv = g(f, p);
        for (let j = 0; j < 3; j++) {
          const a = [...p] as Vec3, b = [...p] as Vec3;
          a[j] += h; b[j] -= h;
          const d = -(f.potential(...a) - f.potential(...b)) / (2 * h);
          expect(Math.abs(d - gv[j]), `${law} ${p} ${j}`).toBeLessThan(2e-6 * Math.max(1, Math.abs(gv[j])));
        }
      }
      // Zero beyond the cut-off; attraction points to the centre.
      expect(g(f, [40, 2, 3])).toEqual([0, -0, 0].map(Math.abs) as Vec3);
      expect(g(f, [5, 2, 3])[0]).toBeLessThan(0);
    }
  });
  it('softened inverse-square: bounded at the centre, ≈ S·(r0/r)² far from the core', () => {
    const f = new GravityField(0);
    f.add(exp('r', spec({ magnitude: 0, profile: 'constant', sources: [radial({ radius: 300, edge: 1, softening: 0.5, strength: 10, r0: 5 })] })));
    f.prepare(1);
    expect(Math.hypot(...g(f, [0, 0, 0]))).toBe(0);
    expect(Math.hypot(...g(f, [50, 0, 0]))).toBeCloseTo(10 * (5 / 50) ** 2, 4);
  });
  it('followProfile scales the source with the blend; otherwise it is on for the whole window', () => {
    const s = spec({ global: false, profile: 'linear', ramp: 10, duration: 40, end: 'hold', sources: [radial({ followProfile: true })] });
    const f = new GravityField(9.81);
    f.add(exp('a', s));
    const full = (() => { const q = new GravityField(9.81); q.add(exp('a', { ...s, profile: 'constant' })); return g(q.prepare(5), [8, 0, 0]); })();
    const half = g(f.prepare(5), [8, 0, 0]);
    expect(half[0]).toBeCloseTo(full[0] * 0.5, 12);
  });
  it('gradient of a uniform field is zero; tidal of a linear (harmonic) field is −S/r0 · d', () => {
    const f = new GravityField(9.81).prepare(0);
    expect(Array.from(f.gradient(1, 2, 3)).every((v) => Math.abs(v) < 1e-9)).toBe(true);
    const r = new GravityField(0);
    r.add(exp('r', spec({ magnitude: 0, profile: 'constant', sources: [radial({ law: 'linear', strength: 4, r0: 8, radius: 100, edge: 1 })] })));
    r.prepare(1);
    const t = r.tidal([5, 0, 0], [1, 0, 0], [0, 0, 0]);
    expect(t[0]).toBeCloseTo(-4 / 8, 10);
  });
});

describe('gravity outlook and presets', () => {
  it('support rules: Earth full; 2 g scaled; zero g holds the free-surface models; tilt beyond 0.3 limited; uplift limits structures', async () => {
    const { supportOf, modeOf, gravityOutlook } = await import('./outlook');
    const st = (down: number, horizontal = 0, local = false) => supportOf({ down, horizontal, magnitude: Math.hypot(down, horizontal), local }, 9.81);
    expect(Object.values(st(9.81)).every((v) => v === 'full')).toBe(true);
    expect(st(19.62).structure).toBe('scaled');
    expect(st(19.62).flood).toBe('scaled');
    expect(st(0).flood).toBe('unsupported');
    expect(st(0).rigid).toBe('full');
    expect(st(9.81, 4).flood).toBe('limited');
    expect(st(9.81, 2).flood).toBe('scaled');
    expect(st(-9.81).structure).toBe('limited');
    expect(modeOf([0, -9.81, 0], 9.81, true)).toBe('earth');
    expect(modeOf([0, -1.62, 0], 9.81, true)).toBe('low');
    expect(modeOf([0, 9.81, 0], 9.81, true)).toBe('reverse');
    expect(modeOf([9.81, 0, 0], 9.81, true)).toBe('sideways');
    expect(modeOf([0, 0, 0], 9.81, true)).toBe('zero');
    expect(modeOf([0, -9.81, 0], 9.81, false)).toBe('local');
    const o = gravityOutlook(presetSpec('reverse'));
    expect(o.minDown).toBeCloseTo(-9.81, 9);
    expect(o.limits).toContain('gravity.lim.uplift');
    expect(gravityOutlook(presetSpec('zero')).limits).toContain('gravity.lim.waterNoDown');
  });
  it('every preset has a demo world with a valid gravity experiment (and its companion phenomenon)', async () => {
    const { gravityDemo } = await import('./demos');
    for (const s of GRAVITY_SCENARIOS) {
      if (s === 'custom') continue;
      const d = gravityDemo(s);
      const g = d.events.find((e) => e.event === 'gravity') as unknown as GravitySpec;
      expect(gravityIssues(g), s).toEqual([]);
      expect(d.objects.length).toBeGreaterThan(10);
    }
    expect(gravityDemo('highSnow').events.some((e) => e.event === 'climate')).toBe(true);
  });
});
