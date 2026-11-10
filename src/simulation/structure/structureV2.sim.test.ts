/**
 * Phase 35.5 structure v2 in a running simulation: flood loads on the members facing the water (walls break in, the house
 * stands where the Phase 25 model collapsed it), torsion-amplified drift (perimeter / corner members first), the default
 * world (network roads from the cross-section presets, member-modelled buildings of five systems, v2 on), the setting
 * through save / load, v1 unchanged when absent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { defaultWaterSettings, type BoundarySide, type WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { SimulationController } from '@/simulation/SimulationController';
import { torsionFactors } from '@/simulation/buildings/structureV2';
import { useWorldStore } from '@/world/worldStore';
import { loadSampleTown } from '@/app/actions';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { crossSectionOf, presetOf } from '@/roads/crossSection';

const T = (x = 0, z = 0) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const B = (id: string, x = 0, z = 0): CreateObjectInput => ({ type: 'building', building: createDesign(presetSpec(id)!, id), seed: 7, transform: T(x, z) });

function doc(inputs: CreateObjectInput[], v2: boolean, water = 0): WorldDocument {
  const d = createEmptyDocument('v2');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  if (v2) d.settings.simulation.structure = { model: 'v2' };
  if (water) {
    const w = defaultWaterSettings();
    for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: 'closed' };
    w.infiltration = false;
    w.drainageCapacity = 0;
    w.initialFromReference = false;
    w.boundaries.W = { type: 'fixedLevel', level: water };
    w.boundaries.E = { type: 'open' };
    d.settings.simulation.water = w;
  }
  return d;
}

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}
const only = (c: SimulationController) => [...c.getRuntime()!.entities.values()][0];

beforeEach(() => {
  useWorldStore.getState().setLocked(false);
});

describe('flood on members (v2)', { timeout: 600_000 }, () => {
  it('1.6 m of water: Phase 25 collapses the timber house; v2 breaks the walls facing the water, lets it in, the house stands', async () => {
    const rain: EventSpec = { event: 'rain', intensity: 0.1, duration: 600 };
    const v1 = await run(doc([B('house', -60, -20)], false, 1.6), [rain], 240);
    const v2 = await run(doc([B('house', -60, -20)], true, 1.6), [rain], 240);
    const a = only(v1), b = only(v2);
    expect(a.flags.collapsed).toBe(true);
    expect(b.flags.collapsed).toBeFalsy();
    expect(b.modular!.v2Stage?.flood).toBe(1);
    // The failed members are on the upstream (west, −x) ground-floor face, and water got in (inside ≈ outside).
    const ms = b.modular!.design.members;
    // (Openings on every face also break under water — the Phase 14–17 opening model, in v1 too; the v2 face failure is the walls.)
    const failedWalls = ms.filter((m) => b.modular!.failedSet.has(m.id) && m.level === 0 && m.type === 'wall');
    expect(failedWalls.length).toBeGreaterThan(0);
    const minX = Math.min(...ms.filter((m) => m.level === 0).map((m) => m.position[0]));
    expect(failedWalls.every((m) => m.position[0] <= minX + 1.5)).toBe(true);
    expect(b.flood!.inside).toBeGreaterThan(0.8 * b.flood!.depth);
    expect(b.modular!.structure!.model.collapseLevel()).not.toBe('global');
    v1.unload();
    v2.unload();
  });
});

describe('torsion (v2)', { timeout: 600_000 }, () => {
  it('drift amplification δ = 1 + 0.6·d/L: ≈ 1.3 at the plan edge, 1 at the stiffness centre', () => {
    const d = doc([B('apartment')], true);
    const o = Object.values(d.objects)[0];
    const mr = { design: o.building!, floors: o.building!.spec.floors, storyMembers: [] as number[][] } as unknown as Parameters<typeof torsionFactors>[0];
    // Story members: the lateral members of each storey (columns / bearing walls) as the runtime lists them.
    const ms = o.building!.members;
    mr.storyMembers = Array.from({ length: mr.floors }, (_, s) => ms.map((m, i) => (m.level === s && (m.type === 'column' || (m.type === 'wall' && m.role === 'bearing')) ? i : -1)).filter((i) => i >= 0));
    const t = torsionFactors(mr);
    const ground = mr.storyMembers[0];
    const dz = ground.map((i) => t[2 * i]), dx = ground.map((i) => t[2 * i + 1]);
    expect(Math.max(...dz)).toBeGreaterThan(1.25);
    expect(Math.max(...dz)).toBeLessThanOrEqual(1.3 + 1e-6);
    expect(Math.min(...dz)).toBeLessThan(1.1);
    expect(Math.max(...dx)).toBeGreaterThan(1.25);
  });

  it('an earthquake: v2 fails more perimeter members among the first drift failures than v1 (capacity still decides first); deterministic', async () => {
    const q: EventSpec = { event: 'earthquake', magnitude: 7, pga: 0.5, duration: 20, seed: 3 };
    const first = async (v2: boolean) => {
      const c = await run(doc([B('apartment')], v2), [q], 30);
      const e = only(c);
      const t = torsionFactors(e.modular!);
      const recs = e.modular!.structure!.model.records.filter((r) => r.cause === 'drift').slice(0, 10).map((r) => Math.max(t[2 * r.i], t[2 * r.i + 1]));
      const dy = Array.from(e.modular!.structure!.model.dy);
      c.unload();
      return { recs, dy };
    };
    const v1 = await first(false), a = await first(true), b = await first(true);
    const perimeter = (r: number[]) => r.filter((f) => f >= 1.25).length;
    expect(perimeter(a.recs)).toBeGreaterThan(perimeter(v1.recs));
    expect(a.dy).toEqual(b.dy);
  });
});

describe('default world', () => {
  it('network roads from the cross-section presets (wide main street, normal side street, T junction), four structural systems + a light shed, v2 on', () => {
    loadSampleTown();
    const d = useWorldStore.getState().doc;
    expect(d.settings.simulation.structure).toEqual({ model: 'v2' });
    expect(Object.values(d.objects).some((o) => o.type === 'road')).toBe(false);
    const segs = Object.values(d.roads.segments);
    expect(new Set(segs.map((s) => presetOf(s.profile)))).toEqual(new Set(['wide2', 'normal2']));
    const wide = segs.find((s) => presetOf(s.profile) === 'wide2')!;
    expect(crossSectionOf(wide.profile)).toMatchObject({ laneCount: 2, laneWidth: 3.5, shoulderWidth: 1.5, carriageway: 10, totalWidth: 15 });
    const normal = segs.find((s) => presetOf(s.profile) === 'normal2')!;
    expect(crossSectionOf(normal.profile)).toMatchObject({ laneWidth: 3.5, shoulderWidth: 0, carriageway: 7, totalWidth: 11 });
    // A T junction: one node shared by three segments.
    const deg = new Map<string, number>();
    for (const s of segs) for (const n of [s.a, s.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    expect([...deg.values()].some((v) => v === 3)).toBe(true);
    const systems = new Set(Object.values(d.objects).filter((o) => o.type === 'building').map((o) => o.building?.spec.system));
    expect(systems).toEqual(new Set(['masonry', 'steelFrame', 'wood', 'rcFrame']));
    expect(Object.values(d.objects).filter((o) => o.type === 'building').every((o) => o.building)).toBe(true);
  });

  it('the structure setting survives save / load; absent stays absent', () => {
    const d = doc([B('house')], true);
    const back = parseDocument(serializeDocument(d));
    expect(back.ok && back.doc.settings.simulation.structure).toEqual({ model: 'v2' });
    const d1 = doc([B('house')], false);
    const back1 = parseDocument(serializeDocument(d1));
    expect(back1.ok && 'structure' in back1.doc.settings.simulation).toBe(false);
  });
});
