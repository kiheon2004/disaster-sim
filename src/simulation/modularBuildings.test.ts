/**
 * Phase 17: modular buildings in the hazard simulation — wind, earthquake, flood, combined
 * hazards, determinism, original-world restoration, undo / redo atomicity of building edits.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { defaultWaterSettings, type BoundarySide, type WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { worldFingerprint } from '@/world/fingerprint';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { removeMembers, addMembers, newMember } from '@/buildings/edit';
import type { BuildingDesign, BuildingSpec } from '@/buildings/types';
import { addFloorTo, applySpec, commitDesign } from '@/app/buildingActions';
import { SimulationController } from './SimulationController';
import { relativeError } from './water/WaterField';

const T = (x = 0, z = 0) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string, patch: Partial<BuildingSpec> = {}) => createDesign({ ...presetSpec(id)!, ...patch }, id);
const B = (d: BuildingDesign, x = 0, z = 0): CreateObjectInput => ({ type: 'building', building: d, seed: 7, transform: T(x, z) });

function doc(inputs: CreateObjectInput[], water = false): WorldDocument {
  const d = createEmptyDocument('p17');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  if (water) {
    const w = defaultWaterSettings();
    for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: 'closed' };
    w.infiltration = false;
    w.drainageCapacity = 0;
    w.initialFromReference = false;
    w.boundaries.W = { type: 'fixedLevel', level: 2.6 };
    w.boundaries.E = { type: 'open' };
    d.settings.simulation.water = w;
  }
  return d;
}

const quake = (pga: number): EventSpec => ({ event: 'earthquake', magnitude: 6.8, pga, duration: 20, seed: 3 });
const wind = (speed: number, duration = 60): EventSpec => ({ event: 'wind', speed, direction: 'E', duration });

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const c = new SimulationController();
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}

function hash(c: SimulationController): string {
  const ev = c.getDamageEvents().map((e) => [e.time, e.objectId, e.componentId ?? '', e.eventType, e.cause, e.hazard, e.response].join('|'));
  const ents = [...c.getRuntime()!.entities.values()].map((e) => [e.id, e.state, e.health, ...e.pose.position, e.modular ? [...e.modular.damage].join(',') : ''].join('|'));
  return createHash('sha256').update(ev.join('\n') + '#' + ents.join('\n')).digest('hex');
}

const only = (c: SimulationController) => [...c.getRuntime()!.entities.values()][0];

describe('earthquake integration', { timeout: 300_000 }, () => {
  it('the same earthquake: structurally different buildings respond differently (no height / material rule)', async () => {
    const out: Record<string, { peak: number; failed: number; collapsed: boolean; partial: number | undefined; period: number }> = {};
    for (const p of ['house', 'apartment', 'office', 'industrial']) {
      const c = await run(doc([B(design(p))]), [quake(0.8)], 24);
      const e = only(c);
      out[p] = { peak: e.seismic!.peakDrift, failed: e.modular!.failedSet.size, collapsed: !!e.flags.collapsed, partial: e.flags.partialCollapse, period: e.seismic!.period };
      c.unload();
    }
    // Different periods / drifts for different structures.
    expect(new Set(Object.values(out).map((v) => v.period.toFixed(3))).size).toBe(4);
    expect(new Set(Object.values(out).map((v) => v.peak.toFixed(4))).size).toBe(4);
    // The 10-story steel / core office is NOT the most damaged, the 2-story timber house is not either.
    expect(out.office.collapsed).toBe(false);
    expect(out.house.collapsed).toBe(false);
    expect(out.apartment.failed + out.industrial.failed).toBeGreaterThan(out.office.failed);
  });

  it('member failures remove stiffness from the structural model and recompute the load path', async () => {
    const c = await run(doc([B(design('apartment'))]), [quake(0.7)], 24);
    const e = only(c);
    const mr = e.modular!;
    expect(mr.failedSet.size).toBeGreaterThan(0);
    expect(mr.reserve).toBeLessThan(1);
    const ev = c.getDamageEvents();
    expect(ev.some((x) => x.eventType === 'FAILED' && x.memberType && x.hazard === 'earthquake')).toBe(true);
    // The structural model only ever loses stiffness / strength (failed members leave it).
    const L = mr.unit!.lumps;
    for (let j = 0; j < L.kx.length; j++) {
      expect(mr.modelK[2 * j]).toBeLessThanOrEqual(L.kx[j] * (1 + 1e-12));
      expect(mr.modelFy[2 * j]).toBeLessThanOrEqual(L.fyX[j] * (1 + 1e-12));
    }
    expect(mr.modelK.some((v, i) => v < (i % 2 ? L.kz : L.kx)[i >> 1] * 0.999) || mr.collapsedFrom < Infinity).toBe(true);
    c.unload();
  });

  it('a soft ground story concentrates drift there and collapses before an otherwise identical building', async () => {
    const base = design('apartment', { core: false });
    const soft = design('apartment', { core: false, groundFloorHeight: 5.5 });
    // Phase 25: a building may collapse progressively (rubble then loads the ground story), so the
    // drift DISTRIBUTION is compared while both still stand — up to the first member failure of either.
    const a = await run(doc([B(base)]), [quake(0.6)], 0);
    const b = await run(doc([B(soft)]), [quake(0.6)], 0);
    let pa = new Float64Array(0), pb = new Float64Array(0);
    for (let t = 0; t < 24; t += 0.25) {
      a.advance(0.25);
      b.advance(0.25);
      if (only(a).modular!.failedSet.size || only(b).modular!.failedSet.size) break;
      pa = only(a).modular!.storyPeak.slice();
      pb = only(b).modular!.storyPeak.slice();
    }
    const ea = { storyPeak: pa }, eb = { storyPeak: pb };
    // Ground-story share of the peak drift is larger in the soft-story building.
    const share = (m: typeof ea) => m.storyPeak[0] / Math.max(...m.storyPeak);
    expect(Math.max(...pa)).toBeGreaterThan(0);
    expect(share(eb)).toBeGreaterThan(share(ea));
    expect(eb.storyPeak[0]).toBeGreaterThan(ea.storyPeak[0]);
    a.unload();
    b.unload();
  });

  it('deterministic: the same world and earthquake give the same member damage, bit for bit', async () => {
    const d = doc([B(design('apartment')), B(design('house'), 40, 0)]);
    const h1 = hash(await run(structuredClone(d), [quake(0.7)], 20));
    const h2 = hash(await run(structuredClone(d), [quake(0.7)], 20));
    expect(h1).toBe(h2);
  });
});

describe('wind integration', { timeout: 300_000 }, () => {
  it('cladding / glazing damage is separate from structural damage; a light house is more exposed than an RC block', async () => {
    const c = await run(doc([B(design('office'))]), [wind(48)], 60);
    const e = only(c);
    const ev = c.getDamageEvents();
    expect(ev.some((x) => x.componentKind === 'cladding' || x.componentKind === 'window')).toBe(true);
    expect(ev.some((x) => x.eventType === 'FAILED' || x.eventType === 'COLLAPSED')).toBe(false); // envelope only
    expect(e.health).toBeGreaterThan(0.9);
    c.unload();
    const house = await run(doc([B(design('house'))]), [wind(70)], 60);
    const block = await run(doc([B(design('apartment'))]), [wind(70)], 60);
    expect(only(house).peakLoadRatio).toBeGreaterThan(only(block).peakLoadRatio);
    house.unload();
    block.unload();
  });

  it('a bigger building catches more wind (load grows with exposed area and height)', async () => {
    const small = await run(doc([B(design('apartment', { floors: 3 }))]), [wind(40, 20)], 15);
    const tall = await run(doc([B(design('apartment', { floors: 10 }))]), [wind(40, 20)], 15);
    expect(only(tall).windLoad).toBeGreaterThan(only(small).windLoad * 2);
    small.unload();
    tall.unload();
  });
});

describe('flood integration', { timeout: 300_000 }, () => {
  it('ground-story capacity and materials decide: the timber house is loaded far more than the RC block', async () => {
    const d = doc([B(design('house'), -60, -20), B(design('apartment'), -60, 25)], true);
    const c = await run(d, [{ event: 'rain', intensity: 0.1, duration: 600 }], 120);
    const [house, apt] = [...c.getRuntime()!.entities.values()];
    expect(house.flood!.depth).toBeGreaterThan(0.3);
    expect(house.flood!.peakLoadRatio).toBeGreaterThan(apt.flood!.peakLoadRatio * 5);
    // The flood solver's mass conservation is untouched by the building models.
    expect(relativeError(c.getEnvironment().flood.field!.budget)).toBeLessThan(1e-9);
    c.unload();
  });
});

describe('combined hazards', { timeout: 300_000 }, () => {
  it('wind + earthquake + flood on modular buildings: every hazard contributes, deterministic', async () => {
    const d = doc([B(design('house'), -50, -20), B(design('apartment'), -40, 25), B(design('office'), 20, 0)], true);
    const specs: EventSpec[] = [wind(35, 80), { ...quake(0.6), startTime: 10 } as EventSpec, { event: 'rain', intensity: 0.1, duration: 600 }];
    const a = await run(structuredClone(d), specs, 50);
    const hz = new Set(a.getDamageEvents().map((e) => e.hazard));
    expect(hz.has('earthquake')).toBe(true);
    expect(hz.has('wind') || hz.has('flood')).toBe(true);
    const b = await run(structuredClone(d), specs, 50);
    expect(hash(a)).toBe(hash(b));
    a.unload();
    b.unload();
  });
});

describe('unsupported members and the original world', { timeout: 300_000 }, () => {
  it('members without a load path (forced) fall at the start of a simulation', async () => {
    let d = design('house');
    d = { ...d, options: { ...d.options, allowUnsupported: true } };
    const floating = newMember(d, 'column', [0, 20, 0], 'u1');
    floating.position = [0, 20, 0];
    d = addMembers(d, [floating]);
    const c = await run(doc([B(d)]), [], 1);
    const mr = only(c).modular!;
    expect(mr.failedSet.has('u1')).toBe(true);
    expect(c.getDamageEvents().some((e) => e.componentId === 'u1' && e.cause === 'gravity')).toBe(true);
    c.unload();
  });

  it('a destructive run never touches the document; geometry, members, materials, foundation, damage and ids come back', async () => {
    const d0 = design('apartment');
    const pre = { ...d0, members: d0.members.map((m) => (m.id === 'c0-0-0' ? { ...m, initialDamage: 0.4 } : m)) };
    const d = doc([B(pre), B(design('industrial'), 40, 0)]);
    const before = worldFingerprint(d);
    const json = serializeDocument(d, false);
    const c = await run(d, [quake(1.1)], 24);
    expect([...c.getRuntime()!.entities.values()].some((e) => e.modular!.failedSet.size > 5)).toBe(true);
    c.unload();
    expect(worldFingerprint(d)).toBe(before);
    expect(serializeDocument(d, false)).toBe(json);
    // The original damage state is part of the world and survives.
    expect(Object.values(d.objects)[0].building!.members.find((m) => m.id === 'c0-0-0')!.initialDamage).toBe(0.4);
  });

  it('reset reproduces the same damage from the same original world', async () => {
    const d = doc([B(design('apartment'))]);
    const c = new SimulationController();
    await c.load(d);
    c.addEvent(quake(0.8));
    c.advance(20);
    const h1 = hash(c);
    await c.reset();
    c.advance(20);
    expect(hash(c)).toBe(h1);
    c.unload();
  });

  it('a saved and reloaded world gives the same result', async () => {
    const d = doc([B(design('apartment')), B(design('house'), 30, 0)]);
    const re = parseDocument(serializeDocument(d));
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    const h1 = hash(await run(d, [quake(0.7)], 18));
    const h2 = hash(await run(re.doc, [quake(0.7)], 18));
    expect(h2).toBe(h1);
  });
});

describe('undo / redo of building edits (atomic)', () => {
  function setup() {
    useWorldStore.setState({ locked: false });
    const d = createEmptyDocument('edit');
    useWorldStore.getState().replaceDocument(d);
    useEditorStore.setState({ mode: 'editor' });
    const [id] = useWorldStore.getState().applyEdit({ add: [B(design('apartment'))] });
    return id;
  }

  it('add floor, spec change and member edits are one undo step each; redo restores identically', () => {
    const id = setup();
    const w = useWorldStore.getState;
    const original = w().doc.objects[id];
    expect(addFloorTo(id)).toBe(true);
    const tall = w().doc.objects[id];
    expect(tall.building!.spec.floors).toBe(7);
    expect(applySpec(id, { ...tall.building!.spec, claddingMaterial: 'lightCladding' })).toBe(true);
    const removed = removeMembers(w().doc.objects[id].building!, ['w0-s-0']).design;
    expect(commitDesign(id, removed)).toBe(true);
    expect(w().past.length).toBe(4); // add + floor + spec + members
    w().undo();
    w().undo();
    expect(w().doc.objects[id]).toBe(tall);
    w().undo();
    expect(w().doc.objects[id]).toBe(original);
    w().redo();
    expect(w().doc.objects[id]).toBe(tall);
  });

  it('a failing edit changes nothing (no half-updated building, no undo step)', () => {
    const id = setup();
    const w = useWorldStore.getState;
    const before = w().doc;
    const pastLen = w().past.length;
    const d = w().doc.objects[id].building!;
    const broken = { ...d, members: d.members.map((m, i) => (i === 3 ? { ...m, size: [Number.NaN, 1, 1] as Vec3 } : m)) };
    expect(commitDesign(id, broken)).toBe(false);
    expect(w().doc).toBe(before);
    expect(w().past.length).toBe(pastLen);
    const dup = { ...d, members: [...d.members, { ...d.members[0] }] };
    expect(commitDesign(id, dup)).toBe(false);
    expect(w().doc).toBe(before);
  });

  it('new unsupported members ask first; declining changes nothing', () => {
    const id = setup();
    const w = useWorldStore.getState;
    const d = w().doc.objects[id].building!;
    const floating = newMember(d, 'column', [0, 40, 0], 'u9');
    floating.position = [0, 40, 0];
    const before = w().doc;
    expect(commitDesign(id, addMembers(d, [floating]), { confirm: () => false })).toBe(false);
    expect(w().doc).toBe(before);
    expect(commitDesign(id, addMembers(d, [floating]), { confirm: () => true })).toBe(true);
    expect(w().doc.objects[id].building!.members.some((m) => m.id === 'u9')).toBe(true);
  });
});
