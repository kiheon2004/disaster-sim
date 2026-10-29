/**
 * Phase 32.1: the orbit integrator replaces Rapier's gravity increment of a free body assuming Rapier's measured
 * response to a constant acceleration in one step (RapierEngine.freeKappa): x₁ = x₀ + v₀·dt + κ·g·dt², κ = (n + 1)/(2n)
 * for n solver iterations, and v₁ = (v₀ + g·dt)/(1 + d·dt). An empirical property of Rapier 0.21 — a version that
 * integrates differently must fail here, not shift orbits silently. Independent of mass and damping; positions near
 * the origin (f32 rounding of the displacement far below the tolerance).
 */
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { RapierEngine } from './RapierEngine';

describe("Rapier's free-body step (κ of the orbit integrator)", () => {
  it('matches κ = (n + 1)/(2n) and the damped velocity for every mass, damping, initial velocity and dt', async () => {
    const e = new RapierEngine();
    await e.init(9.81);
    const kappa = e.freeKappa();
    e.dispose();
    for (const dt of [1 / 60, 1 / 120]) for (const m of [1, 100, 1e4]) for (const d of [0, 0.05, 0.5]) for (const v0 of [0, 7]) {
      const g = -24.5;
      const w = new RAPIER.World({ x: 0, y: g, z: 0 });
      w.timestep = dt;
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.5, 0).setLinvel(v0, v0, 0).setLinearDamping(d));
      w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setMass(m), b);
      const x0 = b.translation().y, vy0 = b.linvel().y;
      w.step();
      const k = (b.translation().y - x0 - vy0 * dt) / (g * dt * dt);
      expect(Math.abs(k - kappa)).toBeLessThan(2e-3);
      expect(Math.abs(b.linvel().y - (vy0 + g * dt) / (1 + d * dt))).toBeLessThan(1e-5);
      w.free();
    }
  });
});
