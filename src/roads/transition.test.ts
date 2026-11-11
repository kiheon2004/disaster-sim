/**
 * Phase 36 (roads): width transitions at straight joints of two cross-sections, and the small road fixes of the audit
 * (docs/phase36-audit/terrain-roads.md §8, §10 #3 #11 #15).
 *
 * The repro of the stair: the default world + the palette's 2-lane road placed at (66, 0), yaw 0, length 20 — its west
 * end snaps to the main street's free end n2 (56, 0), so the 10 m 'wide' section meets the 7 m 'street' section. Before
 * Phase 36 both kept their constant width up to the node: a slit in the mesh and a 0.16–0.18 m step in the heightfield.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TerrainData, WorldDocument } from '@/core/model';
import { createEmptyDocument } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { defaultTownRoads } from '@/world/defaultTown';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { samplerFor } from '@/terrain/TerrainSampler';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { RoadBatches } from '@/rendering/roads/RoadBatches';
import { roadInfluence } from '@/landscape/apply';
import { bakeRegion, dirtyRect } from './bake';
import { nominalSection, sectionAt, taperSignature, transitionsOf } from './crossSection';
import { intersectionsOf } from './intersections';
import { segmentPiece, intersectionPiece, type MeshData } from './mesh';
import { drawRoad, findNode, mergeAtNode, networkWarnings, sameProfile, setProfile } from './network';
import { decodeUnderlay, encodeUnderlay } from './schema';
import { vehiclesAlong } from './city';
import { defaultProfile, emptyNetwork, PROFILE_PRESETS, type RoadNetwork, type RoadProfile, type RoadSegment } from './types';

const prof = (k: string, extra: Partial<RoadProfile> = {}): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[k] ?? {}), ...extra });
const vi = (t: TerrainData, x: number, z: number) => Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);
const H = (t: TerrainData, x: number, z: number) => t.heights[vi(t, x, z)];

/** The default world with the palette 2-lane road joined to the main street's east end. */
function jointWorld() {
  const st = scratchWorld(createEmptyDocument(''));
  st.getState().applyEdit({ roads: defaultTownRoads() });
  st.getState().applyEdit({ roads: drawRoad(st.getState().doc.roads, [[56, 0], [76, 0]], { curved: false, profile: prof('street') }).network });
  const doc = st.getState().doc;
  const node = findNode(doc.roads, 56, 0, 0.5)!;
  const at = Object.values(doc.roads.segments).filter((s) => s.a === node.id || s.b === node.id);
  const wide = at.find((s) => s.profile.width === 10)!, narrow = at.find((s) => s.profile.width === 7)!;
  return { st, doc, node: node.id, wide, narrow };
}

/** A flat world with the given straight roads drawn in order. */
function lineWorld(roads: [number, number, number, number, RoadProfile][]) {
  const st = scratchWorld(createEmptyDocument(''));
  let n = st.getState().doc.roads;
  for (const [x0, z0, x1, z1, p] of roads) n = drawRoad(n, [[x0, z0], [x1, z1]], { curved: false, profile: p }).network;
  st.getState().applyEdit({ roads: n });
  return st;
}

const segAt = (n: RoadNetwork, x: number, z: number) => Object.values(n.segments).find((s) => {
  const a = n.nodes[s.a], b = n.nodes[s.b];
  return Math.min(a.x, b.x) < x && x < Math.max(a.x, b.x) && Math.abs(a.z - z) < 1e-6;
})!;

const piece = (doc: WorldDocument, seg: RoadSegment) => segmentPiece({ network: doc.roads, terrain: doc.terrain, sampler: samplerFor(doc.terrain) }, seg);

/** Largest |z| of the mesh vertices at x (the outermost edge of that layer in the cross-section at x). */
function edgeAt(m: MeshData, x: number): number {
  let r = -1;
  for (let i = 0; i < m.pos.length; i += 3) if (Math.abs(m.pos[i] - x) < 1e-6) r = Math.max(r, Math.abs(m.pos[i + 2]));
  return r;
}

describe('Phase 36 width transitions (derived, no schema change)', () => {
  it('the 10 → 7 m joint tapers on the wide segment over the rule length (15 m)', () => {
    const { doc, node, wide, narrow } = jointWorld();
    const tr = transitionsOf(doc.roads).get(node)!;
    expect(tr).toBeDefined();
    expect(tr.host).toBe(wide.id);
    expect(tr.narrow).toBe(narrow.id);
    // max(6, 10 · |5 − 3.5|, 5 · |7.5 − 5.5|) = 15 m, well inside 0.45 of the 79 m main street: not split, not short.
    expect(tr.wanted).toBeCloseTo(15, 9);
    expect(tr.hostLength).toBeCloseTo(15, 9);
    expect(tr.narrowLength).toBe(0);
    expect(tr.short).toBe(false);
    expect(networkWarnings(doc.roads).some((w) => w.code === 'shortTransition')).toBe(false);
    // Outside the taper the section is the profile's own object; at the node it is the narrow road's section.
    const L = doc.roads.nodes[wide.b].x - doc.roads.nodes[wide.a].x;
    expect(sectionAt(doc.roads, wide, L - 15.01)).toBe(nominalSection(wide.profile));
    const end = sectionAt(doc.roads, wide, L), start = sectionAt(doc.roads, narrow, 0);
    for (const k of ['w', 'swL', 'swR', 'curbL', 'curbR', 'fall'] as const) expect(end[k]).toBe(start[k]);
    expect(sectionAt(doc.roads, narrow, 0)).toBe(nominalSection(narrow.profile));
  });

  it('mesh carriageway and sidewalk edges are C0 across the node (they jumped 1.5 / 2 m before)', () => {
    const { doc, wide, narrow } = jointWorld();
    const pw = piece(doc, wide), pn = piece(doc, narrow);
    // At the node both pieces have the same carriageway edge (3.5 m) and sidewalk outer edge (5.5 m).
    expect(edgeAt(pw.surface, 56)).toBeCloseTo(3.5, 9);
    expect(edgeAt(pn.surface, 56)).toBeCloseTo(3.5, 9);
    expect(edgeAt(pw.walk, 56)).toBeCloseTo(5.5, 9);
    expect(edgeAt(pn.walk, 56)).toBeCloseTo(5.5, 9);
    // Just before / after the node the edges differ only by the taper slope (0.1 m/m carriageway, 0.133 m/m outer edge).
    expect(Math.abs(edgeAt(pw.surface, 55) - edgeAt(pn.surface, 57))).toBeLessThan(0.15);
    expect(Math.abs(edgeAt(pw.walk, 55) - edgeAt(pn.walk, 57))).toBeLessThan(0.15);
    // The taper starts at 41 m with the full wide section (a cross-section exactly there).
    expect(edgeAt(pw.surface, 41)).toBeCloseTo(5, 9);
    expect(edgeAt(pw.walk, 41)).toBeCloseTo(7.5, 9);
    expect(edgeAt(pw.surface, 48)).toBeCloseTo(4.3, 9);
  });

  it('the baked heightfield (the vehicle collider) has no step across the joint at |z| = 3.5 … 5', () => {
    const { doc } = jointWorld();
    const t = doc.terrain;
    for (const z of [-5, -4, 4, 5]) {
      // Across the node (56) the stair was 0.16–0.18 m: the wide carriageway against the narrow road's sidewalk. (Inside
      // the taper a line of constant |z| crosses the narrowing curb once, as it must: that is the curb, not a stair.)
      for (const x of [55, 56, 57]) expect(Math.abs(H(t, x + 1, z) - H(t, x, z)), `z ${z}, x ${x}`).toBeLessThan(0.025);
      // The sidewalk (concrete) runs through the node; the carriageway edge (asphalt) narrows before it.
      expect(t.ground[vi(t, 56, z)]).toBe(4);
      expect(t.ground[vi(t, 57, z)]).toBe(4);
    }
    // The lanes stay asphalt, crowned exactly as before, through the taper and the node.
    for (const x of [40, 48, 56, 60]) for (const z of [-3, 0, 3]) expect(H(t, x, z)).toBeCloseTo(-0.02 * Math.abs(z), 6);
  });

  it('lane centres are continuous through the joint (equal lane counts interpolate)', () => {
    const { doc, wide, narrow } = jointWorld();
    const L = doc.roads.nodes[wide.b].x - doc.roads.nodes[wide.a].x;
    expect(sectionAt(doc.roads, wide, L).lanes).toEqual(nominalSection(narrow.profile).lanes);
    for (const s of [L - 15, L - 7.5, L - 0.5]) for (const c of sectionAt(doc.roads, wide, s).lanes) expect(Math.abs(c!)).toBeCloseTo(1.75, 9);
  });

  it('avenue4 → normal2: the outer lanes and their dividers end at the taper start; vehicles stay on the remaining lanes', () => {
    const st = lineWorld([[-95, 0, 0, 0, prof('avenue')], [0, 0, 40, 0, prof('street')]]);
    const doc = st.getState().doc;
    const av = segAt(doc.roads, -50, 0);
    const tr = [...transitionsOf(doc.roads).values()][0];
    expect(tr.host).toBe(av.id);
    // max(6, 10 · 3.5, 5 · 4.5) = 35 m on the 95 m avenue.
    expect(tr.hostLength).toBeCloseTo(35, 9);
    const L = 95;
    expect(sectionAt(doc.roads, av, L - 35).lanes).toEqual([-5.25, -1.75, 1.75, 5.25]);
    expect(sectionAt(doc.roads, av, L - 34).lanes).toEqual([null, -1.75, 1.75, null]);
    expect(sectionAt(doc.roads, av, L).lanes).toEqual([null, -1.75, 1.75, null]);
    const keys = (s: number) => sectionAt(doc.roads, av, s).lines.map((l) => l.key).sort();
    expect(keys(L - 35)).toEqual(['cL', 'cR', 'dL1', 'dR1', 'eL', 'eR']);
    expect(keys(L - 34)).toEqual(['cL', 'cR', 'eL', 'eR']);
    // The edge line bends from 6.75 m to the street's 3.25 m and meets it at the node.
    const edgeR = (s: number) => sectionAt(doc.roads, av, s).lines.find((l) => l.key === 'eR')!.o;
    expect(edgeR(L - 35)).toBeCloseTo(6.75, 9);
    expect(edgeR(L)).toBeCloseTo(3.25, 9);
    expect(edgeR(L - 17.5)).toBeCloseTo(5, 9);
    const plan = vehiclesAlong({ terrain: samplerFor(doc.terrain), objects: {}, network: doc.roads }, [av.id], { spacing: 7, mode: 'lanes', seed: 3, policy: 'follow', presets: [{ type: 'car' }] });
    const pos = plan.inputs.map((p) => p.transform.position);
    expect(pos.some(([x, , z]) => x < -40 && Math.abs(Math.abs(z) - 5.25) < 0.01)).toBe(true);
    for (const [x, , z] of pos) if (x > -35) expect(Math.abs(z)).toBeLessThan(2);
  });

  it('a host too short for the rule shares the taper with the narrow road; still short → shortTransition warning', () => {
    // 10 m wide piece between two 10 m streets: 0.45 · 10 = 4.5 m on each side of each node = 9 m < 15 m.
    const st = lineWorld([[-15, 0, -5, 0, prof('street')], [-5, 0, 5, 0, prof('wide')], [5, 0, 15, 0, prof('street')]]);
    const n = st.getState().doc.roads;
    const trs = [...transitionsOf(n).values()];
    expect(trs).toHaveLength(2);
    for (const tr of trs) {
      expect(tr.hostLength).toBeCloseTo(4.5, 9);
      expect(tr.narrowLength).toBeCloseTo(4.5, 9);
      expect(tr.short).toBe(true);
    }
    const warn = networkWarnings(n).filter((w) => w.code === 'shortTransition');
    // One warning per segment of each short transition (the inspector shows it on either road).
    expect(warn).toHaveLength(4);
    expect([...new Set(warn.map((w) => w.node))].sort()).toEqual(trs.map((t) => t.node).sort());
    const wide = segAt(n, 0, 0), west = segAt(n, -10, 0);
    // The two tapers of the short piece never overlap: its middle keeps the wide section.
    expect(sectionAt(n, wide, 5)).toBe(nominalSection(wide.profile));
    // Split: the node section lies between the two (half way here) and both sides agree there.
    const a = sectionAt(n, west, 10), b = sectionAt(n, wide, 0);
    expect(a.w).toBeCloseTo(4.25, 9);
    expect(b.w).toBeCloseTo(a.w, 12);
    expect(b.swL).toBeCloseTo(a.swL, 12);
  });

  it('save → load keeps the transition and the tapered heightfield exactly', () => {
    const { doc, node } = jointWorld();
    const r = parseDocument(serializeDocument(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.landscape.recomposedVertices).toBe(0);
    expect(Array.from(r.doc.terrain.heights)).toEqual(Array.from(doc.terrain.heights));
    expect(Array.from(r.doc.terrain.ground)).toEqual(Array.from(doc.terrain.ground));
    expect(transitionsOf(r.doc.roads).get(node)).toEqual(transitionsOf(doc.roads).get(node));
  });

  it('a v6 file (saved terrain, no layers) gets the taper re-baked into the heightfield on load', () => {
    const { doc } = jointWorld();
    // A file written before Phase 36 carries the stair: the wide carriageway (crown) up to the node at |z| = 4 … 5.
    const old = { ...doc.terrain, heights: doc.terrain.heights.slice(), ground: doc.terrain.ground.slice() };
    for (let x = 41; x <= 56; x++) for (const z of [-5, -4, 4, 5]) { old.heights[vi(old, x, z)] = Math.fround(-0.02 * Math.abs(z)); old.ground[vi(old, x, z)] = 3; }
    const json = JSON.parse(serializeDocument({ ...doc, terrain: old }));
    delete json.landscape;
    json.schemaVersion = 6;
    const r = parseDocument(JSON.stringify(json));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.landscape.recomposedVertices).toBeGreaterThan(0);
    expect(Array.from(r.doc.terrain.heights)).toEqual(Array.from(doc.terrain.heights));
    expect(Array.from(r.doc.terrain.ground)).toEqual(Array.from(doc.terrain.ground));
  });

  it('editing the narrow neighbour re-bakes the whole taper on the unchanged wide segment (dirty rect)', () => {
    const { st, doc, narrow } = jointWorld();
    const next = setProfile(doc.roads, [narrow.id], { width: 6 });
    // 7 → 6 m: the taper grows to 20 m (36 … 56 m), beyond the reach of the edited segment (≥ 42 m).
    const tr = [...transitionsOf(next).values()][0];
    expect(tr.hostLength).toBeCloseTo(20, 9);
    const rect = dirtyRect(doc.terrain, doc.roads, next)!;
    expect(doc.terrain.originX + rect.x0 * doc.terrain.cellSize).toBeLessThanOrEqual(36 - 15);
    st.getState().applyEdit({ roads: next });
    // Same terrain as a full bake of the new network from scratch.
    const fresh = scratchWorld(createEmptyDocument(''));
    fresh.getState().applyEdit({ roads: { ...next, underlay: emptyNetwork().underlay } });
    expect(Array.from(st.getState().doc.terrain.heights)).toEqual(Array.from(fresh.getState().doc.terrain.heights));
    expect(Array.from(st.getState().doc.terrain.ground)).toEqual(Array.from(fresh.getState().doc.terrain.ground));
    // A layer edit touching only the narrow road re-bakes the taper zone with it.
    const t = doc.terrain;
    const inf = roadInfluence(t, next, { x0: vi(t, 70, 0) % t.nx, z0: 100, x1: vi(t, 71, 0) % t.nx, z1: 101 });
    expect(t.originX + inf.x0 * t.cellSize).toBeLessThanOrEqual(36 - 15);
  });

  it('road meshes of the unchanged host are rebuilt when only the neighbour changes (batch signature)', () => {
    // Same widths, the neighbour drops to one lane: only the host's markings change, the terrain does not.
    const t = createFlatTerrain();
    let n = drawRoad(emptyNetwork(), [[-40, 0], [0, 0]], { curved: false, profile: prof('street') }).network;
    n = drawRoad(n, [[0, 0], [40, 0]], { curved: false, profile: prof('street') }).network;
    n = { ...n, underlay: bakeRegion(t, emptyNetwork(), n, fullRect(t)).underlay };
    expect(transitionsOf(n).size).toBe(0);
    const east = segAt(n, 20, 0), west = segAt(n, -20, 0);
    const m = setProfile(n, [east.id], { lanes: 1 });
    expect(transitionsOf(m).get(east.a)?.host).toBe(west.id);
    expect(taperSignature(m, m.segments[west.id])).not.toBe(taperSignature(n, n.segments[west.id]));
    const b = new RoadBatches();
    const marking = () => b.root.children.find((c) => c.name === 'roads:marking:-1,0') as THREE.Mesh;
    b.sync(n, t);
    const before = marking().geometry;
    b.sync(m, t);
    expect(marking().geometry).not.toBe(before);
    b.dispose();
  });
});

describe('Phase 36 road fixes (audit §10)', () => {
  it('#15 the underlay keeps every ground type (rock / mud / riverbed 6–8 were rejected)', () => {
    const u = { idx: [3, 10, 11, 40], h: [1.25, -0.5, 2, 0], g: [6, 7, 8, 0] };
    const back = decodeUnderlay(encodeUnderlay(u), 100)!;
    expect(back).not.toBeNull();
    expect(back.g).toEqual(u.g);
    expect(decodeUnderlay({ ...encodeUnderlay(u), g: 'z000' }, 100)).toBeNull();
  });

  it('#11 profiles compare symmetrically: shoulders are never dropped by a merge, in either order', () => {
    const p = prof('street'), q = { ...prof('street'), shoulderWidth: 1 };
    expect(sameProfile(p, q)).toBe(false);
    expect(sameProfile(q, p)).toBe(false);
    expect(sameProfile(p, { ...p })).toBe(true);
    for (const [a, b] of [[p, q], [q, p]]) {
      let n = drawRoad(emptyNetwork(), [[-40, 0], [0, 0]], { curved: false, profile: a }).network;
      n = drawRoad(n, [[0, 0], [40, 0]], { curved: false, profile: b }).network;
      expect(mergeAtNode(n, findNode(n, 0, 0, 0.5)!.id)).toBeNull();
    }
  });

  it('#3 curb faces face the carriageway, junction corners have them, free ends are closed', () => {
    const st = scratchWorld(createEmptyDocument(''));
    st.getState().applyEdit({ roads: defaultTownRoads() });
    const doc = st.getState().doc;
    const ctx = { network: doc.roads, terrain: doc.terrain, sampler: samplerFor(doc.terrain) };
    const vertical = (m: MeshData) => {
      const out: { x: number; z: number; nx: number; nz: number }[] = [];
      for (let i = 0; i < m.pos.length; i += 9) if (Math.abs(m.nrm[i + 1]) < 1e-6) out.push({ x: (m.pos[i] + m.pos[i + 3] + m.pos[i + 6]) / 3, z: (m.pos[i + 2] + m.pos[i + 5] + m.pos[i + 8]) / 3, nx: m.nrm[i], nz: m.nrm[i + 2] });
      return out;
    };
    // Main street (z = 0, curbs at |z| = 5): every curb face along it looks toward the centreline.
    const main = segAt(doc.roads, 0, 0);
    const faces = vertical(piece(doc, main).walk).filter((f) => Math.abs(Math.abs(f.z) - 5) < 1e-6);
    expect(faces.length).toBeGreaterThan(20);
    for (const f of faces) expect(f.nz * -Math.sign(f.z)).toBeGreaterThan(0.99);
    // The T junction's sidewalk corners carry curb faces looking into the junction.
    const ix = intersectionsOf(doc.roads).get(findNode(doc.roads, -23, 0, 0.5)!.id)!;
    const corner = vertical(intersectionPiece(ctx, ix).walk);
    expect(corner.length).toBeGreaterThan(0);
    for (const f of corner) expect(f.nx * (-23 - f.x) + f.nz * (0 - f.z)).toBeGreaterThan(0);
    // The free east end (56, 0) of the main street: the slab edge and the sidewalk ends face east.
    const east = segAt(doc.roads, 50, 0);
    const end = vertical(piece(doc, east).walk).filter((f) => Math.abs(f.x - 56) < 1e-6);
    expect(end.length).toBeGreaterThanOrEqual(4);
    for (const f of end) expect(f.nx).toBeGreaterThan(0.99);
  });
});
