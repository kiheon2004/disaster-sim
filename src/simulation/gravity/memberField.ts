/**
 * Field samples at the members of a modular building, shared within a step (Phase 32.1). The Phase 31 ratios
 * (gravity/structures.ts: k = −g_y/g₀ per member) and the Phase 32 uplift check (celestial/structures.ts: m·g_y per
 * member) sample the same field at the same member centres in the same step; they now read one array.
 *
 * Caches (both on the building's StructureState, freed with it):
 *   centres  key: the structural graph and the building's pose (position + quaternion, compared value by value);
 *            value: the world centre of every member's box (toWorld of the box centre — the same arithmetic as before);
 *            rebuilt when the pose or the graph changes. Static geometry only (the members' fall offsets are not used,
 *            as before).
 *   gy       key: the field (identity), its epoch and its point sources' epoch (bumped by every prepare / growth / new
 *            experiment); value: g_y = f.sample(centre)[1] of every member (the same call as before).
 * Bit-identical to sampling member by member: same functions, same inputs, same order; only repeated work is skipped.
 */
import type { RuntimeEntity } from '../SimulationRuntime';
import type { GravityField } from '@/gravity/field';
import type { StructureState } from '../structure/state';
import { toWorld } from '../structure/state';
import type { Vec3 } from '@/core/types';

interface MemberField {
  graph: unknown;
  pose: Float64Array;
  centres: Float64Array;
  field: GravityField | null;
  epoch: number;
  pEpoch: number;
  gy: Float64Array;
}

const cache = new WeakMap<StructureState, MemberField>();
const tmp: Vec3 = [0, 0, 0];

function samePose(e: RuntimeEntity, pose: Float64Array): boolean {
  const p = e.pose.position, q = e.pose.quaternion;
  return pose[0] === p[0] && pose[1] === p[1] && pose[2] === p[2] && pose[3] === q[0] && pose[4] === q[1] && pose[5] === q[2] && pose[6] === q[3];
}

/** World centres of the members' boxes (3 per member). */
export function memberCentres(e: RuntimeEntity, st: StructureState): Float64Array {
  const g = st.model.g;
  let c = cache.get(st);
  if (c && c.graph === g && samePose(e, c.pose)) return c.centres;
  const n = g.n, centres = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const o = 6 * i;
    const w = toWorld(e, [(g.box[o] + g.box[o + 3]) / 2, (g.box[o + 1] + g.box[o + 4]) / 2, (g.box[o + 2] + g.box[o + 5]) / 2]);
    centres[3 * i] = w[0]; centres[3 * i + 1] = w[1]; centres[3 * i + 2] = w[2];
  }
  const p = e.pose.position, q = e.pose.quaternion;
  c = { graph: g, pose: Float64Array.of(p[0], p[1], p[2], q[0], q[1], q[2], q[3]), centres, field: null, epoch: -1, pEpoch: -1, gy: new Float64Array(n) };
  cache.set(st, c);
  return centres;
}

/** g_y of the field at every member centre (m/s²), sampled once per field state. */
export function memberGy(e: RuntimeEntity, st: StructureState, f: GravityField): Float64Array {
  const centres = memberCentres(e, st);
  const c = cache.get(st)!;
  if (c.field === f && c.epoch === f.epoch && c.pEpoch === f.points.epoch) return c.gy;
  const n = st.model.g.n, gy = c.gy;
  for (let i = 0; i < n; i++) gy[i] = f.sample(centres[3 * i], centres[3 * i + 1], centres[3 * i + 2], tmp)[1];
  c.field = f; c.epoch = f.epoch; c.pEpoch = f.points.epoch;
  return gy;
}
