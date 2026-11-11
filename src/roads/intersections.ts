/**
 * Intersections (Phase 18), derived from the network: every node where ≥ 3 segments meet
 * (T, 4-way, multi-road) and every bend node where two segments meet at an angle.
 *
 * Roads leaving a node are sorted by angle. For each neighbouring pair the facing edges
 * (carriageway, and outer sidewalk edges) are intersected; the roads are trimmed back so their
 * ends clear those corners; the carriageway surface is the polygon of the trimmed end caps
 * and the corner points, the sidewalk corners are the bands between the carriageway and the
 * outer corners. Crosswalks sit just outside each trimmed end of a real junction.
 * Problems (very acute angles, trims longer than a road) are reported, never "fixed" by
 * moving or deleting roads.
 */
import { nodeDirections, segmentLine } from './network';
import type { RoadMaterial, RoadNetwork, RoadSegment } from './types';
import { ROAD_MATERIAL_PROPS } from './materials';

type P2 = [number, number];

export interface IntersectionRoad {
  segment: RoadSegment;
  atStart: boolean;
  dx: number;
  dz: number;
  angle: number;
  trim: number;
  /** Carriageway half width and outer (incl. sidewalk) half widths on the -r / +r sides. */
  w: number;
  outerMinus: number;
  outerPlus: number;
  /** A sidewalk corner continues this road's sidewalk on the -r / +r side (else the sidewalk ends at the trim). */
  cornerMinus: boolean;
  cornerPlus: boolean;
}

export interface Crosswalk {
  /** Center, direction along the road, stripe set width (across) and depth (along). */
  x: number;
  z: number;
  dx: number;
  dz: number;
  width: number;
  depth: number;
}

export interface Intersection {
  node: string;
  roads: IntersectionRoad[];
  trim: Map<string, number>;
  /** Carriageway polygon (counter-clockwise in angle order). */
  surface: P2[];
  /** Sidewalk corner polygons with their curb height and curb line (the edge facing the carriageway, mesh curb faces). */
  corners: { poly: P2[]; curb: number; curbLine: P2[] }[];
  material: RoadMaterial;
  crosswalks: Crosswalk[];
  /** A real junction (≥ 3 roads) rather than a bend. */
  junction: boolean;
  warnings: ('acute' | 'trimTooLong')[];
}

const cache = new WeakMap<RoadNetwork, Map<string, Intersection>>();

/** Intersections of a network (cached per network object). */
export function intersectionsOf(n: RoadNetwork): Map<string, Intersection> {
  let m = cache.get(n);
  if (m) return m;
  m = new Map();
  for (const id of Object.keys(n.nodes).sort()) {
    const ix = buildIntersection(n, id);
    if (ix) m.set(id, ix);
  }
  cache.set(n, m);
  return m;
}

/**
 * Phase 36: below this turn (rad) a straight joint stays a plain butt joint — its wedge is narrower than 1 cm, and roads
 * that continue exactly straight (split roads, the default world) keep their geometry bit for bit.
 */
export const MITRE_MIN_TURN = 1e-3;

const mitreCache = new WeakMap<RoadNetwork, Map<string, { tx: number; tz: number }>>();

/**
 * Mitre joins (Phase 36): two roads meeting almost straight (a turn too small for a bend patch, < ~9.9°) both end on the
 * bisector line through the node instead of each on its own perpendicular end plane, so the outer side has no wedge
 * gap and the inner side no overlapping (z-fighting) surfaces — in the mesh and in the bake. Value per node: the unit
 * through-direction T; the mitre line is perpendicular to it. Cached per network object.
 */
export function mitresOf(n: RoadNetwork): Map<string, { tx: number; tz: number }> {
  let m = mitreCache.get(n);
  if (m) return m;
  m = new Map();
  const ints = intersectionsOf(n);
  for (const id of Object.keys(n.nodes).sort()) {
    if (ints.has(id)) continue;
    const d = nodeDirections(n, id);
    if (d.length !== 2 || d[0].segment === d[1].segment) continue;
    // Turn = angle between road 1 leaving the node and road 0 arriving at it (−d0).
    const turn = Math.atan2(Math.abs(d[0].dx * d[1].dz - d[0].dz * d[1].dx), -(d[0].dx * d[1].dx + d[0].dz * d[1].dz));
    if (turn < MITRE_MIN_TURN) continue;
    const tx = d[1].dx - d[0].dx, tz = d[1].dz - d[0].dz, l = Math.hypot(tx, tz);
    m.set(id, { tx: tx / l, tz: tz / l });
  }
  mitreCache.set(n, m);
  return m;
}

/**
 * Lateral axis of a segment's mitred end: the cross-section point at lateral o is end + o·(rx, rz), on the mitre line.
 * (r, t) = the right normal and tangent of the segment at that end; T = the node's mitre; k = slide per metre of lateral.
 * Both roads map lateral o to the same point (r'·r = 1 for each), so their sections meet exactly.
 */
export function mitreAxis(rx: number, rz: number, tx: number, tz: number, T: { tx: number; tz: number }): { rx: number; rz: number; k: number } {
  // Slide along the tangent until the point lies on the line ⟂ T: (r + k·t)·T = 0.
  const k = -(rx * T.tx + rz * T.tz) / (tx * T.tx + tz * T.tz);
  return { rx: rx + k * tx, rz: rz + k * tz, k };
}

function sideHasWalk(s: RoadSegment, side: 'left' | 'right') {
  return s.profile.sidewalk === 'both' || s.profile.sidewalk === side;
}

/** Intersection of P + d·t and Q + e·u → [t, u] (null when parallel). */
function lineHit(px: number, pz: number, dx: number, dz: number, qx: number, qz: number, ex: number, ez: number): [number, number] | null {
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((qx - px) * ez - (qz - pz) * ex) / den;
  const u = ((qx - px) * dz - (qz - pz) * dx) / den;
  return [t, u];
}

function buildIntersection(n: RoadNetwork, nodeId: string): Intersection | null {
  const dirs = nodeDirections(n, nodeId).sort((a, b) => a.angle - b.angle || (a.segment.id < b.segment.id ? -1 : 1));
  if (dirs.length < 2) return null;
  const node = n.nodes[nodeId];
  const O: P2 = [node.x, node.z];
  if (dirs.length === 2) {
    // A bend: nothing to fill when the two roads continue (almost) straight.
    const dot = dirs[0].dx * dirs[1].dx + dirs[0].dz * dirs[1].dz;
    if (dot < -0.985) return null;
  }
  const roads: IntersectionRoad[] = dirs.map((d) => {
    const p = d.segment.profile;
    // +r = side toward increasing angle = the travel-right side when the road starts here.
    const plusSide = d.atStart ? 'right' : 'left';
    const minusSide = d.atStart ? 'left' : 'right';
    return {
      segment: d.segment, atStart: d.atStart, dx: d.dx, dz: d.dz, angle: d.angle, trim: 0, cornerMinus: false, cornerPlus: false,
      w: p.width / 2,
      outerPlus: p.width / 2 + (sideHasWalk(d.segment, plusSide) ? p.sidewalkWidth : 0),
      outerMinus: p.width / 2 + (sideHasWalk(d.segment, minusSide) ? p.sidewalkWidth : 0),
    };
  });
  const K = roads.length;
  const warnings: Intersection['warnings'] = [];
  const cornerC: (P2 | null)[] = [];
  const cornerO: (P2 | null)[] = [];
  for (let k = 0; k < K; k++) {
    const a = roads[k], b = roads[(k + 1) % K];
    const gap = ((b.angle - a.angle + 2 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI;
    if (gap < (20 * Math.PI) / 180) warnings.push('acute');
    const ra: P2 = [-a.dz, a.dx], rb: P2 = [-b.dz, b.dx];
    const corner = (wa: number, wb: number): P2 | null => {
      if (gap >= Math.PI - 1e-3) return null; // facing edges diverge: no corner in front
      const hit = lineHit(O[0] + ra[0] * wa, O[1] + ra[1] * wa, a.dx, a.dz, O[0] - rb[0] * wb, O[1] - rb[1] * wb, b.dx, b.dz);
      if (!hit || hit[0] < 0 || hit[1] < 0) return null;
      a.trim = Math.max(a.trim, hit[0]);
      b.trim = Math.max(b.trim, hit[1]);
      return [O[0] + ra[0] * wa + a.dx * hit[0], O[1] + ra[1] * wa + a.dz * hit[0]];
    };
    cornerC.push(corner(a.w, b.w));
    cornerO.push(corner(a.outerPlus, b.outerMinus));
  }
  const junction = K >= 3;
  // Clearance beyond the corners (crosswalk room at junctions), limited by the road length.
  for (const r of roads) {
    r.trim += junction ? 1 : 0.25;
    const L = segmentLine(n, r.segment).length;
    const max = L / 2 - 0.5;
    if (r.trim > max) {
      warnings.push('trimTooLong');
      r.trim = Math.max(0, max);
    }
  }
  const cap = (r: IntersectionRoad, w: number): P2 => [O[0] + r.dx * r.trim - r.dz * w, O[1] + r.dz * r.trim + r.dx * w];
  const surface: P2[] = [];
  const corners: Intersection['corners'] = [];
  for (let k = 0; k < K; k++) {
    const a = roads[k], b = roads[(k + 1) % K];
    surface.push(cap(a, -a.w), cap(a, a.w));
    const c = cornerC[k];
    if (c) surface.push(c);
    const walkA = a.outerPlus > a.w, walkB = b.outerMinus > b.w;
    if (walkA && walkB) {
      const poly: P2[] = [cap(a, a.w), cap(a, a.outerPlus)];
      const o = cornerO[k];
      if (o) poly.push(o);
      poly.push(cap(b, -b.outerMinus), cap(b, -b.w));
      if (c) poly.push(c);
      corners.push({ poly, curb: Math.min(a.segment.profile.curbHeight, b.segment.profile.curbHeight), curbLine: c ? [cap(b, -b.w), c, cap(a, a.w)] : [cap(b, -b.w), cap(a, a.w)] });
      a.cornerPlus = true;
      b.cornerMinus = true;
    }
  }
  const widest = [...roads].sort((x, y) => y.w - x.w || (x.segment.id < y.segment.id ? -1 : 1))[0];
  const material = widest.segment.profile.material;
  const crosswalks: Crosswalk[] = [];
  if (junction) {
    for (const r of roads) {
      if (!r.segment.profile.markings || !ROAD_MATERIAL_PROPS[r.segment.profile.material].marked) continue;
      const along = r.trim + 1.6;
      crosswalks.push({ x: O[0] + r.dx * along, z: O[1] + r.dz * along, dx: r.dx, dz: r.dz, width: r.w * 2 - 0.4, depth: 3 });
    }
  }
  return { node: nodeId, roads, trim: new Map(roads.map((r) => [r.segment.id, r.trim])), surface, corners, material, crosswalks, junction, warnings };
}
