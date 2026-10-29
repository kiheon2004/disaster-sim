/**
 * City blocks (Phase 18): the bounded faces of the planar road graph. Drawing splits roads at
 * every crossing, so the network is a plane graph; walking each directed edge and always
 * turning to the next road clockwise traces every face once. Faces traced counter-clockwise
 * (positive area in x/z with +z south = clockwise on screen, see `signedArea`) are the bounded
 * blocks; the unbounded outer face of each connected part comes out with the opposite sign and
 * is dropped, so an open network (a tree of roads) has no blocks.
 *
 * A block's id is derived from its boundary segments, so a zone stays attached to the same
 * block while unrelated roads are edited; changing a boundary road makes it a new block.
 */
import { nodeDirections, segmentLine } from './network';
import type { RoadNetwork, RoadSegment, ZoneType } from './types';

type P2 = [number, number];

export interface Block {
  id: string;
  /** Boundary along the road centerlines (closed, without repeating the first point). */
  polygon: P2[];
  /** Area enclosed by the centerlines (m²). */
  area: number;
  /** Boundary segments with the side of the block (+1 = right of travel a→b). */
  edges: { segment: string; side: 1 | -1 }[];
  centroid: P2;
  zone: ZoneType | null;
}

/** Faces smaller than this are slivers between nearly parallel roads, not blocks (m²). */
export const MIN_BLOCK_AREA = 150;

export function signedArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

export function pointInPolygon(poly: readonly P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function centroidOf(poly: readonly P2[]): P2 {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cz += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  return [cx / (3 * a), cz / (3 * a)];
}

const cache = new WeakMap<RoadNetwork, Block[]>();

/** Bounded blocks of the network (cached per network object), sorted by id. */
export function blocksOf(n: RoadNetwork): Block[] {
  const hit = cache.get(n);
  if (hit) return hit;
  // Outgoing half-edges per node sorted by angle.
  const out = new Map<string, { segment: RoadSegment; atStart: boolean; angle: number }[]>();
  for (const id of Object.keys(n.nodes)) out.set(id, nodeDirections(n, id).sort((a, b) => a.angle - b.angle || (a.segment.id < b.segment.id ? -1 : 1)));
  const key = (seg: string, forward: boolean) => `${seg}:${forward ? 1 : 0}`;
  const used = new Set<string>();
  const blocks: Block[] = [];
  const segs = Object.values(n.segments).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const s0 of segs) {
    for (const f0 of [true, false]) {
      if (used.has(key(s0.id, f0))) continue;
      const edges: { segment: RoadSegment; forward: boolean }[] = [];
      let seg = s0, fwd = f0;
      let guard = 0;
      while (!used.has(key(seg.id, fwd)) && guard++ < 10000) {
        used.add(key(seg.id, fwd));
        edges.push({ segment: seg, forward: fwd });
        const at = fwd ? seg.b : seg.a;
        const list = out.get(at)!;
        // The reverse half-edge (back along the road we came on) in the node's angular order.
        const k = list.findIndex((d) => d.segment.id === seg.id && d.atStart === !fwd);
        // Next road clockwise from the reverse edge (previous in ascending angle order).
        const nxt = list[(k - 1 + list.length) % list.length];
        seg = nxt.segment;
        fwd = nxt.atStart;
      }
      // Polygon along the centerlines.
      const poly: P2[] = [];
      for (const e of edges) {
        const line = segmentLine(n, e.segment);
        const pts = line.samples.map((p) => [p.x, p.z] as P2);
        if (!e.forward) pts.reverse();
        poly.push(...pts.slice(0, -1));
      }
      if (poly.length < 3) continue;
      const area = signedArea(poly);
      if (area <= MIN_BLOCK_AREA) continue; // outer face (negative) or a sliver
      const ids = [...new Set(edges.map((e) => e.segment.id))].sort();
      // A road entering the block and ending inside (dead end) is walked on both sides.
      const id = `b:${ids.join('+')}`;
      blocks.push({
        id,
        polygon: poly,
        area,
        edges: edges.map((e) => ({ segment: e.segment.id, side: (e.forward ? 1 : -1) as 1 | -1 })),
        centroid: centroidOf(poly),
        zone: n.zones[id] ?? null,
      });
    }
  }
  blocks.sort((a, b) => (a.id < b.id ? -1 : 1));
  cache.set(n, blocks);
  return blocks;
}

/** The block containing (x, z), if any. */
export function blockAt(n: RoadNetwork, x: number, z: number): Block | null {
  return blocksOf(n).find((b) => pointInPolygon(b.polygon, x, z)) ?? null;
}

/** Network with a zone assigned to (or cleared from, zone = null) a block. Zones of blocks that no longer exist are dropped. */
export function setZone(n: RoadNetwork, blockId: string, zone: ZoneType | null): RoadNetwork {
  const live = new Set(blocksOf(n).map((b) => b.id));
  const zones: RoadNetwork['zones'] = {};
  for (const [k, v] of Object.entries(n.zones)) if (live.has(k) && k !== blockId) zones[k] = v;
  if (zone) zones[blockId] = zone;
  return { ...n, zones };
}
