/**
 * Phase 32: celestial sources in the full simulation (Rapier + gravity runtime) against closed forms — a probe on a
 * circular orbit (radius, Plummer period, energy), an ellipse (vis-viva periapsis), capture with the mass / momentum
 * ledger, the Phase 31 energy ledger with KDK bodies, determinism and dormancy.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { Vec3 } from '@/core/types';
import { gravity } from '../gravity/testSpecs';
import { celestialSpec, labSource, probe } from './testSpecs';
import { G_N } from '@/celestial/constants';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });

function world(objs: { type: string; seed: number; transform: ReturnType<typeof tf> }[] = []): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 7;
  if (objs.length) S().applyEdit({ add: objs as never });
  return structuredClone(S().doc);
}

async function controller(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const ZERO = gravity({ magnitude: 0, duration: 6 * 3600, end: 'hold' });
const MU = 5e4;

describe('celestial sources in the simulation', () => {
  it('circular orbit of a probe: radius within 0.2 %, period of the Plummer field, energy error < 10⁻³', async () => {
    const r = 30, eps = 1;
    const c = await controller(world(), [ZERO, celestialSpec({ sources: [labSource({ softening: eps })], probes: [probe([r, 60, 0], 'circular', 1, [0, 0, 1])] })]);
    const P = (2 * Math.PI * r) / Math.sqrt((MU * r * r) / (r * r + eps * eps) ** 1.5);
    c.advance(0.02);
    const cel = c.getEnvironment().gravity.rt!.celestial!;
    let rMin = Infinity, rMax = 0;
    for (let k = 0; k < Math.round((5 * P) / 0.1); k++) {
      c.advance(0.1);
      const d = cel.probes[0].diag;
      rMin = Math.min(rMin, d.r); rMax = Math.max(rMax, d.r);
    }
    const d = cel.probes[0].diag;
    expect(cel.probes[0].state).toBe('orbit');
    expect((rMax - rMin) / r).toBeLessThan(2e-3);
    expect(Math.abs(d.period - P) / P).toBeLessThan(5e-3);
    expect(d.conserved).toBe(true);
    expect(d.maxErr).toBeLessThan(1e-3);
    expect(d.lErr).toBeLessThan(1e-3);
    // The integrator did the work: substeps > 0 and no cap.
    expect(cel.stats.capped).toBe(0);
  });

  it('ellipse: 0.7 × circular at 40 m reaches the vis-viva periapsis r·k²/(2 − k²) = 13.0 m', async () => {
    const c = await controller(world(), [ZERO, celestialSpec({ sources: [labSource({ softening: 0.5, capture: 0.5 })], probes: [probe([40, 60, 0], 'circular', 0.7, [0, 0, 1])] })]);
    c.advance(30);
    const d = c.getEnvironment().gravity.rt!.celestial!.probes[0].diag;
    // ε = 0.5 m shifts the speed by (1 + ε²/r²)^{-3/4}: periapsis within 1 %.
    expect(Math.abs(d.rMin - (40 * 0.49) / 1.51) / 13).toBeLessThan(1e-2);
    expect(Math.abs(d.rMax - 40) / 40).toBeLessThan(2e-3);
  });

  it('capture: a car lifted into a black hole is removed with its mass, momentum and energy booked', async () => {
    const doc = world([{ type: 'car', seed: 1, transform: tf(0, 0, 0) }]);
    const c = await controller(doc, [celestialSpec({ sources: [labSource({ center: [0, 8, 0], softening: 1.5, capture: 1.5, ramp: 0 })] })]);
    const rt = c.getRuntime()!;
    const car = [...rt.entities.values()].find((e) => e.source.type === 'car')!;
    const m = c.getPhysics()!.getMass(car.body!);
    c.advance(8);
    const cel = c.getEnvironment().gravity.rt!.celestial!;
    expect(car.flags.captured).toBe(true);
    expect(car.body).toBeNull();
    expect(cel.ledger.count).toBe(1);
    expect(cel.ledger.mass).toBeCloseTo(m, 6);
    expect(cel.ledger.massResidual()).toBe(0);
    const rec = cel.ledger.records[0];
    expect(rec.kind).toBe('vehicle');
    // Fixed source: the constraint takes the whole momentum (J = −m·v), no work (V_s = 0), K_rel = K.
    for (let i = 0; i < 3; i++) expect(rec.constraintImpulse[i]).toBeCloseTo(-rec.momentum[i], 9);
    expect(rec.constraintWork).toBe(0);
    expect(rec.kineticRel).toBeCloseTo(rec.kinetic, 9);
    expect(rec.massAfter).toBe(rec.massBefore); // fixed policy
    // The Phase 31 ledger: the car left the set with its K and U (boundary terms), nothing else lost.
    const b = c.getEnvironment().gravity.rt!.balance();
    expect(b.boundaryKinetic).toBeCloseTo(-rec.kinetic, 3);
  });

  it('grow policy: M rises by the captured mass, μ = G·M', async () => {
    const doc = world([{ type: 'car', seed: 1, transform: tf(0, 0, 0) }]);
    const c = await controller(doc, [celestialSpec({ sources: [labSource({ center: [0, 8, 0], softening: 1.5, capture: 1.5, ramp: 0, massPolicy: 'grow' })] })]);
    c.advance(8);
    const f = c.getEnvironment().gravity.field!;
    const cel = c.getEnvironment().gravity.rt!.celestial!;
    const m0 = MU / G_N;
    expect(cel.ledger.count).toBe(1);
    expect(f.points.massOf(0, 0) - m0).toBeCloseTo(cel.ledger.mass, 3);
    expect(f.points.live[0].mu).toBeCloseTo(G_N * (m0 + cel.ledger.mass), 6);
    expect(cel.ledger.grown).toBe(cel.ledger.mass);
  });

  it('determinism: the same run twice gives the same probe states and ledgers', async () => {
    const ev = [ZERO, celestialSpec({ sources: [labSource()], probes: [probe([25, 60, 0], 'circular', 0.8, [0, 0.3, 1]), probe([0, 60, 30], 'escape', 1.1, [1, 0, 0])] })];
    const a = await controller(world(), ev), b = await controller(world(), ev);
    a.advance(12); b.advance(12);
    const ca = a.getEnvironment().gravity.rt!.celestial!, cb = b.getEnvironment().gravity.rt!.celestial!;
    expect(ca.probes.map((p) => p.pos)).toEqual(cb.probes.map((p) => p.pos));
    expect(a.getEnvironment().gravity.rt!.balance()).toEqual(b.getEnvironment().gravity.rt!.balance());
  });

  it('dormant: without a celestial experiment nothing of it exists', async () => {
    const c = await controller(world([{ type: 'car', seed: 1, transform: tf(0, 0, 0) }]), []);
    c.advance(1);
    expect(c.getEnvironment().gravity.field).toBeNull();
    const g = await controller(world([{ type: 'car', seed: 1, transform: tf(0, 0, 0) }]), [gravity({ magnitude: 1.62 })]);
    g.advance(1);
    expect(g.getEnvironment().gravity.rt!.celestial).toBeNull();
    expect(g.getEnvironment().gravity.field!.points.empty).toBe(true);
  });
});
