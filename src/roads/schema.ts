/**
 * Road network file format (Phase 18, schema v6). Validated leniently like the rest of the
 * format: an invalid node / segment is DROPPED and counted (never guessed), profiles are
 * clamped to their limits, references are checked (a segment whose node is missing is dropped,
 * nodes no segment uses are dropped). The underlay (natural ground under the roads) is stored
 * compactly: vertex index deltas, heights in cm, ground ids — all base-36 text.
 */
import { z } from 'zod';
import { PROFILE_LIMITS, ROAD_MATERIALS, ELEVATION_POLICIES, SIDEWALK_SIDES, DRAINAGE_LEVELS, ZONE_TYPES, LINK_POLICIES, defaultProfile, emptyNetwork, type RoadLink, type RoadNetwork, type RoadProfile, type RoadSegment, type Underlay } from './types';
import { structuralIssues } from './network';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';

const finite = z.number().refine(Number.isFinite);
const clampTo = ([lo, hi]: readonly [number, number]) => finite.transform((v) => Math.min(hi, Math.max(lo, v)));

const d = defaultProfile();
export const profileSchema = z.object({
  width: clampTo(PROFILE_LIMITS.width).catch(d.width),
  lanes: clampTo(PROFILE_LIMITS.lanes).transform(Math.round).catch(d.lanes),
  oneWay: z.boolean().catch(d.oneWay),
  material: z.enum(ROAD_MATERIALS as [string, ...string[]]).catch(d.material),
  sidewalk: z.enum(SIDEWALK_SIDES as [string, ...string[]]).catch(d.sidewalk),
  sidewalkWidth: clampTo(PROFILE_LIMITS.sidewalkWidth).catch(d.sidewalkWidth),
  curbHeight: clampTo(PROFILE_LIMITS.curbHeight).catch(d.curbHeight),
  elevation: z.enum(ELEVATION_POLICIES as [string, ...string[]]).catch(d.elevation),
  drainage: z.enum(DRAINAGE_LEVELS as [string, ...string[]]).catch(d.drainage),
  markings: z.boolean().catch(d.markings),
  shoulderWidth: clampTo(PROFILE_LIMITS.shoulderWidth).optional().catch(undefined),
  medianWidth: clampTo(PROFILE_LIMITS.medianWidth).optional().catch(undefined),
}).partial();

const idSchema = z.string().regex(/^[ns]\d{1,9}$/);
const nodeSchema = z.object({ id: idSchema, x: finite, z: finite, y: finite.nullable().catch(null).default(null) });
const segmentSchema = z.object({
  id: idSchema,
  a: idSchema,
  b: idSchema,
  control: z.array(z.tuple([finite, finite])).max(64).default([]),
  profile: profileSchema.default({}),
  condition: z.number().min(0).max(1).optional().catch(undefined),
});

export interface SerializedUnderlay {
  encoding: 'b36-delta';
  idx: string;
  h: string;
  g: string;
}

const underlaySchema = z.object({ encoding: z.literal('b36-delta'), idx: z.string(), h: z.string(), g: z.string() });

export const linkSchema = z.object({
  segment: idSchema,
  t: z.number().min(0).max(1),
  lateral: finite,
  yaw: finite,
  policy: z.enum(LINK_POLICIES as [string, ...string[]]).catch('follow'),
});

const networkSchema = z.object({
  version: z.literal(1),
  nodes: z.record(z.string(), z.unknown()).default({}),
  segments: z.record(z.string(), z.unknown()).default({}),
  zones: z.record(z.string(), z.unknown()).default({}),
  underlay: underlaySchema.nullable().catch(null).default(null),
  next: z.number().int().min(1).catch(1).default(1),
});

export function encodeUnderlay(u: Underlay): SerializedUnderlay {
  let prev = -1;
  const idx: string[] = [], h: string[] = [];
  for (let k = 0; k < u.idx.length; k++) {
    idx.push((u.idx[k] - prev).toString(36));
    prev = u.idx[k];
    h.push(Math.round(u.h[k] * 100).toString(36));
  }
  return { encoding: 'b36-delta', idx: idx.join(','), h: h.join(','), g: u.g.map((g) => g.toString(36)).join('') };
}

export function decodeUnderlay(s: SerializedUnderlay, vertices: number): Underlay | null {
  if (!s.idx) return { idx: [], h: [], g: [] };
  const di = s.idx.split(','), dh = s.h.split(',');
  if (di.length !== dh.length || s.g.length !== di.length) return null;
  const out: Underlay = { idx: [], h: [], g: [] };
  let prev = -1;
  for (let k = 0; k < di.length; k++) {
    const step = parseInt(di[k], 36), cm = parseInt(dh[k], 36), g = parseInt(s.g[k], 36);
    // Every ground type is valid under a road (Phase 36: rock / mud / riverbed 6–8 were rejected and the underlay lost).
    if (!(step > 0) || !Number.isFinite(cm) || !Number.isFinite(g) || g < 0 || g >= GROUND_MATERIALS.length) return null;
    prev += step;
    if (prev >= vertices) return null;
    out.idx.push(prev);
    out.h.push(Math.fround(cm / 100));
    out.g.push(g);
  }
  return out;
}

/** JSON-ready network (underlay encoded). */
export function serializeNetwork(n: RoadNetwork) {
  return { ...n, underlay: encodeUnderlay(n.underlay) };
}

export interface RoadLoadReport {
  droppedNodes: number;
  droppedSegments: number;
  /** The underlay could not be read: the terrain under the roads is kept as saved. */
  underlayLost: boolean;
}

/**
 * Parse a saved network. `vertices` = terrain vertex count (underlay bounds). Returns the network
 * and what was dropped; a missing / unreadable network is an empty one.
 */
export function parseNetwork(raw: unknown, vertices: number): { network: RoadNetwork; report: RoadLoadReport } {
  const report: RoadLoadReport = { droppedNodes: 0, droppedSegments: 0, underlayLost: false };
  if (raw === undefined || raw === null) return { network: emptyNetwork(), report };
  const r = networkSchema.safeParse(raw);
  if (!r.success) return { network: emptyNetwork(), report: { ...report, underlayLost: true } };
  const n = emptyNetwork();
  let maxId = 0;
  const num = (id: string) => parseInt(id.slice(1), 10);
  for (const [key, v] of Object.entries(r.data.nodes)) {
    const p = nodeSchema.safeParse(v);
    if (!p.success || p.data.id !== key || !p.data.id.startsWith('n')) { report.droppedNodes++; continue; }
    n.nodes[key] = p.data;
    maxId = Math.max(maxId, num(key));
  }
  for (const [key, v] of Object.entries(r.data.segments)) {
    const p = segmentSchema.safeParse(v);
    if (!p.success || p.data.id !== key || !p.data.id.startsWith('s') || !n.nodes[p.data.a] || !n.nodes[p.data.b]) { report.droppedSegments++; continue; }
    const seg: RoadSegment = { id: key, a: p.data.a, b: p.data.b, control: p.data.control, profile: { ...d, ...p.data.profile } as RoadProfile };
    if (p.data.condition !== undefined) seg.condition = p.data.condition;
    n.segments[key] = seg;
    maxId = Math.max(maxId, num(key));
  }
  // Geometric validity (too short / self loops) — such segments are dropped, not stretched.
  for (const issue of structuralIssues(n)) {
    if (issue.segment && n.segments[issue.segment]) { delete n.segments[issue.segment]; report.droppedSegments++; }
  }
  // Nodes without segments are not part of a road.
  const used = new Set(Object.values(n.segments).flatMap((s) => [s.a, s.b]));
  for (const id of Object.keys(n.nodes)) if (!used.has(id)) { delete n.nodes[id]; report.droppedNodes++; }
  for (const [k, z0] of Object.entries(r.data.zones)) {
    if (typeof z0 === 'string' && (ZONE_TYPES as readonly string[]).includes(z0)) n.zones[k] = z0 as RoadNetwork['zones'][string];
  }
  n.next = Math.max(r.data.next, maxId + 1);
  if (r.data.underlay) {
    const u = decodeUnderlay(r.data.underlay, vertices);
    if (u) n.underlay = u;
    else report.underlayLost = true;
  }
  return { network: n, report };
}

export function parseLink(raw: unknown): RoadLink | undefined {
  const r = linkSchema.safeParse(raw);
  return r.success ? (r.data as RoadLink) : undefined;
}
