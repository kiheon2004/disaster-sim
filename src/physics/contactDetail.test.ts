/**
 * Phase 33: contact events with detail and explicit mass properties. Independent expectations: the momentum balance of a
 * body landing on the ground (Σ F·dt over the contact steps = m Δv − m g t, the impulse-momentum theorem), the contact point
 * on the face that landed, and the angular response ω = L / I of the declared principal moments.
 */
import { describe, expect, it } from 'vitest';
import { RapierEngine } from './RapierEngine';

describe('contact detail and mass properties (Phase 33)', () => {
  it('a landing body: the reported force pushes it up, Σ F·dt balances its momentum change, the point lies on its bottom face', async () => {
    const e = new RapierEngine();
    await e.init(9.81, null);
    const m = 70, dt = 1 / 60;
    const h = e.createBody({
      kind: 'dynamic', position: [0, 3, 0], quaternion: [0, 0, 0, 1], mass: m, friction: 0.6, restitution: 0,
      shapes: [{ type: 'box', halfExtents: [0.3, 0.3, 0.3] }], contactForceThreshold: 0,
      userData: { entityId: 'b', detail: true },
    });
    let J = 0, vBefore = NaN, vAfter = NaN, steps = 0, pointY = NaN, up = true;
    let prev = 0;
    for (let s = 0; s < 120; s++) {
      e.step(dt);
      const v = e.getLinearVelocity(h)[1];
      const evs = e.drainContactEvents();
      if (evs.length && Number.isNaN(vBefore)) vBefore = prev;
      for (const ev of evs) {
        const d = ev.detail!;
        const onBody = ev.a?.entityId === 'b' ? d.F : [-d.F[0], -d.F[1], -d.F[2]];
        if (onBody[1] <= 0) up = false;
        J += onBody[1] * dt;
        if (Number.isNaN(pointY)) pointY = d.P[1];
        steps++;
      }
      if (evs.length) vAfter = v;
      prev = v;
    }
    e.dispose();
    expect(steps).toBeGreaterThan(0);
    expect(up).toBe(true);
    // Free fall from 3 m to the face at 0.3 m: v = √(2 g · 2.7) ≈ 7.28 m/s downwards before the first contact step.
    expect(vBefore).toBeLessThan(-6.5);
    const expected = m * (vAfter - vBefore) + m * 9.81 * steps * dt;
    expect(Math.abs(J - expected) / expected).toBeLessThan(0.02);
    expect(Math.abs(pointY)).toBeLessThan(0.05);
  });

  it('explicit principal moments: a torque impulse L about x gives ω = L / I_x; the declared mass is the body mass', async () => {
    const e = new RapierEngine();
    await e.init(0, null);
    const h = e.createBody({
      kind: 'dynamic', position: [0, 10, 0], quaternion: [0, 0, 0, 1], mass: 70, friction: 0.6, restitution: 0,
      shapes: [{ type: 'capsule', radius: 0.22, halfHeight: 0.65, offset: [0, 0.875, 0] }],
      massProps: { com: [0, 0.97, 0], inertia: [12.6, 1, 13.1] },
      userData: { entityId: 'h' },
    });
    expect(e.getMass(h)).toBeCloseTo(70, 4);
    e.applyTorqueImpulse(h, [25.2, 0, 0]);
    expect(e.getAngularVelocity(h)[0]).toBeCloseTo(2, 4);
    e.dispose();
  });
});
