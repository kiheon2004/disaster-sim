/**
 * Phase 31: how each gravity-dependent model scales with g — checked against the closed form of its own relation
 * (independent of the code path that applies it): natural convection (Nu ∝ Ra^⅓ turbulent, Ra ∝ g), flame height
 * (∝ g^−⅕), buoyant velocity (∝ √g), ash settling (Stokes ∝ g, Newton ∝ √g), lava (Newtonian film ∝ g), slope
 * stability (cohesion does not scale), snow overburden (∝ g), air columns (p = σ·g with the mass kept), crater gravity
 * regime (R ∝ π₂^(−μ/(2+μ))). Every relation is bitwise the Phase 0–30 value at ratio 1.
 */
import { describe, expect, it } from 'vitest';
import { withGravity, gravityDown, gravityMagnitude } from '@/thermal/gravityScope';
import { airProps, hGround, hNaturalVertical, hWaterSide, hForcedPlate } from '@/thermal/convection';
import { buoyantVelocity, flameHeight, ventInflow } from '@/fire/relations';
import { settlingVelocity } from '@/volcano/ash';
import { binghamFlux } from '@/volcano/rheology';
import { infiniteSlopeFS } from '@/ground/stability';
import { unitWeight, MECHANICAL_PROFILES } from '@/ground/materials';
import { compactionRate } from '@/climate/snow';
import { AtmosphereField } from '@/atmosphere/AtmosphereField';
import { scaledRadius, HH11 } from '@/impact/crater';
import { personStability } from '@/simulation/damage/behaviors/flood';
import { GRAVITY } from '@/core/units';

const at = <T>(k: number, f: () => T) => withGravity(k, k, f);

describe('gravity scope', () => {
  it('ratios are 1 outside a scope and restored after (also on throw)', () => {
    expect(gravityDown()).toBe(1);
    at(2, () => expect(gravityDown()).toBe(2));
    expect(() => at(3, () => { throw new Error('x'); })).toThrow();
    expect(gravityMagnitude()).toBe(1);
    // Downward ratio is never negative (an upward field gives no buoyant rise / weight in the vertical models).
    withGravity(1, -1, () => expect(gravityDown()).toBe(0));
  });
  it('ratio 1 is bitwise the Phase 0–30 value of every relation', () => {
    const v = [hGround(320, 290, 2), hWaterSide(300, 290), flameHeight(2e6, 1), buoyantVelocity(3, 200, 300), settlingVelocity(1e-4), binghamFlux(2, 0.1, 2600, 1e4, 0), unitWeight(MECHANICAL_PROFILES.denseGranular)];
    expect(at(1, () => [hGround(320, 290, 2), hWaterSide(300, 290), flameHeight(2e6, 1), buoyantVelocity(3, 200, 300), settlingVelocity(1e-4), binghamFlux(2, 0.1, 2600, 1e4, 0), unitWeight(MECHANICAL_PROFILES.denseGranular)])).toEqual(v);
  });
});

describe('thermal / fire under variable gravity', () => {
  it('turbulent natural convection over hot ground: h ∝ g^⅓ (Nu = 0.15·Ra^⅓, Ra ∝ g); conduction / radiation untouched', () => {
    const h1 = hGround(400, 290, 0), h2 = at(2, () => hGround(400, 290, 0));
    expect(h2 / h1).toBeCloseTo(Math.cbrt(2), 9);
    // Zero gravity: no buoyant convection (Ra = 0) — forced convection by wind remains (not g-dependent).
    expect(at(0, () => hGround(400, 290, 0))).toBe(0);
    expect(at(0, () => hForcedPlate(400, 290, 3, 1))).toBe(hForcedPlate(400, 290, 3, 1));
    // Vertical plate (Churchill–Chu): at 0 g only the conduction-like 0.825² term is left.
    expect(at(0, () => hNaturalVertical(400, 290, 1))).toBeCloseTo(0.825 * 0.825 * airProps(345).k, 12);
    expect(hWaterSide(300, 290) / at(8, () => hWaterSide(300, 290))).toBeCloseTo(0.5, 9);
  });
  it('flame height L ∝ g^(−1/5) (Heskestad, the 0.235·Q^⅖ part); buoyant velocities ∝ √g; vent inflow ∝ √g', () => {
    const Q = 3e6, D = 0;
    expect(at(32, () => flameHeight(Q, D)) / flameHeight(Q, D)).toBeCloseTo(0.5, 9);
    expect(at(4, () => buoyantVelocity(3, 200, 300)) / buoyantVelocity(3, 200, 300)).toBeCloseTo(2, 9);
    expect(at(0, () => buoyantVelocity(3, 200, 300))).toBe(0);
    expect(at(4, () => ventInflow(2, 2, 900, 300, 1.2)) / ventInflow(2, 2, 900, 300, 1.2)).toBeCloseTo(2, 9);
  });
});

describe('volcano / snow / ground / impact under variable gravity', () => {
  it('ash: Stokes particles settle ∝ g, coarse (Newton) ∝ √g; none without gravity', () => {
    const fine = 5e-6, coarse = 5e-3;
    const v = (d: number, g: number) => settlingVelocity(d, 2500, 1.2, 1.81e-5, 1, g);
    expect(v(fine, 2 * GRAVITY) / v(fine, GRAVITY)).toBeCloseTo(2, 2); // (the Oseen term 0.15·Re^0.687 is not exactly Stokes)
    expect(v(coarse, 4 * GRAVITY) / v(coarse, GRAVITY)).toBeCloseTo(2, 1);
    expect(settlingVelocity(coarse, 2500, 1.2, 1.81e-5, 1, 0)).toBe(0);
  });
  it('lava: Newtonian film q = ρ·g·sinθ·h³/(3η) ∝ g; a Bingham flow stops below h_cr = τ/(ρ g sinθ) — deeper needed at low g', () => {
    expect(binghamFlux(2, 0.1, 2600, 1e4, 0, 3 * GRAVITY) / binghamFlux(2, 0.1, 2600, 1e4, 0)).toBeCloseTo(3, 12);
    expect(binghamFlux(2, 0.1, 2600, 1e4, 0, 0)).toBe(0);
    const tau = 5e3; // h_cr = 1.96 m at 1 g, 4.9 m at 0.4 g
    expect(binghamFlux(3, 0.1, 2600, 1e4, tau)).toBeGreaterThan(0);
    expect(binghamFlux(3, 0.1, 2600, 1e4, tau, 0.4 * GRAVITY)).toBe(0);
  });
  it('slopes: a dry purely frictional slope has the same FS at any g; a cohesive one is safer at low g and fails at high g', () => {
    const p = MECHANICAL_PROFILES.denseGranular;
    const fs = (k: number, c: number) => at(k, () => infiniteSlopeFS({ beta: 0.6, z: 3, c, phi: 0.7, gamma: unitWeight(p), m: 0 }));
    expect(fs(3, 0)).toBeCloseTo(fs(1, 0), 12);
    expect(fs(0.3, 10)).toBeGreaterThan(fs(1, 10));
    expect(fs(3, 10)).toBeLessThan(fs(1, 10));
    // Exact: FS = c/(γ z sinβ cosβ) + tanφ/tanβ with γ ∝ g.
    const g = unitWeight(p) * 3;
    expect(fs(3, 10)).toBeCloseTo(10 / (g * 3 * Math.sin(0.6) * Math.cos(0.6)) + Math.tan(0.7) / Math.tan(0.6), 9);
  });
  it('snow: the overburden compaction term scales with the weight (W·g/g₀)', () => {
    const base = compactionRate(200, 268, 0, false); // metamorphism only
    const over1 = compactionRate(200, 268, 300, false) - base;
    const over2 = at(2, () => compactionRate(200, 268, 300, false)) - at(2, () => compactionRate(200, 268, 0, false));
    expect(over2 / over1).toBeCloseTo(2, 9);
  });
  it('air columns: p = σ·g with the column mass kept; the scale height R·T/g', () => {
    const f = new AtmosphereField({ originX: 0, originZ: 0, nx: 4, nz: 4, dx: 50, H: 100, ground: new Float64Array(16), p0: 101325, T0: 288.15, boundary: 'closed', thermo: 'isothermal' } as never);
    const M = f.totalMass(), p = f.surfacePressure(5), H = f.Href;
    f.setGravity(2 * GRAVITY);
    expect(f.totalMass()).toBe(M);
    expect(f.surfacePressure(5) / p).toBeCloseTo(2, 12);
    expect(f.Href / H).toBeCloseTo(0.5, 12);
  });
  it('crater gravity regime: R ∝ π₂^(−μ/(2+μ)) — a weaker g digs a larger crater in sand', () => {
    const set = HH11.C4_sand;
    const R1 = scaledRadius(set, 'gravity', 1e5, 1, 3000, 1600, 15000, GRAVITY);
    const R2 = scaledRadius(set, 'gravity', 1e5, 1, 3000, 1600, 15000, GRAVITY / 6);
    expect(R2 / R1).toBeCloseTo(Math.pow(6, set.mu / (2 + set.mu)), 9);
  });
  it('a person in flowing water is swept away by weaker flow at lower gravity (friction ∝ weight)', () => {
    expect(personStability(70, 1.7, 0.3, 0.5, 1.2, 150, 1, 1.62)).toBeGreaterThan(personStability(70, 1.7, 0.3, 0.5, 1.2, 150));
  });
});
