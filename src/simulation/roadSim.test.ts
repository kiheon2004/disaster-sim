/**
 * Roads in the simulation (Phase 18): full SimulationController runs.
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { defaultWaterSettings, type BoundarySide, type WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { drawRoad } from '@/roads/network';
import { bakeRegion } from '@/roads/bake';
import { fullRect } from '@/terrain/TerrainData';
import { defaultProfile, emptyNetwork, type RoadProfile } from '@/roads/types';
import { INLET_CAPACITY } from '@/roads/materials';
import { worldFingerprint } from '@/world/fingerprint';

function roadDoc(profile: Partial<RoadProfile> = {}, opts: { drainage?: number; slope?: number } = {}): WorldDocument {
  const d = createEmptyDocument('roads');
  if (opts.slope) {
    const t = d.terrain;
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = Math.round(-opts.slope * (t.originX + ix) * 100) / 100;
  }
  const net = drawRoad(emptyNetwork(), [[-80, 0], [80, 0]], { curved: false, profile: { ...defaultProfile(), ...profile } }).network;
  const r = bakeRegion(d.terrain, emptyNetwork(), net, fullRect(d.terrain));
  d.roads = { ...net, underlay: r.underlay };
  const w = defaultWaterSettings();
  for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: 'closed' };
  w.infiltration = false;
  w.drainageCapacity = opts.drainage ?? 0;
  w.initialFromReference = false;
  d.settings.simulation.water = w;
  d.settings.simulation.seed = 5;
  return d;
}

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const c = new SimulationController();
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}

describe('roads in the simulation', { timeout: 240_000 }, () => {
  it('a strong earthquake cracks a concrete road before an asphalt one; a weak one cracks nothing', async () => {
    const strong: EventSpec = { event: 'earthquake', magnitude: 7, pga: 0.6, duration: 12, seed: 3 };
    const weak: EventSpec = { event: 'earthquake', magnitude: 5, pga: 0.05, duration: 10, seed: 3 };
    const c1 = await run(roadDoc({ material: 'concrete' }), [strong], 14);
    const r1 = c1.getRuntime()!.roads!;
    expect(r1.segments[0].peakPgv).toBeGreaterThan(0.1);
    const c2 = await run(roadDoc({ material: 'gravel' }), [strong], 14);
    const r2 = c2.getRuntime()!.roads!;
    // Same ground motion, brittle slab cracks more than unbound gravel.
    expect(r1.segments[0].crack).toBeGreaterThan(0);
    expect(r1.segments[0].crack).toBeGreaterThan(r2.segments[0].crack);
    expect(r1.events.some((e) => e.kind === 'cracked')).toBe(true);
    c1.unload();
    c2.unload();
    const c3 = await run(roadDoc(), [weak], 12);
    expect(c3.getRuntime()!.roads!.segments[0].crack).toBe(0);
    c3.unload();
  });

  it('heavy rain inundates the road; drain inlets remove water with the mass budget closed', async () => {
    const rain: EventSpec = { event: 'rain', intensity: 400, duration: 600 };
    const none = await run(roadDoc({ drainage: 'none' }), [rain], 60);
    const enh = await run(roadDoc({ drainage: 'enhanced' }), [rain], 60);
    const fNone = none.getRuntime() && (none as unknown as { env: { flood: { field: { budget: { drainage: number; error: number }; totalVolume(): number; inletCells: number } } } }).env.flood.field;
    const fEnh = (enh as unknown as { env: { flood: { field: { budget: { drainage: number; error: number }; totalVolume(): number; inletCells: number } } } }).env.flood.field;
    expect(fNone!.inletCells).toBe(0);
    expect(fEnh.inletCells).toBeGreaterThan(10);
    expect(fEnh.budget.drainage).toBeGreaterThan(0);
    expect(Math.abs(fEnh.budget.error)).toBeLessThan(1e-6 * Math.max(1, fEnh.totalVolume()));
    // The crown sheds the rain to the gutters: water stands at the curbs first.
    const st = none.getRuntime()!.roads!.segments[0];
    expect(st.maxDepth).toBeGreaterThan(0);
    expect(st.maxDepth).toBeGreaterThan(st.maxCrownDepth);
    expect(fEnh.totalVolume()).toBeLessThan(fNone!.totalVolume());
    // Inlet capacity bound: drained ≤ inlets × capacity × time.
    expect(fEnh.budget.drainage).toBeLessThanOrEqual(fEnh.inletCells * INLET_CAPACITY * 60 + 1e-6);
    none.unload();
    enh.unload();
  });

  it('runs leave the original roads untouched and are deterministic', async () => {
    const d = roadDoc();
    const before = worldFingerprint(d);
    const roadsBefore = JSON.stringify(d.roads);
    const q: EventSpec = { event: 'earthquake', magnitude: 7, pga: 0.7, duration: 10, seed: 9 };
    const a = await run(d, [q], 11);
    const b = await run(d, [q], 11);
    expect(JSON.stringify(a.getRuntime()!.roads!.segments)).toBe(JSON.stringify(b.getRuntime()!.roads!.segments));
    expect(worldFingerprint(d)).toBe(before);
    expect(JSON.stringify(d.roads)).toBe(roadsBefore);
    a.unload();
    b.unload();
  });

  it('roads are part of the ground: a car on a graded road on a slope stays on it (no flying)', async () => {
    const d = roadDoc({}, { slope: 0.05 });
    const o = createWorldObject({ type: 'car', transform: { position: [0, 0, 1.75], rotation: [0, 0, 0], scale: [1, 1, 1] } }, nextSerial(d.objects, 'car'));
    const { reseat } = await import('@/terrain/groundPlacement');
    const { TerrainSampler } = await import('@/terrain/TerrainSampler');
    const p = reseat(o, new TerrainSampler(d.terrain));
    o.transform.position = p.position;
    o.transform.rotation = p.rotation;
    d.objects[o.id] = o;
    const c = await run(d, [{ event: 'wind', speed: 20, direction: 'E', duration: 10, gustStrength: 0.2, rampDuration: 2 }], 8);
    const e = c.getRuntime()!.entities.get(o.id)!;
    expect(Math.abs(e.pose.position[1] - p.position[1])).toBeLessThan(0.3);
    c.unload();
  });
});
