/**
 * Phase 37 — reference resolution (§7): what the symbolic references of an intent ("the selection", "node n4", "the
 * main road", "north of #id", "the tallest building") ARE in a particular document. Pure: reads the document and the
 * Context, writes nothing.
 *
 * Three results: a value (with notes for the summary), an error (nothing matches — the command does not run), or a
 * question (several candidates would give different results — the user chooses; a command never picks one by itself).
 */
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { WORLD_HALF } from '@/core/units';
import { getDefinition } from '@/objects/registry';
import { analyzeBuilding, type AnalysisWarning } from '@/buildings/analysis';
import type { BuildingDesign } from '@/buildings/types';
import type { Feature, PeakFeature } from '@/landscape/types';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { RoadNetwork, RoadSegment } from '@/roads/types';
import { segmentLine, segmentPoints } from '@/roads/network';
import { nearest, pointAt } from '@/roads/curve';
import { sectionAt } from '@/roads/crossSection';
import { footprintHalf, selectionPivot } from '@/editor/build/groupTransform';
import { expandGroups, msg, orderedObjects, sortIds, type Env, type Highlight, type Msg } from './context';
import { canonicalType, findKind, isOfKind, KIND_TYPES, presetIsExact } from './kinds';
import type { AreaRef, CompareOp, InstanceRef, PlaceRef, Predicate, RoadRef, TargetRef } from './intent';

// ── Results ──────────────────────────────────────────────────────────────────────────

export interface ClarifyOption {
  label: Msg;
  /** What the reference becomes when this option is chosen (the same kind of reference, now unambiguous). */
  value: unknown;
  highlight?: Highlight;
}

/** A question: the node of the intent that is ambiguous (`at`, by identity) and what it can be replaced with. */
export interface Clarify {
  question: Msg;
  at: object;
  options: ClarifyOption[];
}

export type Resolved<T> = { ok: true; value: T; notes: Msg[] } | { ok: false; error: Msg } | { ok: false; clarify: Clarify };

const ok = <T>(value: T, notes: Msg[] = []): Resolved<T> => ({ ok: true, value, notes });
const err = (error: Msg): { ok: false; error: Msg } => ({ ok: false, error });
const ask = (question: Msg, at: object, options: ClarifyOption[]): { ok: false; clarify: Clarify } => ({ ok: false, clarify: { question, at, options } });

/** At most this many options in a question (the rest are summarised by the question's count). */
export const MAX_OPTIONS = 12;

const r1 = (v: number) => Math.round(v * 10) / 10;
const lower = (s: string) => s.toLowerCase();

/** Find an id: exact, else ignoring case, else the ids it is a prefix of. */
function lookupId(ids: readonly string[], want: string): { id: string } | { many: string[] } | null {
  if (ids.includes(want)) return { id: want };
  const w = lower(want);
  const ci = ids.filter((id) => lower(id) === w);
  if (ci.length === 1) return { id: ci[0] };
  const pre = (ci.length ? ci : ids.filter((id) => lower(id).startsWith(w))).sort();
  if (pre.length === 1) return { id: pre[0] };
  return pre.length ? { many: pre } : null;
}

/** Names by tiers: exact → ignoring case → containing (ignoring case). The first non-empty tier. */
function matchNames<T>(items: readonly T[], nameOf: (t: T) => string, want: string): T[] {
  const exact = items.filter((t) => nameOf(t) === want);
  if (exact.length) return exact;
  const w = lower(want);
  const ci = items.filter((t) => lower(nameOf(t)) === w);
  if (ci.length) return ci;
  return items.filter((t) => nameOf(t) !== '' && lower(nameOf(t)).includes(w));
}

const natural = (a: string, b: string) => {
  const na = Number(a.replace(/^\D+/, '')), nb = Number(b.replace(/^\D+/, ''));
  return (Number.isFinite(na) && Number.isFinite(nb) ? na - nb : 0) || (a < b ? -1 : a > b ? 1 : 0);
};

// ── Labels of things offered in questions ────────────────────────────────────────────

export function objectLabel(o: WorldObject): Msg {
  const [x, , z] = o.transform.position;
  const base = { type: `@object.${o.type}`, serial: o.serial, id: o.id, x: r1(x), z: r1(z) };
  return o.name ? msg('cmd37.opt.objectNamed', { ...base, name: o.name }) : msg('cmd37.opt.object', base);
}

// ── Groups, names ────────────────────────────────────────────────────────────────────

interface GroupInfo {
  id: string;
  name: string;
  members: WorldObject[];
}

/** Named groups that still have members (names of emptied groups linger in a session: they do not count). */
function namedGroups(env: Env): GroupInfo[] {
  const names = env.doc.groups ?? {};
  const by = new Map<string, WorldObject[]>();
  for (const o of orderedObjects(env.doc)) if (o.group && names[o.group]) (by.get(o.group) ?? by.set(o.group, []).get(o.group)!).push(o);
  return [...by.entries()].map(([id, members]) => ({ id, name: names[id].name, members })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.members[0].serial - b.members[0].serial) || (a.id < b.id ? -1 : 1));
}

function groupLabel(g: GroupInfo): Msg {
  const p = selectionPivot(g.members);
  return msg('cmd37.opt.group', { name: g.name, count: g.members.length, x: r1(p.x), z: r1(p.z) });
}

/** The members of the group called `name` — a question when several groups match (its options name the group by id). */
function groupByName(name: string, at: object, env: Env, kind: 'target' | 'place'): Resolved<WorldObject[]> {
  const hits = matchNames(namedGroups(env), (g) => g.name, name);
  if (!hits.length) return err(msg('cmd37.err.unknownGroup', { name }));
  if (hits.length === 1) return ok(hits[0].members);
  return ask(msg('cmd37.ask.group', { name, count: hits.length }), at, hits.slice(0, MAX_OPTIONS).map((g) => ({ label: groupLabel(g), value: groupRef(g, kind), highlight: { ids: g.members.map((o) => o.id) } })));
}

const groupRef = (g: GroupInfo, kind: 'target' | 'place') => (kind === 'target' ? { b: 'groupId', id: g.id } : { p: 'groupId', id: g.id });

/** The members of the group with this id (named or not). */
function groupById(id: string, env: Env): Resolved<WorldObject[]> {
  const members = orderedObjects(env.doc).filter((o) => o.group === id);
  return members.length ? ok(members) : err(msg('cmd37.err.unknownGroup', { name: id }));
}

/**
 * Objects or a group by name: object names first (tiers), then group names. Several objects with the same name at the
 * best tier, or an object and a group — a question.
 */
function byName(name: string, at: object, env: Env, kind: 'target' | 'place'): Resolved<WorldObject[]> {
  const objs = matchNames(orderedObjects(env.doc).filter((o) => o.name !== ''), (o) => o.name, name);
  const groups = matchNames(namedGroups(env), (g) => g.name, name);
  if (!objs.length && !groups.length) return err(msg('cmd37.err.unknownName', { name }));
  if (objs.length === 1 && !groups.length) return ok(objs);
  if (!objs.length && groups.length === 1) return ok(groups[0].members);
  const idRef = (o: WorldObject) => (kind === 'target' ? { b: 'id', id: o.id } : { p: 'object', id: o.id });
  const options: ClarifyOption[] = [
    ...objs.map((o) => ({ label: objectLabel(o), value: idRef(o), highlight: { ids: [o.id] } })),
    // (groups are offered by id: group names need not be unique)
    ...groups.map((g) => ({ label: groupLabel(g), value: groupRef(g, kind), highlight: { ids: g.members.map((o) => o.id) } })),
  ];
  return ask(msg('cmd37.ask.name', { name, count: options.length }), at, options.slice(0, MAX_OPTIONS));
}

// ── Features ─────────────────────────────────────────────────────────────────────────

export type Shape =
  | { k: 'circle'; x: number; z: number; r: number }
  | { k: 'rect'; x0: number; z0: number; x1: number; z1: number }
  | { k: 'poly'; points: [number, number][] }
  | { k: 'path'; points: [number, number][]; half: number };

/** A ground area: the union of its shapes. */
export interface Area {
  shapes: Shape[];
  /** World-space bounds [x0, z0, x1, z1]. */
  box: [number, number, number, number];
}

const FEATURE_KINDS = ['mountain', 'hill', 'ridge', 'valley', 'canyon', 'river', 'lake', 'coast'] as const;
const isPeak = (f: Feature): f is PeakFeature => f.kind === 'mountain' || f.kind === 'hill';

function featureCentre(f: Feature): [number, number] {
  if (isPeak(f)) return [f.x, f.z];
  if (f.kind === 'lake') return [f.points.reduce((s, p) => s + p[0], 0) / f.points.length, f.points.reduce((s, p) => s + p[1], 0) / f.points.length];
  // Paths: the point half-way along.
  const pts = f.points;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let run = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (run <= d && d > 0) return [pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * run) / d, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * run) / d];
    run -= d;
  }
  return pts[0];
}

function featureShape(f: Feature): Shape | null {
  if (isPeak(f)) return { k: 'circle', x: f.x, z: f.z, r: f.radius };
  if (f.kind === 'lake') return { k: 'poly', points: f.points.map((p) => [p[0], p[1]] as [number, number]) };
  if (f.kind === 'coast') return null;
  return { k: 'path', points: f.points.map((p) => [p[0], p[1]] as [number, number]), half: f.width / 2 };
}

const featureLabel = (f: Feature): Msg => {
  const [x, z] = featureCentre(f);
  return msg('cmd37.opt.feature', { kind: f.kind, id: f.id, x: r1(x), z: r1(z) });
};

/** A terrain feature by id (f3) or by kind (hill): a question when several are of that kind. */
function feature(id: string, at: object, env: Env, make: (f: Feature) => unknown): Resolved<Feature> {
  const all = env.doc.landscape.features;
  const kind = FEATURE_KINDS.find((k) => k === lower(id));
  if (kind) {
    const hits = all.filter((f) => f.kind === kind).sort((a, b) => natural(a.id, b.id));
    if (!hits.length) return err(msg('cmd37.err.noFeatureKind', { kind }));
    if (hits.length === 1) return ok(hits[0]);
    return ask(msg('cmd37.ask.feature', { kind, count: hits.length }), at, hits.slice(0, MAX_OPTIONS).map((f) => ({ label: featureLabel(f), value: make(f), highlight: { points: [featureCentre(f)] } })));
  }
  const hit = lookupId(all.map((f) => f.id), id);
  if (hit && 'id' in hit) return ok(all.find((f) => f.id === hit.id)!);
  return err(msg('cmd37.err.unknownFeature', { id, known: all.map((f) => f.id).sort(natural).slice(0, 12).join(', ') || '—' }));
}

// ── Places ───────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  z: number;
}

/** Clear gap left between an object-like base and what is put "north of" / "next to" it (m), when none is said. */
export const DEFAULT_GAP = 2;
/** Distance from a point base (a node, coordinates) when none is said (m). */
export const DEFAULT_OFFSET = 10;

const DIR: Record<'north' | 'south' | 'east' | 'west', [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** The objects a place reference stands for (an object, the selection, a group …), or null when it is a bare point. */
function placeObjects(ref: PlaceRef, env: Env): Resolved<WorldObject[]> | null {
  const { doc, ctx } = env;
  switch (ref.p) {
    case 'object': {
      const hit = lookupId(Object.keys(doc.objects), ref.id);
      if (!hit) return err(msg('cmd37.err.unknownId', { id: ref.id }));
      if ('many' in hit) return ask(msg('cmd37.ask.id', { id: ref.id, count: hit.many.length }), ref, sortIds(doc, hit.many).slice(0, MAX_OPTIONS).map((id) => ({ label: objectLabel(doc.objects[id]), value: { p: 'object', id }, highlight: { ids: [id] } })));
      return ok([doc.objects[hit.id]]);
    }
    case 'selection': {
      const ids = sortIds(doc, expandGroups(doc, ctx.selection));
      return ids.length ? ok(ids.map((id) => doc.objects[id])) : err(msg('cmd37.err.noSelection'));
    }
    case 'last': {
      const ids = sortIds(doc, ctx.results[ctx.results.length - 1] ?? []);
      return ids.length ? ok(ids.map((id) => doc.objects[id])) : err(msg('cmd37.err.noLast'));
    }
    case 'group': return groupByName(ref.name, ref, env, 'place');
    case 'groupId': return groupById(ref.id, env);
    case 'name': return byName(ref.name, ref, env, 'place');
    default: return null;
  }
}

/** Bounds of footprints on the ground: [x0, z0, x1, z1]. */
export function footprintBounds(objs: readonly WorldObject[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const o of objs) {
    const [x, , z] = o.transform.position;
    const hx = footprintHalf(o, 0), hz = footprintHalf(o, 2);
    x0 = Math.min(x0, x - hx); x1 = Math.max(x1, x + hx);
    z0 = Math.min(z0, z - hz); z1 = Math.max(z1, z + hz);
  }
  return [x0, z0, x1, z1];
}

/**
 * A place → a ground point. `clear`: half extent (m) of what will be put there, used by "north of" / "next to" so that
 * it ends up clear of the base. Does not check the world bounds (the caller knows the size of what it places).
 */
export function resolvePlace(ref: PlaceRef, env: Env, clear = 0): Resolved<Point> {
  const { doc, ctx } = env;
  switch (ref.p) {
    case 'xz': return ok({ x: ref.x, z: ref.z });
    case 'center': return ok({ x: 0, z: 0 });
    case 'cursor': return ctx.cursor ? ok({ x: ctx.cursor[0], z: ctx.cursor[1] }) : err(msg('cmd37.err.noCursor'));
    case 'view': return ctx.view ? ok({ x: ctx.view[0], z: ctx.view[1] }) : err(msg('cmd37.err.noView'));
    case 'node': {
      const hit = lookupId(Object.keys(doc.roads.nodes), ref.id);
      if (!hit || 'many' in hit) return err(msg('cmd37.err.unknownNode', { id: ref.id, known: Object.keys(doc.roads.nodes).sort(natural).slice(0, 16).join(', ') || '—' }));
      const n = doc.roads.nodes[hit.id];
      return ok({ x: n.x, z: n.z });
    }
    case 'seg': {
      const hit = lookupId(Object.keys(doc.roads.segments), ref.id);
      if (!hit || 'many' in hit) return err(msg('cmd37.err.unknownSegment', { id: ref.id, known: Object.keys(doc.roads.segments).sort(natural).slice(0, 16).join(', ') || '—' }));
      const line = segmentLine(doc.roads, doc.roads.segments[hit.id]);
      const p = pointAt(line, line.length * ref.t);
      return ok({ x: p.x, z: p.z });
    }
    case 'junction': {
      const nodes = junctions(doc.roads);
      if (!nodes.length) return err(msg('cmd37.err.noJunction'));
      if (nodes.length === 1) return ok({ x: nodes[0].x, z: nodes[0].z }, [msg('cmd37.note.junction', { id: nodes[0].id })]);
      return ask(msg('cmd37.ask.junction', { count: nodes.length }), ref, nodes.slice(0, MAX_OPTIONS).map((n) => ({ label: msg('cmd37.opt.node', { id: n.id, x: r1(n.x), z: r1(n.z), roads: n.degree }), value: { p: 'node', id: n.id }, highlight: { nodes: [n.id] } })));
    }
    case 'feature': {
      const f = feature(ref.id, ref, env, (x) => ({ p: 'feature', id: x.id }));
      if (!f.ok) return f;
      const [x, z] = featureCentre(f.value);
      return ok({ x, z }, f.notes);
    }
    case 'object': case 'selection': case 'last': case 'group': case 'groupId': case 'name': {
      const objs = placeObjects(ref, env)!;
      if (!objs.ok) return objs;
      const p = selectionPivot(objs.value);
      return ok({ x: p.x, z: p.z }, objs.notes);
    }
    case 'dir': case 'next': {
      // "Next to" = east of it (shown in the summary); a direction = that side.
      const [dx, dz] = DIR[ref.p === 'dir' ? ref.dir : 'east'];
      const dist = ref.p === 'dir' ? ref.dist : undefined;
      const objs = placeObjects(ref.of, env);
      if (objs) {
        if (!objs.ok) return objs;
        // From the edge of the footprints, with a clear gap, to the centre of what is placed.
        const [x0, z0, x1, z1] = footprintBounds(objs.value);
        const gap = dist ?? DEFAULT_GAP;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const notes = [...objs.notes, ...(dist === undefined ? [msg('cmd37.note.defaultGap', { gap })] : []), ...(ref.p === 'next' ? [msg('cmd37.note.nextEast')] : [])];
        return ok({ x: dx ? cx + dx * ((x1 - x0) / 2 + gap + clear) : cx, z: dz ? cz + dz * ((z1 - z0) / 2 + gap + clear) : cz }, notes);
      }
      const base = resolvePlace(ref.of, env, clear);
      if (!base.ok) return base;
      const d = dist ?? DEFAULT_OFFSET;
      const notes = [...base.notes, ...(dist === undefined ? [msg('cmd37.note.defaultOffset', { dist: d })] : []), ...(ref.p === 'next' ? [msg('cmd37.note.nextEast')] : [])];
      return ok({ x: base.value.x + dx * d, z: base.value.z + dz * d }, notes);
    }
  }
}

/** Whether a point is inside the world square (the same bound the numeric fields and placement use). */
export const insideWorld = (p: Point): boolean => Math.abs(p.x) <= WORLD_HALF && Math.abs(p.z) <= WORLD_HALF;

// ── Roads ────────────────────────────────────────────────────────────────────────────

export interface RoadPart {
  seg: RoadSegment;
  /** The run goes through this segment from its node b to its node a. */
  reversed: boolean;
}

/** A stretch of road: segments end to end, in travel order. */
export interface RoadRun {
  parts: RoadPart[];
  from: string;
  to: string;
}

interface NodeInfo {
  id: string;
  x: number;
  z: number;
  degree: number;
}

/** Nodes where three or more segments meet, by id. */
export function junctions(net: RoadNetwork): NodeInfo[] {
  const deg = new Map<string, number>();
  for (const s of Object.values(net.segments)) {
    deg.set(s.a, (deg.get(s.a) ?? 0) + 1);
    deg.set(s.b, (deg.get(s.b) ?? 0) + 1);
  }
  return [...deg.entries()].filter(([, d]) => d >= 3).map(([id, degree]) => ({ id, x: net.nodes[id].x, z: net.nodes[id].z, degree })).sort((a, b) => natural(a.id, b.id));
}

/** Unit vector along a segment, leaving one of its end nodes. */
function leaving(net: RoadNetwork, s: RoadSegment, node: string): [number, number] {
  const pts = segmentPoints(net, s);
  const [p, q] = s.a === node ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
  const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
}

/** A road goes on through a junction only into a segment of the same profile that is at most this far from straight. */
const THROUGH_ANGLE = (45 * Math.PI) / 180;

/**
 * Which segments continue into which at a node, among the segments of a set: where two meet, each other (also across a
 * change of width); where more meet (a T, a crossing), the pairs of the same profile that are each other's straightest
 * continuation — the main street goes on through its T, the side street ends there.
 */
function throughPairs(net: RoadNetwork, node: string, segs: readonly RoadSegment[]): Map<string, RoadSegment> {
  const out = new Map<string, RoadSegment>();
  if (segs.length === 2) {
    out.set(segs[0].id, segs[1]);
    out.set(segs[1].id, segs[0]);
    return out;
  }
  if (segs.length < 2) return out;
  const dir = new Map(segs.map((x) => [x.id, leaving(net, x, node)]));
  const best = new Map<string, RoadSegment>();
  for (const x of segs) {
    let hit: RoadSegment | null = null, turn = THROUGH_ANGLE;
    for (const y of segs) {
      if (y === x || y.profile.lanes !== x.profile.lanes || y.profile.width !== x.profile.width) continue;
      const [ax, az] = dir.get(x.id)!, [bx, bz] = dir.get(y.id)!;
      // Straight on = the two leave the node in opposite directions.
      const t = Math.acos(Math.min(1, Math.max(-1, -(ax * bx + az * bz))));
      if (t < turn - 1e-9) { turn = t; hit = y; }
    }
    if (hit) best.set(x.id, hit);
  }
  for (const x of segs) {
    const y = best.get(x.id);
    if (y && best.get(y.id) === x) out.set(x.id, y);
  }
  return out;
}

/**
 * The chains a set of segments forms: maximal runs that go on through nodes (see throughPairs; roads that are not in
 * the set do not count). Each run starts at its west end (north end when it runs north–south), so "left" and "right"
 * do not depend on the order the road was drawn in.
 */
export function chainsOf(net: RoadNetwork, ids: readonly string[]): RoadRun[] {
  const set = [...ids].sort(natural).map((id) => net.segments[id]);
  const at = new Map<string, RoadSegment[]>();
  for (const s of set) for (const n of [s.a, s.b]) (at.get(n) ?? at.set(n, []).get(n)!).push(s);
  const pairs = new Map([...at.entries()].map(([node, segs]) => [node, throughPairs(net, node, segs)]));
  const used = new Set<string>();
  const runs: RoadRun[] = [];
  for (const start of set) {
    if (used.has(start.id)) continue;
    used.add(start.id);
    const parts: RoadPart[] = [{ seg: start, reversed: false }];
    /** Follow the road from `node`, where `seg` ends; returns the node the run ends at. */
    const grow = (seg: RoadSegment, from: string, push: (p: RoadPart) => void): string => {
      let node = from, cur = seg;
      for (;;) {
        const next = pairs.get(node)?.get(cur.id);
        if (!next || used.has(next.id)) return node;
        used.add(next.id);
        const reversed = next.b === node;
        push({ seg: next, reversed });
        node = reversed ? next.a : next.b;
        cur = next;
      }
    };
    const end = grow(start, start.b, (p) => parts.push(p));
    const head: RoadPart[] = [];
    // (walking back from node a: each part is entered at its far end → stored flipped, in front)
    const begin = grow(start, start.a, (p) => head.unshift({ seg: p.seg, reversed: !p.reversed }));
    let run: RoadRun = { parts: [...head, ...parts], from: begin, to: end };
    const a = net.nodes[run.from], b = net.nodes[run.to];
    if (a.x > b.x || (a.x === b.x && a.z > b.z)) run = { parts: run.parts.map((p) => ({ seg: p.seg, reversed: !p.reversed })).reverse(), from: run.to, to: run.from };
    runs.push(run);
  }
  return runs;
}

export const runLength = (net: RoadNetwork, run: RoadRun): number => run.parts.reduce((s, p) => s + segmentLine(net, p.seg).length, 0);

function runLabel(net: RoadNetwork, run: RoadRun): Msg {
  const p = run.parts[0].seg.profile;
  return msg('cmd37.opt.road', { from: run.from, to: run.to, ids: run.parts.map((x) => x.seg.id).join(' '), length: Math.round(runLength(net, run)), lanes: p.lanes, width: p.width });
}

/** The reference that names a run exactly. */
const runRef = (run: RoadRun): RoadRef => (run.parts.length === 1 ? { r: 'seg', id: run.parts[0].seg.id } : { r: 'between', a: run.from, b: run.to });

function pickRun(net: RoadNetwork, runs: RoadRun[], at: object, question: Msg): Resolved<RoadRun> {
  if (runs.length === 1) return ok(runs[0]);
  return ask(question, at, runs.slice(0, MAX_OPTIONS).map((run) => ({ label: runLabel(net, run), value: runRef(run), highlight: { segments: run.parts.map((p) => p.seg.id) } })));
}

/** Fewest-segments path between two nodes (ties: smaller segment ids first). */
function pathBetween(net: RoadNetwork, a: string, b: string): RoadPart[] | null {
  const segs = Object.values(net.segments).sort((x, y) => natural(x.id, y.id));
  const prev = new Map<string, { node: string; part: RoadPart }>();
  const seen = new Set([a]);
  let frontier = [a];
  while (frontier.length && !seen.has(b)) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const s of segs) {
        const other = s.a === node ? s.b : s.b === node ? s.a : null;
        if (other === null || seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { node, part: { seg: s, reversed: s.b === node } });
        next.push(other);
      }
    }
    frontier = next;
  }
  if (!seen.has(b)) return null;
  const parts: RoadPart[] = [];
  for (let n = b; n !== a; n = prev.get(n)!.node) parts.unshift(prev.get(n)!.part);
  return parts;
}

export function resolveRoad(ref: RoadRef, env: Env): Resolved<RoadRun> {
  const net = env.doc.roads;
  const ids = Object.keys(net.segments);
  if (!ids.length) return err(msg('cmd37.err.noRoads'));
  switch (ref.r) {
    case 'seg': {
      const hit = lookupId(ids, ref.id);
      if (!hit || 'many' in hit) return err(msg('cmd37.err.unknownSegment', { id: ref.id, known: ids.sort(natural).slice(0, 16).join(', ') }));
      const seg = net.segments[hit.id];
      return ok({ parts: [{ seg, reversed: false }], from: seg.a, to: seg.b });
    }
    case 'between': {
      const nodes = Object.keys(net.nodes);
      const a = lookupId(nodes, ref.a), b = lookupId(nodes, ref.b);
      for (const [hit, id] of [[a, ref.a], [b, ref.b]] as const) if (!hit || 'many' in hit) return err(msg('cmd37.err.unknownNode', { id, known: nodes.sort(natural).slice(0, 16).join(', ') }));
      const from = (a as { id: string }).id, to = (b as { id: string }).id;
      if (from === to) return err(msg('cmd37.err.sameNode', { id: from }));
      const parts = pathBetween(net, from, to);
      return parts ? ok({ parts, from, to }) : err(msg('cmd37.err.noPath', { a: from, b: to }));
    }
    case 'main': {
      // The widest roads: most lanes, then the widest carriageway.
      let best: [number, number] = [-1, -1];
      for (const s of Object.values(net.segments)) if (s.profile.lanes > best[0] || (s.profile.lanes === best[0] && s.profile.width > best[1])) best = [s.profile.lanes, s.profile.width];
      const widest = Object.values(net.segments).filter((s) => s.profile.lanes === best[0] && s.profile.width === best[1]).map((s) => s.id);
      return pickRun(net, chainsOf(net, widest), ref, msg('cmd37.ask.mainRoad'));
    }
    case 'any': return pickRun(net, chainsOf(net, ids), ref, msg('cmd37.ask.road'));
    case 'nearest': {
      const p = resolvePlace(ref.at, env);
      if (!p.ok) return p;
      let hit: RoadSegment | null = null, d = Infinity;
      for (const id of ids.sort(natural)) {
        const dist = nearest(segmentLine(net, net.segments[id]), p.value.x, p.value.z).dist;
        if (dist < d) { d = dist; hit = net.segments[id]; }
      }
      return ok({ parts: [{ seg: hit!, reversed: false }], from: hit!.a, to: hit!.b }, [...p.notes, msg('cmd37.note.nearestRoad', { id: hit!.id, dist: r1(d) })]);
    }
  }
}

// ── Targets ──────────────────────────────────────────────────────────────────────────

const warningCache = new WeakMap<BuildingDesign, AnalysisWarning[]>();

/** Structural analysis warnings of a building's design (cached per design: designs are shared immutable values). */
export function designWarnings(o: WorldObject): AnalysisWarning[] {
  if (!o.building) return [];
  let w = warningCache.get(o.building);
  if (!w) warningCache.set(o.building, (w = analyzeBuilding(o.building).warnings));
  return w;
}

export const floorsOf = (o: WorldObject): number | null => {
  if (o.type !== 'building') return null;
  const f = o.building ? o.building.spec.floors : Number((o.params as { floors?: number }).floors);
  return Number.isFinite(f) ? f : null;
};

export const heightOf = (o: WorldObject): number => getDefinition(o.type).getDimensions(o.params)[1] * o.transform.scale[1];
export const footprintArea = (o: WorldObject): number => {
  const d = getDefinition(o.type).getDimensions(o.params);
  return d[0] * o.transform.scale[0] * d[2] * o.transform.scale[2];
};

const compare = (a: number, op: CompareOp, b: number): boolean => (op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : a === b);

/** Whether an object's centre is on the carriageway of one of the segments. */
function onRoad(o: WorldObject, net: RoadNetwork, segs: readonly RoadSegment[]): boolean {
  const [x, , z] = o.transform.position;
  for (const s of segs) {
    const line = segmentLine(net, s);
    const h = nearest(line, x, z);
    if (h.dist <= sectionAt(net, s, h.s).w) return true;
  }
  return false;
}

function applyPredicate(objs: WorldObject[], p: Predicate, env: Env): Resolved<WorldObject[]> {
  switch (p.f) {
    case 'floors': return ok(objs.filter((o) => { const f = floorsOf(o); return f !== null && compare(f, p.op, p.v); }));
    case 'height': return ok(objs.filter((o) => compare(heightOf(o), p.op, p.v)));
    case 'slope': return ok(objs.filter((o) => compare(env.terrain.flat ? 0 : env.terrain.sampleSlope(o.transform.position[0], o.transform.position[2]), p.op, p.v)));
    case 'near': {
      const at = resolvePlace(p.at, env);
      if (!at.ok) return at;
      return ok(objs.filter((o) => Math.hypot(o.transform.position[0] - at.value.x, o.transform.position[2] - at.value.z) <= p.r), at.notes);
    }
    case 'onRoad': {
      if (!p.road) return ok(objs.filter((o) => onRoad(o, env.doc.roads, Object.values(env.doc.roads.segments))));
      const run = resolveRoad(p.road, env);
      if (!run.ok) return run;
      return ok(objs.filter((o) => onRoad(o, env.doc.roads, run.value.parts.map((x) => x.seg))), run.notes);
    }
    case 'hidden': return ok(objs.filter((o) => o.hidden));
    case 'visible': return ok(objs.filter((o) => !o.hidden));
    case 'locked': return ok(objs.filter((o) => o.locked));
    case 'unlocked': return ok(objs.filter((o) => !o.locked));
    case 'warning': {
      const code = p.code ? lower(p.code) : null;
      return ok(objs.filter((o) => designWarnings(o).some((w) => (code ? lower(w.code).startsWith(code) : w.level !== 'info'))));
    }
  }
}

export interface TargetSet {
  objects: WorldObject[];
  /** The target was named explicitly (ids, the selection, a result set, a `hidden` / `locked` filter) — not swept up by kind. */
  explicit: boolean;
  /** A rank without a limit ended in a tie between these objects (the caller decides: all of them, or a question). */
  tie: WorldObject[] | null;
}

/**
 * A target → its objects, in command order (context.ts). Empty sets are errors: a command about nothing does not run —
 * except for the questions "how many …?" / "which …?" (`allowEmpty`), whose answer is then 0 / an empty list.
 */
export function resolveTarget(ref: TargetRef, env: Env, opts: { allowEmpty?: boolean } = {}): Resolved<TargetSet> {
  const { doc, ctx } = env;
  const notes: Msg[] = [];
  let objs: WorldObject[];
  let explicit = true;
  const b = ref.base;
  const fromIds = (ids: readonly EntityId[]) => sortIds(doc, ids).map((id) => doc.objects[id]);
  switch (b.b) {
    case 'selection':
      objs = fromIds(expandGroups(doc, ctx.selection));
      if (!objs.length) return err(msg('cmd37.err.noSelection'));
      break;
    case 'last':
      objs = fromIds(ctx.results[ctx.results.length - 1] ?? []);
      if (!objs.length) return err(msg('cmd37.err.noLast'));
      break;
    case 'it': {
      const sel = fromIds(expandGroups(doc, ctx.selection));
      objs = sel.length ? sel : fromIds(ctx.results[ctx.results.length - 1] ?? []);
      if (!objs.length) return err(msg('cmd37.err.noIt'));
      notes.push(msg(sel.length ? 'cmd37.note.itSelection' : 'cmd37.note.itLast', { count: objs.length }));
      break;
    }
    case 'all':
      objs = [...orderedObjects(doc)];
      explicit = false;
      break;
    case 'id': {
      const hit = lookupId(Object.keys(doc.objects), b.id);
      if (!hit) return err(msg('cmd37.err.unknownId', { id: b.id }));
      if ('many' in hit) return ask(msg('cmd37.ask.id', { id: b.id, count: hit.many.length }), b, fromIds(hit.many).slice(0, MAX_OPTIONS).map((o) => ({ label: objectLabel(o), value: { b: 'id', id: o.id }, highlight: { ids: [o.id] } })));
      objs = [doc.objects[hit.id]];
      break;
    }
    case 'group': {
      const g = groupByName(b.name, b, env, 'target');
      if (!g.ok) return g;
      objs = g.value;
      break;
    }
    case 'groupId': {
      const g = groupById(b.id, env);
      if (!g.ok) return g;
      objs = g.value;
      break;
    }
    case 'name': {
      const n = byName(b.name, b, env, 'target');
      if (!n.ok) return n;
      objs = n.value;
      break;
    }
    case 'type': {
      const type = canonicalType(b.type);
      if (!type) return err(msg('cmd37.err.unknownType', { type: b.type, known: KIND_TYPES.join(', ') }));
      if (b.preset === undefined) objs = orderedObjects(doc).filter((o) => o.type === type);
      else {
        const kind = findKind(type, b.preset);
        if (!kind) return err(msg('cmd37.err.unknownPreset', { type, preset: b.preset }));
        objs = orderedObjects(doc).filter((o) => isOfKind(o, kind));
        if (!presetIsExact(kind)) notes.push(msg('cmd37.note.presetInexact', { kind: kind.key, type }));
      }
      explicit = false;
      break;
    }
  }
  for (const p of ref.where ?? []) {
    const r = applyPredicate(objs, p, env);
    if (!r.ok) return r;
    objs = r.value;
    notes.push(...r.notes);
    if (p.f === 'hidden' || p.f === 'locked') explicit = true;
  }
  let tie: WorldObject[] | null = null;
  if (ref.rank && objs.length) {
    const rank = ref.rank;
    let score: (o: WorldObject) => number;
    if (rank.by === 'nearest') {
      const at = resolvePlace(rank.at, env);
      if (!at.ok) return at;
      notes.push(...at.notes);
      score = (o) => -Math.hypot(o.transform.position[0] - at.value.x, o.transform.position[2] - at.value.z);
    } else score = rank.by === 'tallest' ? heightOf : footprintArea;
    // Best first; equal scores stay in command order (the sort is stable).
    const scored = objs.map((o) => ({ o, s: score(o) })).sort((x, y) => y.s - x.s);
    if (ref.first === undefined) {
      const best = scored.filter((x) => x.s === scored[0].s).map((x) => x.o);
      if (best.length > 1) tie = best;
      objs = best;
    } else objs = scored.map((x) => x.o);
  }
  if (ref.first !== undefined) objs = objs.slice(0, ref.first);
  if (!objs.length && !opts.allowEmpty) return err(msg('cmd37.err.noMatch'));
  return ok({ objects: objs, explicit, tie }, notes);
}

/** The question for a rank that ended in a tie (editing commands ask; read-only ones take all of them). */
export function tieQuestion(ref: TargetRef, tie: readonly WorldObject[]): Clarify {
  return {
    question: msg('cmd37.ask.tie', { count: tie.length }),
    at: ref,
    options: tie.slice(0, MAX_OPTIONS).map((o) => ({ label: objectLabel(o), value: { base: { b: 'id', id: o.id } } satisfies TargetRef, highlight: { ids: [o.id] } })),
  };
}

// ── Areas ────────────────────────────────────────────────────────────────────────────

function boxOf(shapes: readonly Shape[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const add = (x: number, z: number, r = 0) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); };
  for (const s of shapes) {
    if (s.k === 'circle') add(s.x, s.z, s.r);
    else if (s.k === 'rect') { add(s.x0, s.z0); add(s.x1, s.z1); }
    else for (const p of s.points) add(p[0], p[1], s.k === 'path' ? s.half : 0);
  }
  return [x0, z0, x1, z1];
}

export function areaContains(a: Area, x: number, z: number): boolean {
  for (const s of a.shapes) {
    if (s.k === 'circle') { if (Math.hypot(x - s.x, z - s.z) <= s.r) return true; }
    else if (s.k === 'rect') { if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return true; }
    else if (s.k === 'poly') {
      let inside = false;
      for (let i = 0, j = s.points.length - 1; i < s.points.length; j = i++) {
        const [xi, zi] = s.points[i], [xj, zj] = s.points[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    } else {
      for (let i = 1; i < s.points.length; i++) {
        const [ax, az] = s.points[i - 1], [bx, bz] = s.points[i];
        const dx = bx - ax, dz = bz - az;
        const w = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
        if (Math.hypot(x - (ax + dx * w), z - (az + dz * w)) <= s.half) return true;
      }
    }
  }
  return false;
}

/** Area of the bounding box clipped to the world (m²) — the measure the safety limits use. */
export function areaExtent(a: Area): number {
  const x0 = Math.max(-WORLD_HALF, a.box[0]), x1 = Math.min(WORLD_HALF, a.box[2]);
  const z0 = Math.max(-WORLD_HALF, a.box[1]), z1 = Math.min(WORLD_HALF, a.box[3]);
  return Math.max(0, x1 - x0) * Math.max(0, z1 - z0);
}

export function resolveArea(ref: AreaRef, env: Env): Resolved<Area> {
  const make = (shapes: Shape[], notes: Msg[] = []): Resolved<Area> => ok({ shapes, box: boxOf(shapes) }, notes);
  switch (ref.a) {
    case 'rect': return make([{ k: 'rect', x0: Math.min(ref.x0, ref.x1), z0: Math.min(ref.z0, ref.z1), x1: Math.max(ref.x0, ref.x1), z1: Math.max(ref.z0, ref.z1) }]);
    case 'circle': {
      const at = resolvePlace(ref.at, env);
      if (!at.ok) return at;
      return make([{ k: 'circle', x: at.value.x, z: at.value.z, r: ref.r }], at.notes);
    }
    case 'around': {
      const t = resolveTarget(ref.target, env);
      if (!t.ok) return t;
      // Around each footprint: its bounding circle grown by r.
      return make(t.value.objects.map((o) => ({ k: 'circle' as const, x: o.transform.position[0], z: o.transform.position[2], r: Math.hypot(footprintHalf(o, 0), footprintHalf(o, 2)) + ref.r })), t.notes);
    }
    case 'feature': {
      const f = feature(ref.id, ref, env, (x) => ({ a: 'feature', id: x.id }));
      if (!f.ok) return f;
      const shape = featureShape(f.value);
      return shape ? make([shape], f.notes) : err(msg('cmd37.err.featureNoArea', { kind: f.value.kind, id: f.value.id }));
    }
  }
}

// ── Placed disasters ─────────────────────────────────────────────────────────────────

export function resolveInstances(ref: InstanceRef, env: Env): Resolved<PhenomenonInstance[]> {
  const all = env.doc.scenario.experiment?.instances ?? [];
  if (!all.length) return err(msg('cmd37.err.noInstances'));
  if (ref.i === 'all') return ok([...all]);
  if (ref.i === 'id') {
    const hit = all.find((x) => lower(x.id) === lower(ref.id));
    return hit ? ok([hit]) : err(msg('cmd37.err.unknownInstance', { id: ref.id, known: all.map((x) => x.id).join(', ') }));
  }
  const types = [...new Set(all.map((x) => x.type))];
  const type = types.find((t) => lower(t) === lower(ref.type));
  const of = type ? all.filter((x) => x.type === type) : [];
  if (!of.length) return err(msg('cmd37.err.noInstanceOfType', { type: ref.type, known: all.map((x) => `${x.id} ${x.type}`).join(', ') }));
  const label = (x: PhenomenonInstance): ClarifyOption => ({ label: msg('cmd37.opt.instance', { id: x.id, type: x.type }), value: { i: 'id', id: x.id } satisfies InstanceRef, highlight: { instances: [x.id] } });
  if (ref.nth === undefined) return of.length === 1 ? ok(of) : ask(msg('cmd37.ask.instance', { type: type!, count: of.length }), ref, of.slice(0, MAX_OPTIONS).map(label));
  // "#3" can be the instance id p3 or the third of the type: the same instance → fine; two different → ask.
  const byId = of.find((x) => x.id === `p${ref.nth}`);
  const byOrder = of[ref.nth - 1];
  if (byId && byOrder && byId !== byOrder) return ask(msg('cmd37.ask.instanceNth', { type: type!, n: ref.nth }), ref, [label(byId), label(byOrder)]);
  const hit = byId ?? byOrder;
  return hit ? ok([hit]) : err(msg('cmd37.err.noInstanceNth', { type: type!, n: ref.nth, count: of.length }));
}
