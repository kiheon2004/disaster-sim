/**
 * Phase 34: the physiology in the simulation — settings, sampler provenance, boundary zones, confined compartments
 * (mass conservation), airway events, the capacity → posture coupling, determinism, lifecycle.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import type { Vec3 } from '@/core/types';
import { parseDocument, serializeDocument } from '@/world/serialization';
import type { PhysiologySettings, PhysiologyZone } from '@/physiology/settings';

const S = () => useWorldStore.getState();
const K = 273.15;
type Obj = Record<string, unknown>;
const person = (x: number, z: number, y = 0, seed = 1): Obj => ({ type: 'human', seed, params: { height: 1.75, shirtColor: '#ffffff', pantsColor: '#000000' }, transform: { position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } });

function world(objs: Obj[], physiology?: PhysiologySettings | null, humans = true): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 7;
  if (humans) S().doc.settings.simulation.humans = { model: 'extended' };
  if (physiology) S().doc.settings.simulation.physiology = physiology;
  if (objs.length) S().applyEdit({ add: objs as never });
  return structuredClone(S().doc);
}
async function controller(doc: WorldDocument) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  return c;
}
const people = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'human');
const zone = (o: Partial<PhysiologyZone>): PhysiologyZone => ({ id: 'z', shape: 'box', center: [0, 1, 0], size: [20, 6, 20], ...o });

describe('physiology in the simulation', () => {
  it('off by default and without the extended model: no state is created; a file with physiology but no extended model loses it on load', async () => {
    const c = await controller(world([person(0, 0)]));
    expect(c.getRuntime()!.physiology).toBeUndefined();
    expect(people(c)[0].physio).toBeUndefined();
    c.unload();
    const doc = world([person(0, 0)], { model: 'reduced' }, false);
    (doc.settings.simulation as unknown as Record<string, unknown>).physiology = { model: 'reduced' };
    const back = parseDocument(serializeDocument(doc));
    expect(back.ok && back.doc.settings.simulation.physiology).toBeFalsy();
  });

  it('settings: saved and loaded; an invalid zone is dropped alone; other edits keep it; null switches it off; switching the extended model off drops it', () => {
    const p: PhysiologySettings = { model: 'reduced', clothing: 'insulated', activity: 'light', zones: [zone({ airTemperature: 270 }), { ...zone({}), id: 'bad', humidity: 7 } as PhysiologyZone] };
    const doc = world([person(0, 0)], p);
    const back = parseDocument(serializeDocument(doc));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.doc.settings.simulation.physiology?.clothing).toBe('insulated');
    expect(back.doc.settings.simulation.physiology?.zones?.map((z) => z.id)).toEqual(['z']);
    world([person(0, 0)], p);
    S().updateSimulationSettings({ seed: 11 });
    expect(S().doc.settings.simulation.physiology?.activity).toBe('light');
    S().updateSimulationSettings({ physiology: null });
    expect(S().doc.settings.simulation.physiology).toBeUndefined();
    world([person(0, 0)], p);
    S().updateSimulationSettings({ humans: null });
    expect(S().doc.settings.simulation.physiology).toBeUndefined();
  });

  it('a calm scene: the sample says where every value came from (scene ambient, reference humidity / pressure / gas) and nothing changes much in 10 min', async () => {
    const c = await controller(world([person(0, 0)], { model: 'reduced' }));
    const p = people(c)[0];
    c.advance(600);
    const pe = p.physio!;
    expect(pe.provenance.airT).toBe('scene.ambient');
    expect(pe.provenance.humidity).toBe('reference');
    expect(pe.provenance.pressure).toBe('reference');
    expect(pe.provenance.gas).toBe('reference');
    expect(Math.abs(pe.s.Tc - K - 36.8)).toBeLessThan(0.3);
    expect(pe.s.capacity).toBe('normal');
    expect(p.human!.standing).toBe(true);
    // Physiology never writes the Phase 33 health.
    expect(p.health).toBe(1);
    c.unload();
  });

  it('a hot humid zone (boundary condition): core rises, sweat drips, a THERMAL_STRESS event once, provenance "zone"; the energy ledger closes', async () => {
    const c = await controller(world([person(0, 0)], { model: 'reduced', activity: 'moderate', clothing: 'light', zones: [zone({ airTemperature: 45 + K, humidity: 0.85 })] }));
    const p = people(c)[0];
    c.advance(1800);
    const s = p.physio!.s;
    expect(p.physio!.provenance.airT).toBe('zone');
    expect(s.Tc - K).toBeGreaterThan(38);
    expect(s.ledger.drip).toBeGreaterThan(0);
    const ev = c.getDamageEvents().filter((d) => d.eventType === 'THERMAL_STRESS');
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev.length).toBeLessThanOrEqual(4);
    expect(Math.abs(s.ledger.residual)).toBeLessThan(1);
    c.unload();
  });

  it('confined air (8 m³, no exchange): O₂ falls and CO₂ rises by what the occupants exchanged — mass conserved; the supply index falls', { timeout: 600_000 }, async () => {
    const c = await controller(world([person(0, 0), person(1, 0, 0, 2)], { model: 'reduced', activity: 'light', zones: [zone({ size: [6, 6, 6], confined: { volume: 8, exchange: 0 } })] }));
    const rt = c.getRuntime()!.physiology!;
    c.advance(0.2);
    const comp = rt.compartments.get(0)!;
    const o20 = comp.ref.o2, co20 = comp.ref.co2;
    c.advance(1800);
    expect(comp.o2).toBeCloseTo(o20 - comp.ledger.o2Taken + comp.ledger.o2Exchange, 9);
    expect(comp.co2).toBeCloseTo(co20 + comp.ledger.co2Given + comp.ledger.co2Exchange, 9);
    expect(comp.ledger.o2Exchange).toBe(0);
    const taken = people(c).reduce((a, p) => a + p.physio!.s.ledger.o2 - p.physio!.s.ledger.o2Debt, 0);
    expect(comp.ledger.o2Taken).toBeCloseTo(taken, 6);
    expect(comp.ledger.co2Given / comp.ledger.o2Taken).toBeCloseTo(0.85, 6);
    expect(people(c)[0].physio!.s.resp.supply!).toBeLessThan(0.97);
    expect(people(c)[0].physio!.provenance.gas).toBe('confined');
    c.unload();
  });

  it('airway: physiology-only water rising over the airway and falling again — AIRWAY_SUBMERGED / AIRWAY_CLEARED once each, history kept, no inhalation while under', async () => {
    const c = await controller(world([person(0, 0)], { model: 'reduced', zones: [zone({ start: 5, end: 25, water: { level: 2.2, temperature: 20 + K } })] }));
    const p = people(c)[0];
    c.advance(40);
    const ev = c.getDamageEvents();
    expect(ev.filter((d) => d.eventType === 'AIRWAY_SUBMERGED').length).toBe(1);
    expect(ev.filter((d) => d.eventType === 'AIRWAY_CLEARED').length).toBe(1);
    const a = p.physio!.s.airway;
    expect(a.first!).toBeGreaterThanOrEqual(5);
    expect(a.cumulative).toBeGreaterThan(19);
    expect(a.cumulative).toBeLessThan(21);
    expect(p.physio!.s.ledger.o2Debt).toBeGreaterThan(0);
    c.unload();
  });

  it('unable to act (CO zone, FED ≥ 1): the person sinks down through the Phase 33 controlled collapse — one FALLEN with cause physiology, no impact episode, the physical injury index untouched', async () => {
    const c = await controller(world([person(0, 0)], { model: 'reduced', zones: [zone({ co: 0.05 })] }));
    const p = people(c)[0];
    c.advance(90);
    const s = p.physio!.s;
    expect(s.levels.gas).toBe('unableToAct');
    expect(s.capacity).toBe('unableToAct');
    expect(p.human!.standing).toBe(false);
    expect(p.human!.fallCause).toBe('physiological');
    expect(p.human!.collapsed).toBeGreaterThanOrEqual(1);
    const ev = c.getDamageEvents();
    expect(ev.filter((d) => d.eventType === 'FALLEN').length).toBe(1);
    expect(ev.filter((d) => d.eventType === 'INJURED').length).toBe(0);
    expect(p.human!.impacts).toBe(0);
    expect(ev.some((d) => d.eventType === 'CAPACITY_CHANGED' && d.physio?.to === 'unableToAct')).toBe(true);
    c.unload();
  });

  it('deterministic: the same run twice and with the people added in another order give the same physiology', async () => {
    const run = async (rev: boolean) => {
      const objs = [person(0, 0, 0, 1), person(3, 0, 0, 2)];
      const c = await controller(world(rev ? objs.reverse() : objs, { model: 'reduced', activity: 'moderate', zones: [zone({ airTemperature: 5 + K, wind: 8 })] }));
      c.advance(300);
      const out = people(c).map((p) => [p.pose.position[0].toFixed(3), p.physio!.s.Tc, p.physio!.s.Ts, p.physio!.s.ledger.evap]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
      c.unload();
      return JSON.stringify(out);
    };
    const a = await run(false);
    expect(await run(false)).toBe(a);
    expect(await run(true)).toBe(a);
  });

  it('reset: back to the initial physiology; the document is never touched', async () => {
    const doc = world([person(0, 0)], { model: 'reduced', zones: [zone({ airTemperature: 0 + K, wind: 6 })] });
    const before = JSON.stringify(doc);
    const c = await controller(doc);
    c.advance(120);
    const t1 = people(c)[0].physio!.s.Ts;
    await c.reset();
    expect(people(c)[0].physio!.s.time).toBe(0);
    c.advance(120);
    expect(people(c)[0].physio!.s.Ts).toBe(t1);
    expect(JSON.stringify(doc)).toBe(before);
    c.unload();
  });
});
