/**
 * Phase 33: the extended human model in the simulation (runs only for people with `e.human`, i.e. an 'extended' run).
 *
 * Standing person (rotations held — posture control): the inverted-pendulum balance model (src/human/balance) is driven by
 * this step's forces on the body as the ForceLedger recorded them per source (wind, ground-motion inertia, water, sediment,
 * ejecta, blast — never the gravity field, which enters from the local g at the COM), the tangential part of the local
 * gravity, the body's own acceleration (feet slipping / carried: the base accelerates under the COM) and the angular impulse
 * of contacts (DamageSystem → humanContact). Loss of balance or of support releases the body: rotations unlocked, the lean
 * applied about the support edge, the pendulum's motion handed to the rigid body (no invented shove). From then on Rapier
 * moves it; this system reads posture, landings, contact episodes and the risk index from the body's actual state.
 *
 * Responsibility: extended people are NOT knocked down by the legacy rules (knockDown returns early), take no legacy
 * impact health loss (DamageSystem routes their contacts here) and get their health / state from the injury model only.
 */
import type { Vec3 } from '@/core/types';
import { SEGMENT_IDS, segmentShares } from '@/human/anthropometry';
import { edgeDistance, MIN_GN, stepBalance } from '@/human/balance';
import { applyEpisode, capability, GAP, levelRank, MAX_STEPS, MIN_SHARE, worstLevel } from '@/human/injury';
import { classifyPosture, POSTURE, POSTURES, tiltFromUp } from '@/human/posture';
import { tidalLoad } from '@/human/tidal';
import type { BodyUserData, ContactEvent } from '@/physics/PhysicsEngine';
import { HUMAN_RADIUS } from '@/objects/definitions/human';
import type { DamageCause, Hazard } from '../analysis/DamageEvent';
import { DamageState, worst } from '../damage/DamageState';
import { floodLevel } from '../damage/floodLevels';
import { FORCE_SOURCES, HUM_STRIDE } from '../forces/ForceLedger';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SimulationSystem, SystemContext } from '../systems/SimulationSystem';
import { simProfiler } from '../profiling/SimProfiler';
import { SERIES_KEYS, SERIES_MAX, type Episode, type HumanState } from './state';

/** Steps without support after which a standing body has lost it (0.25 s: millimetre hops in a ground shock do not count). */
const FREE_RELEASE = 15;
/** Lowest capsule point within this height (m) of the terrain surface: on the ground. */
const GROUND_GAP = 0.03;
/** Episodes recorded as IMPACT events from this struck-point velocity change (m/s) — smaller bumps are only counted. */
const RECORD_DV = 1;
/**
 * Stance after a landing on the feet (the minimal active-control rule of the model, HUMAN_PHYSICS.md §19): a released body
 * upright within STANCE_TILT, touching, slower than STANCE_V / STANCE_W for STANCE_TIME s regains posture control when it
 * can (not incapacitated, not immobile, support-normal gravity present); a person who cannot stand collapses: the legs
 * give way — a controlled sinking, not a rigid topple (a rigid single body would fall like a tree and strike the ground at
 * standing-fall speed). The body is laid prone at the same place with no velocity; the COM's potential energy m g Δh is
 * booked as dissipated in the legs (collapseEnergy), no contact episode is created.
 */
const STANCE_TILT = (10 * Math.PI) / 180, STANCE_V = 0.2, STANCE_W = 0.3, STANCE_TIME = 0.5;
/** Contact points within the collision capsule's radius (+ 8 cm) of a segment cylinder belong to it. */
const SEGMENT_SLACK = HUMAN_RADIUS + 0.08;
/** A segment's surface within this distance (m) of the contact plane at the end of a ground episode was struck. */
const PLANE_GAP = 0.08;
/** Model-limit thresholds: angular speed (rad/s) and struck-point velocity change (m/s) beyond the model's range. */
const EXTREME_SPIN = 50, EXTREME_DV = 60;
/** Memory (s) of the recent tipping impulses the fall is attributed to. */
const TIP_MEMORY = 0.5;
/** Fall causes beyond the ledger sources. */
type FallCause = (typeof FORCE_SOURCES)[number] | 'gravity' | 'slip' | 'contact' | 'noSupport' | 'physiological';
const CAUSE: Record<FallCause, [DamageCause, Hazard | null]> = {
  wind: ['overload', 'wind'],
  groundMotion: ['shaking', 'earthquake'],
  water: ['hydrodynamic', 'flood'],
  gravityField: ['gravity', 'gravity'],
  sediment: ['debris', 'ground'],
  impact: ['ejecta', 'impact'],
  blast: ['blast', 'blast'],
  gravity: ['gravity', 'gravity'],
  slip: ['push', null],
  contact: ['impact', null],
  noSupport: ['gravity', 'gravity'],
  // Phase 34: the physiology left the person unable to act — posture control lost (legs give way, see stance()).
  physiological: ['physiology', 'thermal'],
};

// ── small vector helpers (rotation by a unit quaternion) ──
function rot(q: readonly number[], v: readonly number[], out: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}
const conj = (q: readonly number[]) => [-q[0], -q[1], -q[2], q[3]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function qMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];


/**
 * A contact-force event on an extended person (called by DamageSystem for each side of an event). `isA` = the person is
 * the event's `a` (the detail's force acts on a). Terrain contacts have other = null (partner 'ground').
 */
export function humanContact(ctx: SystemContext, e: RuntimeEntity, other: BodyUserData | null, ev: ContactEvent, isA: boolean, dt: number) {
  const st = e.human!;
  const d = ev.detail;
  if (!d || e.body === null) return;
  const s = isA ? 1 : -1;
  const J: Vec3 = [s * d.F[0] * dt, s * d.F[1] * dt, s * d.F[2] * dt];
  const jm = Math.hypot(J[0], J[1], J[2]);
  if (!(jm > 0)) return;
  const partner = other ? other.debrisId ?? other.entityId : 'ground';
  let ep = st.episodes.get(partner);
  if (!ep) {
    // Closing speed along the normal from the person to the partner (previous-step velocities; the ground is at rest).
    const n: Vec3 = isA ? d.n : [-d.n[0], -d.n[1], -d.n[2]];
    let vp: Vec3 = [0, 0, 0], mp = Infinity;
    if (other && !other.debrisId) {
      const o = ctx.runtime.entities.get(other.entityId);
      if (o?.body != null) {
        vp = ctx.physics.getLinearVelocity(o.body);
        if (ctx.physics.isDynamic(o.body)) mp = ctx.physics.getMass(o.body);
      }
    } else if (other?.debrisId) {
      const db = ctx.runtime.debris.find((x) => x.id === other.debrisId);
      if (db) {
        vp = ctx.physics.getLinearVelocity(db.body);
        if (ctx.physics.isDynamic(db.body)) mp = ctx.physics.getMass(db.body);
      }
    }
    const closing = Math.max(0, (st.v[0] - vp[0]) * n[0] + (st.v[1] - vp[1]) * n[1] + (st.v[2] - vp[2]) * n[2]);
    // A landing ends a free phase: released and either still unsupported, mid-fall, or with a free phase not yet landed
    // (a body that comes down lying / sliding is classified as such on its first touching step).
    const landing = !st.standing && (st.freeSteps >= 2 || st.airTop === st.airTop || st.posture === 'falling' || st.posture === 'airborne' || st.posture === 'tumbling');
    const hz = other ? (ctx.runtime.entities.get(other.entityId)?.lastHazard ?? ctx.runtime.debris.find((x) => x.id === other.debrisId)?.hazard ?? null) : null;
    ep = { partner, startStep: ctx.step, lastStep: ctx.step, steps: 0, seg: new Float64Array(SEGMENT_IDS.length * 4), unknown: 0, N: [0, 0, 0], J: [0, 0, 0], P: [0, 0, 0], jw: 0, peak: 0, v0: [...st.v], w0: [...st.w], v1: [...st.v], w1: [...st.w], c1: [0, 0, 0], p1: [0, 0, 0], q1: [0, 0, 0, 1], closing, mp, landing, hazard: hz };
    st.episodes.set(partner, ep);
    if (landing && st.airTop === st.airTop) {
      const c = comWorld(e, st);
      const up = upAt(ctx, c);
      const drop = st.airTop - dot(c, up);
      if (drop > st.maxDrop) st.maxDrop = drop;
      st.airTop = NaN;
    }
  }
  if (ep.lastStep !== ctx.step) ep.steps++;
  else if (ep.steps === 0) ep.steps = 1;
  ep.lastStep = ctx.step;
  ep.J[0] += J[0]; ep.J[1] += J[1]; ep.J[2] += J[2];
  if (d.P[0] === d.P[0]) {
    ep.P[0] += jm * d.P[0]; ep.P[1] += jm * d.P[1]; ep.P[2] += jm * d.P[2];
    ep.jw += jm;
    // Normal towards the person (n runs from a to b).
    const sn = isA ? -1 : 1;
    ep.N[0] += sn * jm * d.n[0]; ep.N[1] += sn * jm * d.n[1]; ep.N[2] += sn * jm * d.n[2];
  }
  if (ev.force > ep.peak) ep.peak = ev.force;
  st.stepImpulse += jm;
  // Solver contact points → segments (body frame at this step).
  {
    const q = e.pose.quaternion, p0 = e.pose.position, iq = conj(q), loc: Vec3 = [0, 0, 0];
    const pts = d.pts;
    for (let i = 0; i < pts.length; i += 4) {
      rot(iq, [pts[i] - p0[0], pts[i + 1] - p0[1], pts[i + 2] - p0[2]], loc);
      const sh = segmentShares(st.model, loc, SEGMENT_SLACK);
      if (!sh.length) { ep.unknown += pts[i + 3]; continue; }
      for (const x of sh) {
        const o = SEGMENT_IDS.indexOf(x.id) * 4, j = pts[i + 3] * x.share;
        ep.seg[o] += j; ep.seg[o + 1] += j * loc[0]; ep.seg[o + 2] += j * loc[1]; ep.seg[o + 3] += j * loc[2];
      }
    }
  }
  // A standing person: the contact's angular impulse about the stance point drives the lean (its linear part moved the
  // body and enters through the body's acceleration).
  if (st.standing && d.P[0] === d.P[0]) {
    const q = e.pose.quaternion, p0 = e.pose.position;
    const L = cross([d.P[0] - p0[0], d.P[1] - p0[1], d.P[2] - p0[2]], J);
    const axis = rot(q, Y, [0, 0, 0]);
    const tip = cross(L, axis);
    const e1 = rot(q, X, [0, 0, 0]), e2 = rot(q, Z, [0, 0, 0]);
    st.bal.om[0] += dot(tip, e1) / st.bp.Ia;
    st.bal.om[1] += dot(tip, e2) / st.bp.Ia;
    const o = 2 * (FORCE_SOURCES.length + 2);
    st.tipHist[o] += dot(tip, e1);
    st.tipHist[o + 1] += dot(tip, e2);
  }
}

/**
 * A strike by a projectile that is not a rigid body (a volcanic bomb, Phase 28 parcels): perfectly inelastic with the whole
 * body — the person takes the impulse J = m_b v_b · M / (m_b + M) at the hit point (applied to the body), the struck segment's
 * velocity change is v_b · m_b / (m_b + m_s) (the struck-by rule of contact episodes) and a standing person's lean takes the
 * angular impulse. One call per strike; recorded like an episode (IMPACT / INJURED).
 */
export function humanStruck(ctx: SystemContext, e: RuntimeEntity, partner: string, hazard: Hazard, point: Readonly<Vec3>, vel: Readonly<Vec3>, mb: number) {
  const st = e.human!;
  if (e.body === null || !(mb > 0)) return;
  const M = st.bp.mass, k = (mb * M) / (mb + M);
  const J: Vec3 = [vel[0] * k, vel[1] * k, vel[2] * k];
  const jm = Math.hypot(J[0], J[1], J[2]);
  if (!(jm > 0)) return;
  ctx.physics.applyImpulse(e.body, J, [point[0], point[1], point[2]]);
  const q = e.pose.quaternion, p0 = e.pose.position;
  const local = rot(conj(q), [point[0] - p0[0], point[1] - p0[1], point[2] - p0[2]], [0, 0, 0]);
  const shares = segmentShares(st.model, local, SEGMENT_SLACK);
  const vb = Math.hypot(vel[0], vel[1], vel[2]);
  const hits = shares.map((s) => ({ id: s.id, dv: (vb * mb) / (mb + st.model.segments[SEGMENT_IDS.indexOf(s.id)].mass) }));
  if (st.standing) {
    const axis = rot(q, Y, [0, 0, 0]), e1 = rot(q, X, [0, 0, 0]), e2 = rot(q, Z, [0, 0, 0]);
    const tip = cross(cross([point[0] - p0[0], point[1] - p0[1], point[2] - p0[2]], J), axis);
    st.bal.om[0] += dot(tip, e1) / st.bp.Ia;
    st.bal.om[1] += dot(tip, e2) / st.bp.Ia;
    const o = 2 * (FORCE_SOURCES.length + 2);
    st.tipHist[o] += dot(tip, e1);
    st.tipHist[o + 1] += dot(tip, e2);
  }
  const dvp = hits.reduce((a, h) => Math.max(a, h.dv), 0);
  st.impacts++;
  st.stepImpulse += jm;
  if (jm > st.maxImpulse) st.maxImpulse = jm;
  if (vb > st.maxClosing) st.maxClosing = vb;
  st.last = { time: ctx.time, partner, impulse: jm, dv: dvp, decel: NaN, closing: vb, segments: shares, dir: [J[0] / jm, J[1] / jm, J[2] / jm], point: [point[0], point[1], point[2]] };
  e.lastHazard = hazard;
  const rose = applyEpisode(st.risk, hits, st.vRef);
  const cap = capability(st.risk);
  st.incapacitated = cap.incapacitated;
  st.mobility = cap.mobility;
  const seg = shares.length === 0 ? 'unknown' : shares.map((s) => s.id).join('+');
  if (dvp >= RECORD_DV || shares.length === 0) ctx.recordDamage(e, { eventType: 'IMPACT', cause: 'ejecta', hazard, componentId: seg, worldPosition: [point[0], point[1], point[2]], human: { segment: seg, impulse: jm, dv: dvp, partner, posture: st.posture } });
  for (const id of rose) {
    const r = st.risk[id];
    ctx.recordDamage(e, { eventType: 'INJURED', cause: 'ejecta', hazard, componentId: id, response: r.cum, human: { segment: id, index: r.cum, level: r.level, impulse: jm, dv: dvp, partner } });
  }
}

/**
 * The collision capsule touches the terrain within GROUND_GAP: a hemisphere centre's height above the surface, measured
 * along the surface normal (vertical gap · cos θ of the local slope, from central differences of the terrain), is at most
 * the radius + GROUND_GAP. (A vertical gap would grow by R(1/cos θ − 1) on a slope: 3 cm at 29°.)
 */
function onTerrain(ctx: SystemContext, e: RuntimeEntity, q: readonly number[], p0: readonly number[]): boolean {
  const H = e.dims[1], tr = ctx.env.terrain, d = 0.25;
  for (const y of [HUMAN_RADIUS, Math.max(HUMAN_RADIUS, H - HUMAN_RADIUS)]) {
    const c = rot(q, [0, y, 0], [0, 0, 0]);
    const x = p0[0] + c[0], yy = p0[1] + c[1], z = p0[2] + c[2];
    const gx = (tr.sampleHeight(x + d, z) - tr.sampleHeight(x - d, z)) / (2 * d), gz = (tr.sampleHeight(x, z + d) - tr.sampleHeight(x, z - d)) / (2 * d);
    if ((yy - tr.sampleHeight(x, z)) / Math.sqrt(1 + gx * gx + gz * gz) - HUMAN_RADIUS <= GROUND_GAP) return true;
  }
  return false;
}

function comWorld(e: RuntimeEntity, st: HumanState): Vec3 {
  const c = rot(e.pose.quaternion, st.model.com, [0, 0, 0]);
  c[0] += e.pose.position[0]; c[1] += e.pose.position[1]; c[2] += e.pose.position[2];
  return c;
}

const gTmp: Vec3 = [0, 0, 0];
function upAt(ctx: SystemContext, c: Vec3): Vec3 {
  const g = ctx.env.gravity.at(c[0], c[1], c[2], gTmp);
  const gm = Math.hypot(g[0], g[1], g[2]);
  return gm > 1e-6 ? [-g[0] / gm, -g[1] / gm, -g[2] / gm] : [0, 1, 0];
}

export class HumanSystem implements SimulationSystem {
  readonly name = 'humans';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['damage', 'poses', 'forces'] as const;
  readonly writes = ['damage'] as const;
  /** Structural collapse and heat damage of this step are resolved after it (as for DamageSystem): seen next step. */
  readonly lagged = ['damage'] as const;
  private readonly tip = new Float64Array(FORCE_SOURCES.length * 2);

  update(ctx: SystemContext, dt: number) {
    const t0 = simProfiler.now();
    for (const e of ctx.runtime.entities.values()) {
      const st = e.human;
      if (!st) continue;
      if (e.flags.captured || e.body === null) {
        if (st.episodes.size) st.episodes.clear();
        e.hum = undefined;
        continue;
      }
      // Phase 35: seated in a vehicle — the body is out of the collision world, carried with the seat (vehicle occupant model).
      if (e.occupant) {
        if (e.hum) e.hum.fill(0);
        continue;
      }
      this.person(ctx, e, st, dt);
    }
    simProfiler.add('humans', t0);
  }

  private person(ctx: SystemContext, e: RuntimeEntity, st: HumanState, dt: number) {
    const { physics } = ctx;
    const h = e.body!;
    // Fast path: a standing person asleep in Rapier with no load this step and the lean at rest has nothing to update (a
    // change of gravity or any force wakes the body first) — only the chart series keeps its samples.
    if (st.standing && st.started && st.episodes.size === 0 && physics.isSleeping(h) && quiet(st) && (!e.physio || e.physio.couple.canStand)) {
      const ser = st.series;
      if (ser && ctx.time - ser.t[ser.t.length - 1] >= ser.dt - 1e-9 && ser.t.length < SERIES_MAX) {
        ser.t.push(ctx.time); ser.speed.push(0); ser.height.push(ser.height[ser.height.length - 1]); ser.spin.push(0);
        ser.margin.push(st.bal.margin); ser.impulse.push(0); ser.risk.push(ser.risk[ser.risk.length - 1]); ser.contact.push(1);
        ser.posture.push(POSTURES.indexOf(st.posture));
      }
      return;
    }
    const q = e.pose.quaternion, p0 = e.pose.position;
    const v = physics.getLinearVelocity(h), w = physics.getAngularVelocity(h);
    // Numerical limits: never clamped — flagged once and the person is no longer evaluated (the run continues).
    if (!(Number.isFinite(v[0] + v[1] + v[2] + w[0] + w[1] + w[2] + p0[0] + p0[1] + p0[2]))) {
      this.limit(ctx, e, st, 'nonFinite');
      return;
    }
    const c = comWorld(e, st);
    const g = ctx.env.gravity.at(c[0], c[1], c[2], [0, 0, 0]);
    this.energy(st, e, v, w, g, c, dt);
    const gm = Math.hypot(g[0], g[1], g[2]);
    const up: Vec3 = gm > 1e-6 ? [-g[0] / gm, -g[1] / gm, -g[2] / gm] : [0, 1, 0];
    // Supported: a contact, a sleeping body that fell asleep supported (it rests on something — a body far out where float32
    // positions no longer move can fall asleep in free flight; Phase 33 long-run audit), or the capsule's lowest point within
    // GROUND_GAP of the terrain surface under it — after the terrain collider is rebuilt (a crater re-cut it) Rapier reported
    // no contact for bodies standing on it for seconds (measured, Phase 33 audit; HUMAN_PHYSICS.md §20).
    let touching = physics.touching(h);
    if (physics.isSleeping(h)) touching ||= st.sleepSupported;
    else st.sleepSupported = touching ||= onTerrain(ctx, e, q, p0);
    st.freeSteps = touching ? 0 : st.freeSteps + 1;
    const m = st.bp.mass, hc = st.bp.hc;
    if (!st.started) {
      st.started = true;
      // Placed lying / steeply tilted (more than the lying tilt from the world vertical — the placement, not the gravity of
      // the moment: reversed gravity at t = 0 is a loss of support): passive from the start — not a fall.
      if (tiltFromUp(rot(q, Y, [0, 0, 0]), Y) > POSTURE.lying) {
        st.standing = false;
        physics.setRotationsLocked(h, false);
      }
    }

    if (st.standing) {
      const axis = rot(q, Y, [0, 0, 0]), e1 = rot(q, X, [0, 0, 0]), e2 = rot(q, Z, [0, 0, 0]);
      // Support-normal load per unit mass: gravity's component into the support minus the external forces along the body
      // axis (buoyancy and lift make a person lighter on the feet; a person lifted off has no support).
      const a = st.acc;
      let fUp = 0;
      for (let k = 0; k < FORCE_SOURCES.length; k++) {
        const o = k * HUM_STRIDE;
        const f = (a[o] + a[o + 6]) * axis[0] + (a[o + 1] + a[o + 7]) * axis[1] + (a[o + 2] + a[o + 8]) * axis[2];
        fUp += f;
        st.liftHist[k] += f * dt;
      }
      const gn0 = -dot(g, axis), gn = gn0 - fUp / m;
      if (gn < MIN_GN || st.freeSteps >= FREE_RELEASE) {
        a.fill(0);
        // No support from gravity: 'noSupport'. Lifted / thrown off by a force (water, blast, ground shock …) while gravity
        // alone would hold the person: the source with the largest recent lift, else the largest recent push.
        let cause: FallCause = 'noSupport';
        if (gn0 >= MIN_GN) {
          let lm = 0.05 * m * gn0 * TIP_MEMORY;
          for (let k = 0; k < FORCE_SOURCES.length; k++) if (st.liftHist[k] > lm) { lm = st.liftHist[k]; cause = FORCE_SOURCES[k]; }
          if (cause === 'noSupport') cause = recentCause(st, null, 'noSupport');
        }
        this.release(ctx, e, st, cause, axis, e1, e2, v);
      } else if (e.physio && !e.physio.couple.canStand) {
        // Phase 34: unable to act (physiology) — posture control is lost; the released body sinks down (stance()).
        a.fill(0);
        this.release(ctx, e, st, 'physiological', axis, e1, e2, v);
      } else {
        // Tipping moment per ledger source about the stance point s = p0: τ = Σ p×F − s×ΣF + (c − s)×ΣF_com; tip = τ × axis.
        const tip = this.tip;
        let t1 = 0, t2 = 0;
        for (let k = 0; k < FORCE_SOURCES.length; k++) {
          const o = k * HUM_STRIDE;
          const tx = a[o + 3] - (p0[1] * a[o + 2] - p0[2] * a[o + 1]) + ((c[1] - p0[1]) * a[o + 8] - (c[2] - p0[2]) * a[o + 7]);
          const ty = a[o + 4] - (p0[2] * a[o] - p0[0] * a[o + 2]) + ((c[2] - p0[2]) * a[o + 6] - (c[0] - p0[0]) * a[o + 8]);
          const tz = a[o + 5] - (p0[0] * a[o + 1] - p0[1] * a[o]) + ((c[0] - p0[0]) * a[o + 7] - (c[1] - p0[1]) * a[o + 6]);
          // (τ × a)·e₁ = −τ·e₂ and (τ × a)·e₂ = τ·e₁ for the right-handed body axes (e₁ left, a up, e₂ facing).
          tip[2 * k] = -(tx * e2[0] + ty * e2[1] + tz * e2[2]);
          tip[2 * k + 1] = tx * e1[0] + ty * e1[1] + tz * e1[2];
          t1 += tip[2 * k];
          t2 += tip[2 * k + 1];
        }
        a.fill(0);
        // Tangential gravity and the base (body) acceleration.
        const ga = dot(g, axis);
        const gt: Vec3 = [g[0] - ga * axis[0], g[1] - ga * axis[1], g[2] - ga * axis[2]];
        const ab: Vec3 = [(v[0] - st.v[0]) / dt, (v[1] - st.v[1]) / dt, (v[2] - st.v[2]) / dt];
        const gx1 = m * hc * dot(gt, e1), gx2 = m * hc * dot(gt, e2);
        const bx1 = -m * hc * dot(ab, e1), bx2 = -m * hc * dot(ab, e2);
        t1 += gx1 + bx1;
        t2 += gx2 + bx2;
        // Phase 34: physiological capacity scales the available ankle moment (absent: the Phase 33 model unchanged).
        const out = stepBalance(st.bp, st.bal, e.physio ? { gn, t1, t2, f1: 0, f2: 1, control: e.physio.couple.balance } : { gn, t1, t2, f1: 0, f2: 1 }, dt);
        // Recent tipping angular impulse per cause (decaying memory; contacts are added in humanContact).
        const hist = st.tipHist, ns = FORCE_SOURCES.length;
        for (let k = 0; k < ns; k++) { hist[2 * k] += tip[2 * k] * dt; hist[2 * k + 1] += tip[2 * k + 1] * dt; }
        hist[2 * ns] += gx1 * dt; hist[2 * ns + 1] += gx2 * dt;
        hist[2 * ns + 2] += bx1 * dt; hist[2 * ns + 3] += bx2 * dt;
        if (out === 'fall') this.release(ctx, e, st, recentCause(st, fallDir(st, gn), 'gravity'), axis, e1, e2, v, gn);
        else {
          decay(st, dt);
          // Unloaded and settled below 1e-9 rad (rad/s): exactly at rest (the decaying lean never reaches 0 in floating point).
          const b = st.bal;
          if (t1 === 0 && t2 === 0 && Math.abs(b.th[0]) + Math.abs(b.th[1]) + Math.abs(b.om[0]) + Math.abs(b.om[1]) < 1e-9) b.th[0] = b.th[1] = b.om[0] = b.om[1] = 0;
        }
      }
    } else st.acc.fill(0);

    // Free phase (from its first unsupported step, standing or not): highest COM along up — the drop height at the landing.
    if (st.freeSteps > 0) {
      const hgt = dot(c, up);
      if (!(st.airTop >= hgt)) st.airTop = hgt;
    } else if (st.standing) st.airTop = NaN;
    // Tidal load while a celestial source is live.
    const field = ctx.env.gravity.field;
    if (field && field.points.live.length) {
      const T = field.gradient(c[0], c[1], c[2]);
      st.tidal = tidalLoad(st.model, T, rot(q, Y, [0, 0, 0]), rot(q, X, [0, 0, 0]));
      if (st.tidal.bodyWeights > st.tidalPeak) st.tidalPeak = st.tidal.bodyWeights;
    }
    // Contact episodes: the body's state at a contact step; close finished episodes.
    if (st.episodes.size) {
      for (const [k, ep] of st.episodes) {
        if (ep.lastStep === ctx.step) {
          ep.v1 = v;
          ep.w1 = w;
          ep.c1 = c;
          ep.p1 = [p0[0], p0[1], p0[2]];
          ep.q1 = [q[0], q[1], q[2], q[3]];
        }
        if (ctx.step - ep.lastStep > GAP || ep.steps >= MAX_STEPS) {
          st.episodes.delete(k);
          this.finish(ctx, e, st, ep, dt);
        }
      }
    }
    // Posture from the body's state.
    const speed = Math.hypot(v[0], v[1], v[2]), spin = Math.hypot(w[0], w[1], w[2]);
    if (spin > st.maxSpin) st.maxSpin = spin;
    if (spin > EXTREME_SPIN) this.limit(ctx, e, st, 'extremeSpin');
    st.stillFor = speed < POSTURE.stillV && spin < POSTURE.stillW ? st.stillFor + dt : 0;
    const posture = classifyPosture({
      standing: st.standing,
      lean: Math.hypot(st.bal.th[0], st.bal.th[1]),
      axis: rot(q, Y, [0, 0, 0]),
      facing: rot(q, Z, [0, 0, 0]),
      up,
      speed,
      spin,
      freeSteps: st.freeSteps,
      stillFor: st.stillFor,
      sinceLanding: ctx.time - st.lastLanding,
      incapacitated: st.incapacitated,
    });
    if (posture !== st.posture) {
      st.posture = posture;
      st.postureChanges++;
    }
    if (!st.standing) this.stance(ctx, e, st, g, up, touching, speed, spin, dt);
    // Health and state from the injury model only (single owner).
    let maxCum = 0;
    for (const id of SEGMENT_IDS) maxCum = Math.max(maxCum, st.risk[id].cum);
    e.health = Math.max(0, 1 - maxCum / 2);
    const lv = levelRank(worstLevel(st.risk));
    let s: DamageState = lv >= 3 ? DamageState.CRITICAL : lv === 2 ? DamageState.DAMAGED : lv === 1 ? DamageState.STRESSED : DamageState.NORMAL;
    if (e.flood) s = worst(s, floodLevel(e.flood));
    e.state = Math.min(s, DamageState.CRITICAL) as DamageState;
    // Chart series (bounded set of people).
    const ser = st.series;
    if (ser && (ser.t.length === 0 || ctx.time - ser.t[ser.t.length - 1] >= ser.dt - 1e-9)) {
      // Bounded: past SERIES_MAX samples every second one is dropped and the interval doubles.
      if (ser.t.length >= SERIES_MAX) {
        for (const k of SERIES_KEYS) {
          const a = ser[k];
          let j = 0;
          for (let i = 0; i < a.length; i += 2) a[j++] = a[i];
          a.length = j;
        }
        ser.dt *= 2;
      }
      ser.t.push(ctx.time);
      ser.speed.push(speed);
      ser.height.push(dot(c, up));
      ser.spin.push(spin);
      ser.margin.push(st.standing ? st.bal.margin : NaN);
      ser.impulse.push(st.stepImpulse);
      ser.risk.push(maxCum);
      ser.contact.push(touching ? 1 : 0);
      ser.posture.push(POSTURES.indexOf(st.posture));
    }
    st.stepImpulse = 0;
    st.v = v;
    st.w = w;
  }

  /** A model limit met: flagged once per person, logged (no value is clamped). */
  private limit(ctx: SystemContext, e: RuntimeEntity, st: HumanState, id: string) {
    if (st.limits.includes(id)) return;
    st.limits.push(id);
    ctx.log(e.id, 'warn', { key: 'log.human.limit', params: { what: `@human.limit.${id}` } });
  }

  /** Energy ledger of the step (see HumanState.energy); uses this step's ledger forces before the balance model reads them. */
  private energy(st: HumanState, e: RuntimeEntity, v: Vec3, w: Vec3, g: Vec3, c: Vec3, dt: number) {
    const E = st.energy, m = st.bp.mass, I = st.model.inertia;
    const Wl = rot(conj(e.pose.quaternion), w, [0, 0, 0]);
    const ke = 0.5 * m * m2(v) + 0.5 * (I[0] * Wl[0] * Wl[0] + I[1] * Wl[1] * Wl[1] + I[2] * Wl[2] * Wl[2]);
    if (E.ke0 !== E.ke0) {
      E.ke0 = E.ke = ke;
      return;
    }
    const vb: Vec3 = [(v[0] + st.v[0]) / 2, (v[1] + st.v[1]) / 2, (v[2] + st.v[2]) / 2];
    const wb: Vec3 = [(w[0] + st.w[0]) / 2, (w[1] + st.w[1]) / 2, (w[2] + st.w[2]) / 2];
    const wg = m * dot(g, vb) * dt;
    let we = 0;
    const a = st.acc;
    for (let k = 0; k < FORCE_SOURCES.length; k++) {
      const o = k * HUM_STRIDE;
      const fx = a[o] + a[o + 6], fy = a[o + 1] + a[o + 7], fz = a[o + 2] + a[o + 8];
      // Torque about the COM of the forces at points: Σ p × F − c × Σ F.
      const tx = a[o + 3] - (c[1] * a[o + 2] - c[2] * a[o + 1]);
      const ty = a[o + 4] - (c[2] * a[o] - c[0] * a[o + 2]);
      const tz = a[o + 5] - (c[0] * a[o + 1] - c[1] * a[o]);
      we += (fx * vb[0] + fy * vb[1] + fz * vb[2] + tx * wb[0] + ty * wb[1] + tz * wb[2]) * dt;
    }
    const rel = E.pendingRelease;
    E.pendingRelease = 0;
    const rest = ke - E.ke - wg - we - rel;
    E.gravity += wg;
    E.external += we;
    E.release += rel;
    if (st.stepImpulse > 0) E.contact += rest;
    else E.other += rest;
    E.ke = ke;
  }

  /** Regained stance / collapse of a released body standing still on its feet (see STANCE_*). */
  private stance(ctx: SystemContext, e: RuntimeEntity, st: HumanState, g: Vec3, up: Vec3, touching: boolean, speed: number, spin: number, dt: number) {
    const q = e.pose.quaternion;
    const axis = rot(q, Y, [0, 0, 0]);
    const ok = touching && speed < STANCE_V && spin < STANCE_W && tiltFromUp(axis, up) < STANCE_TILT;
    st.uprightFor = ok ? st.uprightFor + dt : 0;
    if (st.uprightFor < STANCE_TIME) return;
    st.uprightFor = 0;
    const h = e.body!;
    if (!st.incapacitated && st.mobility !== 'immobile' && (!e.physio || e.physio.couple.canStand) && -dot(g, axis) >= MIN_GN) {
      st.standing = true;
      st.regained++;
      st.bal.th[0] = st.bal.th[1] = st.bal.om[0] = st.bal.om[1] = 0;
      st.acc.fill(0);
      e.hum = st.acc;
      e.flags.fallen = false;
      e.rev++;
      ctx.physics.setVelocity(h, [0, 0, 0], [0, 0, 0]);
      ctx.physics.setRotationsLocked(h, true);
      ctx.log(e.id, 'info', { key: 'log.human.regained' });
      return;
    }
    // Cannot stand: the legs give way — laid prone (+90° about the body's left axis: axis → facing, face → down), the
    // capsule resting on the support (axis HUMAN_RADIUS above it).
    st.collapsed++;
    const left = rot(q, X, [0, 0, 0]);
    const s = Math.SQRT1_2, r = [left[0] * s, left[1] * s, left[2] * s, s];
    const quat = qMul(r, q) as unknown as [number, number, number, number];
    const p0 = e.pose.position;
    const pos: Vec3 = [p0[0] + up[0] * HUMAN_RADIUS, p0[1] + up[1] * HUMAN_RADIUS, p0[2] + up[2] * HUMAN_RADIUS];
    const gl = Math.hypot(g[0], g[1], g[2]);
    st.collapseEnergy += st.bp.mass * gl * Math.max(0, st.bp.hc - HUMAN_RADIUS);
    ctx.physics.setBodyPose(h, pos, quat);
    ctx.physics.setVelocity(h, [0, 0, 0], [0, 0, 0]);
    e.pose.position = pos;
    e.pose.quaternion = quat;
    ctx.log(e.id, 'danger', { key: 'log.human.collapsed' });
  }

  /** Loss of balance / support: hand the standing body to the rigid-body dynamics. */
  private release(ctx: SystemContext, e: RuntimeEntity, st: HumanState, cause: FallCause, axis: Vec3, e1: Vec3, e2: Vec3, v: Vec3, gn = 9.80665) {
    const { physics } = ctx;
    const h = e.body!;
    st.standing = false;
    st.acc.fill(0);
    e.flags.fallen = true;
    e.rev++;
    st.falls++;
    if (st.firstFall !== st.firstFall) st.firstFall = ctx.time;
    st.fallCause = cause;
    physics.setRotationsLocked(h, false);
    const th = st.bal.th, om = st.bal.om;
    const omw: Vec3 = [om[0] * e1[0] + om[1] * e2[0], om[0] * e1[1] + om[1] * e2[1], om[0] * e1[2] + om[1] * e2[2]];
    // Fall direction û (extrapolated COM), the lean's component along it (the lean against the load is not applied).
    const [u1, u2] = fallDir(st, gn);
    const ang = Math.max(0, th[0] * u1 + th[1] * u2);
    const p0 = e.pose.position;
    // Pivot: the support edge in the fall's direction (the stance point when there is no lean).
    let pivot: Vec3 = [p0[0], p0[1], p0[2]];
    if (ang > 1e-9 && cause !== 'noSupport') {
      const u: Vec3 = [u1 * e1[0] + u2 * e2[0], u1 * e1[1] + u2 * e2[1], u1 * e1[2] + u2 * e2[2]];
      const ed = edgeDistance(st.bp, u1, u2, 0, 1);
      pivot = [p0[0] + u[0] * ed, p0[1] + u[1] * ed, p0[2] + u[2] * ed];
      // Rotate the body by the lean about k = axis × û through the pivot (the COM moves towards û).
      const k = cross(axis, u);
      const s = Math.sin(ang / 2), r = [k[0] * s, k[1] * s, k[2] * s, Math.cos(ang / 2)];
      const rel: Vec3 = [p0[0] - pivot[0], p0[1] - pivot[1], p0[2] - pivot[2]];
      const rr = rot(r, rel, [0, 0, 0]);
      const pos: Vec3 = [pivot[0] + rr[0], pivot[1] + rr[1], pivot[2] + rr[2]];
      const quat = qMul(r, e.pose.quaternion) as unknown as [number, number, number, number];
      physics.setBodyPose(h, pos, quat);
      e.pose.position = pos;
      e.pose.quaternion = quat;
    }
    // The lean's motion: angular velocity Ω = axis × θ̇ (COM moving along θ̇), the COM's velocity about the pivot.
    const W = cross(axis, omw);
    const c = comWorld(e, st);
    const wr = cross(W, [c[0] - pivot[0], c[1] - pivot[1], c[2] - pivot[2]]);
    const vn: Vec3 = cause === 'noSupport' ? [v[0], v[1], v[2]] : [v[0] + wr[0], v[1] + wr[1], v[2] + wr[2]];
    physics.setVelocity(h, vn, W);
    const I = st.model.inertia;
    const Wl = rot(conj(e.pose.quaternion), W, [0, 0, 0]);
    const dE = 0.5 * m2(vn) * st.bp.mass - 0.5 * m2(v) * st.bp.mass + 0.5 * (I[0] * Wl[0] * Wl[0] + I[1] * Wl[1] * Wl[1] + I[2] * Wl[2] * Wl[2]);
    st.releaseEnergy += dE;
    st.energy.pendingRelease += dE;
    const hr = dot(c, upAt(ctx, c));
    if (!(st.airTop >= hr)) st.airTop = hr;
    const [dc, hz] = CAUSE[cause];
    const hazard = hz ?? e.lastHazard ?? 'gravity';
    e.lastCause = dc;
    e.lastHazard = hazard;
    ctx.recordDamage(e, { eventType: 'FALLEN', cause: dc, hazard, response: Math.hypot(th[0], th[1]), human: { posture: 'falling', partner: cause } });
    ctx.log(e.id, 'danger', { key: `log.human.fall.${cause}` });
  }

  /**
   * A finished contact episode: impulse, velocity changes, segments, risk index, events. The struck point's velocity change
   * is read from the body's actual motion (v + ω × r before the first and after the last contact step) — valid for a
   * contact spread along the body, where one equivalent point impulse would overstate it. Without a contact point: the
   * COM's change J/m.
   */
  private finish(ctx: SystemContext, e: RuntimeEntity, st: HumanState, ep: Episode, dt: number) {
    const jm = Math.hypot(ep.J[0], ep.J[1], ep.J[2]);
    if (!(jm > 0)) return;
    const m = st.bp.mass, q = ep.q1, p0 = ep.p1, c = ep.c1;
    const dvCom = jm / m;
    const decel = dvCom / (ep.steps * dt);
    const P: Vec3 = ep.jw > 0 ? [ep.P[0] / ep.jw, ep.P[1] / ep.jw, ep.P[2] / ep.jw] : [NaN, NaN, NaN];
    // Struck segments: share of the contact impulse, the struck point's velocity change from the body's motion.
    let jn = ep.unknown;
    for (let k = 0; k < SEGMENT_IDS.length; k++) jn += ep.seg[k * 4];
    const shares: { id: (typeof SEGMENT_IDS)[number]; share: number }[] = [];
    const hits: { id: (typeof SEGMENT_IDS)[number]; dv: number }[] = [];
    let dvp = jn > 0 ? 0 : dvCom;
    // Velocity change of a body point (world, relative to the stance origin) from the body's motion. A person struck by a
    // moving body while pinned against a support barely moves (a falling car on the head): there the struck segment takes
    // the striker's closing speed reduced by the mass ratio, v_c · m_p / (m_p + m_s) — the change a free segment of mass
    // m_s would get. The larger of the two is used (for the ground, a static partner, the body's own change).
    const dvAt = (pw: Vec3, ms: number) => {
      const r: Vec3 = [pw[0] + p0[0] - c[0], pw[1] + p0[1] - c[1], pw[2] + p0[2] - c[2]];
      const a0 = cross(ep.w0, r), a1 = cross(ep.w1, r);
      const kin = Math.hypot(ep.v1[0] + a1[0] - ep.v0[0] - a0[0], ep.v1[1] + a1[1] - ep.v0[1] - a0[1], ep.v1[2] + a1[2] - ep.v0[2] - a0[2]);
      const struck = Number.isFinite(ep.mp) ? (ep.closing * ep.mp) / (ep.mp + ms) : 0;
      return Math.max(kin, struck);
    };
    // Landing on the ground: the single collision capsule reports contact points at its ends only, so the segments struck
    // are found geometrically — a segment whose surface (the capsule's radius) lies within PLANE_GAP of the contact plane
    // at the end of the episode was struck, at the velocity change of its lowest point.
    const nm = Math.hypot(ep.N[0], ep.N[1], ep.N[2]);
    const planar = ep.partner === 'ground' && nm > 0 && ep.jw > 0;
    const n: Vec3 = planar ? [ep.N[0] / nm, ep.N[1] / nm, ep.N[2] / nm] : [0, 0, 0];
    for (let k = 0; k < SEGMENT_IDS.length; k++) {
      const s = st.model.segments[k];
      const j = ep.seg[k * 4];
      let pw: Vec3 | null = null;
      // The neck is shielded from a flat surface by the head and the shoulders: only a direct contact point counts.
      if (planar && s.id !== 'neck') {
        // Lowest end of the segment axis along n, its surface point.
        const a = rot(q, [s.x, s.y0, 0], [0, 0, 0]), b = rot(q, [s.x, s.y1, 0], [0, 0, 0]);
        const da = (a[0] + p0[0] - P[0]) * n[0] + (a[1] + p0[1] - P[1]) * n[1] + (a[2] + p0[2] - P[2]) * n[2];
        const db = (b[0] + p0[0] - P[0]) * n[0] + (b[1] + p0[1] - P[1]) * n[1] + (b[2] + p0[2] - P[2]) * n[2];
        const lo = da <= db ? a : b, dl = Math.min(da, db);
        if (dl - HUMAN_RADIUS <= PLANE_GAP) pw = [lo[0] - n[0] * HUMAN_RADIUS, lo[1] - n[1] * HUMAN_RADIUS, lo[2] - n[2] * HUMAN_RADIUS];
      } else if (jn > 0 && j / jn >= MIN_SHARE) {
        pw = rot(q, [ep.seg[k * 4 + 1] / j, ep.seg[k * 4 + 2] / j, ep.seg[k * 4 + 3] / j], [0, 0, 0]);
      }
      if (!pw) continue;
      const dv = dvAt(pw, s.mass);
      shares.push({ id: SEGMENT_IDS[k], share: jn > 0 ? j / jn : 0 });
      hits.push({ id: SEGMENT_IDS[k], dv });
      if (dv > dvp) dvp = dv;
    }
    st.impacts++;
    if (dvp > EXTREME_DV) this.limit(ctx, e, st, 'extremeImpact');
    if (jm > st.maxImpulse) st.maxImpulse = jm;
    if (ep.closing > st.maxClosing) st.maxClosing = ep.closing;
    if (decel > st.maxDecel) st.maxDecel = decel;
    if (ep.landing) st.lastLanding = ctx.time;
    st.last = { time: ctx.time, partner: ep.partner, impulse: jm, dv: dvp, decel, closing: ep.closing, segments: shares, dir: [ep.J[0] / jm, ep.J[1] / jm, ep.J[2] / jm], point: P };
    const rose = applyEpisode(st.risk, hits, st.vRef);
    const cap = capability(st.risk);
    const wasInc = st.incapacitated;
    st.incapacitated = cap.incapacitated;
    st.mobility = cap.mobility;
    const hazard: Hazard = (ep.hazard as Hazard | null) ?? (ep.partner === 'ground' ? (st.fallCause ? CAUSE[st.fallCause as FallCause]?.[1] ?? e.lastHazard ?? 'gravity' : e.lastHazard ?? 'gravity') : e.lastHazard ?? 'wind');
    const seg = shares.length === 0 ? 'unknown' : shares.length === 1 ? shares[0].id : shares.map((s) => s.id).join('+');
    if (dvp >= RECORD_DV) {
      ctx.recordDamage(e, {
        eventType: 'IMPACT', cause: 'impact', hazard, force: ep.peak, componentId: seg, worldPosition: P[0] === P[0] ? P : undefined,
        human: { segment: seg, impulse: jm, dv: dvp, decel, partner: ep.partner, posture: st.posture },
      });
    }
    for (const id of rose) {
      const r = st.risk[id];
      ctx.recordDamage(e, {
        eventType: 'INJURED', cause: 'impact', hazard, componentId: id, response: r.cum,
        human: { segment: id, index: r.cum, level: r.level, impulse: jm, dv: dvp, partner: ep.partner },
      });
      if (levelRank(r.level) >= 2) ctx.log(e.id, 'danger', { key: 'log.human.injury', params: { seg: `@human.seg.${id}`, level: `@human.level.${r.level}` } });
    }
    if (!wasInc && st.incapacitated) ctx.log(e.id, 'danger', { key: 'log.human.incapacitated' });
  }
}

const m2 = (v: readonly number[]) => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];

const EXTRA_CAUSES: FallCause[] = ['gravity', 'slip', 'contact'];

/** No load accumulated this step and the lean at rest (see the fast path of HumanSystem.person). */
function quiet(st: HumanState): boolean {
  const b = st.bal;
  if (b.th[0] !== 0 || b.th[1] !== 0 || b.om[0] !== 0 || b.om[1] !== 0 || st.stepImpulse !== 0) return false;
  const a = st.acc;
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

function decay(st: HumanState, dt: number) {
  const keep = Math.exp(-dt / TIP_MEMORY), h = st.tipHist, l = st.liftHist;
  for (let i = 0; i < h.length; i++) h[i] *= keep;
  for (let i = 0; i < l.length; i++) l[i] *= keep;
}

/**
 * The cause with the largest recent tipping impulse along the fall direction u (plane axes) — or by magnitude without a
 * direction (thrown off the support). `fallback` when nothing pushed.
 */
function recentCause(st: HumanState, u: [number, number] | null, fallback: FallCause): FallCause {
  const h = st.tipHist, ns = FORCE_SOURCES.length;
  // External causes first (ledger sources, tangential gravity, contacts); 'slip' — the base sliding, itself a consequence
  // of those forces and the friction — only when none of them pushed towards the fall.
  // When no external cause pushed along the fall (a load below the COM on a sliding body rotates it backwards), the
  // external cause with the largest recent impulse is still the origin.
  let best = fallback, bv = 0, bm = fallback, mv = 0;
  for (let k = 0; k < ns + EXTRA_CAUSES.length; k++) {
    const c = k < ns ? FORCE_SOURCES[k] : EXTRA_CAUSES[k - ns];
    if (c === 'slip') continue;
    const s = u ? h[2 * k] * u[0] + h[2 * k + 1] * u[1] : 0, mag = Math.hypot(h[2 * k], h[2 * k + 1]);
    if (s > bv) { bv = s; best = c; }
    if (mag > mv) { mv = mag; bm = c; }
  }
  if (bv > 0) return best;
  if (mv > 0) return bm;
  return Math.hypot(h[2 * (ns + 1)], h[2 * (ns + 1) + 1]) > 0 ? 'slip' : fallback;
}

/** Unit direction (plane axes) of the extrapolated COM θ + θ̇/ω₀ of a standing person (the lean when it is zero). */
function fallDir(st: HumanState, gn = 9.80665): [number, number] {
  const b = st.bp, th = st.bal.th, om = st.bal.om;
  const w0 = Math.sqrt((Math.max(gn, 1e-3) * b.mass * b.hc) / b.Ia);
  let x1 = th[0] + om[0] / w0, x2 = th[1] + om[1] / w0;
  let n = Math.hypot(x1, x2);
  if (!(n > 1e-12)) { x1 = th[0]; x2 = th[1]; n = Math.hypot(x1, x2); }
  return n > 1e-12 ? [x1 / n, x2 / n] : [0, 1];
}
