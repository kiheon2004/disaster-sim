/**
 * Phase 33: independent checks of the pure human model. Expected values come from closed forms (rigid-body impulse,
 * linear-inverted-pendulum capture condition, Plummer field), numerical integration (Monte Carlo inertia, direct field
 * differences) or the published table itself — never from the functions under test.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { bodyModel, MASS_FRACTION, segmentShares, validateBody } from './anthropometry';
import { edgeDistance, newBalance, stepBalance, type BalanceParams } from './balance';
import { applyEpisode, capability, levelOf, newRisk, pointDeltaV } from './injury';
import { classifyPosture, lyingSide } from './posture';
import { tidalLoad } from './tidal';

const H = 1.75, M = 70, G = 9.80665, DT = 1 / 60;

describe('anthropometry', () => {
  it('mass fractions of the table sum to 1 and the segments carry exactly the body mass', () => {
    const f = MASS_FRACTION;
    expect(f.headNeck + f.thoraxAbdomen + f.pelvis + 2 * f.arm + 2 * f.leg).toBeCloseTo(1, 12);
    const b = bodyModel(H, M);
    expect(b.segments.reduce((a, s) => a + s.mass, 0)).toBeCloseTo(M, 10);
    expect(b.segments.map((s) => s.id).sort()).toEqual(['head', 'leftArm', 'leftLeg', 'neck', 'pelvis', 'rightArm', 'rightLeg', 'torso']);
  });

  it('COM height from the table by hand (mid-heights × fractions), and inside the commonly quoted 53–58 % of stature', () => {
    // Head + neck as one block (0.818–1.0 H) differs from the split model only by the split; do the split by hand: neck/head
    // volume ratio ¼·(0.870−0.818)/(1−0.870) = 0.1, so head 0.081/1.1 at 0.935 H, neck 0.081·0.1/1.1 at 0.844 H.
    const yc = (0.081 / 1.1) * 0.935 + ((0.081 * 0.1) / 1.1) * 0.844 + 0.355 * 0.709 + 0.142 * 0.565 + 2 * 0.05 * ((0.377 + 0.818) / 2) + 2 * 0.161 * 0.265;
    const b = bodyModel(H, M);
    expect(b.com[1] / H).toBeCloseTo(yc, 10);
    expect(yc).toBeGreaterThan(0.53);
    expect(yc).toBeLessThan(0.58);
    expect(b.com[0]).toBeCloseTo(0, 12);
  });

  it('inertia about the COM matches a Monte Carlo integration over the segment cylinders (independent of the closed forms)', () => {
    const b = bodyModel(H, M);
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const I: Vec3 = [0, 0, 0];
    const N = 40000;
    for (const g of b.segments) {
      const dm = g.mass / N;
      for (let k = 0; k < N; k++) {
        const r = g.radius * Math.sqrt(rnd()), a = 2 * Math.PI * rnd();
        const x = g.x + r * Math.cos(a) - b.com[0], z = r * Math.sin(a) - b.com[2], y = g.y0 + (g.y1 - g.y0) * rnd() - b.com[1];
        I[0] += dm * (y * y + z * z);
        I[1] += dm * (x * x + z * z);
        I[2] += dm * (x * x + y * y);
      }
    }
    for (let k = 0; k < 3; k++) expect(Math.abs(b.inertia[k] - I[k]) / I[k]).toBeLessThan(0.01);
  });

  it('rejects impossible bodies and warns about implausible proportions', () => {
    expect(validateBody(0.5, 70).ok).toBe(false);
    expect(validateBody(1.75, 5).ok).toBe(false);
    expect(validateBody(NaN, 70).ok).toBe(false);
    expect(validateBody(1.75, 70)).toMatchObject({ ok: true });
    expect(validateBody(1.75, 70).warning).toBeUndefined();
    expect(validateBody(1.6, 200).warning).toBe('bmi');
    expect(() => bodyModel(3, 70)).toThrow();
  });

  it('contact points map to segments: sole between the feet → ½ each leg; crown → head; side at hip height (+x) → left leg; far away → unknown', () => {
    const b = bodyModel(H, M);
    expect(segmentShares(b, [0, 0, 0]).map((s) => [s.id, s.share])).toEqual([['leftLeg', 0.5], ['rightLeg', 0.5]]);
    expect(segmentShares(b, [0, H, 0])).toEqual([{ id: 'head', share: 1 }]);
    expect(segmentShares(b, [0.22, 0.4, 0])[0].id).toBe('leftLeg');
    expect(segmentShares(b, [-0.3, 1.2, 0])[0].id).toBe('rightArm');
    expect(segmentShares(b, [2, 1, 0])).toEqual([]);
  });
});

describe('balance (inverted pendulum, bounded ankle moment)', () => {
  const b = bodyModel(H, M);
  const hc = b.com[1];
  const p: BalanceParams = { mass: M, hc, Ia: b.inertia[0] + M * hc * hc, forward: b.support.forward, lateral: b.support.lateral };
  const W = M * G;
  const run = (load: (t: number) => number, seconds: number, dir: [number, number] = [0, 1], th0: [number, number] = [0, 0], om0: [number, number] = [0, 0]) => {
    const s = newBalance();
    s.th = [...th0];
    s.om = [...om0];
    for (let k = 0; k < seconds / DT; k++) {
      const T = load(k * DT);
      if (stepBalance(p, s, { gn: G, t1: T * dir[0], t2: T * dir[1], f1: 0, f2: 1 }, DT) === 'fall') return { fell: true, t: k * DT, s };
    }
    return { fell: false, t: seconds, s };
  };

  it('unloaded: stays standing, lean returns to zero', () => {
    const r = run(() => 0, 5, [0, 1], [0.03, 0.02]);
    expect(r.fell).toBe(false);
    expect(Math.hypot(...r.s.th)).toBeLessThan(1e-3);
  });

  it('slowly applied load: the steady limit is the full lean against it, T ≈ W·(0.9 e + e) (COM near one foot edge, pressure at the other)', () => {
    const e = b.support.forward;
    const lim = W * (0.9 * e + e);
    expect(run((t) => Math.min(t / 4, 1) * 0.97 * lim, 10).fell).toBe(false);
    expect(run((t) => Math.min(t / 4, 1) * 1.03 * lim, 10).fell).toBe(true);
  });

  it('a load applied at once is resisted only up to about the centred capacity W·e (no time to lean)', () => {
    const e = b.support.forward;
    expect(run(() => 0.8 * W * e, 5).fell).toBe(false);
    expect(run(() => 1.9 * W * e, 5).fell).toBe(true);
  });

  it('push recovery follows the capture condition of the inverted pendulum: x + v/ω₀ inside the support ⇔ recoverable', () => {
    const e = b.support.forward;
    const w0 = Math.sqrt((G * M * hc) / p.Ia);
    // An initial lean rate θ̇₀ (θ₀ = 0): capture point h·θ̇₀/ω₀ — recoverable below the edge, a fall above.
    const om = (k: number) => (k * e) / hc * w0;
    expect(run(() => 0, 5, [0, 1], [0, 0], [0, om(0.9)]).fell).toBe(false);
    expect(run(() => 0, 5, [0, 1], [0, 0], [0, om(1.1)]).fell).toBe(true);
  });

  it('the support rectangle follows the facing: edge distance along / across it, and a push across a wider support is resisted', () => {
    expect(edgeDistance(p, 0, 1, 0, 1)).toBeCloseTo(b.support.forward, 12);
    expect(edgeDistance(p, 1, 0, 0, 1)).toBeCloseTo(b.support.lateral, 12);
    // Rotated facing (along e1): the forward half length now lies along e1.
    expect(edgeDistance(p, 1, 0, 1, 0)).toBeCloseTo(b.support.forward, 12);
    // Diagonal of a rectangle: the edge is reached on the side with the larger u/half-extent.
    const q = { ...p, forward: 0.1, lateral: 0.2 };
    expect(edgeDistance(q, Math.SQRT1_2, Math.SQRT1_2, 0, 1)).toBeCloseTo(0.1 * Math.SQRT2, 12);
    const s = newBalance(), s2 = newBalance();
    const T = 1.4 * W * 0.1;
    let fwd = false, side = false;
    for (let k = 0; k < 180; k++) {
      fwd ||= stepBalance(q, s, { gn: G, t1: 0, t2: T, f1: 0, f2: 1 }, DT) === 'fall';
      side ||= stepBalance(q, s2, { gn: G, t1: T, t2: 0, f1: 0, f2: 1 }, DT) === 'fall';
    }
    expect(fwd).toBe(true);
    expect(side).toBe(false);
  });

  it('tilted gravity: standing holds while tan φ is well inside the leaning limit, falls beyond it', () => {
    // Tangential gravity g sin φ acts as T = m h_c g_t with g_n = g cos φ.
    const at = (deg: number) => {
      const s = newBalance();
      const gn = G * Math.cos((deg * Math.PI) / 180), gt = G * Math.sin((deg * Math.PI) / 180);
      for (let k = 0; k < 600; k++) if (stepBalance(p, s, { gn, t1: 0, t2: M * hc * gt * Math.min(1, k / 120), f1: 0, f2: 1 }, DT) === 'fall') return true;
      return false;
    };
    const limDeg = (Math.atan((1.9 * b.support.forward) / hc) * 180) / Math.PI;
    expect(at(0.8 * limDeg)).toBe(false);
    expect(at(1.2 * limDeg)).toBe(true);
  });
});

describe('impact and injury index', () => {
  it('impulse at the end of a free rod moves that end by 4 J/m (J/m + J r²/I with I = mL²/12, r = L/2)', () => {
    const m = 10, L = 2, I = (m * L * L) / 12;
    const dv = pointDeltaV([0, 0, 3], m, [L / 2, 0, 0], (v) => [v[0] / I, v[1] / I, v[2] / I]);
    expect(dv[2]).toBeCloseTo((4 * 3) / m, 12);
  });

  it('levels rise with the cumulative index; equal episodes add like energies (√2)', () => {
    expect(levelOf(0)).toBe('none');
    expect(levelOf(0.45)).toBe('minor');
    expect(levelOf(2)).toBe('incapacitating');
    const r = newRisk();
    applyEpisode(r, [{ id: 'leftLeg', dv: 0.5 * 10 }]);
    applyEpisode(r, [{ id: 'leftLeg', dv: 0.5 * 10 }]);
    expect(r.leftLeg.cum).toBeCloseTo(0.5 * Math.SQRT2, 12);
    expect(r.leftLeg.peak).toBeCloseTo(0.5, 12);
    expect(r.leftLeg.hits).toBe(2);
    expect(r.head.hits).toBe(0);
  });

  it('the same velocity change weighs more on the head than on a leg; head severe → incapacitated, both legs severe → immobile only', () => {
    const r = newRisk();
    applyEpisode(r, [{ id: 'head', dv: 6.5 }, { id: 'leftLeg', dv: 6.5 }]);
    expect(r.head.cum).toBeGreaterThan(r.leftLeg.cum);
    expect(r.head.level).toBe('severe');
    expect(capability(r).incapacitated).toBe(true);
    const q = newRisk();
    applyEpisode(q, [{ id: 'rightLeg', dv: 11 }, { id: 'leftLeg', dv: 11 }]);
    expect(capability(q)).toEqual({ incapacitated: false, mobility: 'immobile' });
    const w = newRisk();
    applyEpisode(w, [{ id: 'leftLeg', dv: 7 }]);
    expect(capability(w)).toEqual({ incapacitated: false, mobility: 'impaired' });
  });
});

describe('posture from the body state', () => {
  const up: Vec3 = [0, 1, 0];
  const base = { standing: false, lean: 0, axis: [0, 1, 0] as Vec3, facing: [0, 0, 1] as Vec3, up, speed: 0, spin: 0, freeSteps: 0, stillFor: 0, sinceLanding: Infinity, incapacitated: false };
  it('reads lying sides and motion', () => {
    expect(classifyPosture({ ...base, standing: true })).toBe('upright');
    expect(classifyPosture({ ...base, standing: true, lean: 0.1 })).toBe('leaning');
    expect(classifyPosture({ ...base, freeSteps: 10 })).toBe('airborne');
    expect(classifyPosture({ ...base, axis: [1, 0, 0], facing: [0, 1, 0] })).toBe('supine');
    expect(classifyPosture({ ...base, axis: [1, 0, 0], facing: [0, -1, 0] })).toBe('prone');
    expect(classifyPosture({ ...base, axis: [1, 0, 0], facing: [0, 0, 1] })).toBe('sideLying');
    expect(classifyPosture({ ...base, axis: [1, 0, 0], facing: [0, 1, 0], speed: 1 })).toBe('sliding');
    expect(classifyPosture({ ...base, spin: 5 })).toBe('tumbling');
    expect(classifyPosture({ ...base, axis: [1, 0, 0], facing: [0, 1, 0], stillFor: 2 })).toBe('resting');
    expect(classifyPosture({ ...base, axis: [1, 0, 0], facing: [0, 1, 0], stillFor: 2, incapacitated: true })).toBe('incapacitated');
    expect(classifyPosture({ ...base, axis: [0.6, 0.8, 0], spin: 1 })).toBe('falling');
    // Gravity reversed: "up" is −y, a body lying with its face to −y faces up.
    expect(lyingSide([0, -1, 0], [0, -1, 0])).toBe('supine');
  });
});

describe('tidal load', () => {
  const b = bodyModel(H, M);
  it('uniform field: no gradient, no load', () => {
    expect(tidalLoad(b, new Float64Array(9), [0, 1, 0], [1, 0, 0]).force).toBe(0);
  });

  it('point source along the body axis: the linear load matches direct differences of the exact Plummer field far away, and stretches', () => {
    const mu = 1e7, eps = 1, R = 60;
    const g = (p: Vec3): Vec3 => {
      const d2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + eps * eps, k = -mu / d2 ** 1.5;
      return [k * p[0], k * p[1], k * p[2]];
    };
    // Body standing on the axis above the source, COM at height R; gradient by central differences of g (independent of
    // the library's analytic tensor).
    const c: Vec3 = [0, R, 0];
    const h = 1e-3, T = new Float64Array(9);
    for (let j = 0; j < 3; j++) {
      const a = [...c] as Vec3, z = [...c] as Vec3;
      a[j] += h;
      z[j] -= h;
      const ga = g(a), gz = g(z);
      for (let i = 0; i < 3; i++) T[i * 3 + j] = (ga[i] - gz[i]) / (2 * h);
    }
    const L = tidalLoad(b, T, [0, 1, 0], [1, 0, 0]);
    // Direct: internal force at the cut = Σ_above m_i (g(r_i) − g(r_c))·ŷ, the largest |·| over the three cuts.
    let direct = 0;
    for (const yc of [b.segments[1].y0, b.segments[2].y0, b.segments[3].y0]) {
      let N = 0;
      const gc = g([0, R, 0]);
      for (const s of b.segments) if (s.centre[1] > yc) N += s.mass * (g([s.centre[0] - b.com[0], R + s.centre[1] - b.com[1], 0])[1] - gc[1]);
      if (Math.abs(N) > Math.abs(direct)) direct = N;
    }
    expect(Math.abs(L.force - Math.abs(direct)) / Math.abs(direct)).toBeLessThan(0.02);
    expect(L.sign).toBe(1);
    expect(L.axial).toBeGreaterThan(0);
  });
});
