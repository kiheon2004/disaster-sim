/**
 * Phase 31 audit (§10): the step-wide gravity scope (thermal/gravityScope.ts) — the same gravity as Rapier from the
 * first step of an experiment on, restored after a throw, exactly 1 outside a step and inside a dormant controller
 * (also one stepped from within another controller's step), back to 1 after reset.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { gravityDown, gravityMagnitude } from '@/thermal/gravityScope';
import type { SimulationSystem } from '@/simulation/systems/SimulationSystem';
import type { Vec3 } from '@/core/types';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
function doc() {
  S().setLocked(false);
  S().newDocument();
  S().applyEdit({ add: [{ type: 'car', seed: 1, transform: { position: [0, 20, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }] as never });
  return structuredClone(S().doc);
}
type Rec = { step: number; down: number; mag: number; gy: number };
/** A probe system appended to the pipeline (prePhysics, after the GravitySystem). */
function spy(c: SimulationController, out: Rec[], fn?: (step: number) => void) {
  const sys = {
    name: 'scopeSpy', phase: 'prePhysics', reads: [], writes: [],
    update(ctx: { step: number; physics: { getGravity(): Vec3 } }) {
      out.push({ step: ctx.step, down: gravityDown(), mag: gravityMagnitude(), gy: ctx.physics.getGravity()[1] });
      fn?.(ctx.step);
    },
  } as unknown as SimulationSystem;
  (c.getSystems() as SimulationSystem[]).push(sys);
  return () => { const l = c.getSystems() as SimulationSystem[]; l.splice(l.indexOf(sys), 1); };
}

describe('gravity scope (§10)', { timeout: 300_000 }, () => {
  it('the first step of an experiment: the scope already has its gravity (as Rapier does); again after reset', async () => {
    const c = new SimulationController({ headless: true });
    await c.load(doc());
    c.addEvent(gravity({ magnitude: 1.62 }));
    const r: Rec[] = [];
    spy(c, r);
    c.advance(1 / 60);
    expect(r[0].gy).toBeCloseTo(-1.62, 6);
    expect(r[0].down).toBeCloseTo(1.62 / 9.81, 12);
    expect(r[0].mag).toBeCloseTo(1.62 / 9.81, 12);
    await c.reset();
    expect(gravityDown()).toBe(1);
    const r2: Rec[] = [];
    spy(c, r2);
    c.advance(1 / 60);
    expect(r2[0].down).toBeCloseTo(1.62 / 9.81, 12);
    c.unload();
  });

  it('a throw inside a step restores the scope; outside a step it is 1', async () => {
    const c = new SimulationController({ headless: true });
    await c.load(doc());
    c.addEvent(gravity({ magnitude: 1.62 }));
    const r: Rec[] = [];
    const off = spy(c, r, (s) => { if (s === 3) throw new Error('probe'); });
    expect(() => c.advance(0.2)).toThrow('probe');
    expect(r[r.length - 1].down).toBeCloseTo(1.62 / 9.81, 12);
    expect(gravityDown()).toBe(1);
    expect(gravityMagnitude()).toBe(1);
    off();
    c.advance(0.1);
    expect(gravityDown()).toBe(1);
    c.unload();
  });

  it('a dormant controller stepped from inside another controller\'s step sees exactly 1', async () => {
    const a = new SimulationController({ headless: true });
    await a.load(doc());
    a.addEvent(gravity({ magnitude: 3 * 9.81 }));
    const b = new SimulationController({ headless: true });
    await b.load(doc());
    const rb: Rec[] = [];
    spy(b, rb);
    spy(a, [], () => b.advance(1 / 60));
    a.advance(2 / 60);
    expect(rb.length).toBe(2);
    for (const x of rb) { expect(x.down).toBe(1); expect(x.mag).toBe(1); expect(x.gy).toBe(-9.81); }
    a.unload();
    b.unload();
  });
});
