/**
 * Phase 37 — planning `place` (§8): new objects of a palette kind at a place, in a row, or along one side of a road.
 *
 * Positions are found with the editor's own pure functions — the snap engine (`snapPoint`: road frontage 1 m behind
 * the sidewalk facing the road, lane centres with the lane's heading), the bulk-placement planner (`planPlacement`:
 * seeded variation, seating on the ground, placement checks) — so a placed object has the values a mouse placement at
 * that spot would have. Outside the world = that item is rejected; overlap / slope / water / wheel contact = warnings.
 */
import type { ObjectParams, WorldObject } from '@/core/model';
import { degToRad, hashString } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import { designParams } from '@/buildings/design';
import { presetDesign } from '@/buildings/presetDesign';
import { hasErrors, presetSpec, validateSpec } from '@/buildings/spec';
import { subSeed } from '@/editor/build/distribution';
import { collisionFootprint, FootprintIndex } from '@/editor/build/footprint';
import { checkPlacement } from '@/editor/build/placementCheck';
import { DEFAULT_PLACEMENT, planPlacement, type PlanItem as PlacementItem, type PlannedObject } from '@/editor/build/placementPlan';
import { footprintHalves, FRONTAGE_SETBACK, snapPoint, type SnapKind } from '@/editor/snap/snapEngine';
import { footprintOnRoad } from '@/roads/city';
import { pointAt, type Centerline } from '@/roads/curve';
import { sectionAt } from '@/roads/crossSection';
import { roadYaw } from '@/roads/links';
import { segmentLine, segmentPoints } from '@/roads/network';
import type { RoadNetwork, RoadSegment } from '@/roads/types';
import type { CreateObjectInput } from '@/world/WorldDocument';
import { msg, type Env, type Msg } from './context';
import { formatCanonical } from './canonical';
import type { IntentOf, Side } from './intent';
import { findKind, type Kind } from './kinds';
import { CONFIRM_ITEMS, MAX_ITEMS, need, PlanStop, stop, type Draft, type PlanItem, type PlanOptions } from './planTypes';
import { DEFAULT_GAP, resolvePlace, resolveRoad, type RoadRun } from './resolve';

/** Clear distance between neighbours along a road when none is said (m), by what is placed. */
export const DEFAULT_ROAD_GAP = { building: 0, car: 3, human: 1.5, other: 2 } as const;
/** How far behind the sidewalk's outer edge things that are not buildings stand (m). */
const VERGE_SETBACK = 0.5;

type Compass = 'north' | 'south' | 'east' | 'west';
const COMPASS: Record<Compass, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** The compass side a unit vector points to (the nearest of the four). */
function compassOf(x: number, z: number): Compass {
  return Math.abs(x) >= Math.abs(z) ? (x >= 0 ? 'east' : 'west') : z >= 0 ? 'south' : 'north';
}

// ── A run of road as one line ────────────────────────────────────────────────────────

interface RunLine {
  /** Start of each part along the run (m), and the total length last. */
  starts: number[];
  lines: Centerline[];
  total: number;
}

function runLine(net: RoadNetwork, run: RoadRun): RunLine {
  const lines = run.parts.map((p) => segmentLine(net, p.seg));
  const starts: number[] = [];
  let total = 0;
  for (const l of lines) { starts.push(total); total += l.length; }
  return { starts, lines, total };
}

interface Station {
  x: number;
  z: number;
  /** Unit tangent in the run's travel direction. */
  tx: number;
  tz: number;
  seg: RoadSegment;
  /** Arc length in the segment's own a → b frame, and whether the run travels it backwards. */
  s: number;
  reversed: boolean;
}

/** The point `d` m along a run. */
function station(run: RoadRun, rl: RunLine, d: number): Station {
  let k = rl.starts.length - 1;
  while (k > 0 && rl.starts[k] > d) k--;
  const part = run.parts[k], line = rl.lines[k];
  const local = Math.min(line.length, Math.max(0, d - rl.starts[k]));
  const s = part.reversed ? line.length - local : local;
  const p = pointAt(line, s);
  const sign = part.reversed ? -1 : 1;
  return { x: p.x, z: p.z, tx: p.tx * sign, tz: p.tz * sign, seg: part.seg, s, reversed: part.reversed };
}

/** The point `lat` m to the RIGHT of travel at a station (negative = left). */
const offset = (st: Station, lat: number) => ({ x: st.x - st.tz * lat, z: st.z + st.tx * lat });

/** Cross-section widths at a station, in the travel frame: carriageway half width, sidewalk right / left of travel. */
function widths(net: RoadNetwork, st: Station) {
  const sec = sectionAt(net, st.seg, st.s);
  return { w: sec.w, swRight: st.reversed ? sec.swL : sec.swR, swLeft: st.reversed ? sec.swR : sec.swL, sec };
}

/**
 * Stretches of a run where nothing is placed on one side (`side` = +1 right of travel, −1 left, 0 = on the
 * carriageway): the mouths of other roads that join there — on that side only, a T on the far side does not count.
 */
function blocked(net: RoadNetwork, run: RoadRun, rl: RunLine, side: 1 | -1 | 0): [number, number][] {
  const own = new Set(run.parts.map((p) => p.seg.id));
  const out: [number, number][] = [];
  const nodes: { id: string; d: number }[] = [{ id: run.from, d: 0 }];
  run.parts.forEach((p, k) => nodes.push({ id: p.reversed ? p.seg.a : p.seg.b, d: rl.starts[k] + rl.lines[k].length }));
  for (const n of nodes) {
    const st = station(run, rl, n.d);
    let reach = 0;
    for (const other of Object.values(net.segments)) {
      if (own.has(other.id) || (other.a !== n.id && other.b !== n.id)) continue;
      const pts = segmentPoints(net, other);
      const [p, q] = other.a === n.id ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      // Which side of the run the other road leaves to (right of travel = (−tz, tx)).
      const toRight = ((q[0] - p[0]) * -st.tz + (q[1] - p[1]) * st.tx) / l;
      if (side !== 0 && toRight * side < 0.2) continue;
      const sec = sectionAt(net, other, other.a === n.id ? 0 : segmentLine(net, other).length);
      reach = Math.max(reach, side === 0 ? sec.w + 1 : sec.w + Math.max(sec.swL, sec.swR) + FRONTAGE_SETBACK);
    }
    if (reach > 0) out.push([n.d - reach, n.d + reach]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// ── Kinds ────────────────────────────────────────────────────────────────────────────

interface Proto {
  kind: Kind;
  item: PlacementItem;
  params: ObjectParams;
  /** Footprint half extents in the object's own frame (x, z). */
  half: [number, number];
}

function proto(i: IntentOf<'place'>): Proto {
  const kind = findKind(i.type, i.preset) ?? stop(msg('cmd37.err.unknownKind', { kind: i.preset ? `${i.type}:${i.preset}` : i.type }));
  if (kind.type === 'road') stop(msg('cmd37.err.placeRoad'));
  const def = getDefinition(kind.type);
  if (i.floors !== undefined && kind.type !== 'building') stop(msg('cmd37.err.floorsNotBuilding', { kind: kind.key }));
  if (kind.item.buildingPreset) {
    const base = presetSpec(kind.item.buildingPreset) ?? stop(msg('cmd37.err.unknownKind', { kind: kind.key }));
    const floors = i.floors ?? base.floors;
    const issues = validateSpec({ ...base, floors });
    if (hasErrors(issues)) stop(msg('cmd37.err.floors', { kind: kind.key, floors }));
    const building = presetDesign(kind.item.buildingPreset, floors) ?? stop(msg('cmd37.err.unknownKind', { kind: kind.key }));
    const params = designParams(building);
    return { kind, item: { type: kind.type, building, randomize: false }, params, half: footprintHalves(kind.type, params) };
  }
  let params: ObjectParams = { ...def.defaultParams, ...(kind.item.params ?? {}) };
  if (i.floors !== undefined) {
    // Legacy box building: floors is one of its parameters (1 … 30).
    if (i.floors > 30) stop(msg('cmd37.err.floors', { kind: kind.key, floors: i.floors }));
    params = { ...params, floors: i.floors };
  }
  return { kind, item: { type: kind.type, params, randomize: !!kind.item.randomize }, params, half: footprintHalves(kind.type, params) };
}

// ── Planning the points ──────────────────────────────────────────────────────────────

interface Spot {
  x: number;
  z: number;
  yaw: number;
  snap?: SnapKind;
  /** Rejected before placement (ended lane, another road's mouth …). */
  reject?: 'endedLane' | 'onRoad' | 'noSidewalk';
}

function sideLabel(run: RoadRun, rl: RunLine, sign: 1 | -1): Compass {
  const st = station(run, rl, rl.total / 2);
  return compassOf(-st.tz * sign, st.tx * sign);
}

/** Which side of the run is meant: +1 right of travel, −1 left; a question when the sentence does not decide it. */
function resolveSide(i: IntentOf<'place'>, env: Env, run: RoadRun, rl: RunLine, required: boolean, notes: Msg[]): 1 | -1 | null {
  const ask = (): never => {
    throw new PlanStop({
      planClarify: {
        question: msg('cmd37.ask.side'),
        options: ([-1, 1] as const).map((sign) => {
          const intent = { ...i, side: (sign > 0 ? 'right' : 'left') as Side };
          return { label: msg('cmd37.opt.side', { compass: `@cmd37.dir.${sideLabel(run, rl, sign)}`, hand: `@cmd37.hand.${sign > 0 ? 'right' : 'left'}` }), intent, canonical: formatCanonical(intent), highlight: { segments: run.parts.map((p) => p.seg.id) } };
        }),
      },
    });
  };
  const side = i.side;
  if (side === undefined) return required ? ask() : null;
  let sign: 1 | -1;
  if (side === 'left' || side === 'right') sign = side === 'right' ? 1 : -1;
  else {
    // A compass side: the side of the run whose outward direction points that way. A road running that way has no
    // such side (its "north" is an end, not a side) — ask.
    const a = env.doc.roads.nodes[run.from], b = env.doc.roads.nodes[run.to];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const right: [number, number] = [-(b.z - a.z) / l, (b.x - a.x) / l];
    const dot = right[0] * COMPASS[side][0] + right[1] * COMPASS[side][1];
    if (Math.abs(dot) < 0.5) return ask();
    sign = dot > 0 ? 1 : -1;
  }
  notes.push(msg('cmd37.note.side', { from: run.from, to: run.to, compass: `@cmd37.dir.${sideLabel(run, rl, sign)}`, hand: `@cmd37.hand.${sign > 0 ? 'right' : 'left'}` }));
  return sign;
}

function alongRoad(i: IntentOf<'place'>, env: Env, p: Proto, notes: Msg[]): { spots: Spot[]; short: boolean } {
  const net = env.doc.roads;
  const run = need(resolveRoad(i.along!, env), notes);
  const rl = runLine(net, run);
  const count = i.count ?? 1;
  const type = p.kind.type;
  const group = type === 'building' ? 'building' : type === 'car' ? 'car' : type === 'human' ? 'human' : 'other';
  const gap = i.gap ?? DEFAULT_ROAD_GAP[group];
  if (i.gap === undefined && count > 1) notes.push(msg('cmd37.note.defaultRoadGap', { gap }));
  // Length a thing takes along the road: buildings and furniture lie with their local x along it, cars with their length.
  const along = 2 * p.half[0];
  const spots: Spot[] = [];
  const side = resolveSide(i, env, run, rl, group === 'building' || group === 'other', notes);
  const blocks = blocked(net, run, rl, group === 'car' ? 0 : (side ?? 1));
  const objects = Object.values(env.doc.objects);
  const off = new Set<SnapKind>(['roadNode', 'objectCenter', 'objectEdge', 'structGrid', 'grid', group === 'car' ? 'roadFront' : 'roadLane']);
  let d = 0;
  let guard = 0;
  while (spots.filter((s) => !s.reject).length < count && guard++ < 4 * MAX_ITEMS) {
    const hit = blocks.find(([b0, b1]) => d < b1 && d + along > b0);
    if (hit) { d = hit[1]; continue; }
    if (d + along > rl.total + 1e-6) break;
    const st = station(run, rl, d + along / 2);
    const wd = widths(net, st);
    if (group === 'building') {
      const q = offset(st, side! * (wd.w + (side! > 0 ? wd.swRight : wd.swLeft) + FRONTAGE_SETBACK + p.half[1]));
      const t = snapPoint({ x: q.x, z: q.z, yaw: 0, half: p.half, type }, { objects, roads: net, grid: 0, disabled: off });
      const yaw = i.heading !== undefined ? degToRad(i.heading) : t.yaw ?? 0;
      const fp = collisionFootprint(type, p.params, [1, 1, 1], t.x, t.z, yaw);
      // (a slot that reaches onto another road is skipped — the next slot is tried further along)
      spots.push({ x: t.x, z: t.z, yaw, snap: t.kind, ...(fp && footprintOnRoad(net, fp, 0) ? { reject: 'onRoad' as const } : {}) });
    } else if (group === 'car') {
      // The kerb lane in the direction of travel (right-hand traffic); `side=left` = the kerb lane of the other
      // direction. Chosen at every station among the lanes that are OPEN there: where a road narrows the outer lanes
      // end (null) and the cars go on in the lane that is the kerb lane from there. A one-way road has all its lanes
      // on the travel side; a station with no open lane on the wanted side gets no car.
      const want = side ?? 1;
      const open = wd.sec.lanes.filter((l): l is number => l !== null).map((l) => (st.reversed ? -l : l));
      const sameSide = open.filter((l) => l * want > 0 || st.seg.profile.oneWay);
      const lat = sameSide.length ? sameSide.sort((a, b) => (want > 0 ? b - a : a - b))[0] : null;
      if (lat === null) spots.push({ x: st.x, z: st.z, yaw: 0, reject: 'endedLane' });
      else {
        const q = offset(st, lat);
        const t = snapPoint({ x: q.x, z: q.z, yaw: 0, half: p.half, type }, { objects, roads: net, grid: 0, disabled: off });
        spots.push({ x: t.x, z: t.z, yaw: i.heading !== undefined ? degToRad(i.heading) : t.yaw ?? roadYaw(st.tx, st.tz), snap: t.kind });
      }
    } else if (group === 'human') {
      // On a sidewalk: the right one unless a side is said; the other when that side has none.
      let sign: 1 | -1 = side ?? 1;
      if ((sign > 0 ? wd.swRight : wd.swLeft) <= 0 && side === null) sign = -sign as 1 | -1;
      const sw = sign > 0 ? wd.swRight : wd.swLeft;
      const q = offset(st, sign * (wd.w + sw / 2));
      // A person's face is local +z: looking along the road.
      spots.push({ x: q.x, z: q.z, yaw: i.heading !== undefined ? degToRad(i.heading) : Math.atan2(st.tx, st.tz), ...(sw <= 0 ? { reject: 'noSidewalk' as const } : {}) });
    } else {
      const q = offset(st, side! * (wd.w + (side! > 0 ? wd.swRight : wd.swLeft) + VERGE_SETBACK + p.half[1]));
      spots.push({ x: q.x, z: q.z, yaw: i.heading !== undefined ? degToRad(i.heading) : roadYaw(st.tx, st.tz) });
    }
    d += along + gap;
  }
  return { spots, short: spots.filter((s) => !s.reject).length < count };
}

function atPlace(i: IntentOf<'place'>, env: Env, p: Proto, notes: Msg[]): Spot[] {
  const count = i.count ?? 1;
  const at = need(resolvePlace(i.at!, env, Math.max(p.half[0], p.half[1])), notes);
  const yaw = i.heading !== undefined ? degToRad(i.heading) : 0;
  if (count === 1) return [{ x: at.x, z: at.z, yaw }];
  // Several at one place: a row from west to east, centred on it.
  const gap = i.gap ?? DEFAULT_GAP;
  const step = 2 * p.half[0] + gap;
  notes.push(msg('cmd37.note.row', { count, gap }));
  return Array.from({ length: count }, (_, k) => ({ x: at.x + (k - (count - 1) / 2) * step, z: at.z, yaw }));
}

/** "Where?" — the places a command can name by itself. */
function askWhere(i: IntentOf<'place'>, env: Env): never {
  const places = [env.ctx.cursor ? 'cursor' : null, env.ctx.view ? 'view' : null, 'center'].filter((x): x is 'cursor' | 'view' | 'center' => x !== null);
  throw new PlanStop({
    planClarify: {
      question: msg('cmd37.ask.where'),
      options: places.map((pl) => {
        const intent = { ...i, at: { p: pl } };
        const pt = pl === 'cursor' ? env.ctx.cursor! : pl === 'view' ? env.ctx.view! : ([0, 0] as const);
        return { label: msg(`cmd37.opt.place.${pl}`, { x: Math.round(pt[0] * 10) / 10, z: Math.round(pt[1] * 10) / 10 }), intent, canonical: formatCanonical(intent), highlight: { points: [[pt[0], pt[1]] as [number, number]] } };
      }),
    },
  });
}

export function planPlace(i: IntentOf<'place'>, env: Env, o: PlanOptions, d: Draft): void {
  const count = i.count ?? 1;
  if (count > MAX_ITEMS) stop(msg('cmd37.err.tooMany', { count, max: MAX_ITEMS }));
  const p = proto(i);
  if (p.kind.preset && i.preset === undefined) d.notes.push(msg('cmd37.note.defaultPreset', { kind: p.kind.key }));
  let spots: Spot[];
  let short = false;
  if (i.along) ({ spots, short } = alongRoad(i, env, p, d.notes));
  else if (i.at) spots = atPlace(i, env, p, d.notes);
  else return askWhere(i, env);

  const seed = subSeed(o.seed, 'place', hashString(formatCanonical(i)));
  const settings = { ...DEFAULT_PLACEMENT, seed, randomRotation: false, baseYaw: 0, variation: !!p.item.randomize, avoidCollisions: false, slopeLimit: 90 };
  const ctx = { terrain: env.terrain, existing: FootprintIndex.fromObjects(Object.values(env.doc.objects)) };
  const own = new FootprintIndex();
  const inputs: CreateObjectInput[] = [];
  let k = 0;
  for (const s of spots) {
    if (s.reject) {
      d.items.push({ status: 'rejected', x: s.x, z: s.z, reasons: [s.reject], ...(s.snap ? { snap: s.snap } : {}) });
      continue;
    }
    const planned: PlannedObject = planPlacement(p.item, [{ x: s.x, z: s.z, yaw: s.yaw }], settings, ctx, k++, own)[0];
    const reasons: PlanItem['reasons'] = [...planned.warnings];
    if (planned.ok) {
      // The slope is a warning here (the mouse places on slopes too, in orange) — never a silent rejection.
      const check = checkPlacement({ type: p.kind.type, params: planned.input.params ?? p.params, transform: planned.input.transform } as WorldObject, env.terrain, DEFAULT_PLACEMENT.slopeLimit);
      if (check.warnings.includes('slope')) reasons.push('slope');
      inputs.push(planned.input);
      d.items.push({ status: reasons.length ? 'warn' : 'ok', x: s.x, z: s.z, reasons, ...(s.snap ? { snap: s.snap } : {}) });
    } else d.items.push({ status: 'rejected', x: s.x, z: s.z, reasons: [planned.rejected === 'collision' ? 'overlap' : planned.rejected ?? 'outside'], ...(s.snap ? { snap: s.snap } : {}) });
  }
  if (short) d.warnings.push(msg('cmd37.warn.room', { placed: inputs.length, count }));
  const rejected = d.items.filter((x) => x.status === 'rejected').length;
  if (rejected) d.warnings.push(msg('cmd37.warn.rejected', { count: rejected }));
  const warned = d.items.filter((x) => x.status === 'warn').length;
  if (warned) d.warnings.push(msg('cmd37.warn.placement', { count: warned }));
  if (!inputs.length) stop(msg('cmd37.err.nothingPlaced', { count }));
  d.ops.push({ op: 'edit', edit: { add: inputs }, result: 'added' });
  d.counts.create = inputs.length;
  if (inputs.length >= CONFIRM_ITEMS) d.confirm = msg('cmd37.confirm.many', { count: inputs.length });
}
