/**
 * Phase 17: modular building model — generation, connections / load path, structural
 * parameters, materials, mass, foundation support, member editing (ids, hosts), blueprint
 * duplication, save / load, legacy conversion and spec validation. Pure (no simulation).
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument, WorldObject } from '@/core/model';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { createBlueprint, instantiateBlueprint, parseBlueprint, serializeBlueprint } from '@/editor/build/blueprint';
import { flatSampler, samplerFor } from '@/terrain/TerrainSampler';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { getDefinition } from '@/objects/registry';
import { STRUCTURAL_SYSTEMS } from '@/simulation/seismic/structuralProps';
import { analyzeBuilding, chainPeriod } from './analysis';
import { analysisOf, createDesign, designParams, designPhysics, deriveFields, regenerate, withDesign } from './design';
import { addFloor, addMembers, duplicateMembers, moveMembers, newMember, nextUserIds, removeFloor, removeMembers, rotateMembers, setMaterial, setRole } from './edit';
import { generateMembers, storyBase, totalHeight } from './generate';
import { MATERIALS, MATERIAL_IDS } from './materials';
import { BUILDING_PRESETS, defaultSpec, hasErrors, normalizeSpec, presetSpec, validateSpec } from './spec';
import { convertLegacy } from './convert';
import { foundationContact } from './foundation';
import { parseDesign } from './schema';
import { lumpStories, modularUnit, groupSizes } from './structuralAdapter';
import type { BuildingDesign, BuildingSpec } from './types';

const T = (x = 0, z = 0) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string, patch: Partial<BuildingSpec> = {}) => createDesign({ ...presetSpec(id)!, ...patch }, id);
const object = (d: BuildingDesign, x = 0, z = 0, seed = 11): WorldObject => createWorldObject({ type: 'building', building: d, seed, transform: T(x, z) }, 1);

describe('building generation (parametric)', () => {
  it('every preset is valid, fully supported, within capacity and deterministic', () => {
    for (const p of BUILDING_PRESETS) {
      expect(hasErrors(validateSpec(p.spec))).toBe(false);
      const a = generateMembers(p.spec);
      const b = generateMembers(p.spec);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const an = analyzeBuilding(createDesign(p.spec, p.id));
      expect(an.unsupported, p.id).toEqual([]);
      expect(Math.max(...an.members.map((m) => m.utilization)), p.id).toBeLessThan(1);
      const ids = new Set(a.members.map((m) => m.id));
      expect(ids.size).toBe(a.members.length); // unique member ids
      // Every opening is hosted by a wall of the same building.
      for (const m of a.members) if (m.host) expect(ids.has(m.host)).toBe(true);
    }
  });

  it('produces every component type with a structural role that matches it', () => {
    const d = design('office');
    const types = new Set(d.members.map((m) => m.type));
    for (const t of ['foundation', 'column', 'beam', 'slab', 'wall', 'window', 'door', 'roof'] as const) expect(types.has(t), t).toBe(true);
    // Windows never carry load; cladding walls are not bearing walls (not every wall is load-bearing).
    for (const m of d.members) {
      if (m.type === 'window' || m.type === 'door') expect(m.role).toBe('opening');
      if (m.type === 'column') expect(['primary', 'secondary']).toContain(m.role);
    }
    expect(d.members.some((m) => m.type === 'wall' && m.role === 'cladding')).toBe(true);
    expect(d.members.some((m) => m.type === 'wall' && m.role === 'bearing')).toBe(true); // core walls
  });

  it('stories stack at the declared heights; the ground story can be taller', () => {
    const spec = { ...defaultSpec(), floors: 3, floorHeight: 3, groundFloorHeight: 4.5 };
    expect(storyBase(spec, 1)).toBe(4.5);
    expect(totalHeight(spec)).toBeCloseTo(10.5);
    const d = createDesign(spec);
    const top = Math.max(...d.members.filter((m) => m.type === 'slab').map((m) => m.position[1] + m.size[1] / 2));
    expect(top).toBeCloseTo(10.5, 6);
    expect(designParams(d).floorHeight).toBeCloseTo(3.5, 3);
  });

  it('pitched roofs rise above the structure and enlarge the bounding box', () => {
    const flat = designParams(design('house', { roof: 'flat' }));
    const gable = designParams(design('house'));
    expect(Number(gable.roofHeight)).toBeGreaterThan(1.5);
    expect(getDefinition('building').getDimensions(gable)[1]).toBeGreaterThan(getDefinition('building').getDimensions(flat)[1]);
  });
});

describe('spec validation (no silent clamping)', () => {
  it('negative, absurd and non-structural inputs are errors; atypical ones warnings', () => {
    const v = (p: Partial<BuildingSpec>) => validateSpec({ ...defaultSpec(), ...p });
    expect(v({ width: -5 }).some((i) => i.field === 'width' && i.level === 'error')).toBe(true);
    expect(v({ floors: 2.5 }).some((i) => i.code === 'integer')).toBe(true);
    expect(v({ floors: 40, floorHeight: 6 }).some((i) => i.code === 'tooTall')).toBe(true);
    expect(v({ width: Number.NaN }).some((i) => i.code === 'notNumber')).toBe(true);
    expect(v({ structureMaterial: 'glass' }).some((i) => i.code === 'notStructural')).toBe(true);
    const masonry = v({ system: 'masonry', structureMaterial: 'masonry', floors: 8 });
    expect(masonry.some((i) => i.code === 'masonryTall' && i.level === 'warning')).toBe(true);
    expect(hasErrors(masonry)).toBe(false);
    expect(v({ groundFloorHeight: 6, floorHeight: 3 }).some((i) => i.code === 'softStory')).toBe(true);
  });

  it('stored specs are normalized (load path): bad fields fall back, numbers clamp', () => {
    const s = normalizeSpec({ width: 1000, floors: 'x' as unknown as number, roof: 'dome' as never, structureMaterial: 'unobtainium' as never });
    expect(s.width).toBe(60);
    expect(s.floors).toBe(defaultSpec().floors);
    expect(s.roof).toBe('flat');
    expect(s.structureMaterial).toBe('reinforcedConcrete');
  });
});

describe('connections and load path', () => {
  it('columns stand on the columns below, beams on columns, slabs on beams, openings on walls', () => {
    const d = design('apartment');
    const a = analyzeBuilding(d);
    const idx = (id: string) => a.byId.get(id)!;
    const sup = (id: string) => a.members[idx(id)].supports.map((j) => d.members[j].id);
    expect(sup('c1-0-0')).toContain('c0-0-0');
    expect(sup('bx0-0-0').filter((s) => s.startsWith('c0-'))).toHaveLength(2);
    expect(sup('sl0-0-0').some((s) => s.startsWith('bx0-') || s.startsWith('bz0-'))).toBe(true);
    const win = d.members.find((m) => m.type === 'window')!;
    expect(sup(win.id)).toEqual([win.host]);
    expect(a.connections).toBeGreaterThan(d.members.length);
  });

  it('removing one column: the stories above rest on its beams (transfer); removing all ground columns breaks the load path', () => {
    const d = design('apartment', { core: false });
    const one = removeMembers(d, ['c0-1-1']).design;
    const a1 = analyzeBuilding(one);
    expect(a1.unsupported).toEqual([]);
    // The column above now stands on the beams / slabs at its base instead of a column.
    expect(a1.members[a1.byId.get('c1-1-1')!].supports.every((j) => one.members[j].type !== 'column')).toBe(true)
    // Every ground-story column gone: nothing above has a path to the ground any more.
    const all = removeMembers(d, d.members.filter((m) => m.type === 'column' && m.level === 0).map((m) => m.id)).design;
    const a = analyzeBuilding(all);
    expect(a.unsupported.length).toBeGreaterThan(100);
    expect(a.warnings.some((w) => w.code === 'unsupported' && w.level === 'error')).toBe(true);
  });

  it('a floating member is unsupported (not a normal structure); a glass column carries nothing', () => {
    const d = design('house');
    // A column on the bare ground beside the house stands on the soil (reported, not an error).
    const onGround = newMember(d, 'column', [8, 0, 8], 'u2');
    const g = analyzeBuilding(addMembers(d, [onGround]));
    expect(g.unsupported).not.toContain('u2');
    expect(g.warnings.some((w) => w.code === 'onSoil' && w.members!.includes('u2'))).toBe(true);
    const floating = { ...newMember(d, 'column', [0, 30, 0], 'u1'), position: [0, 30, 0] as Vec3 };
    expect(analyzeBuilding(addMembers(d, [floating])).unsupported).toContain('u1');
    const office = design('office');
    const glass = setMaterial(office, office.members.filter((m) => m.type === 'column' && m.level === 0).map((m) => m.id), 'glass');
    const a = analyzeBuilding(glass);
    expect(a.warnings.some((w) => w.code === 'nonStructuralMaterial')).toBe(true);
    // The ground-story frame lost every column: only the core walls resist.
    expect(a.stories[0].kx).toBeLessThan(analyzeBuilding(office).stories[0].kx);
  });

  it('gravity loads accumulate downwards and the foundation carries the whole building', () => {
    const d = design('apartment');
    const a = analyzeBuilding(d);
    const col = (s: number) => a.members[a.byId.get(`c${s}-1-1`)!].load;
    for (let s = 0; s < 5; s++) expect(col(s)).toBeGreaterThan(col(s + 1));
    const foundation = a.members[a.byId.get('fd-mat')!].load;
    const total = (a.totalMass + a.foundationMass) * 9.81;
    expect(foundation / total).toBeGreaterThan(0.95);
    expect(foundation / total).toBeLessThan(1.05);
  });
});

describe('structural parameters', () => {
  it('mass, center of mass, floor masses and stiffness are physical and consistent', () => {
    const a = analyzeBuilding(design('apartment'));
    expect(a.totalMass).toBeGreaterThan(1e6);
    expect(Math.abs(a.centerOfMass[0])).toBeLessThan(0.5); // symmetric plan
    expect(a.centerOfMass[1]).toBeGreaterThan(5);
    // Lumped floor masses: the lower half of the ground-story columns / walls goes to the base.
    const floorSum = a.stories.reduce((t, s) => t + s.mass, 0);
    expect(floorSum).toBeLessThan(a.totalMass);
    expect(floorSum / a.totalMass).toBeGreaterThan(0.95);
    for (const s of a.stories) {
      expect(s.kx).toBeGreaterThan(0);
      expect(s.vx).toBeGreaterThan(0);
    }
  });

  it('periods stay in the code-formula band and follow height', () => {
    for (const p of BUILDING_PRESETS) {
      const a = analyzeBuilding(createDesign(p.spec));
      expect(a.periodX).toBeGreaterThanOrEqual(a.periodBand[0] - 1e-9);
      expect(a.periodX).toBeLessThanOrEqual(a.periodBand[1] + 1e-9);
    }
    const low = analyzeBuilding(design('apartment', { floors: 3 }));
    const high = analyzeBuilding(design('apartment', { floors: 12 }));
    expect(high.periodX).toBeGreaterThan(low.periodX);
  });

  it('shear-chain period: a uniform chain matches the closed form', () => {
    const n = 5, m = 1e5, k = 2e8;
    const exact = (2 * Math.PI) / (2 * Math.sqrt(k / m) * Math.sin(Math.PI / (2 * (2 * n + 1))));
    expect(chainPeriod(Array(n).fill(m), Array(n).fill(k))).toBeCloseTo(exact, 6);
  });

  it('a taller ground story is a soft story: lower stiffness than the story above, flagged', () => {
    const base = analyzeBuilding(design('apartment', { core: false }));
    const soft = analyzeBuilding(design('apartment', { core: false, groundFloorHeight: 5.5 }));
    expect(soft.stories[0].kx).toBeLessThan(base.stories[0].kx * 0.5);
    expect(soft.stories[0].kx).toBeLessThan(soft.stories[1].kx * 0.7);
    expect(soft.warnings.some((w) => w.code === 'softStory' && w.story === 0)).toBe(true);
    expect(base.warnings.some((w) => w.code === 'softStory' && w.story === 0)).toBe(false);
  });

  it('openings weaken bearing walls; wall direction decides which axis they stiffen', () => {
    const few = analyzeBuilding(design('house', { windowDensity: 0.1 }));
    const many = analyzeBuilding(design('house', { windowDensity: 0.5 }));
    expect(many.stories[0].kx).toBeLessThan(few.stories[0].kx);
    expect(many.stories[0].vx).toBeLessThan(few.stories[0].vx);
    const d = design('house');
    const a = analyzeBuilding(d);
    const wallX = a.members[a.byId.get('w0-s-0')!];
    expect(wallX.kx).toBeGreaterThan(0);
    expect(wallX.kz).toBeCloseTo(0, 6);
  });

  it('the structural adapter lumps stories into ≤ 5 dofs, ground story separate', () => {
    expect(groupSizes(3)).toEqual([1, 1, 1]);
    expect(groupSizes(30)).toEqual([1, 8, 7, 7, 7]);
    const l = lumpStories([1, 1, 1, 1, 1, 1], [3, 3, 3, 3, 3, 3], [2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [5, 4, 3, 2, 1, 1], [5, 4, 3, 2, 1, 1]);
    expect(l.mass).toEqual([1, 2, 1, 1, 1]);
    expect(l.kx[1]).toBeCloseTo(1, 9); // two stories of 2 in series
    expect(l.fyX[1]).toBe(3); // weakest of the group
    expect(l.share[2] + l.share[4]).toBeCloseTo(1, 12);
    const u = modularUnit(analyzeBuilding(design('tower')), undefined);
    expect(u.lumps.mass).toHaveLength(5);
    expect(u.period[0]).toBeGreaterThan(1);
  });
});

describe('materials', () => {
  it('every material documents density, stiffness, strength, ductility and failure', () => {
    for (const id of MATERIAL_IDS) {
      const m = MATERIALS[id];
      expect(m.density).toBeGreaterThan(0);
      expect(m.E).toBeGreaterThan(0);
      expect(['ductile', 'semiDuctile', 'brittle']).toContain(m.failure);
      if (m.structural) {
        expect(m.compressive).toBeGreaterThan(0);
        expect(m.driftCapacity.column).toBeGreaterThan(0);
      } else expect(m.compressive).toBe(0);
    }
    expect(MATERIALS.glass.structural).toBe(false);
    expect(MATERIALS.lightCladding.structural).toBe(false);
  });

  it('changing materials changes mass and structural response sensibly', () => {
    const rc = design('apartment', { core: false });
    const steel = regenerate(rc, { ...rc.spec, system: 'steelFrame', structureMaterial: 'structuralSteel' });
    const ar = analyzeBuilding(rc), as = analyzeBuilding(steel);
    expect(as.structuralMass).toBeLessThan(ar.structuralMass);
    expect(as.system).toBe('steelFrame');
    expect(as.damping).toBeLessThan(ar.damping); // steel frames damp less
    // Heavy masonry infill vs light cladding: same structure, different mass and wind speed.
    const light = regenerate(rc, { ...rc.spec, claddingMaterial: 'lightCladding' });
    expect(analyzeBuilding(light).totalMass).toBeLessThan(ar.totalMass);
    // Swapping one member's material on an edited design keeps its other edits.
    const edited = setRole(rc, ['c0-0-0'], 'secondary');
    const swapped = setMaterial(edited, ['c0-1-1'], 'structuralSteel');
    expect(swapped.members.find((m) => m.id === 'c0-0-0')!.role).toBe('secondary');
    expect(swapped.edits).toBe(2);
  });

  it('wind design speed follows the lateral capacity and the exposed face', () => {
    const house = designPhysics(design('house'));
    const tower = designPhysics(design('tower'));
    const apartment = designPhysics(design('apartment'));
    expect(house.windResistance).toBeLessThan(apartment.windResistance);
    expect(tower.windResistance).toBeGreaterThan(20);
    // Fewer walls → lower capacity → lower design wind.
    const weak = designPhysics(design('house', { windowDensity: 0.6 }));
    expect(weak.windResistance).toBeLessThan(house.windResistance);
  });
});

describe('member editing', () => {
  it('add / remove floor keeps manual edits and the roof on top', () => {
    const d = setRole(design('apartment'), ['c0-0-0'], 'secondary'); // a manual edit
    const up = addFloor(d);
    expect(up.spec.floors).toBe(7);
    expect(up.members.find((m) => m.id === 'c0-0-0')!.role).toBe('secondary');
    expect(up.members.some((m) => m.id === 'c6-1-1')).toBe(true);
    const roofY = (x: BuildingDesign) => Math.min(...x.members.filter((m) => m.type === 'roof').map((m) => m.position[1]));
    expect(roofY(up)).toBeCloseTo(roofY(d) + d.spec.floorHeight, 6);
    expect(analyzeBuilding(up).unsupported).toEqual([]);
    const down = removeFloor(up);
    expect(down.spec.floors).toBe(6);
    expect(roofY(down)).toBeCloseTo(roofY(d), 6);
    expect(analyzeBuilding(down).unsupported).toEqual([]);
    // Unedited designs regenerate exactly.
    expect(JSON.stringify(addFloor(design('apartment')).members)).toBe(JSON.stringify(design('apartment', { floors: 7 }).members));
  });

  it('move / rotate keep hosted openings with their wall; levels follow the new height', () => {
    const d = design('house');
    const wall = d.members.find((m) => m.type === 'wall' && d.members.some((w) => w.host === m.id))!;
    const hosted = d.members.filter((m) => m.host === wall.id);
    const moved = moveMembers(d, [wall.id], [0.5, 0, 0]);
    for (const h of hosted) expect(moved.members.find((m) => m.id === h.id)!.position[0]).toBeCloseTo(h.position[0] + 0.5, 9);
    const up = moveMembers(d, ['w0-s-0'], [0, d.spec.groundFloorHeight, 0]);
    expect(up.members.find((m) => m.id === 'w0-s-0')!.level).toBe(1);
    const turned = rotateMembers(d, [wall.id], Math.PI / 2, [0, 0]);
    const yaw = turned.members.find((m) => m.id === wall.id)!.rotation[1];
    expect(Math.cos(yaw)).toBeCloseTo(Math.cos(wall.rotation[1] + Math.PI / 2), 9);
    expect(Math.sin(yaw)).toBeCloseTo(Math.sin(wall.rotation[1] + Math.PI / 2), 9);
  });

  it('duplicate: fresh ids, host references remapped to the copies, originals untouched', () => {
    const d = design('house');
    const wall = d.members.find((m) => d.members.some((w) => w.host === m.id))!;
    const { design: out, map } = duplicateMembers(d, [wall.id], [0, 0, 3]);
    const copyWall = map.get(wall.id)!;
    expect(copyWall).toMatch(/^u\d+$/);
    const hosted = d.members.filter((m) => m.host === wall.id);
    for (const h of hosted) {
      const c = out.members.find((m) => m.id === map.get(h.id))!;
      expect(c.host).toBe(copyWall);
    }
    expect(out.members.filter((m) => m.host === wall.id)).toHaveLength(hosted.length);
    expect(new Set(out.members.map((m) => m.id)).size).toBe(out.members.length);
    expect(nextUserIds(out, 1)[0]).not.toBe(copyWall);
  });

  it('delete removes the hosted openings too; adding a duplicate id is refused', () => {
    const d = design('house');
    const wall = d.members.find((m) => d.members.some((w) => w.host === m.id))!;
    const r = removeMembers(d, [wall.id]);
    expect(r.removed.length).toBe(1 + d.members.filter((m) => m.host === wall.id).length);
    expect(() => addMembers(d, [{ ...d.members[0] }])).toThrow();
  });
});

describe('designs are immutable values (shared between copies, the simulation snapshot)', () => {
  const freeze = <T>(o: T): T => {
    if (o && typeof o === 'object') {
      Object.freeze(o);
      for (const v of Object.values(o as object)) freeze(v);
    }
    return o;
  };
  it('no edit operation mutates its input design', () => {
    const d = freeze(createDesign(presetSpec('apartment')!, 'apartment'));
    const edited = freeze(setRole(d, ['c0-0-0'], 'secondary')); // edits > 0 → copy paths
    for (const x of [d, edited]) {
      expect(() => {
        addFloor(x); removeFloor(x);
        moveMembers(x, ['w0-s-0', 'c1-1-1'], [0.5, 0, 0]);
        rotateMembers(x, ['w0-s-0'], Math.PI / 2, [0, 0]);
        duplicateMembers(x, ['w0-s-0'], [0, 0, 2]);
        removeMembers(x, ['w0-s-0']);
        setMaterial(x, ['c0-0-0'], 'structuralSteel');
        setRole(x, ['bx0-0-0'], 'secondary');
        addMembers(x, [newMember(x, 'column', [1, 0, 1], 'u77')]);
        regenerate(x, { ...x.spec, floors: 3 });
        withDesign(object(x), x);
        analyzeBuilding(x, { failed: new Set(['c0-0-0']) });
      }).not.toThrow();
    }
  });

  it('copies placed from one preset share the design object; the simulation snapshot references it', async () => {
    const d = createDesign(presetSpec('house')!, 'house');
    const a = object(d, 0, 0, 1), b = object(d, 20, 0, 2);
    expect(a.building).toBe(b.building);
    const { snapshotDocument } = await import('@/simulation/SimulationController');
    const doc = createEmptyDocument('s');
    doc.objects[a.id] = a;
    const snap = snapshotDocument(doc);
    expect(snap.objects[a.id].building).toBe(a.building);
    expect(snap.objects[a.id]).not.toBe(a);
    expect(snap.objects[a.id].components).not.toBe(a.components);
    // A file with many copies of one design loads them as one shared object.
    const file = createEmptyDocument('f');
    file.objects[a.id] = a;
    file.objects[b.id] = { ...b, serial: 2 };
    const res = parseDocument(serializeDocument(file));
    expect(res.ok && res.doc.objects[a.id].building).toBe(res.ok && res.doc.objects[b.id].building);
  });
});

describe('derived fields, save / load and blueprints', () => {
  const docWith = (objs: WorldObject[]): WorldDocument => {
    const doc = createEmptyDocument('p17');
    for (const o of objs) doc.objects[o.id] = { ...o, serial: nextSerial(doc.objects, o.type) };
    return doc;
  };

  it('a modular building round-trips exactly through save / load (schema v6)', () => {
    const o = withDesign(object(design('office')), setRole(design('office'), ['c0-0-0'], 'secondary'));
    const doc = docWith([o, object(design('house'), 30, 0)]);
    const json = serializeDocument(doc, false);
    const res = parseDocument(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(6);
    expect(res.designs).toEqual({ invalidDesigns: 0, droppedMembers: 0, repairedMembers: 0 });
    for (const id of Object.keys(doc.objects)) {
      const a = doc.objects[id], b = res.doc.objects[id];
      expect(b.building).toEqual(a.building);
      expect(b.params).toEqual(a.params);
      expect(b.physics).toEqual(a.physics);
      expect(b.components).toEqual(a.components);
      expect(b.seismic).toEqual(a.seismic);
    }
    expect(JSON.parse(serializeDocument(res.doc, false))).toEqual(JSON.parse(json));
  });

  it('invalid members are dropped and counted; an unusable design leaves a legacy building', () => {
    const o = object(design('house'));
    const raw = JSON.parse(serializeDocument(docWith([o]), false));
    const stored = raw.objects[o.id];
    stored.building.members[0].size = [-1, 2, 3];
    stored.building.members[1].material = 'cheese';
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok && res.designs.droppedMembers).toBe(1);
    expect(res.ok && res.designs.repairedMembers).toBe(1);
    stored.building = { version: 1, members: 'nope' };
    const bad = parseDocument(JSON.stringify(raw));
    expect(bad.ok && bad.designs.invalidDesigns).toBe(1);
    expect(bad.ok && bad.doc.objects[o.id].building).toBeUndefined();
    expect(bad.ok && bad.doc.objects[o.id].type).toBe('building'); // still a (legacy) building
  });

  it('older readers keep a sensible building: params are the design bounding box', () => {
    const o = object(design('apartment'));
    const p = designParams(o.building!);
    expect(o.params).toEqual(p);
    expect(Number(p.floors) * Number(p.floorHeight)).toBeCloseTo(17.5, 2);
  });

  it('blueprints keep components, materials, foundation, options; every paste gets new ids', () => {
    const d = { ...setMaterial(design('house'), ['w0-s-0'], 'masonry'), options: { foundationPolicy: 'preserve' as const, allowUnsupported: true, plinthDepth: 1.2 } };
    const o = object(d, 5, 5);
    const bp = parseBlueprint(serializeBlueprint(createBlueprint([o], flatSampler())))!;
    expect(bp.objects[0].building).toEqual(o.building);
    const a = instantiateBlueprint(bp, 40, 0, 0, flatSampler());
    const b = instantiateBlueprint(bp, 60, 0, 0, flatSampler());
    const oa = createWorldObject(a[0], 2), ob = createWorldObject(b[0], 3);
    expect(oa.id).not.toBe(ob.id);
    expect(oa.id).not.toBe(o.id);
    expect(oa.building).toEqual(o.building);
    expect(oa.components).toEqual(o.components);
    // Member ids are local; the global ids differ per copy.
    expect(`${oa.id}/w0-s-0`).not.toBe(`${o.id}/w0-s-0`);
  });

  it('derived physics follow the design unless the user overrode them', () => {
    const o = object(design('apartment'));
    const custom = { ...o, physics: { ...o.physics, durability: 42 } };
    const bigger = withDesign(custom, addFloor(o.building!));
    expect(bigger.physics.durability).toBe(42);
    expect(bigger.physics.mass).toBeGreaterThan(o.physics.mass);
    const f = deriveFields(o.building!, o.seed);
    expect(f.physics.mass).toBe(o.physics.mass);
  });
});

describe('legacy migration', () => {
  it('loading never converts; explicit conversion reports every field and keeps overrides', () => {
    const legacy = createWorldObject({ type: 'building', params: { floors: 5, width: 12, depth: 10 }, transform: T(), seed: 3 }, 1);
    legacy.physics.windResistance = 95; // a manual value
    legacy.seismic!.structure.strengthFactor = 1.4;
    const doc = createEmptyDocument('legacy');
    doc.objects[legacy.id] = legacy;
    const res = parseDocument(serializeDocument(doc));
    expect(res.ok && res.doc.objects[legacy.id].building).toBeUndefined();
    const r = convertLegacy(legacy);
    expect(r.object.building!.spec.floors).toBe(5);
    expect(r.object.building!.spec.width).toBe(12);
    expect(r.object.physics.windResistance).toBe(95);
    expect(r.object.seismic!.structure.strengthFactor).toBe(1.4);
    const fields = r.notes.map((n) => n.field);
    for (const f of ['dimensions', 'floors', 'system', 'mass', 'windResistance', 'seismicFactors', 'windows']) expect(fields).toContain(f);
    expect(r.notes.find((n) => n.field === 'windResistance')!.level).toBe('kept');
    expect(r.notes.find((n) => n.field === 'mass')!.level).toBe('changed');
  });

  it('parseDesign repairs duplicate ids and unknown roles', () => {
    const d = design('house');
    const raw = JSON.parse(JSON.stringify(d));
    raw.members[1].id = raw.members[0].id;
    raw.members[2].role = 'decorative';
    const r = parseDesign(raw);
    expect(r.repaired).toBe(2);
    expect(new Set(r.design!.members.map((m) => m.id)).size).toBe(d.members.length);
  });
});

describe('foundation support and terrain', () => {
  it('flat ground: full contact, embedded foundation, no gaps', () => {
    const fc = foundationContact(object(design('apartment')), flatSampler());
    expect(fc.contact).toBe(1);
    expect(fc.unsupportedArea).toBe(0);
    expect(fc.embedMin).toBeGreaterThan(0);
  });

  it('slope + refit: the plinth reaches the ground everywhere; preserve + lowered ground: gaps', () => {
    const terrain = generateTerrain('gentleHills', 5);
    const s = samplerFor(terrain);
    // Find a sloped spot.
    let x = 0, z = 0, best = 0;
    for (let i = -60; i <= 60; i += 10) for (let j = -60; j <= 60; j += 10) {
      const g = Math.abs(s.sampleHeight(i + 5, j) - s.sampleHeight(i - 5, j));
      if (g > best) { best = g; x = i; z = j; }
    }
    const def = getDefinition('building');
    void def;
    const o = object(design('house'), x, z);
    const seated = { ...o, transform: { ...o.transform, position: [x, Math.max(...[-4, 0, 4].flatMap((dx) => [-4, 0, 4].map((dz) => s.sampleHeight(x + dx, z + dz)))), z] as Vec3 } };
    const refit = foundationContact(seated, s);
    expect(refit.plinth).toBeGreaterThan(0);
    expect(refit.contact).toBe(1);
    const frozen = { ...seated, building: { ...seated.building!, options: { ...seated.building!.options, foundationPolicy: 'preserve' as const, plinthDepth: 0.05 } } };
    const gap = foundationContact(frozen, s);
    expect(gap.contact).toBeLessThan(1);
    expect(gap.unsupportedArea).toBeGreaterThan(0);
  });
});

describe('physics consistency of the presets (relative behavior, not ratings)', () => {
  it('no preset carries a rating; behavior comes from members: masonry houses are stiffer but brittle', () => {
    const timber = analyzeBuilding(design('house'));
    const masonry = analyzeBuilding(createDesign({ ...presetSpec('house')!, system: 'masonry', structureMaterial: 'masonry', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'masonry' }));
    expect(masonry.totalMass).toBeGreaterThan(timber.totalMass * 2);
    expect(masonry.driftU).toBeLessThan(timber.driftU);
    expect(STRUCTURAL_SYSTEMS[masonry.system].drift.complete).toBeLessThan(STRUCTURAL_SYSTEMS[timber.system].drift.complete);
  });

  it('the analysis of a design is cached per design object (immutable values)', () => {
    const d = design('office');
    expect(analysisOf(d)).toBe(analysisOf(d));
    expect(analysisOf(addFloor(d))).not.toBe(analysisOf(d));
  });
});
