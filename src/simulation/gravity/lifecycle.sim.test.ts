/**
 * Phase 31 audit (H3) with Rapier: bodies leaving the gravity ledger — removed by a prePhysics system after the field
 * step (as debris recycling in the BlastSystem does), made fixed (held) and dynamic again, asleep (still tracked) —
 * leave / enter with their K, U and momentum; no phantom work, mass never counted twice.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { SimulationSystem } from '@/simulation/systems/SimulationSystem';
import type { Vec3 } from '@/core/types';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y: number) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
async function start(ev = gravity({ magnitude: 2 * 9.81, profile: 'linear', ramp: 2, duration: 60, end: 'hold' })) {
  S().setLocked(false);
  S().newDocument();
  S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(0, 0, 60) }, { type: 'car', seed: 2, transform: tf(20, 0, 80) }] as never });
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(S().doc));
  c.addEvent(ev);
  return c;
}
const cars = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'car');
function system(c: SimulationController, fn: (step: number) => void) {
  (c.getSystems() as SimulationSystem[]).push({ name: 'lifecycleProbe', phase: 'prePhysics', reads: [], writes: [], update: (ctx: { step: number }) => fn(ctx.step) } as unknown as SimulationSystem);
}

describe('gravity ledger: body lifecycle with Rapier (H3)', { timeout: 300_000 }, () => {
  it('a body removed between the field step and the physics step leaves with its state at the step start (no phantom work)', async () => {
    const c = await start();
    const [, b] = cars(c);
    system(c, (step) => {
      if (step !== 40 || b.body === null) return;
      c.getPhysics()!.removeBody(b.body);
      b.body = null;
      b.dynamic = false;
    });
    c.advance(1.5);
    const r = c.getEnvironment().gravity.rt!.balance();
    expect(r.bodies).toBe(1);
    // In free fall (damping only): the other work is the damping work, a few % of the gross gravity work.
    expect(r.workOther).toBeLessThan(0);
    expect(-r.workOther).toBeLessThan(0.1 * r.workGravityGross);
    expect(Math.abs(r.fieldResidual)).toBeLessThan(1e-6 * r.workGravityGross);
    c.unload();
  });

  it('made fixed and dynamic again: the body leaves and re-enters; the books stay closed, mass not doubled', async () => {
    const c = await start();
    const [a] = cars(c);
    let kHold = 0;
    system(c, (step) => {
      if (step === 30) {
        // Held in the middle of its fall: the hold takes its kinetic energy (work of the constraint, booked as other work).
        const v = c.getPhysics()!.getLinearVelocity(a.body!), m = c.getPhysics()!.getMass(a.body!);
        kHold = 0.5 * m * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
        c.getPhysics()!.setBodyKind(a.body!, 'fixed'); a.dynamic = false;
      }
      if (step === 50) { c.getPhysics()!.setBodyKind(a.body!, 'dynamic'); a.dynamic = true; }
    });
    c.advance(40 / 60);
    expect(c.getEnvironment().gravity.rt!.balance().bodies).toBe(1);
    c.advance(30 / 60);
    const r = c.getEnvironment().gravity.rt!.balance();
    expect(r.bodies).toBe(2);
    expect(Math.abs(r.fieldResidual)).toBeLessThan(1e-6 * r.workGravityGross);
    expect(kHold).toBeGreaterThan(0);
    // Other work = −K taken by the hold + the damping work (a few % of the gross gravity work).
    expect(-r.workOther).toBeGreaterThan(kHold);
    expect(-r.workOther - kHold).toBeLessThan(0.1 * r.workGravityGross);
    c.unload();
  });

  it('a body asleep on the ground stays in the ledger (sleeping is not fixed) and is woken by the ramp', async () => {
    S().setLocked(false);
    S().newDocument();
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(0, 0, 0) }] as never });
    const c = new SimulationController({ headless: true });
    await c.load(structuredClone(S().doc));
    c.addEvent(gravity({ magnitude: 0.3 * 9.81, direction: [0, 1, 0], startTime: 6 }));
    c.advance(5.9);
    expect(c.getPhysics()!.isSleeping(cars(c)[0].body!)).toBe(true);
    c.advance(1);
    const r = c.getEnvironment().gravity.rt!.balance();
    expect(r.bodies).toBe(1);
    expect(r.workGravity).toBeGreaterThan(0);
    c.unload();
  });
});
