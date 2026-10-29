/**
 * Road network operations (Phase 18). Pure: every operation returns a new RoadNetwork.
 *
 * Drawing snaps to existing nodes (no duplicate nodes at a junction), splits a segment it ends
 * on (T-junction), and splits both roads where it crosses another road (4-way junction). Every
 * result is validated (references, lengths); invalid edits throw before anything is returned.
 */
import { centerlineOf, nearest, pointAt, type Centerline, type P2 } from './curve';
import { defaultProfile, PROFILE_LIMITS, type RoadNetwork, type RoadNode, type RoadProfile, type RoadSegment } from './types';

/** Snap radius for nodes / segments while drawing (m). */
export const SNAP_NODE = 3;
export const SNAP_SEGMENT = 2;
/** Shortest segment allowed (m). */
export const MIN_SEGMENT = 2;
/** Nodes closer than this are one node (m). */
export const MERGE_DIST = 0.75;

const clone = (n: RoadNetwork): RoadNetwork => ({ ...n, nodes: { ...n.nodes }, segments: { ...n.segments }, zones: { ...n.zones } });

function newId(n: RoadNetwork, prefix: 'n' | 's'): string {
  const id = `${prefix}${n.next}`;
  n.next++;
  return id;
}

/** Points of a segment's centerline definition: a, controls, b. */
export function segmentPoints(n: RoadNetwork, s: RoadSegment): P2[] {
  const a = n.nodes[s.a], b = n.nodes[s.b];
  return [[a.x, a.z], ...s.control.map((c) => [c[0], c[1]] as P2), [b.x, b.z]];
}

const lineCache = new WeakMap<RoadSegment, { key: string; line: Centerline }>();
/** Centerline of a segment (cached per segment object and its node positions). */
export function segmentLine(n: RoadNetwork, s: RoadSegment): Centerline {
  const pts = segmentPoints(n, s);
  const key = pts.map((p) => `${p[0]},${p[1]}`).join(';');
  const c = lineCache.get(s);
  if (c && c.key === key) return c.line;
  const line = centerlineOf(pts);
  lineCache.set(s, { key, line });
  return line;
}

/** Segments attached to a node. */
export function nodeSegments(n: RoadNetwork, node: string): RoadSegment[] {
  return Object.values(n.segments).filter((s) => s.a === node || s.b === node);
}

export function degree(n: RoadNetwork, node: string): number {
  let d = 0;
  for (const s of Object.values(n.segments)) {
    if (s.a === node) d++;
    if (s.b === node) d++;
  }
  return d;
}

export function findNode(n: RoadNetwork, x: number, z: number, radius = SNAP_NODE): RoadNode | null {
  let best: RoadNode | null = null;
  let bd = radius;
  for (const node of Object.values(n.nodes)) {
    const d = Math.hypot(node.x - x, node.z - z);
    if (d < bd) { bd = d; best = node; }
  }
  return best;
}

export interface SegmentHit {
  segment: RoadSegment;
  s: number;
  t: number;
  x: number;
  z: number;
  dist: number;
}

export function findSegment(n: RoadNetwork, x: number, z: number, radius = SNAP_SEGMENT): SegmentHit | null {
  let best: SegmentHit | null = null;
  for (const seg of Object.values(n.segments)) {
    const line = segmentLine(n, seg);
    const hit = nearest(line, x, z);
    const tol = radius + seg.profile.width / 2;
    // Beyond a free end the road surface ends: only the node snap radius applies there.
    const atEnd = hit.s <= 1e-6 || hit.s >= line.length - 1e-6;
    if (atEnd && hit.dist > SNAP_NODE) continue;
    if (hit.dist <= tol && (!best || hit.dist < best.dist)) {
      const p = pointAt(line, hit.s);
      best = { segment: seg, s: hit.s, t: line.length > 0 ? hit.s / line.length : 0, x: p.x, z: p.z, dist: hit.dist };
    }
  }
  return best;
}

function sanitizeProfile(p: RoadProfile): RoadProfile {
  const c = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  return { ...p, width: c(p.width, PROFILE_LIMITS.width), lanes: Math.round(c(p.lanes, PROFILE_LIMITS.lanes)), sidewalkWidth: c(p.sidewalkWidth, PROFILE_LIMITS.sidewalkWidth), curbHeight: c(p.curbHeight, PROFILE_LIMITS.curbHeight) };
}

/** Get or create the node at (x, z): existing node within MERGE_DIST, else a new one. */
function nodeAt(n: RoadNetwork, x: number, z: number): string {
  const near = findNode(n, x, z, MERGE_DIST);
  if (near) return near.id;
  const id = newId(n, 'n');
  n.nodes[id] = { id, x: round(x), z: round(z), y: null };
  return id;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Split a segment at arc length s; returns the new node id (existing end node when s ≈ 0 / L). */
function splitAt(n: RoadNetwork, segId: string, s: number): string {
  const seg = n.segments[segId];
  const line = segmentLine(n, seg);
  if (s <= MERGE_DIST) return seg.a;
  if (s >= line.length - MERGE_DIST) return seg.b;
  const p = pointAt(line, s);
  const mid = nodeAt(n, p.x, p.z);
  // Control points before / after the split point (by their arc length on the curve).
  const pre: [number, number][] = [];
  const post: [number, number][] = [];
  for (const c of seg.control) (nearest(line, c[0], c[1]).s < s ? pre : post).push(c);
  delete n.segments[segId];
  const s1 = newId(n, 's');
  const s2 = newId(n, 's');
  n.segments[s1] = { ...seg, id: s1, b: mid, control: pre };
  n.segments[s2] = { ...seg, id: s2, a: mid, control: post };
  return mid;
}

export interface DrawOptions {
  /** Interior points are curve control points (one segment) instead of polyline vertices. */
  curved: boolean;
  profile: RoadProfile;
}

/** Result of a draw: the network and the ids it created / split (for previews and links). */
export interface DrawResult {
  network: RoadNetwork;
  segments: string[];
  splits: string[];
}

/**
 * Draw a road through `points` (≥ 2). Ends snap to nodes (≤ SNAP_NODE) or split the segment
 * they land on (T-junction); crossings with existing roads become 4-way junctions.
 */
export function drawRoad(net: RoadNetwork, points: readonly P2[], opts: DrawOptions): DrawResult {
  if (points.length < 2) throw new Error('A road needs two points');
  const n = clone(net);
  const profile = sanitizeProfile(opts.profile);
  const splits: string[] = [];
  const endNode = (p: P2): string => {
    const node = findNode(n, p[0], p[1], SNAP_NODE);
    if (node) return node.id;
    const hit = findSegment(n, p[0], p[1], SNAP_SEGMENT);
    if (hit) {
      splits.push(hit.segment.id);
      return splitAt(n, hit.segment.id, hit.s);
    }
    return nodeAt(n, p[0], p[1]);
  };
  // Chains of (start, controls, end) to create: one chain for a curve, one per leg for a polyline.
  const legs: { pts: P2[] }[] = opts.curved ? [{ pts: [...points] }] : points.slice(0, -1).map((p, i) => ({ pts: [p, points[i + 1]] }));
  const created: string[] = [];
  for (const leg of legs) {
    const a = endNode(leg.pts[0]);
    const b = endNode(leg.pts[leg.pts.length - 1]);
    if (a === b) continue;
    const pts: P2[] = [[n.nodes[a].x, n.nodes[a].z], ...leg.pts.slice(1, -1), [n.nodes[b].x, n.nodes[b].z]];
    // Crossings with existing segments (not the ones sharing an end node).
    const line = centerlineOf(pts);
    if (line.length < MIN_SEGMENT) continue;
    const cuts = crossings(n, line, a, b);
    // Split the crossed roads; the new road goes through the junction nodes in order.
    const chain: string[] = [a];
    for (const cut of cuts) {
      splits.push(cut.segment);
      const node = splitAt(n, cut.segment, cut.otherS);
      if (node !== chain[chain.length - 1] && node !== b) chain.push(node);
    }
    chain.push(b);
    // Distribute the interior control points (curves) to the chain parts by arc length.
    const interior = pts.slice(1, -1);
    const sOf = (c: P2) => nearest(line, c[0], c[1]).s;
    const cutS = cuts.map((c) => c.s);
    for (let k = 0; k < chain.length - 1; k++) {
      const lo = k === 0 ? -Infinity : cutS[k - 1];
      const hi = k < cutS.length ? cutS[k] : Infinity;
      const ctrl = interior.filter((c) => { const s = sOf(c); return s > lo && s < hi; }).map((c) => [round(c[0]), round(c[1])] as [number, number]);
      if (chain[k] === chain[k + 1]) continue;
      const id = newId(n, 's');
      n.segments[id] = { id, a: chain[k], b: chain[k + 1], control: ctrl, profile: { ...profile } };
      created.push(id);
    }
  }
  if (!created.length) throw new Error('Road too short');
  assertValid(n);
  return { network: n, segments: created, splits };
}

interface Crossing { segment: string; s: number; otherS: number }

/** Where a new centerline crosses existing segments (sorted along the new line). */
export function crossings(n: RoadNetwork, line: Centerline, a: string, b: string): Crossing[] {
  const out: Crossing[] = [];
  const S = line.samples;
  for (const seg of Object.values(n.segments)) {
    if (seg.a === a || seg.a === b || seg.b === a || seg.b === b) continue;
    const other = segmentLine(n, seg);
    const O = other.samples;
    for (let i = 0; i < S.length - 1; i++) {
      for (let j = 0; j < O.length - 1; j++) {
        const hit = segIntersect(S[i].x, S[i].z, S[i + 1].x, S[i + 1].z, O[j].x, O[j].z, O[j + 1].x, O[j + 1].z);
        if (!hit) continue;
        const s = S[i].s + (S[i + 1].s - S[i].s) * hit[0];
        const os = O[j].s + (O[j + 1].s - O[j].s) * hit[1];
        if (s < MERGE_DIST || s > line.length - MERGE_DIST) continue;
        if (!out.some((c) => c.segment === seg.id)) out.push({ segment: seg.id, s, otherS: os });
      }
    }
  }
  return out.sort((x, y) => x.s - y.s);
}

function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

/** Split a segment at the point nearest to (x, z). */
export function splitSegment(net: RoadNetwork, segId: string, x: number, z: number): { network: RoadNetwork; node: string } {
  const n = clone(net);
  const seg = n.segments[segId];
  if (!seg) throw new Error(`No segment ${segId}`);
  const line = segmentLine(n, seg);
  const s = nearest(line, x, z).s;
  if (s <= MIN_SEGMENT || s >= line.length - MIN_SEGMENT) throw new Error('Split point too close to an end');
  const node = splitAt(n, segId, s);
  assertValid(n);
  return { network: n, node };
}

/** Profiles that can merge into one segment. */
const sameProfile = (p: RoadProfile, q: RoadProfile) => (Object.keys(p) as (keyof RoadProfile)[]).every((k) => p[k] === q[k]);

/**
 * Merge the two segments meeting at a degree-2 node with identical profiles into one (the node
 * becomes a control point). Returns null when they are not compatible.
 */
export function mergeAtNode(net: RoadNetwork, nodeId: string): RoadNetwork | null {
  const segs = nodeSegments(net, nodeId);
  if (segs.length !== 2) return null;
  const [s1, s2] = segs;
  if (!sameProfile(s1.profile, s2.profile) || (s1.condition ?? 0) !== (s2.condition ?? 0)) return null;
  // Orient: s1 ends at the node, s2 starts there.
  const n = clone(net);
  const node = n.nodes[nodeId];
  const fwd = (s: RoadSegment, endAtNode: boolean): { from: string; to: string; ctrl: [number, number][] } =>
    endAtNode === (s.b === nodeId) ? { from: s.a, to: s.b, ctrl: s.control } : { from: s.b, to: s.a, ctrl: [...s.control].reverse() };
  const first = fwd(s1, true);
  const second = fwd(s2, false);
  if (first.from === second.to) return null; // would make a loop on one node
  if (s1.profile.oneWay && (s1.b === nodeId) !== (s2.a === nodeId)) return null; // opposite one-way directions
  delete n.segments[s1.id];
  delete n.segments[s2.id];
  delete n.nodes[nodeId];
  const id = newId(n, 's');
  n.segments[id] = { ...s1, id, a: first.from, b: second.to, control: [...first.ctrl, [node.x, node.z], ...second.ctrl] };
  assertValid(n);
  return n;
}

/** Delete segments; nodes left without segments are removed too. */
export function deleteSegments(net: RoadNetwork, ids: readonly string[]): RoadNetwork {
  const n = clone(net);
  for (const id of ids) delete n.segments[id];
  const used = new Set<string>();
  for (const s of Object.values(n.segments)) { used.add(s.a); used.add(s.b); }
  for (const id of Object.keys(n.nodes)) if (!used.has(id)) delete n.nodes[id];
  return n;
}

export function moveNode(net: RoadNetwork, id: string, x: number, z: number): RoadNetwork {
  const n = clone(net);
  if (!n.nodes[id]) throw new Error(`No node ${id}`);
  n.nodes[id] = { ...n.nodes[id], x: round(x), z: round(z) };
  assertValid(n);
  return n;
}

export function setNodeElevation(net: RoadNetwork, id: string, y: number | null): RoadNetwork {
  const n = clone(net);
  n.nodes[id] = { ...n.nodes[id], y: y === null ? null : Math.round(y * 100) / 100 };
  return n;
}

export function moveControl(net: RoadNetwork, segId: string, index: number, x: number, z: number): RoadNetwork {
  const n = clone(net);
  const seg = n.segments[segId];
  const control = seg.control.map((c, i) => (i === index ? [round(x), round(z)] as [number, number] : c));
  n.segments[segId] = { ...seg, control };
  assertValid(n);
  return n;
}

/** Add a control point (bend) to a straight or curved segment at the point nearest to (x, z). */
export function addControl(net: RoadNetwork, segId: string, x: number, z: number): RoadNetwork {
  const n = clone(net);
  const seg = n.segments[segId];
  const line = segmentLine(n, seg);
  const s = nearest(line, x, z).s;
  const ctrl = [...seg.control];
  const idx = ctrl.findIndex((c) => nearest(line, c[0], c[1]).s > s);
  ctrl.splice(idx < 0 ? ctrl.length : idx, 0, [round(x), round(z)]);
  n.segments[segId] = { ...seg, control: ctrl };
  assertValid(n);
  return n;
}

export function setProfile(net: RoadNetwork, ids: readonly string[], patch: Partial<RoadProfile>): RoadNetwork {
  const n = clone(net);
  for (const id of ids) if (n.segments[id]) n.segments[id] = { ...n.segments[id], profile: sanitizeProfile({ ...n.segments[id].profile, ...patch }) };
  return n;
}

export function setCondition(net: RoadNetwork, ids: readonly string[], condition: number): RoadNetwork {
  const n = clone(net);
  for (const id of ids) {
    const s = { ...n.segments[id] };
    if (condition > 0) s.condition = Math.min(1, condition);
    else delete s.condition;
    n.segments[id] = s;
  }
  return n;
}

export interface NetworkIssue {
  /** i18n key suffix: road.issue.<code> */
  code: 'missingNode' | 'selfLoop' | 'tooShort' | 'duplicate' | 'acute' | 'tightCurve' | 'steep' | 'cutFill';
  level: 'error' | 'warning';
  segment?: string;
  node?: string;
  value?: number;
}

/** Structural validity (errors) — every edit result must pass. */
export function structuralIssues(n: RoadNetwork): NetworkIssue[] {
  const out: NetworkIssue[] = [];
  for (const s of Object.values(n.segments)) {
    if (!n.nodes[s.a] || !n.nodes[s.b]) { out.push({ code: 'missingNode', level: 'error', segment: s.id }); continue; }
    if (s.a === s.b && s.control.length < 2) out.push({ code: 'selfLoop', level: 'error', segment: s.id });
    const L = segmentLine(n, s).length;
    if (L < MIN_SEGMENT) out.push({ code: 'tooShort', level: 'error', segment: s.id, value: L });
  }
  return out;
}

export function assertValid(n: RoadNetwork) {
  const bad = structuralIssues(n);
  if (bad.length) throw new Error(`Invalid road network: ${bad.map((b) => `${b.code}:${b.segment ?? b.node}`).join(', ')}`);
}

/** Geometric warnings (allowed, shown): acute junctions, tight curves, duplicates. */
export function networkWarnings(n: RoadNetwork): NetworkIssue[] {
  const out: NetworkIssue[] = [];
  const seen = new Map<string, string>();
  for (const s of Object.values(n.segments)) {
    const key = [s.a, s.b].sort().join('|');
    if (seen.has(key) && !s.control.length) out.push({ code: 'duplicate', level: 'warning', segment: s.id });
    seen.set(key, s.id);
    const line = segmentLine(n, s);
    const r = minRadiusOf(line);
    if (r < s.profile.width) out.push({ code: 'tightCurve', level: 'warning', segment: s.id, value: r });
  }
  for (const node of Object.values(n.nodes)) {
    const dirs = nodeDirections(n, node.id).map((d) => d.angle).sort((a, b) => a - b);
    for (let i = 0; i < dirs.length && dirs.length >= 2; i++) {
      const gap = ((dirs[(i + 1) % dirs.length] - dirs[i] + 2 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI;
      if (gap < (20 * Math.PI) / 180) out.push({ code: 'acute', level: 'warning', node: node.id, value: (gap * 180) / Math.PI });
    }
  }
  return out;
}

import { minRadius as minRadiusOf } from './curve';

/** Directions (angle in x/z) of the segments leaving a node. */
export function nodeDirections(n: RoadNetwork, nodeId: string): { segment: RoadSegment; angle: number; atStart: boolean; dx: number; dz: number }[] {
  const out: { segment: RoadSegment; angle: number; atStart: boolean; dx: number; dz: number }[] = [];
  for (const s of Object.values(n.segments)) {
    for (const atStart of [true, false]) {
      if ((atStart ? s.a : s.b) !== nodeId) continue;
      const line = segmentLine(n, s);
      const smp = atStart ? line.samples[0] : line.samples[line.samples.length - 1];
      const dx = atStart ? smp.tx : -smp.tx;
      const dz = atStart ? smp.tz : -smp.tz;
      out.push({ segment: s, angle: Math.atan2(dz, dx), atStart, dx, dz });
    }
  }
  return out;
}

export { defaultProfile };
