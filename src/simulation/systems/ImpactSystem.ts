/**
 * Impacts (Phase 23, prePhysics — right BEFORE the GroundFailureSystem): every step it
 *  - re-evaluates whether an impact ground shock is passing (env.groundMotion; the shock itself is
 *    felt by every consumer through that field — structures, bodies, water, Newmark slopes),
 *  - advances each impact model on the shared ground field (crater front, rim uplift, ejecta
 *    launches and landings — the DeformationSystem applies the terrain in the same step at its
 *    rate; the granular solver of the GroundFailureSystem moves anything that slumps),
 *  - lets objects respond to the ejecta that landed on them:
 *      buildings      momentum flux of the landing curtain F = m_hit·v_h / Δt, Δt = 2·σ_r / v_h (the
 *                     time it sweeps its footprint) against the lateral strength (as flood / sediment)
 *      poles, signs, walls, trees   base moment of F against their wind-design moment → topple
 *      dynamic bodies impulse J = m_hit·v (ForceLedger 'impact'); a standing person falls when the
 *                     velocity change exceeds the rigid-block toppling threshold
 *                     √(2g(√(h²+b²) − h)) (Housner 1963; h = half height, b = half foot base)
 *    m_hit = parcel mass × (object plan area / footprint area), capped at the parcel mass.
 *    Burial and the weight of the deposit come from the deposit itself (Phase 22 responses).
 *  - turns model events into the log and timeline milestones (only events that happened).
 * Inactive (and free) without an impact.
 */
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { DEFORM_INTERVAL } from './DeformationSystem';
import { GRAVITY } from '@/core/units';
import { WORLD_SIZE } from '@/core/units';
import type { Landing, ImpactModel } from '@/impact/ImpactModel';
import type { GroundEnv } from '@/ground/common';
import { AIR, FOOT_LEVER, lateralCapacity, STRUCT_ONSET, STRUCT_RATE } from '../ground/objects';
import { residualStrength } from '../interactions/integrity';
import { knockDown } from '../damage/behaviors/human';
import { DamageState } from '../damage/DamageState';
import type { RuntimeEntity } from '../SimulationRuntime';

const SMALL = new Set(['streetLight', 'sign', 'wall', 'tree']);
/** Bucket size of the object grid used to find objects under a landing (m). */
const GRID = 8;
const force: [number, number, number] = [0, 0, 0];

function impactOf(e: RuntimeEntity, source: string) {
  return (e.impact ??= { damage: 0, ejectaRatio: 0, hits: 0, impulse: 0, source });
}

export class ImpactSystem implements SimulationSystem {
  readonly name = 'impact';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['terrain', 'poses'] as const;
  readonly writes = ['terrain', 'forces', 'damage', 'groundMotion'] as const;
  /** Terrain as last applied (the DeformationSystem applies this step's field after it), poses of the last step. */
  readonly lagged = ['terrain', 'poses'] as const;
  private noted = new Set<string>();
  private shockPeak = new Map<string, { a: number; time: number; done: boolean }>();
  /** Model events already turned into log / timeline entries (per model). */
  private seen = new Map<string, number>();

  isActive(ctx: SystemContext) {
    return ctx.env.impact.active;
  }

  update(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    const ch = ctx.env.impact;
    const gm = ctx.env.groundMotion;
    gm.updateShocks(ctx.time, WORLD_SIZE / 2);
    let objectsMs = 0;
    for (const m of ch.models) {
      const landings = m.update(ctx.time);
      // New model events (including those known at construction: entry, break-up, airburst — each
      // reported when the simulation reaches its time).
      const from = this.seen.get(m.id) ?? 0;
      let k = from;
      for (; k < m.events.length && m.events[k].time <= ctx.time + 1e-9; k++) this.event(ctx, m, m.events[k].kind, m.events[k].value, m.events[k].time);
      this.seen.set(m.id, k);
      if (landings.length) {
        const a = performance.now();
        const grid = this.objectGrid(ctx);
        for (const l of landings) this.respond(ctx, m, l, dt, grid);
        objectsMs += performance.now() - a;
        ch.stats.landings += landings.length;
        ctx.env.groundFailure.urgent = true;
      }
      if (ctx.step % DEFORM_INTERVAL === 0 && m.formed) m.walls(this.groundEnv(ctx));
      this.trackShock(ctx, m);
    }
    const st = ch.stats;
    st.updates++;
    st.objectsMs = objectsMs;
    st.modelMs = performance.now() - t0 - objectsMs;
    st.totalMs += performance.now() - t0;
  }

  private groundEnv(ctx: SystemContext): GroundEnv {
    const f = ctx.env.groundFailure.field!, src = ctx.env.groundFailure.source!;
    const H = ctx.env.terrain.data.heights;
    return { ground: (i) => H[i] - src.applied[i] + f.bed[i], infiltrated: () => 0, surcharge: () => 0 };
  }

  /** Peak ground shock actually felt by the objects (from their sampled base motion). */
  private trackShock(ctx: SystemContext, m: ImpactModel) {
    const s = m.plan.shock;
    if (!s) return;
    const rec = this.shockPeak.get(m.id) ?? { a: 0, time: 0, done: false };
    this.shockPeak.set(m.id, rec);
    if (rec.done) return;
    for (const e of ctx.runtime.entities.values()) {
      const a = e.seismic?.ground.aImpact ?? 0;
      if (a > rec.a) { rec.a = a; rec.time = ctx.time; }
    }
    if (!ctx.env.groundMotion.active || ctx.time > s.time + WORLD_SIZE / s.c + 1) {
      if (ctx.time < s.time) return;
      rec.done = true;
      if (rec.a > 0) {
        ctx.milestone?.({ time: rec.time, kind: 'peakGroundShock', hazard: 'impact', label: { key: 'milestone.peakGroundShock', params: { id: m.name, g: (rec.a / GRAVITY).toFixed(2) } } }, `shock:${m.id}`);
        ctx.log(null, 'warn', { key: 'log.impact.peakShock', params: { id: m.name, g: (rec.a / GRAVITY).toFixed(2) } });
      }
    }
  }

  private event(ctx: SystemContext, m: ImpactModel, kind: string, value: number, time: number) {
    const key = `${m.id}:${kind}`;
    if (this.noted.has(key)) return;
    this.noted.add(key);
    const id = m.name, p = m.plan;
    switch (kind) {
      case 'entry':
        ctx.log(null, 'info', { key: p.spec.entry === 'atmosphere' ? 'log.impact.entry' : 'log.impact.entryDirect', params: { id, v: (value / 1000).toFixed(1), t: p.timeToImpact.toFixed(1) } });
        ctx.milestone?.({ time, kind: 'impactEntry', hazard: 'impact', label: { key: 'milestone.impactEntry', params: { id } } }, key);
        break;
      case 'breakup':
        ctx.log(null, 'warn', { key: 'log.impact.breakup', params: { id, z: (value / 1000).toFixed(1) } });
        ctx.milestone?.({ time, kind: 'impactBreakup', hazard: 'impact', label: { key: 'milestone.impactBreakup', params: { id, z: (value / 1000).toFixed(1) } } }, key);
        break;
      case 'airburst':
        ctx.log(null, 'danger', { key: 'log.impact.airburst', params: { id, z: (value / 1000).toFixed(1) } });
        ctx.milestone?.({ time, kind: 'airburst', hazard: 'impact', label: { key: 'milestone.airburst', params: { id, z: (value / 1000).toFixed(1) } } }, key);
        break;
      case 'impact':
        ctx.log(null, 'danger', { key: 'log.impact.impact', params: { id, v: p.speed.toFixed(0), E: (p.energy / 4.184e9).toFixed(2) } });
        ctx.milestone?.({ time, kind: 'impact', hazard: 'impact', label: { key: 'milestone.impact', params: { id } } }, key);
        break;
      case 'craterFormed':
        ctx.log(null, 'warn', { key: 'log.impact.crater', params: { id, D: value.toFixed(1), d: (p.crater?.depth ?? 0).toFixed(1) } });
        ctx.milestone?.({ time, kind: 'craterFormed', hazard: 'impact', label: { key: 'milestone.craterFormed', params: { id, D: value.toFixed(1) } } }, key);
        break;
      case 'ejectaLanding':
        ctx.milestone?.({ time, kind: 'ejectaLanding', hazard: 'impact', label: { key: 'milestone.ejectaLanding', params: { id } } }, key);
        break;
      case 'ejectaDone':
        ctx.log(null, 'info', { key: 'log.impact.ejectaDone', params: { id, t: (p.ejectaMass / 1000).toFixed(1), out: (p.ejectaOut / 1000).toFixed(1) } });
        break;
    }
  }

  /** Objects bucketed on a GRID-m grid (built once per update with landings; objects barely move within one). */
  private objectGrid(ctx: SystemContext) {
    const buckets = new Map<number, RuntimeEntity[]>();
    let maxHalf = 0;
    for (const e of ctx.runtime.entities.values()) {
      if (e.def.inert) continue;
      const pos = e.dynamic ? e.pose.position : e.initialPose.position;
      const k = Math.floor(pos[0] / GRID) * 4096 + Math.floor(pos[2] / GRID);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(e);
      maxHalf = Math.max(maxHalf, Math.max(e.dims[0], e.dims[2]) / 2);
    }
    return { buckets, maxHalf };
  }

  /** Objects under a landing parcel's footprint. */
  private respond(ctx: SystemContext, m: ImpactModel, l: Landing, dt: number, grid: { buckets: Map<number, RuntimeEntity[]>; maxHalf: number }) {
    if (l.parcel.outflow) return;
    const p = l.parcel;
    const reachMax = 2 * Math.max(p.spreadR, p.spreadT);
    const footArea = 2 * Math.PI * p.spreadR * p.spreadT;
    const source = `impact:${m.name}`;
    const reach = reachMax + grid.maxHalf;
    const near: RuntimeEntity[] = [];
    for (let gx = Math.floor((l.x - reach) / GRID); gx <= Math.floor((l.x + reach) / GRID); gx++) {
      for (let gz = Math.floor((l.z - reach) / GRID); gz <= Math.floor((l.z + reach) / GRID); gz++) {
        const b = grid.buckets.get(gx * 4096 + gz);
        if (b) near.push(...b);
      }
    }
    for (const e of near) {
      const pos = e.dynamic ? e.pose.position : e.initialPose.position;
      const half = Math.max(e.dims[0], e.dims[2]) / 2;
      const d = Math.hypot(pos[0] - l.x, pos[2] - l.z);
      if (d > reachMax + half) continue;
      // Share of the parcel over the object's plan area (Gaussian footprint value at the object).
      const a = (pos[0] - l.x) * l.dirX + (pos[2] - l.z) * l.dirZ, b = -(pos[0] - l.x) * l.dirZ + (pos[2] - l.z) * l.dirX;
      const density = Math.exp(-0.5 * ((a * a) / (p.spreadR * p.spreadR) + (b * b) / (p.spreadT * p.spreadT))) / footArea;
      const plan = e.dims[0] * e.dims[2];
      const mHit = Math.min(l.mass, l.mass * density * plan);
      if (mHit <= 0) continue;
      const st = impactOf(e, source);
      st.hits++;
      if (e.source.type === 'building') this.building(ctx, e, st, mHit, l);
      else if (SMALL.has(e.source.type) && !e.dynamic && e.body !== null) this.small(ctx, e, st, mHit, l);
      else if (e.dynamic && e.body !== null) this.body(ctx, e, st, mHit, l, dt);
    }
  }

  private building(ctx: SystemContext, e: RuntimeEntity, st: NonNullable<RuntimeEntity['impact']>, mHit: number, l: Landing) {
    const vh = Math.max(0.1, l.vh);
    const dur = (2 * l.parcel.spreadR) / vh;
    const F = (mHit * vh) / dur;
    const capacity = lateralCapacity(e) * (ctx.interactions ? residualStrength(e, 'impact') : 1);
    const r = capacity > 0 ? F / capacity : 0;
    st.ejectaRatio = Math.max(st.ejectaRatio, r);
    if (r > STRUCT_ONSET) st.damage = Math.min(1, st.damage + STRUCT_RATE * ((r - STRUCT_ONSET) / STRUCT_ONSET) * dur * (r >= 1.5 ? 10 : 1));
    const level = st.damage >= 1 ? DamageState.DESTROYED : st.damage >= 0.6 ? DamageState.CRITICAL : st.damage >= 0.3 ? DamageState.DAMAGED : r > STRUCT_ONSET ? DamageState.STRESSED : DamageState.NORMAL;
    if (level > e.state) {
      e.state = level;
      e.health = Math.min(e.health, 1 - st.damage);
      e.lastHazard = 'impact';
      e.lastCause = 'ejecta';
    }
  }

  private small(ctx: SystemContext, e: RuntimeEntity, st: NonNullable<RuntimeEntity['impact']>, mHit: number, l: Landing) {
    const vh = Math.max(0.1, l.vh);
    const F = (mHit * vh * vh) / (2 * l.parcel.spreadR);
    const windDesign = e.source.physics.windResistance * e.strength;
    let design = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * windDesign * windDesign * Math.max(0.5, e.copLocal[1]);
    if (ctx.interactions) design *= residualStrength(e, 'impact');
    // Resultant at half the height (ejecta strike the whole object).
    const ratio = design > 0 ? (F * e.dims[1] * 0.5) / design : 0;
    st.ejectaRatio = Math.max(st.ejectaRatio, ratio);
    if (ratio >= e.source.physics.breakThreshold && e.body !== null) {
      ctx.physics.setBodyKind(e.body, 'dynamic');
      e.dynamic = true;
      e.flags.toppled = true;
      st.damage = 1;
      e.health = 0;
      e.state = DamageState.DESTROYED;
      e.lastHazard = 'impact';
      e.lastCause = 'ejecta';
      ctx.recordDamage(e, { eventType: 'TOPPLED', cause: 'ejecta', hazard: 'impact', response: ratio, force: F, source: st.source });
      ctx.log(e.id, 'danger', { key: 'log.impact.toppled' });
      ctx.physics.applyImpulse(e.body, [l.dirX * mHit * vh * 0.5, 0, l.dirZ * mHit * vh * 0.5]);
    }
  }

  private body(ctx: SystemContext, e: RuntimeEntity, st: NonNullable<RuntimeEntity['impact']>, mHit: number, l: Landing, dt: number) {
    const v = Math.max(0, l.speed);
    const vh = Math.min(v, Math.max(0, l.vh)), vv = Math.sqrt(Math.max(0, v * v - vh * vh));
    const J = mHit * v;
    st.impulse += J;
    // Impulse over one step as a force through the ledger (downward + outward).
    force[0] = (mHit * vh * l.dirX) / dt;
    force[1] = (-mHit * vv) / dt;
    force[2] = (mHit * vh * l.dirZ) / dt;
    ctx.forces.force('impact', e.body!, force, e);
    if (e.source.type === 'human' && !e.flags.fallen) {
      const mass = e.source.physics.mass;
      const h = e.dims[1] / 2, b = FOOT_LEVER;
      const dvCrit = Math.sqrt(2 * GRAVITY * (Math.hypot(h, b) - h));
      if ((mHit * vh) / mass >= dvCrit) knockDown(e, ctx, 'ejecta', J / dt, [l.dirX, 0, l.dirZ]);
    }
  }
}
