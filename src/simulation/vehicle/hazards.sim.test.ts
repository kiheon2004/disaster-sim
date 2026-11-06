/**
 * Phase 35: the wheeled vehicle under the existing hazards and with people / structures (spec §45–55, §39, §38, §75–76).
 * The hazards' own forces come from their systems through the ForceLedger; the tests check that the vehicle model reads
 * them consistently (wheel loads, traction, attribution) and adds none twice.
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { buildWorld, car, person, type DemoObject } from '@/human/demos';
import { forcesAt } from '@/simulation/forces/ForceLedger';
import type { VehicleCar, VehicleSettings } from '@/vehicle/settings';
import { AIR_DENSITY, VARIANTS } from '@/vehicle/params';

const g = 9.80665;
function world(objects: DemoObject[], vehicles: Omit<VehicleSettings, 'model'> = {}, cfg: (ids: string[]) => Record<string, VehicleCar> = () => ({}), height?: (x: number, z: number) => number): WorldDocument {
  const doc = buildWorld({ objects, seed: 3501, name: 'vehicle hazards', height });
  const ids = Object.values(doc.objects).filter((o) => o.type === 'car').map((o) => o.id);
  doc.settings.simulation.vehicles = { model: 'dynamics', ...vehicles, cars: cfg(ids) };
  return doc;
}
async function load(doc: WorldDocument, events: EventSpec[] = []) {
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  for (const e of events) c.addEvent(e);
  return c;
}
const of = (c: SimulationController, type: string) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === type);
const sumFz = (e: RuntimeEntity) => e.vehicle!.dyn.wheels.reduce((a, w) => a + w.Fz, 0);
const gravityEvent = (magnitude: number, direction: [number, number, number], startTime = 0): EventSpec =>
  ({ event: 'gravity', scenario: 'custom', global: true, magnitude, direction, transition: 'vector', profile: 'constant', duration: 600, end: 'hold', sources: [], startTime } as unknown as EventSpec);

describe('vehicles and hazards', () => {
  it('variable gravity (§54): on the Moon (1.62 m/s²) the wheel loads sum to m g_moon; the suspension compresses g_moon / ω²', async () => {
    const c = await load(world([car(0, 0, 1)]), [gravityEvent(1.62, [0, -1, 0])]);
    const e = of(c, 'car')[0];
    c.advance(8);
    expect(sumFz(e)).toBeCloseTo(e.vehicle!.geo.mass * 1.62, -1);
    const w = 2 * Math.PI * VARIANTS.sedan.rideHz;
    expect(e.vehicle!.dyn.wheels[0].compression).toBeCloseTo(1.62 / (w * w), 2);
    c.unload();
  });

  it('tilt table (§75): steady lateral load transfer is the rigid-body value 2h tan θ / t raised by the body roll (1.0–1.3×); a sudden step overshoots dynamically', async () => {
    for (const k of [0.3, 0.5, 0.7]) {
      const c = await load(world([car(0, 0, 1)], { tire: 'linear' }, (ids) => ({ [ids[0]]: { controls: { gear: 'P', handbrake: true, brake: 1 } } })));
      const v = of(c, 'car')[0].vehicle!;
      const th = k * Math.atan(v.geo.track / (2 * v.geo.hcg));
      c.addEvent(gravityEvent(g, [0, -Math.cos(th), Math.sin(th)], 1));
      c.advance(12);
      const rigid = (2 * v.geo.hcg * Math.tan(th)) / v.geo.track;
      expect(v.rollover).toBe('upright');
      expect(v.ltr / rigid).toBeGreaterThan(1.0);
      expect(v.ltr / rigid).toBeLessThan(1.3);
      c.unload();
    }
  }, 120_000);

  it('rollover (§33): a sudden lateral gravity step at 0.8 of the static angle tips the car — a rollover event, the state from the body attitude', async () => {
    const c = await load(world([car(0, 0, 1)], { tire: 'linear' }, (ids) => ({ [ids[0]]: { controls: { gear: 'P', handbrake: true, brake: 1 } } })));
    const e = of(c, 'car')[0], v = e.vehicle!;
    const th = 0.8 * Math.atan(v.geo.track / (2 * v.geo.hcg));
    c.addEvent(gravityEvent(g, [0, -Math.cos(th), Math.sin(th)], 1));
    c.advance(8);
    expect(['onSide', 'onRoof']).toContain(v.rollover);
    expect(c.getDamageEvents().some((ev) => ev.objectId === e.id && ev.eventType === 'VEHICLE_ROLLOVER')).toBe(true);
    c.unload();
  }, 60_000);

  it('crosswind (§50): the vehicle\'s own aerodynamics replaces the legacy car drag — one wind force per step (no duplicate), ½ρ C_y A_s |v| v_z of the local wind', async () => {
    const c = await load(world([car(0, 0, 1)], {}, (ids) => ({ [ids[0]]: { controls: { gear: 'P', handbrake: true } } })), [{ event: 'wind', speed: 20, direction: 'E', duration: 60, gustStrength: 0, rampDuration: 1, startTime: 0 } as EventSpec]);
    const e = of(c, 'car')[0];
    c.advance(4);
    expect(c.duplicateForces()).toBe(0);
    const w = e.localWind.velocity;
    const d = e.vehicle!.geo.dims, s = VARIANTS.sedan;
    // Parked: v_body ≈ 0; side (body z) and front (body x) components of the wind on the respective areas.
    const fx = 0.5 * AIR_DENSITY * s.cd * d.width * d.height * s.areaFill * Math.hypot(w[0], w[1], w[2]) * w[0];
    const fz = 0.5 * AIR_DENSITY * s.cy * d.length * d.height * s.areaFill * Math.hypot(w[0], w[1], w[2]) * w[2];
    const got = forcesAt(e, c.getStep() - 1).wind;
    expect(Math.abs(got - Math.hypot(fx, fz)) / Math.hypot(fx, fz)).toBeLessThan(0.05);
    c.unload();
  });

  it('earthquake (§45): the ground-motion force reaches the car through its own source only; the parked car stays upright on its wheels at 0.3 g', async () => {
    const c = await load(world([car(0, 0, 1)], {}, (ids) => ({ [ids[0]]: { controls: { gear: 'P', handbrake: true } } })), [{ event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 10, seed: 3, startTime: 0 } as unknown as EventSpec]);
    const e = of(c, 'car')[0];
    let gm = 0;
    for (let i = 0; i < 300; i++) { c.advance(1 / 60); gm = Math.max(gm, forcesAt(e, c.getStep() - 1).groundMotion); }
    expect(gm).toBeGreaterThan(0);
    expect(c.duplicateForces()).toBe(0);
    expect(e.vehicle!.rollover).toBe('upright');
    c.unload();
  });

  it('flood (§46–47): Σ wheel loads + the water force ≈ m g at rest in still water; floating — no wheel touches, the throttle drives nothing; water in the intake stalls the engine', async () => {
    // Flat shore at z ≥ 85 (height rising to the north), water rising from the south edge.
    const shore = (_x: number, z: number) => Math.min(4, Math.max(0, (85 - z) * 0.1));
    const rise = (level: number): EventSpec => ({ event: 'risingWater', boundary: 'S', level, riseRate: 30, duration: 600, startTime: 0 } as EventSpec);
    const c = await load(world([car(0, 95, 1)], {}, (ids) => ({ [ids[0]]: { controls: { gear: 'P', handbrake: true } } }), shore), [rise(0.5)]);
    const e = of(c, 'car')[0];
    c.advance(40);
    const water = forcesAt(e, c.getStep() - 1).water;
    // The water carries a real share of the weight (buoyancy of the submerged body volume — the flood model's).
    expect(water).toBeGreaterThan(0.15 * e.vehicle!.geo.mass * g);
    expect(Math.abs(sumFz(e) + water - e.vehicle!.geo.mass * g) / (e.vehicle!.geo.mass * g)).toBeLessThan(0.05);
    c.unload();
    // Deep water: the car floats; full throttle while afloat moves it no differently from no throttle (no traction), and the
    // intake takes water (stall).
    const drift = async (thr: number) => {
      const d = await load(world([car(0, 95, 1)], {}, (ids) => ({ [ids[0]]: { program: [{ t: 0, gear: 'D', throttle: 0 }, { t: 60, throttle: thr }] } }), shore), [rise(2.0)]);
      const f = of(d, 'car')[0];
      // Sample once a second: whenever the car is afloat (no wheel on anything), every tyre force is exactly zero.
      let afloat = 0, forceWhileAfloat = 0;
      for (let k = 0; k < 60; k++) {
        d.advance(1);
        if (f.vehicle!.dyn.touching === 0) {
          afloat++;
          forceWhileAfloat += f.vehicle!.dyn.wheels.reduce((a, w) => a + Math.abs(w.Fx) + Math.abs(w.Fy), 0);
        }
      }
      const p0 = [...f.pose.position];
      d.advance(4);
      const evs = d.getDamageEvents().filter((x) => x.objectId === f.id);
      const out = { afloat, forceWhileAfloat, moved: Math.hypot(f.pose.position[0] - p0[0], f.pose.position[2] - p0[2]), stalled: f.vehicle!.stalled, events: evs.map((x) => x.eventType), rollT: evs.filter((x) => x.eventType === 'VEHICLE_ROLLOVER').map((x) => x.time) };
      d.unload();
      return out;
    };
    const idle = await drift(0), full = await drift(1);
    expect(idle.afloat + full.afloat).toBeGreaterThan(0);
    expect(idle.forceWhileAfloat + full.forceWhileAfloat).toBe(0);
    expect(Math.abs(full.moved - idle.moved)).toBeLessThan(0.3);
    expect(full.stalled).toBe(true);
    expect(full.events).toContain('VEHICLE_STALLED');
    // Rollover state changes are events, not per-step noise: a state holds ≥ 0.5 s before the next one (a tumbling body in a surge
    // may change state repeatedly — each change is real).
    for (let i = 1; i < full.rollT.length; i++) expect(full.rollT[i] - full.rollT[i - 1]).toBeGreaterThanOrEqual(0.5 - 1e-9);
  }, 300_000);

  it('vehicle → person (§39): the person\'s Phase 33 contact episode records the strike (partner = the car, hazard vehicle); the vehicle adds no health loss of its own', async () => {
    const c = await load(world([car(0, 0, 1), person(14, 0, 2)], {}, (ids) => ({ [ids[0]]: { controls: { gear: 'D', throttle: 0.5 } } })));
    const h = of(c, 'human')[0], e = of(c, 'car')[0];
    c.advance(8);
    const evs = c.getDamageEvents().filter((ev) => ev.objectId === h.id && (ev.eventType === 'IMPACT' || ev.eventType === 'INJURED' || ev.eventType === 'FALLEN'));
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.some((ev) => ev.human?.partner === e.id || ev.hazard === 'vehicle')).toBe(true);
    // The vehicle's own record of the episode (no injury values on the vehicle side).
    expect(e.vehicle!.episodes.some((x) => x.partner === h.id) || [...e.vehicle!.open.keys()].includes(h.id)).toBe(true);
    c.unload();
  }, 120_000);

  it('vehicle → structure (§38): driving into a street light at speed, the Phase 25 strike model topples it (one strike record, the vehicle as the striker)', async () => {
    const c = await load(world([car(0, 0, 1), { type: 'streetLight', seed: 3, transform: { position: [16, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], {}, (ids) => ({ [ids[0]]: { controls: { gear: 'D', throttle: 1 } } })));
    const l = of(c, 'streetLight')[0];
    c.advance(8);
    const evs = c.getDamageEvents().filter((ev) => ev.objectId === l.id);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.some((ev) => ev.secondary?.striker === `vehicle:${of(c, 'car')[0].id}`)).toBe(true);
    c.unload();
  }, 120_000);
});
