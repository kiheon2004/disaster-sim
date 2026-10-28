/**
 * Flood integration (Phase 14): full SimulationController + Rapier runs.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import { defaultWaterSettings, type BoundarySide, type WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField } from './water/WaterField';
import { captureWaterState } from './water/waterStateCodec';
import { relativeError } from './water/WaterField';
import { mmPerHour } from './water/waterParams';
import { personStability } from './damage/behaviors/flood';
import { WATER_SOLVER_INTERVAL } from './systems/WaterSolverSystem';
import { FIXED_DT } from '@/core/units';
import { WET_GRIP, WET_GROUND_DEPTH } from './systems/GroundContactSystem';

const T = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
const at = (x: number, z: number, yaw = 0) => ({ ...T, position: [x, 0, z] as [number, number, number], rotation: [0, yaw, 0] as [number, number, number] });

function doc(inputs: CreateObjectInput[], opts: { seed?: number; edges?: Partial<Record<BoundarySide, 'closed' | 'open'>>; slope?: number } = {}): WorldDocument {
  const d = createEmptyDocument('flood');
  for (const input of inputs) {
    const o = createWorldObject({ seed: 7, ...input }, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = opts.seed ?? 42;
  const w = defaultWaterSettings();
  for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: opts.edges?.[s] ?? 'closed' };
  w.infiltration = false;
  w.drainageCapacity = 0;
  // Water enters from the edges during the run (no pre-filled "sea" below a fixed level).
  w.initialFromReference = false;
  d.settings.simulation.water = w;
  if (opts.slope) {
    const t = d.terrain;
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = Math.round(-opts.slope * (t.originX + ix) * 100) / 100;
    t.revision++;
  }
  return d;
}

/** A water state with `depth(x, z)` of still water, as a mid-simulation snapshot. */
function waterState(d: WorldDocument, depth: (x: number, z: number) => number) {
  const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
  for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) f.h[iz * f.nx + ix] = Math.max(0, depth(f.cellX(ix), f.cellZ(iz)));
  return captureWaterState(f, 0);
}

/** A tiny rain only activates the water model (so the initial state is applied). */
const nudge: EventSpec = { event: 'rain', intensity: 0.1, duration: 600 };

async function run(d: WorldDocument, specs: EventSpec[], seconds: number, initial?: ReturnType<typeof waterState>) {
  const c = new SimulationController();
  if (initial) c.setInitialWaterState(initial);
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}

const car = (x: number, z: number, params = {}): CreateObjectInput => ({ type: 'car', transform: at(x, z), params });
const person = (x: number, z: number): CreateObjectInput => ({ type: 'human', transform: at(x, z) });

describe('flood: vehicles', { timeout: 240_000 }, () => {
  it('a car does not float just because water reached it: shallow water → grounded, deep water → lifted', async () => {
    const d = doc([car(0, 0)]);
    const shallow = await run(d, [nudge], 6, waterState(d, () => 0.15));
    const e1 = [...shallow.getRuntime()!.entities.values()][0];
    expect(e1.flood!.depth).toBeGreaterThan(0.1);
    expect(e1.flood!.buoyancyRatio).toBeLessThan(1);
    expect(e1.flood!.floated).toBe(false);
    expect(Math.abs(e1.pose.position[1])).toBeLessThan(0.05);
    shallow.unload();

    const deep = await run(d, [nudge], 6, waterState(d, () => 1.3));
    const e2 = [...deep.getRuntime()!.entities.values()][0];
    expect(e2.flood!.floated).toBe(true);
    expect(e2.pose.position[1]).toBeGreaterThan(0.1);
    const ev = deep.getDamageEvents().find((x) => x.eventType === 'FLOATED')!;
    expect(ev.hazard).toBe('flood');
    expect(ev.cause).toBe('buoyancy');
    expect(ev.waterDepth).toBeGreaterThan(1);
    deep.unload();
  });

  it('buoyancy depends on mass and displaced volume: a heavy truck stays down where a sedan floats', async () => {
    const d = doc([car(-10, 0, { variant: 'sedan' }), car(10, 0, { variant: 'truck', length: 8, width: 2.5, height: 3.2 })]);
    // Make the truck heavy (loaded): same water, very different buoyancy / weight.
    const truckObj = Object.values(d.objects)[1];
    truckObj.physics.mass = 16000;
    const c = await run(d, [nudge], 6, waterState(d, () => 0.9));
    const [sedan, truck] = [...c.getRuntime()!.entities.values()];
    expect(sedan.flood!.buoyancyRatio).toBeGreaterThan(truck.flood!.buoyancyRatio);
    expect(truck.flood!.floated).toBe(false);
    expect(sedan.flood!.floated).toBe(true);
    c.unload();
  });

  it('flowing water pushes a floating car downstream (MOVED, hazard = flood)', async () => {
    // West edge held 1.4 m above the ground there, terrain falls 1 % to the east, east edge open.
    const d = doc([car(-60, 0)], { slope: 0.01, edges: { E: 'open' } });
    d.settings.simulation.water.boundaries.W = { type: 'fixedLevel', level: 1 + 1.4 };
    const c = await run(d, [nudge], 90);
    const e = [...c.getRuntime()!.entities.values()][0];
    expect(e.pose.position[0]).toBeGreaterThan(-58);
    const moved = c.getDamageEvents().find((x) => x.eventType === 'MOVED');
    expect(moved?.hazard).toBe('flood');
    expect(['hydrodynamic', 'buoyancy']).toContain(moved?.cause);
    c.unload();
  });
});

describe('ground-contact friction (Phase 12 limitation fixed)', { timeout: 240_000 }, () => {
  it('a car pushed from asphalt onto grass takes the grip of the ground it is on now (and wet grip in water)', async () => {
    const d = doc([car(-60, 0)], { slope: 0.01, edges: { E: 'open' } });
    // Asphalt west of x = −56, grass elsewhere.
    const t = d.terrain;
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) if (t.originX + ix < -56) t.ground[iz * t.nx + ix] = 3;
    t.revision++;
    d.settings.simulation.water.boundaries.W = { type: 'fixedLevel', level: 1 + 1.4 };
    const c = new SimulationController();
    await c.load(d);
    const e = [...c.getRuntime()!.entities.values()][0];
    const asphalt = 0.7 / 0.55;
    expect(e.groundFriction).toBeCloseTo(asphalt, 6); // start: the ground under it
    c.addEvent(nudge);
    c.advance(90);
    expect(e.pose.position[0]).toBeGreaterThan(-55); // pushed onto grass
    expect(e.groundFriction).toBeCloseTo(e.flood!.depth > WET_GROUND_DEPTH ? WET_GRIP : 1, 6);
    c.unload();
  });
});

describe('flood: people', { timeout: 240_000 }, () => {
  it('stability ratio grows with depth × speed and falls with weight (h·v ≈ 1 m²/s → unstable)', () => {
    expect(personStability(70, 1.7, 0.3, 0.3, 0.5, 120)).toBeLessThan(0.3);
    expect(personStability(70, 1.7, 0.3, 0.5, 2, 200)).toBeGreaterThan(1);
    expect(personStability(40, 1.4, 0.25, 0.5, 1.6, 120)).toBeGreaterThan(personStability(80, 1.8, 0.32, 0.5, 1.6, 120));
    expect(personStability(70, 1.7, 0.3, 0.6, 0, 250)).toBe(0); // still water alone does not push
  });

  it('still shallow water: people keep standing; a strong current: they fall and are carried downstream', async () => {
    const still = await run(doc([person(0, 0)]), [nudge], 8, waterState(doc([]), () => 0.3));
    const p1 = [...still.getRuntime()!.entities.values()][0];
    expect(p1.flags.fallen).toBeFalsy();
    expect(p1.flood!.depth).toBeGreaterThan(0.25);
    still.unload();

    const d = doc([person(-40, 0)], { slope: 0.01, edges: { E: 'open' } });
    d.settings.simulation.water.boundaries.W = { type: 'fixedLevel', level: 1 + 1.2 };
    const c = await run(d, [nudge], 80);
    const p2 = [...c.getRuntime()!.entities.values()][0];
    expect(p2.flags.fallen).toBe(true);
    const fell = c.getDamageEvents().find((x) => x.eventType === 'FALLEN')!;
    expect(fell.hazard).toBe('flood');
    expect(fell.cause).toBe('hydrodynamic');
    expect(fell.waterDepth * fell.flowSpeed).toBeGreaterThan(0.3);
    expect(p2.pose.position[0]).toBeGreaterThan(-39); // carried with the flow (+x)
    expect(c.getMetrics()!.flood!.fallenHumans).toBe(1);
    c.unload();
  });
});

describe('flood: structures', { timeout: 240_000 }, () => {
  it('a free-standing masonry wall fails under a water depth difference; the breach then lets water through', async () => {
    // A 200 m line of walls along x = 0 holds 1.4 m of water on the west side; the east is dry.
    const walls = [-80, -40, 0, 40, 80].map((z): CreateObjectInput => ({ type: 'wall', transform: at(0, z, Math.PI / 2), params: { length: 40, height: 2, thickness: 0.3 } }));
    const d = doc(walls);
    const c = await run(d, [nudge], 6, waterState(d, (x) => (x < -1 ? 1.4 : 0)));
    const ev = c.getDamageEvents().filter((x) => x.hazard === 'flood' && x.eventType === 'COLLAPSED');
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].cause).toBe('hydrostatic');
    expect(ev[0].waterDepth).toBeGreaterThan(1.2);
    c.advance(10);
    const f = c.getEnvironment().flood.field!;
    expect(f.h[f.indexAt(10.5, 0.5)]).toBeGreaterThan(0.05); // water went through
    c.unload();
  });

  it('the same wall stands in shallow water', async () => {
    const walls = [-80, -40, 0, 40, 80].map((z): CreateObjectInput => ({ type: 'wall', transform: at(0, z, Math.PI / 2), params: { length: 40, height: 2, thickness: 0.3 } }));
    const d = doc(walls);
    const c = await run(d, [nudge], 6, waterState(d, (x) => (x < -1 ? 0.4 : 0)));
    expect(c.getDamageEvents().filter((x) => x.eventType === 'COLLAPSED')).toHaveLength(0);
    c.unload();
  });

  it('buildings: inundation is recorded with depth and exposure; no collapse rule at a fixed depth (RC office in 1.5 m)', async () => {
    const d = doc([{ type: 'building', transform: at(0, 0), params: { floors: 6 } }]);
    const c = await run(d, [nudge], 30, waterState(d, () => 1.5));
    const e = [...c.getRuntime()!.entities.values()][0];
    const inund = c.getDamageEvents().filter((x) => x.eventType === 'INUNDATED');
    expect(inund.length).toBeGreaterThan(0);
    expect(inund.every((x) => x.hazard === 'flood' && x.cause === 'inundation')).toBe(true);
    expect(e.flood!.exposure).toBeGreaterThan(20);
    expect(e.flags.collapsed).toBeFalsy();
    expect(e.flood!.loadRatio).toBeLessThan(0.5);
    expect(e.state).toBeGreaterThanOrEqual(1);
    c.unload();
  });
});

describe('flood: water budget and events in the full simulation', { timeout: 240_000 }, () => {
  it('rain input matches intensity × duration × map area (within one solver interval)', async () => {
    const d = doc([]);
    const c = await run(d, [{ event: 'rain', intensity: 80, duration: 30 }], 40);
    const b = c.getEnvironment().flood.field!.budget;
    const exact = mmPerHour(80) * 30 * 200 * 200;
    expect(Math.abs(b.rain - exact)).toBeLessThanOrEqual(mmPerHour(80) * WATER_SOLVER_INTERVAL * FIXED_DT * 200 * 200 + 1e-6);
    expect(relativeError(b)).toBeLessThan(1e-9);
    expect(c.getMetrics()!.flood!.totalVolume).toBeCloseTo(b.rain, 3); // closed, no losses
    c.unload();
  });

  it('a local source fills a closed map with exactly its inflow', async () => {
    const c = await run(doc([]), [{ event: 'waterSource', position: [0, 0], rate: 5, duration: 20 }], 30);
    const b = c.getEnvironment().flood.field!.budget;
    expect(b.sources).toBeCloseTo(100, 0);
    expect(relativeError(b)).toBeLessThan(1e-9);
    c.unload();
  });

  it('typhoon + heavy rain and earthquake + flood run together without conflicts', async () => {
    const base = () => doc(sampleTown().slice(0, 40));
    const c = await run(base(), [
      { event: 'wind', speed: 40, direction: 'S', duration: 30, gustStrength: 0.3, rampDuration: 3 },
      { event: 'rain', intensity: 120, duration: 30 },
      { event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 12, seed: 3 },
    ], 16, waterState(base(), () => 0.4));
    const hz = new Set(c.getDamageEvents().map((e) => e.hazard));
    expect(hz.has('wind')).toBe(true);
    expect(hz.has('flood')).toBe(true);
    const m = c.getMetrics()!;
    expect(m.earthquake).not.toBeNull();
    expect(m.flood).not.toBeNull();
    for (const e of c.getRuntime()!.entities.values()) {
      expect(Number.isFinite(e.pose.position[0]) && Number.isFinite(e.health)).toBe(true);
    }
    c.unload();
  });
});

describe('flood: determinism', { timeout: 240_000 }, () => {
  const fingerprint = (c: SimulationController) => {
    const f = c.getEnvironment().flood.field!;
    const ev = c.getDamageEvents().map((e) => [e.time, e.objectId, e.eventType, e.cause, e.hazard, e.waterDepth, e.flowSpeed].join('|'));
    const ent = [...c.getRuntime()!.entities.values()].map((e) => [e.id, e.state, e.health, ...e.pose.position].join('|'));
    return createHash('sha256').update(Buffer.from(f.h.buffer)).update(ev.join('\n')).update(ent.join('\n')).digest('hex');
  };

  it('same terrain + world + flood event + seed + step → identical water and damage', async () => {
    const d = doc([car(-20, 0), person(-15, 3), { type: 'building', transform: at(5, 0) }], { slope: 0.01, edges: { E: 'open' } });
    d.settings.simulation.water.boundaries.W = { type: 'fixedLevel', level: 1 + 1.3 };
    const specs: EventSpec[] = [{ event: 'rain', intensity: 60, duration: 20 }];
    const a = await run(d, specs, 40);
    const fa = fingerprint(a);
    a.unload();
    const b = await run(d, specs, 40);
    expect(fingerprint(b)).toBe(fa);
    b.unload();
  });
});
