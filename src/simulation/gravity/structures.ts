/**
 * Gravity on structures (Phase 31): the downward gravity at each modular building's members, as ratios k = g_down/g₀,
 * fed to its collapse model (solver.kM: own weight and surcharges × k — dead, snow, ash and rubble loads follow g).
 *
 *  - uniform field: one k for the whole building (fast path); a building inside a local source's radius gets one k per
 *    member (sampled at the member centre);
 *  - a building's ratios are re-applied when they moved by more than K_QUANTUM since the last application (a ramp is
 *    followed in ≈ 1 % load steps, not every 1/60 s); changes above SUDDEN_RATIO in one step are sudden (dynamic Ω);
 *  - models are created lazily (Phase 25): at most CREATE_BUDGET new models per step (deterministic order), so a gravity
 *    change over a 1000-building town spreads the one-off creation over a few steps;
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

/** Re-apply a building's gravity ratios when one moved by more than this (share of g₀). */
export const K_QUANTUM = 0.01;
/** New collapse models per step for gravity (creation is a one-off cost per building). */
export const CREATE_BUDGET = 40;

interface Applied {
  /** Uniform ratio last applied (NaN = per member), per-member ratios when inside a source. */
  k: number;
  kM: Float64Array | null;
}

export class GravityStructures {
  private applied = new Map<RuntimeEntity, Applied>();
  /** Buildings with gravity ratios ≠ 1 applied, re-applications, models created for gravity. */
  loaded = 0;
  applications = 0;
  created = 0;
  private readonly tmp: Vec3 = [0, 0, 0];

  constructor(private readonly g0: number) {}

  /** Ratio at a world point. */
  private ratio(f: GravityField, p: Readonly<Vec3>): number {
    return -f.sample(p[0], p[1], p[2], this.tmp)[1] / this.g0;
  }

  /** `changed`: the field changed since the last step (a static field only needs buildings never applied yet). */
  update(ctx: SystemContext, f: GravityField, changed = true) {
    let budget = CREATE_BUDGET;
    const kU = -f.G[1] / this.g0;
    for (const e of ctx.runtime.entities.values()) {
      const mr = e.modular;
      if (!mr || e.flags.collapsed) continue;
      const a = this.applied.get(e);
      if (!changed && a && !e.flags.toppled) continue;
      const local = !f.uniform && this.nearSource(f, e);
      if (!local) {
        const last = a ? (a.kM ? NaN : a.k) : 1;
        // Back to exactly 1 at a restore (no residual quantum left on the structure).
        if (!(Math.abs(kU - last) > K_QUANTUM) && !Number.isNaN(last) && !(kU === 1 && last !== 1)) continue;
        if (!mr.structure) { if (budget <= 0) continue; budget--; this.created++; }
        const st = structureOf(e, ctx);
        this.applyUniform(st, kU);
        this.applied.set(e, { k: kU, kM: null });
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
        this.applyMembers(st, next);
        this.applied.set(e, { k: NaN, kM: next });
      }
      this.applications++;
      activate(e, ctx);
    }
    let n = 0;
    for (const a of this.applied.values()) if (a.kM || a.k !== 1) n++;
    this.loaded = n;
  }

  private applyUniform(st: StructureState, k: number) {
    const m = st.model;
    m.s.enableRoofCheck();
    for (let i = 0; i < m.n; i++) m.setGravityRatio(i, k);
  }

  private applyMembers(st: StructureState, k: Float64Array) {
    const m = st.model;
    m.s.enableRoofCheck();
    for (let i = 0; i < m.n; i++) m.setGravityRatio(i, k[i]);
  }

  /** The building's bounding sphere meets a local source. */
  private nearSource(f: GravityField, e: RuntimeEntity): boolean {
    const p = e.pose.position, d = e.dims;
    const r = 0.5 * Math.hypot(d[0], d[1], d[2]);
    for (const l of f.liveSources()) {
      const c = l.src.center;
      const dx = p[0] - c[0], dy = l.src.shape === 'column' && l.src.kind === 'region' ? 0 : p[1] + d[1] / 2 - c[1], dz = p[2] - c[2];
      if (Math.hypot(dx, dy, dz) < l.src.radius + r) return true;
    }
    return false;
  }
}
