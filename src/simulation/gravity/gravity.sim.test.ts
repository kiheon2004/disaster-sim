/**
 * Phase 31: variable gravity in the simulation — rigid-body motion against closed forms, the field / Rapier split (no
 * double gravity), local sources through the ForceLedger, wakes, ledgers, determinism, dormancy.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { gravity } from './testSpecs';
import type { Vec3 } from '@/core/types';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });

function world(objs: { type: string; seed: number; transform: ReturnType<typeof tf> }[]): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 7;
  if (objs.length) S().applyEdit({ add: objs as never });
  return structuredClone(S().doc);
}

async function run(doc: WorldDocument, events: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  c.advance(seconds);
  return c;
}
const car = (c: SimulationController) => [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'car')!;

describe('variable gravity: rigid bodies', () => {
  const doc = () => world([{ type: 'car', seed: 1, transform: tf(0, 0, 40) }]);

  it('free fall scales with g exactly (linear dynamics from rest) and matches ½gt² within the damping term', async () => {
    const t = 1.5;
    const y0 = car(await run(doc(), [], 0)).pose.position[1];
    const earth = car(await run(doc(), [], t)).pose.position[1];
    const moon = car(await run(doc(), [gravity({ magnitude: 1.62 })], t)).pose.position[1];
    const dE = y0 - earth, dM = y0 - moon;
    // Rapier stores positions in f32: the ratio holds to ≈ 1e-6 relative.
    expect(dM / dE).toBeCloseTo(1.62 / 9.81, 5);
    // ½gt² with Rapier's linear damping c = 0.05 /s: Δy ≈ ½gt²(1 − ct/3).
    expect(dM).toBeGreaterThan(0.5 * 1.62 * t * t * (1 - (0.05 * t) / 3) * 0.98);
    expect(dM).toBeLessThan(0.5 * 1.62 * t * t * 1.02);
  });

  it('the Earth preset of the project gravity is bit-identical to no experiment', async () => {
    const a = car(await run(doc(), [], 2)).pose.position;
    const b = car(await run(doc(), [gravity({ magnitude: 9.81 })], 2)).pose.position;
    expect(b).toEqual(a);
  });

  it('zero gravity: no fall; reversed: it rises; sideways: it moves along +x', async () => {
    const y0 = car(await run(doc(), [], 0)).pose.position[1];
    const zero = car(await run(doc(), [gravity({ magnitude: 0 })], 2)).pose.position;
    expect(Math.abs(zero[1] - y0)).toBeLessThan(1e-9);
    const up = car(await run(doc(), [gravity({ magnitude: 9.81, direction: [0, 1, 0] })], 1)).pose.position;
    expect(up[1] - y0).toBeGreaterThan(4);
    const side = car(await run(doc(), [gravity({ magnitude: 9.81, direction: [1, 0, 0] })], 1)).pose.position;
    expect(side[0]).toBeGreaterThan(4);
    expect(Math.abs(side[1] - y0)).toBeLessThan(1e-9);
  });

  it('a body asleep on the ground floats away when gravity reverses (woken)', async () => {
    const d = world([{ type: 'car', seed: 1, transform: tf(0, 0, 0) }]);
    const c = await run(d, [gravity({ magnitude: 3, direction: [0, 1, 0], startTime: 8 })], 7.9);
    const rest = car(c).pose.position[1];
    expect(c.getPhysics()!.isSleeping(car(c).body!)).toBe(true);
    c.advance(2);
    expect(car(c).pose.position[1] - rest).toBeGreaterThan(1.5);
  });

  it('a local radial source pulls through the ForceLedger only by its difference (no double gravity)', async () => {
    const src = { kind: 'radial' as const, center: [10, 40, 0] as Vec3, radius: 30, falloff: 'none' as const, strength: 4, r0: 10, law: 'constant' as const, softening: 0.01 };
    const c = await run(doc(), [gravity({ global: false, sources: [src] })], 1);
    const e = car(c);
    // Pulled toward +x by ≈ 4 m/s², still falling at g.
    expect(e.pose.position[0]).toBeGreaterThan(1.5);
    expect(e.pose.position[0]).toBeLessThan(2.1);
    expect(c.getPhysics()!.getGravity()).toEqual([0, -9.81, 0]);
    expect(c.duplicateForces()).toBe(0);
  });

  it('ledger: free fall in a uniform field — ΔK = W_g, ΔU = −W_g (exact); impulse = Δp', async () => {
    const c = await run(doc(), [gravity({ magnitude: 3.71 })], 1.5);
    const b = c.getEnvironment().gravity.rt!.balance();
    expect(b.workGravity).toBeGreaterThan(0);
    // Linear damping (c = 0.05 /s) is the only other work in free fall: ΔK/W_g ≈ 1 − ct over t = 1.5 s (≈ 7.5 % lost).
    expect(b.workOther).toBeLessThan(0);
    expect(-b.workOther / b.workGravity).toBeGreaterThan(0.04);
    expect(-b.workOther / b.workGravity).toBeLessThan(0.1);
    // f32 positions in Rapier: exact up to the round-off of Φ(x) evaluated at f32 positions.
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-6 * b.workGravity);
    expect(b.impulseOther[1]).toBeGreaterThan(0); // damping opposes the fall
    expect(Math.abs(b.impulseOther[1])).toBeLessThan(0.06 * Math.abs(b.impulse[1]));
  });

  it('a changing field does work on resting bodies only through ∂Φ/∂t (field work booked)', async () => {
    const d = world([{ type: 'car', seed: 1, transform: tf(0, 0, 0) }]);
    const c = await run(d, [gravity({ magnitude: 20, profile: 'linear', ramp: 4, duration: 10, startTime: 3 })], 8);
    const b = c.getEnvironment().gravity.rt!.balance();
    expect(Number.isFinite(b.workField)).toBe(true);
    expect(Math.abs(b.fieldResidual)).toBeLessThan(1e-6 * Math.max(1, Math.abs(b.workField)));
  });

  it('dormant without an experiment: no field, no runtime', async () => {
    const c = await run(doc(), [], 1);
    expect(c.getEnvironment().gravity.field).toBeNull();
    expect(c.getEnvironment().gravity.rt).toBeNull();
  });

  it('deterministic: same input → same trajectory (bitwise)', async () => {
    const ev = [gravity({ magnitude: 9.81, direction: [1, 0.5, -1], transition: 'rotate', profile: 'smooth', ramp: 1 })];
    const a = car(await run(doc(), ev, 2)).pose.position;
    const b = car(await run(doc(), ev, 2)).pose.position;
    expect(b).toEqual(a);
  });
});
