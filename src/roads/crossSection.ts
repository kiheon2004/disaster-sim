/**
 * Road cross-section (Phase 35.5): ONE description of a road's width that every part reads — the mesh (lanes, shoulders,
 * markings), the terrain bake and junctions (carriageway `width` + sidewalks, unchanged), the vehicle lane centres and the
 * palette. A road profile stores the carriageway width (curb to curb) and the lane count as before; shoulders and a median
 * are optional (absent = 0, which is exactly the geometry of every road made before Phase 35.5 — old files are unchanged).
 *
 *   carriageway = lanes × laneWidth + 2 × shoulderWidth + medianWidth      total = carriageway + sidewalks
 *
 * Presets: the same preset gives the same section wherever a road is made (road tool, palette, default world, templates).
 *
 * Phase 36: `sectionAt` is the section at a station of a segment — the profile's own section, except inside a width
 * transition (see below), and every part that needs a width (mesh, bake, runtime gutters, lanes, outlines) reads it.
 */
import { intersectionsOf } from './intersections';
import { ROAD_MATERIAL_PROPS } from './materials';
import { nodeDirections, segmentLine } from './network';
import type { RoadNetwork, RoadProfile, RoadSegment } from './types';

export interface RoadCrossSection {
  laneCount: number;
  laneWidth: number;
  /** Paved shoulder on each side (m). */
  shoulderWidth: number;
  /** Sidewalk on each side that has one (m). */
  sidewalkWidth: number;
  medianWidth: number;
  /** Curb to curb (m). */
  carriageway: number;
  /** Outer edge to outer edge, sidewalks included (m). */
  totalWidth: number;
}

/** The cross-section of a profile (derived; shoulders / median default to 0). */
export function crossSectionOf(p: RoadProfile): RoadCrossSection {
  const shoulder = p.shoulderWidth ?? 0, median = p.medianWidth ?? 0;
  const sides = p.sidewalk === 'both' ? 2 : p.sidewalk === 'none' ? 0 : 1;
  return {
    laneCount: p.lanes,
    laneWidth: (p.width - 2 * shoulder - median) / p.lanes,
    shoulderWidth: shoulder,
    sidewalkWidth: sides ? p.sidewalkWidth : 0,
    medianWidth: median,
    carriageway: p.width,
    totalWidth: p.width + sides * p.sidewalkWidth,
  };
}

/** Lateral offset (m, + = right of the a→b direction) of the centre of lane i (0 = leftmost). */
export function laneCenter(p: RoadProfile, i: number): number {
  const shoulder = p.shoulderWidth ?? 0, median = p.medianWidth ?? 0;
  if (shoulder === 0 && median === 0) return -p.width / 2 + (p.width / p.lanes) * (i + 0.5);
  const lw = (p.width - 2 * shoulder - median) / p.lanes;
  const left = -p.width / 2 + shoulder;
  return left + lw * (i + 0.5) + (!p.oneWay && i >= p.lanes / 2 ? median : 0);
}

export type CrossSectionId = 'narrow2' | 'normal2' | 'wide2' | 'avenue4';

/** Cross-section presets → road profile fields. normal2 / avenue4 are exactly the road tool's 'street' / 'avenue'. */
export const CROSS_SECTIONS: Record<CrossSectionId, { profile: Partial<RoadProfile>; preset: string }> = {
  narrow2: { preset: 'narrow', profile: { width: 6, lanes: 2, sidewalk: 'both', sidewalkWidth: 1.5, material: 'asphalt', drainage: 'standard' } },
  normal2: { preset: 'street', profile: { width: 7, lanes: 2, sidewalk: 'both', sidewalkWidth: 2, material: 'asphalt', drainage: 'standard' } },
  wide2: { preset: 'wide', profile: { width: 10, lanes: 2, shoulderWidth: 1.5, sidewalk: 'both', sidewalkWidth: 2.5, material: 'asphalt', drainage: 'standard' } },
  avenue4: { preset: 'avenue', profile: { width: 14, lanes: 4, sidewalk: 'both', sidewalkWidth: 3, material: 'asphalt', drainage: 'enhanced' } },
};

/** The preset a profile matches exactly (null = custom). */
export function presetOf(p: RoadProfile): CrossSectionId | null {
  for (const [id, c] of Object.entries(CROSS_SECTIONS) as [CrossSectionId, (typeof CROSS_SECTIONS)[CrossSectionId]][]) {
    const q = c.profile;
    if (q.width === p.width && q.lanes === p.lanes && (q.shoulderWidth ?? 0) === (p.shoulderWidth ?? 0) && (q.medianWidth ?? 0) === (p.medianWidth ?? 0) && q.sidewalkWidth === p.sidewalkWidth && q.sidewalk === p.sidewalk) return id;
  }
  return null;
}

// ── Phase 36: the section at a station, width transitions ─────────────────────────────────────────────────────────────
//
// A profile is constant along its segment, so where a road continued straight into a road of another cross-section (a
// degree-2 node without a junction or bend patch) the two met with a slit in the mesh and a curb-high stair in the baked
// heightfield, which is the vehicle collider. The transition is derived at build time (no saved field): the WIDER segment
// tapers linearly to the narrower section, so curbs, sidewalks, crown, markings and lane centres are continuous at the
// node. Away from a transition `sectionAt` returns exactly the values the profile gave before (same expressions), so a
// network without a width joint bakes and meshes exactly as before.

/** One painted line of the markings (offset + = right of a→b). */
export interface MarkLine {
  /** Identity across a transition: c(entre) / d(ivider) / e(dge), side L / R / 0, rank from the centre. */
  key: string;
  o: number;
  width: number;
  yellow: boolean;
  dashed: boolean;
}

/** The cross-section at one station of a segment, in that segment's frame (+ = right of travel a→b). */
export interface RoadSection {
  /** Carriageway half width (m): the curbs stand at ±w (a profile is symmetric about its centreline). */
  w: number;
  /** Sidewalk width on the left / right (0 = none); the outer edge is at w + sw. */
  swL: number;
  swR: number;
  /** Curb height on the left / right (0 where there is no sidewalk). */
  curbL: number;
  curbR: number;
  shoulder: number;
  median: number;
  /** Crown cross-fall of graded / fixed roads (centreline → curb). */
  fall: number;
  /** Lane centres by the segment's lane index (lateral, m); null where a lane has ended inside a taper (lane drop). */
  lanes: (number | null)[];
  /** Painted lines in drawing order (empty when the road has no markings). */
  lines: MarkLine[];
  /** Weight of the neighbour's section: 0 = this segment's own section (outside a transition), 1 = the neighbour's. */
  blend: number;
}

const sectionCache = new WeakMap<RoadProfile, RoadSection>();

/** The constant section of a profile: exactly the widths, curbs and lines every consumer derived before Phase 36. */
export function nominalSection(p: RoadProfile): RoadSection {
  const hit = sectionCache.get(p);
  if (hit) return hit;
  const hasL = p.sidewalk === 'both' || p.sidewalk === 'left';
  const hasR = p.sidewalk === 'both' || p.sidewalk === 'right';
  const props = ROAD_MATERIAL_PROPS[p.material];
  const s: RoadSection = {
    w: p.width / 2,
    swL: hasL ? p.sidewalkWidth : 0,
    swR: hasR ? p.sidewalkWidth : 0,
    curbL: hasL ? p.curbHeight : 0,
    curbR: hasR ? p.curbHeight : 0,
    shoulder: p.shoulderWidth ?? 0,
    median: p.medianWidth ?? 0,
    fall: props.crossFall,
    lanes: Array.from({ length: p.lanes }, (_, i) => laneCenter(p, i)),
    lines: p.markings && props.marked ? markLines(p) : [],
    blend: 0,
  };
  sectionCache.set(p, s);
  return s;
}

/** The lines of the mesh markings (the Phase 18 / 35.5 rules, same order), keyed for pairing across a taper. */
function markLines(p: RoadProfile): MarkLine[] {
  const out: MarkLine[] = [];
  const w = p.width / 2, lanes = p.lanes, shoulder = p.shoulderWidth ?? 0, median = p.medianWidth ?? 0;
  const line = (key: string, o: number, width: number, yellow = false, dashed = false) => { out.push({ key, o, width, yellow, dashed }); };
  // One-way dividers run from the left edge; their keys rank them from the centre like the two-way ones.
  const oneWay = (o: (k: number) => number) => {
    const offs = Array.from({ length: lanes - 1 }, (_, k) => o(k + 1));
    const sideOf = (v: number) => (v < -1e-9 ? 'L' : v > 1e-9 ? 'R' : '0');
    for (const v of offs) {
      const side = sideOf(v);
      const rank = offs.filter((u) => side !== '0' && sideOf(u) === side && Math.abs(u) < Math.abs(v)).length + 1;
      line(`d${side}${side === '0' ? '' : rank}`, v, 0.12, false, true);
    }
  };
  if (shoulder > 0 || median > 0) {
    const tw = w - shoulder;
    const lw = (2 * tw - median) / lanes;
    if (p.oneWay) oneWay((k) => -tw + lw * k);
    else {
      if (median > 0) { line('cL', -median / 2, 0.12, true); line('cR', median / 2, 0.12, true); }
      else if (lanes >= 2) { line('cL', -0.11, 0.1, true); line('cR', 0.11, 0.1, true); }
      const perDir = Math.floor(lanes / 2);
      for (let k = 1; k < perDir; k++) { line(`dR${k}`, median / 2 + lw * k, 0.12, false, true); line(`dL${k}`, -median / 2 - lw * k, 0.12, false, true); }
    }
    line('eL', -tw, 0.15);
    line('eR', tw, 0.15);
    return out;
  }
  const laneW = (2 * w) / lanes;
  if (p.oneWay) oneWay((k) => -w + laneW * k);
  else {
    if (lanes >= 2) { line('cL', -0.11, 0.1, true); line('cR', 0.11, 0.1, true); }
    const perDir = Math.floor(lanes / 2);
    for (let k = 1; k < perDir; k++) { line(`dR${k}`, laneW * k, 0.12, false, true); line(`dL${k}`, -laneW * k, 0.12, false, true); }
  }
  if (w > 2) { line('eL', -w + 0.25, 0.12); line('eR', w - 0.25, 0.12); }
  return out;
}

/** The same section seen in the opposite travel direction (left ↔ right). */
function mirrored(s: RoadSection): RoadSection {
  const flip = (k: string) => k[0] + (k[1] === 'L' ? 'R' : k[1] === 'R' ? 'L' : k[1]) + k.slice(2);
  return {
    ...s, swL: s.swR, swR: s.swL, curbL: s.curbR, curbR: s.curbL,
    lanes: s.lanes.map((c) => (c === null ? null : -c)).reverse(),
    lines: s.lines.map((l) => ({ ...l, o: -l.o, key: flip(l.key) })),
  };
}

/** Lanes that continue through the node: same side, paired from the centre outward (the outer lanes of a drop end). */
function pairLanes(own: readonly (number | null)[], other: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = own.map(() => null);
  for (const left of [true, false]) {
    const onSide = (c: number) => (left ? c < 0 : c >= 0);
    const mine = own.flatMap((c, i) => (c !== null && onSide(c) ? [{ c, i }] : [])).sort((a, b) => Math.abs(a.c) - Math.abs(b.c));
    const theirs = other.filter((c): c is number => c !== null && onSide(c)).sort((a, b) => Math.abs(a) - Math.abs(b));
    for (let k = 0; k < Math.min(mine.length, theirs.length); k++) out[mine[k].i] = theirs[k];
  }
  return out;
}

/** Taper length rule (m): at least TAPER_MIN, 10 m per metre of carriageway half-width change, 5 m per metre of outer edge. */
export const TAPER_MIN = 6;
export const TAPER_PER_WIDTH = 10;
export const TAPER_PER_EDGE = 5;
/** A taper uses at most this share of a segment's usable length, so tapers at both ends of a segment never overlap. */
export const TAPER_MAX_SHARE = 0.45;

/** A width transition at a straight degree-2 node. */
export interface Transition {
  node: string;
  /** The wider segment carries the taper; the narrower one keeps its section unless the host is too short (split). */
  host: string;
  narrow: string;
  /** Taper length on the host and on the narrow segment (m; the latter is > 0 only for a split taper). */
  hostLength: number;
  narrowLength: number;
  /** Length the rule asks for (m). */
  wanted: number;
  /** Shorter than the rule even when split (both segments short): reported as a network warning. */
  short: boolean;
}

/** The part of a transition lying on one segment. */
interface TaperPart {
  node: string;
  atStart: boolean;
  /** Length of this part (from the node) and of the whole taper (m). */
  length: number;
  total: number;
  segLength: number;
  /** The neighbour's section in this segment's frame, and this segment's lanes / lines paired with it. */
  other: RoadSection;
  lanes: (number | null)[];
  lines: (MarkLine | undefined)[];
}

interface TransitionSet {
  byNode: Map<string, Transition>;
  parts: Map<string, TaperPart[]>;
}

const transitionCache = new WeakMap<RoadNetwork, TransitionSet>();

/** Same geometry (material / cross-fall alone is not a width joint and keeps its old behaviour). */
const sameSection = (a: RoadSection, b: RoadSection) =>
  a.w === b.w && a.swL === b.swL && a.swR === b.swR && a.curbL === b.curbL && a.curbR === b.curbR && a.shoulder === b.shoulder && a.median === b.median &&
  a.lanes.length === b.lanes.length && a.lanes.every((c, i) => c === b.lanes[i]);

function buildTransitions(n: RoadNetwork): TransitionSet {
  const byNode = new Map<string, Transition>();
  const parts = new Map<string, TaperPart[]>();
  const ints = intersectionsOf(n);
  const usable = (seg: RoadSegment, atStart: boolean) => segmentLine(n, seg).length - (ints.get(atStart ? seg.b : seg.a)?.trim.get(seg.id) ?? 0);
  for (const node of Object.keys(n.nodes).sort()) {
    // Junctions and bends have their own patch (intersections.ts); only straight joints taper.
    if (ints.has(node)) continue;
    const dirs = nodeDirections(n, node);
    if (dirs.length !== 2 || dirs[0].segment === dirs[1].segment) continue;
    // One segment's +lateral is the other's −lateral when both start (or both end) at the node.
    const flip = dirs[0].atStart === dirs[1].atStart;
    const sec = dirs.map((d) => nominalSection(d.segment.profile));
    const inFrame = (i: number) => (flip ? mirrored(sec[i]) : sec[i]);
    if (sameSection(sec[0], inFrame(1))) continue;
    // Host = the wider carriageway, then the wider total, then more lanes, then the lower id (deterministic).
    const total = (s: RoadSection) => 2 * s.w + s.swL + s.swR;
    const cmp = sec[0].w - sec[1].w || total(sec[0]) - total(sec[1]) || sec[0].lanes.length - sec[1].lanes.length || (dirs[0].segment.id < dirs[1].segment.id ? 1 : -1);
    const [h, k] = cmp > 0 ? [0, 1] : [1, 0];
    const H = sec[h], N = inFrame(k);
    const dEdge = Math.max(Math.abs(H.w + H.swL - (N.w + N.swL)), Math.abs(H.w + H.swR - (N.w + N.swR)));
    const wanted = Math.max(TAPER_MIN, TAPER_PER_WIDTH * Math.abs(H.w - N.w), TAPER_PER_EDGE * dEdge);
    // A host too short for the rule shares the taper with the narrow segment (the section at the node then lies between
    // the two): a gentler slope instead of a steep step on the host alone. Still short of the rule → warning.
    const hostLength = Math.min(wanted, TAPER_MAX_SHARE * usable(dirs[h].segment, dirs[h].atStart));
    const narrowLength = hostLength < wanted ? Math.min(wanted - hostLength, TAPER_MAX_SHARE * usable(dirs[k].segment, dirs[k].atStart)) : 0;
    byNode.set(node, { node, host: dirs[h].segment.id, narrow: dirs[k].segment.id, hostLength, narrowLength, wanted, short: hostLength + narrowLength < wanted - 1e-6 });
    const add = (own: number, oth: number, length: number) => {
      if (length <= 0) return;
      const seg = dirs[own].segment;
      const mine = sec[own], other = inFrame(oth);
      const keyed = new Map(other.lines.map((l) => [l.key, l]));
      const list = parts.get(seg.id) ?? [];
      list.push({
        node, atStart: dirs[own].atStart, length, total: hostLength + narrowLength, segLength: segmentLine(n, seg).length,
        other, lanes: pairLanes(mine.lanes, other.lanes), lines: mine.lines.map((l) => keyed.get(l.key)),
      });
      parts.set(seg.id, list);
    };
    // Frames: `inFrame` maps into dirs[0]'s frame; mirroring is symmetric, so it also maps dirs[0] into dirs[1]'s.
    add(h, k, hostLength);
    add(k, h, narrowLength);
  }
  return { byNode, parts };
}

function transitionSet(n: RoadNetwork): TransitionSet {
  let t = transitionCache.get(n);
  if (!t) transitionCache.set(n, (t = buildTransitions(n)));
  return t;
}

/** Width transitions of a network by node (cached per network object, like `intersectionsOf`). */
export function transitionsOf(n: RoadNetwork): Map<string, Transition> {
  return transitionSet(n).byNode;
}

/** The taper parts lying on a segment (none for almost every road): node, end and length from the node (m). */
export function taperParts(n: RoadNetwork, seg: RoadSegment): readonly { node: string; atStart: boolean; length: number }[] {
  return transitionSet(n).parts.get(seg.id) ?? [];
}

function blendSection(own: RoadSection, part: TaperPart, a: number): RoadSection {
  const o = part.other;
  // x·(1 − a) + y·a is exact at both ends (a = 0 → x, a = 1 → y): the node section equals the neighbour's bit for bit.
  const mix = (x: number, y: number) => x * (1 - a) + y * a;
  const lines: MarkLine[] = [];
  own.lines.forEach((l, i) => {
    const m = part.lines[i];
    if (m) lines.push({ ...l, o: mix(l.o, m.o), width: mix(l.width, m.width) });
  });
  return {
    w: mix(own.w, o.w), swL: mix(own.swL, o.swL), swR: mix(own.swR, o.swR), curbL: mix(own.curbL, o.curbL), curbR: mix(own.curbR, o.curbR),
    shoulder: mix(own.shoulder, o.shoulder), median: mix(own.median, o.median), fall: mix(own.fall, o.fall),
    lanes: own.lanes.map((c, i) => {
      const m = part.lanes[i];
      return c === null || m === null ? null : mix(c, m);
    }),
    lines,
    blend: a,
  };
}

/**
 * The section of a segment at arc length s. Inside a taper part it is linear in the distance from the node between the
 * segment's own section and the neighbour's (equal at the node); everywhere else it is the profile's own section.
 */
export function sectionAt(n: RoadNetwork, seg: RoadSegment, s: number): RoadSection {
  const own = nominalSection(seg.profile);
  const list = transitionSet(n).parts.get(seg.id);
  if (!list) return own;
  for (const p of list) {
    const d = Math.max(0, p.atStart ? s : p.segLength - s);
    if (d < p.length) return blendSection(own, p, (p.length - d) / p.total);
  }
  return own;
}

/** Largest carriageway half width and sidewalk of a segment along its length (null = its profile's: no taper). */
export function sectionExtent(n: RoadNetwork, seg: RoadSegment): { w: number; sw: number } | null {
  const list = transitionSet(n).parts.get(seg.id);
  if (!list) return null;
  const own = nominalSection(seg.profile);
  let w = own.w, sw = Math.max(own.swL, own.swR);
  for (const p of list) { w = Math.max(w, p.other.w); sw = Math.max(sw, p.other.swL, p.other.swR); }
  return { w, sw };
}

/** Arc lengths where a taper starts on a segment (the mesh puts a cross-section there). */
export function taperStations(n: RoadNetwork, seg: RoadSegment): number[] {
  return (transitionSet(n).parts.get(seg.id) ?? []).map((p) => (p.atStart ? p.length : p.segLength - p.length));
}

/** Signature of a segment's transition geometry (mesh dirty tracking: the neighbour's section shapes this segment). */
export function taperSignature(n: RoadNetwork, seg: RoadSegment): string {
  const list = transitionSet(n).parts.get(seg.id);
  if (!list) return '';
  return list.map((p) => `${p.node}:${p.atStart}:${p.length}:${p.total}:${JSON.stringify(p.other)}`).join('|');
}
