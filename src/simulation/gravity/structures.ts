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
 *  - roof-panel checks (R1) are switched on for every model a gravity experiment touches;
 *  - Phase 32: celestial point sources reach every building within r_reach = √(μ/(0.005·g₀)) of their path (beyond it
 *    their pull is below half a ratio quantum); with a point source in force a member pulled UPWARD takes k = 0 (no
 *    compression from an upward field — the tension it puts on its connections is the celestial uplift check,
 *    simulation/celestial/structures.ts), instead of the Phase 31 |k| (which stays for gravity experiments alone).
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
import { G_N } from '@/celestial/constants';
import type { CelestialSourceSpec } from '@/celestial/types';
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
  private prevMu = 0;
  private celestialSudden = false;
  private nextF = new Map<GravitySourceSpec, number>();
  /** Plan of the experiments (by field revision): a global part away from g₀, the sources of every experiment. */
  private planRev = -1;
  private planAll = false;
  private planSources: GravitySourceSpec[] = [];
  /** Celestial sources of the plan: the polyline they move on and their reach (m). */
  private planPoints: { pts: Vec3[]; reach: number }[] = [];

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
        let jump = 0;
        for (let i = 0; i < g.n; i++) {
          const o = 6 * i;
          const c = toWorld(e, [(g.box[o] + g.box[o + 3]) / 2, (g.box[o + 1] + g.box[o + 4]) / 2, (g.box[o + 2] + g.box[o + 5]) / 2]);
          next[i] = this.ratio(f, c);
          const d = Math.abs(next[i] - kM[i]);
          if (d > K_QUANTUM) changed = true;
          if (d > jump) jump = d;
        }
        if (!changed) continue;
        // Phase 32: models near a celestial source are prepared before it starts, so a jump of a member's own ratio
        // within one application (re-applied every K_QUANTUM) is the field's own sudden change (a source switched on).
        const cel = f.points.live.length > 0;
        this.applyMembers(st, next, sudden || (cel && a !== undefined && jump > SUDDEN_RATIO) || (cel && !a && jump > SUDDEN_RATIO && this.celestialSudden), cel);
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
    // Phase 32: a celestial source's μ (ramp / growth) changing by more than SUDDEN_RATIO of itself in one step.
    let mu = 0;
    for (const l of f.points.live) mu += l.mu;
    this.celestialSudden = Math.abs(mu - this.prevMu) > SUDDEN_RATIO * Math.max(mu, this.prevMu);
    this.prevMu = mu;
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
    this.planPoints = [];
    for (const x of f.celestial) for (const s of x.spec.sources) this.planPoints.push({ pts: celestialPath(s, x.spec.duration), reach: celestialReach(s, this.g0) });
  }

  /** The experiments' plan reaches the building: a global change, or a source of any experiment near it. */
  private planned(e: RuntimeEntity): boolean {
    if (this.planAll) return true;
    for (const src of this.planSources) if (this.meets(e, src)) return true;
    for (const p of this.planPoints) if (nearPath(e, p.pts, p.reach)) return true;
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

  private applyMembers(st: StructureState, k: Float64Array, sudden: boolean, celestial = false) {
    const m = st.model;
    m.s.enableRoofCheck();
    for (let i = 0; i < m.n; i++) m.setGravityRatio(i, celestial && k[i] < 0 ? 0 : k[i], 'gravity', sudden);
  }

  /** The building's bounding sphere meets a local source (or lies within a celestial source's reach). */
  private nearSource(f: GravityField, e: RuntimeEntity): boolean {
    for (const l of f.liveSources()) if (this.meets(e, l.src)) return true;
    for (const l of f.points.live) {
      const p = e.pose.position;
      if (Math.hypot(p[0] - l.x, p[1] + e.dims[1] / 2 - l.y, p[2] - l.z) < Math.sqrt(l.mu / (0.005 * this.g0)) + 0.5 * Math.hypot(...e.dims)) return true;
    }
    return false;
  }
}

/** Reach of a celestial source (m): where its pull falls to half a ratio quantum (0.005·g₀). */
export function celestialReach(s: CelestialSourceSpec, g0: number): number {
  return Math.sqrt((G_N * s.mass) / (0.005 * g0));
}

/** Polyline a celestial source moves on over the window (its centre for a fixed source). */
export function celestialPath(s: CelestialSourceSpec, duration: number): Vec3[] {
  if (s.motion === 'path' && s.path?.length) return s.path.map((w) => [w[1], w[2], w[3]] as Vec3);
  if (s.motion === 'velocity' && s.velocity) {
    const T = (s.end ?? duration) - (s.start ?? 0);
    return [[...s.center] as Vec3, [s.center[0] + s.velocity[0] * T, s.center[1] + s.velocity[1] * T, s.center[2] + s.velocity[2] * T]];
  }
  return [[...s.center] as Vec3];
}

/** A building's bounding sphere comes within `reach` of a polyline. */
export function nearPath(e: RuntimeEntity, pts: readonly Vec3[], reach: number): boolean {
  const p = e.pose.position, d = e.dims;
  const c: Vec3 = [p[0], p[1] + d[1] / 2, p[2]];
  const R = reach + 0.5 * Math.hypot(d[0], d[1], d[2]);
  if (pts.length === 1) return Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1], c[2] - pts[0][2]) < R;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / L2)) : 0;
    if (Math.hypot(c[0] - a[0] - t * ab[0], c[1] - a[1] - t * ab[1], c[2] - a[2] - t * ab[2]) < R) return true;
  }
  return false;
}
