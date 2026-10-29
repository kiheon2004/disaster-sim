/**
 * Celestial runtime (Phase 32): the part of the gravity runtime that serves the celestial point sources. It owns no
 * gravity of its own — every acceleration it uses is a sample of the ONE field (GravityField, Phase 31 part + point
 * sources) — and it never applies a force twice: Rapier keeps applying m·g(x₀) through its uniform gravity and the
 * 'gravityField' force (GravityRuntime.pre); this runtime only replaces, for free-flying bodies, the first-order
 * gravity increment of that step by the KDK result (docs/EXTREME_CELESTIAL.md §15–§17):
 *
 *   Rapier, constant a over a step:  x₁ = x₀ + v₀·dt + κ·a·dt²,  v₁ = (v₀ + a·dt)/(1 + d·dt)   (κ = (n + 1)/(2n))
 *   gravity part of it:              Δx_R = κ·g·dt²,             Δv_R = g·dt/(1 + d·dt)
 *   KDK (substeps, same field):      Δx_K = x* − x₀ − v₀·dt,     Δv_K = (v* − v₀)/(1 + d·dt)
 *   corrected:                       x₁ ← x₁ + Δx_K − Δx_R,      v₁ ← v₁ + Δv_K − Δv_R
 * Everything else Rapier did in that step (other forces, damping) stays; a body with a solver contact in the step
 * keeps Rapier's result (contact state — first order, counted). Bodies: free → orbit-integrated; contact → Rapier;
 * captured → removed with its mass, momentum and energy booked; left → out of the world.
 *
 * Also here: probe bodies (orbit laboratory test spheres), physical accretion test particles (not Rapier bodies),
 * capture of bodies / particles, the gravity-gradient torque on elongated bodies, orbit diagnostics, the capture
 * ledger, model-limit policy, milestones and the history for the results.
 */
import type { Vec3 } from '@/core/types';
import type { BodyHandle } from '@/physics/PhysicsEngine';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity, DebrisPiece } from '../SimulationRuntime';
import type { GravityField } from '@/gravity/field';
import type { GravityLedger } from '@/gravity/ledger';
import { kdk, newKdkResult, type StepField } from '@/celestial/integrator';
import { CELESTIAL_LIMITS, type CelestialSpec } from '@/celestial/types';
import { circularSpeed, escapeSpeed, launchVelocity } from '@/celestial/orbit';
import { symEigenvalues, boxSecondMoment, gradientTorque } from '@/celestial/tidal';
import { G_N, schwarzschildRadius } from '@/celestial/constants';
import { newForceRecord, type ForceRecord } from '../forces/ForceLedger';
import { CelestialLedger, type CaptureKind } from '@/celestial/ledger';
import { CelestialStructures } from './structures';

/** Seconds between history samples, history length. */
const SERIES_DT = 0.25;
const SERIES_MAX = 6000;
/** Trail points per probe (ring). */
export const TRAIL = 600;
/** Probe diagnostics in the history (the first ones). */
export const SERIES_PROBES = 4;
/** Gradient torque is applied above this |T| (1/s²) — below it the torque is negligible against contacts / damping. */
const TORQUE_MIN = 1e-3;

export interface OrbitDiag {
  /** Energy per unit mass at the first booked step, current, worst relative error so far (J/kg). */
  e0: number;
  e: number;
  maxErr: number;
  /** Angular momentum per unit mass about the reference source at the start, worst relative error. */
  l0: Vec3;
  lErr: number;
  /** Distance to the reference source: current, min / max seen (m), speed (m/s), |g| (m/s²). */
  r: number;
  rMin: number;
  rMax: number;
  v: number;
  a: number;
  /** Revolutions completed in the orbit plane, time of the first crossing, mean period (s; NaN before two). */
  revs: number;
  tFirst: number;
  period: number;
  /** The energy / angular momentum are conserved quantities of this run (static single central source, no uniform
   *  part) — otherwise the errors are shown as changes, not errors. */
  conserved: boolean;
  private_angle: number;
}

export interface Probe {
  id: string;
  /** Experiment (canonical index) and probe index. */
  exp: number;
  index: number;
  body: BodyHandle | null;
  mass: number;
  radius: number;
  forces: ForceRecord;
  pos: Vec3;
  vel: Vec3;
  state: 'orbit' | 'contact' | 'captured' | 'left';
  /** Reference source (live index lookup by owner / index). */
  ref: { owner: number; index: number };
  diag: OrbitDiag;
  trail: Float32Array;
  trailN: number;
  trailHead: number;
}

export interface CelestialStats {
  /** Sources in force: mass (kg), μ, r_s (reference), ε, capture radius, position. */
  sources: { owner: number; index: number; mass: number; mu: number; rs: number; eps: number; capture: number; x: number; y: number; z: number; policy: string; moving: boolean }[];
  /** Largest |g| and tidal stretch (λ₁, 1/s²) sampled at bodies this step. */
  maxAccel: number;
  maxTidal: number;
  /** Bodies integrated by KDK this step, in contact (Rapier), probes / particles flying. */
  orbiting: number;
  contact: number;
  particles: number;
  landed: number;
  /** Substeps: largest this step, mean per integrated body this step, capped steps so far. */
  maxSubsteps: number;
  meanSubsteps: number;
  capped: number;
  /** Captures so far (count, kg). */
  captured: number;
  capturedMass: number;
  /** Model-limit state: none / warned / stopped, reason key. */
  limit: 'none' | 'warn' | 'stop';
  limitReason: string;
  ms: number;
}

export interface CelestialSeriesPoint {
  t: number;
  /** Per probe (first SERIES_PROBES): distance, speed, |g|, specific energy, |L| per unit mass (NaN once gone). */
  r: number[];
  v: number[];
  a: number[];
  e: number[];
  l: number[];
  maxTidal: number;
  capturedMass: number;
  sourceMass: number[];
  failures: number;
}

const tmp: Vec3 = [0, 0, 0];

export class CelestialRuntime {
  readonly ledger = new CelestialLedger();
  readonly probes: Probe[] = [];
  readonly stats: CelestialStats = { sources: [], maxAccel: 0, maxTidal: 0, orbiting: 0, contact: 0, particles: 0, landed: 0, maxSubsteps: 0, meanSubsteps: 0, capped: 0, captured: 0, capturedMass: 0, limit: 'none', limitReason: '', ms: 0 };
  readonly series: CelestialSeriesPoint[] = [];
  /** Storey lateral loads and the uplift check (structures.ts). */
  readonly structures = new CelestialStructures();
  /** Accretion test particles: position / velocity (3 per particle), state (0 none, 1 flying, 2 landed, 3 captured,
   *  4 left), mass (kg). */
  px = new Float64Array(0);
  pv = new Float64Array(0);
  pstate = new Uint8Array(0);
  pmass = 0;
  /** Structural failures attributed to the celestial field (StructuralCollapseSystem / tidal model). */
  failures = 0;
  /** Set when the stop policy halts the run (the controller pauses on it). */
  stopRequest: { time: number; reason: string } | null = null;
  private readonly started = new Set<number>();
  private readonly f: GravityField;
  private readonly sf: StepField;
  private readonly res = newKdkResult();
  private readonly x = new Float64Array(3);
  private readonly v = new Float64Array(3);
  private readonly T = new Float64Array(9);
  private readonly S = new Float64Array(9);
  private readonly R = new Float64Array(9);
  private nextSeries = 0;
  private sumN = 0;
  private nInt = 0;
  private approach = new Set<string>();

  constructor(f: GravityField) {
    this.f = f;
    this.sf = {
      accel: (x, y, z, out) => f.sample(x, y, z, out),
      segmentTimescale: (x, y, z, vx, vy, vz, dt) => f.points.segmentTimescale(x, y, z, vx, vy, vz, dt),
      captureAt: (x, y, z) => f.points.captureAt(x, y, z),
    };
  }

  get experiments() {
    return this.f.celestial;
  }

  // ── Before the physics step (after the field is prepared) ─────────────────────────────────

  pre(ctx: SystemContext) {
    const t0 = performance.now();
    const f = this.f;
    f.celestial.forEach((e, k) => {
      if (ctx.time >= e.start && !this.started.has(k)) {
        this.started.add(k);
        this.begin(ctx, e.spec, k, e.start);
      }
    });
    this.torques(ctx);
    this.stats.ms = performance.now() - t0;
  }

  /** Start of an experiment: probes spawned with their initial conditions, accretion particles placed, milestone. */
  private begin(ctx: SystemContext, spec: CelestialSpec, exp: number, start: number) {
    ctx.milestone?.({ time: start, kind: 'celestialStart', subject: 'celestial', label: { key: 'ms.celestial.start' as never, params: { n: String(spec.sources.length) } } });
    spec.probes.forEach((p, index) => {
      const s = spec.sources[p.source ?? 0];
      const c = s.motion === 'path' && s.path ? [s.path[0][1], s.path[0][2], s.path[0][3]] as Vec3 : s.center;
      const r: Vec3 = [p.position[0] - c[0], p.position[1] - c[1], p.position[2] - c[2]];
      const rm = Math.hypot(r[0], r[1], r[2]);
      const mu = G_N * s.mass;
      let vel: Vec3;
      if (p.mode === 'custom') vel = [...(p.velocity ?? [0, 0, 0])] as Vec3;
      else {
        const speed = p.factor * (p.mode === 'circular' ? circularSpeed(mu, rm, s.softening) : escapeSpeed(mu, rm, s.softening));
        vel = launchVelocity(r, p.direction, speed, p.mode === 'circular');
      }
      if (s.motion === 'velocity' && s.velocity) for (let i = 0; i < 3; i++) vel[i] += s.velocity[i];
      const body = ctx.physics.createBody({
        kind: 'dynamic', position: [...p.position] as Vec3, quaternion: [0, 0, 0, 1],
        shapes: [{ type: 'ball', radius: p.radius }], mass: p.mass, friction: 0.5, restitution: 0.2,
        // Test bodies in vacuum: no air drag (the orbit laboratory measures the field, not the air).
        linearDamping: 0, angularDamping: 0, ccd: true,
        userData: { entityId: `celestial-probe-${exp}-${index}` },
      });
      ctx.physics.writeMotion(body, p.position, vel);
      const probe: Probe = {
        id: `probe-${exp}-${index}`, exp, index, body, mass: p.mass, radius: p.radius, forces: newForceRecord(),
        pos: [...p.position] as Vec3, vel, state: 'orbit', ref: { owner: exp, index: p.source ?? 0 },
        diag: { e0: NaN, e: NaN, maxErr: 0, l0: [0, 0, 0], lErr: 0, r: rm, rMin: rm, rMax: rm, v: Math.hypot(...vel), a: 0, revs: 0, tFirst: NaN, period: NaN, conserved: false, private_angle: NaN },
        trail: new Float32Array(3 * TRAIL), trailN: 0, trailHead: 0,
      };
      this.probes.push(probe);
    });
    const a = spec.accretion;
    if (a.particles > 0) {
      const s = spec.sources[a.source ?? 0];
      const n0 = this.pstate.length;
      const N = n0 + a.particles;
      const grow = (old: Float64Array, n: number) => { const x = new Float64Array(n); x.set(old); return x; };
      this.px = grow(this.px, 3 * N); this.pv = grow(this.pv, 3 * N);
      const st = new Uint8Array(N); st.set(this.pstate); this.pstate = st;
      this.pmass = a.particleMass;
      const mu = G_N * s.mass;
      // Deterministic placement: radii by the van der Corput sequence (area-uniform), angles by the golden angle; a
      // small vertical spread so the ring is a disc, circular velocity of the single source (counter-clockwise).
      for (let k = 0; k < a.particles; k++) {
        let q = 0, b = 0.5, m = k + 1;
        while (m > 0) { if (m & 1) q += b; m >>= 1; b /= 2; }
        const r = Math.sqrt(a.inner * a.inner + q * (a.outer * a.outer - a.inner * a.inner));
        const th = k * 2.399963229728653;
        const h = ((k * 0.6180339887498949) % 1 - 0.5) * 0.04 * r;
        const i = n0 + k;
        const c = s.center;
        this.px[3 * i] = c[0] + r * Math.cos(th); this.px[3 * i + 1] = c[1] + h; this.px[3 * i + 2] = c[2] + r * Math.sin(th);
        const vc = circularSpeed(mu, r, s.softening) * (1 - (a.spread ?? 0) * ((k * 0.7548776662466927) % 1));
        this.pv[3 * i] = -vc * Math.sin(th); this.pv[3 * i + 1] = 0; this.pv[3 * i + 2] = vc * Math.cos(th);
        this.pstate[i] = 1;
      }
      this.ledger.particlesIn += a.particles * a.particleMass;
    }
  }

  /** Gravity-gradient torque τ = ε·S·Tᵀ on elongated awake bodies (entities: their box; debris: their size). */
  private torques(ctx: SystemContext) {
    const f = this.f, physics = ctx.physics, dt = 1 / 60;
    const apply = (h: BodyHandle, m: number, dims: Readonly<Vec3>, q: Readonly<[number, number, number, number]>, p: Readonly<Vec3>) => {
      if (physics.isSleeping(h)) return;
      const T = f.gradient(p[0], p[1], p[2], this.T);
      let tn = 0;
      for (let i = 0; i < 9; i++) tn = Math.max(tn, Math.abs(T[i]));
      if (tn < TORQUE_MIN) return;
      // Rotation matrix of the quaternion (columns = body axes in world).
      const [x, y, z, w] = q, R = this.R;
      R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
      R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
      R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
      const tq = gradientTorque(boxSecondMoment(m, dims, R, this.S), T, tmp);
      if (tq[0] === 0 && tq[1] === 0 && tq[2] === 0) return;
      physics.applyTorqueImpulse(h, [tq[0] * dt, tq[1] * dt, tq[2] * dt]);
    };
    for (const e of ctx.runtime.entities.values()) {
      if (!e.dynamic || e.body === null || e.def.physicsProfile === 'upright') continue;
      apply(e.body, physics.getMass(e.body), e.dims, e.pose.quaternion, e.pose.position);
    }
    for (const d of ctx.runtime.debris) apply(d.body, d.mass, d.size, d.pose.quaternion, d.pose.position);
  }

  // ── After the physics step: per body (called by GravityRuntime.post before its ledger booking) ─────

  /**
   * Replace the gravity increment of a free body's step by the KDK result and book it. Returns false when the body is
   * not eligible (asleep, in contact) — the caller books Rapier's result as before. `captured` is set when the body
   * entered a capture sphere in this step (the caller removes it after the loop).
   */
  integrate(ctx: SystemContext, h: BodyHandle, m: number, x0: Readonly<Vec3>, v0: Readonly<Vec3>, g0: Readonly<Vec3>, phi0: number, dt: number, ledger: GravityLedger, out: { captured: number; x: Vec3; v: Vec3 }): boolean {
    const physics = ctx.physics;
    if (physics.isSleeping(h)) return false;
    if (physics.touching(h)) { this.stats.contact++; return false; }
    const x = this.x, v = this.v, res = this.res;
    x[0] = x0[0]; x[1] = x0[1]; x[2] = x0[2];
    v[0] = v0[0]; v[1] = v0[1]; v[2] = v0[2];
    kdk(this.sf, x, v, dt, res);
    this.note(res.n, res.capped, ctx);
    const kappa = physics.freeKappa(), damp = 1 / (1 + physics.linearDamping(h) * dt);
    physics.readMotion(h, POS, VEL, 0);
    const W = m * res.work;
    const dK = 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - v0[0] * v0[0] - v0[1] * v0[1] - v0[2] * v0[2]);
    const J: Vec3 = [m * (v[0] - v0[0]), m * (v[1] - v0[1]), m * (v[2] - v0[2])];
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed > CELESTIAL_LIMITS.speed) this.limit(ctx, 'speed');
    if (res.captured >= 0) {
      // Captured inside the step: its motion up to the capture point is booked, then it leaves the set there.
      const phiC = this.f.potential(x[0], x[1], x[2]);
      ledger.bodyPath(m, v, phi0, phiC, W, W - dK, J, false);
      ledger.boundary(-1, m, v, phiC);
      out.captured = res.captured;
      out.x[0] = x[0]; out.x[1] = x[1]; out.x[2] = x[2];
      out.v[0] = v[0]; out.v[1] = v[1]; out.v[2] = v[2];
      this.stats.orbiting++;
      return true;
    }
    for (let i = 0; i < 3; i++) {
      POS[i] += x[i] - x0[i] - v0[i] * dt - kappa * g0[i] * dt * dt;
      VEL[i] += (v[i] - v0[i] - g0[i] * dt) * damp;
    }
    physics.writeMotion(h, POS, VEL);
    physics.readMotion(h, POS, VEL, 0);
    const phi1 = this.f.potential(POS[0], POS[1], POS[2]);
    ledger.bodyPath(m, VEL, phi0, phi1, W, W - dK, J, true);
    out.captured = -1;
    out.x[0] = POS[0]; out.x[1] = POS[1]; out.x[2] = POS[2];
    out.v[0] = VEL[0]; out.v[1] = VEL[1]; out.v[2] = VEL[2];
    this.stats.orbiting++;
    return true;
  }

  private note(n: number, capped: boolean, ctx: SystemContext) {
    if (n > this.stats.maxSubsteps) this.stats.maxSubsteps = n;
    this.sumN += n;
    this.nInt++;
    if (capped) {
      this.stats.capped++;
      this.limit(ctx, 'substeps');
    }
  }

  /** A model limit was reached: recorded (warn) or the run is stopped (stop policy of any experiment in force). */
  limit(ctx: SystemContext, reason: string) {
    const stop = this.f.celestial.some((e) => e.spec.limitPolicy === 'stop');
    if (this.stats.limit === 'none' || (stop && this.stats.limit !== 'stop')) {
      ctx.milestone?.({ time: ctx.time, kind: 'celestialLimit', subject: 'celestial', label: { key: `ms.celestial.limit.${reason}` as never, params: {} } }, `celestial:limit:${reason}`);
    }
    this.stats.limitReason = reason;
    if (stop) {
      this.stats.limit = 'stop';
      this.stopRequest ??= { time: ctx.time, reason };
    } else if (this.stats.limit === 'none') this.stats.limit = 'warn';
  }

  /**
   * Book a capture: mass, momentum and energy of the body at the capture point relative to the source (held on its
   * prescribed path: the momentum change is a constraint impulse, its work J·V_s; the kinetic energy relative to the
   * source and the potential at the capture point are not resolved further — no radiation / heating model).
   */
  capture(ctx: SystemContext, kind: CaptureKind, id: string, m: number, x: Readonly<Vec3>, v: Readonly<Vec3>, liveIndex: number) {
    const l = this.f.points.live[liveIndex];
    const rel: Vec3 = [v[0] - l.vx, v[1] - l.vy, v[2] - l.vz];
    const J: Vec3 = [m * (l.vx - v[0]), m * (l.vy - v[1]), m * (l.vz - v[2])];
    const phi = this.f.potential(x[0], x[1], x[2]);
    const policy = l.spec.massPolicy;
    const massBefore = this.f.points.massOf(l.owner, l.index);
    if (policy === 'grow') this.f.points.grow(l.owner, l.index, m);
    this.ledger.capture({
      t: ctx.time, kind, id, mass: m, source: { owner: l.owner, index: l.index }, policy,
      momentum: [m * v[0], m * v[1], m * v[2]], constraintImpulse: J,
      constraintWork: J[0] * l.vx + J[1] * l.vy + J[2] * l.vz,
      kineticRel: 0.5 * m * (rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2]),
      kinetic: 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]),
      potential: m * phi, massBefore, massAfter: this.f.points.massOf(l.owner, l.index),
      freeMergeDv: [(m * rel[0]) / (massBefore + m), (m * rel[1]) / (massBefore + m), (m * rel[2]) / (massBefore + m)],
    });
    this.stats.captured = this.ledger.count;
    this.stats.capturedMass = this.ledger.mass;
    if (kind !== 'particle') ctx.milestone?.({ time: ctx.time, kind: 'capture', subject: 'celestial', label: { key: 'ms.celestial.capture' as never, params: { id, m: m.toFixed(0) } } }, this.ledger.count === 1 ? 'celestial:capture:first' : `celestial:capture:${id}`);
    if (policy === 'grow') ctx.milestone?.({ time: ctx.time, kind: 'sourceGrowth', subject: 'celestial', label: { key: 'ms.celestial.growth' as never, params: { m: this.f.points.massOf(l.owner, l.index).toExponential(3) } } }, 'celestial:growth');
  }

  /** Remove a captured Rapier body from the world (the entity stays in the runtime, hidden; restore rebuilds it). */
  removeCaptured(ctx: SystemContext, h: BodyHandle) {
    const rt = ctx.runtime;
    for (const e of rt.entities.values()) {
      if (e.body !== h) continue;
      removeEntity(ctx, e);
      return;
    }
    const k = rt.debris.findIndex((d) => d.body === h);
    if (k >= 0) {
      const d = rt.debris[k];
      ctx.physics.removeBody(d.body);
      if (d.structural) fragmentCaptured(ctx, d);
      rt.debris.splice(k, 1);
      rt.debrisRev++;
      return;
    }
    const p = this.probes.find((q) => q.body === h);
    if (p) { ctx.physics.removeBody(h); p.body = null; p.state = 'captured'; }
  }

  /** Kind and id of a body (capture records). */
  identify(ctx: SystemContext, h: BodyHandle): { kind: CaptureKind; id: string } {
    for (const e of ctx.runtime.entities.values()) if (e.body === h) return { kind: e.source.type === 'car' ? 'vehicle' : e.source.type === 'human' ? 'person' : 'object', id: e.id };
    const d = ctx.runtime.debris.find((x) => x.body === h);
    if (d) return { kind: d.structural ? 'fragment' : 'debris', id: d.id };
    const p = this.probes.find((q) => q.body === h);
    return { kind: 'probe', id: p?.id ?? String(h) };
  }

  // ── After the physics step: particles, probes, diagnostics, history ─────────────────────────

  post(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    this.particles(ctx, dt);
    this.diagnostics(ctx, dt);
    this.stats.meanSubsteps = this.nInt ? this.sumN / this.nInt : 0;
    if (ctx.time + dt >= this.nextSeries) {
      this.nextSeries = ctx.time + dt + SERIES_DT;
      const ps = this.probes.slice(0, SERIES_PROBES);
      const live = (p: Probe, v: number) => (p.state === 'orbit' || p.state === 'contact' ? v : NaN);
      this.series.push({
        t: ctx.time + dt,
        r: ps.map((p) => live(p, p.diag.r)), v: ps.map((p) => live(p, p.diag.v)), a: ps.map((p) => live(p, p.diag.a)),
        e: ps.map((p) => live(p, p.diag.e)), l: ps.map((p) => live(p, Math.hypot(...this.angular(p)))),
        maxTidal: this.stats.maxTidal, capturedMass: this.ledger.mass,
        sourceMass: this.f.points.entries.map((e) => e.spec.mass + e.grown), failures: this.failures,
      });
      if (this.series.length > SERIES_MAX) this.series.splice(0, this.series.length - SERIES_MAX);
    }
    this.stats.ms += performance.now() - t0;
  }

  /** Structures under the field of this step (after the Phase 31 member ratios). */
  structuresStep(ctx: SystemContext) {
    this.structures.update(ctx, this.f);
  }

  /** A structural failure attributed to gravity while celestial sources act (milestone on the first). */
  noteFailure(ctx: SystemContext, building: string) {
    this.failures++;
    ctx.milestone?.({ time: ctx.time, kind: 'tidalFailure', subject: 'celestial', label: { key: 'ms.celestial.tidalFailure' as never, params: { id: building } } }, 'celestial:failure');
  }

  /** Reset per-step counters (GravityRuntime.pre, before the bodies are visited). */
  beginStep() {
    this.stats.orbiting = 0;
    this.stats.contact = 0;
    this.stats.maxAccel = 0;
    this.stats.maxTidal = 0;
    this.stats.maxSubsteps = 0;
    this.sumN = 0;
    this.nInt = 0;
    const pts = this.f.points;
    this.stats.sources = pts.live.map((l) => ({ owner: l.owner, index: l.index, mass: l.mu / G_N, mu: l.mu, rs: schwarzschildRadius(l.mu / G_N), eps: Math.sqrt(l.eps2), capture: Math.sqrt(l.cap2), x: l.x, y: l.y, z: l.z, policy: l.spec.massPolicy, moving: l.vx !== 0 || l.vy !== 0 || l.vz !== 0 }));
  }

  /** Field and tide sampled at a body (HUD maxima). */
  sampleAt(x: number, y: number, z: number) {
    const g = this.f.sample(x, y, z, tmp);
    const a = Math.hypot(g[0], g[1], g[2]);
    if (a > this.stats.maxAccel) this.stats.maxAccel = a;
    const [l1] = symEigenvalues(this.f.gradient(x, y, z, this.T));
    if (l1 > this.stats.maxTidal) this.stats.maxTidal = l1;
    if (a > CELESTIAL_LIMITS.accel) this.stats.limitReason ||= 'accel';
  }

  /** Accretion test particles: KDK in the field, landing on the ground, capture, leaving the world. */
  private particles(ctx: SystemContext, dt: number) {
    const N = this.pstate.length;
    if (!N) return;
    const terrain = ctx.env.terrain, res = this.res, x = this.x, v = this.v;
    let flying = 0, landed = 0;
    for (let i = 0; i < N; i++) {
      const st = this.pstate[i];
      if (st === 2) { landed++; continue; }
      if (st !== 1) continue;
      const o = 3 * i;
      x[0] = this.px[o]; x[1] = this.px[o + 1]; x[2] = this.px[o + 2];
      v[0] = this.pv[o]; v[1] = this.pv[o + 1]; v[2] = this.pv[o + 2];
      kdk(this.sf, x, v, dt, res);
      this.note(res.n, res.capped, ctx);
      this.px[o] = x[0]; this.px[o + 1] = x[1]; this.px[o + 2] = x[2];
      this.pv[o] = v[0]; this.pv[o + 1] = v[1]; this.pv[o + 2] = v[2];
      if (res.captured >= 0) {
        this.pstate[i] = 3;
        this.ledger.particlesCaptured += this.pmass;
        this.capture(ctx, 'particle', `particle-${i}`, this.pmass, [x[0], x[1], x[2]], [v[0], v[1], v[2]], res.captured);
        continue;
      }
      if (Math.abs(x[0]) > 800 || Math.abs(x[2]) > 800 || x[1] > 3000) { this.pstate[i] = 4; this.ledger.particlesLeft += this.pmass; continue; }
      const hg = terrain.sampleHeight(x[0], x[2]);
      if (x[1] <= hg) {
        // Landed: stops on the ground (its kinetic energy goes into the ground contact — booked as dissipated).
        this.pstate[i] = 2;
        this.px[o + 1] = hg;
        this.ledger.particlesLanded += this.pmass;
        this.ledger.particleDissipated += 0.5 * this.pmass * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        this.pv[o] = this.pv[o + 1] = this.pv[o + 2] = 0;
        landed++;
        continue;
      }
      flying++;
    }
    this.stats.particles = flying;
    this.stats.landed = landed;
  }

  /** Probes: pose, trail, orbit diagnostics (energy, angular momentum, distance extremes, revolutions). */
  private diagnostics(ctx: SystemContext, dt: number) {
    const physics = ctx.physics;
    const conservative = this.conservative();
    for (const p of this.probes) {
      if (p.body === null) continue;
      if (!physics.hasBody(p.body)) { p.body = null; p.state = 'captured'; continue; }
      physics.readMotion(p.body, POS, VEL, 0);
      p.pos[0] = POS[0]; p.pos[1] = POS[1]; p.pos[2] = POS[2];
      p.vel[0] = VEL[0]; p.vel[1] = VEL[1]; p.vel[2] = VEL[2];
      if (Math.abs(POS[0]) > 800 || Math.abs(POS[2]) > 800 || POS[1] > 3000) {
        physics.removeBody(p.body);
        p.body = null;
        p.state = 'left';
        this.ledger.left += p.mass;
        continue;
      }
      p.state = physics.touching(p.body) ? 'contact' : 'orbit';
      const o = 3 * p.trailHead;
      p.trail[o] = POS[0]; p.trail[o + 1] = POS[1]; p.trail[o + 2] = POS[2];
      p.trailHead = (p.trailHead + 1) % TRAIL;
      if (p.trailN < TRAIL) p.trailN++;
      const d = p.diag;
      const l = this.refLive(p);
      const g = this.f.sample(POS[0], POS[1], POS[2], tmp);
      d.a = Math.hypot(g[0], g[1], g[2]);
      d.v = Math.hypot(VEL[0], VEL[1], VEL[2]);
      d.e = 0.5 * d.v * d.v + this.f.potential(POS[0], POS[1], POS[2]);
      const L = this.angular(p);
      if (Number.isNaN(d.e0)) { d.e0 = d.e; d.l0 = [...L] as Vec3; d.conserved = conservative; }
      d.conserved &&= conservative;
      d.maxErr = Math.max(d.maxErr, Math.abs((d.e - d.e0) / d.e0));
      const l0 = Math.hypot(...d.l0);
      if (l0 > 0) d.lErr = Math.max(d.lErr, Math.hypot(L[0] - d.l0[0], L[1] - d.l0[1], L[2] - d.l0[2]) / l0);
      if (!l) continue;
      const rx = POS[0] - l.x, ry = POS[1] - l.y, rz = POS[2] - l.z;
      d.r = Math.hypot(rx, ry, rz);
      d.rMin = Math.min(d.rMin, d.r);
      d.rMax = Math.max(d.rMax, d.r);
      // Revolutions: the polar angle in the plane ⟂ L₀ crosses the start angle.
      if (l0 > 0) {
        const n = [d.l0[0] / l0, d.l0[1] / l0, d.l0[2] / l0];
        // In-plane basis: e1 = first radius direction projected, e2 = n × e1.
        const ang = this.planeAngle(n, rx, ry, rz, p);
        if (!Number.isNaN(d.private_angle) && d.private_angle < 0 && ang >= 0 && ang - d.private_angle < Math.PI) {
          if (Number.isNaN(d.tFirst)) d.tFirst = ctx.time + dt;
          else { d.revs++; d.period = (ctx.time + dt - d.tFirst) / d.revs; }
        }
        d.private_angle = ang;
      }
      // Close approach (≤ 3 capture radii / 3 ε): a milestone per probe and source.
      const near = Math.max(3 * Math.sqrt(l.cap2), 3 * Math.sqrt(l.eps2));
      const key = `${p.id}:${l.owner}:${l.index}`;
      if (d.r <= near && !this.approach.has(key)) {
        this.approach.add(key);
        ctx.milestone?.({ time: ctx.time, kind: 'closeApproach', subject: 'celestial', label: { key: 'ms.celestial.approach' as never, params: { id: p.id, r: d.r.toFixed(1) } } }, `celestial:approach:${key}`);
      }
    }
  }

  private planeBasis = new Map<Probe, [Vec3, Vec3]>();
  private planeAngle(n: number[], rx: number, ry: number, rz: number, p: Probe): number {
    let b = this.planeBasis.get(p);
    if (!b) {
      const k = rx * n[0] + ry * n[1] + rz * n[2];
      const e1: Vec3 = [rx - k * n[0], ry - k * n[1], rz - k * n[2]];
      const m = Math.hypot(...e1) || 1;
      e1[0] /= m; e1[1] /= m; e1[2] /= m;
      const e2: Vec3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
      b = [e1, e2];
      this.planeBasis.set(p, b);
    }
    return Math.atan2(rx * b[1][0] + ry * b[1][1] + rz * b[1][2], rx * b[0][0] + ry * b[0][1] + rz * b[0][2]);
  }

  /** Live reference source of a probe (null when not in force). */
  refLive(p: Probe) {
    return this.f.points.live.find((l) => l.owner === p.ref.owner && l.index === p.ref.index) ?? null;
  }

  /** Angular momentum per unit mass about the reference source (relative velocity). */
  angular(p: Probe): Vec3 {
    const l = this.refLive(p);
    if (!l) return [NaN, NaN, NaN];
    const r = [p.pos[0] - l.x, p.pos[1] - l.y, p.pos[2] - l.z], u = [p.vel[0] - l.vx, p.vel[1] - l.vy, p.vel[2] - l.vz];
    return [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
  }

  /** The field is static and central about one source (energy and angular momentum are conserved quantities). */
  conservative(): boolean {
    const f = this.f;
    if (f.points.live.length !== 1 || f.liveSources().length) return false;
    const G = f.G;
    if (G[0] !== 0 || G[1] !== 0 || G[2] !== 0) return false;
    const l = f.points.live[0];
    if (l.vx !== 0 || l.vy !== 0 || l.vz !== 0) return false;
    if (l.spec.massPolicy === 'grow' && this.ledger.count > 0) return false;
    const e = f.points.entries.find((x) => x.owner === l.owner && x.index === l.index)!;
    return f.time >= e.on + (l.spec.ramp ?? 0);
  }
}

const POS = new Float64Array(3);
const VEL = new Float64Array(3);

/** Remove a captured entity's body (the entity stays, hidden; the original world is untouched — restore rebuilds). */
function removeEntity(ctx: SystemContext, e: RuntimeEntity) {
  if (e.body !== null) ctx.physics.removeBody(e.body);
  e.body = null;
  e.flags.captured = true;
  ctx.env.windField.removeObstacle(e.id);
  ctx.env.flood?.removeObstacle(e.id);
  e.rev++;
  ctx.log(e.id, 'danger', { key: 'log.celestial.captured' as never, params: {} });
}

/** A structural fragment captured: its mass moves to the building's 'captured' account. */
function fragmentCaptured(ctx: SystemContext, d: DebrisPiece) {
  const S = ctx.runtime.structures;
  if (!S || !d.structural) return;
  const k = S.fragments.indexOf(d);
  if (k >= 0) S.fragments.splice(k, 1);
  S.fragmentById.delete(d.id);
  ctx.runtime.entities.get(d.structural.owner)?.modular?.structure?.model.ledger.move('bodies', 'captured', d.mass);
}

