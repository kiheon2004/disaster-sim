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
 *   geometry key: the centres and, per live point source in canonical order, its position, ε², influence radius and
 *            inner taper radius; value per (source, member): q·√q (q = r² + ε²; NaN where the source does not act —
 *            beyond R or q ≤ 0), the vertical offset y − y_s and the taper factor (sm(·) where r > inner, else none).
 *            A ramping or growing source changes only μ, so g_y = base_y − Σ_k (μ_k / D)·[taper]·dy reuses them — the
 *            operations of PointField.addSample on the same values in the same order (its x / z parts are not needed).
 * Bit-identical to sampling member by member: same functions, same inputs, same order; only repeated work is skipped.
 */
import type { RuntimeEntity } from '../SimulationRuntime';
import type { GravityField } from '@/gravity/field';
import type { PointLive } from '@/celestial/point';
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
  /** Point-source geometry (see the header): signature (6 per source), D, dy, taper (K × n each; taper NaN = none). */
  sig: Float64Array;
  D: Float64Array;
  dy: Float64Array;
  taper: Float64Array;
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
  c = { graph: g, pose: Float64Array.of(p[0], p[1], p[2], q[0], q[1], q[2], q[3]), centres, field: null, epoch: -1, pEpoch: -1, gy: new Float64Array(n), sig: new Float64Array(0), D: new Float64Array(0), dy: new Float64Array(0), taper: new Float64Array(0) };
  cache.set(st, c);
  return centres;
}

/** g_y of the field at every member centre (m/s²), sampled once per field state. */
export function memberGy(e: RuntimeEntity, st: StructureState, f: GravityField): Float64Array {
  const centres = memberCentres(e, st);
  const c = cache.get(st)!;
  if (c.field === f && c.epoch === f.epoch && c.pEpoch === f.points.epoch) return c.gy;
  const n = st.model.g.n, gy = c.gy;
  const live = f.points.live, K = live.length;
  geometry(c, live, n);
  for (let i = 0; i < n; i++) {
    let y = f.sampleBase(centres[3 * i], centres[3 * i + 1], centres[3 * i + 2], tmp)[1];
    for (let k = 0; k < K; k++) {
      const j = k * n + i, D = c.D[j];
      if (D !== D) continue;
      let a = live[k].mu / D;
      const t = c.taper[j];
      if (t === t) a *= t;
      y -= a * c.dy[j];
    }
    gy[i] = y;
  }
  c.field = f; c.epoch = f.epoch; c.pEpoch = f.points.epoch;
  return gy;
}

/** smootherstep (PointField's taper). */
const sm = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10));

/** (Re)build the per-source geometry when a source moved, appeared or changed shape. */
function geometry(c: MemberField, live: readonly PointLive[], n: number) {
  const K = live.length;
  let same = c.sig.length === 6 * K;
  for (let k = 0; same && k < K; k++) {
    const l = live[k], s = c.sig;
    same = s[6 * k] === l.x && s[6 * k + 1] === l.y && s[6 * k + 2] === l.z && s[6 * k + 3] === l.eps2 && s[6 * k + 4] === l.R && s[6 * k + 5] === l.inner;
  }
  if (same) return;
  const sig = new Float64Array(6 * K), D = new Float64Array(K * n), dy = new Float64Array(K * n), taper = new Float64Array(K * n);
  for (let k = 0; k < K; k++) {
    const l = live[k];
    sig[6 * k] = l.x; sig[6 * k + 1] = l.y; sig[6 * k + 2] = l.z; sig[6 * k + 3] = l.eps2; sig[6 * k + 4] = l.R; sig[6 * k + 5] = l.inner;
    for (let i = 0; i < n; i++) {
      const j = k * n + i;
      const x = c.centres[3 * i], y = c.centres[3 * i + 1], z = c.centres[3 * i + 2];
      const dx = x - l.x, ddy = y - l.y, dz = z - l.z;
      const r2 = dx * dx + ddy * ddy + dz * dz;
      const q = r2 + l.eps2;
      dy[j] = ddy;
      taper[j] = NaN;
      if (r2 >= l.R * l.R || !(q > 0)) { D[j] = NaN; continue; }
      D[j] = q * Math.sqrt(q);
      if (r2 > l.inner * l.inner) taper[j] = sm((l.R - Math.sqrt(r2)) / (l.R - l.inner));
    }
  }
  c.sig = sig; c.D = D; c.dy = dy; c.taper = taper;
}
