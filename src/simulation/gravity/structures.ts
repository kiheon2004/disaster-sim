/**
 * Gravity on structures (Phase 31): the downward gravity at each modular building's members, as ratios k = g_down/g₀,
 * fed to its collapse model (solver.kM: own weight and surcharges × k — dead, snow, ash and rubble loads follow g).
 *
 *  - uniform field: one k for the whole building (fast path); a building inside a local source's radius gets one k per
 *    member (sampled at the member centre);
 *  - a building's ratios are re-applied when they moved by more than K_QUANTUM since the last application (a ramp is
 *    followed in ≈ 1 % load steps, not every 1/60 s); changes above SUDDEN_RATIO in one step are sudden (dynamic Ω);
 *  - models are created lazily (Phase 25): at most CREATE_BUDGET new models per step, so a gravity change over a
 *    1000-building town spreads the one-off creation over a few steps. Phase 31 audit (M3): the buildings the
 *    experiments' plans reach are prepared from the runtime's first step on (before the field moves, where the plan
 *    leaves time), in a canonical order by place (never by creation order or id — the same town built in another order
 *    gives the same results), and a model applied late takes the field's own history: it is loaded suddenly (dynamic
 *    increase) only if the FIELD changed suddenly since its last application, not because it jumps from 1 to the
 *    current ratio when created in the middle of a gradual ramp;
 *  - roof-panel checks (R1) are switched on for every model a gravity experiment touches.
 *
 * Capacities never change (designed on Earth: graph capacities, Phase 17 design analysis, seismic yield strengths).
 * Horizontal / upward components are a documented limit (outlook: structure 'limited').
 */
import type { Vec3 } from '@/core/types';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { structureOf, activate, toWorld, type StructureState } from '../structure/state';
import type { GravityField } from '@/gravity/field';
import type { GravitySourceSpec } from '@/gravity/types';
import { SUDDEN_RATIO } from '@/structure/collapse';

/** Re-apply a building's gravity ratios when one moved by more than this (share of g₀). */
export const K_QUANTUM = 0.01;
/** New collapse models per step for gravity (creation is a one-off cost per building). */
export const CREATE_BUDGET = 40;

interface Applied {
  /** Uniform ratio last applied (NaN = per member), per-member ratios when inside a source. */
  k: number;
  kM: Float64Array | null;
  /** Step of the last application. */
  step: number;
}

/** Canonical order of buildings: by place (x, z, y), id only for coincident ones. */
const byPlace = (a: RuntimeEntity, b: RuntimeEntity) => {
  const p = a.pose.position, q = b.pose.position;
  return p[0] - q[0] || p[2] - q[2] || p[1] - q[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

export class GravityStructures {
  private applied = new Map<RuntimeEntity, Applied>();
  /** Buildings with gravity ratios ≠ 1 applied, re-applications, models created for gravity. */
  loaded = 0;
  applications = 0;
  created = 0;
  /** Buildings the plan reaches still waiting for their model (no ratio is applied while > 0). */
  pending = 0;
  private readonly tmp: Vec3 = [0, 0, 0];

  constructor(private readonly g0: number) {}

  /** Ratio at a world point. */
  private ratio(f: GravityField, p: Readonly<Vec3>): number {
    return -f.sample(p[0], p[1], p[2], this.tmp)[1] / this.g0;
  }

  /** Buildings with a model in canonical order (rebuilt when the entity set changes). */
  private order: RuntimeEntity[] = [];
  private orderSize = -1;
  /** Field history: last step with a sudden change (> SUDDEN_RATIO of g₀ in one step), the last uniform ratio and source factors. */
  private lastSudden = -Infinity;
  private prevK = 1;
  private prevF = new Map<GravitySourceSpec, number>();
  private nextF = new Map<GravitySourceSpec, number>();
  /** Plan of the experiments (by field revision): a global part away from g₀, the sources of every experiment. */
  private planRev = -1;
  private planAll = false;
  private planSources: GravitySourceSpec[] = [];

  /** `changed`: the field changed since the last step (a static field only needs buildings never applied yet). */
  update(ctx: SystemContext, f: GravityField, changed = true) {
    let budget = CREATE_BUDGET;
    const kU = -f.G[1] / this.g0;
    const step = ctx.step;
    this.history(f, kU, step);
    if (ctx.runtime.entities.size !== this.orderSize) {
      this.orderSize = ctx.runtime.entities.size;
      this.order = [...ctx.runtime.entities.values()].filter((e) => e.modular).sort(byPlace);
    }
    if (f.rev !== this.planRev) this.plan(f);
    // Prepared ahead: the buildings the plan reaches get their models while the budget allows (no ratio applied yet).
    // Until every one of them has its model no ratio is applied anywhere — all buildings take a gravity change in the
    // same step (a town of N buildings without models answers ⌈N / CREATE_BUDGET⌉ − 1 steps late, all at once).
    let pending = 0;
    for (const e of this.order) {
      const mr = e.modular!;
      if (mr.structure || e.flags.collapsed || !this.planned(e)) continue;
      if (budget > 0) { budget--; this.created++; structureOf(e, ctx); } else pending++;
    }
    this.pending = pending;
    if (pending > 0) return;
    for (const e of this.order) {
      const mr = e.modular;
      if (!mr || e.flags.collapsed) continue;
      const a = this.applied.get(e);
      if (!changed && a && !e.flags.toppled) continue;
      const sudden = this.lastSudden > (a ? a.step : -Infinity);
      const local = !f.uniform && this.nearSource(f, e);
      if (!local) {
        const last = a ? (a.kM ? NaN : a.k) : 1;
        // Back to exactly 1 at a restore (no residual quantum left on the structure).
        if (!(Math.abs(kU - last) > K_QUANTUM) && !Number.isNaN(last) && !(kU === 1 && last !== 1)) continue;
        if (!mr.structure) { if (budget <= 0) continue; budget--; this.created++; }
        const st = structureOf(e, ctx);
        this.applyUniform(st, kU, sudden);
        this.applied.set(e, { k: kU, kM: null, step });
      } else {
        const st0 = mr.structure;
        if (!st0) { if (budget <= 0) continue; budget--; this.created++; }
        const st = structureOf(e, ctx);
        const g = st.model.g;
        const kM = a?.kM ?? new Float64Array(g.n).fill(a && !a.kM ? a.k : 1);
        let changed = !a?.kM;
        const next = new Float64Array(g.n);
        for (let i = 0; i < g.n; i++) {
          const o = 6 * i;
          const c = toWorld(e, [(g.box[o] + g.box[o + 3]) / 2, (g.box[o + 1] + g.box[o + 4]) / 2, (g.box[o + 2] + g.box[o + 5]) / 2]);
          next[i] = this.ratio(f, c);
          if (Math.abs(next[i] - kM[i]) > K_QUANTUM) changed = true;
        }
        if (!changed) continue;
        this.applyMembers(st, next, sudden);
        this.applied.set(e, { k: NaN, kM: next, step });
      }
      this.applications++;
      activate(e, ctx);
    }
    let n = 0;
    for (const a of this.applied.values()) if (a.kM || a.k !== 1) n++;
    this.loaded = n;
  }

  /** Whether the field changed suddenly in this step: the uniform ratio, or a source's factor × its strength (share of g₀). */
  private history(f: GravityField, kU: number, step: number) {
    let jump = Math.abs(kU - this.prevK);
    this.prevK = kU;
    const seen = this.nextF;
    seen.clear();
    const scale = (s: GravitySourceSpec) => (s.kind === 'radial' ? Math.abs(s.strength ?? 0) : Math.hypot(...(s.accel ?? [0, 0, 0]))) / this.g0;
    for (const l of f.liveSources()) {
      seen.set(l.src, l.f);
      jump = Math.max(jump, Math.abs(l.f - (this.prevF.get(l.src) ?? 0)) * scale(l.src));
    }
    for (const [src, v] of this.prevF) if (!seen.has(src)) jump = Math.max(jump, Math.abs(v) * scale(src));
    this.nextF = this.prevF;
    this.prevF = seen;
    if (jump > SUDDEN_RATIO) this.lastSudden = step;
  }

  private plan(f: GravityField) {
    this.planRev = f.rev;
    this.planAll = false;
    this.planSources = [];
    for (const x of f.experiments) {
      const s = x.spec;
      if (s.global && !(s.magnitude === this.g0 && s.direction[0] === 0 && s.direction[2] === 0 && s.direction[1] < 0)) this.planAll = true;
      this.planSources.push(...s.sources);
    }
  }

  /** The experiments' plan reaches the building: a global change, or a source of any experiment near it. */
  private planned(e: RuntimeEntity): boolean {
    if (this.planAll) return true;
    for (const src of this.planSources) if (this.meets(e, src)) return true;
    return false;
  }

  private meets(e: RuntimeEntity, src: GravitySourceSpec): boolean {
    const p = e.pose.position, d = e.dims;
    const r = 0.5 * Math.hypot(d[0], d[1], d[2]);
    const c = src.center;
    const dx = p[0] - c[0], dy = src.shape === 'column' && src.kind === 'region' ? 0 : p[1] + d[1] / 2 - c[1], dz = p[2] - c[2];
    return Math.hypot(dx, dy, dz) < src.radius + r;
  }

  private applyUniform(st: StructureState, k: number, sudden: boolean) {
    const m = st.model;
    m.s.enableRoofCheck();
    for (let i = 0; i < m.n; i++) m.setGravityRatio(i, k, 'gravity', sudden);
  }

  private applyMembers(st: StructureState, k: Float64Array, sudden: boolean) {
    const m = st.model;
    m.s.enableRoofCheck();
    for (let i = 0; i < m.n; i++) m.setGravityRatio(i, k[i], 'gravity', sudden);
  }

  /** The building's bounding sphere meets a local source. */
  private nearSource(f: GravityField, e: RuntimeEntity): boolean {
    for (const l of f.liveSources()) if (this.meets(e, l.src)) return true;
    return false;
  }
}
