/**
 * Phase 35: independent checks of the pure vehicle model (spec §68–77). Expected values are hand calculations written out
 * in the test (box inertia, parallel axis, statics, the brush-curve limits, Ackermann geometry, the engine curve) — not the
 * implementation's functions, unless stated.
 */
import { describe, expect, it } from 'vitest';
import { composite, vehicleGeometry } from './geometry';
import { TIRE, VARIANTS } from './params';
import { driveShares, fullLoadTorque, newPowertrain, steerAngles, driveTorque, neutralControls } from './powertrain';
import { implicitSpin, relaxLateral, steadySlip, tireForce, type TireForce } from './tire';
import { aeroForce } from './aero';
import { tireMu, tireCrr } from './surface';
import { SURF } from '@/climate/surfaceState';

const g = 9.80665;

describe('mass properties (§15–16)', () => {
  it('a single box about its centre: I_xx = m(h² + w²)/12, I_yy = m(l² + w²)/12, I_zz = m(l² + h²)/12 (x length, y height, z width)', () => {
    const m = 1200, l = 4, h = 1.2, w = 1.8;
    const c = composite([{ mass: m, centre: [0.3, 0.7, -0.1], size: [l, h, w] }]);
    expect(c.com).toEqual([0.3, 0.7, -0.1]);
    expect(c.inertia[0]).toBeCloseTo((m * (h * h + w * w)) / 12, 9);
    expect(c.inertia[4]).toBeCloseTo((m * (l * l + w * w)) / 12, 9);
    expect(c.inertia[8]).toBeCloseTo((m * (l * l + h * h)) / 12, 9);
    expect(Math.abs(c.inertia[1]) + Math.abs(c.inertia[2]) + Math.abs(c.inertia[5])).toBe(0);
  });

  it('two point masses: parallel axis I = Σ m d² about the common COM; products of inertia −Σ m x y', () => {
    const c = composite([{ mass: 2, centre: [1, 1, 0], size: [0, 0, 0] }, { mass: 6, centre: [-1, 3, 0], size: [0, 0, 0] }]);
    // COM: x = (2 − 6)/8 = −0.5, y = (2 + 18)/8 = 2.5
    expect(c.com[0]).toBeCloseTo(-0.5, 12);
    expect(c.com[1]).toBeCloseTo(2.5, 12);
    // d1 = (1.5, −1.5, 0), d2 = (−0.5, 0.5, 0): I_zz = 2·4.5 + 6·0.5 = 12; I_xx = 2·2.25 + 6·0.25 = 6; I_xy = −(2·(−2.25) + 6·(−0.25)) = 6
    expect(c.inertia[8]).toBeCloseTo(12, 12);
    expect(c.inertia[0]).toBeCloseTo(6, 12);
    expect(c.inertia[1]).toBeCloseTo(6, 12);
  });

  it('the sedan: total mass kept, COM between the axles, static wheel loads sum to m g and balance the moments about the COM', () => {
    const geo = vehicleGeometry({ variant: 'sedan', length: 4.5, width: 1.8, height: 1.45 }, 1409);
    expect(geo.parts.reduce((a, p) => a + p.mass, 0)).toBeCloseTo(1409, 9);
    const F = geo.staticLoad;
    expect(F.reduce((a, b) => a + b, 0)).toBeCloseTo(1409 * g, 6);
    // Moments about the COM (pitch): front load × (x_f − x_c) = rear load × (x_c − x_r).
    const xf = geo.wheelbase / 2, xr = -geo.wheelbase / 2, xc = geo.com[0];
    expect((F[0] + F[1]) * (xf - xc)).toBeCloseTo((F[2] + F[3]) * (xc - xr), 6);
    // Wheel order FL, FR, RL, RR: left = −Z (right = forward × up = +Z).
    expect(geo.wheels[0][2]).toBeLessThan(0);
    expect(geo.wheels[1][2]).toBeGreaterThan(0);
  });

  it('suspension: k = m_c (2π f)², c = 2ζ√(k m_c), static compression m_c g / k = g / (2π f)² for every corner', () => {
    const geo = vehicleGeometry({ variant: 'suv', length: 4.7, width: 1.9, height: 1.75 }, 1871);
    const f = VARIANTS.suv.rideHz, z = VARIANTS.suv.damping;
    for (let i = 0; i < 4; i++) {
      const mc = geo.staticLoad[i] / g;
      expect(geo.k[i]).toBeCloseTo(mc * (2 * Math.PI * f) ** 2, 6);
      expect(geo.c[i]).toBeCloseTo(2 * z * Math.sqrt(geo.k[i] * mc), 6);
      expect(geo.staticCompression[i]).toBeCloseTo(g / (2 * Math.PI * f) ** 2, 9);
    }
  });
});

describe('tyre (§20–23)', () => {
  const tf = (): TireForce => ({ fx: 0, fy: 0, sliding: false, phi: 0 });

  it('steady slips: κ = (Rω − v_x) / max(|v_x|, |Rω|, v_ε), α = atan2(v_y, |v_x| + v_ε); locked wheel κ = −1, spinning at rest κ = +1', () => {
    expect(steadySlip(10, 0, 11).kappa).toBeCloseTo(0.1 / 1.1, 12);
    expect(steadySlip(10, 0, 0).kappa).toBe(-1);
    expect(steadySlip(0, 0, 5).kappa).toBe(1);
    expect(steadySlip(10, 1, 10).alpha).toBeCloseTo(Math.atan2(1, 10.1), 12);
  });

  it('brush curve: small demand → linear (F ≈ C s), large → the friction circle |F| ≤ μ F_z, peak μF_z at φ = 1, sliding μ_slide F_z at φ ≥ 2', () => {
    const Fz = 4000, mu = 0.9;
    const small = tireForce('saturating', 100, 0, Fz, mu, tf());
    // 3φ − 3φ² + φ³ with φ = 100 / (3·0.9·4000): F = 100 (1 − φ + φ²/3)
    const phi = 100 / (3 * mu * Fz);
    expect(small.fx).toBeCloseTo(100 * (1 - phi + (phi * phi) / 3), 9);
    const peak = tireForce('saturating', 3 * mu * Fz, 0, Fz, mu, tf());
    expect(peak.fx).toBeCloseTo(mu * Fz, 9);
    const slide = tireForce('saturating', 2 * 3 * mu * Fz, 0, Fz, mu, tf());
    expect(slide.fx).toBeCloseTo(TIRE.slideShare * mu * Fz, 9);
    expect(slide.sliding).toBe(true);
  });

  it('combined slip shares one friction budget: braking and cornering together never exceed μF_z; the direction follows the demand', () => {
    const Fz = 3000, mu = 0.7;
    for (const [sx, sy] of [[-5000, 4000], [8000, -2000], [1000, 1000], [-30000, 30000]]) {
      const f = tireForce('saturating', sx, sy, Fz, mu, tf());
      expect(Math.hypot(f.fx, f.fy)).toBeLessThanOrEqual(mu * Fz + 1e-9);
      expect(f.fx * sy - f.fy * sx).toBeCloseTo(0, 6);
    }
    // The linear model has no limit (small-slip reference only).
    const lin = tireForce('linear', 20000, 0, Fz, mu, tf());
    expect(lin.fx).toBe(20000);
  });

  it('transient lateral slip relaxes to v_y / |v_x| with the length σ_y (exact exponential), and integrates the sideways creep at rest', () => {
    const st = { k: 0, a: 0 };
    relaxLateral(st, 20, 1, 0.1);
    expect(st.a).toBeCloseTo((1 / 20) * (1 - Math.exp((-20 * 0.1) / TIRE.sigmaY)), 12);
    const s0 = { k: 0, a: 0 };
    relaxLateral(s0, 0, 0.05, 0.2);
    expect(s0.a).toBeCloseTo((0.05 * 0.2) / TIRE.sigmaY, 12);
  });

  it('implicit wheel spin: a free-rolling wheel (no torque) at speed stays at ω = v / R; a driving torque on a wheel at rest spins it up and builds forward slip', () => {
    const st = { k: 0, a: 0 };
    let w = 20 / 0.31;
    for (let i = 0; i < 100; i++) w = implicitSpin(st, w, 20, 0.31, 0.9, 0, 16 * 4000, 0, 1 / 480);
    expect(w).toBeCloseTo(20 / 0.31, 9);
    expect(st.k).toBeCloseTo(0, 9);
    const s2 = { k: 0, a: 0 };
    const w2 = implicitSpin(s2, 0, 0, 0.31, 0.9, 500, 16 * 4000, 0, 1 / 480);
    expect(w2).toBeGreaterThan(0);
    expect(s2.k).toBeGreaterThan(0);
  });
});

describe('powertrain, brakes, steering (§24–27)', () => {
  const sedan = VARIANTS.sedan;

  it('engine: T_max up to ω = P / T, then P / ω, zero at the rev limit', () => {
    expect(fullLoadTorque(sedan, 200)).toBe(250);
    expect(fullLoadTorque(sedan, 500)).toBeCloseTo(110e3 / 500, 12);
    expect(fullLoadTorque(sedan, 650)).toBe(0);
  });

  it('wheel torque in first gear at idle with full throttle = T_max × gear × final × η, split by the layout (shares sum to 1)', () => {
    const pt = newPowertrain();
    const c = { ...neutralControls(), throttle: 1 };
    const T = driveTorque(sedan, pt, c, 0, 1 / 480);
    expect(T).toBeCloseTo(250 * 3.6 * 3.9 * 0.9, 9);
    for (const d of ['fwd', 'rwd', 'awd'] as const) expect(driveShares(d).reduce((a, b) => a + b, 0)).toBe(1);
    // Neutral and park deliver nothing.
    expect(driveTorque(sedan, newPowertrain(), { ...c, gear: 'N' }, 0, 1 / 480)).toBe(0);
    expect(driveTorque(sedan, newPowertrain(), { ...c, gear: 'P' }, 0, 1 / 480)).toBe(0);
  });

  it('a spinning wheel does not shift up (road-speed schedule): at rest with the wheels at the rev limit the gear stays first', () => {
    const pt = newPowertrain();
    const c = { ...neutralControls(), throttle: 1 };
    for (let i = 0; i < 2000; i++) driveTorque(sedan, pt, c, 200, 1 / 480, 1, 0);
    expect(pt.gear).toBe(0);
  });

  it('Ackermann: cot δ_outer − cot δ_inner = t / L; the bicycle angle lies between; rate-limited approach to the target', () => {
    const pt = newPowertrain();
    let a: [number, number] = [0, 0];
    for (let i = 0; i < 200; i++) a = steerAngles(sedan, pt, 1, 5, 2.7, 1.55, 1 / 60);
    const [left, right] = a;
    expect(1 / Math.tan(right) - 1 / Math.tan(left)).toBeCloseTo(1.55 / 2.7, 9);
    expect(left).toBeGreaterThan(pt.delta);
    expect(right).toBeLessThan(pt.delta);
    const p2 = newPowertrain();
    steerAngles(sedan, p2, 1, 5, 2.7, 1.55, 1 / 60);
    expect(p2.delta).toBeCloseTo(sedan.steerRate / 60, 12);
  });
});

describe('aerodynamics and surfaces (§31–32, §48)', () => {
  it('drag −½ρ C_d A |v| v along the body axis; a crosswind gives the side force; no force without relative air', () => {
    const q = [0, 0, 0, 1] as const;
    const f = aeroForce({ q, vCop: [30, 0, 0], wind: [0, 0, 0], rho: 1.225, cd: 0.3, cy: 1, frontal: 2.2, side: 6, dryShare: 1 });
    expect(f[0]).toBeCloseTo(-0.5 * 1.225 * 0.3 * 2.2 * 900, 9);
    const s = aeroForce({ q, vCop: [0, 0, 0], wind: [0, 0, 10], rho: 1.2, cd: 0.3, cy: 1, frontal: 2.2, side: 6, dryShare: 1 });
    expect(s[2]).toBeCloseTo(0.5 * 1.2 * 1 * 6 * 100, 9);
    expect(aeroForce({ q, vCop: [3, 0, 0], wind: [3, 0, 0], rho: 1.2, cd: 0.3, cy: 1, frontal: 2, side: 6, dryShare: 1 })).toEqual([0, 0, 0]);
  });

  it('surface friction: dry asphalt 0.9, wet ×(0.5/0.7), ice 0.1, wet ice 0.05; rolling resistance grows with snow depth', () => {
    expect(tireMu(3, null, 0)).toBe(0.9);
    expect(tireMu(3, null, 0.01)).toBeCloseTo(0.9 * 0.5 / 0.7, 12);
    expect(tireMu(3, { state: SURF.ice, ice: 1, snowDepth: 0 }, 0)).toBe(0.1);
    expect(tireMu(3, { state: SURF.wetIce, ice: 1, snowDepth: 0 }, 0)).toBe(0.05);
    expect(tireCrr(3, { state: SURF.snow, ice: 0, snowDepth: 0.1 }, )).toBeCloseTo(0.012 + TIRE.crrSnowPerM * 0.1, 12);
  });
});
