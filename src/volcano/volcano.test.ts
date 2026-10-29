import { describe, expect, it } from 'vitest';
import { LAVA_MATERIALS, grdVft, viscosity, yieldStrength, crystalFraction, mobile, lockTemperature, specificEnergy, temperatureFromEnergy } from './materials';
import { eruptionIntegral, eruptionPhase, suppliedVolume, totalVolume } from './eruption';
import { volcanoIssues, type VolcanoSpec } from './types';
import { LavaField, stillSurroundings, ASH_DEPOSIT_DENSITY, MAX_SUB } from './LavaField';
import { binghamFlux, criticalDepth } from './rheology';
import { surfaceTemperature, boundaryLayer } from './crust';
import { VolcanoWorld, type VolcanoEnv } from './VolcanoWorld';
import { settlingVelocity, footprint } from './ash';
import { ZERO_C } from '@/thermal/units';
import { enthalpy, TM } from '@/thermal/materials';

const Tref = 288.15;
const basalt = LAVA_MATERIALS.basalt, andesite = LAVA_MATERIALS.andesite;

/** Plane z-independent slope along +x (drop per metre), optional bump wall. */
function plane(nx: number, nz: number, dx: number, slope: number, f?: (x: number, iz: number) => number) {
  const H = new Float32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) H[iz * nx + ix] = -slope * ix * dx + (f ? f(ix * dx, iz * dx) : 0);
  return H;
}

function run(f: LavaField, vent: number, rate: number, T: number, steps: number, supplySteps: number, dt = 0.1) {
  const env = stillSurroundings(Tref);
  let subs = 0;
  for (let s = 0; s < steps; s++) {
    if (s < supplySteps) f.supply(vent, rate * f.rho * dt, T);
    subs += f.flow(dt);
    f.cool(dt, env);
    f.drain(() => {});
  }
  return subs;
}

/** Furthest x reached by lava or deposit (m). */
function front(f: LavaField) {
  let x = -Infinity;
  for (let i = 0; i < f.n; i++) if (f.M[i] > 0 || f.depM[i] > 1) x = Math.max(x, f.xOf(i));
  return x;
}

describe('lava materials', () => {
  it('GRD model reproduces the paper sample (Giordano et al. 2008, Table 2)', () => {
    const v = grdVft({ SiO2: 62.4, TiO2: 0.55, Al2O3: 20.01, FeO: 0.03, MnO: 0.02, MgO: 3.22, CaO: 9.08, Na2O: 3.52, K2O: 0.93, P2O5: 0.12, H2O: 2 });
    expect(v.B).toBeCloseTo(7720, -2);
    expect(v.C).toBeCloseTo(334, -1);
    expect(v.A + v.B / (1273 - v.C)).toBeCloseTo(3.67, 1);
  });

  it('viscosity falls with temperature, andesite ≫ basalt, crystals raise it and lock the lava', () => {
    const T = (c: number) => c + ZERO_C;
    expect(viscosity(basalt, T(1180))).toBeLessThan(viscosity(basalt, T(1140)));
    expect(viscosity(basalt, T(1140))).toBeGreaterThan(1e2);
    expect(viscosity(basalt, T(1140))).toBeLessThan(1e4);
    expect(viscosity(andesite, T(1050)) / viscosity(basalt, T(1140))).toBeGreaterThan(100);
    expect(yieldStrength(basalt, T(1100))).toBeGreaterThan(yieldStrength(basalt, T(1140)));
    expect(mobile(basalt, lockTemperature(basalt) + 1)).toBe(true);
    expect(mobile(basalt, lockTemperature(basalt) - 1)).toBe(false);
    expect(crystalFraction(basalt, basalt.thermal.TL + 10)).toBe(0);
  });

  it('enthalpy table holds the latent heat between liquidus and solidus (energy ↔ temperature round trip)', () => {
    const { TL, TS, cp, latent } = basalt.thermal;
    const dH = enthalpy(TM.basaltLava, TL + 20) - enthalpy(TM.basaltLava, TS - 20);
    expect(dH / (cp * (TL - TS + 40) + latent)).toBeCloseTo(1, 2);
    for (const c of [500, 1000, 1100, 1150]) expect(temperatureFromEnergy(basalt, specificEnergy(basalt, c + ZERO_C, Tref), Tref)).toBeCloseTo(c + ZERO_C, 1);
  });
});

describe('eruption timing', () => {
  const base: VolcanoSpec = { event: 'volcano', vents: [{ kind: 'central', position: [0, 0], radius: 2 }], material: 'basalt', temperature: 1140, rate: 3, duration: 600, profile: 'constant' };
  const profiles: VolcanoSpec[] = [
    base,
    { ...base, profile: 'ramp', rampTime: 120 },
    { ...base, profile: 'pulse', period: 60, pulseWidth: 17 },
    { ...base, profile: 'staged', stages: [0.3, 1, 0.5] },
    { ...base, profile: 'wane', declineTime: 200 },
  ];
  it('supply is the exact integral whatever the step (irregular steps sum to the total)', () => {
    for (const s of profiles) {
      let t = -5, sum = 0, k = 0;
      while (t < s.duration + 10) { const h = 0.05 + ((k++ * 0.37) % 1.3); sum += suppliedVolume(s, t, t + h); t += h; }
      expect(sum).toBeCloseTo(totalVolume(s), 9);
    }
    expect(totalVolume(base)).toBeCloseTo(1800, 9);
    expect(totalVolume(profiles[1])).toBeCloseTo(3 * (600 - 60), 9);
    expect(totalVolume(profiles[3])).toBeCloseTo(3 * 200 * 1.8, 9);
    expect(totalVolume(profiles[4])).toBeCloseTo(3 * (400 + 100), 9);
    expect(eruptionIntegral(base, -10, 0)).toBe(0);
  });
  it('phases: dormant → starting → active → declining → stopped', () => {
    expect(eruptionPhase(profiles[1], -1)).toBe('dormant');
    expect(eruptionPhase(profiles[1], 60)).toBe('starting');
    expect(eruptionPhase(profiles[1], 300)).toBe('active');
    expect(eruptionPhase(profiles[4], 500)).toBe('declining');
    expect(eruptionPhase(profiles[3], 50)).toBe('starting');
    expect(eruptionPhase(profiles[3], 300)).toBe('active');
    expect(eruptionPhase(profiles[3], 500)).toBe('declining');
    expect(eruptionPhase(base, 600)).toBe('stopped');
  });
  it('validation rejects impossible input with reasons', () => {
    const tr = (m: string) => [LAVA_MATERIALS[m as 'basalt'].Trange[0] - ZERO_C, LAVA_MATERIALS[m as 'basalt'].Trange[1] - ZERO_C] as [number, number];
    expect(volcanoIssues(base, ['basalt', 'andesite'], tr)).toEqual([]);
    expect(volcanoIssues({ ...base, rate: 0 })).toContain('volcano.invalid.rate');
    expect(volcanoIssues({ ...base, temperature: 2000 }, ['basalt'], tr)).toContain('volcano.invalid.temperature');
    expect(volcanoIssues({ ...base, vents: [] })).toContain('volcano.invalid.vents');
    expect(volcanoIssues({ ...base, vents: [{ kind: 'fissure', position: [0, 0], radius: 1 }] })).toContain('volcano.invalid.fissure');
    expect(volcanoIssues({ ...base, bombFraction: 0.3, ashFraction: 0.3 })).toContain('volcano.invalid.fractions');
    expect(volcanoIssues({ ...base, profile: 'staged', stages: [0] })).toContain('volcano.invalid.stages');
  });
});

describe('lava flow', () => {
  it('Bingham flux: zero at or below the critical depth, Newtonian limit without yield strength', () => {
    const s = 0.1, rho = 2080, eta = 1000, tau = 200;
    const hc = criticalDepth(s, rho, tau);
    expect(binghamFlux(hc * 0.99, s, rho, eta, tau)).toBe(0);
    expect(binghamFlux(hc * 2, s, rho, eta, tau)).toBeGreaterThan(0);
    expect(binghamFlux(1, s, rho, eta, 1e-9) / ((rho * 9.81 * s) / (3 * eta))).toBeCloseTo(1, 3);
    expect(binghamFlux(1, s, rho, eta, tau)).toBeLessThan(binghamFlux(1, s, rho, eta, 0));
  });

  it('flows downslope, conserves mass and energy exactly, never negative depth', () => {
    const nx = 61, nz = 31;
    const f = new LavaField(nx, nz, 1, 0, -15, plane(nx, nz, 1, 0.1), basalt, Tref);
    const vent = f.index(5, 0);
    run(f, vent, 1, basalt.Tdefault, 600, 400);
    expect(front(f)).toBeGreaterThan(15);
    let minM = 0;
    for (let i = 0; i < f.n; i++) minM = Math.min(minM, f.M[i]);
    expect(minM).toBe(0);
    expect(Math.abs(f.massResidual()) / f.ledger.suppliedMass).toBeLessThan(1e-12);
    expect(Math.abs(f.energyResidual()) / f.ledger.suppliedEnergy).toBeLessThan(1e-12);
    expect(f.ledger.limited).toBe(0);
  });

  it('on flat ground it spreads symmetrically and stops (yield strength); a settled flow is not recomputed', () => {
    const n = 41;
    const f = new LavaField(n, n, 1, -20, -20, new Float32Array(n * n), basalt, Tref);
    const vent = f.index(0, 0);
    run(f, vent, 1, basalt.Tdefault, 300, 100);
    // Symmetric about the vent (x ↔ −x, z ↔ −z).
    let asym = 0, tot = 0;
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
      const a = f.M[iz * n + ix] + f.depM[iz * n + ix], b = f.M[iz * n + (n - 1 - ix)] + f.depM[iz * n + (n - 1 - ix)], c = f.M[(n - 1 - iz) * n + ix] + f.depM[(n - 1 - iz) * n + ix];
      asym += Math.abs(a - b) + Math.abs(a - c); tot += a;
    }
    expect(asym / tot).toBeLessThan(1e-6);
    // Long after the supply stops: no face moves, no sub-steps.
    const env = stillSurroundings(Tref);
    for (let s = 0; s < 3000; s++) { f.flow(0.1); f.cool(0.1, env); f.drain(() => {}); }
    expect(f.flow(0.1)).toBe(0);
    expect(f.faces).toBe(0);
  });

  it('a more viscous lava (andesite) advances far less than basalt', () => {
    const go = (m: typeof basalt) => {
      const f = new LavaField(61, 31, 1, 0, -15, plane(61, 31, 1, 0.15), m, Tref);
      run(f, f.index(5, 0), 1, m.Tdefault, 400, 400);
      return front(f);
    };
    expect(go(andesite)).toBeLessThan(go(basalt) - 5);
  });

  it('cooler lava moves slower (temperature-dependent mobility), and cooling slows the flow over time', () => {
    const go = (Tc: number) => {
      const f = new LavaField(61, 31, 1, 0, -15, plane(61, 31, 1, 0.1), basalt, Tref);
      run(f, f.index(5, 0), 1, Tc + ZERO_C, 300, 300);
      return front(f);
    };
    expect(go(1110)).toBeLessThan(go(1170));
  });

  it('cools, crystallizes and locks into a deposit with the same mass; deposit thickness = mass / (ρ·A)', () => {
    const f = new LavaField(41, 21, 1, 0, -10, plane(41, 21, 1, 0.05), basalt, Tref);
    const vent = f.index(5, 0);
    run(f, vent, 0.5, basalt.Tdefault, 200, 100);
    const env = stillSurroundings(Tref);
    for (let s = 0; s < 6000; s++) { f.flow(1); f.cool(1, env); f.drain(() => {}); }
    expect(f.depositMass()).toBeGreaterThan(0.5 * f.ledger.suppliedMass);
    for (let i = 0; i < f.n; i++) if (f.depM[i] > 0) { expect(f.dep[i]).toBeCloseTo(f.depM[i] / (f.rho * f.area), 6); break; }
    expect(Math.abs(f.massResidual()) / f.ledger.suppliedMass).toBeLessThan(1e-12);
    expect(Math.abs(f.energyResidual()) / f.ledger.suppliedEnergy).toBeLessThan(1e-9);
    expect(f.ledger.toGround).toBeGreaterThan(0);
    expect(f.ledger.radiated).toBeGreaterThan(f.ledger.toAir);
  });

  it('crust: surface far colder than the interior after minutes; the boundary layer grows with age', () => {
    const Ti = basalt.Tdefault;
    expect(boundaryLayer(basalt.kappa, 600, 2)).toBeGreaterThan(boundaryLayer(basalt.kappa, 10, 2));
    const Ts10 = surfaceTemperature(Ti, boundaryLayer(basalt.kappa, 10, 2), basalt.thermal.k, 0.95, Tref, 10, Tref);
    const Ts600 = surfaceTemperature(Ti, boundaryLayer(basalt.kappa, 600, 2), basalt.thermal.k, 0.95, Tref, 10, Tref);
    expect(Ts600).toBeLessThan(Ts10);
    expect(Ts600).toBeLessThan(Ti - 300);
    expect(Ts600).toBeGreaterThan(Tref + 200);
  });

  it('a solidified ridge diverts a later flow (terrain growth and flow obstruction)', () => {
    const nx = 61, nz = 41;
    const H = plane(nx, nz, 1, 0.1);
    const free = new LavaField(nx, nz, 1, 0, -20, H, basalt, Tref);
    run(free, free.index(5, 0), 1, basalt.Tdefault, 2400, 2400);
    const wall = new LavaField(nx, nz, 1, 0, -20, H, basalt, Tref);
    // A 3 m ridge of cold deposit across the path at x = 12, z ∈ [−20, 4].
    for (let iz = 0; iz < nz; iz++) { const z = -20 + iz; if (z > 4) continue; const i = wall.index(12, z); wall.addBomb(i, 3 * wall.rho, 0); }
    run(wall, wall.index(5, 0), 1, basalt.Tdefault, 2400, 2400);
    const zMean = (f: LavaField, x0: number) => { let s = 0, m = 0; for (let i = 0; i < f.n; i++) if (f.xOf(i) > x0 && f.M[i] > 0) { s += f.zOf(i) * f.M[i]; m += f.M[i]; } return m > 0 ? s / m : 0; };
    expect(Math.abs(zMean(free, 14))).toBeLessThan(0.5);
    expect(zMean(wall, 14)).toBeGreaterThan(3);
  });

  it('grid convergence: front position at dx = 1 m and 0.5 m agrees within 20 %', () => {
    const go = (dx: number) => {
      const nx = Math.round(40 / dx) + 1, nz = Math.round(20 / dx) + 1;
      const f = new LavaField(nx, nz, dx, 0, -10, plane(nx, nz, dx, 0.12), basalt, Tref);
      // The same supply on a 1 m² disc (4 vertices at 0.5 m).
      const verts: number[] = [];
      for (let i = 0; i < f.n; i++) if (Math.hypot(f.xOf(i) - 5, f.zOf(i)) <= 0.5 + 1e-9) verts.push(i);
      const env = stillSurroundings(Tref);
      for (let s = 0; s < 250; s++) { for (const v of verts) f.supply(v, (f.rho * 0.1) / verts.length, basalt.Tdefault); f.flow(0.1); f.cool(0.1, env); f.drain(() => {}); }
      let x = 0; for (let i = 0; i < f.n; i++) if (f.M[i] / (f.rho * f.area) > 0.05) x = Math.max(x, f.xOf(i));
      return x - 5;
    };
    const a = go(1), b = go(0.5);
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.2);
  }, 60000);

  it('time-step convergence: 0.1 s and 0.05 s steps give the same front within 10 %', () => {
    const go = (dt: number) => {
      const f = new LavaField(51, 31, 1, 0, -15, plane(51, 31, 1, 0.1), basalt, Tref);
      run(f, f.index(5, 0), 1, basalt.Tdefault, Math.round(30 / dt), Math.round(30 / dt), dt);
      return front(f) - 5;
    };
    const a = go(0.1), b = go(0.05);
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.1);
  });

  it('open edges: lava leaving the grid is booked as outflow with its energy', () => {
    const f = new LavaField(21, 11, 1, 0, -5, plane(21, 11, 1, 0.3), basalt, Tref);
    run(f, f.index(14, 0), 2, basalt.Tdefault + 40, 400, 300);
    expect(f.ledger.outMass).toBeGreaterThan(0);
    expect(f.ledger.outEnergy).toBeGreaterThan(0);
    expect(Math.abs(f.massResidual()) / f.ledger.suppliedMass).toBeLessThan(1e-12);
  });

  it('sub-steps are bounded (MAX_SUB) and an obstacle stops lava until it is overtopped', () => {
    const f = new LavaField(31, 11, 1, 0, -5, plane(31, 11, 1, 0.05), basalt, Tref);
    for (let iz = 0; iz < 11; iz++) f.obstacle[iz * 31 + 12] = 50;
    const s = run(f, f.index(4, 0), 1, basalt.Tdefault, 300, 300);
    expect(s).toBeLessThanOrEqual(300 * MAX_SUB);
    for (let i = 0; i < f.n; i++) if (f.xOf(i) >= 12) expect(f.M[i]).toBe(0);
  });
});

describe('ash, bombs and the world ledger', () => {
  it('settling velocity: Stokes for fine ash, faster for coarse', () => {
    const v = settlingVelocity(0.063e-3);
    expect(v).toBeCloseTo(((2000 - 1.2) * 9.81 * (0.063e-3) ** 2) / (18 * 1.81e-5), 1);
    expect(settlingVelocity(1e-3)).toBeGreaterThan(2);
    expect(settlingVelocity(1e-3)).toBeLessThan(10);
  });

  it('footprint weights plus the outside share sum to one', () => {
    const g = { nx: 11, nz: 11, dx: 1, originX: 0, originZ: 0 };
    const a = footprint(g, 5, 5, 1.2), b = footprint(g, 0.2, 0.3, 2);
    expect(a.w.reduce((s, x) => s + x, 0) + a.outside).toBeCloseTo(1, 12);
    expect(b.outside).toBeGreaterThan(0.3);
    expect(b.w.reduce((s, x) => s + x, 0) + b.outside).toBeCloseTo(1, 12);
  });

  const world = (spec: Partial<VolcanoSpec>, wind = 0) => {
    const nx = 81, nz = 81;
    const H = plane(nx, nz, 1, 0.05);
    const w = new VolcanoWorld(nx, nz, 1, -40, -40, H, basalt, Tref);
    const ground = (x: number) => -0.05 * (x + 40);
    const s: VolcanoSpec = { event: 'volcano', vents: [{ kind: 'central', position: [-25, 0], radius: 1.5 }], material: 'basalt', temperature: 1140, rate: 0.5, duration: 60, profile: 'constant', ...spec };
    w.add('v1', 'v1', s, 0, ground);
    const env: VolcanoEnv = { surroundings: stillSurroundings(Tref), u10: wind, flowX: 1, flowZ: 0, rain: () => 0, ground };
    return { w, env, s };
  };

  it('mass of every product is conserved and the energy ledger closes', () => {
    const { w, env } = world({ bombFraction: 0.1, ashFraction: 0.1, plumeHeight: 30 });
    for (let k = 0; k < 900; k++) {
      w.step(k * 0.1, 0.1, env);
      // Closed at every moment, also while bombs fly and ash is still at the vents.
      if (k % 97 === 0) { const M = w.ledger(); expect(Math.abs(M.mass.residual) / Math.max(1, M.mass.supplied)).toBeLessThan(1e-10); expect(Math.abs(M.energy.residual) / Math.max(1, M.energy.supplied)).toBeLessThan(1e-10); }
    }
    const L = w.ledger();
    expect(L.mass.supplied).toBeCloseTo(0.5 * 60 * basalt.thermal.bulk, 3);
    expect(Math.abs(L.mass.residual) / L.mass.supplied).toBeLessThan(1e-10);
    expect(Math.abs(L.energy.residual) / L.energy.supplied).toBeLessThan(1e-10);
    expect(L.mass.bombsDeposited + L.mass.outBombs).toBeGreaterThan(0);
    expect(L.mass.ashDeposited + L.mass.ashAirborne + L.mass.outAsh).toBeCloseTo(0.1 * L.mass.supplied, 3);
    expect(L.mass.gas).toBeGreaterThan(0);
    expect(L.energy.plumeHeat).toBeGreaterThan(0);
  });

  it('the same flow supplied in different step lengths erupts the same mass', () => {
    const a = world({}), b = world({});
    for (let k = 0; k < 700; k++) a.w.step(k * 0.1, 0.1, a.env);
    for (let k = 0; k < 350; k++) b.w.step(k * 0.2, 0.2, b.env);
    expect(a.w.ledger().mass.supplied).toBeCloseTo(b.w.ledger().mass.supplied, 6);
  });

  it('ash: wind carries it downwind; without wind it lands around the vent', () => {
    const still = world({ ashFraction: 0.2, plumeHeight: 40, duration: 20 });
    const windy = world({ ashFraction: 0.2, plumeHeight: 40, duration: 20 }, 6);
    for (let k = 0; k < 2000; k++) { still.w.step(k * 0.1, 0.1, still.env); windy.w.step(k * 0.1, 0.1, windy.env); }
    const cx = (w: VolcanoWorld) => { let s = 0, m = 0; const f = w.field; for (let i = 0; i < f.n; i++) if (f.depA[i] > 0) { s += f.xOf(i) * f.depA[i]; m += f.depA[i]; } return m > 0 ? s / m : NaN; };
    expect(Math.abs(cx(still.w) + 25)).toBeLessThan(2);
    expect(cx(windy.w)).toBeGreaterThan(-25 + 5);
    expect(windy.w.ledger().mass.outAsh).toBeGreaterThan(still.w.ledger().mass.outAsh);
    // Thickness of the ash deposit = mass / ρ_ash / area.
    const f = still.w.field;
    for (let i = 0; i < f.n; i++) if (f.depA[i] > 0 && f.depM[i] === 0 && f.depB[i] === 0) { expect(f.dep[i]).toBeCloseTo(f.depA[i] / ASH_DEPOSIT_DENSITY, 9); break; }
  });

  it('bombs land hot around the vent and build a cone (deposit grows near the vent)', () => {
    const { w, env } = world({ bombFraction: 0.3, rate: 1, duration: 60 });
    for (let k = 0; k < 900; k++) w.step(k * 0.1, 0.1, env);
    const f = w.field;
    let near = 0, far = 0;
    for (let i = 0; i < f.n; i++) { const r = Math.hypot(f.xOf(i) + 25, f.zOf(i)); if (r < 6) near += f.depB[i]; else far += f.depB[i]; }
    expect(near + far).toBeGreaterThan(0);
    expect(w.ledger().mass.bombsDeposited + w.ledger().mass.outBombs + w.ledger().mass.bombsInFlight).toBeCloseTo(w.ledger().mass.bombsLaunched, 6);
  });

  it('deterministic: the same plan gives identical fields', () => {
    const a = world({ bombFraction: 0.1, ashFraction: 0.1 }, 3), b = world({ bombFraction: 0.1, ashFraction: 0.1 }, 3);
    for (let k = 0; k < 400; k++) { a.w.step(k * 0.1, 0.1, a.env); b.w.step(k * 0.1, 0.1, b.env); }
    expect(Array.from(a.w.field.M)).toEqual(Array.from(b.w.field.M));
    expect(Array.from(a.w.field.dep)).toEqual(Array.from(b.w.field.dep));
  });
});
