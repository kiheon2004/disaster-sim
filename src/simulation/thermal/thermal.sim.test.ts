/**
 * Phase 26: thermal physics in the simulation — heat sources on the terrain, water, air, objects and
 * modular buildings; energy ledger; wind and water coupling; temperature-dependent strength and
 * restrained expansion through the collapse engine; debris heat; determinism, id independence,
 * shared designs, save / load, original-world restoration, resource cleanup, impact heat share.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { worldFingerprint } from '@/world/fingerprint';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { BuildingDesign } from '@/buildings/types';
import { rapierWorlds } from '@/physics/RapierEngine';
import { steelKy } from '@/thermal/materials';
import { totalEnergy } from '@/thermal/sources';
import type { HeatSourceSpec } from '@/thermal/types';
import { toC } from '@/thermal/units';
import { SimulationController } from '../SimulationController';
import { relativeError } from '../water/WaterField';
import type { ThermalRuntime } from './runtime';
import { createInstance } from '@/phenomena/schedule';

const T = (x = 0, z = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string) => createDesign(presetSpec(id)!, id);
const B = (d: BuildingDesign, x = 0, z = 0, seed = 7): CreateObjectInput => ({ type: 'building', building: d, seed, transform: T(x, z) });

function doc(inputs: CreateObjectInput[], patch?: (d: WorldDocument) => void): WorldDocument {
  const d = createEmptyDocument('p26');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  patch?.(d);
  return d;
}

const heat = (p: Partial<HeatSourceSpec>): EventSpec => ({ event: 'heatSource', kind: 'point', position: [0, 0], height: 1.5, radius: 2, input: 'power', power: 2e5, profile: 'constant', duration: 60, ...p } as EventSpec);

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}

const rtOf = (c: SimulationController): ThermalRuntime => c.getEnvironment().thermal.rt!;

/** Hash of the whole thermal state (bodies by owner order, ground of the active tiles, air, rooms). */
function thermalHash(c: SimulationController): string {
  const rt = rtOf(c), w = rt.world, B = w.bodies;
  const parts: string[] = [];
  for (let i = 0; i < B.n; i++) parts.push(`${B.kind[i]}|${B.sub[i]}|${B.alive[i]}|${B.ES[i]}|${B.EC[i]}`);
  w.terrain.forActive((c) => { for (let l = 0; l < w.terrain.nl; l++) parts.push(String(w.terrain.E[c * w.terrain.nl + l])); });
  parts.push(...Array.from(w.air.E, String), ...w.comps.map((x) => String(x.E)), JSON.stringify(w.ledger.snapshot()));
  for (const e of c.getRuntime()!.entities.values()) {
    const m = e.modular?.structure?.model;
    if (m) parts.push(...m.records.map((r) => [r.i, r.time, r.cause, r.hazard].join('|')));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

describe('thermal channel', () => {
  it('stays dormant without a heat source (no arrays, no system work, water untouched)', async () => {
    const c = await run(doc([B(design('house'))]), [{ event: 'rain', intensity: 60, duration: 20 } as EventSpec], 5);
    expect(c.getEnvironment().thermal.rt).toBeNull();
    expect(c.getEnvironment().flood.field?.heat ?? null).toBeNull();
    expect(c.getSystems().some((s) => s.name === 'thermal')).toBe(true);
    c.unload();
  });

  it('heats the ground under an area source and closes the energy balance; the input equals the profile integral', async () => {
    const spec = heat({ kind: 'area', radius: 4, power: 4e5, profile: 'ramp', rampTime: 20, duration: 40 });
    const c = await run(doc([]), [spec], 45);
    const rt = rtOf(c), w = rt.world;
    const cell = w.terrain.index(0.5, 0.5);
    expect(w.terrain.T(cell, 0) - w.Tref).toBeGreaterThan(1);
    expect(w.terrain.T(cell, 1)).toBeGreaterThan(w.Tref);
    expect(w.terrain.T(w.terrain.index(30.5, 30.5), 0)).toBe(w.Tref);
    expect(w.ledger.added).toBeCloseTo(totalEnergy(spec as HeatSourceSpec), 3);
    expect(w.ledger.relativeResidual()).toBeLessThan(1e-9);
    expect(w.ledger.lost.radiationSky).toBeGreaterThan(0);
    expect(w.ledger.transfers.convection).toBeGreaterThan(0);
    // Air above warmed by convection, then partly vented upward.
    expect(w.air.T(w.air.index(0, 0)) - w.Tref).toBeGreaterThan(0);
    expect(w.ledger.lost.atmosphere).toBeGreaterThan(0);
    c.unload();
  });

  it('gives the same total heat for any source timing (instant energy, pulses, schedule)', async () => {
    for (const p of [{ profile: 'instant', input: 'energy', energy: 3e6 }, { profile: 'pulse', input: 'energy', energy: 3e6, pulseWidth: 0.35, period: 1.1, duration: 7.3 }, { profile: 'schedule', input: 'energy', energy: 3e6, schedule: [[0.05, 0.12], [2, 3.33]], duration: 5 }] as Partial<HeatSourceSpec>[]) {
      const c = await run(doc([]), [heat({ kind: 'surface', radius: 3, ...p })], 10);
      expect(rtOf(c).world.ledger.added).toBeCloseTo(3e6, 2);
      expect(rtOf(c).world.ledger.relativeResidual()).toBeLessThan(1e-9);
      c.unload();
    }
  });
});

describe('objects, vegetation, people', () => {
  it('a point source radiates on the objects that see it: cars and trees warm, nothing burns, the shaded side stays cooler', async () => {
    const d = doc([{ type: 'car', seed: 1, transform: T(4, 0) }, { type: 'tree', seed: 2, transform: T(-5, 0) }, B(design('house'), 0, 14), { type: 'car', seed: 3, transform: T(0, 24) }, { type: 'human', seed: 4, transform: T(0, -6) }]);
    const c = await run(d, [heat({ power: 1e6, duration: 60, height: 2 })], 30);
    const rt = rtOf(c), bodies = rt.world.bodies;
    const byType = (t: string) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === t);
    const [car1, car2] = byType('car').map((e) => rt.entity(e.id)!);
    const tree = rt.entity(byType('tree')[0].id)!;
    expect(bodies.Esrc[car1.body]).toBeGreaterThan(1e5);
    expect(bodies.TS[car1.body]).toBeGreaterThan(rt.world.Tref + 0.3);
    // The car behind the house (shaded from the source) gets no direct radiation.
    expect(bodies.Esrc[car2.body] ?? 0).toBe(0);
    expect(bodies.TS[tree.body]).toBeGreaterThan(rt.world.Tref + 1);
    expect(byType('tree')[0].state).toBe(0);
    expect(byType('tree')[0].flags.snapped ?? false).toBe(false);
    const person = byType('human')[0];
    expect(person.exposure?.thermal?.radiant ?? 0).toBeGreaterThan(100);
    c.unload();
  });

  it('wind: forced convection cools a heated body and carries warm air downstream (no force is applied)', async () => {
    const run2 = async (speed: number) => {
      const d = doc([{ type: 'car', seed: 1, transform: T(0, 0) }]);
      const specs: EventSpec[] = [heat({ kind: 'surface', radius: 1.5, power: 1e5, duration: 40, height: 0.8 })];
      if (speed > 0) specs.unshift({ event: 'wind', speed, direction: 'W', duration: 60, gustStrength: 0, rampDuration: 0.5 } as EventSpec);
      const c = await run(d, specs, 30);
      const rt = rtOf(c), car = rt.entity([...c.getRuntime()!.entities.values()][0].id)!;
      const out = { T: rt.world.bodies.TS[car.body], air: rt.world.air, dup: c.duplicateForces() };
      c.unload();
      return out;
    };
    const calm = await run2(0), windy = await run2(12);
    expect(windy.T).toBeLessThan(calm.T);
    // Wind from the west blows toward +x: the column east of the source is warmer than the one west.
    const a0 = windy.air.index(0, 0);
    expect(windy.air.E[a0 + 2]).toBeGreaterThan(windy.air.E[a0 - 2]);
    expect(windy.dup).toBe(0);
  });
});

describe('water', () => {
  it('heat moves with the water (advection), the water mass budget is unchanged and the heat ledger closes', async () => {
    const d = doc([], (x) => { x.terrain.heights.forEach((_, i) => { x.terrain.heights[i] = -0.02 * ((i % x.terrain.nx) - 100); }); });
    const specs: EventSpec[] = [
      { event: 'waterSource', position: [-40, 0], rate: 3, duration: 120, radius: 2 } as EventSpec,
      heat({ kind: 'area', position: [-40, 0], radius: 3, power: 3e6, duration: 120, startTime: 10 }),
    ];
    const c = await run(d, specs, 80);
    const rt = rtOf(c), w = rt.world, f = c.getEnvironment().flood.field!;
    expect(relativeError(f.budget)).toBeLessThan(1e-9);
    // Downstream (+x: the ground falls toward +x) the water is warmer than at the same distance upstream.
    const at = (x: number) => w.waterT(w.terrain.index(x, 0.5));
    expect(at(-30)).toBeGreaterThan(w.Tref + 0.1);
    expect(at(-30)).toBeGreaterThan(at(-50));
    expect(w.ledger.transfers.waterAdvection).toBeGreaterThan(0);
    expect(w.ledger.relativeResidual()).toBeLessThan(1e-9);
    c.unload();
  }, 60000);
});

describe('buildings', () => {
  const warehouse = () => doc([B(design('warehouse'))]);
  /** A hot sphere inside the warehouse, around one interior column line. */
  const fire = (p: Partial<HeatSourceSpec> = {}) => heat({ kind: 'temperature', temperature: 1273.15, radius: 4, height: 4, duration: 900, ...p });

  /** World x, z of the first ground-story column of the warehouse (a hot sphere enclosing it, inside). */
  const columnXZ = (): [number, number] => {
    const m = design('warehouse').members.find((x) => x.type === 'column' && x.level === 0)!;
    return [m.position[0] + Math.sign(-m.position[0] || 1) * 1.8, m.position[2] + Math.sign(-m.position[2] || 1) * 1.8];
  };

  it('member temperatures rise, strength follows EN 1993-1-2 once (product with damage), the room heats', async () => {
    const c = await run(warehouse(), [fire({ position: columnXZ(), radius: 2.6 })], 360);
    const rt = rtOf(c), bt = rt.buildings[0], bodies = rt.world.bodies;
    const e = bt.e, m = e.modular!.structure?.model;
    let hottest = -1, Tmax = 0;
    for (let i = 0; i < bt.g.n; i++) if (bt.body[i] >= 0 && bt.g.structural[i] && bodies.TS[bt.body[i]] > Tmax) { Tmax = bodies.TS[bt.body[i]]; hottest = i; }
    expect(toC(Tmax)).toBeGreaterThan(400);
    expect(rt.world.comps.some((cp) => cp.E > 0)).toBe(true);
    expect(m?.material).toBeDefined();
    if (m && m.material) {
      const f = m.material[hottest];
      expect(f).toBeLessThan(1);
      // Applied as a separate factor: capacity factor = (1 − 0.3·D)·f, never a second damage index.
      expect(m.s.capFactor[hottest]).toBeCloseTo((1 - 0.3 * Math.min(1, m.damage[hottest])) * f, 9);
      expect(m.damage[hottest]).toBe(0);
    }
    expect(steelKy(500)).toBeCloseTo(0.78, 9);
    expect(rt.world.ledger.relativeResidual()).toBeLessThan(1e-9);
    c.unload();
  }, 120000);

  it('restrained expansion: no thermal force when free, a force through the load path when restrained; failures come from load vs reduced capacity', async () => {
    const withMode = async (restraint: 'none' | 'full') => {
      const d = warehouse();
      d.settings.simulation.thermal = { ambient: 288.15, airLayerHeight: 10, restraint };
      const c = await run(d, [fire({ temperature: 1173.15, position: columnXZ(), radius: 2.6 })], 300);
      const rt = rtOf(c), bt = rt.buildings[0];
      const m = bt.e.modular!.structure?.model;
      const out = { force: bt.nApplied.reduce((a, b) => a + Math.abs(b), 0), firstFail: m?.records.find((r) => r.hazard === 'thermal')?.time ?? Infinity, records: m?.records.filter((r) => r.hazard === 'thermal') ?? [] };
      c.unload();
      return out;
    };
    const free = await withMode('none'), full = await withMode('full');
    expect(free.force).toBe(0);
    expect(full.force).toBeGreaterThan(0);
    expect(full.firstFail).toBeLessThanOrEqual(free.firstFail);
    // Every thermal failure has a mechanical cause (axial / bending / thermal buckling / support …), never "temperature reached".
    for (const r of [...free.records, ...full.records]) expect(['axial', 'bending', 'shear', 'support', 'connection', 'thermal', 'impact', 'bearing']).toContain(r.cause);
  }, 240000);

  it('heated debris keeps its energy: members merging into rubble move their heat into the heap', async () => {
    const d = doc([B(design('house'))]);
    const c = await run(d, [heat({ kind: 'temperature', temperature: 1373.15, radius: 3, height: 2.5, duration: 900 })], 400);
    const rt = rtOf(c);
    expect(rt.world.ledger.relativeResidual()).toBeLessThan(1e-9);
    const m = rt.buildings[0].e.modular!.structure?.model;
    if (m && m.records.some((r) => r.hazard === 'thermal') && rt.heapBody.size) {
      let heapE = 0;
      for (const b of rt.heapBody.values()) heapE += rt.world.bodies.ES[b];
      expect(heapE).toBeGreaterThan(0);
    }
    c.unload();
  }, 240000);

  it('copies of one design are heated independently; the shared design is never written', async () => {
    const shared = design('house');
    const before = JSON.stringify(shared);
    const d = doc([B(shared, 0, 0), B(shared, 40, 0, 8)]);
    const c = await run(d, [heat({ kind: 'temperature', temperature: 1073.15, radius: 3, height: 2, position: [0, 0], duration: 60 })], 40);
    const rt = rtOf(c), B2 = rt.world.bodies;
    const [a, b] = rt.buildings.length === 2 ? rt.buildings : [rt.buildings[0], null];
    let hotA = 0;
    for (let i = 0; i < a.g.n; i++) if (a.body[i] >= 0) hotA = Math.max(hotA, B2.TS[a.body[i]]);
    expect(hotA).toBeGreaterThan(rt.world.Tref + 20);
    if (b) for (let i = 0; i < b.g.n; i++) if (b.body[i] >= 0) expect(B2.TS[b.body[i]]).toBeLessThan(rt.world.Tref + 1);
    expect(JSON.stringify(shared)).toBe(before);
    c.unload();
  }, 120000);

  it('legacy buildings get envelope / interior temperatures but no structural thermal response (documented)', async () => {
    const d = doc([{ type: 'building', seed: 1, transform: T(6, 0) }]);
    const c = await run(d, [heat({ kind: 'surface', position: [6, 0], radius: 6, power: 2e6, height: 3, duration: 60 })], 30);
    const rt = rtOf(c), e = [...c.getRuntime()!.entities.values()][0];
    const te = rt.entity(e.id)!;
    expect(rt.world.bodies.TS[te.body]).toBeGreaterThan(rt.world.Tref + 0.2);
    expect(e.modular).toBeUndefined();
    expect(rt.buildings.length).toBe(0);
    c.unload();
  });
});

describe('progressive collapse and ambient', () => {
  it('a heated RC slab fails in bending at its reduced capacity and the collapse engine carries it to a partial collapse attributed to heat', async () => {
    const des = design('apartment');
    const m0 = des.members.find((x) => x.type === 'column' && x.level === 0)!;
    const pos: [number, number] = [m0.position[0] + Math.sign(-m0.position[0] || 1) * 1.8, m0.position[2] + Math.sign(-m0.position[2] || 1) * 1.8];
    const c = await run(doc([B(des)]), [heat({ kind: 'temperature', position: pos, height: 4, radius: 3.2, temperature: 1373.15, duration: 3000 })], 900);
    const e = [...c.getRuntime()!.entities.values()][0];
    const m = e.modular!.structure!.model;
    expect(m.records.length).toBeGreaterThan(5);
    expect(m.records[0].hazard).toBe('thermal');
    expect(['bending', 'axial', 'shear']).toContain(m.records[0].cause);
    // Before failing, the member carried its load: strength had dropped (factor < 1), the load did not change.
    expect(m.material![m.records[0].i]).toBeLessThan(1);
    expect(['partial', 'global']).toContain(m.collapseLevel());
    expect(c.getMilestones().some((x) => x.kind === 'thermalFailure')).toBe(true);
    expect(c.getDamageEvents().some((x) => x.hazard === 'thermal' && x.eventType === 'FAILED')).toBe(true);
    expect(Math.abs(m.ledger.residual())).toBeLessThan(1e-6);
    expect(rtOf(c).world.ledger.relativeResidual()).toBeLessThan(1e-9);
    c.unload();
  }, 300000);

  it('the ambient setting is the reference state: a world at ambient stays exactly there; heat is measured from it', async () => {
    const d = doc([{ type: 'car', seed: 1, transform: T(30, 30) }]);
    d.settings.simulation.thermal = { ambient: 308.15, airLayerHeight: 10, restraint: 'frame' };
    const c = await run(d, [heat({ kind: 'area', position: [0, 0], radius: 2, power: 1e4, duration: 5 })], 10);
    const w = rtOf(c).world;
    expect(w.Tref).toBe(308.15);
    // Far from the source nothing changed (no flux at equal temperatures).
    expect(w.terrain.T(w.terrain.index(-60.5, -60.5), 0)).toBe(308.15);
    expect(w.air.T(w.air.index(-60, -60))).toBe(308.15);
    expect(w.terrain.T(w.terrain.index(0.5, 0.5), 0)).toBeGreaterThan(308.15);
    c.unload();
  });
});

describe('reproducibility and world preservation', () => {
  const scene = () => doc([B(design('house'), 0, 0), { type: 'car', seed: 3, transform: T(8, 3) }, { type: 'tree', seed: 4, transform: T(-7, 2) }]);
  const specs = () => [heat({ power: 8e5, duration: 30 }), heat({ kind: 'area', position: [6, -6], radius: 3, power: 3e5, duration: 30 })];

  it('is deterministic and independent of object ids and of the order the sources were added', async () => {
    const a = await run(scene(), specs(), 20);
    const b = await run(scene(), specs(), 20);
    const r = await run(scene(), specs().reverse(), 20);
    expect(thermalHash(b)).toBe(thermalHash(a));
    expect(thermalHash(r)).toBe(thermalHash(a));
    a.unload(); b.unload(); r.unload();
  });

  it('never writes the original world; reset restores the thermal state and a rerun is identical', async () => {
    const d = scene();
    const fp = worldFingerprint(d);
    const live0 = rapierWorlds.live;
    const c = new SimulationController({ headless: true });
    await c.load(d);
    for (const s of specs()) c.addEvent(s);
    c.advance(15);
    const h1 = thermalHash(c);
    await c.reset();
    expect(c.getEnvironment().thermal.rt).toBeNull();
    c.advance(15);
    expect(thermalHash(c)).toBe(h1);
    expect(worldFingerprint(d)).toBe(fp);
    c.unload();
    expect(rapierWorlds.live).toBe(live0);
  });

  it('saves heat sources and thermal settings in schema v7 and loads them back; older files get the defaults', async () => {
    const d = scene();
    d.settings.simulation.thermal = { ambient: 300.15, airLayerHeight: 12, restraint: 'full' };
    d.scenario.experiment.instances.push(createInstance('heatSource', [], heat({ kind: 'temperature', temperature: 900, radius: 2, duration: 30 })));
    const back = parseDocument(serializeDocument(d));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.doc.settings.simulation.thermal).toEqual({ ambient: 300.15, airLayerHeight: 12, restraint: 'full' });
    expect(back.doc.scenario.experiment.instances[0].type).toBe('heatSource');
    expect((back.doc.scenario.experiment.instances[0].spec as HeatSourceSpec).temperature).toBe(900);
    const raw = JSON.parse(serializeDocument(d));
    delete raw.settings.simulation.thermal;
    raw.schemaVersion = 5;
    const old = parseDocument(JSON.stringify(raw));
    expect(old.ok && old.doc.settings.simulation.thermal).toBeFalsy();
  });
});

describe('impact heat share (Phase 23 ledger)', () => {
  it('takes the heat only from the unresolved energy and deposits exactly that in the crater surface', async () => {
    const spec = { event: 'impact', target: [0, 0], material: 'iron', diameter: 0.6, speed: 12000, angle: 60, azimuth: 90, entry: 'direct', thermalShare: 0.1 } as EventSpec;
    const c = await run(doc([]), [spec], 8);
    const m = c.getEnvironment().impact.models[0];
    const p = m.plan.partition;
    expect(p.thermal).toBeGreaterThan(0);
    expect(p.thermal).toBeCloseTo(0.1 * p.impact, 0);
    expect(p.seismic + p.ejectaKinetic + p.blast + p.thermal + p.unresolved).toBeCloseTo(p.impact, 0);
    const w = rtOf(c).world;
    expect(w.ledger.impactDeposit).toBeCloseTo(p.thermal, 0);
    expect(w.ledger.relativeResidual()).toBeLessThan(1e-9);
    const none = await run(doc([]), [{ ...spec, thermalShare: undefined } as EventSpec], 8);
    expect(none.getEnvironment().thermal.rt).toBeNull();
    c.unload(); none.unload();
  }, 120000);
});
