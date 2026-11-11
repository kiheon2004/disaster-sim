/**
 * Snapping (Phase 36 §13): ONE place that turns a cursor point on the ground into the point (and, for road-bound
 * objects, the heading) an object is placed or dragged to. Used by the place tool and the move gizmo.
 *
 * Candidates, in priority order, each with a tolerance (m, on the ground):
 *
 *   roadNode     3.0   a road node (junction / road end)
 *   roadLane     2.5   vehicles: the nearest lane centre, heading along the lane (travel direction of that lane)
 *   roadFront    3.0   buildings: facing the road, the footprint 1 m behind the sidewalk's outer edge
 *   objectCenter 0.75  another object's centre
 *   objectEdge   0.8   footprint edges flush or touching a neighbour's (also its building outline), per axis, when the
 *                      two headings are parallel (within 3°, modulo 90°)
 *   structGrid   0.8   a footprint edge on a column line of a neighbouring modular building (its bay grid)
 *   grid         —     the grid step (always applies when nothing else does; off = free)
 *
 * The first candidate (by priority) within its tolerance wins. Hysteresis: the target of the previous move keeps
 * winning while it stays within 1.6 × its tolerance, so the cursor does not flicker between two candidates on their
 * border. Per-axis candidates (objectEdge, structGrid) snap one axis and leave the other at the cursor.
 */
import type { EntityId, ObjectType, Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { yawOf } from '@/terrain/groundPlacement';
import type { RoadNetwork } from '@/roads/types';
import { segmentLine } from '@/roads/network';
import { nearest, pointAt } from '@/roads/curve';
import { sectionAt } from '@/roads/crossSection';
import { roadYaw } from '@/roads/links';

export type SnapKind = 'roadNode' | 'roadLane' | 'roadFront' | 'objectCenter' | 'objectEdge' | 'structGrid' | 'grid' | 'free';

export const SNAP_TOLERANCE: Record<SnapKind, number> = {
  roadNode: 3, roadLane: 2.5, roadFront: 3, objectCenter: 0.75, objectEdge: 0.8, structGrid: 0.8, grid: Infinity, free: 0,
};
export const SNAP_PRIORITY: readonly SnapKind[] = ['roadNode', 'roadLane', 'roadFront', 'objectCenter', 'objectEdge', 'structGrid', 'grid'];
/** Previous target keeps winning up to this multiple of its tolerance. */
export const SNAP_HYSTERESIS = 1.6;
/** Setback of a snapped building's footprint behind the sidewalk's outer edge (m). */
export const FRONTAGE_SETBACK = 1;
const NEAR = 40;
const PARALLEL = (3 * Math.PI) / 180;

export interface SnapTarget {
  kind: SnapKind;
  x: number;
  z: number;
  /** Heading the snap asks for (road lanes / frontage), else undefined (keep the object's own). */
  yaw?: number;
  /** What was snapped to (object / node / segment id) — keeps hysteresis on the same target. */
  ref?: string;
  /** Distance from the cursor to the snapped point (m). */
  dist: number;
  /** Per-axis snaps: which axis of the MOVING object's frame the snap moves (0 = its local x, 1 = its local z). */
  axis?: 0 | 1;
}

export interface SnapQuery {
  x: number;
  z: number;
  /** Heading of the moving object (rad). */
  yaw: number;
  /** Footprint half extents of the moving object in its own frame (x, z), scale included. */
  half: [number, number];
  type: ObjectType;
  /** Ids that move with the object (never snap to themselves). */
  exclude?: ReadonlySet<EntityId>;
}

export interface SnapEnv {
  objects: readonly WorldObject[];
  roads: RoadNetwork;
  /** Grid step (m); 0 = no grid (free). */
  grid: number;
  prev?: SnapTarget | null;
  /** Kinds turned off (all on by default). */
  disabled?: ReadonlySet<SnapKind>;
}

const VEHICLES = new Set<ObjectType>(['car']);
const half2 = (o: WorldObject): [number, number] => {
  const d = getDefinition(o.type).getDimensions(o.params);
  return [(d[0] * o.transform.scale[0]) / 2, (d[2] * o.transform.scale[2]) / 2];
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Angle between two headings modulo 90° (0 = parallel or perpendicular). */
const offAxis = (a: number, b: number) => {
  const d = Math.abs(wrap(a - b)) % (Math.PI / 2);
  return Math.min(d, Math.PI / 2 - d);
};

function nodeCandidates(q: SnapQuery, env: SnapEnv, out: SnapTarget[]) {
  for (const [id, n] of Object.entries(env.roads.nodes)) {
    const d = Math.hypot(n.x - q.x, n.z - q.z);
    if (d <= SNAP_TOLERANCE.roadNode * SNAP_HYSTERESIS) out.push({ kind: 'roadNode', x: n.x, z: n.z, ref: id, dist: d });
  }
}

function roadCandidates(q: SnapQuery, env: SnapEnv, out: SnapTarget[]) {
  const building = q.type === 'building';
  const vehicle = VEHICLES.has(q.type);
  if (!building && !vehicle) return;
  for (const seg of Object.values(env.roads.segments)) {
    const line = segmentLine(env.roads, seg);
    const h = nearest(line, q.x, q.z);
    if (h.dist > NEAR) continue;
    const p = pointAt(line, h.s);
    const sec = sectionAt(env.roads, seg, h.s);
    const at = (lateral: number) => ({ x: p.x - p.tz * lateral, z: p.z + p.tx * lateral });
    if (vehicle) {
      sec.lanes.forEach((lat, i) => {
        if (lat === null) return;
        const pt = at(lat);
        const dir = seg.profile.oneWay ? 1 : lat >= 0 ? 1 : -1;
        out.push({ kind: 'roadLane', ...pt, yaw: roadYaw(dir * p.tx, dir * p.tz), ref: `${seg.id}:${i}`, dist: Math.hypot(pt.x - q.x, pt.z - q.z) });
      });
    } else {
      // Facing the road, the footprint's depth (local z half extent) behind the setback line on the cursor's side.
      const side = h.side >= 0 ? 1 : -1;
      const outer = sec.w + (side > 0 ? sec.swR : sec.swL);
      const lateral = side * (outer + FRONTAGE_SETBACK + q.half[1]);
      const pt = at(lateral);
      out.push({ kind: 'roadFront', ...pt, yaw: Math.atan2(side * p.tz, -side * p.tx), ref: `${seg.id}:${side}`, dist: Math.hypot(pt.x - q.x, pt.z - q.z) });
    }
  }
}

function objectCandidates(q: SnapQuery, env: SnapEnv, out: SnapTarget[]) {
  for (const o of env.objects) {
    if (q.exclude?.has(o.id) || o.hidden || o.type === 'road') continue;
    const [ox, , oz] = o.transform.position;
    if (Math.abs(ox - q.x) > NEAR || Math.abs(oz - q.z) > NEAR) continue;
    const dc = Math.hypot(ox - q.x, oz - q.z);
    if (dc <= SNAP_TOLERANCE.objectCenter * SNAP_HYSTERESIS) out.push({ kind: 'objectCenter', x: ox, z: oz, ref: o.id, dist: dc });
    const oyaw = yawOf(o.transform.rotation);
    if (offAxis(oyaw, q.yaw) > PARALLEL) continue;
    // In the neighbour's frame (u along its local x, v along its local z).
    const c = Math.cos(oyaw), s = Math.sin(oyaw);
    const toU = (x: number, z: number) => (x - ox) * c - (z - oz) * s;
    const toV = (x: number, z: number) => (x - ox) * s + (z - oz) * c;
    const fromUV = (u: number, v: number) => ({ x: ox + u * c + v * s, z: oz - u * s + v * c });
    const [nu, nv] = half2(o);
    // The moving footprint's half extents along the neighbour's axes (swapped when turned by 90°).
    const turned = Math.abs(Math.sin(wrap(q.yaw - oyaw))) > 0.7071;
    const mu = turned ? q.half[1] : q.half[0], mv = turned ? q.half[0] : q.half[1];
    const u = toU(q.x, q.z), v = toV(q.x, q.z);
    // Only neighbours the moving footprint is next to (the other axis overlaps or nearly so).
    const nearU = Math.abs(u) <= nu + mu + SNAP_TOLERANCE.objectEdge * 2, nearV = Math.abs(v) <= nv + mv + SNAP_TOLERANCE.objectEdge * 2;
    // Touching (outside each other) and flush (same side) edge positions, and centres aligned.
    const axisCands = (n: number, m: number) => [n + m, -(n + m), n - m, -(n - m), 0];
    const pick = (val: number, list: number[]) => list.reduce((b, t) => (Math.abs(t - val) < Math.abs(b - val) ? t : b), list[0]);
    if (nearV) {
      const tu = pick(u, axisCands(nu, mu));
      const d = Math.abs(tu - u);
      if (d <= SNAP_TOLERANCE.objectEdge * SNAP_HYSTERESIS) out.push({ kind: 'objectEdge', ...fromUV(tu, v), ref: `${o.id}:u`, dist: d, axis: turned ? 1 : 0 });
    }
    if (nearU) {
      const tv = pick(v, axisCands(nv, mv));
      const d = Math.abs(tv - v);
      if (d <= SNAP_TOLERANCE.objectEdge * SNAP_HYSTERESIS) out.push({ kind: 'objectEdge', ...fromUV(u, tv), ref: `${o.id}:v`, dist: d, axis: turned ? 0 : 1 });
    }
    // Column lines of a modular neighbour: one footprint edge of the moving object on a bay line.
    const spec = o.building?.spec;
    if (spec && (nearU || nearV)) {
      const nx = Math.max(1, Math.round(spec.width / spec.bay)), nz = Math.max(1, Math.round(spec.depth / spec.bay));
      const kx = o.transform.scale[0], kz = o.transform.scale[2];
      const linesU = Array.from({ length: nx + 1 }, (_, i) => (-spec.width / 2 + (i * spec.width) / nx) * kx);
      const linesV = Array.from({ length: nz + 1 }, (_, i) => (-spec.depth / 2 + (i * spec.depth) / nz) * kz);
      if (nearV) for (const l of linesU) for (const e of [l + mu, l - mu]) {
        const d = Math.abs(e - u);
        if (d <= SNAP_TOLERANCE.structGrid * SNAP_HYSTERESIS) out.push({ kind: 'structGrid', ...fromUV(e, v), ref: `${o.id}:gu${l.toFixed(2)}${e > l ? '+' : '-'}`, dist: d, axis: turned ? 1 : 0 });
      }
      if (nearU) for (const l of linesV) for (const e of [l + mv, l - mv]) {
        const d = Math.abs(e - v);
        if (d <= SNAP_TOLERANCE.structGrid * SNAP_HYSTERESIS) out.push({ kind: 'structGrid', ...fromUV(u, e), ref: `${o.id}:gv${l.toFixed(2)}${e > l ? '+' : '-'}`, dist: d, axis: turned ? 0 : 1 });
      }
    }
  }
}

/**
 * A frontage / lane snap fixes the distance to the road and the heading; ALONG the road the object may still sit flush
 * with a neighbour (or on its column line): the best edge snap along the road axis (the moving object's local x) at the
 * snapped point. Other targets are returned as they are.
 */
function alongRoad(best: SnapTarget, q: SnapQuery, env: SnapEnv): SnapTarget {
  const off = env.disabled;
  if ((best.kind !== 'roadFront' && best.kind !== 'roadLane') || best.yaw === undefined || (off?.has('objectEdge') && off?.has('structGrid'))) return best;
  const along: SnapTarget[] = [];
  objectCandidates({ ...q, x: best.x, z: best.z, yaw: best.yaw }, env, along);
  const edge = along
    .filter((c) => (c.kind === 'objectEdge' || c.kind === 'structGrid') && c.axis === 0 && !off?.has(c.kind) && c.dist <= SNAP_TOLERANCE[c.kind])
    .sort((a, b) => a.dist - b.dist || (a.ref ?? '').localeCompare(b.ref ?? ''))[0];
  return edge ? { ...best, x: edge.x, z: edge.z, ref: `${best.ref}|${edge.ref}`, dist: Math.hypot(edge.x - q.x, edge.z - q.z) } : best;
}

/** The grid point of the cursor (or the free cursor when the grid is off). */
function gridTarget(x: number, z: number, step: number): SnapTarget {
  if (!(step > 0)) return { kind: 'free', x, z, dist: 0 };
  const gx = Math.round(x / step) * step, gz = Math.round(z / step) * step;
  return { kind: 'grid', x: gx, z: gz, dist: Math.hypot(gx - x, gz - z) };
}

/** Snap a cursor point (see the module comment for the rules). */
export function snapPoint(q: SnapQuery, env: SnapEnv): SnapTarget {
  const off = env.disabled;
  const cands: SnapTarget[] = [];
  if (!off?.has('roadNode')) nodeCandidates(q, env, cands);
  if (!off?.has('roadLane') || !off?.has('roadFront')) roadCandidates(q, env, cands);
  if (!off?.has('objectCenter') || !off?.has('objectEdge') || !off?.has('structGrid')) objectCandidates(q, env, cands);
  const usable = cands.filter((c) => !off?.has(c.kind));
  // Hysteresis: the previous target (same kind and reference) wins while it stays within the extended tolerance.
  const prev = env.prev;
  if (prev && prev.ref && prev.kind !== 'objectEdge' && prev.kind !== 'structGrid' && (prev.kind === 'roadFront' || prev.kind === 'roadLane' || !prev.ref.includes('|'))) {
    const head = prev.ref.split('|')[0];
    const same = usable.find((c) => c.kind === prev.kind && c.ref === head);
    if (same && same.dist <= SNAP_TOLERANCE[same.kind] * SNAP_HYSTERESIS) return alongRoad(same, q, env);
  }
  if (prev && prev.ref && (prev.kind === 'objectEdge' || prev.kind === 'structGrid')) {
    const refs = prev.ref.split('|');
    const parts = refs.map((r) => usable.find((c) => c.ref === r)).filter((c): c is SnapTarget => !!c && c.dist <= SNAP_TOLERANCE[c.kind] * SNAP_HYSTERESIS);
    if (parts.length === refs.length) {
      // The held parts stay; an axis without one takes the best new edge / grid snap in tolerance (a one-axis snap held
      // from an earlier cursor position must not keep the other axis from snapping).
      for (const ax of [0, 1] as const) {
        if (parts.some((c) => c.axis === ax)) continue;
        const add = usable.filter((c) => (c.kind === 'objectEdge' || c.kind === 'structGrid') && c.axis === ax && c.dist <= SNAP_TOLERANCE[c.kind]).sort((a, b) => a.dist - b.dist || (a.ref ?? '').localeCompare(b.ref ?? ''))[0];
        if (add) parts.push(add);
      }
      let x = q.x, z = q.z;
      for (const c of parts) { x += c.x - q.x; z += c.z - q.z; }
      return { ...prev, x, z, ref: parts.map((c) => c.ref).join('|'), dist: Math.hypot(x - q.x, z - q.z) };
    }
  }
  const order = (a: SnapTarget, b: SnapTarget) => a.dist - b.dist || (a.ref ?? '').localeCompare(b.ref ?? '');
  for (const kind of SNAP_PRIORITY) {
    if (kind === 'grid') break;
    if (kind === 'objectEdge' || kind === 'structGrid') {
      // Per-axis snaps combine: the best edge / grid snap along each axis of the moving object (they move it along
      // perpendicular directions, so both apply) — e.g. flush with one neighbour's side AND its front.
      const inTol = usable.filter((c) => (c.kind === 'objectEdge' || c.kind === 'structGrid') && c.dist <= SNAP_TOLERANCE[c.kind] && (kind === 'structGrid' ? true : c.kind === 'objectEdge'));
      if (!inTol.length) continue;
      let x = q.x, z = q.z;
      const parts: SnapTarget[] = [];
      for (const ax of [0, 1] as const) {
        const best = inTol.filter((c) => c.axis === ax).sort(order)[0];
        if (!best) continue;
        x += best.x - q.x;
        z += best.z - q.z;
        parts.push(best);
      }
      parts.sort(order);
      return { kind: parts[0].kind, x, z, ref: parts.map((c) => c.ref).join('|'), dist: Math.hypot(x - q.x, z - q.z) };
    }
    const best = usable.filter((c) => c.kind === kind && c.dist <= SNAP_TOLERANCE[kind]).sort(order)[0];
    if (best) return alongRoad(best, q, env);
  }
  return off?.has('grid') ? { kind: 'free', x: q.x, z: q.z, dist: 0 } : gridTarget(q.x, q.z, env.grid);
}

/** Half extents (x, z) of an object's footprint in its own frame, scale included — the `half` of a SnapQuery. */
export function footprintHalves(type: ObjectType, params: WorldObject['params'], scale: Vec3 = [1, 1, 1]): [number, number] {
  const d = getDefinition(type).getDimensions(params);
  return [(d[0] * scale[0]) / 2, (d[2] * scale[2]) / 2];
}
