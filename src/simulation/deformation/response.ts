/**
 * How objects, buildings and roads respond to ground deformation (Phase 21). Called by the
 * DeformationSystem after each applied update, only for things overlapping the changed region.
 *
 * Two kinds of response are kept apart:
 *  - PHYSICAL CONTACT (dynamic bodies: vehicles, people, debris, fallen trees): Rapier does it.
 *    The collider is replaced; bodies in the region are woken; on UPLIFT a body resting on the
 *    ground is lifted with it (otherwise the new ground would appear inside it and push it out
 *    explosively); on SUBSIDENCE nothing is moved — the body falls under gravity.
 *  - KINEMATIC GROUND FOLLOWING (fixed bodies: buildings, trees, poles, signs, walls): they are
 *    attached to the ground. The ground displacement under their footprint is fitted with a
 *    plane — mean settlement + tilt (rigid base) — and the body is moved there. What goes beyond
 *    a rigid motion is evaluated as damage:
 *      buildings     angular distortion β (differential settlement off the plane, Burland &
 *                    Wroth 1974 definition) against the empirical limits of Skempton & MacDonald
 *                    (1956) / Bjerrum (1963): 1/500 no cracking expected, 1/300 first cracks in
 *                    panel walls, 1/150 structural damage; beyond 1/50 (extrapolated, labeled)
 *                    the building is treated as destroyed. Uniform settlement and rigid tilt
 *                    alone cause no structural damage here (they matter for utilities and use,
 *                    which are not modeled). Foundation CONTACT (points where the ground fell
 *                    more than 5 cm below the fitted base) and the static BEARING ratio
 *                    (Phase 17 capacity × contact × explicit support factor) are reported
 *                    separately from structural damage.
 *      poles, signs, walls, trees   topple when the ground tilt under them exceeds a limit
 *                    (TILT_LIMIT, judgment values, see docs) — they become dynamic bodies.
 */
import type { Quat, Vec3 } from '@/core/types';
import { qMul, quatFromUnitVectors } from '@/core/math';
import { yawOf } from '@/terrain/groundPlacement';
import { foundationContact } from '@/buildings/foundation';
import type { WorldObject } from '@/core/model';
import { DamageState, worst } from '../damage/DamageState';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import type { DeformationEngine } from '@/deformation/engine';
import type { GridRect } from '@/terrain/TerrainData';
import type { RoadRuntime, RoadSegmentState } from '../roads/RoadRuntime';
import { recordStateChange } from '../interactions/integrity';
import { groundResponseFor } from '@/deformation/groundModel';
import { foundationSupport } from '../structure/foundation';

/** Empirical angular-distortion limits (rad). */
export const BETA = { safe: 1 / 500, cracking: 1 / 300, structural: 1 / 150, severe: 1 / 50 } as const;
/** Rigid tilt noticeable to occupants (rad) — informational event only. */
export const TILT_NOTICEABLE = 1 / 250;
/** Ground fell this far below the fitted foundation base → that point lost contact (m). */
export const CONTACT_GAP = 0.05;
/** Contact fraction below which the foundation counts as having lost support (Phase 17 warning level). */
export const CONTACT_LOST = 0.75;
/** Tilt (rad) at which a ground-attached object topples (judgment values; see docs §9). */
export const TILT_LIMIT: Partial<Record<string, number>> = { streetLight: (15 * Math.PI) / 180, sign: (15 * Math.PI) / 180, wall: (8 * Math.PI) / 180, tree: (30 * Math.PI) / 180 };
/** A dynamic body whose bottom is within this of the ground counts as resting on it (m). */
const RESTING = 0.5;
/** Footprint sample grid (per side) for buildings. */
const N = 5;

export interface GroundEntityState {
  /** Mean vertical displacement under the footprint (m, + up). */
  settlement: number;
  /** Fitted base plane gradient (dw/dx, dw/dz) and the tilt angle (rad). */
  gradient: [number, number];
  tilt: number;
  /** Angular distortion (rad) now / peak (buildings). */
  beta: number;
  peakBeta: number;
  /** Fraction of the footprint still bearing (1 = all) and the lowest reached. */
  contact: number;
  minContact: number;
  /** Mean explicit support multiplier under the footprint (1 = unchanged). */
  support: number;
  /** Static bearing ratio at t = 0 (Phase 17) and now (× 1 / (contact · support)). */
  bearing0: number;
  bearingRatio: number;
  /** Structural damage index 0–1 from differential settlement (buildings) / toppling (others). */
  damage: number;
  health: number;
  /** Events already recorded (once each). */
  noted: Set<string>;
  /** Phase 22: lateral sediment load ratio, its damage index, loose material at the object (m), cause. */
  debrisRatio?: number;
  debrisDamage?: number;
  overburden?: number;
  source?: string;
}

export function stateOf(e: RuntimeEntity): GroundEntityState {
  return (e.ground ??= {
    settlement: 0, gradient: [0, 0], tilt: 0, beta: 0, peakBeta: 0, contact: 1, minContact: 1, support: 1,
    bearing0: NaN, bearingRatio: 0, damage: 0, health: 1, noted: new Set(),
  });
}

/** Damage level of the ground channel (folded into the shared state with worst()). */
export function groundLevel(st: GroundEntityState): DamageState {
  let s: DamageState = DamageState.NORMAL;
  if (st.peakBeta >= BETA.safe || st.contact < 1) s = DamageState.STRESSED;
  if (st.peakBeta >= BETA.cracking || st.minContact < CONTACT_LOST) s = worst(s, DamageState.DAMAGED);
  if (st.peakBeta >= BETA.structural || st.bearingRatio > 1) s = worst(s, DamageState.CRITICAL);
  // Damage index levels (Phase 22: also sediment loads) — 0.3 / 0.6 are the β levels 1/300, 1/150.
  if (st.damage >= 0.3) s = worst(s, DamageState.DAMAGED);
  if (st.damage >= 0.6) s = worst(s, DamageState.CRITICAL);
  if (st.peakBeta >= BETA.severe || st.damage >= 1) s = DamageState.DESTROYED;
  return s;
}

/** Damage index from angular distortion: 0 → 0.3 → 0.6 → 1 at 1/500, 1/300, 1/150, 1/50. */
export function betaDamage(beta: number): number {
  const pts: [number, number][] = [[BETA.safe, 0], [BETA.cracking, 0.3], [BETA.structural, 0.6], [BETA.severe, 1]];
  if (beta <= pts[0][0]) return 0;
  for (let k = 1; k < pts.length; k++) if (beta <= pts[k][0]) return pts[k - 1][1] + ((beta - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0])) * (pts[k][1] - pts[k - 1][1]);
  return 1;
}

const UP: Vec3 = [0, 1, 0];

/** Tilt quaternion that turns +y onto the normal of the plane with gradient g. */
function tiltQuat(g: [number, number]): Quat {
  const l = Math.hypot(g[0], 1, g[1]);
  return quatFromUnitVectors(UP, [-g[0] / l, 1 / l, -g[1] / l]);
}

/** Footprint half extents (scaled) and yaw. */
export function footprint(e: RuntimeEntity): { hx: number; hz: number; yaw: number } {
  const d = e.dims;
  return { hx: Math.max(0.25, d[0] / 2), hz: Math.max(0.25, d[2] / 2), yaw: yawOf(e.source.transform.rotation) };
}

/** |ΔW| > 0 anywhere under an object's footprint circle (+ 0.5 m), scanned at 1 m spacing. */
function groundChangedUnder(e: RuntimeEntity, delta: (x: number, z: number) => number): boolean {
  const [x, , z] = e.pose.position;
  const r = Math.hypot(e.dims[0], e.dims[2]) / 2 + 0.5;
  for (let dz = -r; dz <= r + 1e-9; dz += 1) for (let dx = -r; dx <= r + 1e-9; dx += 1) if (delta(x + dx, z + dz) !== 0) return true;
  return delta(x + r, z + r) !== 0 || delta(x - r, z - r) !== 0;
}

const overlaps = (e: RuntimeEntity, r: { x0: number; z0: number; x1: number; z1: number }, pad: number) => {
  const [x, , z] = e.pose.position;
  const ext = Math.hypot(e.dims[0], e.dims[2]) / 2 + pad;
  return x + ext >= r.x0 && x - ext <= r.x1 && z + ext >= r.z0 && z - ext <= r.z1;
};

/**
 * Plane fit of the displacement under a footprint: w ≈ a + b·lx + c·lz on an N×N grid in the
 * object's frame (symmetric grid → closed form). Returns the world gradient, mean, residuals.
 */
function fitBase(engine: DeformationEngine, e: RuntimeEntity, n: number) {
  const { hx, hz, yaw } = footprint(e);
  const [x0, , z0] = e.initialPose.position;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const w: number[] = [], lxs: number[] = [], lzs: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const lx = -hx + (2 * hx * i) / (n - 1), lz = -hz + (2 * hz * j) / (n - 1);
    // Foundations follow the ground itself, not loose material deposited around them (Phase 22).
    const v = engine.supportDisplacementAt(x0 + lx * c + lz * s, z0 - lx * s + lz * c);
    w.push(v); lxs.push(lx); lzs.push(lz); sum += v;
  }
  const a = sum / w.length;
  let sxx = 0, szz = 0, bx = 0, bz = 0;
  for (let k = 0; k < w.length; k++) { sxx += lxs[k] * lxs[k]; szz += lzs[k] * lzs[k]; bx += w[k] * lxs[k]; bz += w[k] * lzs[k]; }
  const b = sxx > 0 ? bx / sxx : 0, cz = szz > 0 ? bz / szz : 0;
  // Local gradient (along local x, z) → world: local x = (cos, −sin), local z = (sin, cos).
  const gx = b * c + cz * s, gz = -b * s + cz * c;
  const residual = w.map((v, k) => v - (a + b * lxs[k] + cz * lzs[k]));
  return { a, b, cz, gradient: [gx, gz] as [number, number], residual, lxs, lzs, hx, hz, yaw, c, s, x0, z0 };
}

/** Move a fixed body to its initial pose displaced by (settlement, tilt). */
function follow(e: RuntimeEntity, ctx: SystemContext, settlement: number, gradient: [number, number]) {
  const p0 = e.initialPose.position, q0 = e.initialPose.quaternion;
  const q = qMul(tiltQuat(gradient), q0);
  e.pose = { position: [p0[0], p0[1] + settlement, p0[2]], quaternion: q };
  if (e.body !== null) ctx.physics.setBodyPose(e.body, e.pose.position, e.pose.quaternion);
  e.rev++;
}

function note(e: RuntimeEntity, key: string, run: () => void) {
  const st = stateOf(e);
  if (st.noted.has(key)) return;
  st.noted.add(key);
  run();
}

/** Building foundation response (kinematic follow + differential settlement + contact). */
function respondBuilding(e: RuntimeEntity, ctx: SystemContext, engine: DeformationEngine) {
  const st = stateOf(e);
  const f = fitBase(engine, e, N);
  // Ground-material extension point (groundModel.ts): none is registered in this phase, so the
  // prescribed settlement is used as is.
  const gm = groundResponseFor(ctx.env.terrain.sampleSoilType(f.x0, f.z0));
  if (gm) f.a += gm.additionalSettlement({ soil: ctx.env.terrain.sampleSoilType(f.x0, f.z0), settlement: f.a, bearingRatio: Number.isNaN(st.bearing0) ? 0 : st.bearing0, elapsed: ctx.time });
  st.settlement = f.a;
  st.gradient = f.gradient;
  st.tilt = Math.atan(Math.hypot(f.gradient[0], f.gradient[1]));
  // Angular distortion: largest residual difference between neighbouring samples / distance.
  let beta = 0;
  const dx = (2 * f.hx) / (N - 1), dz = (2 * f.hz) / (N - 1);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = i * N + j;
    if (i + 1 < N) beta = Math.max(beta, Math.abs(f.residual[k + N] - f.residual[k]) / dx);
    if (j + 1 < N) beta = Math.max(beta, Math.abs(f.residual[k + 1] - f.residual[k]) / dz);
  }
  st.beta = beta;
  st.peakBeta = Math.max(st.peakBeta, beta);
  // Contact: the rigid base sits on the fitted plane; points where the ground fell clearly below it bear nothing.
  let bearing = 0, support = 0;
  for (let k = 0; k < f.residual.length; k++) {
    if (f.residual[k] > -CONTACT_GAP) bearing++;
    const x = f.x0 + f.lxs[k] * f.c + f.lzs[k] * f.s, z = f.z0 - f.lxs[k] * f.s + f.lzs[k] * f.c;
    support += engine.supportAt(x, z, ctx.time);
  }
  st.contact = bearing / f.residual.length;
  st.minContact = Math.min(st.minContact, st.contact);
  st.support = support / f.residual.length;
  if (Number.isNaN(st.bearing0)) st.bearing0 = bearingRatioAt0(e, ctx, engine);
  st.bearingRatio = st.bearing0 / Math.max(1e-3, st.contact * st.support);
  st.damage = Math.max(st.damage, betaDamage(st.peakBeta));
  st.health = 1 - st.damage;
  follow(e, ctx, f.a, f.gradient);
  // Phase 25: the ground under each foundation member (gap below the rigid base, explicit support
  // loss) → its support in the structural graph — local loss of support, not only a rigid motion.
  if (e.modular) foundationSupport(e, ctx, engine, f);
  const before = e.state;
  const level = groundLevel(st);
  if (level > e.state) {
    e.state = level;
    e.lastHazard = 'ground';
    e.lastCause = 'foundation';
    recordStateChange(e, ctx.time, 'ground', level);
  }
  // Events (once each).
  if (st.peakBeta >= BETA.cracking) note(e, 'cracked', () => ctx.recordDamage(e, { eventType: 'CRACKED', cause: 'foundation', hazard: 'ground', response: st.peakBeta, damageBefore: 0, damageAfter: st.damage }));
  // State transitions (DAMAGED / CRITICAL / DESTROYED) are recorded once by the MetricsSystem
  // from e.state + lastHazard / lastCause — only the ground-specific events are recorded here.
  if (st.peakBeta >= BETA.structural) note(e, 'structural', () => ctx.log(e.id, 'danger', { key: 'log.deform.structural', params: { beta: Math.round(1 / st.peakBeta) } }));
  if (st.tilt >= TILT_NOTICEABLE) note(e, 'tilted', () => { ctx.recordDamage(e, { eventType: 'TILTED', cause: 'foundation', hazard: 'ground', response: st.tilt, damageAfter: st.damage }); ctx.log(e.id, 'warn', { key: 'log.deform.tilted', params: { deg: ((st.tilt * 180) / Math.PI).toFixed(2) } }); });
  if (st.minContact < CONTACT_LOST) note(e, 'contact', () => ctx.log(e.id, 'danger', { key: 'log.deform.contact', params: { pct: Math.round(st.minContact * 100) } }));
  if (st.bearingRatio > 1) note(e, 'bearing', () => ctx.log(e.id, 'danger', { key: 'log.deform.bearing', params: { r: st.bearingRatio.toFixed(2) } }));
  void before;
}

/** Static bearing ratio of the building at t = 0 (Phase 17 foundation contact, original ground). */
export function bearingRatioAt0(e: RuntimeEntity, ctx: SystemContext, engine?: DeformationEngine): number {
  try {
    // On the ORIGINAL ground (the engine keeps it) when the ground already moved (lazy priming).
    const c = foundationContact(e.source as WorldObject, engine ? engine.originalSampler() : ctx.env.terrain);
    return Number.isFinite(c.bearingRatio) ? c.bearingRatio : 0;
  } catch {
    return 0;
  }
}

/** Ground-attached objects other than buildings: follow; topple beyond their tilt limit. */
function respondAttached(e: RuntimeEntity, ctx: SystemContext, engine: DeformationEngine) {
  const st = stateOf(e);
  const f = fitBase(engine, e, 3);
  st.settlement = f.a;
  st.gradient = f.gradient;
  st.tilt = Math.atan(Math.hypot(f.gradient[0], f.gradient[1]));
  follow(e, ctx, f.a, f.gradient);
  const limit = TILT_LIMIT[e.source.type];
  if (limit !== undefined && st.tilt > limit && e.body !== null && !e.dynamic) {
    // Becomes a free body: physics topples it along the slope.
    ctx.physics.setBodyKind(e.body, 'dynamic');
    e.dynamic = true;
    e.flags.toppled = true;
    st.damage = 1;
    st.health = 0;
    e.state = DamageState.DESTROYED;
    e.lastHazard = 'ground';
    e.lastCause = 'foundation';
    recordStateChange(e, ctx.time, 'ground', DamageState.DESTROYED);
    ctx.recordDamage(e, { eventType: 'TOPPLED', cause: 'foundation', hazard: 'ground', response: st.tilt, damageAfter: 1 });
    ctx.log(e.id, 'warn', { key: 'log.deform.toppled', params: { deg: Math.round((st.tilt * 180) / Math.PI) } });
  }
}

/** Static bearing ratios of the buildings in a region on the ground as it is now (before it moves). */
export function primeFoundation(ctx: SystemContext, engine: DeformationEngine, rect: GridRect) {
  const t = engine.terrain;
  const w = { x0: t.originX + rect.x0 * t.cellSize, z0: t.originZ + rect.z0 * t.cellSize, x1: t.originX + rect.x1 * t.cellSize, z1: t.originZ + rect.z1 * t.cellSize };
  for (const e of ctx.runtime.entities.values()) {
    if (e.source.type !== 'building' || e.ground || !overlaps(e, w, 2)) continue;
    stateOf(e).bearing0 = bearingRatioAt0(e, ctx);
  }
}

export interface ResponseStats {
  dynamicWoken: number;
  dynamicLifted: number;
  followed: number;
  buildings: number;
  roads: number;
}

/**
 * Responses to one applied update. `before(x, z)` = ground height before the update (for the
 * resting test of dynamic bodies); `delta(x, z)` = change of the displacement in this update.
 */
export function respond(ctx: SystemContext, engine: DeformationEngine, rect: GridRect, delta: (x: number, z: number) => number, before: (x: number, z: number) => number): ResponseStats {
  const t = engine.terrain;
  const world = { x0: t.originX + rect.x0 * t.cellSize, z0: t.originZ + rect.z0 * t.cellSize, x1: t.originX + rect.x1 * t.cellSize, z1: t.originZ + rect.z1 * t.cellSize };
  const stats: ResponseStats = { dynamicWoken: 0, dynamicLifted: 0, followed: 0, buildings: 0, roads: 0 };
  for (const e of ctx.runtime.entities.values()) {
    if (e.body === null || e.def.inert) continue;
    if (!overlaps(e, world, 2)) continue;
    // Only objects whose ground actually changed in this update (Phase 22: a ground-failure
    // field covers the whole grid; untouched objects are neither refitted nor woken).
    if (!groundChangedUnder(e, delta)) continue;
    if (e.dynamic) {
      const p = e.pose.position;
      const d = delta(p[0], p[2]);
      if (d > 0 && p[1] - before(p[0], p[2]) < RESTING) {
        const q = e.pose.quaternion;
        e.pose = { position: [p[0], p[1] + d, p[2]], quaternion: q };
        ctx.physics.setBodyPose(e.body, e.pose.position, q);
        stats.dynamicLifted++;
      } else ctx.physics.wake(e.body);
      stats.dynamicWoken++;
      continue;
    }
    if (e.flags.collapsed) continue;
    if (e.source.type === 'building') {
      respondBuilding(e, ctx, engine);
      stats.buildings++;
    } else respondAttached(e, ctx, engine);
    stats.followed++;
  }
  // Debris pieces (bodies without an entity): wake / lift like dynamic objects.
  for (const dbr of ctx.runtime.debris) {
    const p = dbr.pose.position;
    if (p[0] < world.x0 - 2 || p[0] > world.x1 + 2 || p[2] < world.z0 - 2 || p[2] > world.z1 + 2) continue;
    const d = delta(p[0], p[2]);
    if (d === 0) continue;
    if (d > 0 && p[1] - before(p[0], p[2]) < RESTING) {
      dbr.pose = { position: [p[0], p[1] + d, p[2]], quaternion: dbr.pose.quaternion };
      ctx.physics.setBodyPose(dbr.body, dbr.pose.position, dbr.pose.quaternion);
    } else ctx.physics.wake(dbr.body);
  }
  if (ctx.runtime.roads) stats.roads = respondRoads(ctx, ctx.runtime.roads, engine, world);
  return stats;
}

// ── Roads ────────────────────────────────────────────────────────────────────

/** Differential vertical movement between neighbouring samples (5 m) that breaks a pavement (Phase 18 hook). */
export const ROAD_CRACK_OFFSET = 0.1;
/** Grade beyond typical maximum design grades of local roads (≈ 15 %). */
export const ROAD_STEEP_GRADE = 0.15;
/** Grade / step beyond which ordinary vehicles cannot pass (judgment values, documented). */
export const ROAD_IMPASSABLE_GRADE = 0.25;
export const ROAD_IMPASSABLE_STEP = 0.3;

export interface RoadDeformState {
  /** Largest differential vertical displacement between neighbouring samples (m). */
  offset: number;
  /** Steepest current grade along the segment (fraction) and at the start of the run. */
  grade: number;
  grade0: number;
  /** Mean vertical displacement of the segment (m). */
  settlement: number;
  /** Can ordinary vehicles still use it (design connectivity is never changed). */
  passable: boolean;
  /** Loose sediment on the carriageway (m; Phase 22). */
  debris?: number;
}

function respondRoads(ctx: SystemContext, roads: RoadRuntime, engine: DeformationEngine, w: { x0: number; z0: number; x1: number; z1: number }): number {
  const sampler = ctx.env.terrain;
  let n = 0;
  for (const st of roads.segments) {
    if (!st.samples.some((p) => p.x >= w.x0 - 3 && p.x <= w.x1 + 3 && p.z >= w.z0 - 3 && p.z <= w.z1 + 3)) continue;
    n++;
    const d = st.samples.map((p) => engine.displacementAt(p.x, p.z));
    const h = st.samples.map((p) => sampler.sampleHeight(p.x, p.z));
    const h0 = st.samples.map((p) => engine.originalAt(p.x, p.z));
    let offset = 0, grade = 0, grade0 = 0, sum = 0;
    for (let k = 0; k + 1 < d.length; k++) {
      const len = Math.max(0.5, Math.hypot(st.samples[k + 1].x - st.samples[k].x, st.samples[k + 1].z - st.samples[k].z));
      offset = Math.max(offset, Math.abs(d[k + 1] - d[k]));
      grade = Math.max(grade, Math.abs(h[k + 1] - h[k]) / len);
      grade0 = Math.max(grade0, Math.abs(h0[k + 1] - h0[k]) / len);
    }
    for (const v of d) sum += v;
    const prev = st.deform;
    const passable = !(offset >= ROAD_IMPASSABLE_STEP || (grade >= ROAD_IMPASSABLE_GRADE && grade > grade0 + 0.01));
    st.deform = { offset: Math.max(prev?.offset ?? 0, offset), grade, grade0, settlement: sum / d.length, passable: (prev?.passable ?? true) && passable, ...(prev?.debris ? { debris: prev.debris } : {}) };
    // Pavement cracking from differential movement (same scale as the Phase 18 ground-failure hook).
    const crack = Math.min(1, st.deform.offset / ROAD_CRACK_OFFSET);
    if (crack > st.crack) {
      st.crack = crack;
      roads.rev++;
      if (crack >= 0.05 && roads.mark(st, 'cracked', ctx.time, st.deform.offset)) ctx.log(null, 'warn', { key: 'log.deform.roadCracked', params: { id: st.id, cm: Math.round(st.deform.offset * 100) } });
      if (crack >= 0.6 && roads.mark(st, 'severe', ctx.time, st.deform.offset)) ctx.log(null, 'danger', { key: 'log.road.severe', params: { id: st.id } });
    }
    if (grade >= ROAD_STEEP_GRADE && grade > grade0 + 0.01 && roads.mark(st, 'steep', ctx.time, grade)) ctx.log(null, 'warn', { key: 'log.deform.roadSteep', params: { id: st.id, pct: Math.round(grade * 100) } });
    if (!st.deform.passable && roads.mark(st, 'impassable', ctx.time, st.deform.offset)) ctx.log(null, 'danger', { key: 'log.deform.roadCut', params: { id: st.id } });
    roads.rev++;
  }
  return n;
}

export type { RoadSegmentState };
