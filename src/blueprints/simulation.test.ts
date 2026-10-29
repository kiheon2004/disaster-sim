/**
 * Phase 20: worlds built from blueprints in the simulation — wind / earthquake / flood /
 * multi-hazard runs, original-world restoration, determinism (same blueprint + same seed → same
 * initial conditions and results, whatever the fresh ids), hydrology mass conservation.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { SimulationController } from '@/simulation/SimulationController';
import { defaultWaterSettings, type BoundarySide } from '@/core/model';
import { buildBuiltinBlueprint } from './builtin';
import { defaultPlacement, planPlacement, type PlacementOptions } from './place';
import type { UnifiedBlueprint } from './types';

const S = () => useWorldStore.getState();
const place = (bp: UnifiedBlueprint, o: Partial<PlacementOptions>) => {
  const plan = planPlacement(S().doc, bp, { ...defaultPlacement(), ...o });
  expect(plan.report.errors).toEqual([]);
  return S().applyEdit(plan.edit);
};

const house = buildBuiltinBlueprint('house');
const crossroads = buildBuiltinBlueprint('crossroads');
const mixed = buildBuiltinBlueprint('mixedDistrict');
const river = buildBuiltinBlueprint('riverBasin');

/** A world assembled only from blueprints. */
function blueprintWorld(): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  place(mixed, { x: 0, z: 0, terrain: 'apply' });
  place(house, { x: -80, z: 86, yaw: Math.PI / 2, terrain: 'offset' });
  place(crossroads, { x: 58, z: 58, roads: 'snap', terrain: 'preserve' });
  return structuredClone(S().doc);
}

/** Simulation fingerprint keyed by object ORDER (ids differ between equal worlds). */
async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, i]));
  const c = new SimulationController();
  await c.load(d);
  for (const sp of specs) c.addEvent(sp);
  c.advance(seconds);
  const events = c.getDamageEvents();
  const lines = events.map((e) => [e.time, index.get(e.objectId), e.componentId ?? '', e.eventType, e.hazard, e.force, e.damageAfter].join('|'));
  const ents = [...c.getRuntime()!.entities.values()];
  const finite = ents.every((e) => e.pose.position.every(Number.isFinite) && Number.isFinite(e.health));
  const hash = createHash('sha256').update(lines.join('\n') + '#' + ents.map((e) => [index.get(e.id), e.state, e.health, ...e.pose.position].join('|')).join('\n')).digest('hex');
  const byHazard: Record<string, number> = { wind: 0, earthquake: 0, flood: 0 };
  for (const e of events) byHazard[e.hazard]++;
  const flood = (c as unknown as { env: { flood?: { field: { totalVolume(): number; budget: { error: number } } } } }).env.flood?.field;
  const water = flood ? { volume: flood.totalVolume(), error: flood.budget.error } : null;
  c.unload();
  return { events: events.length, hash, finite, byHazard, water };
}

const WIND: EventSpec = { event: 'wind', speed: 52, direction: 'E', duration: 30, gustStrength: 0.3, rampDuration: 2 };
const QUAKE: EventSpec = { event: 'earthquake', magnitude: 7, pga: 0.55, duration: 12, seed: 3 };
const RAIN: EventSpec = { event: 'rain', intensity: 150, duration: 60 };

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('hazards on a world built from blueprints', { timeout: 600_000 }, () => {
  it('wind, earthquake, flood and a multi-hazard run work, stay finite and repeat exactly; the original world is untouched', async () => {
    const d = blueprintWorld();
    const json = serializeDocument(d);
    const fp = worldFingerprint(d);
    const wind = await run(d, [WIND], 20);
    const quake = await run(d, [QUAKE], 14);
    const flood = await run(d, [RAIN], 20);
    const multi = await run(d, [WIND, { ...QUAKE, startTime: 5 } as EventSpec, RAIN], 20);
    for (const r of [wind, quake, flood, multi]) expect(r.finite).toBe(true);
    expect(wind.byHazard.wind).toBeGreaterThan(0);
    expect(quake.byHazard.earthquake).toBeGreaterThan(0);
    expect(flood.water!.volume).toBeGreaterThan(100); // river water + rain
    expect(Math.abs(flood.water!.error)).toBeLessThan(1e-6 * flood.water!.volume);
    expect(multi.byHazard.wind + multi.byHazard.earthquake).toBeGreaterThan(0);
    // Repeats exactly.
    expect((await run(d, [WIND], 20)).hash).toBe(wind.hash);
    expect((await run(d, [WIND, { ...QUAKE, startTime: 5 } as EventSpec, RAIN], 20)).hash).toBe(multi.hash);
    // Original world: simulations never touched the document.
    expect(worldFingerprint(S().doc)).toBe(fp);
    expect(serializeDocument(S().doc)).toBe(json);
  });

  it('a reset restores the original world (same snapshot, same results after reset)', async () => {
    const d = blueprintWorld();
    const c = new SimulationController();
    await c.load(d);
    c.addEvent(QUAKE);
    c.advance(10);
    const first = c.getDamageEvents().map((e) => `${e.time}:${e.eventType}`).join(',');
    await c.reset();
    c.advance(10);
    expect(c.getDamageEvents().map((e) => `${e.time}:${e.eventType}`).join(',')).toBe(first);
    c.unload();
    expect(worldFingerprint(S().doc)).toBe(worldFingerprint(d));
  });

  it('same blueprint + same placement + same seed → same initial conditions and results, though ids are fresh', async () => {
    const a = blueprintWorld();
    const b = blueprintWorld();
    expect(Object.keys(a.objects)).not.toEqual(Object.keys(b.objects));
    // Canonical content: ids replaced by creation order.
    const canon = (d: WorldDocument) => {
      const ids = Object.keys(d.objects);
      let s = serializeDocument({ ...d, meta: { ...d.meta, createdAt: '', updatedAt: '' } });
      ids.forEach((id, i) => { s = s.split(`"${id}"`).join(`"#${i}"`); });
      return s.replace(/"grp_[^"]+"/g, '"grp"');
    };
    expect(canon(b)).toBe(canon(a));
    const ra = await run(a, [WIND, QUAKE], 14);
    const rb = await run(b, [WIND, QUAKE], 14);
    expect(rb.hash).toBe(ra.hash);
  });
});

describe('hydrology after placing water blueprints', { timeout: 300_000 }, () => {
  it('a cut river placed across the map keeps its inflow, reaches an open edge and conserves mass', async () => {
    S().newDocument();
    // River basin blueprint (120 m wide, river cut at both ends): turned to run from edge to edge
    // would leave gaps — place it centred; the inflow enters at the cut upstream end.
    place(river, { x: 0, z: 0, terrain: 'apply' });
    const d = structuredClone(S().doc);
    const w = defaultWaterSettings();
    for (const side of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[side] = { type: 'closed' };
    d.settings.simulation.water = { ...w, infiltration: false, drainageCapacity: 0 };
    const c = new SimulationController();
    await c.load(d);
    c.advance(60);
    const f = (c as unknown as { env: { flood: { field: { totalVolume(): number; budget: { error: number; initial: number } } } } }).env.flood.field;
    expect(f.budget.initial).toBeGreaterThan(10); // the channel starts filled
    expect(f.totalVolume()).toBeGreaterThan(f.budget.initial); // + inflow (closed edges)
    expect(Math.abs(f.budget.error)).toBeLessThan(1e-6 * Math.max(1, f.totalVolume()));
    c.unload();
  });

  it('blueprints never carry dynamic water state; a dry placement starts with no water', async () => {
    S().newDocument();
    const text = JSON.stringify(river);
    expect(text).not.toMatch(/"depth":\[|velocity|waterState"\s*:\s*\{/);
    place(river, { x: 0, z: 0, terrain: 'apply', include: { ...defaultPlacement().include, waterState: false } });
    const c = new SimulationController();
    await c.load(structuredClone(S().doc));
    c.addEvent({ event: 'rain', intensity: 1, duration: 1 });
    c.advance(1);
    const f = (c as unknown as { env: { flood: { field: { budget: { initial: number } } } } }).env.flood.field;
    expect(f.budget.initial).toBe(0);
    c.unload();
  });
});
