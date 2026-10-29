/**
 * Objects linked to roads (Phase 18): streetlights, signs, buildings placed along a road, parked
 * vehicles. A link stores where the object sits relative to the road (fraction along the
 * centerline, lateral offset, heading offset); what happens to it on a road edit is its policy:
 *
 *   follow   → re-placed from the link on the edited road (and re-seated on the new ground)
 *   preserve → world transform kept; the link is re-measured on the edited road
 *   detach   → link dropped at the first edit that changes its road; the object stays
 *
 * A follow link whose segment disappears (split / merge / delete) is re-attached to the nearest
 * road within LINK_REACH of its old anchor; if there is none the object is detached and stays —
 * an edit never deletes or teleports objects.
 */
import type { WorldDocument, WorldObject } from '@/core/model';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { groundPose, isGrounded, yawOf } from '@/terrain/groundPlacement';
import { nearest, pointAt, type Centerline } from './curve';
import { segmentLine } from './network';
import type { LinkPolicy, RoadLink, RoadNetwork, RoadSegment } from './types';

/** Farthest a linked object's anchor may be from a road to stay linked (m). */
export const LINK_REACH = 30;

type Objects = WorldDocument['objects'];

/** Road heading (yaw about +Y) that points an object's local +x along the tangent. */
export const roadYaw = (tx: number, tz: number) => Math.atan2(-tz, tx);

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** World pose (x, z, yaw) of a link on a centerline. */
export function linkPose(line: Centerline, link: Pick<RoadLink, 't' | 'lateral' | 'yaw'>) {
  const p = pointAt(line, link.t * line.length);
  return { x: p.x - p.tz * link.lateral, z: p.z + p.tx * link.lateral, yaw: wrap(roadYaw(p.tx, p.tz) + link.yaw) };
}

/** Link of a point to the nearest segment (null when no segment is within `reach`). */
export function measureLink(n: RoadNetwork, x: number, z: number, yaw: number, policy: LinkPolicy, prefer?: string, reach = LINK_REACH): RoadLink | null {
  let best: { seg: RoadSegment; line: Centerline; s: number; dist: number; side: number } | null = null;
  const consider = (seg: RoadSegment) => {
    const line = segmentLine(n, seg);
    const h = nearest(line, x, z);
    if (h.dist <= reach && (!best || h.dist < best.dist - 1e-9)) best = { seg, line, ...h };
  };
  if (prefer && n.segments[prefer]) consider(n.segments[prefer]);
  else for (const seg of Object.values(n.segments).sort((a, b) => (a.id < b.id ? -1 : 1))) consider(seg);
  if (!best) return null;
  const b = best as { seg: RoadSegment; line: Centerline; s: number; dist: number; side: number };
  const p = pointAt(b.line, b.s);
  return {
    segment: b.seg.id,
    t: b.line.length > 0 ? b.s / b.line.length : 0,
    lateral: Math.round(b.dist * b.side * 1000) / 1000,
    yaw: wrap(yaw - roadYaw(p.tx, p.tz)),
    policy,
  };
}

/** Did this segment's centerline change between the two networks? */
function lineChanged(a: RoadNetwork, b: RoadNetwork, id: string): boolean {
  const sa = a.segments[id], sb = b.segments[id];
  if (!sa || !sb) return true;
  if (sa === sb && a.nodes[sa.a] === b.nodes[sb.a] && a.nodes[sa.b] === b.nodes[sb.b]) return false;
  const la = segmentLine(a, sa), lb = segmentLine(b, sb);
  if (la.length !== lb.length || la.samples.length !== lb.samples.length) return true;
  return la.samples.some((p, i) => p.x !== lb.samples[i].x || p.z !== lb.samples[i].z);
}

/**
 * Apply link policies after a road edit prev → next. `before` / `after` sample the terrain as it
 * was / is (grounded objects are re-seated on the new ground). Returns the same map when nothing
 * changed.
 */
export function followRoads(objects: Objects, prev: RoadNetwork, next: RoadNetwork, before: TerrainSampler, after: TerrainSampler): Objects {
  let out: Objects | null = null;
  const put = (o: WorldObject) => {
    out ??= { ...objects };
    out[o.id] = o;
  };
  for (const o of Object.values(objects)) {
    const link = o.roadLink;
    if (!link || !lineChanged(prev, next, link.segment)) continue;
    const yaw = yawOf(o.transform.rotation);
    if (link.policy === 'detach') {
      const { roadLink: _drop, ...rest } = o;
      void _drop;
      put(rest);
      continue;
    }
    if (link.policy === 'preserve') {
      const l = measureLink(next, o.transform.position[0], o.transform.position[2], yaw, 'preserve', next.segments[link.segment] ? link.segment : undefined);
      if (l) put({ ...o, roadLink: l });
      else {
        const { roadLink: _drop, ...rest } = o;
        void _drop;
        put(rest);
      }
      continue;
    }
    // follow
    let l: RoadLink | null = link;
    if (!next.segments[link.segment]) {
      // Segment replaced (split / merge): re-attach at the old anchor on the nearest new road.
      const old = prev.segments[link.segment];
      const anchor = old ? linkPose(segmentLine(prev, old), { ...link, lateral: 0, yaw: 0 }) : { x: o.transform.position[0], z: o.transform.position[2] };
      const re = measureLink(next, anchor.x, anchor.z, yaw, 'follow');
      l = re ? { ...re, lateral: link.lateral, yaw: link.yaw } : null;
    }
    if (!l) {
      const { roadLink: _drop, ...rest } = o;
      void _drop;
      put(rest);
      continue;
    }
    const pose = linkPose(segmentLine(next, next.segments[l.segment]), l);
    const grounded = isGrounded(o, before);
    const t = o.transform;
    const seated = grounded ? groundPose(o, pose.x, pose.z, pose.yaw, after) : { position: [pose.x, t.position[1], pose.z] as [number, number, number], rotation: [t.rotation[0], pose.yaw, t.rotation[2]] as [number, number, number] };
    put({ ...o, roadLink: l, transform: { ...t, position: seated.position, rotation: seated.rotation } });
  }
  return out ?? objects;
}
