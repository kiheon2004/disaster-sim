/**
 * Gravity runtime (Phase 31): the adapter between the gravity field and the run, created with the first gravity
 * experiment (GravitySystem). Per fixed step:
 *
 *  prePhysics   the field is prepared for the step's time (every later system of the step reads the same field);
 *               the Rapier world takes the field's UNIFORM part G(t) as its gravity (one write when it changed) —
 *               Rapier stays the only place the uniform weight m·G is applied (no second gravity force anywhere);
 *               a spatial field adds only its DIFFERENCE m·(g(x) − G) per dynamic body through the ForceLedger
 *               (source 'gravityField'); sleeping bodies are woken when G moved by more than WAKE_SHARE since the
 *               last wake (a body asleep under 1 g would otherwise hang in the air at 0 g) and the contact-force event
 *               thresholds follow the heavier resting weight (no resting contact reported as an impact at 3 g)
 *  postPhysics  the energy / momentum ledger over the dynamic bodies (gravity/ledger.ts), statistics, milestones
 *
 * Fixed bodies (buildings, anchored objects, standing trees) are not moved by gravity — their weight acts through the
 * structural model (structure k factor), not through Rapier.
 */
import type { Vec3 } from '@/core/types';
import type { BodyHandle } from '@/physics/PhysicsEngine';
import type { SystemContext } from '../systems/SimulationSystem';
import type { GravityField } from '@/gravity/field';
import { GravityLedger, type GravityBalance } from '@/gravity/ledger';
import { EARTH_G } from '@/gravity/types';
import type { GravityChannel } from './GravityChannel';
import type { ForceOwner } from '../forces/ForceLedger';
import { GravityStructures } from './structures';
import { CelestialRuntime } from '../celestial/runtime';
import { simProfiler as P } from '../profiling/SimProfiler';

/** Wake every dynamic body when the uniform gravity moved by this share of max(|G|, 0.05 g₀) since the last wake. */
const WAKE_SHARE = 0.02;
/** Relative change of the local field at a body that re-sets its contact threshold under celestial sources (Phase 32.1). */
const THR_SHARE = 0.1;
/** Seconds between history samples. */
const SERIES_DT = 0.5;
const SERIES_MAX = 4000;

interface Tracked {
  h: BodyHandle;
  m: number;
  owner: ForceOwner;
  /** Contact threshold: floor (N) and factor on the resting weight (RuntimeBuilder / spawn / fragments). */
  thrMin: number;
  thrK: number;
  /** Start of this step: position, velocity, Φ(x₀, t). */
  x0: Vec3;
  v0: Vec3;
  phi0: number;
  /** End of the last step: position, velocity, Φ(x₁, t) (NaN without a potential) — what the ledger last booked. */
  x1: Vec3;
  v: Vec3;
  phi: number;
  seen: number;
  g: Vec3;
  /** Phase 32.1: field magnitude the contact threshold was last set for under celestial sources (NaN = not set). */
  thrL: number;
}

export interface GravityStats {
  /** Uniform part (m/s²), |G|, |G|/g₀ (Earth), down component. */
  G: Vec3;
  magnitude: number;
  ratio: number;
  down: number;
  uniform: boolean;
  /** Dynamic bodies tracked / inside a local source / under a changed field. */
  bodies: number;
  inSource: number;
  affected: number;
  /** Field-difference forces applied this step and wakes so far. */
  fieldForces: number;
  wakes: number;
  /** Peak / minimum |g| sampled at bodies so far. */
  peak: number;
  minimum: number;
  /** Cost (ms) of the structural ratio pass in the last step. */
  structMs: number;
  /** Cost (ms) of this runtime in the last step, cumulative. */
  ms: number;
  msTotal: number;
}

export interface GravitySeriesPoint {
  t: number;
  gx: number; gy: number; gz: number;
  magnitude: number;
  kinetic: number;
  potential: number;
  workGravity: number;
  workField: number;
  workOther: number;
  /** Phase 31 audit: moves outside the integrator, the integrator's share ε, the energy check R_Φ − ε. */
  workMoved: number;
  integrator: number;
  energyResidual: number;
  px: number; py: number; pz: number;
  jx: number; jy: number; jz: number;
  bodies: number;
  /** Structural members failed so far with hazard gravity, roofs failed. */
  failed: number;
}

/** Support of each model under the current field (the outlook's state for the running field). */
export type SupportLevel = 'full' | 'scaled' | 'limited' | 'unsupported';

export class GravityRuntime {
  readonly ch: GravityChannel;
  readonly field: GravityField;
  readonly ledger = new GravityLedger();
  readonly stats: GravityStats = { G: [0, 0, 0], magnitude: 0, ratio: 0, down: 0, uniform: true, bodies: 0, inSource: 0, affected: 0, fieldForces: 0, wakes: 0, peak: 0, minimum: Infinity, structMs: 0, ms: 0, msTotal: 0 };
  readonly series: GravitySeriesPoint[] = [];
  /** Gravity ratios of the modular buildings (structures.ts). */
  readonly structures: GravityStructures;
  /** Structural failures attributed to gravity (StructuralCollapseSystem), roofs among them. */
  failures = 0;
  roofFailures = 0;
  private tracked = new Map<BodyHandle, Tracked>();
  private stamp = 0;
  private rapierG: Vec3 = [NaN, NaN, NaN];
  private wakeG: Vec3;
  private nextSeries = 0;
  /** Milestone state. */
  private lastLevel: number;
  private zeroSeen = false;
  private reverseSeen = false;
  private endSeen = new Set<string>();
  private readonly tmp: Vec3 = [0, 0, 0];
  /** Scratch position / velocity of one body (readMotion: no Pose objects in the per-body loops). */
  private readonly pos = new Float64Array(3);
  private readonly vel = new Float64Array(3);
  /** Uniform vector of the previous step (structures: a static field needs no re-sampling). */
  private lastG: Vec3 = [NaN, NaN, NaN];
  /** Bodies moved outside the integrator since the last ledger step (scratch), time of that step. */
  private readonly movedBodies: Tracked[] = [];
  private lastTime = 0;
  /** Phase 32: celestial point sources' runtime (probes, KDK of free bodies, captures), created with the first one. */
  celestial: CelestialRuntime | null = null;
  private readonly kOut = { captured: -1, x: [0, 0, 0] as Vec3, v: [0, 0, 0] as Vec3 };
  private readonly captures: { tr: Tracked; k: number; x: Vec3; v: Vec3 }[] = [];

  constructor(ch: GravityChannel) {
    this.ch = ch;
    this.field = ch.field!;
    this.wakeG = [0, -ch.g0, 0];
    this.structures = new GravityStructures(ch.g0);
    this.lastLevel = ch.g0;
  }

  // ── Before the physics step ──────────────────────────────

  pre(ctx: SystemContext) {
    const t0 = performance.now();
    const f = this.field.prepare(ctx.time);
    const G = f.G, physics = ctx.physics;
    let thresholds = false;
    if (G[0] !== this.rapierG[0] || G[1] !== this.rapierG[1] || G[2] !== this.rapierG[2]) {
      physics.setGravity(G);
      this.rapierG[0] = G[0]; this.rapierG[1] = G[1]; this.rapierG[2] = G[2];
      const ref = Math.max(Math.hypot(this.wakeG[0], this.wakeG[1], this.wakeG[2]), 0.05 * this.ch.g0);
      if (Math.hypot(G[0] - this.wakeG[0], G[1] - this.wakeG[1], G[2] - this.wakeG[2]) > WAKE_SHARE * ref) {
        this.wakeG[0] = G[0]; this.wakeG[1] = G[1]; this.wakeG[2] = G[2];
        thresholds = true;
        this.stats.wakes++;
      }
    }
    // Bodies of this step (canonical order: entities in map order, then debris in list order — both deterministic).
    const stamp = ++this.stamp;
    const gm = Math.hypot(G[0], G[1], G[2]);
    const thrG = Math.max(gm, this.ch.g0);
    const ledger = this.ledger;
    const start = !ledger.started;
    let k0 = 0, u0 = 0;
    const p0: Vec3 = [0, 0, 0];
    let n = 0, inSrc = 0, forces = 0;
    const cel = f.celestial.length ? (this.celestial ??= new CelestialRuntime(f)) : null;
    const pointsLive = f.points.live.length > 0;
    if (cel) { const tc = P.now(); cel.beginStep(); cel.pre(ctx); P.add('celestial.pre', tc); }
    const visit = (h: BodyHandle, owner: ForceOwner, thrMin: number, thrK: number) => {
      let tr = this.tracked.get(h);
      const fresh = !tr;
      if (!tr) {
        tr = { h, m: physics.getMass(h), owner, thrMin, thrK, x0: [0, 0, 0], v0: [0, 0, 0], phi0: NaN, x1: [0, 0, 0], v: [0, 0, 0], phi: NaN, seen: 0, g: [0, 0, 0], thrL: NaN };
        this.tracked.set(h, tr);
      }
      tr.seen = stamp;
      const x = tr.x0, v0 = tr.v0;
      physics.readMotion(h, this.pos, this.vel, 0);
      const p = this.pos, v = this.vel;
      x[0] = p[0]; x[1] = p[1]; x[2] = p[2];
      v0[0] = v[0]; v0[1] = v[1]; v0[2] = v[2];
      // Probes (thrMin < 0) report no contact forces (they are test bodies, not damage sources).
      if (thrMin >= 0 && (thresholds || (fresh && thrG > this.ch.g0))) physics.setContactForceThreshold(h, Math.max(thrMin, tr.m * thrG * thrK));
      if (thresholds) physics.wake(h);
      const phi = f.potential(x[0], x[1], x[2]);
      tr.phi0 = phi;
      if (start) {
        k0 += 0.5 * tr.m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        u0 += tr.m * phi;
        p0[0] += tr.m * v[0]; p0[1] += tr.m * v[1]; p0[2] += tr.m * v[2];
      } else if (fresh) ledger.boundary(1, tr.m, v, phi);
      // Moved outside the integrator since the last ledger step (pose set by a later system): the field-change term
      // needs Φ at the last step's time at the NEW position (evaluated below, once for all moved bodies).
      else if (x[0] !== tr.x1[0] || x[1] !== tr.x1[1] || x[2] !== tr.x1[2]) this.movedBodies.push(tr);
      else ledger.field(tr.m, phi, tr.phi);
      const g = f.sample(x[0], x[1], x[2], tr.g);
      if (!f.uniform) {
        const dx = g[0] - G[0], dy = g[1] - G[1], dz = g[2] - G[2];
        if (dx !== 0 || dy !== 0 || dz !== 0) {
          inSrc++;
          const F = this.tmp;
          F[0] = tr.m * dx; F[1] = tr.m * dy; F[2] = tr.m * dz;
          // Wake only while the field itself changes (or on a global wake): a body asleep in a constant local field
          // fell asleep in equilibrium with it.
          if (ctx.forces.force('gravityField', h, [F[0], F[1], F[2]], owner, this.fieldChanging || thresholds)) forces++;
        }
      }
      const gg = Math.hypot(g[0], g[1], g[2]);
      // Phase 32.1: under celestial sources the contact threshold follows the field AT the body (the Phase 31 rule —
      // threshold = factor × resting weight — with the local field: a body pressed into the ground or a pile by a
      // strong source is resting, not striking). Re-set when that field moved by > THR_SHARE; the uniform rule again
      // once the sources are gone. Without celestial sources nothing here runs (Phase 31 thresholds unchanged).
      if (thrMin >= 0) {
        if (pointsLive) {
          const gl = Math.max(gg, thrG);
          if (!(Math.abs(gl - tr.thrL) <= THR_SHARE * tr.thrL)) {
            physics.setContactForceThreshold(h, Math.max(thrMin, tr.m * gl * thrK));
            tr.thrL = gl;
          }
        } else if (tr.thrL === tr.thrL) {
          physics.setContactForceThreshold(h, Math.max(thrMin, tr.m * thrG * thrK));
          tr.thrL = NaN;
        }
      }
      if (cel) { const tsa = P.now(); cel.sampleAt(ctx, x[0], x[1], x[2]); P.add('celestial.sample', tsa); }
      if (gg > this.stats.peak) this.stats.peak = gg;
      if (gg < this.stats.minimum) this.stats.minimum = gg;
      n++;
    };
    const tv = P.now();
    for (const e of ctx.runtime.entities.values()) if (e.dynamic && e.body !== null) visit(e.body, e, 800, 2.5);
    for (const d of ctx.runtime.debris) visit(d.body, d, 600, 4);
    if (cel) for (const p of cel.probes) if (p.body !== null) visit(p.body, p, -1, 0);
    P.add('gravity.visit', tv);
    // Bodies that left the set (removed debris, bodies made fixed).
    for (const [h, tr] of this.tracked) {
      if (tr.seen === stamp) continue;
      if (!start) ledger.boundary(-1, tr.m, tr.v, tr.phi);
      this.tracked.delete(h);
    }
    if (start) ledger.start(k0, u0, p0);
    if (this.movedBodies.length) {
      // Φ(x′, t_prev): the field of the last step, then back to this step's (prepare is deterministic and idempotent).
      f.prepare(this.lastTime);
      for (const tr of this.movedBodies) {
        const old = f.potential(tr.x0[0], tr.x0[1], tr.x0[2]);
        ledger.moved(tr.m, old, tr.phi);
        ledger.field(tr.m, tr.phi0, old);
      }
      f.prepare(ctx.time);
      this.movedBodies.length = 0;
    }
    this.fieldChanging = this.fieldSignature();
    const ts = performance.now();
    const moved = G[0] !== this.lastG[0] || G[1] !== this.lastG[1] || G[2] !== this.lastG[2];
    this.lastG[0] = G[0]; this.lastG[1] = G[1]; this.lastG[2] = G[2];
    const tsu = P.now();
    this.structures.update(ctx, f, moved || this.fieldChanging);
    P.add('gravity.structures', tsu);
    if (cel) { const tc = P.now(); cel.structuresStep(ctx); P.add('celestial.struct', tc); }
    this.stats.structMs = performance.now() - ts;
    const s = this.stats;
    s.G = [G[0], G[1], G[2]];
    s.magnitude = gm;
    s.ratio = gm / EARTH_G;
    s.down = -G[1];
    s.uniform = f.uniform;
    s.bodies = n;
    s.inSource = inSrc;
    s.affected = f.uniform ? (Math.abs(G[0]) + Math.abs(G[1] + this.ch.g0) + Math.abs(G[2]) > 0 ? n : 0) : inSrc;
    s.fieldForces = forces;
    this.milestones(ctx, gm, G);
    s.ms = performance.now() - t0;
  }

  /** The local part changed since the last step (strength factors) — wakes bodies under a varying local field. */
  private fieldChanging = true;
  private lastSig = '';
  private fieldSignature(): boolean {
    let sig = '';
    for (const l of this.field.liveSources()) sig += `${l.f};`;
    // Phase 32: celestial sources move, ramp and grow.
    for (const l of this.field.points.live) sig += `${l.x},${l.y},${l.z},${l.mu};`;
    const ch = sig !== this.lastSig;
    this.lastSig = sig;
    return ch;
  }

  // ── After the physics step ───────────────────────────────

  post(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    const physics = ctx.physics, f = this.field, ledger = this.ledger;
    ledger.beginStep();
    for (const tr of this.tracked.values()) {
      // Removed after the field step and before this one (a prePhysics system recycling debris): it leaves with its
      // state at the start of the step (no motion of a body that no longer exists is booked).
      if (!physics.hasBody(tr.h)) {
        ledger.boundary(-1, tr.m, tr.v0, tr.phi0);
        this.tracked.delete(tr.h);
        continue;
      }
      // Phase 32: a free body near celestial sources takes the KDK increment instead of Rapier's first-order one.
      const cel = this.celestial, ko = this.kOut;
      const tk = cel ? P.now() : 0;
      const kdk = cel !== null && cel.integrate(ctx, tr.h, tr.m, tr.x0, tr.v0, tr.g, tr.phi0, dt, ledger, ko);
      if (cel) P.add('celestial.kdk', tk);
      if (kdk) {
        if (ko.captured >= 0) { this.captures.push({ tr, k: ko.captured, x: [...ko.x] as Vec3, v: [...ko.v] as Vec3 }); continue; }
        tr.phi = f.potential(ko.x[0], ko.x[1], ko.x[2]);
        tr.x1[0] = ko.x[0]; tr.x1[1] = ko.x[1]; tr.x1[2] = ko.x[2];
        tr.v[0] = ko.v[0]; tr.v[1] = ko.v[1]; tr.v[2] = ko.v[2];
        continue;
      }
      physics.readMotion(tr.h, this.pos, this.vel, 0);
      const p = this.pos, v = this.vel;
      const phi = f.potential(p[0], p[1], p[2]);
      ledger.body(tr.m, tr.x0, p, tr.v0, v, tr.g, dt, tr.phi0, phi);
      tr.phi = phi;
      tr.x1[0] = p[0]; tr.x1[1] = p[1]; tr.x1[2] = p[2];
      tr.v[0] = v[0]; tr.v[1] = v[1]; tr.v[2] = v[2];
    }
    // Captured bodies (booked out by integrate): capture ledger, then removed from the world — after the loop.
    for (const c of this.captures) {
      const cel = this.celestial!;
      const id = cel.identify(ctx, c.tr.h);
      cel.capture(ctx, id.kind, id.id, c.tr.m, c.x, c.v, c.k);
      cel.removeCaptured(ctx, c.tr.h);
      this.tracked.delete(c.tr.h);
    }
    this.captures.length = 0;
    this.lastTime = ctx.time;
    ledger.endStep(f.potentialDefined);
    if (this.celestial) { const tc = P.now(); this.celestial.post(ctx, dt); P.add('celestial.post', tc); }
    if (ctx.time + dt >= this.nextSeries) {
      this.nextSeries = ctx.time + dt + SERIES_DT;
      const b = ledger.balance(), G = f.G;
      this.series.push({ t: ctx.time + dt, gx: G[0], gy: G[1], gz: G[2], magnitude: Math.hypot(G[0], G[1], G[2]), kinetic: b.kinetic, potential: b.potential, workGravity: b.workGravity, workField: b.workField, workOther: b.workOther, workMoved: b.workMoved, integrator: b.integratorResidual, energyResidual: b.energyResidual, px: b.momentum[0], py: b.momentum[1], pz: b.momentum[2], jx: b.impulse[0], jy: b.impulse[1], jz: b.impulse[2], bodies: b.bodies, failed: this.failures });
      if (this.series.length > SERIES_MAX) this.series.splice(0, this.series.length - SERIES_MAX);
    }
    this.stats.ms += performance.now() - t0;
    this.stats.msTotal += this.stats.ms;
  }

  balance(): GravityBalance {
    return this.ledger.balance();
  }

  // ── Milestones ───────────────────────────────────────────

  private milestones(ctx: SystemContext, gm: number, G: Readonly<Vec3>) {
    const ms = ctx.milestone;
    if (!ms) return;
    const g0 = this.ch.g0;
    const label = (key: string, params: Record<string, string> = {}) => ({ key: key as never, params });
    if (gm < 0.01 * g0 && !this.zeroSeen) {
      this.zeroSeen = true;
      ms({ time: ctx.time, kind: 'zeroGravity', subject: 'gravity', label: label('ms.gravity.zero') }, 'gravity:zero');
    }
    if (G[1] > 0.01 * g0 && !this.reverseSeen) {
      this.reverseSeen = true;
      ms({ time: ctx.time, kind: 'gravityReversal', subject: 'gravity', label: label('ms.gravity.reverse', { g: G[1].toFixed(2) }) }, 'gravity:reverse');
    }
    // Increase / decrease: every crossing of a 25 % step of g₀ from the last reported level.
    const step = 0.25 * g0;
    if (gm >= this.lastLevel + step || gm <= this.lastLevel - step) {
      const up = gm > this.lastLevel;
      this.lastLevel = gm;
      ms({ time: ctx.time, kind: up ? 'gravityIncrease' : 'gravityDecrease', subject: 'gravity', label: label(up ? 'ms.gravity.increase' : 'ms.gravity.decrease', { g: gm.toFixed(2), x: (gm / EARTH_G).toFixed(2) }) });
    }
    for (const e of this.field.canonical) {
      const end = e.start + e.spec.duration;
      if (ctx.time >= end && !this.endSeen.has(e.id)) {
        this.endSeen.add(e.id);
        ms({ time: end, kind: 'gravityEnd', subject: 'gravity', label: label(e.spec.end === 'hold' ? 'ms.gravity.endHold' : 'ms.gravity.endRestore', { id: e.id }) });
      }
    }
  }

  /** A structural failure attributed to gravity (StructuralCollapseSystem) — the first one is a milestone. */
  noteFailure(ctx: SystemContext, roof: boolean, building: string) {
    this.failures++;
    if (roof) this.roofFailures++;
    if (this.celestial && this.field.points.live.length) this.celestial.noteFailure(ctx, building);
    ctx.milestone?.({ time: ctx.time, kind: 'gravityFailure', subject: 'gravity', label: { key: (roof ? 'ms.gravity.roofFailure' : 'ms.gravity.failure') as never, params: { id: building } } }, `gravity:fail:${roof ? 'roof' : 'member'}`);
  }
}
