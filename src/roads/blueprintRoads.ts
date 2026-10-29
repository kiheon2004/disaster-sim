/**
 * Roads in blueprints (Phase 18): copy / paste of road segments together with the objects linked
 * to them. Blueprint roads are stored relative to the blueprint anchor, by index (no ids), so
 * every paste creates fresh node / segment ids.
 *
 * External connection policy (chosen explicitly when pasting):
 *  - connect:  pasted roads are drawn like hand-drawn ones — their ends snap to existing nodes /
 *              roads within the snap radius and crossings with existing roads become junctions
 *  - isolate:  pasted roads are inserted exactly as copied with no connection to existing roads;
 *              crossings with existing roads are reported (they are not split)
 * Links of pasted objects are re-measured on the pasted roads (same place along the road).
 */
import { z } from 'zod';
import type { P2 } from './curve';
import { crossings, drawRoad, insertSubnetwork, segmentLine } from './network';
import { defaultProfile, type RoadNetwork, type RoadProfile } from './types';
import { profileSchema } from './schema';

export type RoadPastePolicy = 'connect' | 'isolate';

export interface BlueprintRoads {
  /** Node positions relative to the anchor (x, z) and fixed elevation (relative to the anchor ground) or null. */
  nodes: { x: number; z: number; y: number | null }[];
  segments: { a: number; b: number; control: [number, number][]; profile: RoadProfile; condition?: number }[];
}

/** Capture segments (and their nodes) relative to (px, pz); `groundY` = ground height at the anchor. */
export function captureRoads(n: RoadNetwork, segIds: readonly string[], px: number, pz: number, groundY = 0): { roads: BlueprintRoads; index: Map<string, number> } {
  const nodeIndex = new Map<string, number>();
  const roads: BlueprintRoads = { nodes: [], segments: [] };
  const index = new Map<string, number>();
  const node = (id: string) => {
    let k = nodeIndex.get(id);
    if (k === undefined) {
      const nd = n.nodes[id];
      k = roads.nodes.length;
      roads.nodes.push({ x: nd.x - px, z: nd.z - pz, y: nd.y === null ? null : nd.y - groundY });
      nodeIndex.set(id, k);
    }
    return k;
  };
  for (const id of [...segIds].sort()) {
    const s = n.segments[id];
    if (!s) continue;
    index.set(id, roads.segments.length);
    const seg: BlueprintRoads['segments'][number] = { a: node(s.a), b: node(s.b), control: s.control.map((c) => [c[0] - px, c[1] - pz]), profile: { ...s.profile } };
    if (s.condition) seg.condition = s.condition;
    roads.segments.push(seg);
  }
  return { roads, index };
}

export interface RoadPasteResult {
  network: RoadNetwork;
  /** New segment ids per blueprint segment (a connected paste may split one into several). */
  segments: string[][];
  /** Isolate policy: crossings with existing roads that were NOT turned into junctions. */
  unconnectedCrossings: number;
}

/** Place blueprint roads with the anchor at (x, z), rotated by yaw (same rotation as objects). */
export function pasteRoads(net: RoadNetwork, bp: BlueprintRoads, x: number, z: number, yaw: number, policy: RoadPastePolicy, groundY = 0): RoadPasteResult {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const tr = (u: number, v: number): P2 => [x + u * c + v * s, z - u * s + v * c];
  if (policy === 'isolate') {
    const before = net;
    const r = insertSubnetwork(
      net,
      bp.nodes.map((p) => { const [px, pz] = tr(p.x, p.z); return { x: px, z: pz, y: p.y === null ? null : p.y + groundY }; }),
      bp.segments.map((g) => ({ ...g, control: g.control.map(([u, v]) => tr(u, v)) })),
    );
    let unconnected = 0;
    for (const id of r.segmentIds) {
      const seg = r.network.segments[id];
      unconnected += crossings(before, segmentLine(r.network, seg), seg.a, seg.b).length;
    }
    return { network: r.network, segments: r.segmentIds.map((id) => [id]), unconnectedCrossings: unconnected };
  }
  let n = net;
  const out: string[][] = [];
  for (const g of bp.segments) {
    const a = bp.nodes[g.a], b = bp.nodes[g.b];
    const pts: P2[] = [tr(a.x, a.z), ...g.control.map(([u, v]) => tr(u, v)), tr(b.x, b.z)];
    const r = drawRoad(n, pts, { curved: g.control.length > 0, profile: g.profile });
    n = r.network;
    // Fixed node elevations travel with the paste (relative to the ground at the anchor).
    for (const [k, id] of [[g.a, r.network.segments[r.segments[0]]?.a], [g.b, r.network.segments[r.segments[r.segments.length - 1]]?.b]] as [number, string | undefined][]) {
      const y = bp.nodes[k].y;
      if (id && y !== null && n.nodes[id]) n = { ...n, nodes: { ...n.nodes, [id]: { ...n.nodes[id], y: Math.round((y + groundY) * 100) / 100 } } };
    }
    if (g.condition) for (const id of r.segments) n = { ...n, segments: { ...n.segments, [id]: { ...n.segments[id], condition: g.condition } } };
    out.push(r.segments);
  }
  return { network: n, segments: out, unconnectedCrossings: 0 };
}

const finite = z.number().refine(Number.isFinite);
export const blueprintRoadsSchema = z.object({
  nodes: z.array(z.object({ x: finite, z: finite, y: finite.nullable().default(null) })).max(5000),
  segments: z.array(z.object({
    a: z.number().int().min(0),
    b: z.number().int().min(0),
    control: z.array(z.tuple([finite, finite])).max(64).default([]),
    profile: profileSchema.catch({}).default({}),
    condition: z.number().min(0).max(1).optional().catch(undefined),
  })).max(5000),
}).transform((r) => ({
  nodes: r.nodes,
  // Segments referencing missing nodes are dropped; profiles are completed (clamped on paste).
  segments: r.segments.filter((g) => g.a < r.nodes.length && g.b < r.nodes.length && g.a !== g.b).map((g) => ({ ...g, profile: { ...defaultProfile(), ...g.profile } as RoadProfile })),
}));
