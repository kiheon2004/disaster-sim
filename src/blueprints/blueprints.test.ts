/**
 * Phase 20: Unified Blueprints — capture, local frame, rotation, ids, references, roads,
 * modular buildings, terrain layers, water, dependencies, merge policies, atomic placement,
 * undo / redo, file format.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { useWorldStore } from '@/world/worldStore';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { samplerFor } from '@/terrain/TerrainSampler';
import { createDesign, designParams } from '@/buildings/design';
import { groundPose } from '@/terrain/groundPlacement';
import { getDefinition } from '@/objects/registry';
import { presetSpec } from '@/buildings/spec';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { measureLink } from '@/roads/links';
import { composeAll, landformSampler } from '@/landscape/compose';
import type { LakeFeature, PeakFeature, RiverFeature } from '@/landscape/types';
import { captureBlueprint, type CaptureSelection } from './capture';
import { defaultPlacement, planPlacement, preFeatureAt, type PlacementOptions } from './place';
import { blueprintHash, parseBlueprintText, parseBlueprintValue, serializeBlueprint, exportValue } from './schema';
import { rotate } from './frame';
import type { UnifiedBlueprint } from './types';

const S = () => useWorldStore.getState();
const NOW = '2026-10-11T00:00:00.000Z';
const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
const house = createDesign(presetSpec('house')!, 'house');

const mountain = (id: string, x: number, z: number, roughness = 0.6): PeakFeature => ({ id, kind: 'mountain', x, z, radius: 22, height: 12, roughness, seed: 7 });
const river = (id: string, points: [number, number][], extra: Partial<RiverFeature> = {}): RiverFeature => ({
  id, kind: 'river', points, width: 5, depth: 1.5, bankSlope: 2, material: 8,
  meander: { amplitude: 3, wavelength: 40, seed: 2 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0.5, inflow: 2, downstream: 'open' }, ...extra,
});
const lake = (id: string, cx: number, cz: number): LakeFeature => ({ id, kind: 'lake', points: [[cx - 10, cz - 8], [cx + 10, cz - 8], [cx + 12, cz + 8], [cx - 10, cz + 9]], surface: -0.5, depth: 2, shoreWidth: 4, material: 7, filled: true });

/** A district in the north-west quadrant: crossing roads, linked houses, trees, a lake, a mountain, a river, sculpt and paint. */
function district() {
  S().setLocked(false);
  S().newDocument();
  let net = drawRoad(S().doc.roads, [[-90, -50], [-10, -50]], { curved: false, profile: defaultProfile() }).network;
  net = drawRoad(net, [[-50, -90], [-50, -10]], { curved: false, profile: { ...defaultProfile(), width: 6 } }).network;
  S().applyEdit({ roads: net });
  S().setFeatures([mountain('f1', -75, -78), river('f2', [[-99, -30], [-60, -25], [-10, -32]]), lake('f3', -25, -75)], 4);
  // Sculpt + paint near (-70, -65).
  S().beginTerrainStroke();
  for (let k = 0; k < 8; k++) S().terrainDab({ op: 'raise', x: -70, z: -65, brush: { radius: 5, strength: 1 }, dt: 0.05 });
  for (let k = 0; k < 4; k++) S().terrainDab({ op: 'paint', x: -35, z: -60, brush: { radius: 3, strength: 1 }, dt: 0.05, groundType: 2 });
  S().endTerrainStroke();
  const roads = S().doc.roads;
  const houses = [[-40, -60], [-60, -60], [-40, -40], [-30, -60]].map(([x, z]) => {
    const yaw = 0;
    const link = measureLink(roads, x, z, yaw, 'follow');
    return { type: 'building' as const, building: house, transform: { position: v3(x, 0, z), rotation: v3(0, yaw, 0), scale: v3(1, 1, 1) }, roadLink: link ?? undefined };
  });
  const trees = Array.from({ length: 12 }, (_, i) => ({ type: 'tree' as const, seed: 100 + i, transform: { position: v3(-85 + (i % 4) * 5, 0, -70 + Math.floor(i / 4) * 5), rotation: v3(0, i * 0.3, 0), scale: v3(1, 1, 1) } }));
  const lamp = { type: 'streetLight' as const, seed: 9, transform: { position: v3(-20, 0, -45), rotation: v3(0, 0, 0), scale: v3(1, 1, 1) } };
  // Seated on the ground like the placement tools do.
  const sampler = samplerFor(S().doc.terrain);
  const inputs = [...houses, ...trees, lamp].map((inp) => {
    const pose = groundPose({ type: inp.type, params: inp.type === 'building' ? designParams(house) : getDefinition(inp.type).defaultParams, transform: inp.transform }, inp.transform.position[0], inp.transform.position[2], inp.transform.rotation[1], sampler);
    return { ...inp, transform: { ...inp.transform, position: pose.position, rotation: pose.rotation } };
  });
  const ids = S().applyEdit({ add: inputs });
  // Group two trees.
  const objs = S().doc.objects;
  const grp = 'grp_test';
  S().applyEdit({ update: [objs[ids[4]], objs[ids[5]]].map((o) => ({ ...o, group: grp })) });
  return ids;
}

const rectSel = (x0: number, z0: number, x1: number, z1: number): CaptureSelection => ({ shape: { kind: 'rect', x0, z0, x1, z1 } });
const capture = (sel: CaptureSelection, opts = {}) => captureBlueprint(S().doc, sel, { now: NOW, id: 'bp_test', ...opts });
const place = (bp: UnifiedBlueprint, o: Partial<PlacementOptions>) => planPlacement(S().doc, bp, { ...defaultPlacement(), ...o });
const commit = (bp: UnifiedBlueprint, o: Partial<PlacementOptions>) => {
  const plan = place(bp, o);
  expect(plan.report.errors).toEqual([]);
  return { plan, ids: S().applyEdit(plan.edit) };
};
const H = (x: number, z: number) => samplerFor(S().doc.terrain).sampleHeight(x, z);

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('unified blueprint: capture and serialization', () => {
  it('captures every element of a mixed district with local ids, local coordinates and a datum', () => {
    district();
    const { blueprint: bp, report } = capture(rectSel(-100, -100, 0, 0));
    expect(report.empty).toBe(false);
    expect(report.anchor).toEqual([-50, -50]);
    expect(bp.objects.map((o) => o.id)).toEqual(bp.objects.map((_, i) => `o${i + 1}`));
    expect(bp.vegetation).toHaveLength(12);
    expect(bp.objects.filter((o) => o.type === 'building')).toHaveLength(4);
    // One shared design table entry for four copies of one design.
    expect(Object.keys(bp.designs)).toEqual(['d1']);
    expect(bp.objects.filter((o) => o.design === 'd1')).toHaveLength(4);
    expect(bp.roads.segments.length).toBeGreaterThanOrEqual(4); // the crossing splits both roads
    expect(bp.roads.segments.every((s) => /^s\d+$/.test(s.id) && /^n\d+$/.test(s.a))).toBe(true);
    expect(bp.attachments.length).toBe(4);
    expect(bp.features.map((f) => f.kind).sort()).toEqual(['lake', 'mountain', 'river']);
    expect(bp.features.every((f) => /^r\d+$/.test(f.id))).toBe(true);
    // Local frame: the house at world (-40, -60) sits at (10, -10) relative to the anchor.
    expect(bp.objects.some((o) => o.offset[0] === 10 && o.offset[2] === -10)).toBe(true);
    // The lake surface is stored relative to the datum.
    const lk = bp.features.find((f) => f.kind === 'lake') as LakeFeature;
    expect(lk.surface).toBeCloseTo(-0.5 - bp.origin.datum, 2);
    expect(bp.terrain?.grid).toEqual({ x0: -50, z0: -50, nx: 101, nz: 101, cell: 1 });
    expect(bp.terrain?.sculpt).not.toBeNull();
    expect(bp.terrain?.paint).not.toBeNull();
    expect(bp.preview.counts).toEqual({ objects: 5, buildings: 4, vegetation: 12, roads: bp.roads.segments.length, features: 3, water: 2 });
  });

  it('serializes canonically: save → parse → save is byte-identical; hash ignores id and time', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    const text = serializeBlueprint(bp);
    const r = parseBlueprintText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(serializeBlueprint(r.blueprint)).toBe(text);
    expect(r.report.unsupported).toEqual([]);
    const other = { ...r.blueprint, id: 'bp_other', meta: { ...r.blueprint.meta, createdAt: 'x', updatedAt: 'y' } };
    expect(blueprintHash(other)).toBe(blueprintHash(bp));
    expect(blueprintHash({ ...bp, meta: { ...bp.meta, name: 'renamed' } })).not.toBe(blueprintHash(bp));
    // Never any dynamic state.
    expect(text).not.toMatch(/"depth":\s*\[|velocity|"damage"|"health"/);
  });

  it('selection: polygon areas take objects inside the polygon and mask the terrain grid', () => {
    district();
    const tri: CaptureSelection = { shape: { kind: 'polygon', points: [[-100, -100], [5, -100], [-100, 5]] } };
    const { blueprint: bp } = capture(tri);
    // Inside the triangle x + z < −95: the houses at (−60, −60) and (−40, −60).
    expect(bp.objects.filter((o) => o.type === 'building').length).toBe(2);
    expect(bp.terrain?.mask).not.toBeNull();
  });

  it('selection: explicit objects / roads / features without an area use their bounds', () => {
    const ids = district();
    const seg = Object.keys(S().doc.roads.segments)[0];
    const { blueprint: bp, report } = capture({ shape: null, objects: [ids[0]], segments: [seg], features: ['f1'] });
    expect(report.area).toHaveLength(4);
    expect(bp.roads.segments).toHaveLength(1);
    expect(bp.features.map((f) => f.kind)).toEqual(['mountain']);
    // The house plus the objects linked to the selected road.
    expect(bp.objects.length).toBeGreaterThanOrEqual(1);
  });

  it('element toggles leave things out and count them', () => {
    district();
    const { blueprint: bp, report } = capture(rectSel(-100, -100, 0, 0), { include: { vegetation: false, water: false } });
    expect(bp.vegetation).toHaveLength(0);
    expect(report.excluded.vegetation).toBe(12);
    expect(bp.features.map((f) => f.kind)).toEqual(['mountain']);
    expect(report.excluded.water).toBe(2);
  });
});

describe('boundary policies and dependencies', () => {
  it('clip cuts roads and rivers at the boundary and records the cut ends', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-70, -70, -30, -20), { roads: 'clip', nature: 'clip' });
    const dep = (k: string) => bp.dependencies.filter((d) => d.kind === k);
    expect(dep('roadExternal')[0].refs.length).toBeGreaterThanOrEqual(3);
    // Every captured road lies inside the area (± rounding).
    for (const n of bp.roads.nodes) expect(Math.abs(n.x) <= 20.01 && Math.abs(n.z) <= 25.01).toBe(true);
    const rv = bp.features.filter((f) => f.kind === 'river') as RiverFeature[];
    expect(rv.length).toBeGreaterThanOrEqual(1);
    expect(rv[0].meander.amplitude).toBe(0); // baked into the points
    expect(dep('riverInflowOutside').length + dep('riverOutletOutside').length).toBeGreaterThanOrEqual(2);
    // The lake partly inside is kept whole and reported.
    expect(dep('lakePartial')).toHaveLength(1);
    expect(bp.features.filter((f) => f.kind === 'lake')).toHaveLength(1);
  });

  it('inside leaves partial roads and rivers out (reported, never silently)', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-70, -70, -30, -20), { roads: 'inside', nature: 'inside' });
    expect(bp.roads.segments).toHaveLength(0);
    expect(bp.dependencies.filter((d) => d.kind === 'roadPartial' && d.resolution === 'dropped').length).toBeGreaterThan(0);
    expect(bp.dependencies.some((d) => d.kind === 'riverPartial' && d.resolution === 'dropped')).toBe(true);
    // Links to roads that were left out are detached and reported.
    expect(bp.dependencies.some((d) => d.kind === 'externalLink')).toBe(true);
    expect(bp.attachments).toHaveLength(0);
  });

  it('coastlines are never captured but reported; partial groups and shared designs are reported', () => {
    district();
    S().setFeatures([...S().doc.landscape.features, { id: 'f9', kind: 'coast', points: [[-99, 80], [99, 80]], seaSide: 1, beachSlope: 0.05, beachWidth: 10, offshoreSlope: 0.05, maxDepth: 5, material: 2 }], 10);
    const { blueprint: bp } = capture(rectSel(-90, -75, -40, 99));
    expect(bp.features.some((f) => f.kind === ('coast' as string))).toBe(false);
    expect(bp.dependencies.some((d) => d.kind === 'coastExcluded')).toBe(true);
    const { blueprint: one } = capture(rectSel(-42, -62, -38, -58));
    expect(one.dependencies.some((d) => d.kind === 'sharedDesign' && d.resolution === 'copied')).toBe(true);
    const g = capture(rectSel(-86, -71, -81, -66)).blueprint; // only one of the two grouped trees
    expect(g.dependencies.some((d) => d.kind === 'groupPartial')).toBe(true);
  });
});

describe('placement: local frame, rotation, ids, references', () => {
  it('placing at the source anchor with yaw 0 reproduces positions, roads and features', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    const plan = place(bp, { x: -50, z: -50, roads: 'separate', terrain: 'preserve' });
    expect(plan.report.errors).toEqual([]);
    const src = Object.values(S().doc.objects).sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial);
    const key = (p: number[]) => `${Math.round(p[0] * 1000) / 1000},${Math.round(p[2] * 1000) / 1000}`;
    expect(plan.edit.add.map((a) => key(a.transform.position)).sort()).toEqual(src.map((o) => key(o.transform.position)).sort());
    // Heights: on the same ground (within the "grounded" tolerance of the source objects).
    const ys = new Map(src.map((o) => [key(o.transform.position), o.transform.position[1]]));
    for (const a of plan.edit.add) expect(Math.abs(a.transform.position[1] - ys.get(key(a.transform.position))!)).toBeLessThan(0.05);
    const placed = plan.edit.landscape!.features!.slice(-3);
    const orig = S().doc.landscape.features;
    expect(placed.find((f) => f.kind === 'mountain')).toMatchObject({ x: -75, z: -78 });
    expect((placed.find((f) => f.kind === 'lake') as LakeFeature).surface).toBeCloseTo((orig.find((f) => f.kind === 'lake') as LakeFeature).surface, 2);
    // Frames at the identity are dropped: same value as the source feature apart from the id.
    const m0 = orig.find((f) => f.kind === 'mountain')!;
    expect({ ...placed.find((f) => f.kind === 'mountain')!, id: m0.id }).toEqual(m0);
  });

  it('rotation turns objects, road nodes, river points and the relief together (noise frame)', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    S().newDocument();
    const yaw = Math.PI / 2;
    const { plan } = commit(bp, { x: 50, z: 50, yaw, roads: 'separate', terrain: 'offset' });
    // A local point (u, v) maps to (50, 50) + R(yaw)(u, v).
    const at = (u: number, v: number) => { const [a, b] = rotate(u, v, yaw); return [50 + a, 50 + b]; };
    const m = bp.features.find((f) => f.kind === 'mountain') as PeakFeature;
    const [mx, mz] = at(m.x, m.z);
    const pm = S().doc.landscape.features.find((f) => f.kind === 'mountain') as PeakFeature;
    expect(pm.x).toBeCloseTo(mx, 2);
    expect(pm.z).toBeCloseTo(mz, 2);
    expect(pm.frame).toBeDefined();
    // The rough relief is the same at corresponding points (noise frame turned with the mountain).
    const zero = new Float32Array(S().doc.terrain.heights.length);
    const L = landformSampler({ ...S().doc.landscape, sculpt: zero, features: [pm] }, S().doc.terrain);
    district();
    const src = S().doc.landscape.features.find((f) => f.kind === 'mountain')!;
    const Ls = landformSampler({ ...S().doc.landscape, sculpt: zero, features: [src] }, S().doc.terrain);
    for (const [du, dv] of [[3, 4], [-7, 2], [10, -6], [0.5, -12]]) {
      const [wx, wz] = at(m.x + du, m.z + dv);
      expect(L(wx, wz)).toBeCloseTo(Ls(-75 + du, -78 + dv), 2);
    }
    // Objects keep their relative layout turned by the yaw.
    const h0 = bp.objects.find((o) => o.offset[0] === 10 && o.offset[2] === -10)!;
    const [hx, hz] = at(10, -10);
    expect(plan.edit.add.some((a) => Math.abs(a.transform.position[0] - hx) < 1e-6 && Math.abs(a.transform.position[2] - hz) < 1e-6)).toBe(true);
    expect(h0).toBeDefined();
    const net = plan.report.roads.network!;
    const n1 = bp.roads.nodes[0];
    const [nx, nz] = at(n1.x, n1.z);
    expect(Object.values(net.nodes).some((n) => Math.abs(n.x - nx) < 0.01 && Math.abs(n.z - nz) < 0.01)).toBe(true);
  });

  it('fresh world ids on every placement; local ids never reach the world; references stay intact', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    S().newDocument();
    const a = commit(bp, { x: -50, z: -50 });
    const b = commit(bp, { x: 50, z: 50 });
    const doc = S().doc;
    expect(new Set([...a.ids, ...b.ids]).size).toBe(a.ids.length + b.ids.length);
    expect(Object.keys(doc.objects).every((id) => !/^[ov]\d+$/.test(id))).toBe(true);
    expect(doc.landscape.features.map((f) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    const segIds = Object.keys(doc.roads.segments);
    expect(new Set(segIds).size).toBe(segIds.length);
    // Every link points to an existing segment; groups were recreated per placement.
    const objs = Object.values(doc.objects);
    expect(objs.filter((o) => o.roadLink).every((o) => doc.roads.segments[o.roadLink!.segment])).toBe(true);
    expect(objs.filter((o) => o.roadLink).length).toBe(8);
    const groups = new Set(objs.map((o) => o.group).filter(Boolean));
    expect(groups.size).toBe(2);
    // Shared design: one object for every copy (design-table entry on save).
    const designs = new Set(objs.filter((o) => o.building).map((o) => o.building));
    expect(designs.size).toBe(1);
    const json = JSON.parse(serializeDocument(doc));
    expect(Object.keys(json.designs)).toHaveLength(1);
  });
});

describe('roads: connection policies', () => {
  const corridor = () => {
    S().newDocument();
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-30, -90], [-30, 90]], { curved: false, profile: defaultProfile() }).network });
  };
  const stub = () => {
    S().newDocument();
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[0, 0], [40, 0]], { curved: false, profile: defaultProfile() }).network });
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[20, -15], [20, 15]], { curved: false, profile: defaultProfile() }).network });
    return capture(rectSel(-1, -16, 41, 16)).blueprint;
  };

  it('separate: inserted as stored, crossings reported, existing roads untouched', () => {
    const bp = stub();
    corridor();
    const before = S().doc.roads.segments;
    const { plan } = commit(bp, { x: -20, z: 0, roads: 'separate' });
    expect(plan.report.roads.unconnected).toBeGreaterThan(0);
    for (const id of Object.keys(before)) expect(S().doc.roads.segments[id]).toBe(before[id]);
  });

  it('snap: only open ends near the corridor attach (T-junction), nothing removed', () => {
    const bp = stub();
    corridor();
    const before = Object.keys(S().doc.roads.segments);
    // Left end of the stub (local x = -20) lands 1.5 m from the corridor.
    const { plan } = commit(bp, { x: -8.5, z: 0, roads: 'snap' });
    expect(plan.report.roads.snapped).toBe(1);
    expect(plan.report.roads.split).toEqual(before);
    expect(plan.report.errors).toEqual([]);
  });

  it('snap: an open end lying exactly ON a road becomes a T-junction (split reuses the end node)', () => {
    const bp = stub();
    corridor();
    // Left end (local x = −20) at world x = −30: exactly on the corridor's centerline.
    const { plan } = commit(bp, { x: -10, z: 0, roads: 'snap' });
    expect(plan.report.roads.snapped).toBe(1);
    expect(plan.report.roads.split).toHaveLength(1);
    const net = S().doc.roads;
    const deg = (id: string) => Object.values(net.segments).filter((s) => s.a === id || s.b === id).length;
    expect(Object.keys(net.nodes).some((id) => deg(id) === 3 && Math.abs(net.nodes[id].x + 30) < 0.01)).toBe(true);
  });

  it('connect: crossings become junctions like hand-drawn roads; split roads are reported', () => {
    const bp = stub();
    corridor();
    const { plan } = commit(bp, { x: -20, z: 0, roads: 'connect' });
    expect(plan.report.roads.split.length).toBe(1);
    expect(plan.report.warnings.some((w) => w.code === 'roadSplits')).toBe(true);
  });

  it('connection preview lists open ends near existing roads before placing', () => {
    const bp = stub();
    corridor();
    const plan = place(bp, { x: -8.5, z: 0, roads: 'separate' });
    expect(plan.report.connections.some((c) => c.kind === 'road' || c.kind === 'node')).toBe(true);
    expect(Object.keys(S().doc.roads.segments)).toHaveLength(1); // preview changed nothing
  });
});

describe('terrain merge policies', () => {
  const hillBlueprint = () => {
    S().newDocument();
    S().beginTerrainStroke();
    for (let k = 0; k < 12; k++) S().terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 8, strength: 1 }, dt: 0.05 });
    S().endTerrainStroke();
    const top = H(0, 0);
    expect(top).toBeGreaterThan(0.5);
    return { bp: capture(rectSel(-12, -12, 12, 12)).blueprint, top };
  };
  const slope = () => {
    S().newDocument();
    const t0 = S().doc.terrain;
    const heights = new Float32Array(t0.heights.length);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = Math.round(0.05 * (t0.originX + ix) * 100) / 100;
    S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  };

  it('preserve writes nothing; offset adds the relief on the destination slope', () => {
    const { bp, top } = hillBlueprint();
    slope();
    const base = H(50, 50);
    const p0 = place(bp, { x: 50, z: 50, terrain: 'preserve' });
    expect(p0.edit.landscape).toBeUndefined();
    commit(bp, { x: 50, z: 50, terrain: 'offset' });
    expect(H(50, 50) - base).toBeCloseTo(top, 1);
    // The slope continues under the relief: the far edges keep the destination heights.
    expect(H(64, 50)).toBeCloseTo(0.05 * 64, 1);
  });

  it('apply reproduces the blueprint surface relative to the datum; blend fades to the destination at the edge', () => {
    const { bp, top } = hillBlueprint();
    slope();
    const datum = preFeatureAt(S().doc, 50, 50);
    commit(bp, { x: 50, z: 50, terrain: 'apply' });
    expect(H(50, 50)).toBeCloseTo(datum + top, 1);
    // Inside the footprint the slope is replaced by the (flat) blueprint ground.
    expect(H(61, 50)).toBeCloseTo(datum, 1);
    S().undo();
    commit(bp, { x: 50, z: 50, terrain: 'blend', blendWidth: 6 });
    expect(H(50, 50)).toBeCloseTo(datum + top, 1);
    // At the edge the destination slope is kept.
    expect(H(62, 50)).toBeCloseTo(0.05 * 62, 1);
  });

  it('apply warns about existing sculpt and overlapping features; undo restores every layer exactly', () => {
    const { bp } = hillBlueprint();
    district();
    const json = serializeDocument(S().doc);
    const plan = place(bp, { x: -70, z: -65, terrain: 'apply' });
    expect(plan.report.warnings.some((w) => w.code === 'existingSculpt')).toBe(true);
    expect(plan.report.warnings.some((w) => w.code === 'featureOverlap')).toBe(true);
    S().applyEdit(plan.edit);
    expect(serializeDocument(S().doc)).not.toBe(json);
    S().undo();
    expect(serializeDocument({ ...S().doc, meta: JSON.parse(json).meta } as WorldDocument)).toBe(json);
  });

  it('deleting a placed road does not remove other layers', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    S().newDocument();
    commit(bp, { x: -50, z: -50, terrain: 'offset' });
    const sculpt = S().doc.landscape.sculpt.slice();
    const features = S().doc.landscape.features;
    S().applyEdit({ roads: { ...S().doc.roads, segments: {}, nodes: {} } });
    expect(S().doc.landscape.features).toBe(features);
    expect(S().doc.landscape.sculpt).toEqual(sculpt);
  });
});

describe('water: rivers, lakes and their initial state', () => {
  it('channel shape and initial water are separable at capture and at placement', () => {
    district();
    const dry = capture(rectSel(-100, -100, 0, 0), { include: { waterState: false } }).blueprint;
    const r = dry.features.find((f) => f.kind === 'river') as RiverFeature;
    expect(r.water.fill).toBe(0);
    expect(r.water.inflow).toBe(0);
    expect((dry.features.find((f) => f.kind === 'lake') as LakeFeature).filled).toBe(false);
    const wet = capture(rectSel(-100, -100, 0, 0)).blueprint;
    expect((wet.features.find((f) => f.kind === 'river') as RiverFeature).water).toEqual({ fill: 0.5, inflow: 2, downstream: 'open' });
    const plan = place(wet, { x: -50, z: -50, include: { ...defaultPlacement().include, waterState: false } });
    const placed = plan.edit.landscape!.features!.filter((f) => f.kind === 'river').pop() as RiverFeature;
    expect(placed.water.inflow).toBe(0);
  });

  it('a clipped river reports its missing inflow / outlet; an unconnected cut end is warned at placement', () => {
    district();
    const bp = capture(rectSel(-70, -40, -30, -10), { nature: 'clip' }).blueprint;
    S().newDocument();
    const plan = place(bp, { x: 0, z: 0 });
    const codes = plan.report.warnings.map((w) => w.code);
    expect(codes).toContain('riverUnconnected');
    expect(codes.some((c) => c === 'riverInflowOutside' || c === 'riverOutletOutside')).toBe(true);
  });
});

describe('atomic placement and undo / redo', () => {
  it('a whole district is ONE undo step; redo restores the identical world', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    S().newDocument();
    const empty = serializeDocument(S().doc);
    const steps = S().past.length;
    commit(bp, { x: 50, z: 50, terrain: 'apply' });
    expect(S().past.length).toBe(steps + 1);
    const placed = serializeDocument(S().doc);
    expect(Object.keys(S().doc.objects).length).toBe(17);
    S().undo();
    const meta = (j: string) => JSON.stringify({ ...JSON.parse(j), meta: null });
    expect(meta(serializeDocument(S().doc))).toBe(meta(empty));
    S().redo();
    expect(meta(serializeDocument(S().doc))).toBe(meta(placed));
  });

  it('an invalid part refuses the whole placement: nothing is added', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    S().newDocument();
    const plan = place(bp, { x: 50, z: 50 });
    const broken = { ...plan.edit, roads: { ...plan.edit.roads!, segments: { ...plan.edit.roads!.segments, bad: { id: 'bad', a: 'nX', b: 'nY', control: [], profile: defaultProfile() } } } };
    const before = serializeDocument(S().doc);
    expect(() => S().applyEdit(broken)).toThrow();
    expect(serializeDocument(S().doc)).toBe(before);
    expect(Object.keys(S().doc.objects)).toHaveLength(0);
  });

  it('objects are seated on the FINAL ground (after this edit raised it)', () => {
    S().newDocument();
    S().beginTerrainStroke();
    for (let k = 0; k < 14; k++) S().terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 12, strength: 1 }, dt: 0.05 });
    S().endTerrainStroke();
    S().applyEdit({ add: [{ type: 'tree', seed: 1, transform: { position: v3(0, H(0, 0), 0), rotation: v3(0, 0, 0), scale: v3(1, 1, 1) } }] });
    const bp = capture(rectSel(-14, -14, 14, 14)).blueprint;
    S().newDocument();
    const ids = commit(bp, { x: 40, z: 40, terrain: 'apply' }).ids;
    const o = S().doc.objects[ids[0]];
    expect(o.transform.position[1]).toBeCloseTo(H(40, 40), 2);
    expect(o.transform.position[1]).toBeGreaterThan(1);
  });
});

describe('file format: import / export, migration, rejection', () => {
  const sample = () => { district(); return capture(rectSel(-100, -100, 0, 0)).blueprint; };

  it('v1 copy / paste payloads and Phase 19 nature regions migrate', async () => {
    district();
    const { createBlueprint } = await import('@/editor/build/blueprint');
    const objs = Object.values(S().doc.objects).filter((o) => o.type === 'building');
    const v1 = createBlueprint(objs, samplerFor(S().doc.terrain), 'legacy', { network: S().doc.roads, segments: Object.keys(S().doc.roads.segments) });
    const r = parseBlueprintText(JSON.stringify(v1));
    expect(r.ok && r.report.migratedFrom).toBe('v1');
    if (r.ok) {
      expect(r.blueprint.objects).toHaveLength(4);
      expect(Object.keys(r.blueprint.designs)).toHaveLength(1);
      expect(r.blueprint.attachments.length).toBe(4);
    }
    const { captureRegion } = await import('@/landscape/region');
    composeAll(S().doc.landscape, S().doc.terrain, 0);
    const region = captureRegion(S().doc.landscape, S().doc.terrain, [-99, -99, -1, -1]);
    const rr = parseBlueprintValue(JSON.parse(JSON.stringify(region)));
    expect(rr.ok && rr.report.migratedFrom).toBe('nature-region');
    if (rr.ok) {
      expect(rr.blueprint.terrain?.surface).toBeNull();
      const plan = place(rr.blueprint, { x: 0, z: 0, terrain: 'apply' });
      expect(plan.report.warnings.some((w) => w.code === 'noSurface')).toBe(true);
    }
  });

  it('unknown future fields are kept and written back; unknown object types are reported', () => {
    const bp = sample();
    const v = exportValue(bp) as Record<string, unknown> & { objects: unknown[]; features: Record<string, unknown>[] };
    const future = { ...v, version: 3, minReaderVersion: 2, climate: { zone: 'temperate' }, objects: [...v.objects, { id: 'o99', type: 'windTurbine', offset: [0, 0, 0] }], features: [{ ...v.features[0], erosionRate: 0.2 }, ...v.features.slice(1)] };
    const r = parseBlueprintValue(JSON.parse(JSON.stringify(future)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.newerVersion).toBe(3);
    expect(r.report.unsupportedObjects).toBe(1);
    expect(r.report.unsupported).toEqual(expect.arrayContaining(['climate', 'features[].erosionRate']));
    const back = JSON.parse(serializeBlueprint(r.blueprint));
    expect(back.climate).toEqual({ zone: 'temperate' });
    expect(back.objects.some((o: { type: string }) => o.type === 'windTurbine')).toBe(true);
    expect(back.features[0].erosionRate).toBe(0.2);
    // A writer that needs a newer reader is refused.
    const r2 = parseBlueprintValue({ ...v, version: 4, minReaderVersion: 4 });
    expect(r2.ok || r2.code).toBe('version');
  });

  it('rejects broken files with a reason: JSON, fields, references, sizes, unsafe keys, thumbnails', () => {
    const bp = sample();
    const v = JSON.parse(serializeBlueprint(bp));
    const code = (x: unknown) => { const r = typeof x === 'string' ? parseBlueprintText(x) : parseBlueprintValue(x); return r.ok ? 'ok' : r.code; };
    expect(code('{not json')).toBe('json');
    expect(code({ format: 'something-else' })).toBe('format');
    expect(code({ ...v, meta: undefined })).toBe('schema');
    expect(code({ ...v, roads: { ...v.roads, segments: [{ ...v.roads.segments[0], a: 'n999' }] } })).toBe('reference');
    expect(code({ ...v, attachments: [{ ...v.attachments[0], segment: 's999' }] })).toBe('reference');
    expect(code({ ...v, objects: v.objects.map((o: { design?: string }) => (o.design ? { ...o, design: 'd9' } : o)) })).toBe('reference');
    expect(code({ ...v, objects: Array.from({ length: 20_001 }, () => v.objects[0]) })).toBe('limits');
    expect(code(JSON.parse(`{"format":"disaster-sim/blueprint","version":2,"__proto__":{"polluted":true}}`))).toBe('unsafe');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(code({ ...v, preview: { ...v.preview, thumbnail: 'data:image/svg+xml;base64,PHN2Zz4=' } })).toBe('ok'); // dropped, not executed
    const r = parseBlueprintValue({ ...v, preview: { ...v.preview, thumbnail: 'javascript:alert(1)' } });
    expect(r.ok && r.blueprint.preview.thumbnail).toBeNull();
    expect(code({ ...v, objects: [{ ...v.objects[0], offset: [1e9, 0, 0] }] })).toBe('reference');
    expect(code('x'.repeat(64 * 1024 * 1024 + 1))).toBe('tooLarge');
  });
});

describe('save / load with placed blueprints', () => {
  it('world save → load → save is byte-identical with turned landforms (noise frames) and placed roads', () => {
    district();
    const { blueprint: bp } = capture(rectSel(-100, -100, 0, 0));
    S().newDocument();
    commit(bp, { x: 45, z: 45, yaw: 0.7, terrain: 'apply', roads: 'snap' });
    const text = serializeDocument(S().doc);
    const r = parseDocument(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.landscape.recomposedVertices).toBe(0);
    expect(serializeDocument(r.doc)).toBe(text);
    expect(r.doc.landscape.features.some((f) => 'frame' in f && f.frame)).toBe(true);
  });
});
