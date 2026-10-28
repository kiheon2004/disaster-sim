/**
 * Earthquake integration (Phase 13): full SimulationController + Rapier runs.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import type { WorldDocument } from '@/core/model';
import type { EarthquakeEventSpec, WindEventSpec } from '@/events/specs';

function doc(inputs: CreateObjectInput[], seed = 42): WorldDocument {
  const d = createEmptyDocument('eq');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = seed;
  return d;
}

const quake = (pga: number, extra: Partial<EarthquakeEventSpec> = {}): EarthquakeEventSpec => ({ event: 'earthquake', magnitude: 6.8, pga, duration: 20, seed: 3, ...extra });

async function run(d: WorldDocument, spec: EarthquakeEventSpec | WindEventSpec, seconds: number) {
  const c = new SimulationController();
  await c.load(d);
  c.addEvent(spec);
  c.advance(seconds);
  return c;
}

const fingerprint = (c: SimulationController) => {
  const ev = c.getDamageEvents().map((e) => [e.time, e.objectId, e.componentId ?? '', e.eventType, e.cause, e.hazard, e.response, ...e.worldPosition].join('|'));
  const ent = [...c.getRuntime()!.entities.values()].map((e) => [e.id, e.state, e.health, ...e.pose.position, ...e.pose.quaternion].join('|'));
  return createHash('sha256').update(ev.join('\n') + '#' + ent.join('\n')).digest('hex');
};

const building = (floors: number, x = 0, z = 0): CreateObjectInput => ({ type: 'building', transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] }, params: { floors } });

describe('earthquake: damage follows the structural response', () => {
  it('weak shaking: no structural damage; stronger shaking: progressively more', async () => {
    const town = () => doc(sampleTown());
    const levels = [];
    for (const pga of [0.05, 0.3, 0.9]) {
      const c = await run(town(), quake(pga), 24);
      const ev = c.getDamageEvents().filter((e) => e.hazard === 'earthquake');
      const m = c.getMetrics()!.earthquake!;
      levels.push({ n: ev.length, drift: m.maxDrift, collapsed: m.buildingsCollapsed });
      c.unload();
    }
    expect(levels[0].n).toBe(0);
    expect(levels[0].drift).toBeLessThan(0.002);
    expect(levels[1].n).toBeGreaterThan(levels[0].n);
    expect(levels[2].n).toBeGreaterThan(levels[1].n);
    expect(levels[2].drift).toBeGreaterThan(levels[1].drift);
    expect(levels[1].collapsed).toBe(0);
    expect(levels[2].collapsed).toBeGreaterThan(0);
  }, 240_000);

  it('magnitude alone does not destroy anything: M9 with weak site shaking is harmless, M5 with strong shaking is not', async () => {
    const big = await run(doc([building(4)]), quake(0.04, { magnitude: 9 }), 24);
    expect(big.getDamageEvents().filter((e) => e.hazard === 'earthquake')).toHaveLength(0);
    big.unload();
    const small = await run(doc([building(4)]), quake(1.0, { magnitude: 5, duration: 15 }), 20);
    expect(small.getDamageEvents().some((e) => e.hazard === 'earthquake' && (e.eventType === 'CRACKED' || e.eventType === 'BROKEN'))).toBe(true);
    small.unload();
  }, 240_000);

  it('collapse: a strongly shaken building fails into rigid debris and leaves the wind field', async () => {
    const c = await run(doc([building(3)]), quake(1.2, { dominantFrequency: 2.5, duration: 25 }), 28);
    const e = [...c.getRuntime()!.entities.values()][0];
    expect(e.flags.collapsed).toBe(true);
    expect(e.state).toBe(4);
    const ev = c.getDamageEvents().find((x) => x.eventType === 'COLLAPSED')!;
    expect(ev.hazard).toBe('earthquake');
    expect(['drift', 'foundation']).toContain(ev.cause);
    expect(c.getRuntime()!.debris.filter((d) => d.kind === 'structure').length).toBeGreaterThan(0);
    expect(c.getRuntime()!.debris.every((d) => d.hazard === 'earthquake')).toBe(true);
    c.unload();
  }, 120_000);

  it('a stiffer, stronger structure suffers less than the default one', async () => {
    const weak = doc([building(4)]);
    const strong = doc([building(4)]);
    const o = Object.values(strong.objects)[0];
    o.seismic!.structure.strengthFactor = 3;
    const a = await run(weak, quake(0.6), 24);
    const b = await run(strong, quake(0.6), 24);
    const da = [...a.getRuntime()!.entities.values()][0].seismic!.damage;
    const db = [...b.getRuntime()!.entities.values()][0].seismic!.damage;
    expect(db).toBeLessThan(da);
    a.unload();
    b.unload();
  }, 120_000);
});

describe('earthquake: people, vehicles, infrastructure (Rapier)', () => {
  it('a parked car slides only when the ground acceleration beats friction', async () => {
    const car: CreateObjectInput = { type: 'car', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } };
    const calm = await run(doc([car]), quake(0.3), 22);
    const moved = [...calm.getRuntime()!.entities.values()][0].displacement;
    calm.unload();
    const strong = await run(doc([car]), quake(1.5, { duration: 20 }), 22);
    const slid = [...strong.getRuntime()!.entities.values()][0].displacement;
    strong.unload();
    expect(moved).toBeLessThan(0.01);
    expect(slid).toBeGreaterThan(moved + 0.02);
  }, 120_000);

  it('people lose balance and fall in strong shaking, stay up in weak shaking', async () => {
    const people: CreateObjectInput[] = Array.from({ length: 6 }, (_, i) => ({ type: 'human', transform: { position: [i * 3 - 8, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } }));
    const weak = await run(doc(people), quake(0.1), 22);
    expect([...weak.getRuntime()!.entities.values()].filter((e) => e.flags.fallen)).toHaveLength(0);
    weak.unload();
    const strong = await run(doc(people), quake(0.6), 22);
    const fell = strong.getDamageEvents().filter((e) => e.eventType === 'FALLEN');
    expect(fell.length).toBeGreaterThan(3);
    expect(fell.every((e) => e.hazard === 'earthquake' && e.cause === 'shaking')).toBe(true);
    strong.unload();
  }, 120_000);

  it('a free-standing masonry wall overturns under strong shaking', async () => {
    const wall: CreateObjectInput = { type: 'wall', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, params: { height: 2.4, thickness: 0.15 } };
    const c = await run(doc([wall]), quake(0.8, { direction: 0 }), 22); // N–S = out of plane of an E–W wall
    expect(c.getDamageEvents().some((e) => e.objectType === 'wall' && e.eventType === 'COLLAPSED' && e.hazard === 'earthquake')).toBe(true);
    c.unload();
  }, 120_000);
});

describe('earthquake: determinism and isolation', () => {
  it('same world + event + seed → bit-identical damage sequence and final poses', async () => {
    const d = doc(sampleTown());
    const a = await run(d, quake(0.7), 16);
    const b = await run(d, quake(0.7), 16);
    expect(a.getDamageEvents().length).toBeGreaterThan(10);
    const fa = fingerprint(a);
    expect(fingerprint(b)).toBe(fa);
    a.unload();
    b.unload();
    const c = await run(d, quake(0.7, { seed: 4 }), 16);
    expect(fingerprint(c)).not.toBe(fa);
    c.unload();
  }, 240_000);

  it('wind-only runs never build the seismic model', async () => {
    const c = await run(doc(sampleTown()), { event: 'wind', speed: 40, direction: 'E', duration: 20 }, 3);
    expect(c.getRuntime()!.seismic).toBeUndefined();
    expect(c.getDamageEvents().every((e) => e.hazard === 'wind')).toBe(true);
    expect(c.getMetrics()!.earthquake).toBeNull();
    c.unload();
  }, 120_000);

  it('soil profiles do not change wind results (terrain regression)', async () => {
    const plain = doc(sampleTown());
    const soiled = structuredClone(plain);
    soiled.terrain.soil.fill(3);
    soiled.terrain.revision++;
    const wind: WindEventSpec = { event: 'wind', speed: 46, direction: 'S', duration: 30, gustStrength: 0.3 };
    const a = await run(plain, wind, 6);
    const b = await run(soiled, wind, 6);
    expect(fingerprint(b)).toBe(fingerprint(a));
    a.unload();
    b.unload();
  }, 120_000);

  it('soft soil under the same building and input shakes it harder', async () => {
    const dense = doc([building(4)]);
    const soft = structuredClone(dense);
    soft.terrain.soil.fill(2);
    soft.terrain.revision++;
    const a = await run(dense, quake(0.25, { dominantFrequency: 1.5 }), 22);
    const b = await run(soft, quake(0.25, { dominantFrequency: 1.5 }), 22);
    const ea = [...a.getRuntime()!.entities.values()][0].seismic!;
    const eb = [...b.getRuntime()!.entities.values()][0].seismic!;
    expect(eb.pga).toBeGreaterThan(ea.pga * 1.15);
    expect(eb.peakDrift).toBeGreaterThan(ea.peakDrift);
    a.unload();
    b.unload();
  }, 120_000);
});
