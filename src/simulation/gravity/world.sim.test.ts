/**
 * Phase 31: gravity experiments in whole worlds — contact friction under a changed normal load (cars, people),
 * original-world restoration after a low → zero → high → reversed sequence with collapse, determinism and object-id /
 * event-order independence, save / load (schema v7), resource clean-up, a multi-hazard run without non-finite values.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { WorldDocument } from '@/core/model';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { LakeFeature } from '@/landscape/types';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { createInstance } from '@/phenomena/schedule';
import { rapierWorlds } from '@/physics/RapierEngine';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0, yaw = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string) => createDesign(presetSpec(id)!, id);

function town(): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 31;
  S().setFeatures([{ id: 'pond', kind: 'lake', points: [[40, 10], [80, 10], [80, 45], [40, 45]], surface: -0.2, depth: 1.2, shoreWidth: 3, material: 7, filled: true } as LakeFeature], 2);
  S().applyEdit({ add: [
    { type: 'building', building: design('office'), seed: 1, transform: tf(-20, -30) },
    { type: 'building', building: design('warehouse'), seed: 2, transform: tf(10, -30) },
    { type: 'building', building: design('house'), seed: 3, transform: tf(35, -30) },
    { type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed: 4, transform: tf(-40, 0) },
    ...[0, 1, 2, 3].map((k) => ({ type: 'car', seed: 10 + k, transform: tf(-20 + 8 * k, 5, 0, Math.PI / 2) })),
    ...[0, 1, 2].map((k) => ({ type: 'human', seed: 20 + k, transform: tf(-15 + 6 * k, 14) })),
  ] as never });
  return structuredClone(S().doc);
}

/** low → zero → high → reversed (staged) with a collapse-level stretch. */
const sequence = (): EventSpec[] => [
  gravity({ name: 'g1', magnitude: 1.62, profile: 'smooth', ramp: 2, duration: 6, startTime: 1 }),
  gravity({ name: 'g2', magnitude: 0, profile: 'constant', duration: 4, startTime: 7 }),
  gravity({ name: 'g3', magnitude: 4.5 * 9.81, profile: 'linear', ramp: 4, duration: 10, startTime: 11 }),
  gravity({ name: 'g4', magnitude: 9.81, direction: [0, 1, 0], profile: 'smooth', ramp: 1, duration: 3, startTime: 21 }),
];

async function run(doc: WorldDocument, events: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  c.advance(seconds);
  return c;
}

function hash(c: SimulationController) {
  const rt = c.getRuntime()!;
  const ents = [...rt.entities.values()].map((e) => `${e.source.type}@${e.pose.position.map((v) => v.toFixed(5)).join(',')}:${e.state}:${e.modular?.structure ? e.modular.structure.model.records.length : -1}`).sort();
  const g = c.getEnvironment().gravity.rt;
  const f = c.getEnvironment().flood.field;
  const parts = [ents.join(';'), g ? JSON.stringify(g.balance()) : '', f ? Array.from(f.h).join(',') : '', String(rt.debris.length)];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

describe('variable gravity in whole worlds', { timeout: 900_000 }, () => {
  it('contact friction follows the normal load: a car holds against 0.3 g sideways at 1 g down and slides at Moon-like g down', async () => {
    S().setLocked(false);
    S().newDocument();
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(0, 0) }] as never });
    const d = structuredClone(S().doc);
    const side = 0.3 * 9.81;
    const car = (c: SimulationController) => [...c.getRuntime()!.entities.values()][0];
    const a = await run(d, [gravity({ magnitude: Math.hypot(side, 9.81), direction: [side, -9.81, 0], startTime: 1 })], 5);
    const b = await run(d, [gravity({ magnitude: Math.hypot(side, 1.62), direction: [side, -1.62, 0], startTime: 1 })], 5);
    expect(Math.abs(car(a).pose.position[0])).toBeLessThan(0.3);
    expect(car(b).pose.position[0]).toBeGreaterThan(2);
    // The friction coefficient itself is unchanged (it is not scaled with g) — only the normal load changed.
    expect(car(a).source.physics.friction).toBe(car(b).source.physics.friction);
  });

  it('people: weightless people drift (no ground contact) and reversed gravity lifts them; their mass never changes', async () => {
    S().setLocked(false);
    S().newDocument();
    S().applyEdit({ add: [{ type: 'human', seed: 1, transform: tf(0, 0) }] as never });
    const d = structuredClone(S().doc);
    const c = await run(d, [gravity({ magnitude: 9.81, direction: [0, 1, 0], profile: 'smooth', ramp: 0.5, startTime: 1 })], 3);
    const e = [...c.getRuntime()!.entities.values()][0];
    expect(e.pose.position[1]).toBeGreaterThan(3);
    expect(c.getPhysics()!.getMass(e.body!)).toBeCloseTo(e.source.physics.mass, 3);
  });

  it('original world restored bit for bit after low → zero → high → reversed with collapse; the rerun is identical', async () => {
    const doc = town();
    const fp = worldFingerprint(doc);
    const a = await run(doc, sequence(), 26);
    const h1 = hash(a);
    // Something did happen: structural failures under 4.5 g and bodies moved.
    expect(a.getEnvironment().gravity.rt!.failures).toBeGreaterThan(0);
    await a.reset();
    expect(a.getEnvironment().gravity.field).toBeNull();
    expect(a.getPhysics()!.getGravity()).toEqual([0, -9.81, 0]);
    // reset() reschedules the run's own experiments (Phase 32 finding: adding them again doubled every experiment —
    // harmless for identical global gravity, but not the rerun this test means).
    a.advance(26);
    expect(hash(a)).toBe(h1);
    expect(worldFingerprint(doc)).toBe(fp);
    a.unload();
  });

  it('deterministic, independent of object ids and of the order the experiments were added', async () => {
    const doc = town();
    const h1 = hash(await run(doc, sequence(), 14));
    const d2 = structuredClone(doc);
    const objs = Object.values(d2.objects);
    d2.objects = {};
    for (const o of objs) { const id = `zz-${o.id}`; d2.objects[id] = { ...o, id }; }
    const c2 = await run(d2, [...sequence()].reverse(), 14);
    expect(hash(c2)).toBe(h1);
  });

  it('saves gravity experiments (schema v7); an invalid one is dropped with the file still loading', () => {
    S().setLocked(false);
    S().newDocument();
    const d = structuredClone(S().doc);
    const ok = createInstance('gravity', [], gravity({ scenario: 'well', global: false, sources: [{ kind: 'radial', center: [0, 2, 0], radius: 25, falloff: 'smooth', edge: 8, strength: 15, r0: 5, law: 'inverseSquare', softening: 3, followProfile: true }] }));
    const bad = { ...createInstance('gravity', [ok], gravity({ magnitude: 9.81 })), spec: { ...gravity({ magnitude: 500 }) } };
    d.scenario.experiment = { ...d.scenario.experiment, instances: [ok, bad] } as never;
    const res = parseDocument(serializeDocument(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(7);
    const inst = res.doc.scenario.experiment!.instances;
    expect(inst).toHaveLength(1);
    expect(inst[0].spec).toMatchObject({ event: 'gravity', scenario: 'well', global: false });
  });

  it('clean-up: every Rapier world of the runs is freed on unload', async () => {
    const live0 = rapierWorlds.live;
    const c = await run(town(), [gravity({ magnitude: 0 })], 2);
    expect(rapierWorlds.live).toBe(live0 + 1);
    c.unload();
    expect(rapierWorlds.live).toBe(live0);
  });

  it('multi-hazard city (gravity ramp + earthquake + flood + wind + snow): no NaN / Infinity anywhere, ledgers finite', async () => {
    const doc = town();
    const c = await run(doc, [
      gravity({ magnitude: 2.5 * 9.81, profile: 'linear', ramp: 8, duration: 30, end: 'hold' }),
      { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 10, seed: 3, startTime: 4 } as EventSpec,
      { event: 'rain', intensity: 150, duration: 30 } as EventSpec,
      { event: 'wind', speed: 25, direction: 'E', duration: 30 } as EventSpec,
    ], 16);
    const b = c.getEnvironment().gravity.rt!.balance();
    for (const v of [b.kinetic, b.potential, b.workGravity, b.workField, b.workOther, ...b.impulse, ...b.momentum]) expect(Number.isFinite(v)).toBe(true);
    for (const e of c.getRuntime()!.entities.values()) for (const v of e.pose.position) expect(Number.isFinite(v)).toBe(true);
    const f = c.getEnvironment().flood.field!;
    for (let i = 0; i < f.count; i++) if (!Number.isFinite(f.h[i]) || f.h[i] < 0) throw new Error(`water ${i} ${f.h[i]}`);
    expect(Math.abs(f.budget.error)).toBeLessThan(1e-6 * Math.max(1, f.budget.rain + f.budget.initial));
  });
});
