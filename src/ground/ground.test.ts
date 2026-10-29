/**
 * Phase 22 ground models — pure parts: material profiles, stability formulas against textbook
 * closed forms, and the granular solver (repose angle, Coulomb sliding block, rest on gentle
 * slopes, exact volume / mass conservation, open edges, grid and time-step sensitivity).
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { DEFAULT_MECHANICAL, MECHANICAL_IDS, MECHANICAL_PROFILES, mechanicalOf, unitWeight, DEG } from './materials';
import { criticalAcceleration, criticalCavityRadius, culmannCriticalHeight, infiniteSlopeFS, newmarkStep, plugFS, stableCutAngle } from './stability';
import { GeoField } from './GeoField';
import { flowStep } from './granular';

describe('mechanical profiles', () => {
  it('every profile states a value inside its own typical range; soil profiles map to one', () => {
    for (const id of MECHANICAL_IDS) {
      const p = MECHANICAL_PROFILES[id];
      expect(p.cohesion).toBeGreaterThanOrEqual(p.cohesionRange[0]);
      expect(p.cohesion).toBeLessThanOrEqual(p.cohesionRange[1]);
      expect(p.friction).toBeGreaterThanOrEqual(p.frictionRange[0]);
      expect(p.friction).toBeLessThanOrEqual(p.frictionRange[1]);
      expect(p.bulking).toBeGreaterThanOrEqual(1);
      expect(p.porosity).toBeGreaterThan(0);
    }
    expect(DEFAULT_MECHANICAL[0]).toBe('rock');
    expect(mechanicalOf(3).id).toBe('fill');
    expect(MECHANICAL_PROFILES.rock.failureModel).toBe(false);
    expect(unitWeight(MECHANICAL_PROFILES.denseGranular)).toBeCloseTo(19.62, 2);
  });
});

describe('stability formulas', () => {
  const sand = { c: 0, phi: 35 * DEG, gamma: 19, z: 2, m: 0 };
  it('infinite slope: dry cohesionless FS = tanφ / tanβ; water and cohesion behave as the closed form', () => {
    for (const b of [10, 20, 30, 34]) expect(infiniteSlopeFS({ ...sand, beta: b * DEG })).toBeCloseTo(Math.tan(35 * DEG) / Math.tan(b * DEG), 10);
    // Fully saturated, slope-parallel seepage: FS = (γ − γw)/γ · tanφ/tanβ.
    expect(infiniteSlopeFS({ ...sand, beta: 25 * DEG, m: 1 })).toBeCloseTo(((19 - 9.81) / 19) * (Math.tan(35 * DEG) / Math.tan(25 * DEG)), 10);
    // Cohesion term c / (γ z sinβ cosβ).
    const c = infiniteSlopeFS({ ...sand, c: 5, beta: 30 * DEG }) - infiniteSlopeFS({ ...sand, beta: 30 * DEG });
    expect(c).toBeCloseTo(5 / (19 * 2 * Math.sin(30 * DEG) * Math.cos(30 * DEG)), 10);
    // Thicker soil → cohesion matters less; wetter → lower FS; flat → stable.
    expect(infiniteSlopeFS({ ...sand, c: 5, z: 4, beta: 30 * DEG })).toBeLessThan(infiniteSlopeFS({ ...sand, c: 5, z: 2, beta: 30 * DEG }));
    expect(infiniteSlopeFS({ ...sand, m: 0.5, beta: 30 * DEG })).toBeLessThan(infiniteSlopeFS({ ...sand, beta: 30 * DEG }));
    expect(infiniteSlopeFS({ ...sand, beta: 0 })).toBe(Infinity);
  });

  it('Newmark: a_c = (FS − 1)·g·sinβ; a pulse below a_c moves nothing, above it slides and stops', () => {
    expect(criticalAcceleration(1.5, 30 * DEG)).toBeCloseTo(0.5 * 9.81 * 0.5, 10);
    const ac = 1;
    let v = 0, d = 0;
    for (let k = 0; k < 100; k++) { v = newmarkStep(v, 0.9, ac, 0.01); d += v * 0.01; }
    expect(d).toBe(0);
    // Rectangular pulse a = 2 m/s² for 0.5 s (a − a_c = 1): v = 0.5 m/s, then decelerates at a_c:
    // D = ½·1·0.5² + 0.5²/(2·1) = 0.25 m.
    v = 0; d = 0;
    const dt = 1e-4;
    for (let t = 0; t < 2; t += dt) { v = newmarkStep(v, t < 0.5 ? 2 : 0, ac, dt); d += v * dt; }
    expect(d).toBeCloseTo(0.25, 3);
  });

  it('plug failure: FS = 1 exactly at the critical radius; surcharge and water lower it', () => {
    const roof = { H: 6, c: 8, phi: 24 * DEG, gamma: 18, m: 0, q: 0 };
    const ac = criticalCavityRadius(roof);
    expect(plugFS({ ...roof, a: ac })).toBeCloseTo(1, 10);
    expect(plugFS({ ...roof, a: ac * 0.8 })).toBeGreaterThan(1);
    expect(plugFS({ ...roof, a: ac * 1.2 })).toBeLessThan(1);
    expect(criticalCavityRadius({ ...roof, q: 30 })).toBeLessThan(ac);
    expect(criticalCavityRadius({ ...roof, m: 1 })).toBeLessThan(ac);
    // Closed form a_c = 2H(c + K0·γ'H/2·tanφ)/(γH).
    const k0 = 1 - Math.sin(24 * DEG);
    expect(ac).toBeCloseTo((2 * 6 * (8 + k0 * 18 * 3 * Math.tan(24 * DEG))) / (18 * 6), 10);
  });

  it('Culmann: Rankine critical height for a vertical cut; stable at any height below φ; stable angle inverts it', () => {
    const c = 10, g = 18, phi = 25 * DEG;
    expect(culmannCriticalHeight(c, g, 90 * DEG, phi)).toBeCloseTo((4 * c / g) * Math.tan(45 * DEG + phi / 2), 10);
    expect(culmannCriticalHeight(c, g, 20 * DEG, phi)).toBe(Infinity);
    expect(culmannCriticalHeight(0, g, 40 * DEG, phi)).toBe(0);
    const b = stableCutAngle(c, g, phi, 5);
    expect(culmannCriticalHeight(c, g, b, phi)).toBeCloseTo(5, 4);
    expect(stableCutAngle(0, g, phi, 5)).toBe(phi);
    expect(stableCutAngle(c, g, phi, 0.5)).toBeCloseTo(90 * DEG, 10);
  });
});

/** A small synthetic grid for the solver (n×n vertices, spacing dx) and a ground function. */
function grid(n: number, dx: number) {
  const t = createFlatTerrain();
  const tt = { ...t, nx: n, nz: n, cellSize: dx, originX: -((n - 1) * dx) / 2, originZ: -((n - 1) * dx) / 2, heights: new Float32Array(n * n), ground: new Uint8Array(n * n), soil: new Uint8Array(n * n).fill(1) };
  return new GeoField(tt);
}
const vol = (f: GeoField) => { let v = 0; for (let i = 0; i < f.n; i++) v += f.h[i] + f.loose[i]; return v * f.dx * f.dx; };

describe('granular flow', () => {
  it('a pile on flat ground spreads to the angle of repose tan⁻¹μ and stops; volume and mass exact', () => {
    const f = grid(61, 1);
    const mu = Math.tan(30 * DEG);
    const c = 30 * 61 + 30;
    for (let iz = 0; iz < 61; iz++) for (let ix = 0; ix < 61; ix++) {
      const r = Math.hypot(ix - 30, iz - 30);
      if (r < 4) { const i = iz * 61 + ix; f.thickness[i] = 6; f.release(i, 6 - r, mu); }
    }
    const v0 = vol(f), m0 = f.budget.releasedMass;
    const ground = (i: number) => f.bed[i];
    for (let k = 0; k < 400 && f.active.x1 >= f.active.x0; k++) flowStep(f, 0.05, { ground });
    f.closeBudget(0);
    expect(f.active.x1).toBeLessThan(f.active.x0); // everything at rest
    expect(Math.abs(vol(f) - v0) / v0).toBeLessThan(1e-6);
    expect(Math.abs(f.budget.residual)).toBeLessThan(1e-6 * v0);
    expect(Math.abs(f.budget.residualMass)).toBeLessThan(1e-6 * m0);
    // Steepest surface slope of the final pile ≤ μ (+ one cell of discretization).
    const s = (i: number) => f.bed[i] + f.h[i];
    let steep = 0;
    for (let iz = 1; iz < 60; iz++) for (let ix = 1; ix < 60; ix++) {
      const i = iz * 61 + ix;
      steep = Math.max(steep, Math.abs(s(i + 1) - s(i)), Math.abs(s(i + 61) - s(i)));
    }
    expect(steep).toBeLessThan(mu * 1.15);
    expect(s(c)).toBeLessThan(6);
  });

  it('a thin layer on a plane steeper than μ accelerates at g·cosβ(sinβ − μcosβ); gentler than μ it never moves', () => {
    for (const [beta, mu, moves] of [[35, 0.4, true], [15, 0.4, false]] as const) {
      const n = 81, f = grid(n, 1), tb = Math.tan(beta * DEG);
      const ground = (i: number) => -tb * (i % n) + f.bed[i];
      for (let i = 0; i < f.n; i++) { f.thickness[i] = 0.3; f.release(i, 0.2, mu); }
      for (let i = 0; i < f.n; i++) f.bed[i] += 0.2; // keep the ground where it was: only the layer
      flowStep(f, 0.3, { ground, xi: 1e9 });
      const mid = 40 * n + 40, kx = 40 * (n - 1) + 40;
      const u = f.qx[kx] / f.h[mid];
      const cb = Math.cos(beta * DEG), sb = Math.sin(beta * DEG);
      if (moves) expect(u).toBeCloseTo(9.81 * cb * (sb - mu * cb) * 0.3, 1);
      else expect(u).toBe(0);
    }
  });

  it('open edges record what leaves; the budget closes', () => {
    const n = 41, f = grid(n, 1), tb = Math.tan(40 * DEG);
    const ground = (i: number) => -tb * (i % n) + f.bed[i];
    for (let iz = 15; iz < 25; iz++) for (let ix = 25; ix < 35; ix++) { const i = iz * n + ix; f.thickness[i] = 2; f.release(i, 1.5, 0.3); }
    for (let k = 0; k < 200 && f.active.x1 >= f.active.x0; k++) flowStep(f, 0.1, { ground, boundary: 'open' });
    f.closeBudget(0);
    expect(f.budget.outflow).toBeGreaterThan(0);
    expect(Math.abs(f.budget.residual)).toBeLessThan(1e-6 * f.budget.released);
    expect(Math.abs(f.budget.residualMass)).toBeLessThan(1e-6 * f.budget.releasedMass);
  });

  it('a released block never runs faster than its Voellmy terminal speed + the gravity-wave speed (draining faces keep their velocity, not their flux); the time step stays at the CFL of real speeds', () => {
    const n = 121, f = grid(n, 1), beta = 32 * DEG, tb = Math.tan(beta), mu = 0.39, xi = 400, h0 = 2.5;
    const ground = (i: number) => -tb * (i % n) + f.bed[i];
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
      if (Math.hypot(ix - 30, iz - 60) > 15) continue;
      const i = iz * n + ix;
      f.thickness[i] = h0;
      f.release(i, h0, mu);
      f.bed[i] += h0; // the block sits on the plane
    }
    let vmax = 0, hmax = 0, worstSub = 0;
    for (let k = 0; k < 150 && f.active.x1 >= f.active.x0; k++) {
      const st = flowStep(f, 0.1, { ground, xi });
      vmax = Math.max(vmax, st.maxSpeed);
      worstSub = Math.max(worstSub, st.substeps);
      for (let i = 0; i < f.n; i++) hmax = Math.max(hmax, f.h[i]);
    }
    const S = Math.sin(beta) * Math.cos(beta) - mu * Math.cos(beta) ** 2;
    const bound = Math.sqrt(xi * hmax * S) + 2 * Math.sqrt(9.81 * hmax);
    expect(vmax).toBeGreaterThan(2); // it does move
    expect(vmax).toBeLessThan(bound);
    // CFL substeps per 0.1 s at that speed (dx = 1 m, CFL 0.4): a handful, not hundreds.
    expect(worstSub).toBeLessThan(Math.ceil((bound * 0.1) / 0.4) + 2);
  });

  it('runout converges with the grid and does not depend on the call interval', () => {
    // A block released on a 35° slope that ends on flat ground; runout = farthest deposit.
    const runout = (dx: number, call: number) => {
      const L = 80, n = Math.round(L / dx) + 1, f = grid(n, dx), tb = Math.tan(35 * DEG);
      const xOf = (i: number) => (i % n) * dx;
      const ground = (i: number) => (xOf(i) < 40 ? (40 - xOf(i)) * tb : 0) + f.bed[i];
      for (let i = 0; i < f.n; i++) {
        const x = xOf(i), z = Math.floor(i / n) * dx;
        if (x >= 10 && x < 16 && z >= 35 && z < 45) { f.thickness[i] = 2; f.release(i, 1.5, Math.tan(28 * DEG)); }
      }
      for (let k = 0; k < 4000 && f.active.x1 >= f.active.x0; k++) flowStep(f, call, { ground });
      let far = 0;
      for (let i = 0; i < f.n; i++) if (f.loose[i] > 0.01) far = Math.max(far, xOf(i));
      return far;
    };
    const r2 = runout(2, 0.1), r1 = runout(1, 0.1), r05 = runout(0.5, 0.1);
    expect(Math.abs(r05 - r1)).toBeLessThanOrEqual(Math.abs(r1 - r2) + 1);
    expect(r1).toBeGreaterThan(40); // it reached the flat ground
    // Calling every 0.1 s or every 0.5 s (CFL substeps inside): same runout within a cell.
    expect(Math.abs(runout(1, 0.5) - r1)).toBeLessThanOrEqual(1);
  });
});
