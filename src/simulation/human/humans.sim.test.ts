/**
 * Phase 33: the extended human model in the running simulation. Expectations from closed forms (free fall √(2 g h), the
 * impulse–momentum theorem, the standing-balance limit atan(1.9 e / h_c) of the published support geometry, reversed
 * gravity a = g), from the Phase 32.1 rest-contact rule, and from determinism / save round trips — not from the code under
 * test.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { bodyModel } from '@/human/anthropometry';
import { gravity } from '../gravity/testSpecs';
import { celestialSpec, labSource } from '../celestial/testSpecs';
import { humanSnapshot } from './interface';
import { rapierWorlds } from '@/physics/RapierEngine';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0, yaw = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const G = 9.81;
type Obj = { type: string; seed: number; transform: ReturnType<typeof tf>; params?: Record<string, unknown> };
const person = (x: number, z: number, y = 0, seed = 1, yaw = 0): Obj => ({ type: 'human', seed, params: { height: 1.75, shirtColor: '#ffffff', pantsColor: '#000000' }, transform: tf(x, z, y, yaw) });

function world(objs: Obj[], extended = true): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 7;
  if (extended) S().doc.settings.simulation.humans = { model: 'extended' };
  if (objs.length) S().applyEdit({ add: objs as never });
  return structuredClone(S().doc);
}
async function controller(doc: WorldDocument, events: EventSpec[] = []) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const people = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'human');

describe('extended human model in the simulation', () => {
  it('off by default: people keep the Phase 0–32 model (no state, no detail, uniform capsule mass)', async () => {
    const c = await controller(world([person(0, 0)], false));
    const p = people(c)[0];
    expect(p.human).toBeUndefined();
    expect(p.hum).toBeUndefined();
  });

  it('standing still at 1 g and at 3 g: no fall, no contact episode, full health (rest is not an impact)', async () => {
    for (const k of [1, 3]) {
      const c = await controller(world([person(0, 0)]), k === 1 ? [] : [gravity({ magnitude: 3 * G, direction: [0, -1, 0] } as never)]);
      const p = people(c)[0];
      c.advance(6);
      expect(p.human!.standing).toBe(true);
      expect(p.human!.impacts).toBe(0);
      expect(p.health).toBe(1);
      expect(c.getDamageEvents()).toHaveLength(0);
    }
  });

  it('a feet-first drop: lands at √(2 g h), the impulse balances the momentum change, the legs carry it, the drop height is measured', async () => {
    const h = 3;
    const c = await controller(world([person(0, 0, h)]));
    const p = people(c)[0];
    c.advance(1.5);
    const st = p.human!;
    expect(st.impacts).toBeGreaterThanOrEqual(1);
    const v = Math.sqrt(2 * G * h);
    // Linear damping 0.05 1/s over the ~0.8 s fall slows the body by ≈ 2 %.
    expect(Math.abs(st.maxClosing - v) / v).toBeLessThan(0.04);
    // Feet-first: the body stops, so |J| ≈ m v (+ m g over the contact steps).
    expect(Math.abs(st.maxImpulse - p.source.physics.mass * v) / (p.source.physics.mass * v)).toBeLessThan(0.08);
    expect(st.last!.segments.map((s) => s.id).sort()).toEqual(['leftLeg', 'rightLeg']);
    expect(Math.abs(st.maxDrop - h)).toBeLessThan(0.05);
    expect(st.risk.head.hits).toBe(0);
  });

  it('a higher drop raises the leg index; the Moon (0.17 g) lowers it at the same height', async () => {
    const legIndex = async (h: number, ev: EventSpec[] = []) => {
      const c = await controller(world([person(0, 0, h)]), ev);
      c.advance(h > 5 ? 3 : 2.2);
      return people(c)[0].human!.risk.leftLeg.peak;
    };
    const one = await legIndex(1), three = await legIndex(3), ten = await legIndex(10);
    expect(one).toBeLessThan(three);
    expect(three).toBeLessThan(ten);
    const moon = await legIndex(3, [gravity({ magnitude: 1.62, direction: [0, -1, 0] } as never)]);
    expect(moon).toBeLessThan(0.6 * three);
  });

  it('tilted gravity: stands well inside the balance limit atan(1.9 e / h_c), falls beyond it — towards the tilt', async () => {
    const b = bodyModel(1.75, 70);
    const lim = Math.atan((1.9 * b.support.forward) / b.com[1]);
    const run = async (ang: number) => {
      // A slow (5 s smooth) tilt: the person has time to lean into it (the sudden-load limit is lower, see human.test.ts).
      const c = await controller(world([person(0, 0)]), [gravity({ magnitude: G, direction: [0, -Math.cos(ang), Math.sin(ang)], profile: 'smooth', ramp: 5 } as never)]);
      const p = people(c)[0];
      c.advance(8);
      return p;
    };
    expect((await run(0.7 * lim)).human!.standing).toBe(true);
    const f = await run(1.4 * lim);
    expect(f.human!.standing).toBe(false);
    expect(f.human!.fallCause).toBe('gravity');
    expect(f.pose.position[2]).toBeGreaterThan(0.3);
  });

  it('a person placed lying starts passive: no fall event, posture from the body (supine), no contact episode at rest', async () => {
    const lying = { ...person(0, 0), transform: { position: [0, 0.22, 0] as Vec3, rotation: [-Math.PI / 2, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } };
    const c = await controller(world([lying]));
    const p = people(c)[0];
    c.advance(3);
    expect(p.human!.standing).toBe(false);
    expect(p.human!.falls).toBe(0);
    expect(p.flags.fallen).toBeFalsy();
    expect(['supine', 'resting']).toContain(p.human!.posture);
    expect(c.getDamageEvents()).toHaveLength(0);
  });

  it('reversed gravity: the support is lost at once and the body rises at a ≈ g', async () => {
    const c = await controller(world([person(0, 0)]), [gravity({ magnitude: G, direction: [0, 1, 0] } as never)]);
    const p = people(c)[0];
    c.advance(2);
    expect(p.human!.standing).toBe(false);
    expect(p.human!.fallCause).toBe('noSupport');
    expect(p.human!.posture).toBe('airborne');
    // y(t) ≈ ½ g t² after release (damping 0.05 1/s: within 10 %).
    expect(Math.abs(p.pose.position[1] - 0.5 * G * 4) / (0.5 * G * 4)).toBeLessThan(0.1);
  });

  it('wind: a moderate wind is resisted, a storm topples the person downwind, the fall is attributed to the wind', async () => {
    const run = async (speed: number) => {
      const c = await controller(world([person(0, 0)]), [{ event: 'wind', speed, direction: 'S', duration: 30, gustStrength: 0, rampDuration: 4 } as EventSpec]);
      const p = people(c)[0];
      c.advance(8);
      return { p, c };
    };
    const calm = await run(12);
    expect(calm.p.human!.standing).toBe(true);
    const storm = await run(35);
    expect(storm.p.human!.standing).toBe(false);
    expect(storm.p.human!.fallCause).toBe('wind');
    expect(storm.c.getDamageEvents().some((d) => d.eventType === 'FALLEN' && d.hazard === 'wind')).toBe(true);
    // A fall from standing height strikes the head hardest (the top of a toppling body arrives fastest).
    const r = storm.p.human!.risk;
    expect(r.head.peak * 6).toBeGreaterThan(r.pelvis.peak * 8);
  });

  it('a car dropped on a standing person: the contact is an episode with the car as partner, upper body struck, one IMPACT event per episode', async () => {
    const c = await controller(world([person(0, 0), { type: 'car', seed: 3, transform: tf(0, 0, 4) }]));
    const p = people(c)[0];
    const car = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'car')!;
    c.advance(3);
    const st = p.human!;
    expect(st.impacts).toBeGreaterThan(0);
    const ev = c.getDamageEvents().filter((d) => d.objectId === p.id && d.eventType === 'IMPACT');
    expect(ev.some((d) => d.human?.partner === car.id)).toBe(true);
    const struck = ev.filter((d) => d.human?.partner === car.id).flatMap((d) => d.human!.segment!.split('+'));
    expect(struck.some((s) => s === 'head' || s === 'torso')).toBe(true);
    // No legacy impact health rule on an extended person: health follows the risk index only.
    const maxCum = Math.max(...Object.values(st.risk).map((r) => r.cum));
    expect(p.health).toBeCloseTo(Math.max(0, 1 - maxCum / 2), 12);
  });

  it('lying under a strong celestial source: no new contact episodes once at rest (Phase 32.1 local-field threshold)', async () => {
    const src = { ...labSource({ center: [0, -12, 0], softening: 2, capture: 0 }), kind: 'compact' as const };
    const c = await controller(world([person(0, 0)]));
    const p = people(c)[0];
    c.addEvent(celestialSpec({ sources: [src] }));
    c.advance(4);
    const n = p.human!.impacts;
    c.advance(4);
    expect(p.human!.impacts).toBe(n);
  });

  it('deterministic: the same run twice and with the objects added in another order give the same people', async () => {
    const snap = async (objs: Obj[]) => {
      const c = await controller(world(objs), [{ event: 'wind', speed: 32, direction: 'W', duration: 30, gustStrength: 0.3, rampDuration: 3 } as EventSpec]);
      c.advance(8);
      return people(c).map((p) => JSON.stringify([p.source.seed, p.pose.position, p.health, p.human!.posture, p.human!.impacts, p.human!.falls])).sort();
    };
    const objs = [person(0, 0, 0, 1), person(3, 1, 0, 2, 0.7), person(-2, 4, 2, 3)];
    const a = await snap(objs), b = await snap(objs), r = await snap([...objs].reverse());
    expect(b).toEqual(a);
    expect(r).toEqual(a);
  });

  it('energy ledger of a free fall: gravity work = ½ m v² at the landing, the remainder before it is only the linear damping', async () => {
    const c = await controller(world([person(0, 0, 10)]));
    const p = people(c)[0];
    c.advance(1.2); // still in the air (t_fall ≈ 1.43 s)
    const E = p.human!.energy;
    expect(E.ke - E.ke0).toBeGreaterThan(0);
    expect(Math.abs(E.ke - E.ke0 - (E.gravity + E.external + E.release + E.contact + E.other))).toBeLessThan(1e-6 * Math.max(1, E.ke));
    // Damping 0.05 1/s removes ≈ 2·0.05·∫KE dt ≈ 4 % of the gained energy here; nothing else may appear.
    expect(E.other).toBeLessThan(0);
    expect(-E.other / E.gravity).toBeLessThan(0.06);
    expect(E.contact).toBe(0);
    expect(E.release).toBe(0);
  });

  it('no tunnelling: thrown at a 25 cm wall at ≈ 100 m/s (1.7 m per step) the person stops at it', async () => {
    // 30 g towards +x, the wall 20 m away: ≈ 100 m/s at the wall — the capsule (0.44 m) and the wall (0.25 m) overlap for
    // less than one step. Measured: Rapier's predictive contacts already stop it without CCD (this case passes with
    // ccd off too); extended people keep CCD on as a further guard (HUMAN_PHYSICS.md §39).
    const wall = { type: 'wall', seed: 9, transform: { position: [20, 0, 0] as Vec3, rotation: [0, Math.PI / 2, 0] as Vec3, scale: [1, 1, 1] as Vec3 } };
    const c = await controller(world([person(0, 0, 0.3), wall]), [gravity({ magnitude: 30 * G, direction: [1, 0, 0] } as never)]);
    const p = people(c)[0];
    c.advance(1.5);
    expect(p.pose.position[0]).toBeLessThan(20);
    expect(p.human!.impacts).toBeGreaterThan(0);
  });

  it('Phase 34 snapshot: segment centres in the world, activity and the last impact', async () => {
    const c = await controller(world([person(0, 0, 3)]));
    const p = people(c)[0];
    c.advance(2);
    const s = humanSnapshot(p)!;
    expect(s.segments).toHaveLength(8);
    expect(s.segments[0].id).toBe('head');
    expect(s.exposure[1]).toBeGreaterThan(s.segments[6].centre[1]);
    expect(s.lastImpact?.partner).toBe('ground');
    expect(humanSnapshot(people(await controller(world([person(0, 0)], false)))[0])).toBeNull();
  });

  it('lifecycle: run → reset → run again gives the same people, a deleted person leaves nothing behind, unload frees the world', async () => {
    const live0 = rapierWorlds.live;
    const doc = world([person(0, 0, 3, 1), person(4, 0, 0, 2)]);
    const c = await controller(doc, [{ event: 'wind', speed: 34, direction: 'S', duration: 20, gustStrength: 0.2, rampDuration: 3 } as EventSpec]);
    const snap = () => people(c).map((p) => JSON.stringify([p.pose.position, p.health, p.human!.posture, p.human!.impacts, p.human!.falls, p.human!.episodes.size]));
    c.advance(6);
    const a = snap();
    const ev = c.getDamageEvents().length;
    await c.reset();
    expect(people(c).every((p) => p.human!.impacts === 0 && p.human!.episodes.size === 0 && p.human!.standing)).toBe(true);
    c.advance(6);
    expect(snap()).toEqual(a);
    expect(c.getDamageEvents().length).toBe(ev);
    c.unload();
    expect(rapierWorlds.live).toBe(live0);
    // A world without the second person: no state of it anywhere.
    const solo = await controller(world([person(0, 0, 3, 1)]));
    solo.advance(2);
    expect(people(solo)).toHaveLength(1);
    solo.unload();
    expect(rapierWorlds.live).toBe(live0);
  });

  it('changing another simulation setting keeps the human setting; null switches it off', () => {
    world([person(0, 0)]);
    S().updateSimulationSettings({ humans: { model: 'extended', riskScale: 1.2 } });
    S().updateSimulationSettings({ seed: 99 });
    S().updateSimulationSettings({ wind: { turbulence: 0.2 } });
    expect(S().doc.settings.simulation.humans).toEqual({ model: 'extended', riskScale: 1.2 });
    S().updateSimulationSettings({ humans: null });
    expect(S().doc.settings.simulation.humans).toBeUndefined();
  });

  it('the setting is saved and loaded; files without it load as the legacy model', () => {
    const doc = world([person(0, 0)]);
    doc.settings.simulation.humans = { model: 'extended', riskScale: 1.5 };
    const back = parseDocument(serializeDocument(doc));
    expect(back.ok && back.doc.settings.simulation.humans).toEqual({ model: 'extended', riskScale: 1.5 });
    const old = world([person(0, 0)], false);
    const back2 = parseDocument(serializeDocument(old));
    expect(back2.ok && back2.doc.settings.simulation.humans).toBeUndefined();
    const bad = JSON.parse(serializeDocument(doc));
    bad.settings.simulation.humans = { model: 'ragdoll' };
    const back3 = parseDocument(JSON.stringify(bad));
    expect(back3.ok && back3.doc.settings.simulation.humans).toBeUndefined();
  });
});
