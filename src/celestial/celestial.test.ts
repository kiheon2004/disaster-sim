/**
 * Phase 32 — celestial point sources, orbit integrator and tidal mechanics against INDEPENDENT references: hand values
 * of Newton's law, finite differences of the potential / field, the Poisson trace of the gradient tensor, closed-form
 * Kepler motion (Kepler's equation), vis-viva periapsis / apoapsis, the Rutherford deflection angle of a hyperbolic
 * flyby, the radial free-fall (cycloid) time, and the order-of-accuracy of the scheme (error ∝ h²). No expected value is
 * produced by the code under test.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { G_N, C_LIGHT, schwarzschildRadius, muOf, massOf, M_SUN } from './constants';
import { PointField } from './point';
import { kdk, newKdkResult, substepCount, type StepField } from './integrator';
import { circularSpeed, escapeSpeed, elements, launchVelocity } from './orbit';
import { symEigenvalues, symEigenvector, barTension, boxSecondMoment, gradientTorque, stretchAlong } from './tidal';
import { celestialIssues, defaultCelestialSpec, defaultSource, sourceRegime, massForAccel, type CelestialSourceSpec, type CelestialSpec } from './types';

const src = (p: Partial<CelestialSourceSpec> = {}): CelestialSourceSpec => ({ ...defaultSource(), center: [0, 0, 0], ramp: 0, ...p });
const spec = (sources: CelestialSourceSpec[], p: Partial<CelestialSpec> = {}): CelestialSpec => ({ ...defaultCelestialSpec(), sources, ...p });
const fieldOf = (sources: CelestialSourceSpec[], t = 1) => {
  const f = new PointField();
  f.add(spec(sources), 0, 0);
  return f.prepare(t);
};
const g = (f: PointField, x: number, y: number, z: number): Vec3 => f.addSample(x, y, z, [0, 0, 0]);
/** A StepField of point sources only (zero uniform part). */
const stepField = (f: PointField): StepField => ({
  accel: (x, y, z, out) => { out[0] = 0; out[1] = 0; out[2] = 0; return f.addSample(x, y, z, out); },
  segmentTimescale: (x, y, z, vx, vy, vz, dt) => f.segmentTimescale(x, y, z, vx, vy, vz, dt),
  captureAt: (x, y, z) => f.captureAt(x, y, z),
});
const MU = 5e4;
const M = MU / G_N;

describe('constants', () => {
  it('μ = G·M both ways, Schwarzschild radius of the Sun ≈ 2953 m', () => {
    expect(muOf(massOf(123.4))).toBeCloseTo(123.4, 9);
    expect(G_N).toBe(6.6743e-11);
    expect(C_LIGHT).toBe(299792458);
    // 2·1.32712e20 / c² = 2953.3 m (IAU GM☉).
    expect(schwarzschildRadius(M_SUN)).toBeGreaterThan(2952);
    expect(schwarzschildRadius(M_SUN)).toBeLessThan(2955);
  });
});

describe('point-source field', () => {
  it('unsoftened: |g| = μ/r², directed to the centre (hand values)', () => {
    const f = fieldOf([src({ mass: M, softening: 0.05, kind: 'compact', capture: 0 })]);
    const a = g(f, 30, 0, 40); // r = 50
    const mag = Math.hypot(...a);
    // ε = 0.05 m changes μ/r² by (1 + ε²/r²)^{-3/2} ≈ 1 − 1.5·10⁻⁶.
    expect(mag / (MU / 2500)).toBeCloseTo(1, 5);
    expect(a[0] / mag).toBeCloseTo(-0.6, 9);
    expect(a[2] / mag).toBeCloseTo(-0.8, 9);
    expect(a[1]).toBeCloseTo(0, 15);
  });
  it('Plummer: |g(ε)| = μ/(2^{3/2}·ε²), peak at ε/√2, finite and 0 at the centre', () => {
    const eps = 2;
    const f = fieldOf([src({ mass: M, softening: eps })]);
    expect(Math.hypot(...g(f, eps, 0, 0))).toBeCloseTo(MU / (2 ** 1.5 * eps * eps), 8);
    const c = g(f, 0, 0, 0);
    expect(c.every((v) => v === 0)).toBe(true);
    let best = 0, rb = 0;
    for (let r = 0.01; r < 6; r += 0.001) { const m = Math.hypot(...g(f, r, 0, 0)); if (m > best) { best = m; rb = r; } }
    expect(rb).toBeCloseTo(eps / Math.SQRT2, 2);
    expect(best).toBeCloseTo((MU * 2) / (3 * Math.sqrt(3) * eps * eps), 3);
  });
  it('g = −∇Φ (central differences of the potential), untapered and tapered', () => {
    for (const influence of [0, 120]) {
      const f = fieldOf([src({ mass: M, softening: 1.5, influence })]);
      for (const p of [[3, 1, -2], [40, 5, 10], [99, 0, 10], [110, 2, 1]] as Vec3[]) {
        const h = 1e-4, a = g(f, ...p);
        for (let j = 0; j < 3; j++) {
          const pp = [...p] as Vec3, pm = [...p] as Vec3;
          pp[j] += h; pm[j] -= h;
          const d = -(f.potential(...pp) - f.potential(...pm)) / (2 * h);
          expect(Math.abs(d - a[j])).toBeLessThan(1e-5 * Math.max(1, Math.hypot(...a)));
        }
      }
      // Φ → 0 at the cut (tapered) / ∞; continuous across the taper start.
      if (influence) {
        expect(f.potential(influence + 1, 0, 0)).toBe(0);
        const r = 0.8 * influence;
        // Closed form inside, Simpson on the taper: no jump at the seam (the difference over ±δ is the slope |g|·2δ).
        const dl = 1e-6, jump = f.potential(r + dl, 0, 0) - f.potential(r - dl, 0, 0) - Math.hypot(...g(f, r, 0, 0)) * 2 * dl;
        expect(Math.abs(jump)).toBeLessThan(1e-9 * Math.abs(f.potential(r, 0, 0)));
      }
    }
  });
  it('gradient tensor: matches central differences of g, Poisson trace −3με²/q^{5/2}, eigenvalues 2μ/r³ and −μ/r³', () => {
    const eps = 1.2;
    const f = fieldOf([src({ mass: M, softening: eps, influence: 150 })]);
    for (const p of [[5, 2, -3], [30, -4, 12], [125, 3, 3]] as Vec3[]) {
      const T = f.addGradient(...p, new Float64Array(9));
      const h = 1e-4;
      for (let j = 0; j < 3; j++) {
        const pp = [...p] as Vec3, pm = [...p] as Vec3;
        pp[j] += h; pm[j] -= h;
        const a = g(f, ...pp), b = g(f, ...pm);
        for (let i = 0; i < 3; i++) expect(Math.abs((a[i] - b[i]) / (2 * h) - T[3 * i + j])).toBeLessThan(1e-6 * (Math.abs(T[3 * i + j]) + 1e-3));
      }
      const r2 = p[0] ** 2 + p[1] ** 2 + p[2] ** 2;
      if (Math.sqrt(r2) < 120) expect(T[0] + T[4] + T[8]).toBeCloseTo((-3 * MU * eps * eps) / (r2 + eps * eps) ** 2.5, 9);
    }
    const f0 = fieldOf([src({ mass: M, softening: 0.05 })]);
    const T0 = f0.addGradient(0, 0, 60, new Float64Array(9));
    const [l1, l2, l3] = symEigenvalues(T0);
    expect(l1 / ((2 * MU) / 60 ** 3)).toBeCloseTo(1, 5);
    expect(l2 / (-MU / 60 ** 3)).toBeCloseTo(1, 5);
    expect(l3 / (-MU / 60 ** 3)).toBeCloseTo(1, 5);
    const n = symEigenvector(T0, l1);
    expect(Math.abs(n[2])).toBeCloseTo(1, 9); // stretch along the radius
  });
  it('several sources: superposition, and the same sum whatever order they were added in', () => {
    const a = src({ center: [10, 0, 0], mass: M }), b = src({ center: [-20, 5, 3], mass: 2 * M, softening: 1 }), c = src({ center: [0, 30, -9], mass: 0.3 * M, softening: 3 });
    const f1 = new PointField(), f2 = new PointField();
    f1.add(spec([a, b, c]), 0, 0); f1.prepare(1);
    f2.add(spec([c, a, b]), 0, 0); f2.prepare(1);
    const fa = fieldOf([a]), fb = fieldOf([b]), fc = fieldOf([c]);
    for (const p of [[1, 2, 3], [-7, 11, 0.5]] as Vec3[]) {
      const s1 = g(f1, ...p), s2 = g(f2, ...p);
      expect(s1).toEqual(s2); // bitwise: canonical order
      const sum = [0, 1, 2].map((i) => g(fa, ...p)[i] + g(fb, ...p)[i] + g(fc, ...p)[i]);
      for (let i = 0; i < 3; i++) expect(s1[i]).toBeCloseTo(sum[i], 12);
      expect(f1.potential(...p)).toBe(f2.potential(...p));
    }
  });
  it('prescribed motion, window and ramp', () => {
    const f = new PointField();
    f.add(spec([src({ motion: 'velocity', velocity: [2, 0, 0], start: 5, end: 20, ramp: 4 })], { duration: 30 }), 10, 0);
    expect(f.prepare(14).live.length).toBe(0); // before the source's start (10 + 5)
    f.prepare(17);
    expect(f.live[0].x).toBeCloseTo(4, 12); // 2 s after its start
    expect(f.live[0].mu).toBeCloseTo(MU * 0.5, 9); // smootherstep(0.5)
    expect(f.prepare(29).live[0].mu).toBeCloseTo(MU, 9);
    expect(f.prepare(30).live.length).toBe(0); // restore: off at 10 + 20
    const p = new PointField();
    p.add(spec([src({ motion: 'path', path: [[0, 0, 10, 0], [10, 20, 10, 0], [20, 20, 10, 20]] })]), 0, 0);
    p.prepare(5);
    expect([p.live[0].x, p.live[0].z, p.live[0].vx]).toEqual([10, 0, 2]);
    p.prepare(25);
    expect([p.live[0].x, p.live[0].z, p.live[0].vz]).toEqual([20, 20, 0]);
  });
  it('growth: μ follows the captured mass', () => {
    const f = fieldOf([src({ mass: M, massPolicy: 'grow' })]);
    f.grow(0, 0, M);
    expect(f.live[0].mu).toBeCloseTo(2 * MU, 9);
    expect(f.massOf(0, 0)).toBeCloseTo(2 * M, 3);
  });
});

/** Kepler position at time t for an orbit starting at periapsis rp on +x moving +z (closed form, independent). */
function keplerAt(mu: number, rp: number, e: number, t: number): Vec3 {
  const a = rp / (1 - e), n = Math.sqrt(mu / a ** 3);
  const Mm = n * t;
  let E = Mm;
  for (let k = 0; k < 60; k++) E -= (E - e * Math.sin(E) - Mm) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e), z = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return [x, 0, z];
}

describe('KDK orbit integrator', () => {
  const unsoft = () => fieldOf([src({ mass: M, softening: 0.05, kind: 'compact', capture: 0 })]);
  const run = (f: PointField, x: Vec3, v: Vec3, T: number, dt = 1 / 60, cb?: (t: number, x: Vec3, v: Vec3) => void) => {
    const sf = stepField(f), res = newKdkResult();
    let t = 0;
    while (t < T - 1e-12) { kdk(sf, x, v, dt, res); t += dt; cb?.(t, x, v); }
    return res;
  };
  it('substeps: powers of two, pure function of τ', () => {
    expect(substepCount(Infinity, 1 / 60)).toBe(1);
    expect(substepCount(1, 1 / 60)).toBe(1);
    expect(substepCount(0.01, 1 / 60, 0.05)).toBe(64); // (1/60)/(0.05·0.01) = 33.3 → 64
    expect(substepCount(1 / 60 / 0.05 / 32, 1 / 60, 0.05)).toBe(32);
  });
  it('circular orbit: radius, period (2π√(r³/μ)), energy and angular momentum over 20 orbits', () => {
    const f = unsoft(), r = 40, vc = Math.sqrt(MU / r);
    const x: Vec3 = [r, 0, 0], v: Vec3 = [0, 0, vc];
    const P = 2 * Math.PI * Math.sqrt(r ** 3 / MU);
    const E0 = 0.5 * vc * vc - MU / r, L0 = r * vc;
    let rMin = Infinity, rMax = 0, dE = 0, dL = 0, prevZ = 0, crossings: number[] = [];
    run(f, x, v, 20 * P, 1 / 60, (t, x, v) => {
      const rr = Math.hypot(...x);
      rMin = Math.min(rMin, rr); rMax = Math.max(rMax, rr);
      dE = Math.max(dE, Math.abs((0.5 * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) - MU / Math.sqrt(rr * rr + 0.0025) - E0) / E0));
      dL = Math.max(dL, Math.abs((x[0] * v[2] - x[2] * v[0] - L0) / L0));
      if (prevZ < 0 && x[2] >= 0 && x[0] > 0) crossings.push(t);
      prevZ = x[2];
    });
    expect((rMax - rMin) / r).toBeLessThan(3e-4); // (h·ω)² = 2·10⁻⁴ at one substep per 1/60 s
    expect(dE).toBeLessThan(2e-4); // one substep (h/τ = 0.015): bounded oscillation of order (h/τ)²
    expect(dL).toBeLessThan(1e-10); // central field: KDK conserves L to rounding
    const Pm = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
    expect(Math.abs(Pm - P) / P).toBeLessThan(2e-3); // crossings resolved to one step (1/60 s of 2π·35.8 s… )
  });
  it('elliptic orbit: vis-viva periapsis / apoapsis and Kepler-equation phase after 5 orbits', () => {
    const f = unsoft();
    const rp = 20, e = 0.6, a = rp / (1 - e);
    const vp = Math.sqrt((MU * (1 + e)) / rp);
    const x: Vec3 = [rp, 0, 0], v: Vec3 = [0, 0, vp];
    const P = 2 * Math.PI * Math.sqrt(a ** 3 / MU);
    let rMin = Infinity, rMax = 0, t = 0;
    const T = 5 * P;
    const sf = stepField(f), res = newKdkResult();
    const dt = 1 / 60;
    while (t < T - dt / 2) { kdk(sf, x, v, dt, res); t += dt; const rr = Math.hypot(...x); rMin = Math.min(rMin, rr); rMax = Math.max(rMax, rr); }
    expect(Math.abs(rMin - rp) / rp).toBeLessThan(2e-3);
    expect(Math.abs(rMax - a * (1 + e)) / (a * (1 + e))).toBeLessThan(2e-3);
    const ref = keplerAt(MU, rp, e, t);
    // Phase error after 5 orbits: position within 1 % of the orbit size.
    expect(Math.hypot(x[0] - ref[0], x[2] - ref[2]) / a).toBeLessThan(1e-2);
  });
  it('second order: halving dt quarters the energy error of an eccentric orbit', () => {
    const errAt = (dt: number) => {
      const f = unsoft();
      const rp = 25, e = 0.5, vp = Math.sqrt((MU * (1 + e)) / rp);
      const x: Vec3 = [rp, 0, 0], v: Vec3 = [0, 0, vp];
      const E0 = 0.5 * vp * vp - MU / Math.sqrt(rp * rp + 0.0025);
      const sf = stepField(f), res = newKdkResult();
      let worst = 0;
      // Fixed substeps (η huge) so dt alone sets the step.
      for (let t = 0; t < 10; t += dt) {
        kdk(sf, x, v, dt, res, 256, 1e9);
        const rr = Math.hypot(...x);
        worst = Math.max(worst, Math.abs(0.5 * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) - MU / Math.sqrt(rr * rr + 0.0025) - E0));
      }
      return worst;
    };
    const e1 = errAt(1 / 60), e2 = errAt(1 / 120), e3 = errAt(1 / 240);
    expect(e1 / e2).toBeGreaterThan(3.3);
    expect(e1 / e2).toBeLessThan(4.8);
    expect(e2 / e3).toBeGreaterThan(3.3);
    expect(e2 / e3).toBeLessThan(4.8);
  });
  it('escape speed separates bound and unbound: 0.98·v_e returns, 1.02·v_e leaves', () => {
    for (const k of [0.98, 1.02]) {
      const f = unsoft();
      const r0 = 20, ve = escapeSpeed(MU, r0, 0.05);
      const x: Vec3 = [r0, 0, 0], v: Vec3 = [k * ve, 0, 0];
      let rMax = 0;
      // 80 s: past the bound orbit's apoapsis (≈ 55 s), before it falls back through the (unresolved) point core.
      run(f, x, v, 80, 1 / 60, (_t, x) => { rMax = Math.max(rMax, Math.hypot(...x)); });
      // Bound: apoapsis of the radial orbit r_max = r0/(1 − k²) = 505 m; unbound: still receding.
      if (k < 1) { expect(Math.abs(rMax / 505.05 - 1)).toBeLessThan(5e-3); expect(Math.hypot(...x)).toBeLessThan(rMax); }
      else expect(Math.hypot(...x)).toBeGreaterThan(900);
    }
  });
  it('hyperbolic flyby: Rutherford deflection 2·asin(1/e), e = √(1 + b²v∞⁴/μ²)', () => {
    const f = unsoft();
    const b = 30, vinf = 40;
    const x: Vec3 = [-30000, 0, b], v: Vec3 = [vinf, 0, 0];
    // Energy of the start point is not exactly ½v∞² — use the true start energy for the reference.
    const E = 0.5 * vinf * vinf - MU / Math.hypot(x[0], x[2]);
    const h = b * vinf;
    const e = Math.sqrt(1 + (2 * E * h * h) / (MU * MU));
    const delta = 2 * Math.asin(1 / e);
    run(f, x, v, 1500, 1 / 60);
    const out = Math.atan2(v[2], v[0]);
    // Deflected towards the source (−z side), angle measured from +x.
    expect(Math.abs(-out - delta)).toBeLessThan(3e-3);
    expect(elements(MU, x, v).kind).toBe('hyperbolic');
  });
  it('radial infall: capture time equals the closed-form free-fall time (cycloid)', () => {
    const r0 = 60, rc = 2;
    const f = fieldOf([src({ mass: M, softening: 0.05, capture: rc })]);
    const x: Vec3 = [r0, 0, 0], v: Vec3 = [0, 0, 0];
    const sf = stepField(f), res = newKdkResult();
    let t = 0;
    for (let k = 0; k < 100000; k++) { kdk(sf, x, v, 1 / 60, res); if (res.captured >= 0) { t += res.at / 60; break; } t += 1 / 60; }
    const xr = rc / r0;
    const tRef = Math.sqrt(r0 ** 3 / (2 * MU)) * (Math.sqrt(xr * (1 - xr)) + Math.acos(Math.sqrt(xr)));
    expect(res.captured).toBe(0);
    expect(Math.abs(t - tRef)).toBeLessThan(2e-3); // within the substep the crossing was detected in
    expect(Math.hypot(...x)).toBeLessThanOrEqual(rc);
  });
  it('the same state takes the same subdivision and result (determinism)', () => {
    const f = unsoft();
    const a: Vec3 = [15, 1, 2], va: Vec3 = [0, 3, 50];
    const b: Vec3 = [15, 1, 2], vb: Vec3 = [0, 3, 50];
    const r1 = run(f, a, va, 3), r2 = run(f, b, vb, 3);
    expect(a).toEqual(b);
    expect(va).toEqual(vb);
    expect(r1.n).toBe(r2.n);
  });
  it('path work matches −Δ(Φ) to the scheme order, and the cap is reported, never hidden', () => {
    const f = fieldOf([src({ mass: M, softening: 1 })]);
    const x: Vec3 = [8, 0, 0], v: Vec3 = [0, 0, 60];
    const sf = stepField(f), res = newKdkResult();
    let W = 0;
    const phi0 = f.potential(...x);
    for (let k = 0; k < 600; k++) { kdk(sf, x, v, 1 / 60, res); W += res.work; }
    // Trapezoid on the drifted segments: O(h²) — reported by the ledger as R_Φ, not removed.
    expect(Math.abs(W + (f.potential(...x) - phi0)) / Math.abs(phi0)).toBeLessThan(1e-3);
    const capped = kdk(sf, [0.5, 0, 0], [0, 0, 0], 1 / 60, newKdkResult(), 2);
    expect(capped.capped).toBe(true);
    expect(capped.n).toBe(2);
    expect(capped.wanted).toBeGreaterThan(2);
  });
});

describe('orbit tools', () => {
  it('circular and escape speeds (Kepler limits), launch perpendicular to the radius', () => {
    expect(circularSpeed(MU, 50)).toBeCloseTo(Math.sqrt(MU / 50), 12);
    expect(escapeSpeed(MU, 50)).toBeCloseTo(Math.sqrt((2 * MU) / 50), 12);
    expect(circularSpeed(MU, 3, 3) ** 2).toBeCloseTo((MU * 9) / 18 ** 1.5, 9);
    const v = launchVelocity([10, 0, 0], [1, 0, 1], 5, true);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(5, 12);
  });
  it('elements of a known ellipse', () => {
    const rp = 20, e = 0.6, vp = Math.sqrt((MU * (1 + e)) / rp);
    const el = elements(MU, [rp, 0, 0], [0, 0, vp]);
    expect(el.e).toBeCloseTo(e, 9);
    expect(el.periapsis).toBeCloseTo(rp, 9);
    expect(el.apoapsis).toBeCloseTo(rp * (1 + e) / (1 - e), 7);
    expect(el.period).toBeCloseTo(2 * Math.PI * Math.sqrt((rp / (1 - e)) ** 3 / MU), 7);
    expect(el.kind).toBe('elliptic');
    expect(el.exact).toBe(true);
    expect(elements(MU, [rp, 0, 0], [0, 0, vp], 1).exact).toBe(false);
  });
});

describe('tidal mechanics', () => {
  it('uniform field: no tide; point mass: bar tension m·λ·L/8 with λ = 2μ/r³', () => {
    expect(symEigenvalues([0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual([0, 0, 0]);
    const f = fieldOf([src({ mass: M, softening: 0.05 })]);
    const T = f.addGradient(20, 0, 0, new Float64Array(9));
    const lam = stretchAlong(T, [1, 0, 0]);
    expect(lam / ((2 * MU) / 8000)).toBeCloseTo(1, 4); // ε = 5 cm: −2·10⁻⁵
    expect(barTension(1000, 4, lam)).toBeCloseTo((1000 * lam * 4) / 8, 9);
    expect(barTension(1000, 4, -lam)).toBe(0);
    // Exact difference of the field across a 4 m bar vs the linear estimate.
    const d = g(f, 22, 0, 0)[0] - g(f, 18, 0, 0)[0];
    expect(d / (lam * 4)).toBeCloseTo(1, 1);
  });
  it('gravity-gradient torque: zero when aligned with the radius, restoring when tilted', () => {
    const f = fieldOf([src({ mass: M, softening: 0.05 })]);
    const T = f.addGradient(30, 0, 0, new Float64Array(9));
    const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const S = boxSecondMoment(500, [6, 1, 1], I3); // long axis along x = radius
    expect(Math.hypot(...gradientTorque(S, T))).toBeLessThan(1e-9);
    // Tilt the long axis 30° towards +z: the torque turns it back towards the radius.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const R = [c, 0, -s, 0, 1, 0, s, 0, c];
    const tq = gradientTorque(boxSecondMoment(500, [6, 1, 1], R), T);
    // Independent check: r × F at the two end points of the axis.
    const ends = [[3 * c, 0, 3 * s], [-3 * c, 0, -3 * s]] as Vec3[];
    let ty = 0;
    for (const e of ends) { const F = [T[0] * e[0] + T[2] * e[2], 0, T[6] * e[0] + T[8] * e[2]]; ty += e[2] * F[0] - e[0] * F[2]; }
    expect(Math.sign(tq[1])).toBe(Math.sign(ty));
    // The axis (cos 30°, 0, sin 30°) sits at a −30° rotation about y: restoring means a positive torque about y.
    expect(ty).toBeGreaterThan(0);
  });
});

describe('celestial spec validation', () => {
  it('the default is valid; contradictory input is rejected with a reason', () => {
    expect(celestialIssues(defaultCelestialSpec())).toEqual([]);
    expect(celestialIssues(spec([]))).toContain('celestial.invalid.empty');
    expect(celestialIssues(spec([src({ softening: 0 })]))).toContain('celestial.invalid.softening');
    expect(celestialIssues(spec([src({ capture: 0 })]))).toContain('celestial.invalid.capture');
    expect(celestialIssues(spec([src({ mass: -5 })]))).toContain('celestial.invalid.mass');
    // A solar-mass hole in the educational mode is out of its μ range and beyond the integrator.
    expect(celestialIssues(spec([src({ mass: M_SUN })]))).toEqual(expect.arrayContaining(['celestial.invalid.mu', 'celestial.invalid.core']));
    // … but a physical-mode spec is accepted (the run applies its limit policy) and its regime says why.
    expect(celestialIssues(spec([src({ mass: M_SUN, capture: 3 })], { scale: 'physical' }))).toEqual([]);
    const reg = sourceRegime(src({ mass: M_SUN, capture: 3 }));
    expect(reg.within).toBe(false);
    expect(reg.relativistic).toBe(true);
  });
  it('educational mass from a target acceleration', () => {
    const m = massForAccel(20, 50, 2);
    const f = fieldOf([src({ mass: m, softening: 2 })]);
    expect(Math.hypot(...g(f, 50, 0, 0))).toBeCloseTo(20, 9);
  });
});
