/**
 * Air-blast models (Phase 24, pure) against closed forms: Sedov–Taylor near field, weak-shock N-wave
 * decay and lengthening, Rankine–Hugoniot speed and reflection, Sachs scaling, 1/r impulse, energy
 * closure, exact pulse integrals (any step size), loads on boxes, SDOF response to triangular pulses,
 * ground reflection blend, shielding (never total), determinism.
 */
import { describe, expect, it } from 'vitest';
import { BETA, GAMMA, K_SEDOV, RadialTable, makeAmbient, reflectionFactor, shockSpeed, newSample, particleVelocity } from './source';
import { faceImpulse, impulse, impulseTo, peakOf, positiveImpulse, positiveImpulseOf, pressure, type Arrival } from './pulse';
import { BlastWave, ShieldIndex, insertionLoss, shielding, type WaveInit, NO_SHIELD } from './wave';
import { advanceSdof, boxFaces, faceLoads, freeAmplitude, netImpulse, newSdof } from './loads';
import { WaveLedger } from './ledger';
import { planBlast, BlastField, groundOf, shieldIndexOf } from './plan';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import type { BlastSpec } from './types';
import type { Vec3 } from '@/core/types';

const AIR = makeAmbient(101325, 1.225);
const table = (E: number, model: 'weakShock' | 'acoustic' = 'weakShock', reach = 400) =>
  new RadialTable({ energy: E, source: AIR, ground: AIR, height: 0, targetHeight: 0, targetDistance: 1, model, reach });
const flat = { sampleHeight: () => 0, data: { originX: -100, originZ: -100, nx: 201, nz: 201, cellSize: 1 } };
const world = { x0: -100, z0: -100, x1: 100, z1: 100, top: 150, bottom: 0 };
const wave = (x: Partial<WaveInit> = {}) => new BlastWave({ id: 'w', source: 'blast:p1', name: 'p1', kind: 'release', position: [0, 0, 0], time: 0, energy: 1e8, model: 'weakShock', waveform: 'nWave', ambient: AIR, groundY: 0, world, ...x });
const spec = (x: Partial<BlastSpec> = {}): BlastSpec => ({ event: 'blast', position: [0, 0], height: 0, energy: 1e8, model: 'weakShock', waveform: 'nWave', ...x });

describe('propagation model', () => {
  it('near field is the Sedov–Taylor strong blast Δp = K·E/r³ (K = 8ξ₀⁵/(25(γ+1)) ≈ 0.157)', () => {
    expect(K_SEDOV).toBeCloseTo(0.1568, 3);
    const t = table(1e9), s = newSample();
    for (const f of [0.1, 0.3, 0.6, 0.95]) {
      const r = f * t.rt;
      expect(t.at(r, s).dp / ((K_SEDOV * 1e9) / r ** 3)).toBeCloseTo(1, 3);
    }
    // r_t: where the strong-shock overpressure equals p₀; r_t/R₀ = K^(1/3) ≈ 0.54.
    expect(t.rt / t.R0).toBeCloseTo(Math.cbrt(K_SEDOV), 9);
    expect(t.at(t.rt, s).dp / AIR.p).toBeCloseTo(1, 3);
  });

  it('far field follows weak-shock theory: Δp = Δp_t(r_t/r)/√(1+σ), T = T_t√(1+σ), σ = βΔp_t r_t ln(r/r_t)/(ρc³T_t)', () => {
    const t = table(1e9), s = newSample();
    for (const r of [30, 60, 120, 300]) {
      const sig = (BETA * t.dpT * t.rt * Math.log(r / t.rt)) / (AIR.rho * AIR.c ** 3 * t.Tt);
      t.at(r, s);
      expect(s.dp / ((t.dpT * (t.rt / r)) / Math.sqrt(1 + sig))).toBeCloseTo(1, 3);
      expect(s.T / (t.Tt * Math.sqrt(1 + sig))).toBeCloseTo(1, 3);
      expect(s.energyLeft).toBeCloseTo(1 / Math.sqrt(1 + sig), 3);
    }
  });

  it('positive impulse decays exactly as 1/r in the weak-shock zone; acoustic keeps the shape and loses no energy', () => {
    const t = table(1e9), s = newSample();
    const I = (r: number) => { t.at(r, s); return 0.5 * s.dp * s.T * r; };
    expect(I(150) / I(40)).toBeCloseTo(1, 3);
    const a = table(1e9, 'acoustic');
    a.at(200, s);
    expect(s.T).toBeCloseTo(a.Tt, 9);
    expect(s.energyLeft).toBe(1);
    expect(s.dp * 200).toBeCloseTo(a.dpT * a.rt, 3);
  });

  it('arrival: Rankine–Hugoniot speed everywhere — acoustic far field travels at exactly c, the weak shock a little faster', () => {
    expect(shockSpeed(0, AIR.p, AIR.c)).toBe(AIR.c);
    // First order: U ≈ c(1 + (γ+1)Δp/(4γp)).
    const dp = 0.01 * AIR.p;
    expect(shockSpeed(dp, AIR.p, AIR.c) / AIR.c - 1).toBeCloseTo(((GAMMA + 1) * 0.01) / (4 * GAMMA), 4);
    const a = table(1e9, 'acoustic'), w = table(1e9), s = newSample();
    const ta = (tab: RadialTable, r: number) => tab.at(r, s).t;
    expect(ta(a, 300) - ta(a, 100)).toBeCloseTo(200 / AIR.c, 6);
    expect(ta(w, 300) - ta(w, 100)).toBeLessThan(200 / AIR.c);
    expect(ta(w, 300) - ta(w, 100)).toBeGreaterThan(0.98 * (200 / AIR.c));
    // Same inputs → same arrival, monotonic in r.
    let prev = -1;
    for (let r = 1; r < 300; r += 7) { const t = ta(w, r); expect(t).toBeGreaterThan(prev); prev = t; }
    expect(w.radiusAt(ta(w, 123.4))).toBeCloseTo(123.4, 2);
  });

  it('Sachs scaling: Δp/p₀ at r/R₀ fixed does not depend on E; thinner air spreads the same energy farther', () => {
    const s = newSample();
    const a = table(1e6), b = table(1e10);
    expect(a.at(3 * a.R0, s).dp).toBeCloseTo(b.at(3 * b.R0, newSample()).dp, 0);
    const thin = makeAmbient(50000, 0.6);
    const t = new RadialTable({ energy: 1e8, source: thin, ground: thin, height: 0, targetHeight: 0, targetDistance: 1, model: 'weakShock', reach: 400 });
    expect(t.R0).toBeGreaterThan(table(1e8).R0);
    expect(t.at(3 * t.R0, s).dp / thin.p).toBeCloseTo(table(1e8).at(3 * table(1e8).R0, newSample()).dp / AIR.p, 2);
  });

  it('the pulse energy follows from the closure (not chosen): ~30–45 % of E; the rest is near-source dissipation', () => {
    const t = table(1e9);
    expect(t.efficiency).toBeGreaterThan(0.25);
    expect(t.efficiency).toBeLessThan(0.5);
    expect(t.pulseEnergy).toBeCloseTo((8 * Math.PI / 3) * t.rt ** 2 * t.dpT ** 2 * t.Tt / (AIR.rho * AIR.c), 0);
  });

  it('Rankine–Hugoniot normal reflection 2 (weak) … 8 (strong); particle velocity → Δp/(ρc) for weak shocks', () => {
    expect(reflectionFactor(1, AIR.p)).toBeCloseTo(2, 4);
    expect(reflectionFactor(1e9, AIR.p)).toBeCloseTo(8, 2);
    expect(particleVelocity(10, AIR.p, AIR.rho) / (10 / (AIR.rho * AIR.c))).toBeCloseTo(1, 4);
  });
});

describe('pulse integrals', () => {
  const A: Arrival = { t: 0.0123, dp: 5000, T: 0.021, waveform: 'nWave' };
  it('exact impulse: N-wave net zero, positive phase ½ΔpT; any step size gives the same total', () => {
    expect(impulseTo(A, 1)).toBeCloseTo(0, 9);
    expect(impulse(A, 0, A.t + A.T)).toBeCloseTo(positiveImpulse(A), 9);
    const P: Arrival = { ...A, waveform: 'positive' };
    for (const dt of [1 / 30, 1 / 60, 1 / 240, 0.0071]) {
      let s = 0;
      for (let t = 0; t < 0.2; t += dt) s += impulse(P, t, t + dt);
      expect(s).toBeCloseTo(positiveImpulse(P), 10);
    }
    // Numerical check of the clearing integral.
    const C = 3.1, tc = 0.006;
    let num = 0;
    const h = 1e-6;
    for (let t = 0; t < 0.1; t += h) {
      const tau = t + h / 2 - A.t;
      const p = pressure(A, t + h / 2);
      num += p * (1 + (C - 1) * Math.max(0, 1 - tau / tc)) * h;
    }
    expect(faceImpulse(A, C, tc, 0, 0.1)).toBeCloseTo(num, 4);
  });

  it('superposition: peak and positive impulse of overlapping waves', () => {
    const a: Arrival = { t: 0, dp: 1000, T: 0.02, waveform: 'positive' };
    const b: Arrival = { t: 0.01, dp: 1000, T: 0.02, waveform: 'positive' };
    expect(peakOf([a, b])).toBeCloseTo(1500, 6);
    expect(positiveImpulseOf([a, b])).toBeCloseTo(20, 6);
    // Separated waves: impulses add.
    expect(positiveImpulseOf([a, { ...b, t: 1 }])).toBeCloseTo(20, 6);
  });
});

describe('loads', () => {
  it('a closed box in a uniform pressure feels no net force; a passing plane wave pushes along k (diffraction) and an N-wave pulls back', () => {
    const faces = boxFaces([0, 0, 0], [2, 2, 2], [0, 0, 0, 1]);
    const loads: Parameters<typeof netImpulse>[1][number][] = [];
    const J: Vec3 = [0, 0, 0], L: Vec3 = [0, 0, 0];
    faceLoads(faces, (_p, out) => out.push({ t: 0, dp: 1000, T: 0.01, waveform: 'positive', k: [1, 0, 0], path: 'direct', zone: 'weak', p: AIR.p }), AIR.c, loads);
    // All faces loaded at once, reflection on the front face only → net +x (front reflection); clearing.
    netImpulse(faces, loads, 0, 1, J, L, true);
    expect(J[0]).toBeGreaterThan(0);
    // Plane wave along +x: each face loaded at its own arrival (x/c); side-on (no reflection) for this check.
    const plane = (p: Vec3, out: { t: number }[]) => (out as unknown as object[]).push({ t: (p[0] + 1) / AIR.c, dp: 1000, T: 0.01, waveform: 'positive', k: [1, 0, 0], path: 'direct', zone: 'weak', p: AIR.p });
    faceLoads(faces, plane as never, AIR.c, loads);
    for (const l of loads) l.C = 1;
    // Side-on only: while the wave crosses (τ = D/c) the front face alone is loaded …
    const tau = 2 / AIR.c;
    netImpulse(faces, loads, 0, tau, J, L, true);
    expect(J[0]).toBeCloseTo(4 * 1000 * (tau - (tau * tau) / (2 * 0.01)), 3);
    expect(Math.abs(J[2])).toBeLessThan(1e-9);
    // … but over the whole passage the back face takes the same impulse back: net zero. A net push
    // needs front-face reflection (or drag) — exactly as the physics says.
    netImpulse(faces, loads, 0, 1, J, L, true);
    expect(Math.abs(J[0])).toBeLessThan(1e-9);
    faceLoads(faces, plane as never, AIR.c, loads);
    netImpulse(faces, loads, 0, 1, J, L, true);
    expect(J[0]).toBeGreaterThan(0);
    const nw = (p: Vec3, out: object[]) => out.push({ t: (p[0] + 1) / AIR.c, dp: 1000, T: 0.01, waveform: 'nWave', k: [1, 0, 0], path: 'direct', zone: 'weak', p: AIR.p });
    faceLoads(faces, nw as never, AIR.c, loads);
    for (const l of loads) l.C = 1;
    netImpulse(faces, loads, 0, 1, J, L, true);
    expect(Math.abs(J[0])).toBeLessThan(1e-9);
  });

  it('SDOF matches the closed-form undamped response to a triangular pulse (impulsive and quasi-static ranges), with 60 Hz steps', () => {
    // Exact peak of x'' + ω²x = ω²·(1 − t/td) for 0 ≤ t ≤ td, free vibration after.
    const exactPeak = (Tn: number, td: number) => {
      const w = (2 * Math.PI) / Tn;
      let best = 0;
      for (let t = 0; t <= td + Tn; t += Tn / 4000) {
        let x: number;
        if (t <= td) x = 1 - Math.cos(w * t) + Math.sin(w * t) / (w * td) - t / td;
        else {
          const x1 = 1 - Math.cos(w * td) + Math.sin(w * td) / (w * td) - 1;
          const v1 = w * Math.sin(w * td) + Math.cos(w * td) / td - 1 / td;
          x = x1 * Math.cos(w * (t - td)) + (v1 / w) * Math.sin(w * (t - td));
        }
        best = Math.max(best, Math.abs(x));
      }
      return best;
    };
    for (const [Tn, td] of [[0.5, 0.005], [0.015, 0.02], [0.05, 0.3], [0.02, 0.004]]) {
      const s = newSdof(Tn, 1);
      const a: Arrival = { t: 0.003, dp: 1, T: td, waveform: 'positive' };
      for (let t = 0; t < td + 2 * Tn + 0.05; t += 1 / 60) advanceSdof(s, (u, v) => impulse(a, u, v), t, t + 1 / 60);
      expect(Math.max(s.peak, freeAmplitude(s)) / exactPeak(Tn, td)).toBeCloseTo(1, 1);
    }
  });
});

describe('geometry: ground reflection and shielding', () => {
  it('surface release = hemispherical wave of 2E; elevated release = direct + image (doubling at the ground); continuous blend', () => {
    const surf = wave(), out: never[] = [];
    expect(surf.w).toBe(0);
    expect(surf.hemi!.input.energy).toBe(2e8);
    const high = wave({ position: [0, 300, 0] });
    expect(high.w).toBe(1);
    const c = high.contributions([0, 0, 50], NO_SHIELD, []);
    expect(c.map((x) => x.path)).toEqual(['direct', 'image']);
    expect(c[0].dp).toBeCloseTo(c[1].dp, 6);
    expect(Math.abs(c[0].t - c[1].t)).toBeLessThan(1e-9);
    // Blend: overpressure at a ground point changes continuously with the release height.
    let prev = NaN;
    for (let h = 0; h <= 30; h += 0.25) {
      const p = peakOf(wave({ position: [0, h, 0] }).contributions([60, 1, 0], NO_SHIELD, []));
      if (prev === prev) expect(Math.abs(p - prev) / prev).toBeLessThan(0.06);
      prev = p;
    }
    void out;
  });

  it('insertion loss: 5 dB at grazing, growing with the path difference, capped at 20 dB — never a total block', () => {
    expect(insertionLoss(0)).toBe(0);
    expect(insertionLoss(1e-6)).toBeCloseTo(5, 1);
    expect(insertionLoss(1)).toBeGreaterThan(insertionLoss(0.1));
    expect(insertionLoss(1e6)).toBe(20);
  });

  it('a ridge between source and receiver attenuates and delays the wave; a building shields the one behind it', () => {
    const ridge = { sampleHeight: (x: number) => (Math.abs(x - 50) < 5 ? 15 : 0), data: flat.data };
    const s: Vec3 = [0, 0.5, 0], p: Vec3 = [100, 1.5, 0];
    const sh = shielding(s, p, 0.02, AIR.c, ridge, null);
    expect(sh.kind).toBe('terrain');
    expect(sh.factor).toBeLessThan(0.6);
    expect(sh.factor).toBeGreaterThanOrEqual(0.1);
    expect(sh.delay).toBeGreaterThan(0);
    expect(shielding(s, p, 0.02, AIR.c, flat, null)).toBe(NO_SHIELD);
    const doc = createEmptyDocument('t');
    const b = createWorldObject({ type: 'building', transform: { position: [50, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }, 1);
    doc.objects[b.id] = b;
    const idx = shieldIndexOf(Object.values(doc.objects));
    const bs = shielding(s, p, 0.02, AIR.c, flat, idx);
    expect(bs.kind).toBe('building');
    expect(bs.by).toBe(b.id);
    // The building does not shield itself (its own faces are handled by orientation).
    expect(shielding(s, [50, 1.5, 0], 0.02, AIR.c, flat, idx, b.id).kind).toBe('direct');
    expect(new ShieldIndex([]).along(0, 0, 10, 0, [])).toEqual([]);
  });
});

describe('ledger and plan', () => {
  it('the energy ledger closes exactly at every time; late on everything has left the world or was dissipated', () => {
    for (const w of [wave(), wave({ position: [30, 40, -20] }), wave({ model: 'acoustic' })]) {
      const L = new WaveLedger(w);
      for (const t of [0, 0.05, 0.2, 0.5, 2]) {
        const e = L.at(t);
        expect(Math.abs(e.residual)).toBeLessThan(1e-9 * e.input);
        expect(e.nearSource).toBeGreaterThan(0);
      }
      const late = L.at(5);
      expect(late.inTransit).toBe(0);
      expect(late.leftWorld + late.dissipated).toBeCloseTo(late.pulse, 3);
      if (w.init.model === 'acoustic') expect(late.dissipated).toBeCloseTo(0, 6);
    }
  });

  it('the plan is deterministic and reports the validity radius and warnings; the field arrivals match the tables', () => {
    const doc = createEmptyDocument('t');
    const a = planBlast(spec({ energy: 1e9 }), doc.terrain), b = planBlast(spec({ energy: 1e9 }), doc.terrain);
    expect(a.validRadius).toBe(b.validRadius);
    expect(a.validRadius).toBeGreaterThan(a.rt);
    expect(a.warnings.map((w) => w.key)).toContain('blast.warn.near');
    const f = new BlastField([a.wave], groundOf(doc.terrain), null, 10);
    const i = f.indexAt(60, 0);
    const r = Math.hypot(60, 1.5);
    expect(f.arrival[i]).toBeCloseTo(a.wave.sample(r).t, 6);
    expect(f.peak[i] / a.wave.sample(r).dp).toBeCloseTo(1, 6);
    expect(f.pressureAt(i, f.arrival[i] + 1e-6)).toBeCloseTo(f.peak[i], 0);
    expect(f.pressureAt(i, f.arrival[i] - 1e-6)).toBe(0);
  });
});
