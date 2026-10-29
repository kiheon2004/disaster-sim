/**
 * Phase 23 impact models — pure parts against closed forms and the stated scaling relations:
 * mass / density / diameter, energy and momentum, entry (drag-only analytic velocity of Collins
 * et al. 2005 eq. 8, break-up at ρv² = Y, terminal fall turning vertical), arc to the terrain and the
 * aim offset, crater scaling (regimes, exponents, angle, target material), ejecta (HH11 mass, speed,
 * total mass conserved, deterministic, flight vs. vacuum ballistics), ground shock (energy flux,
 * 1/r spreading, applied pulse keeps the peak velocity), energy partition closes.
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { GRAVITY } from '@/core/units';
import { MECHANICAL_PROFILES } from '@/ground/materials';
import { resolveProjectile, sphereMass, yieldStrength } from './projectile';
import { airDensity, integrateEntry, SCALE_HEIGHT, CD, RHO0 } from './entry';
import { bearingDir, flyArc } from './trajectory';
import { computeCrater, ejectedMass, HH11, launchSpeed, scaledRadius } from './crater';
import { fly, generateParcels } from './ejecta';
import { createShock, peakAcceleration, peakVelocity, addShock, SEISMIC_EFFICIENCY } from './shock';
import { planImpact } from './plan';
import { TNT_J_PER_TONNE } from './energy';
import type { ImpactSpec } from './types';

const spec = (x: Partial<ImpactSpec> = {}): ImpactSpec => ({ event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere', ...x });

describe('projectile, energy, momentum', () => {
  it('mass = π/6·L³·ρ; an inconsistent mass is reported, never silently replaced; Collins strength relation', () => {
    const p = resolveProjectile(spec({ diameter: 2, material: 'stony' }));
    expect(p.mass).toBeCloseTo((Math.PI / 6) * 8 * 3300, 6);
    expect(resolveProjectile(spec({ mass: sphereMass(2, 7800) })).issues).toHaveLength(0);
    expect(resolveProjectile(spec({ mass: 1000 })).issues.map((i) => i.key)).toContain('impact.issue.mass');
    expect(yieldStrength(3300)).toBeCloseTo(10 ** (2.107 + 0.0624 * Math.sqrt(3300)), 0);
  });

  it('E = ½mv², p = m·v (a vector along the path), TNT = E / 4.184 GJ', () => {
    const t = createFlatTerrain();
    const plan = planImpact(spec({ entry: 'direct', speed: 8000, angle: 90, material: 'stony', diameter: 1 }), t, 1, false);
    expect(plan.energy).toBeCloseTo(0.5 * plan.mass * plan.speed * plan.speed, 0);
    const p = Math.hypot(...plan.momentum);
    expect(p).toBeCloseTo(plan.mass * plan.speed, 0);
    expect(plan.energy / TNT_J_PER_TONNE).toBeCloseTo(plan.energy / 4.184e9, 9);
  });
});

describe('atmospheric entry', () => {
  it('before break-up the speed follows the drag-only analytic solution v = v0·exp(−3ρ(z)C_D·H / (4ρ_i·L0·sinθ)) (Collins eq. 8)', () => {
    // A strong, non-ablating body (no break-up, ablation off), fast (gravity negligible), 60°.
    const p = { ...resolveProjectile(spec({ diameter: 5 })), ablation: 0, strength: 1e12 };
    const stop = 20000;
    const e = integrateEntry(p, 20000, 60, stop);
    const analytic = 20000 * Math.exp((-3 * airDensity(stop) * CD * SCALE_HEIGHT) / (4 * p.density * p.diameter * Math.sin(Math.PI / 3)));
    expect(Math.abs(e.speed - analytic) / analytic).toBeLessThan(2e-3);
    expect(e.breakup).toBeNull();
  });

  it('break-up happens where the stagnation pressure ρ·v² first exceeds the strength; then the pancake spreads (airburst at L = 7·L0)', () => {
    const p = resolveProjectile(spec({ material: 'stony', diameter: 10 }));
    const e = integrateEntry(p, 18000, 45);
    expect(e.breakup).not.toBeNull();
    expect(e.breakup!.pressure).toBeGreaterThanOrEqual(p.strength);
    expect(e.breakup!.pressure).toBeLessThan(p.strength * 1.05);
    expect(e.airburst).not.toBeNull();
    expect(e.airburst!.altitude).toBeLessThan(e.breakup!.altitude);
  });

  it('a small strong body slows to its terminal speed and turns toward vertical (gravity bends the path)', () => {
    const p = resolveProjectile(spec({ diameter: 0.3 }));
    const e = integrateEntry(p, 15000, 30);
    const vt = Math.sqrt((2 * e.mass * GRAVITY) / (CD * airDensity(1500) * (Math.PI / 4) * e.diameter ** 2));
    expect(e.speed).toBeLessThan(1.2 * vt);
    expect(e.angle).toBeGreaterThan(80);
    void RHO0;
  });
});

describe('arc to the terrain', () => {
  it('meets the aim point exactly on level ground; a hill in the way intercepts it earlier (reported as a miss)', () => {
    const flat = flyArc({ aim: [10, -5], aimHeight: 0, speed: 3000, angle: 40, azimuth: 120, handover: 1500 }, () => 0);
    expect(flat.hit).toBe(true);
    expect(flat.miss).toBeLessThan(0.05);
    const [dx, dz] = bearingDir(120);
    // A 30 m ridge 40 m before the aim point, across the path.
    const ridge = (x: number, z: number) => { const s = (x - 10) * dx + (z + 5) * dz; return s > -45 && s < -35 ? 30 : 0; };
    const hill = flyArc({ aim: [10, -5], aimHeight: 0, speed: 3000, angle: 40, azimuth: 120, handover: 1500 }, ridge);
    expect(hill.point[1]).toBeCloseTo(30, 1);
    expect(hill.miss).toBeGreaterThan(30);
  });
});

describe('crater scaling', () => {
  const sand = MECHANICAL_PROFILES.denseGranular, rock = MECHANICAL_PROFILES.rock;
  it('gravity regime exponents: R ∝ a^(2/(2+μ))·U^(2μ/(2+μ)) (coupling parameter); strength regime: R ∝ a·U^μ', () => {
    const s = HH11.C4_sand, mu = s.mu;
    const R = (a: number, U: number) => scaledRadius(s, 'gravity', (4 / 3) * Math.PI * a ** 3 * 7800, a, 7800, 1800, U, 9.81);
    expect(Math.log(R(2, 5000) / R(1, 5000)) / Math.log(2)).toBeCloseTo(2 / (2 + mu), 6);
    expect(Math.log(R(1, 10000) / R(1, 5000)) / Math.log(2)).toBeCloseTo((2 * mu) / (2 + mu), 6);
    const r = HH11.C2_rock;
    const Rs = (a: number, U: number) => scaledRadius(r, 'strength', (4 / 3) * Math.PI * a ** 3 * 3000, a, 3000, 2400, U, 9.81);
    expect(Math.log(Rs(2, 5000) / Rs(1, 5000)) / Math.log(2)).toBeCloseTo(1, 6);
    expect(Math.log(Rs(1, 10000) / Rs(1, 5000)) / Math.log(2)).toBeCloseTo(r.mu, 6);
  });

  it('the smaller regime radius governs; weak soils are gravity-limited at metre scale, rock strength-limited', () => {
    const base = { mass: sphereMass(1, 3300), density: 3300, speed: 8000, angle: 90, g: 9.81 };
    const c = computeCrater({ ...base, target: MECHANICAL_PROFILES.cohesive });
    expect(c.regime).toBe('gravity');
    expect(c.radius).toBe(Math.min(c.radiusGravity, c.radiusStrength));
    const r = computeCrater({ ...base, target: rock });
    expect(r.regime).toBe('strength');
    expect(r.radiusStrength).toBeLessThan(r.radiusGravity);
    // Non-porous rock (μ = 0.55) grows faster with speed than porous sand (μ = 0.41): with the HH11
    // sets the two cross near 5 km/s (a property of the published constants, documented).
    const slow = { ...base, speed: 2000 };
    expect(computeCrater({ ...slow, target: rock }).radius).toBeLessThan(computeCrater({ ...slow, target: sand }).radius);
    expect(computeCrater({ ...base, speed: 20000, target: rock }).radius).toBeGreaterThan(computeCrater({ ...base, speed: 20000, target: sand }).radius);
  });

  it('oblique impacts use the vertical speed component: R(θ) = R(90°) at speed U·sinθ', () => {
    const base = { mass: sphereMass(1, 7800), density: 7800, g: 9.81, target: sand };
    const a = computeCrater({ ...base, speed: 8000, angle: 30 });
    const b = computeCrater({ ...base, speed: 8000 * Math.sin(Math.PI / 6), angle: 90 });
    expect(a.radius).toBeCloseTo(b.radius, 9);
    expect(computeCrater({ ...base, speed: 8000, angle: 10 }).oblique).toBe(true);
  });

  it('ejected mass M(<x) = k·ρ·(x³ − (n1·a)³) is capped by the bowl; launch speed falls with x and vanishes at n2·R', () => {
    const c = computeCrater({ mass: sphereMass(1, 3300), density: 3300, speed: 8000, angle: 90, g: 9.81, target: sand });
    expect(c.ejectedVolume).toBeLessThanOrEqual(c.volume);
    expect(c.displacedVolume).toBeCloseTo(c.volume - c.ejectedVolume, 9);
    const s = c.set;
    expect(ejectedMass(s, 2 * c.a, c.a, 1800)).toBeCloseTo(s.k * 1800 * ((2 * c.a) ** 3 - (s.n1 * c.a) ** 3), 6);
    const v1 = launchSpeed(s, 0.3 * c.radius, c.a, c.U, 1800, 3300, c.radius), v2 = launchSpeed(s, 0.6 * c.radius, c.a, c.U, 1800, 3300, c.radius);
    expect(v2).toBeLessThan(v1);
    expect(launchSpeed(s, s.n2 * c.radius, c.a, c.U, 1800, 3300, c.radius)).toBe(0);
  });
});

describe('ejecta parcels', () => {
  const sand = MECHANICAL_PROFILES.denseGranular;
  const crater = computeCrater({ mass: sphereMass(1, 3300), density: 3300, speed: 8000, angle: 90, g: 9.81, target: sand });
  const input = { crater, center: [0, 0, 0] as [number, number, number], delta: 3300, rho: sand.density, rock: false, angle: 90, azimuth: 0, seed: 7 };

  it('the parcels carry exactly the ejected mass; same seed → same parcels; another seed → different irregularity', () => {
    const a = generateParcels(input), b = generateParcels(input), c = generateParcels({ ...input, seed: 8 });
    const m = a.reduce((s, p) => s + p.mass, 0);
    expect(Math.abs(m - crater.ejectedVolume * sand.density) / m).toBeLessThan(1e-9);
    expect(a.map((p) => p.mass)).toEqual(b.map((p) => p.mass));
    expect(a.map((p) => p.mass)).not.toEqual(c.map((p) => p.mass));
  });

  it('flight: without drag (huge fragments) the range is the vacuum ballistic range v²·sin2θ/g; drag shortens it', () => {
    const [p] = generateParcels(input).filter((q) => q.ring === 8);
    const q = { ...p, size: 1e6 };
    fly(q, () => 0, { x0: -1e4, z0: -1e4, x1: 1e4, z1: 1e4 }, 1800);
    const range = Math.hypot(q.p1[0] - q.p0[0], q.p1[2] - q.p0[2]);
    expect(Math.abs(range - (p.speed * p.speed) / GRAVITY) / range).toBeLessThan(0.02);
    const r = { ...p };
    fly(r, () => 0, { x0: -1e4, z0: -1e4, x1: 1e4, z1: 1e4 }, 1800);
    expect(Math.hypot(r.p1[0] - r.p0[0], r.p1[2] - r.p0[2])).toBeLessThan(range);
  });

  it('oblique: more mass downrange than uprange below 45°', () => {
    const ps = generateParcels({ ...input, angle: 30, azimuth: 90 }); // travelling east (+x)
    const down = ps.filter((p) => p.v0[0] > 0).reduce((s, p) => s + p.mass, 0);
    const up = ps.filter((p) => p.v0[0] < 0).reduce((s, p) => s + p.mass, 0);
    expect(down).toBeGreaterThan(1.3 * up);
  });
});

describe('ground shock', () => {
  const s = createShock({ energy: 1e10, rho: 2000, c: 450, damping: 0.05, radius: 5 }, [0, 0], 1);
  it('energy flux: V(r) = √(E_s / (π·r²·ρ·c·τ))·exp(−πr/(Q·c·τ)), E_s = 1e-4·E; 1/r spreading', () => {
    const r = 40;
    const expected = Math.sqrt((SEISMIC_EFFICIENCY * 1e10) / (Math.PI * r * r * 2000 * 450 * s.tau)) * Math.exp((-Math.PI * r) / (s.Q * 450 * s.tau));
    expect(peakVelocity(s, r)).toBeCloseTo(expected, 12);
    const q = { ...s, Q: Infinity };
    expect(peakVelocity(q, 20) / peakVelocity(q, 40)).toBeCloseTo(2, 9);
  });

  it('the applied pulse keeps the peak velocity, is no shorter than 4 steps, arrives at r/c and returns the ground to rest', () => {
    expect(s.tauApplied).toBeGreaterThanOrEqual(4 / 60);
    const d: [number, number, number] = [0, 0, 0], v: [number, number, number] = [0, 0, 0], a: [number, number, number] = [0, 0, 0];
    const r = 40, arrive = 1 + r / 450;
    expect(addShock(s, r, 0, arrive - 0.01, d, v, a)).toBe(0);
    let vmax = 0;
    for (let t = arrive; t <= arrive + s.tauApplied; t += 1e-4) { d.fill(0); v.fill(0); a.fill(0); addShock(s, r, 0, t, d, v, a); vmax = Math.max(vmax, Math.abs(v[0])); }
    expect(vmax).toBeCloseTo(peakVelocity(s, r), 4);
    d.fill(0); v.fill(0); a.fill(0);
    addShock(s, r, 0, arrive + s.tauApplied, d, v, a);
    expect(Math.abs(d[0])).toBeLessThan(1e-9);
    expect(peakAcceleration(s, r, true)).toBeLessThanOrEqual(peakAcceleration(s, r));
  });
});

describe('plan', () => {
  it('energy partition closes: initial = atmosphere + seismic + ejecta kinetic + unresolved; nothing is called vaporized', () => {
    const t = createFlatTerrain();
    const p = planImpact(spec(), t, 3);
    const q = p.partition;
    expect(q.atmosphere + q.seismic + q.ejectaKinetic + q.unresolved).toBeCloseTo(q.initial, -2);
    expect(q.blast).toBe(0);
    expect(p.crater).not.toBeNull();
    expect(p.parcels.length).toBeGreaterThan(100);
  });

  it('is deterministic for the same spec, terrain and seed', () => {
    const t = createFlatTerrain();
    const a = planImpact(spec(), t, 3), b = planImpact(spec(), t, 3);
    expect(a.crater!.radius).toBe(b.crater!.radius);
    expect(a.parcels.map((p) => p.p1.join())).toEqual(b.parcels.map((p) => p.p1.join()));
  });

  it('the target material changes the crater: rock is strength-limited, sand gravity-limited, different radii', () => {
    const t = createFlatTerrain();
    t.soil.fill(1);
    const sand = planImpact(spec({ entry: 'direct', speed: 6000, material: 'stony', diameter: 0.5 }), t, 1, false);
    t.soil.fill(0);
    const rock = planImpact(spec({ entry: 'direct', speed: 6000, material: 'stony', diameter: 0.5 }), t, 1, false);
    expect(rock.crater!.regime).toBe('strength');
    expect(sand.crater!.regime).toBe('gravity');
    expect(rock.crater!.radius).not.toBeCloseTo(sand.crater!.radius, 1);
  });
});
