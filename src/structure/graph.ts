/**
 * Structural graph of a modular building (Phase 25) — built ONCE per (design, scale) and shared
 * by every building that uses the design (designs are immutable; runtime damage lives elsewhere).
 *
 * It holds what the Phase 17 analysis recomputes from geometry on every call, as flat arrays:
 *
 *  - members: type, role, level, box, mass / weight, structural flag, capacities (capacity.ts);
 *  - support CANDIDATES in priority tiers — the same type-specific rules as analyzeBuilding, but
 *    with every alternative kept, so the load path after a failure is found by switching tiers
 *    instead of redoing the geometry:
 *      column / wall   tier 0: vertical members under it (column, wall, foundation; non-bearing
 *                              walls may also stack on walls)   tier 1: beams / slabs under it
 *                              (transfer)   tier 2 (non-bearing walls): hang from the frame
 *                              (adjacent columns / beams)   + "on soil" when its bottom is at ground
 *      beam            tier 0: columns / walls it frames into, primary beams (secondary beams)
 *      slab            tier 0: beams / walls / columns right under it
 *      roof            tier 0: whatever is under its footprint   tier 1: lower touching members
 *      window / door   tier 0: host wall   tier 1: any touching wall
 *      foundation, slab-on-grade: on the ground (ground support factor set by the ground model)
 *  - connections: one per candidate edge, with its kind and gravity-transfer capacity;
 *  - a topological rank (supports always rank lower than what they carry);
 *  - a plan grid of the members (what lies under a falling block);
 *  - each lateral member's own story stiffness / strength contribution (Phase 17 analysis).
 *
 * Visual-only members are not special-cased: cladding, partitions, windows and roof coverings have
 * mass and a load path to the structure (they hang / rest on it) but are never `structural` — they
 * carry nothing and have no gravity capacity check — except SPANNING roof panels (Phase 31, R1):
 * a roof covering carried by beams / walls / columns (no slab under it) gets a reduced roof-system
 * capacity (`roofCap`, capacity.ts) checked against its own weight and what lies on it (snow, ash).
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { analyzeBuilding, BEARING_GAP, NEAR_GAP, slabBears, TOL, type BuildingAnalysis } from '@/buildings/analysis';
import { analysisOf } from '@/buildings/design';
import { lengthAxis } from '@/buildings/geometry';
import { MATERIALS, material } from '@/buildings/materials';
import { isLateralRole, isStructuralRole, type BuildingDesign, type MemberType } from '@/buildings/types';
import { beamCapacity, beamSeatCapacity, columnCapacity, roofPanelCapacity, slabEdgeCapacity, slabMomentPerM, wallCapacity } from './capacity';
import { CK } from './types';

export const MT: Record<MemberType, number> = { foundation: 0, column: 1, beam: 2, slab: 3, wall: 4, window: 5, door: 6, roof: 7 };
export const MT_FOUNDATION = 0, MT_COLUMN = 1, MT_BEAM = 2, MT_SLAB = 3, MT_WALL = 4, MT_WINDOW = 5, MT_DOOR = 6, MT_ROOF = 7;

/** Plan grid cell size (m). */
const CELL = 2;

export interface StructuralGraph {
  design: BuildingDesign;
  scale: Vec3;
  n: number;
  /** Initial (original world) analysis the graph was built from. */
  analysis: BuildingAnalysis;
  type: Uint8Array;
  level: Int16Array;
  /** Load-carrying member (structural role + structural material). */
  structural: Uint8Array;
  /** Lateral (story stiffness) member. */
  lateral: Uint8Array;
  /** Rests on the ground (foundations, slab-on-grade). */
  ground: Uint8Array;
  /** May stand on the soil when nothing else holds it (bottom at ground level). */
  soilFallback: Uint8Array;
  /** Broken in the original world (initial damage 1). */
  absent: Uint8Array;
  /** Flat boxes [minX, minY, minZ, maxX, maxY, maxZ] (building-local, scaled). */
  box: Float64Array;
  mass: Float64Array;
  /** Own weight (N). */
  weight: Float64Array;
  /** Capacities: axial (columns / bearing walls), bending (beams: N·m; slabs: N·m per m), shear (beams). */
  capN: Float64Array;
  capM: Float64Array;
  capV: Float64Array;
  /**
   * Spanning roof panels (Phase 31, R1): characteristic gravity capacity (N) — 0 for every other member and for
   * coverings lying on a slab (finish layers). Checked by the solver only while roof checks are on (StructuralSolver.roofCheck).
   */
  roofCap: Float64Array;
  /** Beam length axis (x, z) and length; slab extents along x / z. */
  axisX: Float32Array;
  axisZ: Float32Array;
  length: Float32Array;
  /** Material index (MATERIAL order) per member. */
  mat: Uint8Array;
  /** Edges (dependent → support), CSR by dependent. */
  eStart: Int32Array;
  /** Dependent (carried member) of each edge. */
  eFrom: Int32Array;
  eTo: Int32Array;
  eTier: Uint8Array;
  eKind: Uint8Array;
  /** Gravity-transfer capacity (N; Infinity = governed by the members). */
  eCap: Float64Array;
  /** Beams as dependents: support centre along the beam axis (m from beam centre). */
  ePos: Float32Array;
  /** Beams as supports: the dependent's interval along the beam axis [a0, a1] (m from beam centre). */
  eA0: Float32Array;
  eA1: Float32Array;
  /** Slabs as dependents: support centre offset from the slab centre (x, z). */
  eDX: Float32Array;
  eDZ: Float32Array;
  /** Reverse CSR (support → dependent edges). */
  rStart: Int32Array;
  rEdge: Int32Array;
  /** Topological rank (supports rank lower) and members sorted by rank. */
  rank: Int32Array;
  byRank: Int32Array;
  /** Plan grid (members overlapping each cell), CSR. */
  grid: { x0: number; z0: number; nx: number; nz: number; start: Int32Array; items: Int32Array };
  /** Lateral contribution of each member (Phase 17 analysis of the original world). */
  kx: Float64Array;
  kz: Float64Array;
  vx: Float64Array;
  vz: Float64Array;
  floors: number;
  /** Connections that transfer load (edges) — count. */
  edges: number;
}

const MATERIAL_INDEX = Object.keys(MATERIALS);

const cache = new WeakMap<BuildingDesign, Map<string, StructuralGraph>>();

/** Graph of a design at an object scale (cached; shared by every building using the design). */
export function graphOf(design: BuildingDesign, scale: Vec3 = [1, 1, 1]): StructuralGraph {
  const key = `${scale[0]}|${scale[1]}|${scale[2]}`;
  let m = cache.get(design);
  if (!m) cache.set(design, (m = new Map()));
  let g = m.get(key);
  if (!g) m.set(key, (g = buildGraph(design, scale)));
  return g;
}

interface Edge { to: number; tier: number; kind: number }

export function buildGraph(design: BuildingDesign, scale: Vec3 = [1, 1, 1]): StructuralGraph {
  const unscaled = scale[0] === 1 && scale[1] === 1 && scale[2] === 1;
  const A = unscaled ? analysisOf(design) : analyzeBuilding(design, { scale });
  const src = design.members;
  const n = src.length;
  const floors = Math.max(1, design.spec.floors);
  const type = new Uint8Array(n), level = new Int16Array(n), structural = new Uint8Array(n), lateral = new Uint8Array(n);
  const ground = new Uint8Array(n), soilFallback = new Uint8Array(n), absent = new Uint8Array(n), matIdx = new Uint8Array(n);
  const box = new Float64Array(6 * n), mass = new Float64Array(n), weight = new Float64Array(n);
  const capN = new Float64Array(n), capM = new Float64Array(n), capV = new Float64Array(n);
  const axisX = new Float32Array(n), axisZ = new Float32Array(n), length = new Float32Array(n);
  const kx = new Float64Array(n), kz = new Float64Array(n), vx = new Float64Array(n), vz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = src[i], a = A.members[i], mat = material(m.material);
    type[i] = MT[m.type];
    level[i] = m.level;
    structural[i] = isStructuralRole(m.role) && mat.structural ? 1 : 0;
    lateral[i] = isLateralRole(m.role) && mat.structural && (m.type === 'column' || m.type === 'wall') ? 1 : 0;
    absent[i] = (m.initialDamage ?? 0) >= 0.999 ? 1 : 0;
    matIdx[i] = Math.max(0, MATERIAL_INDEX.indexOf(m.material));
    for (let d = 0; d < 3; d++) { box[6 * i + d] = a.box.min[d]; box[6 * i + 3 + d] = a.box.max[d]; }
    mass[i] = a.mass;
    weight[i] = a.mass * GRAVITY;
    kx[i] = a.kx; kz[i] = a.kz; vx[i] = a.vx; vz[i] = a.vz;
    const [sx, sy, sz] = a.size;
    const ax = lengthAxis(m);
    axisX[i] = ax[0]; axisZ[i] = ax[1]; length[i] = sx;
    if (!structural[i]) continue;
    if (m.type === 'column') capN[i] = columnCapacity(mat, sx, sy, sz);
    else if (m.type === 'wall' && m.role === 'bearing') capN[i] = wallCapacity(mat, sx, sy, sz, a.openingRatio);
    else if (m.type === 'beam') { const c = beamCapacity(m.material, sx, sy, sz); capM[i] = c.M; capV[i] = c.V; }
    else if (m.type === 'slab') capM[i] = slabMomentPerM(mat, sy);
  }
  const B = (i: number, k: number) => box[6 * i + k];

  // ── Connectivity: touching (adj) and "stands on" (below) — the Phase 17 sweep, all members ──
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => B(p, 1) - B(q, 1) || p - q);
  const adj: number[][] = Array.from({ length: n }, () => []);
  const below: number[][] = Array.from({ length: n }, () => []);
  const active: number[] = [];
  for (const i of order) {
    const x0 = B(i, 0), y0 = B(i, 1), z0 = B(i, 2), x1 = B(i, 3), y1 = B(i, 4), z1 = B(i, 5);
    let w = 0;
    for (let q = 0; q < active.length; q++) { const j = active[q]; if (B(j, 4) + NEAR_GAP >= y0) active[w++] = j; }
    active.length = w;
    for (const j of active) {
      if (x0 - TOL > B(j, 3) || B(j, 0) - TOL > x1 || z0 - TOL > B(j, 5) || B(j, 2) - TOL > z1) continue;
      const jy0 = B(j, 1), jy1 = B(j, 4);
      if (y0 - TOL <= jy1 && jy0 - TOL <= y1) { adj[i].push(j); adj[j].push(i); }
      const planOk = Math.min(x1, B(j, 3)) - Math.max(x0, B(j, 0)) + 0.02 > 0 && Math.min(z1, B(j, 5)) - Math.max(z0, B(j, 2)) + 0.02 > 0;
      if (!planOk) continue;
      if (jy1 <= y0 + TOL && jy1 >= y0 - NEAR_GAP) below[i].push(j);
      else if (y1 <= jy0 + TOL && y1 >= jy0 - NEAR_GAP) below[j].push(i);
    }
    active.push(i);
  }
  // Phase 17 iterates adj in insertion order; keep the same order for "first touching wall".
  const byId = new Map(src.map((m, i) => [m.id, i]));

  // ── Support candidates per tier ──
  const groundY = 0.02 * scale[1];
  const edges: Edge[][] = Array.from({ length: n }, () => []);
  const isVert = (j: number) => type[j] === MT_COLUMN || type[j] === MT_WALL;
  for (let i = 0; i < n; i++) {
    const m = src[i];
    const t = type[i];
    if (t === MT_FOUNDATION || (t === MT_SLAB && B(i, 1) <= groundY && m.level < 0)) { ground[i] = 1; continue; }
    if (t === MT_WINDOW || t === MT_DOOR) {
      const h = m.host !== undefined ? byId.get(m.host) : undefined;
      if (h !== undefined && adj[i].includes(h)) edges[i].push({ to: h, tier: 0, kind: CK.HOSTED });
      for (const j of adj[i]) if (type[j] === MT_WALL && j !== h) edges[i].push({ to: j, tier: 1, kind: CK.HOSTED });
      continue;
    }
    const cand = adj[i].filter((j) => structural[j] && j !== i);
    const under = (gap: number, stack = false) => below[i].filter((j) => (structural[j] || (stack && type[j] === MT_WALL)) && B(j, 4) >= B(i, 1) - gap);
    if (t === MT_COLUMN || t === MT_WALL) {
      const u = under(BEARING_GAP, t === MT_WALL && m.role !== 'bearing');
      const nonBearing = t === MT_WALL && m.role !== 'bearing';
      for (const j of u) {
        if (isVert(j) || type[j] === MT_FOUNDATION) edges[i].push({ to: j, tier: 0, kind: type[j] === MT_FOUNDATION ? CK.BASE : nonBearing ? CK.ANCHOR : CK.SPLICE });
      }
      for (const j of u) if (!isVert(j) && type[j] !== MT_FOUNDATION) edges[i].push({ to: j, tier: 1, kind: CK.TRANSFER });
      if (nonBearing) for (const j of cand) if (type[j] === MT_COLUMN || type[j] === MT_BEAM) edges[i].push({ to: j, tier: 2, kind: CK.ANCHOR });
      if (B(i, 1) <= groundY) soilFallback[i] = 1;
      continue;
    }
    if (t === MT_BEAM) {
      for (const j of cand) {
        const tj = type[j];
        if ((tj === MT_COLUMN || tj === MT_WALL) && B(j, 1) < B(i, 1) + TOL) edges[i].push({ to: j, tier: 0, kind: CK.BEAM_SEAT });
        else if (tj === MT_BEAM && m.role === 'secondary' && src[j].role === 'primary' && B(j, 1) <= B(i, 1) + TOL && j !== i) edges[i].push({ to: j, tier: 0, kind: CK.BEAM_BEAM });
      }
      continue;
    }
    if (t === MT_SLAB) {
      for (const j of under(0.15)) if (type[j] !== MT_SLAB && slabBears(src[j], A.members[j], A.members[i])) edges[i].push({ to: j, tier: 0, kind: CK.SLAB });
      continue;
    }
    // Roof coverings.
    for (const j of under(NEAR_GAP)) edges[i].push({ to: j, tier: 0, kind: CK.ROOF });
    for (const j of cand) if (B(j, 1) < B(i, 1)) edges[i].push({ to: j, tier: 1, kind: CK.ROOF });
  }

  // ── Spanning roof panels (R1): pitched panels (on rafters / purlins) and flat coverings with no slab under them ──
  const roofCap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (type[i] !== MT_ROOF || absent[i] || !edges[i].length) continue;
    const r = src[i].rotation;
    const pitched = Math.abs(r[0]) > 1e-6 || Math.abs(r[2]) > 1e-6;
    let onSlab = false;
    for (const e of edges[i]) if (e.tier === 0 && type[e.to] === MT_SLAB) onSlab = true;
    if (!pitched && onSlab) continue;
    roofCap[i] = roofPanelCapacity(weight[i], (B(i, 3) - B(i, 0)) * (B(i, 5) - B(i, 2)));
  }

  // ── Topological rank: depth above the ground through candidate supports ──
  const depth = new Int32Array(n).fill(-1);
  const visiting = new Uint8Array(n);
  const depthOf = (i: number): number => {
    if (depth[i] >= 0) return depth[i];
    if (visiting[i]) return 0; // cycle guard (degenerate, thin overlapping members)
    visiting[i] = 1;
    let d = 0;
    for (const e of edges[i]) d = Math.max(d, depthOf(e.to) + 1);
    visiting[i] = 0;
    return (depth[i] = d);
  };
  for (let i = 0; i < n; i++) depthOf(i);
  // Edges that would point up or sideways in rank (cycle remnants) are dropped.
  const byRank = Int32Array.from({ length: n }, (_, i) => i).sort((p, q) => depth[p] - depth[q] || B(p, 1) - B(q, 1) || p - q);
  const rank = new Int32Array(n);
  byRank.forEach((i, r) => (rank[i] = r));
  for (let i = 0; i < n; i++) edges[i] = edges[i].filter((e) => rank[e.to] < rank[i]);

  // ── CSR + edge geometry / capacities ──
  const eStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) eStart[i + 1] = eStart[i] + edges[i].length;
  const E = eStart[n];
  const eFrom = new Int32Array(E);
  for (let i = 0; i < n; i++) for (let e = eStart[i]; e < eStart[i + 1]; e++) eFrom[e] = i;
  const eTo = new Int32Array(E), eTier = new Uint8Array(E), eKind = new Uint8Array(E), eCap = new Float64Array(E);
  const ePos = new Float32Array(E), eA0 = new Float32Array(E), eA1 = new Float32Array(E), eDX = new Float32Array(E), eDZ = new Float32Array(E);
  const cx = (i: number) => (B(i, 0) + B(i, 3)) / 2, cz = (i: number) => (B(i, 2) + B(i, 5)) / 2;
  const proj = (beam: number, x: number, z: number) => (x - cx(beam)) * axisX[beam] + (z - cz(beam)) * axisZ[beam];
  for (let i = 0; i < n; i++) {
    edges[i].forEach((ed, k) => {
      const e = eStart[i] + k, j = ed.to;
      eTo[e] = j; eTier[e] = ed.tier; eKind[e] = ed.kind;
      eCap[e] = Infinity;
      if (type[i] === MT_BEAM) ePos[e] = proj(i, cx(j), cz(j));
      if (type[i] === MT_SLAB) { eDX[e] = cx(j) - cx(i); eDZ[e] = cz(j) - cz(i); }
      if (type[j] === MT_BEAM) {
        // The dependent's footprint along the beam axis, clipped to the beam.
        let lo = Infinity, hi = -Infinity;
        for (const x of [B(i, 0), B(i, 3)]) for (const z of [B(i, 2), B(i, 5)]) { const p = proj(j, x, z); lo = Math.min(lo, p); hi = Math.max(hi, p); }
        const L = length[j] / 2;
        eA0[e] = Math.max(-L, Math.min(L, lo));
        eA1[e] = Math.max(-L, Math.min(L, hi));
      }
      // Gravity-transfer capacities (capacity.ts).
      const mi = src[i];
      if (ed.kind === CK.BEAM_SEAT || ed.kind === CK.BEAM_BEAM) {
        const s = A.members[i].size;
        eCap[e] = beamSeatCapacity(mi.material, s[0], s[1], s[2]);
      } else if (ed.kind === CK.TRANSFER && type[j] === MT_SLAB) {
        // A column / wall standing on a slab: punching shear around its footprint (perimeter at d/2 ≈ t/2 out).
        const t = A.members[j].size[1];
        const fx = B(i, 3) - B(i, 0), fz = B(i, 5) - B(i, 2);
        eCap[e] = slabEdgeCapacity(src[j].material, t, 2 * (fx + fz) + 4 * t);
      } else if (ed.kind === CK.SLAB) {
        const ox = Math.max(0, Math.min(B(i, 3), B(j, 3)) - Math.max(B(i, 0), B(j, 0)));
        const oz = Math.max(0, Math.min(B(i, 5), B(j, 5)) - Math.max(B(i, 2), B(j, 2)));
        const contact = type[j] === MT_COLUMN ? 2 * (ox + oz) : Math.max(ox, oz);
        eCap[e] = slabEdgeCapacity(mi.material, A.members[i].size[1], Math.max(0.1, contact));
      }
    });
  }
  const rCount = new Int32Array(n + 1);
  for (let e = 0; e < E; e++) rCount[eTo[e] + 1]++;
  for (let j = 0; j < n; j++) rCount[j + 1] += rCount[j];
  const rStart = rCount.slice();
  const fill = rCount.slice(0, n);
  const rEdge = new Int32Array(E);
  for (let e = 0; e < E; e++) rEdge[fill[eTo[e]]++] = e;

  // ── Plan grid ──
  let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
  for (let i = 0; i < n; i++) { gx0 = Math.min(gx0, B(i, 0)); gz0 = Math.min(gz0, B(i, 2)); gx1 = Math.max(gx1, B(i, 3)); gz1 = Math.max(gz1, B(i, 5)); }
  if (!Number.isFinite(gx0)) { gx0 = gz0 = 0; gx1 = gz1 = 1; }
  const gnx = Math.max(1, Math.ceil((gx1 - gx0) / CELL)), gnz = Math.max(1, Math.ceil((gz1 - gz0) / CELL));
  const cells: number[][] = Array.from({ length: gnx * gnz }, () => []);
  for (let i = 0; i < n; i++) {
    const ix0 = Math.max(0, Math.floor((B(i, 0) - gx0) / CELL)), ix1 = Math.min(gnx - 1, Math.floor((B(i, 3) - gx0 - 1e-9) / CELL));
    const iz0 = Math.max(0, Math.floor((B(i, 2) - gz0) / CELL)), iz1 = Math.min(gnz - 1, Math.floor((B(i, 5) - gz0 - 1e-9) / CELL));
    for (let iz = iz0; iz <= Math.max(iz0, iz1); iz++) for (let ix = ix0; ix <= Math.max(ix0, ix1); ix++) cells[iz * gnx + ix].push(i);
  }
  const gStart = new Int32Array(cells.length + 1);
  cells.forEach((c, k) => (gStart[k + 1] = gStart[k] + c.length));
  const gItems = new Int32Array(gStart[cells.length]);
  cells.forEach((c, k) => gItems.set(c, gStart[k]));

  return {
    design, scale: [...scale] as Vec3, n, analysis: A, type, level, structural, lateral, ground, soilFallback, absent, box, mass, weight,
    capN, capM, capV, roofCap, axisX, axisZ, length, mat: matIdx, eStart, eFrom, eTo, eTier, eKind, eCap, ePos, eA0, eA1, eDX, eDZ, rStart, rEdge, rank, byRank,
    grid: { x0: gx0, z0: gz0, nx: gnx, nz: gnz, start: gStart, items: gItems }, kx, kz, vx, vz, floors, edges: E,
  };
}

/** Material properties of a member of the graph. */
export function memberMaterial(g: StructuralGraph, i: number) {
  return MATERIALS[MATERIAL_INDEX[g.mat[i]] as keyof typeof MATERIALS];
}

/** Dedup stamps for membersInRect (per graph, no allocation per query). */
const stamps = new WeakMap<StructuralGraph, { mark: Int32Array; stamp: number }>();

/** Members whose plan box overlaps a local rectangle (deduplicated; order: grid cells, then index). */
export function membersInRect(g: StructuralGraph, x0: number, z0: number, x1: number, z1: number, out: number[] = []): number[] {
  out.length = 0;
  let st = stamps.get(g);
  if (!st) stamps.set(g, (st = { mark: new Int32Array(g.n), stamp: 0 }));
  const stamp = ++st.stamp;
  const G = g.grid;
  const ix0 = Math.max(0, Math.floor((x0 - G.x0) / CELL)), ix1 = Math.min(G.nx - 1, Math.floor((x1 - G.x0) / CELL));
  const iz0 = Math.max(0, Math.floor((z0 - G.z0) / CELL)), iz1 = Math.min(G.nz - 1, Math.floor((z1 - G.z0) / CELL));
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
    const k = iz * G.nx + ix;
    for (let q = G.start[k]; q < G.start[k + 1]; q++) {
      const i = G.items[q];
      if (st.mark[i] === stamp) continue;
      st.mark[i] = stamp;
      const b = 6 * i;
      if (g.box[b] > x1 || g.box[b + 3] < x0 || g.box[b + 2] > z1 || g.box[b + 5] < z0) continue;
      out.push(i);
    }
  }
  return out;
}
