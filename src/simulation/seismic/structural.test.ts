import { describe, expect, it } from 'vitest';
import { GRAVITY } from '@/core/units';
import { StructuralModel, type UnitInit } from './StructuralModel';

const DT = 1 / 60;

function unit(over: Partial<UnitInit> = {}): UnitInit {
  return {
    ndof: 1, mass: 1e5, height: 10, period: 0.5, dampingRatio: 0.05, cyX: 10, cyZ: 10, hardening: 0.05,
    driftU: 0.05, yaw: 0, gravity: GRAVITY, foundation: null, ...over,
  };
}

/** Steady-state peak top displacement under harmonic base acceleration A·sin(2πft). */
function harmonicPeak(init: UnitInit, f: number, A = 1, seconds = 30) {
  const m = new StructuralModel();
  m.add(init);
  m.finalize();
  let peak = 0;
  for (let i = 0; i < seconds / DT; i++) {
    const t = i * DT;
    m.agx[0] = A * Math.sin(2 * Math.PI * f * t);
    m.stepUnit(0, DT);
    if (t > seconds * 0.6) peak = Math.max(peak, Math.abs(m.top[0]));
  }
  return { peak, model: m };
}

describe('structural response (reduced MDOF)', () => {
  it('an SDOF resonates at its natural frequency (dynamic amplification ≈ 1/2ζ)', () => {
    const init = unit({ period: 0.5 });
    const fn = 1 / 0.5;
    const res = harmonicPeak(init, fn).peak;
    const off = harmonicPeak(init, fn * 3).peak;
    // Static displacement of a 1 m/s² load: a/ω².
    const xs = 1 / (2 * Math.PI * fn) ** 2;
    expect(res / xs).toBeGreaterThan(7);
    expect(res / xs).toBeLessThan(13);
    expect(off).toBeLessThan(res / 10);
  });

  it('free vibration period matches the target period (multi-DOF chain too)', () => {
    for (const [ndof, T] of [[1, 0.4], [3, 0.8], [5, 1.6]] as const) {
      const m = new StructuralModel();
      m.add(unit({ ndof, period: T, dampingRatio: 0.01, height: ndof * 3.2 }));
      m.finalize();
      // Short pulse, then count zero crossings of the top displacement.
      for (let i = 0; i < 6; i++) { m.agx[0] = 3; m.stepUnit(0, DT); }
      m.agx[0] = 0;
      const crossings: number[] = [];
      let prev = m.top[0];
      for (let i = 0; i < 20 / DT; i++) {
        m.stepUnit(0, DT);
        const x = m.top[0];
        if (prev < 0 && x >= 0) crossings.push(i * DT);
        prev = x;
      }
      const periods = crossings.slice(1).map((c, k) => c - crossings[k]);
      const measured = periods.reduce((a, b) => a + b, 0) / periods.length;
      expect(measured).toBeGreaterThan(T * 0.93);
      expect(measured).toBeLessThan(T * 1.07);
    }
  });

  it('the building is not moved rigidly with the ground: quasi-static input gives ~no relative motion', () => {
    const slow = harmonicPeak(unit({ period: 0.3 }), 0.05, 1, 60).peak;
    const ground = 1 / (2 * Math.PI * 0.05) ** 2; // ground displacement amplitude of that input
    expect(slow).toBeLessThan(ground * 0.01);
  });

  it('taller / more flexible structures respond differently from short stiff ones', () => {
    const f = 2; // input near the stiff building's frequency
    const short = harmonicPeak(unit({ period: 0.5, height: 6 }), f).peak;
    const tall = harmonicPeak(unit({ ndof: 5, period: 2.5, height: 60 }), f).peak;
    expect(short).not.toBeCloseTo(tall, 3);
    // The tall one is far from resonance at 2 Hz: much smaller drift.
    const mShort = harmonicPeak(unit({ period: 0.5, height: 6 }), f).model;
    const mTall = harmonicPeak(unit({ ndof: 5, period: 2.5, height: 60 }), f).model;
    expect(mTall.peakDrift[0]).toBeLessThan(mShort.peakDrift[0]);
  });

  it('elastic below yield, accumulates damage beyond it (damage threshold)', () => {
    const base = unit({ period: 0.5, cyX: 0.2, cyZ: 0.2, driftU: 0.03 });
    const small = harmonicPeak(base, 2, 0.01 * GRAVITY).model; // resonant response ≈ 0.1 g < Cy = 0.2
    expect(small.cum[small.off[0] + 1]).toBe(0);
    expect(small.damage[0]).toBeLessThan(0.1);
    const big = harmonicPeak(base, 2, 0.6 * GRAVITY).model;
    expect(big.cum[big.off[0] + 1]).toBeGreaterThan(0);
    expect(big.damage[0]).toBeGreaterThan(small.damage[0] * 5);
  });

  it('yield strength limits the base force (bilinear hysteresis)', () => {
    const strong = harmonicPeak(unit({ period: 0.5, cyX: 5 }), 2, 0.5 * GRAVITY).model;
    const weak = harmonicPeak(unit({ period: 0.5, cyX: 0.1 }), 2, 0.5 * GRAVITY).model;
    expect(weak.baseShear[0]).toBeLessThan(strong.baseShear[0]);
  });

  it('the result is independent of which other units share the model (SoA, deterministic)', () => {
    const a = new StructuralModel();
    a.add(unit({ period: 0.7 }));
    a.finalize();
    const b = new StructuralModel();
    b.add(unit({ ndof: 4, period: 1.2 }));
    b.add(unit({ period: 0.7 }));
    b.finalize();
    for (let i = 0; i < 600; i++) {
      const g = 3 * Math.sin(i * 0.2);
      a.agx[0] = g; b.agx[0] = g; b.agx[1] = g;
      a.step(DT);
      b.step(DT);
    }
    expect(b.top[2]).toBe(a.top[0]);
  });
});

describe('foundation response', () => {
  const foundation = (stiffness: number, slip = 1e12) => ({ mass: 3e4, stiffness, dampingRatio: 0.1, slipX: slip, slipZ: slip });

  it('a compliant (soft-soil) foundation lengthens the period and moves itself', () => {
    const rigid = unit({ period: 0.4, foundation: foundation(1e11) });
    const soft = unit({ period: 0.4, foundation: foundation(1.5e8) });
    const fr = 1 / 0.4;
    // Response at the fixed-base frequency drops when the foundation is soft (period shift).
    const pr = harmonicPeak(rigid, fr).model;
    const ps = harmonicPeak(soft, fr).model;
    expect(Math.abs(ps.base[0])).toBeGreaterThan(Math.abs(pr.base[0]));
    expect(ps.peakDrift[0]).toBeLessThan(pr.peakDrift[0]);
  });

  it('weak anchorage lets the foundation slip (residual offset)', () => {
    const m = harmonicPeak(unit({ period: 0.4, foundation: foundation(1e9, 0.05 * 1.3e5 * GRAVITY) }), 2.5, 0.5 * GRAVITY).model;
    expect(Math.abs(m.fP[0])).toBeGreaterThan(1e-4);
    const anchored = harmonicPeak(unit({ period: 0.4, foundation: foundation(1e9) }), 2.5, 0.5 * GRAVITY).model;
    expect(anchored.fP[0]).toBe(0);
  });

  it('after a partial collapse the wind and a lateral field load only the stories that still exist (static equilibrium)', () => {
    // 3 floors of 1e5 kg, the top one removed (truncateFrom 3). At rest under a constant load the base shear is the
    // applied resultant: the wind force W, or Σ m_j·g_h over the two remaining floors — and the removed floor stays
    // with the floor below (its placeholder mass took the whole wind force as an unbounded acceleration before).
    const settle = (load: (m: StructuralModel) => void) => {
      const m = new StructuralModel();
      m.add(unit({ ndof: 3, mass: 3e5, height: 9.6, period: 0.6 }));
      m.finalize();
      m.truncateFrom(0, 3, GRAVITY);
      load(m);
      for (let i = 0; i < 60 / DT; i++) m.stepUnit(0, DT);
      return m;
    };
    const W = 5e4;
    const wind = settle((m) => { m.fwx[0] = W; });
    expect(wind.baseShear[0]).toBeCloseTo(W, -1);
    expect(Math.abs(wind.u[6] - wind.u[4])).toBeLessThan(1e-3);
    const gh = 2;
    const field = settle((m) => { m.hasG[0] = 1; for (let j = 0; j <= 3; j++) m.gfx[2 * j] = gh; });
    expect(field.baseShear[0]).toBeCloseTo(2 * 1e5 * gh, -1);
    expect(Math.abs(field.u[6] - field.u[4])).toBeLessThan(1e-3);
  });
});
