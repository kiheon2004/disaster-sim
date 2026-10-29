/**
 * Phase 31 audit (H1 / H3 / M4): the gravity energy / momentum ledger of the runtime against an INDEPENDENT reference.
 *
 * The runtime (pre → physics step → post) is driven with a minimal stand-in engine (semi-implicit Euler — the scheme
 * Rapier uses: v₁ = v₀ + a·dt, x₁ = x₀ + v₁·dt — no contacts, no damping unless a scene adds them), so every term has
 * a closed form or a separate computation from the trajectory with potentials written out here (never the field's or
 * the ledger's own functions):
 *   - free flight: the only force is gravity, so the work of every OTHER force is exactly 0;
 *   - W_field = Σ m·(Φ(x, t) − Φ(x, t − dt)) at the body's position, from the analytic Φ of each scene;
 *   - the integrator's own energy error (semi-implicit Euler) is booked as such and vanishes as dt → 0;
 *   - bodies entering / leaving (also between the field step and the ledger step) carry their K and U across.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { BodyHandle, PhysicsEngine } from '@/physics/PhysicsEngine';
import { GravityChannel } from './GravityChannel';
import { GravityRuntime } from './runtime';
import { ForceLedger } from '../forces/ForceLedger';
import type { SystemContext } from '../systems/SimulationSystem';
import { defaultGravitySpec, type GravitySourceSpec, type GravitySpec } from '@/gravity/types';

const G0 = 9.81;

interface Body { m: number; x: Vec3; v: Vec3; F: Vec3; floor: number | null }

/** Semi-implicit Euler stand-in for the parts of PhysicsEngine the runtime uses. */
class Engine {
  bodies = new Map<number, Body>();
  G: Vec3 = [0, -G0, 0];
  next = 1;
  add(m: number, x: Vec3, v: Vec3 = [0, 0, 0], floor: number | null = null): BodyHandle {
    const h = this.next++;
    this.bodies.set(h, { m, x: [...x], v: [...v], F: [0, 0, 0], floor });
    return h as BodyHandle;
  }
  setGravity(g: Readonly<Vec3>) { this.G = [g[0], g[1], g[2]]; }
  getMass(h: BodyHandle) { return this.bodies.get(h as number)?.m ?? 0; }
  hasBody(h: BodyHandle) { return this.bodies.has(h as number); }
  removeBody(h: BodyHandle) { this.bodies.delete(h as number); }
  readMotion(h: BodyHandle, pos: Float64Array, vel: Float64Array, o: number) {
    const b = this.bodies.get(h as number);
    if (!b) { pos[o] = pos[o + 1] = pos[o + 2] = 0; vel[o] = vel[o + 1] = vel[o + 2] = 0; return; }
    for (let i = 0; i < 3; i++) { pos[o + i] = b.x[i]; vel[o + i] = b.v[i]; }
  }
  addForce(h: BodyHandle, f: Vec3) { const b = this.bodies.get(h as number); if (b) for (let i = 0; i < 3; i++) b.F[i] += f[i]; }
  setContactForceThreshold() {}
  wake() {}
  step(dt: number) {
    for (const b of this.bodies.values()) {
      for (let i = 0; i < 3; i++) { b.v[i] += (this.G[i] + b.F[i] / b.m) * dt; b.x[i] += b.v[i] * dt; b.F[i] = 0; }
      // Inelastic floor (a contact: its work is the body's lost kinetic energy).
      if (b.floor !== null && b.x[1] < b.floor) { b.x[1] = b.floor; b.v[1] = 0; }
    }
  }
}

interface Entity { id: string; dynamic: boolean; body: BodyHandle | null; forces?: Float64Array; modular?: undefined; flags: Record<string, boolean> }

class Harness {
  readonly eng = new Engine();
  readonly ch = new GravityChannel();
  readonly entities = new Map<string, Entity>();
  readonly debris: { body: BodyHandle }[] = [];
  readonly forces: ForceLedger;
  rt!: GravityRuntime;
  time = 0;
  step = 0;
  /** Systems between the field step and the physics step (pre) and after the ledger (post). */
  between: ((h: Harness) => void) | null = null;
  constructor(readonly dt: number) {
    this.forces = new ForceLedger(this.eng as unknown as PhysicsEngine);
  }
  experiment(p: Partial<GravitySpec>, start = 0, id = 'g') {
    this.ch.add({ ...defaultGravitySpec(), scenario: 'custom', profile: 'constant', duration: 1e6, end: 'hold', ...p }, start, id);
  }
  body(id: string, m: number, x: Vec3, v: Vec3 = [0, 0, 0], floor: number | null = null) {
    const h = this.eng.add(m, x, v, floor);
    this.entities.set(id, { id, dynamic: true, body: h, flags: {} });
    return h;
  }
  private ctx(): SystemContext {
    return { time: this.time, step: this.step, physics: this.eng as unknown as PhysicsEngine, forces: this.forces, runtime: { entities: this.entities, debris: this.debris } as never } as unknown as SystemContext;
  }
  advance(steps: number) {
    for (let k = 0; k < steps; k++) {
      this.forces.beginStep(this.step);
      const ctx = this.ctx();
      (this.rt ??= new GravityRuntime(this.ch)).pre(ctx);
      this.between?.(this);
      this.eng.step(this.dt);
      this.rt.post(ctx, this.dt);
      this.time += this.dt;
      this.step++;
    }
  }
  get b() { return this.rt.balance(); }
}

/** Steps of dt covering T seconds. */
const N = (T: number, dt: number) => Math.round(T / dt);

describe('gravity ledger vs an independent reference (H1)', () => {
  it('1 resting body, constant gravity: no work, no field work, nothing else', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: 2 * G0 });
    h.body('a', 10, [0, 2, 0], [0, 0, 0], 2);
    h.advance(120);
    const b = h.b;
    expect(b.workGravity).toBe(0);
    expect(b.workField).toBe(0);
    expect(b.workOther).toBe(0);
    expect(b.fieldResidual).toBe(0);
  });

  it('2 free fall, constant gravity: the work of every other force is 0; the energy error is the integrator\'s and is O(dt)', () => {
    const err: number[] = [];
    for (const dt of [1 / 60, 1 / 120, 1 / 240]) {
      const h = new Harness(dt);
      h.experiment({ magnitude: 3.71 });
      const m = 7, g = 3.71, T = 2;
      h.body('a', m, [0, 100, 0]);
      h.advance(N(T, dt));
      const b = h.b;
      // Closed form of semi-implicit Euler from rest: v_n = n·g·dt, K_n + U_n − (K_0 + U_0) = −½·m·g²·dt²·n.
      const n = N(T, dt);
      const drift = -0.5 * m * g * g * dt * dt * n;
      expect(b.workOther).toBeCloseTo(0, 9);
      expect(b.fieldResidual).toBeCloseTo(0, 9);
      expect(b.integratorResidual).toBeCloseTo(-drift, 9);
      expect(b.energyResidual).toBeCloseTo(drift, 9);
      expect(b.kinetic + b.potential - (0 + m * -(-g) * 100)).toBeCloseTo(drift, 7);
      err.push(Math.abs(b.energyResidual));
    }
    expect(err[0] / err[1]).toBeCloseTo(2, 6);
    expect(err[1] / err[2]).toBeCloseTo(2, 6);
  });

  it('3 resting body under a gravity ramp: W_field = m·(g₁ − g₀)·h exactly (Φ = −G·x), ΔU = W_field', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: 2 * G0, profile: 'linear', ramp: 2, duration: 10 }, 1);
    // Resting on a ledge at y = 5 m (an inelastic floor: the support keeps it still).
    h.body('a', 4, [0, 5, 0], [0, 0, 0], 5);
    h.advance(N(4, h.dt));
    const b = h.b;
    // Φ = g·y: from 1 g to 2 g at y = 5 m.
    expect(b.workField).toBeCloseTo(4 * (2 * G0 - G0) * 5, 9);
    expect(b.potential - 4 * G0 * 5).toBeCloseTo(b.workField, 9);
    expect(b.workGravity).toBe(0);
    expect(b.workMoved).toBe(0);
  });

  it('4 a moving body under a ramp: W_field from the analytic ∂Φ/∂t along its own trajectory; other work 0', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: 0.5 * G0, direction: [1, -1, 0], profile: 'linear', ramp: 3, duration: 10 });
    h.body('a', 3, [0, 50, 0], [2, 8, -1]);
    const Gat = (t: number): Vec3 => {
      const s = Math.min(1, Math.max(0, t / 3)), d = 0.5 * G0 / Math.SQRT2;
      return [s * d, -G0 + s * (-d + G0), 0];
    };
    let ref = 0, x: Vec3 = [0, 50, 0];
    for (let k = 0; k < 240; k++) {
      if (k > 0) { const a = Gat(h.time), b0 = Gat(h.time - h.dt); ref += 3 * -((a[0] - b0[0]) * x[0] + (a[1] - b0[1]) * x[1] + (a[2] - b0[2]) * x[2]); }
      h.advance(1);
      x = [...h.eng.bodies.get(1)!.x];
    }
    const b = h.b;
    expect(b.workField).toBeCloseTo(ref, 7);
    expect(b.workOther).toBeCloseTo(0, 9);
    expect(b.fieldResidual).toBeCloseTo(0, 7);
  });

  const steps: [string, Partial<GravitySpec>[]][] = [
    ['5 1 g → 3 g', [{ magnitude: 3 * G0 }]],
    ['6 3 g → 0 g', [{ magnitude: 3 * G0 }, { magnitude: 0 }]],
    ['7 reversal', [{ magnitude: G0, direction: [0, 1, 0] }]],
    ['8 pulse', [{ magnitude: 2 * G0, profile: 'pulse', period: 1, pulseWidth: 0.4, ramp: 0, duration: 10, end: 'restore' }]],
  ];
  for (const [name, specs] of steps) {
    it(`${name}: field work = Σ m·ΔΦ at the jumps; other work 0; uniform field check exact`, () => {
      const h = new Harness(1 / 60);
      specs.forEach((s, i) => h.experiment(s, 0.5 + i, `g${i}`));
      h.body('a', 2, [3, 20, -1], [1, 0, 0]);
      h.body('b', 5, [-4, 30, 2], [0, 3, 0]);
      let ref = 0;
      let prevG: Vec3 = [0, -G0, 0];
      for (let k = 0; k < 240; k++) {
        // The field of this step (the runtime prepares it in pre); reference ∂Φ/∂t from the change of G at the bodies.
        const f = h.ch.field!.prepare(h.time);
        const G: Vec3 = [f.G[0], f.G[1], f.G[2]];
        if (k > 0) for (const [, e] of h.entities) { const bd = h.eng.bodies.get(e.body as number)!; ref += bd.m * -((G[0] - prevG[0]) * bd.x[0] + (G[1] - prevG[1]) * bd.x[1] + (G[2] - prevG[2]) * bd.x[2]); }
        prevG = G;
        h.advance(1);
      }
      const b = h.b;
      expect(b.workField).toBeCloseTo(ref, 8);
      expect(b.workOther).toBeCloseTo(0, 9);
      expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-9);
    });
  }

  /** Linear-law radial source without taper: a(r) = S·r/r0 inward, Φ(r) = S·(r² − R²)/(2·r0) inside R. */
  const radial = (p: Partial<GravitySourceSpec> = {}): GravitySourceSpec => ({ kind: 'radial', center: [0, 0, 0], radius: 200, falloff: 'none', strength: 4, r0: 10, law: 'linear', softening: 0, ...p });
  const phiRadial = (x: Readonly<Vec3>, S: number, r0 = 10, R = 200, c: Vec3 = [0, 0, 0]) => {
    const r2 = (x[0] - c[0]) ** 2 + (x[1] - c[1]) ** 2 + (x[2] - c[2]) ** 2;
    return r2 >= R * R ? 0 : (S * (r2 - R * R)) / (2 * r0);
  };

  it('9 radial conservative field (orbit in a harmonic well): other work 0; field check O(dt) and → 0', () => {
    const res: number[] = [];
    for (const dt of [1 / 60, 1 / 120, 1 / 240]) {
      const h = new Harness(dt);
      h.experiment({ magnitude: 0, sources: [radial()] });
      h.body('a', 1, [20, 0, 0], [0, 0, 5]);
      h.advance(N(8, dt));
      const b = h.b;
      expect(b.workOther).toBeCloseTo(0, 8);
      // Gross work as the scale of the check (the net work of a closed orbit is ≈ 0: a relative residual on it is meaningless).
      expect(b.workGravityGross).toBeGreaterThan(Math.abs(b.workGravity));
      res.push(Math.abs(b.energyResidual) / b.workGravityGross);
    }
    expect(res[0]).toBeLessThan(0.05);
    expect(res[0] / res[1]).toBeGreaterThan(1.7);
    expect(res[1] / res[2]).toBeGreaterThan(1.7);
  });

  it('10 radial field whose strength ramps: W_field = Σ m·ΔS·∂Φ/∂S along the trajectory', () => {
    const h = new Harness(1 / 120);
    h.experiment({ global: false, profile: 'linear', ramp: 2, duration: 100, sources: [radial({ followProfile: true })] });
    h.body('a', 2, [15, 0, 0], [0, 3, 1]);
    let ref = 0, x: Vec3 = [15, 0, 0];
    const S = (t: number) => 4 * Math.min(1, Math.max(0, t / 2));
    for (let k = 0; k < N(5, h.dt); k++) {
      if (k > 0) ref += 2 * (phiRadial(x, S(h.time)) - phiRadial(x, S(h.time - h.dt)));
      h.advance(1);
      x = [...h.eng.bodies.get(1)!.x];
    }
    const b = h.b;
    expect(b.workField).toBeCloseTo(ref, 6);
    expect(b.workOther).toBeCloseTo(0, 8);
    expect(Math.abs(b.energyResidual)).toBeLessThan(0.02 * b.workGravityGross);
  });

  it('11 local region (not curl-free): no potential is invented; path work is the force integral; other work 0', () => {
    const h = new Harness(1 / 60);
    const src: GravitySourceSpec = { kind: 'region', center: [0, 0, 0], radius: 30, falloff: 'smooth', edge: 10, mode: 'add', accel: [3, 0, 0] };
    h.experiment({ global: false, sources: [src] });
    h.body('a', 4, [-25, 100, 0], [6, 0, 0]);
    // Reference path work: m·g(x₀)·Δx with the region's acceleration written out (smoothstep taper).
    const w = (d: number) => (d >= 30 ? 0 : d <= 20 ? 1 : ((u) => u * u * u * (u * (6 * u - 15) + 10))((30 - d) / 10));
    let ref = 0;
    for (let k = 0; k < 300; k++) {
      const x0 = [...h.eng.bodies.get(1)!.x];
      h.advance(1);
      const x1 = h.eng.bodies.get(1)!.x;
      const ww = w(Math.hypot(...x0));
      ref += 4 * (3 * ww * (x1[0] - x0[0]) + -G0 * (x1[1] - x0[1]));
    }
    const b = h.b;
    expect(Number.isNaN(b.potential)).toBe(true);
    expect(Number.isNaN(b.fieldResidual)).toBe(true);
    expect(b.workGravity).toBeCloseTo(ref, 7);
    expect(b.workOther).toBeCloseTo(0, 8);
  });

  it('12/13 a region source switches on and off: the potential comes back after it; the books close on every step with Φ', () => {
    const h = new Harness(1 / 60);
    const src: GravitySourceSpec = { kind: 'region', center: [0, 0, 0], radius: 500, falloff: 'none', mode: 'add', accel: [0, 0, 2] };
    h.experiment({ global: false, duration: 1, end: 'restore', sources: [src] }, 1);
    h.body('a', 3, [0, 100, 0], [1, 0, 0]);
    h.advance(60);
    expect(Number.isFinite(h.b.potential)).toBe(true);
    h.advance(60);
    expect(Number.isNaN(h.b.potential)).toBe(true);
    h.advance(60);
    const b = h.b;
    // Φ defined again (gauge −G·x): U = m·g·y.
    expect(b.potential).toBeCloseTo(3 * G0 * h.eng.bodies.get(1)!.x[1], 6);
    expect(Number.isFinite(b.fieldResidual)).toBe(true);
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-9);
    expect(b.potentialGaps).toBe(1);
    expect(b.workOther).toBeCloseTo(0, 8);
  });

  it('13b a radial source ends (restore): its potential jump is field work at the body', () => {
    const h = new Harness(1 / 60);
    h.experiment({ global: false, duration: 1, end: 'restore', sources: [radial()] }, 0);
    h.body('a', 2, [10, 0, 0]);
    let ref = 0, x: Vec3 = [10, 0, 0], prev = 0;
    for (let k = 0; k < 120; k++) {
      const S = h.time < 1 ? 4 : 0;
      const phi = (y: Vec3) => phiRadial(y, S) - -G0 * y[1];
      if (k > 0) ref += 2 * (phi(x) - prev);
      h.advance(1);
      x = [...h.eng.bodies.get(1)!.x];
      prev = phi(x);
    }
    expect(h.b.workField).toBeCloseTo(ref, 6);
  });

  it('14 several sources compose (two radial + a global ramp): other work 0, field check → 0 with dt', () => {
    const res: number[] = [];
    for (const dt of [1 / 60, 1 / 240]) {
      const h = new Harness(dt);
      h.experiment({ magnitude: 0.3 * G0, profile: 'smooth', ramp: 2, duration: 50, sources: [radial(), radial({ center: [30, 0, 0], strength: -2, r0: 15, radius: 60 })] });
      h.body('a', 1, [10, 5, 0], [0, 2, 4]);
      h.body('b', 3, [25, -5, 3], [-1, 0, 0]);
      h.advance(N(4, dt));
      const b = h.b;
      expect(b.workOther).toBeCloseTo(0, 8);
      res.push(Math.abs(b.energyResidual) / b.workGravityGross);
    }
    expect(res[0] / res[1]).toBeGreaterThan(3);
  });
});

describe('displacements outside the integrator (H1)', () => {
  it('a body moved between steps (a rubble heap lifting it, pose sync) under a CONSTANT field: no field work; the move is booked as such', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: 2 * G0 });
    h.body('a', 5, [0, 50, 0]);
    h.advance(30);
    // After the ledger step and before the next field step: lifted by 3 m (setBodyPose).
    h.eng.bodies.get(1)!.x[1] += 3;
    h.advance(30);
    const b = h.b;
    expect(b.workField).toBe(0);
    expect(b.workMoved).toBeCloseTo(5 * 2 * G0 * 3, 6);
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-8);
    expect(b.workOther).toBeCloseTo(0, 8);
  });

  it('the same move under a ramp: field work at the new position only (Φ at the old time evaluated there)', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: 3 * G0, profile: 'linear', ramp: 2, duration: 100 });
    h.body('a', 1, [0, 80, 0]);
    h.advance(30);
    const t1 = h.time - h.dt;
    const g = (t: number) => G0 + 2 * G0 * Math.min(1, t / 2);
    h.eng.bodies.get(1)!.x[1] += 4;
    h.advance(1);
    const b = h.b;
    // The move happened while the field was that of the last step (t₁).
    expect(b.workMoved).toBeCloseTo(g(t1) * 4, 6);
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-8);
  });
});

describe('bodies entering and leaving the ledger (H3)', () => {
  it('15 bodies spawned and removed during a ramp carry their K and U across; the books stay closed', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: 2 * G0, profile: 'linear', ramp: 2, duration: 100 });
    h.body('a', 2, [0, 100, 0]);
    h.advance(30);
    h.body('b', 5, [5, 80, 0], [0, 4, 0]);
    h.advance(30);
    const out = h.eng.bodies.get(1)!;
    const kOut = 0.5 * out.m * (out.v[0] ** 2 + out.v[1] ** 2 + out.v[2] ** 2);
    h.entities.delete('a');
    h.eng.removeBody(1 as BodyHandle);
    h.advance(30);
    const b = h.b;
    expect(b.bodies).toBe(1);
    expect(b.workOther).toBeCloseTo(0, 8);
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-8);
    expect(b.boundaryKinetic).toBeCloseTo(0.5 * 5 * 16 - kOut, 8);
  });

  it('a body removed AFTER the field step and BEFORE the ledger step (prePhysics recycling) leaves with its pre-step state — no phantom work', () => {
    const run = (remove: boolean) => {
      const h = new Harness(1 / 60);
      h.experiment({ magnitude: 1.5 * G0 });
      h.body('a', 2, [0, 100, 0]);
      h.body('b', 3, [40, 60, 0]);
      h.advance(20);
      if (remove) {
        h.between = (hh) => { hh.eng.removeBody(2 as BodyHandle); hh.entities.delete('b'); hh.between = null; };
      }
      h.advance(40);
      return h.b;
    };
    const kept = run(false), gone = run(true);
    // Body a alone moves identically in both runs; the removed body only stops contributing.
    expect(gone.workOther).toBeCloseTo(0, 8);
    expect(Math.abs(gone.fieldResidual)).toBeLessThan(1e-8);
    expect(gone.workGravity).toBeLessThan(kept.workGravity);
    expect(gone.workGravity).toBeGreaterThan(0);
    expect(gone.bodies).toBe(1);
  });

  it('dynamic → fixed (held) → dynamic: K leaves with the body, re-enters at rest; mass is never counted twice', () => {
    const h = new Harness(1 / 60);
    h.experiment({ magnitude: G0 });
    h.body('a', 2, [0, 100, 0]);
    h.advance(30);
    const e = h.entities.get('a')!;
    e.dynamic = false;
    h.advance(10);
    expect(h.b.bodies).toBe(0);
    const bd = h.eng.bodies.get(1)!;
    bd.v = [0, 0, 0];
    e.dynamic = true;
    h.advance(10);
    const b = h.b;
    expect(b.bodies).toBe(1);
    // In the stand-in a 'fixed' entity is still integrated (only its ledger membership changes): the books close anyway.
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-8);
  });
});
