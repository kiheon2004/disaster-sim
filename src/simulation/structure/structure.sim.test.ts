/**
 * Phase 25: structural destruction in the simulation — collapse engine driven by the hazards,
 * fragments, rubble, secondary damage, attribution, ledgers, determinism, restoration, save / load,
 * shared designs, resource cleanup.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { worldFingerprint } from '@/world/fingerprint';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { BuildingDesign } from '@/buildings/types';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { rapierWorlds } from '@/physics/RapierEngine';
import { MS } from '@/structure/types';
import { ACCOUNTS } from '@/structure/ledger';
import { SimulationController } from '../SimulationController';
import type { RuntimeEntity } from '../SimulationRuntime';
import { FRAGMENT_LIMITS } from './fragments';
import { defaultWaterSettings } from '@/core/model';
import { WaterField, relativeError } from '../water/WaterField';
import { captureWaterState } from '../water/waterStateCodec';
import { samplerFor } from '@/terrain/TerrainSampler';

const T = (x = 0, z = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string) => createDesign(presetSpec(id)!, id);
const B = (d: BuildingDesign, x = 0, z = 0, seed = 7): CreateObjectInput => ({ type: 'building', building: d, seed, transform: T(x, z) });

function doc(inputs: CreateObjectInput[]): WorldDocument {
  const d = createEmptyDocument('p25');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  return d;
}

const quake = (pga: number): EventSpec => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed: 3 } as EventSpec);

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}

const buildings = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'building');
const model = (e: RuntimeEntity) => e.modular!.structure!.model;

function sequenceHash(c: SimulationController): string {
  const lines: string[] = [];
  for (const e of buildings(c)) {
    const m = e.modular?.structure?.model;
    if (!m) continue;
    lines.push(e.id, ...m.records.map((r) => [r.i, r.time, r.cause, r.trigger, r.root, r.u, r.hazard].join('|')), Array.from(m.dy).join(','));
  }
  const S = c.getRuntime()!.structures;
  if (S) lines.push(...S.rubble.heaps.map((h) => [h.owner, h.mass, h.height].join('|')), ...S.fragments.map((f) => [f.id, ...f.pose.position].join('|')));
  lines.push(...c.getDamageEvents().map((e) => [e.time, e.objectId, e.eventType, e.componentId ?? '', e.hazard, e.cause].join('|')));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** A collapsing apartment, a house next to it, cars along the street (6 m apart). */
const street = () => doc([B(design('apartment')), B(design('house'), 18, 0, 8), ...[0, 1, 2, 3, 4].map((k) => ({ type: 'car' as const, seed: 20 + k, transform: T(-12 + k * 6, 10) }))]);

afterEach(() => {
  FRAGMENT_LIMITS.active = 160;
  FRAGMENT_LIMITS.total = 600;
});

describe('earthquake → progressive collapse → debris → secondary damage', { timeout: 600_000 }, () => {
  it('member failures, load redistribution, falling floors, rubble pile and fragments — mass conserved per building', async () => {
    const c = await run(street(), [quake(1.1)], 24);
    const apt = buildings(c)[0];
    const m = model(apt);
    // Failures recorded with their causes and chains (drift first, then what it brought down).
    expect(m.records.some((r) => r.cause === 'drift' || r.cause === 'story')).toBe(true);
    expect(m.records.some((r) => r.trigger >= 0)).toBe(true);
    expect(m.events.length).toBe(0);
    expect(['partial', 'global']).toContain(m.collapseLevel());
    // Nothing is still falling at the end; every member is in a final state.
    for (let i = 0; i < m.n; i++) {
      expect(m.state[i] === MS.FAILED || m.state[i] === MS.DETACHED).toBe(false);
      if (m.state[i] === MS.FALLING) expect(m.external[i]).toBe(1); // a fragment still moving in the physics engine
    }
    // Ledger: original mass in exactly one account (float rounding only).
    const L = m.ledger;
    let sum = 0;
    for (const a of ACCOUNTS) sum += L.mass[a];
    expect(Math.abs(sum - L.original) / L.original).toBeLessThan(1e-12);
    expect(L.mass.unresolved).toBe(0);
    // Fragment bodies of this building carry exactly the 'bodies' account.
    const S = c.getRuntime()!.structures!;
    const bodies = S.fragments.filter((f) => f.structural!.owner === apt.id).reduce((s, f) => s + f.mass, 0);
    expect(bodies).toBeCloseTo(L.mass.bodies, 3);
    // Rubble piles of this building = the model's piles (scene heaps carry the same mass).
    const heaps = S.rubble.heaps.filter((h) => h.owner === apt.id);
    expect(heaps.reduce((s, h) => s + h.mass, 0)).toBeCloseTo(m.piles.reduce((s, p) => s + p.mass, 0), 3);
    expect(heaps.some((h) => h.body !== null)).toBe(true);
    // Energy: released potential = collisions + absorption + ground (nothing left moving).
    const E = L.energy;
    expect(E.kinetic).toBeCloseTo(0, 6);
    if (E.released > 0) expect((E.collision + E.absorbed + E.ground) / E.released).toBeCloseTo(1, 6);
    // Timeline milestones of the destruction sequence.
    const kinds = new Set(c.getMilestones().map((x) => x.kind));
    for (const k of ['memberFailure', 'loadRedistribution', 'progressiveCollapse'] as const) expect(kinds.has(k)).toBe(true);
    // Attribution (calm air): no member damage, failure or record of this run is the wind's.
    for (const e of buildings(c)) {
      const mm = e.modular?.structure?.model;
      if (!mm) continue;
      for (let i = 0; i < mm.n; i++) expect(mm.hazardName(i)).not.toBe('wind');
      for (const r of mm.records) expect(r.hazard).toBe('earthquake');
    }
    expect(c.getDamageEvents().filter((x) => x.hazard === 'wind')).toEqual([]);
    c.unload();
  });

  it('fragments strike the cars and the neighbouring house: secondary damage keeps the primary hazard and the source', async () => {
    const c = await run(street(), [quake(1.1)], 24);
    const apt = buildings(c)[0];
    const sec = c.getDamageEvents().filter((e) => e.secondary && e.secondary.source === apt.id);
    expect(sec.length).toBeGreaterThan(0);
    for (const e of sec) {
      expect(e.hazard).toBe('earthquake');
      expect(e.cause === 'impact' || e.cause === 'burial').toBe(true);
    }
    expect(sec.some((e) => e.objectType === 'car')).toBe(true);
    // One record per strike episode: the same fragment never re-records the same target within an episode.
    const keys = sec.map((e) => `${e.secondary!.striker}|${e.objectId}|${Math.floor(e.time / 0.5)}`);
    expect(new Set(keys).size).toBe(keys.length);
    const kinds = new Set(c.getMilestones().map((x) => x.kind));
    expect(kinds.has('debrisImpact') && kinds.has('secondaryDamage')).toBe(true);
    c.unload();
  });

  it('fragments settle (fixed bodies, members SETTLED); over the active-body budget they are aggregated, never dropped', async () => {
    FRAGMENT_LIMITS.active = 4;
    const c = await run(street(), [quake(1.1)], 30);
    const S = c.getRuntime()!.structures!;
    expect(S.aggregated).toBeGreaterThan(0);
    expect(S.rubble.heaps.some((h) => h.pile < 0)).toBe(true);
    for (const f of S.fragments) expect(f.structural!.settled).toBe(true);
    for (const e of buildings(c)) {
      const m = e.modular?.structure?.model;
      if (!m) continue;
      expect(Math.abs(m.ledger.residual()) / m.ledger.original).toBeLessThan(1e-12);
      for (let i = 0; i < m.n; i++) if (m.external[i]) expect(m.state[i]).toBe(MS.SETTLED);
    }
    c.unload();
  });
});

describe('blast and ground integration', { timeout: 600_000 }, () => {
  it('air blast: exterior walls blown out leave with the momentum the wave gave them (no extra push)', async () => {
    const d = doc([B(design('house'), 10, 0), B(design('house'), 40, 0, 9)]);
    const c = await run(d, [{ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.2 } as EventSpec], 8);
    const near = buildings(c)[0];
    const m = model(near);
    // Structural failures (walls out of plane, or the story mechanism of the lumped model) — the blast's.
    expect(m.records.some((r) => r.cause !== 'facade' && r.hazard === 'blast')).toBe(true);
    expect(m.records.every((r) => r.hazard === 'blast')).toBe(true);
    // Parts blown off carry the momentum the wave gave them.
    expect(m.ledger.momentum.impulse).toBeGreaterThan(0);
    expect(c.getDamageEvents().some((e) => e.objectId === near.id && e.eventType === 'FAILED' && e.hazard === 'blast')).toBe(true);
    c.unload();
  });

  it('ground: support lost under part of a footprint fails the footings there (load path, not a rigid move)', async () => {
    const d = doc([B(design('industrial'))]);
    // The ground under one corner drops 8 cm (beyond the 5 cm contact gap) and loses 90 % of its
    // support; the distortion stays below Phase 21's destruction limit (1/50).
    const c = await run(d, [{ event: 'terrainDeformation', kind: 'subsidence', center: [-15, -10], radius: 4, amount: 0.08, supportLoss: 0.9, duration: 1, profile: 'smooth', falloff: 'steep' } as EventSpec], 5);
    const e = buildings(c)[0];
    const m = model(e);
    let reduced = 0;
    for (let i = 0; i < m.n; i++) if (m.g.ground[i] && m.s.groundFactor[i] < 0.05) reduced++;
    expect(reduced).toBeGreaterThan(0);
    expect(e.ground!.peakBeta).toBeLessThan(1 / 50);
    expect(e.flags.collapsed).toBeFalsy();
    expect(m.records.some((r) => (r.cause === 'bearing' || r.cause === 'foundation') && r.hazard === 'ground')).toBe(true);
    // Members far from the pit still stand.
    expect(m.standingMass()).toBeGreaterThan(0.5 * m.superMass);
    c.unload();
  });
});

describe('roads, restoration, determinism, save / load, shared designs, resources', { timeout: 600_000 }, () => {
  it('collapse rubble on a street blocks it (a separate state from sediment)', async () => {
    useWorldStore.getState().setLocked(false);
    useWorldStore.getState().replaceDocument(street());
    const net = drawRoad(useWorldStore.getState().doc.roads, [[-40, 9], [40, 9]], { curved: false, profile: defaultProfile() }).network;
    useWorldStore.getState().applyEdit({ roads: net });
    const d = structuredClone(useWorldStore.getState().doc);
    const c = await run(d, [quake(1.1)], 24);
    const seg = c.getRuntime()!.roads!.segments[0];
    expect(seg.rubble?.blocked).toBe(true);
    expect(seg.deform?.debris ?? 0).toBe(0);
    expect(c.getRuntime()!.roads!.summary().rubble).toBe(1);
    c.unload();
  });

  it('deterministic: the same run gives the same collapse sequence, rubble and fragments, bit for bit; reset reproduces it', async () => {
    const d = street();
    const a = await run(structuredClone(d), [quake(1.1)], 16);
    const h1 = sequenceHash(a);
    a.unload();
    const b = await run(structuredClone(d), [quake(1.1)], 16);
    expect(sequenceHash(b)).toBe(h1);
    await b.reset();
    b.advance(16);
    expect(sequenceHash(b)).toBe(h1);
    b.unload();
  });

  it('the original world is untouched; a saved and reloaded world collapses identically', async () => {
    const d = street();
    const before = worldFingerprint(d);
    const json = serializeDocument(d, false);
    const re = parseDocument(serializeDocument(d));
    expect(re.ok).toBe(true);
    const a = await run(d, [quake(1.1)], 14);
    const h1 = sequenceHash(a);
    a.unload();
    expect(worldFingerprint(d)).toBe(before);
    expect(serializeDocument(d, false)).toBe(json);
    if (!re.ok) return;
    const b = await run(re.doc, [quake(1.1)], 14);
    expect(sequenceHash(b)).toBe(h1);
    b.unload();
  });

  it('copies of one design are independent: the shared design and graph are never written', async () => {
    const shared = design('house');
    const frozen = JSON.stringify(shared);
    const d = doc([B(shared, 10, 0), B(shared, 120, 0, 9)]);
    const c = await run(d, [{ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.2 } as EventSpec], 6);
    const [near, far] = buildings(c);
    expect(near.modular!.design).toBe(far.modular!.design);
    expect(near.modular!.failedSet.size).toBeGreaterThan(far.modular!.failedSet.size);
    // Structural members failed only near the source; the far copy kept its structure.
    expect(model(near).records.some((r) => r.cause !== 'facade')).toBe(true);
    expect(model(near).records.every((r) => r.hazard === 'blast')).toBe(true);
    if (far.modular!.structure) {
      expect(model(far).g).toBe(model(near).g); // one graph per design …
      expect(model(far).s).not.toBe(model(near).s); // … separate runtime states
      const structural = (e: RuntimeEntity) => model(e).records.filter((r) => r.cause !== 'facade').length;
      expect(structural(near)).toBeGreaterThan(structural(far));
    }
    expect(JSON.stringify(shared)).toBe(frozen);
    c.unload();
  });

  it('physics resources are released: no Rapier world survives an unload after a collapse', async () => {
    const live = rapierWorlds.live;
    const c = await run(street(), [quake(1.1)], 10);
    expect(c.getRuntime()!.structures!.fragments.length).toBeGreaterThan(0);
    c.unload();
    expect(rapierWorlds.live).toBe(live);
  });
});

describe('flood, landslide, impact, residual strength', { timeout: 600_000 }, () => {

  it('landslide: the lateral sediment load damages the ground-story members (ground hazard, never wind)', async () => {
    const S = useWorldStore.getState();
    S.setLocked(false);
    S.newDocument();
    const t0 = useWorldStore.getState().doc.terrain;
    const heights = new Float32Array(t0.heights.length);
    const tb = Math.tan((32 * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
    useWorldStore.getState().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
    useWorldStore.getState().applyEdit({ add: [B(design('house'), 7, 0, 1)] });
    const c = await run(structuredClone(useWorldStore.getState().doc), [{ event: 'landslide', area: { kind: 'circle', center: [-14, 0], radius: 12 }, thickness: 2.5, saturation: 1, trigger: 'user', targetSaturation: 1, duration: 10 } as EventSpec], 40);
    const e = buildings(c)[0];
    const lateral = e.modular!.storyMembers[0];
    expect(Math.max(...lateral.map((i) => e.modular!.damage[i]))).toBeGreaterThan(0.3);
    expect(c.getDamageEvents().every((x) => x.hazard === 'ground')).toBe(true);
    c.unload();
  });

  it('impact: buildings near the crater collapse through the engine; every member record is the impact’s', async () => {
    const d = doc([B(design('house'), 30, 0, 1), B(design('apartment'), -40, 10, 2)]);
    const c = await run(d, [{ event: 'impact', target: [6, 6], material: 'stony', diameter: 2, speed: 15000, angle: 70, azimuth: 45, entry: 'direct' } as EventSpec], 25);
    const models = buildings(c).filter((e) => e.modular!.structure).map(model);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) for (const r of m.records) expect(r.hazard).toBe('impact');
    expect(c.getDamageEvents().filter((x) => x.objectType === 'building').every((x) => x.hazard === 'impact')).toBe(true);
    c.unload();
  });

  it('flood: houses that lose their ground story in deep water collapse into rubble — the flood’s, never the wind’s', async () => {
    const S = useWorldStore.getState();
    S.setLocked(false);
    S.newDocument();
    useWorldStore.getState().applyEdit({ add: [0, 1, 2, 3, 4, 5].map((k) => B(design(k % 2 ? 'apartment' : 'house'), -30 + k * 12, 0, k + 1)) });
    const d = structuredClone(useWorldStore.getState().doc);
    d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false };
    const c = new SimulationController({ headless: true });
    const f = new WaterField(samplerFor(d.terrain), d.settings.simulation.water);
    f.h.fill(2.5);
    c.setInitialWaterState(captureWaterState(f, 0));
    await c.load(d);
    c.addEvent({ event: 'risingWater', boundary: 'S', level: 3.5, riseRate: 0.5 } as EventSpec);
    c.advance(40);
    const collapsed = buildings(c).filter((e) => e.modular!.structure && model(e).piles.length > 0);
    expect(collapsed.length).toBeGreaterThan(0);
    for (const e of collapsed) {
      expect(model(e).records.filter((r) => r.cause !== 'facade').every((r) => r.hazard === 'flood')).toBe(true);
      expect(Math.abs(model(e).ledger.residual()) / model(e).ledger.original).toBeLessThan(1e-12);
    }
    expect(c.getDamageEvents().some((x) => x.hazard === 'wind')).toBe(false);
    // Water mass conservation is untouched by the structural engine.
    expect(relativeError(c.getEnvironment().flood.field!.budget)).toBeLessThan(1e-9);
    c.unload();
  });

  it('residual strength: members damaged by the earthquake keep F·(1 − 0.3·D) of their gravity capacity, once (envelope)', async () => {
    const c = await run(doc([B(design('apartment'))]), [quake(0.45)], 20);
    const e = buildings(c)[0];
    const mr = e.modular!;
    const damaged = mr.storyMembers.flat().filter((i) => mr.damage[i] > 0.05 && !mr.failed[i]);
    expect(damaged.length).toBeGreaterThan(0);
    if (mr.structure) {
      for (const i of damaged) {
        expect(model(e).s.capFactor[i]).toBeCloseTo(1 - 0.3 * Math.min(1, mr.damage[i]), 9);
        if (mr.damage[i] >= 0.3) expect(model(e).state[i] === MS.DAMAGED || model(e).state[i] === MS.SEVERE).toBe(true);
      }
    }
    c.unload();
  });
});
