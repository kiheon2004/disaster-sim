/**
 * How objects respond to lava, volcanic deposits, ash and bombs (Phase 28). The lava is a CONTINUUM on the
 * vertex grid (VolcanoWorld's LavaField) — never particles or bodies.
 *
 *  - obstacles   intact buildings and walls stop the lava (it rises against them and flows around; it
 *                passes only once it overtops them). A collapsed building is an obstacle no longer.
 *  - lateral     lava standing against a structure presses on it hydrostatically, ½·ρ·g·h²·B (a viscous
 *                fluid at the speeds of these flows: the dynamic share ρu²h is kept but ≪ the static one).
 *                Buildings: against the lateral strength of their structural system (the Phase 22 sediment
 *                rule: damage above 50 % of the capacity, modular buildings: ground-story members);
 *                trees, poles, signs: base moment against their wind design moment → toppled.
 *  - burial      lava + deposit at the object above a share of its height (people 0.7, vehicles 0.6, small
 *                structures / trees 0.8, buildings: their full height) → BURIED (once).
 *  - contact     objects standing in lava get its heat (runtime.ts contact step); vehicles in ≥ 0.3 m of lava
 *                can no longer move (made fixed: they are held by the lava), people's contact is recorded
 *                (exposure only — no physiology, Phase 33–34).
 *  - ash         ash landing on a building footprint stays on its roof: its weight is a static surcharge on
 *                the roof members (modular buildings, Phase 25 `addLoad`, hazard 'volcano') — other buildings
 *                only report the load; roads report ash thickness.
 *  - bombs       a bomb landing on an object is caught by it (heat into its thermal body, mass on its roof),
 *                the impact recorded with its kinetic energy (no damage index of its own is derived).
 *  - roads       per segment sample: lava over the crown → blocked; solidified deposit ≥ 0.3 m → blocked (the
 *                rubble threshold of Phase 25); ash ≥ 0.1 m → impassable (assumed indicative threshold: a few
 *                cm to 10 cm of ash are reported to stop two-wheel-drive vehicles). The network is never edited.
 */
import { GRAVITY } from '@/core/units';
import { qRotate } from '@/core/math';
import type { Vec3 } from '@/core/types';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { DamageState, worst } from '../damage/DamageState';
import { lateralCapacity, STRUCT_ONSET, STRUCT_RATE, AIR } from '../ground/objects';
import { residualStrength } from '../interactions/integrity';
import { raiseDamage } from '../buildings/modular';
import { activate, structureOf } from '../structure/state';
import { MT_COLUMN, MT_DOOR, MT_ROOF, MT_WALL, MT_WINDOW } from '@/structure/graph';
import { MS } from '@/structure/types';
import { ROAD_IMPASSABLE_STEP } from '../deformation/response';
import type { Bomb } from '@/volcano/bombs';
import type { VolcanoRuntime } from './runtime';
import type { EntityThermal } from '../thermal/runtime';

const BURIAL: Record<string, number> = { human: 0.7, car: 0.6, truck: 0.6, streetLight: 0.8, sign: 0.8, wall: 0.8, tree: 0.8, building: 1 };
/** Lava depth that holds a vehicle in place (m) — about the axle height (assumed). */
export const HOLD_DEPTH = 0.3;
export const ASH_ROAD = 0.1;
/** Roof surcharge changes below this share of the member's capacity are not re-applied (as Phase 26 LOAD_QUANTUM). */
const LOAD_STEP = 0.005;

export interface VolcanoEntityState {
  /** Lava depth / deposit at the object now and the largest seen (m). */
  lava: number;
  deposit: number;
  peakLava: number;
  /** Lateral lava load ratio (load / capacity), its damage index. */
  ratio: number;
  damage: number;
  /** Ash on the roof (kg) and the load (kPa). */
  ash: number;
  ashLoad: number;
  /** Seconds in contact with lava (people: exposure). */
  contact: number;
  /** Bombs that struck it and their energy (J). */
  bombs: number;
  bombEnergy: number;
  held: boolean;
  noted: Set<string>;
}

export function volcanoState(e: RuntimeEntity): VolcanoEntityState {
  return (e.volcano ??= { lava: 0, deposit: 0, peakLava: 0, ratio: 0, damage: 0, ash: 0, ashLoad: 0, contact: 0, bombs: 0, bombEnergy: 0, held: false, noted: new Set() });
}

interface Template {
  te: EntityThermal;
  member: number;
  width: number;
  height: number;
  core: boolean;
  under: boolean;
  underArea: number;
  clearance: number;
}

export interface ContactPoint { vertex: number; body: number; width: number; height: number; core: boolean; under: boolean; underArea: number; clearance: number; share: number }

export class VolcanoObjects {
  /** Vertex → building / wall entity covering it (index into `blockers`, −1 none). */
  private readonly owner: Int32Array;
  private readonly blockers: RuntimeEntity[] = [];
  private readonly blockerHeight: number[] = [];
  private readonly blockerOn: boolean[] = [];
  /** Vertex → contact templates (objects that touch lava standing at that vertex). */
  private readonly templates = new Map<number, Template[]>();
  private readonly refinedTemplates = new Set<EntityThermal>();
  private readonly roofAsh = new Map<RuntimeEntity, number>();
  private readonly roofApplied = new Map<RuntimeEntity, Float64Array>();
  /** Small objects by vertex (bomb hits). */
  private readonly smallAt = new Map<number, RuntimeEntity[]>();

  constructor(ctx: SystemContext, private readonly vr: VolcanoRuntime) {
    const f = vr.world.field;
    this.owner = new Int32Array(f.n).fill(-1);
    for (const te of vr.trt.ents) {
      const e = te.e, t = e.source.type;
      if (t === 'building' || t === 'wall') {
        const k = this.blockers.length;
        this.blockers.push(e);
        this.blockerHeight.push(e.dims[1]);
        this.blockerOn.push(true);
        this.footprint(e, 0, (v) => { this.owner[v] = k; f.obstacle[v] = e.dims[1]; });
        if (t === 'building') this.coarseTemplates(te);
      } else if (t === 'car') {
        const v = f.index(e.pose.position[0], e.pose.position[2]);
        if (v >= 0) this.add(v, { te, member: -1, width: 2 * (e.dims[0] + e.dims[2]), height: e.dims[1], core: false, under: true, underArea: e.dims[0] * e.dims[2], clearance: 0.2 });
        this.footprint(e, 0, (u) => this.small(u, e));
      } else if (t === 'tree') {
        const p = e.source.params as Record<string, number>;
        const v = f.index(e.pose.position[0], e.pose.position[2]);
        if (v >= 0) this.add(v, { te, member: -1, width: 2 * Math.PI * (p.trunkRadius ?? 0.3), height: Math.max(1, (p.height ?? e.dims[1]) * 0.4), core: true, under: false, underArea: 0, clearance: 0 });
        this.small(v, e);
      } else if (t === 'streetLight' || t === 'sign') {
        const v = f.index(e.pose.position[0], e.pose.position[2]);
        if (v >= 0) this.add(v, { te, member: -1, width: 0.6, height: e.dims[1], core: false, under: false, underArea: 0, clearance: 0 });
        this.small(v, e);
      }
    }
    for (const e of ctx.runtime.entities.values()) if (e.source.type === 'human') { const v = f.index(e.pose.position[0], e.pose.position[2]); this.small(v, e); }
  }

  private add(v: number, t: Template) {
    if (v < 0) return;
    const l = this.templates.get(v);
    if (l) l.push(t); else this.templates.set(v, [t]);
  }

  private small(v: number, e: RuntimeEntity) {
    if (v < 0) return;
    const l = this.smallAt.get(v);
    if (l) l.push(e); else this.smallAt.set(v, [e]);
  }

  /** Vertices whose position lies inside the (oriented) footprint grown by `margin`. */
  private footprint(e: RuntimeEntity, margin: number, f: (v: number) => void) {
    const fl = this.vr.world.field;
    const p = e.pose.position, q = e.pose.quaternion;
    const hx = e.dims[0] / 2 + margin, hz = e.dims[2] / 2 + margin;
    const ax = qRotate(q, [1, 0, 0]), az = qRotate(q, [0, 0, 1]);
    const r = Math.hypot(hx, hz);
    const i0 = Math.max(0, Math.ceil((p[0] - r - fl.originX) / fl.dx)), i1 = Math.min(fl.nx - 1, Math.floor((p[0] + r - fl.originX) / fl.dx));
    const k0 = Math.max(0, Math.ceil((p[2] - r - fl.originZ) / fl.dx)), k1 = Math.min(fl.nz - 1, Math.floor((p[2] + r - fl.originZ) / fl.dx));
    for (let iz = k0; iz <= k1; iz++) for (let ix = i0; ix <= i1; ix++) {
      const x = fl.originX + ix * fl.dx - p[0], z = fl.originZ + iz * fl.dx - p[2];
      const lx = x * ax[0] + z * ax[2], lz = x * az[0] + z * az[2];
      if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) f(iz * fl.nx + ix);
    }
  }

  /** Ring of vertices just outside a building: lava there touches its walls (coarse body until refined). */
  private coarseTemplates(te: EntityThermal) {
    const inside = new Set<number>();
    this.footprint(te.e, 0, (v) => inside.add(v));
    const ring: number[] = [];
    this.footprint(te.e, 1.01, (v) => { if (!inside.has(v)) ring.push(v); });
    for (const v of ring) this.add(v, { te, member: -1, width: 1, height: te.e.dims[1], core: false, under: false, underArea: 0, clearance: 0 });
  }

  /** Member templates of a refined modular building: its ground-story perimeter members face the ring. */
  private memberTemplates(te: EntityThermal) {
    const bt = te.b!;
    if (this.refinedTemplates.has(te)) return;
    this.refinedTemplates.add(te);
    const g = bt.g, f = this.vr.world.field;
    // Drop the coarse templates of this building.
    for (const [v, l] of this.templates) { const k = l.filter((t) => t.te !== te); if (k.length !== l.length) { if (k.length) this.templates.set(v, k); else this.templates.delete(v); } }
    const c = te.e.pose.position;
    for (let i = 0; i < g.n; i++) {
      if (g.level[i] !== 0 || !bt.perimeter[i]) continue;
      const t = g.type[i];
      if (t !== MT_WALL && t !== MT_COLUMN && t !== MT_DOOR && t !== MT_WINDOW) continue;
      const o = 6 * i;
      const P = this.vr.trt.toWorld(te.e, [(g.box[o] + g.box[o + 3]) / 2, 0, (g.box[o + 2] + g.box[o + 5]) / 2]);
      const dx = P[0] - c[0], dz = P[2] - c[2], d = Math.hypot(dx, dz) || 1;
      const v = f.index(P[0] + (dx / d) * 1.0, P[2] + (dz / d) * 1.0);
      const w = Math.max(g.box[o + 3] - g.box[o], g.box[o + 5] - g.box[o + 2]);
      this.add(v, { te, member: i, width: w, height: g.box[o + 4] - g.box[o + 1], core: false, under: false, underArea: 0, clearance: 0 });
    }
  }

  /** Lava stops at intact buildings and walls; a collapsed one lets it through. */
  obstacles(ctx: SystemContext) {
    void ctx;
    const f = this.vr.world.field;
    for (let k = 0; k < this.blockers.length; k++) {
      if (!this.blockerOn[k]) continue;
      const e = this.blockers[k];
      const gone = e.flags.collapsed || e.flags.toppled || (e.modular ? Number.isFinite(e.modular.collapsedFrom) && e.modular.collapsedFrom === 0 : false);
      if (!gone) continue;
      this.blockerOn[k] = false;
      this.footprint(e, 0, (v) => { if (this.owner[v] === k) f.obstacle[v] = 0; });
    }
  }

  /** Contact points of objects with lava at their vertices (the runtime turns them into heat). */
  contactPoints(ctx: SystemContext): ContactPoint[] {
    const f = this.vr.world.field, trt = this.vr.trt;
    const out: ContactPoint[] = [];
    const visit = (v: number) => {
      const l = this.templates.get(v);
      if (!l) return;
      for (const t of l) {
        const te = t.te;
        if (!te.active) trt.activate(ctx, te);
        if (te.coarse) { trt.refine(ctx, te); }
        if (te.b && !this.refinedTemplates.has(te)) { this.memberTemplates(te); return visit(v); }
        const body = t.member >= 0 ? te.b?.body[t.member] ?? -1 : te.body;
        if (body < 0) continue;
        if (t.member >= 0) { const st = te.e.modular?.structure?.model.state[t.member] ?? MS.INTACT; if (st >= MS.FAILED) continue; }
        out.push({ vertex: v, body, width: t.width, height: t.height, core: t.core, under: t.under, underArea: t.underArea, clearance: t.clearance, share: 1 });
      }
    };
    for (const v of f.mobile) visit(v);
    for (const v of f.hot) if (f.M[v] <= 0) visit(v);
    // Several points on one body share its half-difference limit.
    const n = new Map<string, number>();
    for (const c of out) { const k = `${c.body}:${c.core}`; n.set(k, (n.get(k) ?? 0) + 1); }
    for (const c of out) c.share = n.get(`${c.body}:${c.core}`)!;
    return out;
  }

  /** Ash arriving at a vertex inside a building footprint stays on its roof. */
  catchAsh(v: number, m: number): number {
    const k = this.owner[v];
    if (k < 0 || !this.blockerOn[k]) return 0;
    const e = this.blockers[k];
    if (e.source.type !== 'building') return 0;
    this.roofAsh.set(e, (this.roofAsh.get(e) ?? 0) + m);
    return m;
  }

  /** The object a bomb lands on (its thermal body), or −1. Records the impact. */
  bombHit(ctx: SystemContext, b: Bomb): number {
    const f = this.vr.world.field, trt = this.vr.trt;
    const p = b.parcel, v = f.index(p.p1[0], p.p1[2]);
    if (v < 0) return -1;
    let e: RuntimeEntity | null = null;
    const k = this.owner[v];
    if (k >= 0 && this.blockerOn[k] && this.blockers[k].source.type === 'building') e = this.blockers[k];
    else e = (this.smallAt.get(v) ?? []).find((x) => x.source.type !== 'human' && !x.def.inert) ?? null;
    if (!e) {
      // People are struck but do not catch the bomb (it lands beside them).
      const h = (this.smallAt.get(v) ?? []).find((x) => x.source.type === 'human');
      if (h) this.strike(ctx, h, b);
      return -1;
    }
    const te = trt.byEntity.get(e.id);
    if (!te) return -1;
    if (!te.active) trt.activate(ctx, te);
    this.strike(ctx, e, b);
    if (e.source.type === 'building') this.roofAsh.set(e, (this.roofAsh.get(e) ?? 0) + p.mass);
    if (te.b) {
      // The roof member nearest to the landing point takes it.
      let best = -1, bd = Infinity;
      const B = trt.world.bodies;
      for (let i = 0; i < te.b.g.n; i++) {
        const bb = te.b.body[i];
        if (bb < 0 || !B.alive[bb] || te.b.g.type[i] !== MT_ROOF) continue;
        const d = Math.hypot(B.x[bb] - p.p1[0], B.z[bb] - p.p1[2]);
        if (d < bd) { bd = d; best = bb; }
      }
      return best >= 0 ? best : -1;
    }
    return te.body;
  }

  private strike(ctx: SystemContext, e: RuntimeEntity, b: Bomb) {
    const st = volcanoState(e);
    const E = 0.5 * b.parcel.mass * b.parcel.v1 * b.parcel.v1;
    st.bombs++;
    st.bombEnergy += E;
    ctx.recordDamage(e, { eventType: 'IMPACT', cause: 'ejecta', hazard: 'volcano', force: E, damageBefore: 1 - e.health, damageAfter: 1 - e.health, worldPosition: [...b.parcel.p1] as Vec3, source: 'volcano' });
  }

  // ── Per step responses ─────────────────────────────────

  respond(ctx: SystemContext, dt: number) {
    const f = this.vr.world.field;
    const sample = (x: number, z: number) => { const v = f.index(x, z); return v < 0 ? { h: 0, d: 0, v: -1 } : { h: f.depth(v), d: f.dep[v], v }; };
    for (const e of ctx.runtime.entities.values()) {
      if (e.def.inert) continue;
      const t = e.source.type;
      const p = e.pose.position;
      if (t === 'building') { this.building(ctx, e, dt); continue; }
      const s = sample(p[0], p[2]);
      if (s.h <= 0.005 && s.d <= 0.005 && !e.volcano) continue;
      const st = volcanoState(e);
      st.lava = s.h; st.deposit = s.d;
      if (s.h > st.peakLava) st.peakLava = s.h;
      if (s.h >= 0.02) { st.contact += dt; this.arrival(ctx, e); }
      const over = s.h + s.d;
      const burial = BURIAL[t];
      if (burial !== undefined && over >= burial * e.dims[1] && !st.noted.has('buried')) {
        st.noted.add('buried');
        e.state = worst(e.state, DamageState.CRITICAL);
        e.lastHazard = 'volcano';
        e.lastCause = 'burial';
        ctx.recordDamage(e, { eventType: 'BURIED', cause: 'burial', hazard: 'volcano', response: over, source: 'volcano' });
        ctx.log(e.id, 'danger', { key: 'log.volcano.buried', params: { m: over.toFixed(2) } });
      }
      if (t === 'human') {
        if (s.h >= 0.02 && !st.noted.has('contact')) { st.noted.add('contact'); ctx.recordDamage(e, { eventType: 'LAVA_CONTACT', cause: 'lava', hazard: 'volcano', response: s.h, damageBefore: 1 - e.health, damageAfter: 1 - e.health, source: 'volcano' }); }
        continue;
      }
      if (t === 'car') {
        if (s.h >= 0.02 && !st.noted.has('contact')) { st.noted.add('contact'); ctx.recordDamage(e, { eventType: 'LAVA_CONTACT', cause: 'lava', hazard: 'volcano', response: s.h, damageBefore: 1 - e.health, damageAfter: 1 - e.health, source: 'volcano' }); }
        if (s.h >= HOLD_DEPTH && !st.held && e.body !== null) {
          st.held = true;
          ctx.physics.setBodyKind(e.body, 'fixed');
          e.dynamic = false;
          ctx.log(e.id, 'danger', { key: 'log.volcano.held', params: { m: s.h.toFixed(2) } });
        }
        continue;
      }
      if (t === 'tree' || t === 'streetLight' || t === 'sign' || t === 'wall') {
        if (e.flags.toppled || e.dynamic || e.body === null || s.h <= 0.02) continue;
        const v = s.v;
        const rho = f.rho, u = v >= 0 ? f.speed[v] : 0;
        const w = t === 'wall' ? e.dims[0] : Math.min(e.dims[0], e.dims[2]);
        const h = Math.min(e.dims[1], s.h);
        const M = 0.5 * rho * GRAVITY * h * h * w * (h / 3) + rho * u * u * h * w * (h / 2);
        const windDesign = e.source.physics.windResistance * e.strength;
        let design = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * windDesign * windDesign * Math.max(0.5, e.copLocal[1]);
        if (ctx.interactions) design *= residualStrength(e, 'volcano');
        st.ratio = design > 0 ? M / design : 0;
        if (st.ratio >= e.source.physics.breakThreshold) {
          ctx.physics.setBodyKind(e.body, 'dynamic');
          e.dynamic = true;
          e.flags.toppled = true;
          st.damage = 1;
          e.state = DamageState.DESTROYED;
          e.lastHazard = 'volcano';
          e.lastCause = 'lava';
          ctx.recordDamage(e, { eventType: 'TOPPLED', cause: 'lava', hazard: 'volcano', response: st.ratio, force: M, source: 'volcano' });
          ctx.log(e.id, 'danger', { key: 'log.volcano.toppled' });
        }
      }
    }
    this.roads(ctx);
  }

  /** Buildings: lateral lava load on the most loaded side, burial, ash roof load. */
  private building(ctx: SystemContext, e: RuntimeEntity, dt: number) {
    const f = this.vr.world.field;
    const p = e.initialPose.position, q = e.pose.quaternion;
    const ax = qRotate(q, [1, 0, 0]), az = qRotate(q, [0, 0, 1]);
    const hx = e.dims[0] / 2 + 1, hz = e.dims[2] / 2 + 1;
    let best = 0, hb = 0, over = 0;
    for (const [u, w] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = p[0] + u * hx * ax[0] + w * hz * az[0], z = p[2] + u * hx * ax[2] + w * hz * az[2];
      const v = f.index(x, z);
      if (v < 0) continue;
      const h = f.depth(v), d = f.dep[v];
      if (h + d > over) over = h + d;
      const L = 0.5 * f.rho * GRAVITY * h * h + f.rho * f.speed[v] ** 2 * h;
      if (L > best) { best = L; hb = h; }
    }
    const ash = this.roofAsh.get(e) ?? 0;
    if (best <= 0 && over <= 0.005 && ash <= 0 && !e.volcano) return;
    const st = volcanoState(e);
    st.lava = hb; st.deposit = over - hb;
    if (hb > st.peakLava) st.peakLava = hb;
    if (hb > 0.02) { st.contact += dt; this.arrival(ctx, e); }
    // Ash on the roof.
    st.ash = ash;
    const roofA = Math.max(1, e.dims[0] * e.dims[2]);
    st.ashLoad = (ash * GRAVITY) / roofA / 1000;
    if (ash > 0 && e.modular) this.roofLoad(ctx, e, ash);
    if (over >= e.dims[1] && !st.noted.has('buried')) {
      st.noted.add('buried');
      ctx.recordDamage(e, { eventType: 'BURIED', cause: 'burial', hazard: 'volcano', response: over, source: 'volcano' });
    }
    if (best <= 0) return;
    const B = Math.max(e.dims[0], e.dims[2]);
    const F = best * B;
    const capacity = lateralCapacity(e) * (ctx.interactions ? residualStrength(e, 'volcano') : 1);
    const r = capacity > 0 ? F / capacity : 0;
    st.ratio = r;
    let d = st.damage;
    if (r > STRUCT_ONSET) d += STRUCT_RATE * ((r - STRUCT_ONSET) / STRUCT_ONSET) * dt * (r >= 1.5 ? 10 : 1);
    d = Math.min(1, d);
    if (d > st.damage) {
      st.damage = d;
      const level = d >= 1 ? DamageState.DESTROYED : d >= 0.6 ? DamageState.CRITICAL : d >= 0.3 ? DamageState.DAMAGED : e.state;
      if (level > e.state) { e.state = level; e.lastHazard = 'volcano'; e.lastCause = 'lava'; }
      if (e.modular) for (const i of e.modular.storyMembers[0] ?? []) raiseDamage(e.modular, i, 0.9 * d, 'volcano');
      if (d >= 0.3 && !st.noted.has('lavaLoad')) {
        st.noted.add('lavaLoad');
        ctx.recordDamage(e, { eventType: 'DAMAGED', cause: 'lava', hazard: 'volcano', response: r, force: F, damageBefore: 0, damageAfter: d, source: 'volcano' });
      }
    }
  }

  /** Ash weight on the roof members of a modular building (static surcharge, by plan area). */
  private roofLoad(ctx: SystemContext, e: RuntimeEntity, ash: number) {
    const mr = e.modular!;
    const g = structureOf(e, ctx).model.g;
    let applied = this.roofApplied.get(e);
    if (!applied) this.roofApplied.set(e, (applied = new Float64Array(g.n)));
    let A = 0;
    for (let i = 0; i < g.n; i++) if (g.type[i] === MT_ROOF && !g.absent[i]) A += (g.box[6 * i + 3] - g.box[6 * i]) * (g.box[6 * i + 5] - g.box[6 * i + 2]);
    if (A <= 0) return;
    const model = mr.structure!.model;
    for (let i = 0; i < g.n; i++) {
      if (g.type[i] !== MT_ROOF || g.absent[i] || model.state[i] >= MS.FAILED) continue;
      const a = (g.box[6 * i + 3] - g.box[6 * i]) * (g.box[6 * i + 5] - g.box[6 * i + 2]);
      const N = (ash * GRAVITY * a) / A;
      if (Math.abs(N - applied[i]) > LOAD_STEP * Math.max(1, g.capN[i] || g.mass[i] * GRAVITY)) {
        model.addLoad(i, N - applied[i], 'volcano');
        applied[i] = N;
        activate(e, ctx);
      }
    }
  }

  /** Timeline: the first object the lava reaches. */
  private arrival(ctx: SystemContext, e: RuntimeEntity) {
    ctx.milestone?.({ time: ctx.time, kind: 'lavaArrival', hazard: 'volcano', subject: e.source.type, label: { key: 'milestone.lavaArrival' } }, 'volcano:lavaArrival');
  }

  private roads(ctx: SystemContext) {
    const roads = ctx.runtime.roads;
    if (!roads) return;
    const f = this.vr.world.field;
    for (const st of roads.segments) {
      let lava = 0, dep = 0, ash = 0, Ts = 0;
      for (const p of st.samples) {
        const v = f.index(p.x, p.z);
        if (v < 0) continue;
        lava = Math.max(lava, f.depth(v));
        dep = Math.max(dep, (f.depM[v] + f.depB[v]) / (f.rho * f.area));
        ash = Math.max(ash, f.depA[v] / 1000 / f.area);
        if (f.M[v] > 0 || f.depE[v] > 0) Ts = Math.max(Ts, f.Ts[v]);
      }
      if (lava <= 0.005 && dep <= 0.005 && ash <= 0.002 && !st.volcanic) continue;
      const prev = st.volcanic;
      st.volcanic = { lava, deposit: dep, ash, surfaceT: Ts, peakLava: Math.max(prev?.peakLava ?? 0, lava), peakT: Math.max(prev?.peakT ?? 0, Ts), blocked: (prev?.blocked ?? false) || lava >= 0.02 || dep >= ROAD_IMPASSABLE_STEP, impassable: (prev?.impassable ?? false) || ash >= ASH_ROAD };
      roads.rev++;
      if ((lava >= 0.02 || dep >= ROAD_IMPASSABLE_STEP) && roads.mark(st, 'blocked', ctx.time, Math.max(lava, dep))) {
        ctx.log(null, 'danger', { key: 'log.volcano.roadBlocked', params: { id: st.id } });
        ctx.milestone?.({ time: ctx.time, kind: 'roadBlocked', hazard: 'volcano', subject: 'road', label: { key: 'milestone.volcano.roadBlocked', params: { id: st.id } } }, `volcano:road:${st.id}`);
      }
      if (ash >= ASH_ROAD) roads.mark(st, 'impassable', ctx.time, ash);
    }
  }
}
