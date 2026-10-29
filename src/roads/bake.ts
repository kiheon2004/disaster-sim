/**
 * Road ↔ terrain (Phase 18). Roads are BAKED into the terrain layers — heights (graded / fixed
 * roads, sidewalks with their curb) and ground type (road / sidewalk material) — so the Rapier
 * heightfield, the water bed, the renderer, placement and contact friction all see the same
 * road. The natural values under road-covered vertices are kept in `network.underlay` and come
 * back when a road moves away or is deleted.
 *
 * Elevation policies (road surface height along the centerline, s = arc length):
 *  - follow: the natural ground (no height change; only the surface material)
 *  - graded: natural centerline smoothed over GRADE_WINDOW, corrected linearly to the node
 *            elevations; the cross-section is level; the terrain beside it blends back to the
 *            natural ground on a 1:2 cut / fill slope (≤ MAX_BLEND m wide)
 *  - fixed:  linear between the node elevations (node.y, or natural when not set) — embankment
 *            / cut where the ground differs. No bridges or tunnels: large differences are earth.
 * Heights are quantized to 1 cm like every terrain height (exact save / load).
 */
import type { TerrainData } from '@/core/model';
import { HEIGHT_QUANTUM, type GridRect } from '@/terrain/TerrainData';
import { nearest, pointAt, type Centerline } from './curve';
import { ROAD_MATERIAL_PROPS, SIDEWALK_GROUND } from './materials';
import { intersectionsOf, type Intersection } from './intersections';
import { segmentLine } from './network';
import type { RoadNetwork, RoadNode, RoadSegment } from './types';

export const GRADE_WINDOW = 16;
export const MAX_BLEND = 8;
/** Extra half width so a carriageway edge between two vertices still claims them (m). */
const EDGE_MARGIN = 0.35;

/** Natural terrain (underlay where a road covers it). */
export interface Natural {
  height(i: number): number;
  ground(i: number): number;
}

const underlayMaps = new WeakMap<RoadNetwork['underlay'], { hu: Map<number, number>; gu: Map<number, number> }>();

export function naturalOf(t: TerrainData, n: RoadNetwork): Natural {
  // Underlays are immutable values: their lookup maps are built once per underlay object.
  let maps = underlayMaps.get(n.underlay);
  if (!maps) {
    maps = { hu: new Map(), gu: new Map() };
    const { hu: h, gu: g } = maps;
    n.underlay.idx.forEach((v, k) => { h.set(v, n.underlay.h[k]); g.set(v, n.underlay.g[k]); });
    underlayMaps.set(n.underlay, maps);
  }
  const { hu, gu } = maps;
  return {
    height: (i) => hu.get(i) ?? t.heights[i],
    ground: (i) => gu.get(i) ?? t.ground[i],
  };
}

/** Bilinear natural height at (x, z) (same triangulation as the sampler is not needed for profiles). */
function naturalAt(t: TerrainData, nat: Natural, x: number, z: number): number {
  const fx = Math.min(t.nx - 1.000001, Math.max(0, (x - t.originX) / t.cellSize));
  const fz = Math.min(t.nz - 1.000001, Math.max(0, (z - t.originZ) / t.cellSize));
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ax = fx - ix, az = fz - iz;
  const i = iz * t.nx + ix;
  const h00 = nat.height(i), h10 = nat.height(i + 1), h01 = nat.height(i + t.nx), h11 = nat.height(i + t.nx + 1);
  return (h00 * (1 - ax) + h10 * ax) * (1 - az) + (h01 * (1 - ax) + h11 * ax) * az;
}

/** Road surface elevation at a node (fixed value, or the natural ground). */
export function nodeElevation(t: TerrainData, nat: Natural, node: RoadNode): number {
  return node.y ?? naturalAt(t, nat, node.x, node.z);
}

/** Surface elevation profile of a segment at its centerline samples (null = follow terrain). */
export function segmentProfile(t: TerrainData, nat: Natural, n: RoadNetwork, s: RoadSegment, line: Centerline = segmentLine(n, s)): Float64Array | null {
  const pol = s.profile.elevation;
  const anyFixed = n.nodes[s.a].y !== null || n.nodes[s.b].y !== null;
  if (pol === 'follow' && !anyFixed) return null;
  const S = line.samples;
  const hA = nodeElevation(t, nat, n.nodes[s.a]);
  const hB = nodeElevation(t, nat, n.nodes[s.b]);
  const out = new Float64Array(S.length);
  if (pol === 'fixed' || (pol === 'follow' && anyFixed)) {
    for (let i = 0; i < S.length; i++) out[i] = hA + (hB - hA) * (S[i].s / Math.max(1e-9, line.length));
    return out;
  }
  // Graded: moving average of the natural centerline, then a linear correction to the nodes.
  const raw = S.map((p) => naturalAt(t, nat, p.x, p.z));
  const half = Math.max(1, Math.round(GRADE_WINDOW / 2));
  for (let i = 0; i < S.length; i++) {
    let sum = 0, k = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(S.length - 1, i + half); j++) { sum += raw[j]; k++; }
    out[i] = sum / k;
  }
  const e0 = hA - out[0], e1 = hB - out[S.length - 1];
  for (let i = 0; i < S.length; i++) {
    const w = S[i].s / Math.max(1e-9, line.length);
    out[i] += e0 * (1 - w) + e1 * w;
  }
  return out;
}

/** Height of a profile at arc length s (linear between samples). */
export function profileAt(line: Centerline, prof: Float64Array, s: number): number {
  const S = line.samples;
  if (s <= 0) return prof[0];
  if (s >= line.length) return prof[prof.length - 1];
  const f = (s / line.length) * (S.length - 1);
  const i = Math.min(S.length - 2, Math.floor(f));
  // Samples are uniform in arc length (resample), so the index is proportional to s.
  return prof[i] + (prof[i + 1] - prof[i]) * (f - i);
}

/**
 * Longitudinal grade (max |dh/ds|), cross slope (follow roads: of the natural ground, max over the
 * segment; graded / fixed roads: the design crown cross-fall) and max cut / fill of a segment.
 */
export function segmentSlopes(t: TerrainData, nat: Natural, n: RoadNetwork, s: RoadSegment): { grade: number; crossSlope: number; cutFill: number } {
  const line = segmentLine(n, s);
  const prof = segmentProfile(t, nat, n, s, line);
  const S = line.samples;
  let grade = 0, cross = 0, cutFill = 0;
  for (let i = 0; i < S.length; i++) {
    const p = S[i];
    const h = prof ? prof[i] : naturalAt(t, nat, p.x, p.z);
    if (i > 0) {
      const q = S[i - 1];
      const hq = prof ? prof[i - 1] : naturalAt(t, nat, q.x, q.z);
      grade = Math.max(grade, Math.abs(h - hq) / Math.max(1e-6, p.s - q.s));
    }
    const w = s.profile.width / 2;
    const l = naturalAt(t, nat, p.x - p.tz * w, p.z + p.tx * w);
    const r = naturalAt(t, nat, p.x + p.tz * w, p.z - p.tx * w);
    if (!prof) cross = Math.max(cross, Math.abs(l - r) / (2 * w));
    if (prof) cutFill = Math.max(cutFill, Math.abs(h - naturalAt(t, nat, p.x, p.z)));
  }
  return { grade, crossSlope: prof ? ROAD_MATERIAL_PROPS[s.profile.material].crossFall : cross, cutFill };
}

/** What a road claims at a vertex. */
interface Claim {
  /** 0 = carriageway / intersection, 1 = sidewalk, 2 = cut/fill blend. */
  rank: number;
  dist: number;
  /** Target height (NaN = keep natural) and ground (-1 = keep natural). */
  h: number;
  g: number;
}

/** Vertex grid rectangle covering a world-space box. */
function rectOf(t: TerrainData, x0: number, z0: number, x1: number, z1: number): GridRect | null {
  const ix0 = Math.max(0, Math.floor((x0 - t.originX) / t.cellSize));
  const iz0 = Math.max(0, Math.floor((z0 - t.originZ) / t.cellSize));
  const ix1 = Math.min(t.nx - 1, Math.ceil((x1 - t.originX) / t.cellSize));
  const iz1 = Math.min(t.nz - 1, Math.ceil((z1 - t.originZ) / t.cellSize));
  return ix0 > ix1 || iz0 > iz1 ? null : { x0: ix0, z0: iz0, x1: ix1, z1: iz1 };
}

/** Outer reach of a segment's influence (m): sidewalks + cut / fill blend. */
export function reach(s: RoadSegment): number {
  const side = s.profile.sidewalk === 'none' ? 0 : s.profile.sidewalkWidth;
  // (A follow road with fixed node elevations is graded too: the blend is always included.)
  return s.profile.width / 2 + side + MAX_BLEND + 1;
}

/** World-space bounding box of a segment's influence. */
export function segmentBounds(n: RoadNetwork, s: RoadSegment): [number, number, number, number] {
  const line = segmentLine(n, s);
  const r = reach(s);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of line.samples) {
    x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z);
  }
  return [x0 - r, z0 - r, x1 + r, z1 + r];
}

/**
 * Claims of the network on the vertices of `rect` (only segments / intersections whose reach
 * overlaps it are evaluated). Deterministic: segments in id order, ties by rank then distance.
 */
export function claims(t: TerrainData, nat: Natural, n: RoadNetwork, rect: GridRect): Map<number, Claim> {
  const out = new Map<number, Claim>();
  const put = (i: number, c: Claim) => {
    const cur = out.get(i);
    if (!cur || c.rank < cur.rank || (c.rank === cur.rank && c.dist < cur.dist)) out.set(i, c);
  };
  const segs = Object.values(n.segments).sort((a, b) => (a.id < b.id ? -1 : 1));
  const ints = intersectionsOf(n);
  for (const s of segs) {
    const [bx0, bz0, bx1, bz1] = segmentBounds(n, s);
    const bx = rectOf(t, bx0, bz0, bx1, bz1);
    if (!bx || bx.x1 < rect.x0 || bx.x0 > rect.x1 || bx.z1 < rect.z0 || bx.z0 > rect.z1) continue;
    const line = segmentLine(n, s);
    const prof = segmentProfile(t, nat, n, s, line);
    const p = s.profile;
    const w = p.width / 2 + EDGE_MARGIN;
    const swL = p.sidewalk === 'both' || p.sidewalk === 'left' ? p.sidewalkWidth : 0;
    const swR = p.sidewalk === 'both' || p.sidewalk === 'right' ? p.sidewalkWidth : 0;
    const blend = p.elevation === 'follow' && !prof ? 0 : MAX_BLEND;
    const R = p.width / 2 + Math.max(swL, swR) + blend + 1;
    const g = ROAD_MATERIAL_PROPS[p.material].ground;
    const fall = ROAD_MATERIAL_PROPS[p.material].crossFall;
    const trimA = ints.get(s.a)?.trim.get(s.id) ?? 0;
    const trimB = ints.get(s.b)?.trim.get(s.id) ?? 0;
    // Every vertex of the segment's reach box inside the rectangle, once.
    const r0 = rectOf(t, bx0, bz0, bx1, bz1)!;
    const zA = Math.max(r0.z0, rect.z0), zB = Math.min(r0.z1, rect.z1);
    const xA = Math.max(r0.x0, rect.x0), xB = Math.min(r0.x1, rect.x1);
    for (let iz = zA; iz <= zB; iz++) {
      for (let ix = xA; ix <= xB; ix++) {
        const i = iz * t.nx + ix;
        const x = t.originX + ix * t.cellSize;
        const z = t.originZ + iz * t.cellSize;
        const hit = nearest(line, x, z);
        if (hit.dist > R) continue;
        // Beyond the trimmed ends: the intersection polygon decides (or nothing at free ends).
        const atEndA = hit.s <= 1e-6, atEndB = hit.s >= line.length - 1e-6;
        if ((atEndA && endBeyond(line, 0, x, z)) || (atEndB && endBeyond(line, line.length, x, z))) continue;
        if (hit.s < trimA - 0.5 || hit.s > line.length - trimB + 0.5) continue;
        const hc = prof ? profileAt(line, prof, hit.s) : NaN;
        const side = hit.side > 0 ? swR : swL;
        // Crown: the carriageway falls from the centerline to the curbs (graded / fixed roads).
        const gutter = hc - fall * (p.width / 2);
        if (hit.dist <= w) put(i, { rank: 0, dist: hit.dist, h: hc - fall * Math.min(hit.dist, p.width / 2), g });
        // Sidewalks stand a curb above the gutter (follow roads: above the natural ground).
        else if (hit.dist <= p.width / 2 + side + EDGE_MARGIN && side > 0) put(i, { rank: 1, dist: hit.dist, h: (Number.isNaN(hc) ? nat.height(i) : gutter) + p.curbHeight, g: SIDEWALK_GROUND });
        else if (blend > 0 && !Number.isNaN(hc)) {
          const edge = p.width / 2 + side;
          const edgeH = gutter + (side > 0 ? p.curbHeight : 0);
          const natH = nat.height(i);
          const bw = Math.min(MAX_BLEND, Math.max(1, 2 * Math.abs(edgeH - natH)));
          const d = hit.dist - edge;
          if (d > 0 && d <= bw) {
            const w2 = d / bw;
            put(i, { rank: 2, dist: hit.dist, h: edgeH * (1 - w2) + natH * w2, g: -1 });
          }
        }
      }
    }
  }
  // Intersections: carriageway polygon at the node elevation, sidewalk corners raised.
  for (const ix of ints.values()) claimIntersection(t, nat, n, ix, rect, put);
  return out;
}

/** True when (x, z) lies beyond the free end of the centerline at arc length s (cap). */
function endBeyond(line: Centerline, s: number, x: number, z: number): boolean {
  const p = pointAt(line, s);
  const dir = s <= 0 ? -1 : 1;
  return ((x - p.x) * p.tx + (z - p.z) * p.tz) * dir > 0.01;
}

function pointInPoly(poly: readonly [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function claimIntersection(t: TerrainData, nat: Natural, n: RoadNetwork, ix: Intersection, rect: GridRect, put: (i: number, c: Claim) => void) {
  const node = n.nodes[ix.node];
  const graded = ix.roads.some((r) => r.segment.profile.elevation !== 'follow') || node.y !== null;
  const h = graded ? Math.round(nodeElevation(t, nat, node) / HEIGHT_QUANTUM) * HEIGHT_QUANTUM : NaN;
  const g = ROAD_MATERIAL_PROPS[ix.material].ground;
  const all = [ix.surface, ...ix.corners.map((c) => c.poly)];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const poly of all) for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const r = rectOf(t, x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5);
  if (!r) return;
  for (let iz = Math.max(r.z0, rect.z0); iz <= Math.min(r.z1, rect.z1); iz++) {
    for (let jx = Math.max(r.x0, rect.x0); jx <= Math.min(r.x1, rect.x1); jx++) {
      const x = t.originX + jx * t.cellSize;
      const z = t.originZ + iz * t.cellSize;
      const i = iz * t.nx + jx;
      if (pointInPoly(ix.surface, x, z)) put(i, { rank: 0, dist: Math.hypot(x - node.x, z - node.z), h, g });
      else for (const c of ix.corners) {
        if (pointInPoly(c.poly, x, z)) {
          put(i, { rank: 1, dist: 0, h: (Number.isNaN(h) ? nat.height(i) : h) + c.curb, g: SIDEWALK_GROUND });
          break;
        }
      }
    }
  }
}

export interface BakeResult {
  /** Changed rectangle (vertex grid) or null when nothing changed. */
  rect: GridRect | null;
  underlay: RoadNetwork['underlay'];
}

/**
 * Rewrite the terrain layers inside `rect` for network `next` (in place): claimed vertices get
 * the road values, the rest gets its natural value back; the underlay keeps the natural values
 * of claimed vertices. `prev` is the network whose underlay describes the current terrain.
 */
export function bakeRegion(t: TerrainData, prev: RoadNetwork, next: RoadNetwork, rect: GridRect, natural?: Natural): BakeResult {
  // Phase 19: the natural terrain comes from the landscape layers when given; otherwise from
  // the previous underlay (Phase 18 behaviour — identical while the two agree).
  const nat = natural ?? naturalOf(t, prev);
  const cl = claims(t, nat, next, rect);
  // New underlay entries inside the rectangle, generated in increasing vertex order.
  const inIdx: number[] = [], inH: number[] = [], inG: number[] = [];
  let changed: GridRect | null = null;
  const touch = (ix: number, iz: number) => {
    changed = changed ? { x0: Math.min(changed.x0, ix), z0: Math.min(changed.z0, iz), x1: Math.max(changed.x1, ix), z1: Math.max(changed.z1, iz) } : { x0: ix, z0: iz, x1: ix, z1: iz };
  };
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const i = iz * t.nx + ix;
      const nh = nat.height(i), ng = nat.ground(i);
      const c = cl.get(i);
      let h = nh, g = ng;
      if (c) {
        // Stored as float32: compare in the storage precision so a re-bake is a no-op.
        if (!Number.isNaN(c.h)) h = Math.fround(Math.round(c.h / HEIGHT_QUANTUM) * HEIGHT_QUANTUM) + 0; // (+ 0: no −0)
        if (c.g >= 0) g = c.g;
      }
      if (c && (h !== nh || g !== ng)) {
        inIdx.push(i);
        inH.push(nh);
        inG.push(ng);
      }
      if (t.heights[i] !== h || t.ground[i] !== g) {
        t.heights[i] = h;
        t.ground[i] = g;
        touch(ix, iz);
      }
    }
  }
  if (changed) t.revision++;
  // Merge: previous entries outside the rectangle (sorted) + the new ones inside (sorted).
  const u = prev.underlay;
  const inside = (i: number) => {
    const ix = i % t.nx, iz = (i - ix) / t.nx;
    return ix >= rect.x0 && ix <= rect.x1 && iz >= rect.z0 && iz <= rect.z1;
  };
  const idx: number[] = [], hs: number[] = [], gs: number[] = [];
  let k = 0;
  for (let j = 0; j < u.idx.length; j++) {
    const i = u.idx[j];
    if (inside(i)) continue;
    while (k < inIdx.length && inIdx[k] < i) { idx.push(inIdx[k]); hs.push(inH[k]); gs.push(inG[k]); k++; }
    idx.push(i); hs.push(u.h[j]); gs.push(u.g[j]);
  }
  for (; k < inIdx.length; k++) { idx.push(inIdx[k]); hs.push(inH[k]); gs.push(inG[k]); }
  return { rect: changed, underlay: { idx, h: hs, g: gs } };
}

/**
 * Vertex rectangle covering everything a change a → b can touch: the segments that differ or
 * end at a moved node (whole reach, both versions), plus the junction areas at their end nodes
 * (intersection polygons + the trimmed ends of the neighbouring roads, both versions). Only one
 * ring of neighbours: a neighbour's graded profile depends on its own nodes, which did not move.
 */
export function dirtyRect(t: TerrainData, a: RoadNetwork, b: RoadNetwork): GridRect | null {
  const boxes: [number, number, number, number][] = [];
  const moved = new Set<string>();
  for (const id of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
    const p = a.nodes[id], q = b.nodes[id];
    if (!p || !q || p.x !== q.x || p.z !== q.z || p.y !== q.y) moved.add(id);
  }
  const junctions = new Set<string>();
  const consider = (n: RoadNetwork, other: RoadNetwork) => {
    for (const s of Object.values(n.segments)) {
      if (other.segments[s.id] === s && !moved.has(s.a) && !moved.has(s.b)) continue;
      boxes.push(segmentBounds(n, s));
      junctions.add(s.a);
      junctions.add(s.b);
    }
  };
  consider(a, b);
  consider(b, a);
  for (const n of [a, b]) {
    const ints = intersectionsOf(n);
    for (const id of junctions) {
      const ix = ints.get(id);
      if (!ix) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, r = 0;
      for (const poly of [ix.surface, ...ix.corners.map((c) => c.poly)]) for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
      for (const road of ix.roads) r = Math.max(r, reach(road.segment));
      if (Number.isFinite(x0)) boxes.push([x0 - r, z0 - r, x1 + r, z1 + r]);
    }
  }
  if (!boxes.length) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const bb of boxes) { x0 = Math.min(x0, bb[0]); z0 = Math.min(z0, bb[1]); x1 = Math.max(x1, bb[2]); z1 = Math.max(z1, bb[3]); }
  return rectOf(t, x0, z0, x1, z1);
}
