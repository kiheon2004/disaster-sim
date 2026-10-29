/**
 * Phase 33 → Phase 34 interface: what the physiological models of the next phase may read about a person. A read-only
 * snapshot of the extended human model's state (null for legacy people); Phase 33 computes no physiology.
 */
import type { Vec3 } from '@/core/types';
import { SEGMENT_IDS, type SegmentId } from '@/human/anthropometry';
import type { InjuryLevel, Mobility } from '@/human/injury';
import type { Posture } from '@/human/posture';
import type { RuntimeEntity } from '../SimulationRuntime';

export interface HumanPhysicalSnapshot {
  id: string;
  mass: number;
  height: number;
  posture: Posture;
  standing: boolean;
  /** World positions of the segment centres (exposure / submersion of each part). */
  segments: { id: SegmentId; centre: Vec3; level: InjuryLevel; cumulative: number }[];
  mobility: Mobility;
  incapacitated: boolean;
  buried: boolean;
  captured: boolean;
  /** Water depth at the person and whether the head centre is under the water surface (Phase 14 water model). */
  waterDepth: number;
  headSubmerged: boolean;
  /** Head centre (world) — the exposure point for air / smoke / heat models. */
  exposure: Vec3;
  /** 'active' standing and mobile, 'impaired', 'down' (lying), 'incapacitated'. */
  activity: 'active' | 'impaired' | 'down' | 'incapacitated';
  lastImpact: { time: number; partner: string; impulse: number; dv: number; segments: SegmentId[] } | null;
  /** Largest cumulative risk index over the segments. */
  cumulative: number;
}

function rotate(q: readonly number[], v: readonly number[]): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function humanSnapshot(e: RuntimeEntity): HumanPhysicalSnapshot | null {
  const st = e.human;
  if (!st) return null;
  const q = e.pose.quaternion, p = e.pose.position;
  const world = (l: readonly number[]): Vec3 => {
    const r = rotate(q, l);
    return [r[0] + p[0], r[1] + p[1], r[2] + p[2]];
  };
  const segments = SEGMENT_IDS.map((id, k) => ({ id, centre: world(st.model.segments[k].centre), level: st.risk[id].level, cumulative: st.risk[id].cum }));
  const head = segments[0].centre;
  const depth = e.flood?.depth ?? 0;
  const surface = e.flood?.surface ?? -Infinity;
  const headSubmerged = head[1] < surface;
  let cumulative = 0;
  for (const s of segments) cumulative = Math.max(cumulative, s.cumulative);
  const down = !st.standing && st.posture !== 'upright' && st.posture !== 'airborne';
  return {
    id: e.id,
    mass: st.model.mass,
    height: st.model.height,
    posture: st.posture,
    standing: st.standing,
    segments,
    mobility: st.mobility,
    incapacitated: st.incapacitated,
    buried: st.buried,
    captured: !!e.flags.captured,
    waterDepth: depth,
    headSubmerged,
    exposure: head,
    activity: st.incapacitated ? 'incapacitated' : down ? 'down' : st.mobility !== 'mobile' ? 'impaired' : 'active',
    lastImpact: st.last ? { time: st.last.time, partner: st.last.partner, impulse: st.last.impulse, dv: st.last.dv, segments: st.last.segments.map((s) => s.id) } : null,
    cumulative,
  };
}
