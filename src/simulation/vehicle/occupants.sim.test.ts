/**
 * Phase 35: occupants (Level A reduced model), the driver's capacity (Phase 33 / 34), the autopilot (inputs only), settings
 * save / load, reset, celestial capture (spec §40–44, §55, §59, §83).
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { buildWorld, car, person, type DemoObject } from '@/human/demos';
import { parseDocument, serializeDocument } from '@/world/serialization';
import type { VehicleCar, VehicleSettings } from '@/vehicle/settings';
import { physiologySnapshot } from '../physiology/interface';

function world(objects: DemoObject[], vehicles: Omit<VehicleSettings, 'model'> = {}, cfg: (cars: string[], people: string[]) => Record<string, VehicleCar> = () => ({}), physiology = false): WorldDocument {
  const doc = buildWorld({ objects, seed: 3502, name: 'vehicle occupants' });
  const cars = Object.values(doc.objects).filter((o) => o.type === 'car').map((o) => o.id);
  const people = Object.values(doc.objects).filter((o) => o.type === 'human').map((o) => o.id);
  doc.settings.simulation.vehicles = { model: 'dynamics', ...vehicles, cars: cfg(cars, people) };
  if (physiology) doc.settings.simulation.physiology = { model: 'reduced', zones: [{ id: 'co', shape: 'box', center: [0, 1, 0], size: [600, 20, 600], co: 0.1 }] };
  return doc;
}
async function load(doc: WorldDocument, events: EventSpec[] = []) {
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  for (const e of events) c.addEvent(e);
  return c;
}
const of = (c: SimulationController, type: string) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === type);

describe('occupants, driver, autopilot', () => {
  it('a seated occupant is out of the collision world and carried with the seat; restrained occupants stay in, unrestrained ones are thrown out in a hard crash', async () => {
    const c = await load(world([car(0, 0, 1), person(30, 0, 2), person(30, 10, 3), { type: 'wall', seed: 4, transform: { position: [26, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] } }], {}, ([id], [a, b]) => ({
      [id]: { controls: { gear: 'D', throttle: 1 }, occupants: [{ human: a, seat: 'driver', restrained: true }, { human: b, seat: 'front', restrained: false }] },
    })));
    const [e] = of(c, 'car');
    const [a, b] = of(c, 'human').sort((p, q) => p.source.transform.position[2] - q.source.transform.position[2]);
    c.advance(0.5);
    expect(a.occupant?.vehicle).toBe(e.id);
    // Carried with the seat: within the car's footprint.
    expect(Math.abs(a.pose.position[0] - e.pose.position[0])).toBeLessThan(2.5);
    c.advance(10);
    const v = e.vehicle!;
    const hard = v.episodes.some((x) => x.dv >= 8);
    const ob = v.occupants.find((o) => o.human === b.id)!, oa = v.occupants.find((o) => o.human === a.id)!;
    expect(oa.state).toBe('seated');
    if (hard) {
      expect(ob.state).toBe('ejected');
      expect(b.occupant).toBeUndefined();
      expect(c.getDamageEvents().some((ev) => ev.objectId === b.id && ev.eventType === 'OCCUPANT_EJECTED')).toBe(true);
    }
    expect(oa.peakDv).toBeGreaterThan(0);
    c.unload();
  }, 120_000);

  it('driver capacity (§42): a driver unable to act (CO zone, Phase 34) releases the pedals — the inputs, never the velocity, are limited', async () => {
    // 10 % CO (an experimental boundary condition, so the FED reaches 1 within ~20 s while the slowly driving car stays inside).
    const c = await load(world([car(0, 0, 1), person(30, 0, 2)], {}, ([id], [h]) => ({ [id]: { controls: { gear: 'D', throttle: 0.12 }, occupants: [{ human: h, seat: 'driver', restrained: true }] } }), true));
    const [e] = of(c, 'car');
    const [h] = of(c, 'human');
    let unable = -1;
    for (let i = 0; i < 120 && unable < 0; i++) {
      c.advance(1);
      const ps = physiologySnapshot(h);
      if (ps?.combined === 'unableToAct') unable = c.getTime();
    }
    expect(unable).toBeGreaterThan(0);
    c.advance(2);
    expect(e.vehicle!.avail.driver).toBe(0);
    expect(e.vehicle!.dyn.wheels.every((w) => w.driveT === 0)).toBe(true);
    c.unload();
  }, 300_000);

  it('autopilot (§44): follows a path by writing inputs (steer / throttle / brake), stops at the end, brakes for an obstacle ahead', async () => {
    const c = await load(world([car(0, 0, 1)], {}, ([id]) => ({ [id]: { autopilot: { path: [[0, 0], [40, 0], [60, 20]], speed: 8 } } })));
    const [e] = of(c, 'car');
    c.advance(30);
    const p = e.pose.position;
    expect(Math.hypot(p[0] - 60, p[2] - 20)).toBeLessThan(4);
    expect(Math.hypot(...c.getPhysics()!.getLinearVelocity(e.body!))).toBeLessThan(0.5);
    c.unload();
    const d = await load(world([car(0, 0, 1), { type: 'wall', seed: 4, transform: { position: [25, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] } }], {}, ([id]) => ({ [id]: { autopilot: { path: [[0, 0], [80, 0]], speed: 10 } } })));
    const [f] = of(d, 'car');
    d.advance(15);
    expect(f.vehicle!.episodes.filter((x) => x.partnerKind === 'structure').length).toBe(0);
    expect(f.pose.position[0]).toBeLessThan(25);
    d.unload();
  }, 120_000);

  it('settings (§59): saved and loaded; an invalid car entry is dropped alone; null switches vehicles off; absent = legacy', () => {
    const doc = world([car(0, 0, 1), car(6, 0, 2)], { tire: 'linear', substeps: 12 }, ([a, b]) => ({ [a]: { drive: 'rwd', program: [{ t: 3, throttle: 1 }, { t: 1, gear: 'D' }] }, [b]: { level: 'rigid' } }));
    (doc.settings.simulation.vehicles!.cars as Record<string, unknown>).bad = { drive: 'sideways' };
    const back = parseDocument(serializeDocument(doc));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const v = back.doc.settings.simulation.vehicles!;
    expect(v.tire).toBe('linear');
    expect(v.substeps).toBe(12);
    expect(Object.keys(v.cars!).length).toBe(2);
    // The program is sorted by time.
    const first = Object.values(v.cars!).find((x) => x.program)!;
    expect(first.program!.map((k) => k.t)).toEqual([1, 3]);
    const off = parseDocument(serializeDocument({ ...doc, settings: { ...doc.settings, simulation: { ...doc.settings.simulation, vehicles: undefined } } }));
    expect(off.ok && off.doc.settings.simulation.vehicles).toBeFalsy();
  });

  it('reset (§83): back to the initial vehicle state; the document is never touched', async () => {
    const doc = world([car(0, 0, 1)], {}, ([id]) => ({ [id]: { controls: { gear: 'D', throttle: 1 } } }));
    const before = JSON.stringify(doc);
    const c = await load(doc);
    c.advance(5);
    const [e] = of(c, 'car');
    expect(e.pose.position[0]).toBeGreaterThan(1);
    await c.reset();
    const [r] = of(c, 'car');
    expect(r.vehicle!.dyn.wheels.every((w) => w.omega === 0)).toBe(true);
    expect(r.pose.position[0]).toBeCloseTo(0, 6);
    expect(JSON.stringify(doc)).toBe(before);
    c.unload();
  });
});
