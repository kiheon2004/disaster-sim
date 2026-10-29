/**
 * Incremental load-path solver of the structural destruction engine (Phase 25).
 *
 * State: which members / connections are still in the structure, which are supported, the gravity
 * load each member carries and the share each connection transfers. Changes (a member killed, a
 * connection broken, ground support lost, a surcharge added, a capacity reduced) are QUEUED and
 * resolved by `propagate()` — only the affected region is visited:
 *
 *  1. support pass (bottom-up, by topological rank): members resting on a changed member re-select
 *     their support tier (a column whose column below is gone stands on the beams of the joint —
 *     transfer); members left without support leave the structure (they will fall) and their
 *     dependents are visited in turn;
 *  2. load pass (top-down): a visited member recomputes its load = own weight + surcharge + what
 *     its dependents pass to it, and splits it equally over its supported supports of the chosen
 *     tier (tributary approximation of Phase 17); only connections whose share changed propagate
 *     further down;
 *  3. checks on the members / connections whose demand changed: axial (columns, bearing walls),
 *     bending + shear (beams: load positions along the beam, simply supported between the extreme
 *     supports or cantilevered from the support nearest the centre), plate bending (slabs: one-way
 *     span between opposite supports, cantilever otherwise), connection shear, foundation bearing.
 *     For a SUDDEN change the increase of utilization is amplified by the material's dynamic factor
 *     Ω (capacity.ts). Members / connections at u ≥ OVERLOAD are returned as failures — the caller
 *     decides when to apply them (one redistribution round per fixed step in the simulation).
 *
 * At initialization (`init`) the result equals the Phase 17 analysis of the original world
 * (supported flags and loads; tested), so the engine starts from the state the editor showed.
 */
import { IndexHeap } from './heap';
import { MT_BEAM, MT_COLUMN, MT_FOUNDATION, MT_SLAB, MT_WALL, memberMaterial, type StructuralGraph } from './graph';
import { dynamicFactor, rotationCapacity } from './capacity';
import { OVERLOAD, type FailCause } from './types';

/** Ground support factor below which a ground-bearing member has lost its support. */
export const GROUND_LOST = 0.05;
/** Ultimate / allowable soil bearing pressure (factor of safety of allowable bearing design). */
export const BEARING_FS = 3;
/** Tier codes beyond the candidate tiers. */
export const TIER_SOIL = 3, TIER_GROUND = 4, TIER_NONE = -1;
/**
 * Columns / bearing walls whose vertical support below is itself carried by a transfer (it lost its
 * own continuous path to the ground) share their load between that member AND the beams / slab of
 * their own joint (tiers 0 + 1, equal shares) — the floors above a lost column pick up their own
 * load through the beams framing into the column line (frame / Vierendeel action, approximate),
 * instead of the whole column line resting on the lowest joint.
 */
export const TIER_MERGED = 5;

export interface Failure { i: number; cause: FailCause; u: number; trigger: number }
export interface EdgeFailure { e: number; u: number; trigger: number }
export interface RoundResult {
  /** Members that lost their load path in this pass (already out of the structure). */
  lost: { i: number; trigger: number }[];
  /** Members over capacity (still in the structure — the caller fails them). */
  failed: Failure[];
  /** Connections over capacity. */
  edges: EdgeFailure[];
  /** Members whose load or support changed. */
  changed: number[];
}

const SAMPLES = 16;
/** Deformation capacity of an end connection in shear (m) — slip / tear-out of bolted / welded seats (judgment). */
export const CONNECTION_SLIP = 0.01;
/** Settlement at bearing failure / footing width (punching shear failures develop at ≈ 5–25 % of B; Vesić 1973). */
export const BEARING_SETTLEMENT = 0.1;
/** Shortening strain of an axial member at crushing (≈ ε_cu of concrete). */
export const AXIAL_STRAIN = 0.002;

export class StructuralSolver {
  readonly g: StructuralGraph;
  readonly n: number;
  /** 1 = in the structure. */
  readonly alive: Uint8Array;
  readonly supported: Uint8Array;
  readonly tier: Int8Array;
  /** Continuous vertical path to the ground (columns / bearing walls standing on such members, foundations). */
  readonly vc: Uint8Array;
  /** Vertical load carried (N): own weight + surcharge + received. */
  readonly load: Float64Array;
  readonly load0: Float64Array;
  /** Static surcharge on a member (N): rubble resting on it, external loads. */
  readonly extra: Float64Array;
  readonly share: Float64Array;
  readonly edgeAlive: Uint8Array;
  /** Connections broken so far (summaries without a scan). */
  edgesFailed = 0;
  /** Ground support 0–1 of ground-bearing members (contact × explicit support factor). */
  readonly groundFactor: Float32Array;
  /** Residual capacity factor (damage) per member. */
  readonly capFactor: Float64Array;
  /** Utilizations (static, last evaluation): governing, axial, bending, shear; connections. */
  readonly util: Float32Array;
  readonly uN: Float32Array;
  readonly uM: Float32Array;
  readonly uV: Float32Array;
  readonly eUtil: Float32Array;
  /** Static bearing ratio (pressure / allowable) of the building in the original world (Phase 17). */
  bearing0 = 0;
  /** Member visited / failure order counters (diagnostics, cost). */
  visits = 0;
  private supHeap: IndexHeap;
  private loadHeap: IndexHeap;
  private origin: Int32Array;
  private originStamp: Int32Array;
  private stamp = 1;
  private touchedFlag: Uint8Array;
  private touched: number[] = [];
  private edgeTouched: number[] = [];
  private edgeOld: Float64Array;
  private edgeFlag: Uint8Array;

  constructor(g: StructuralGraph) {
    this.g = g;
    const n = (this.n = g.n), E = g.edges;
    this.alive = new Uint8Array(n);
    this.supported = new Uint8Array(n);
    this.tier = new Int8Array(n).fill(TIER_NONE);
    this.vc = new Uint8Array(n);
    this.load = new Float64Array(n);
    this.load0 = new Float64Array(n);
    this.extra = new Float64Array(n);
    this.share = new Float64Array(E);
    this.edgeAlive = new Uint8Array(E).fill(1);
    this.groundFactor = new Float32Array(n).fill(1);
    this.capFactor = new Float64Array(n).fill(1);
    this.util = new Float32Array(n);
    this.uN = new Float32Array(n);
    this.uM = new Float32Array(n);
    this.uV = new Float32Array(n);
    this.eUtil = new Float32Array(E);
    this.edgeOld = new Float64Array(E);
    this.edgeFlag = new Uint8Array(E);
    this.supHeap = new IndexHeap(n, g.rank, 1);
    this.loadHeap = new IndexHeap(n, g.rank, -1);
    this.origin = new Int32Array(n).fill(-1);
    this.originStamp = new Int32Array(n);
    this.touchedFlag = new Uint8Array(n);
  }

  /**
   * Full solution of the original world (Phase 17 semantics: unsupported members stay in the
   * structure but carry nothing). Returns the members that would fall at the start (no load path,
   * or over capacity by the Phase 17 gravity check) — the caller fails them.
   */
  init(): number[] {
    const g = this.g;
    for (let i = 0; i < this.n; i++) this.alive[i] = g.absent[i] ? 0 : 1;
    for (let r = 0; r < this.n; r++) {
      const i = g.byRank[r];
      if (this.alive[i]) this.evalSupport(i);
    }
    for (let r = this.n - 1; r >= 0; r--) {
      const i = g.byRank[r];
      if (this.alive[i]) this.distribute(i, this.collect(i));
    }
    this.load0.set(this.load);
    // The full solution is the reference state: nothing is queued.
    this.loadHeap.clear();
    this.supHeap.clear();
    for (const e of this.edgeTouched) this.edgeFlag[e] = 0;
    this.edgeTouched.length = 0;
    for (const i of this.touched) this.touchedFlag[i] = 0;
    this.touched.length = 0;
    this.stamp++;
    const pending: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      this.evaluate(i);
      if (!this.supported[i] || (g.structural[i] && g.analysis.members[i].utilization > 1)) pending.push(i);
    }
    for (let e = 0; e < g.edges; e++) if (this.edgeAlive[e]) this.eUtil[e] = this.edgeUtil(e);
    return pending;
  }

  // ── Changes ───────────────────────────────────────────────

  private mark(i: number, origin: number) {
    if (this.originStamp[i] !== this.stamp) {
      this.originStamp[i] = this.stamp;
      this.origin[i] = origin;
    }
  }

  /** Remove a member from the structure (failed / detached). */
  kill(i: number, origin = i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.supported[i] = 0;
    this.mark(i, origin);
    this.loadHeap.push(i);
    const g = this.g;
    for (let q = g.rStart[i]; q < g.rStart[i + 1]; q++) {
      const d = g.eFrom[g.rEdge[q]];
      if (!this.alive[d]) continue;
      this.mark(d, origin);
      this.supHeap.push(d);
    }
  }

  /** Break a connection. `origin`: member index the failure is attributed to (its dependent by default). */
  killEdge(e: number, origin = this.g.eFrom[e]) {
    if (!this.edgeAlive[e]) return;
    this.edgeAlive[e] = 0;
    this.edgesFailed++;
    const d = this.g.eFrom[e];
    if (!this.alive[d]) return;
    this.mark(d, origin);
    this.supHeap.push(d);
  }

  /** Ground support factor of a ground-bearing member (foundations, slab-on-grade, soil-bearing members). */
  setGround(i: number, f: number, origin = i) {
    const before = this.groundFactor[i];
    if (f === before) return;
    this.groundFactor[i] = f;
    if (!this.alive[i]) return;
    this.mark(i, origin);
    if ((before >= GROUND_LOST) !== (f >= GROUND_LOST)) this.supHeap.push(i);
    this.queueCheck(i);
  }

  /** Add a static surcharge (N, may be negative) on a member. */
  addExtra(i: number, dN: number, origin = i) {
    if (dN === 0) return;
    this.extra[i] = Math.max(0, this.extra[i] + dN);
    if (!this.alive[i]) return;
    this.mark(i, origin);
    this.loadHeap.push(i);
  }

  /** Residual capacity factor (0–1] of a member (damage from any hazard). */
  setCapFactor(i: number, f: number) {
    if (f === this.capFactor[i]) return;
    this.capFactor[i] = f;
    if (this.alive[i]) this.queueCheck(i);
  }

  private queueCheck(i: number) {
    this.touch(i);
  }

  get pending(): boolean {
    return this.supHeap.length > 0 || this.loadHeap.length > 0 || this.touched.length > 0;
  }

  // ── Propagation ───────────────────────────────────────────

  /**
   * Resolve the queued changes. `dynamic`: the change is sudden (member loss / impact) — load
   * increases are amplified by Ω in the checks; false for gradual changes (capacity loss).
   */
  propagate(dynamic = true): RoundResult {
    const g = this.g;
    const res: RoundResult = { lost: [], failed: [], edges: [], changed: [] };
    const touched = this.touched;
    // 1. Supports (bottom-up).
    while (this.supHeap.length) {
      const i = this.supHeap.pop();
      this.visits++;
      if (!this.alive[i]) continue;
      const vcBefore = this.vc[i];
      this.evalSupport(i);
      this.loadHeap.push(i);
      if (this.supported[i] && this.vc[i] !== vcBefore) {
        // Columns standing on it may switch to / from shared support.
        for (let q = g.rStart[i]; q < g.rStart[i + 1]; q++) {
          const d = g.eFrom[g.rEdge[q]];
          if (this.alive[d]) { this.mark(d, this.origin[i]); this.supHeap.push(d); }
        }
      }
      if (!this.supported[i]) {
        const o = this.origin[i];
        res.lost.push({ i, trigger: o });
        this.kill(i, o);
      } else this.touch(i); // support configuration may have changed (cantilever, fewer supports)
    }
    // 2. Loads (top-down).
    while (this.loadHeap.length) {
      const i = this.loadHeap.pop();
      this.visits++;
      const L = this.alive[i] ? this.collect(i) : 0;
      if (L !== this.load[i] || !this.alive[i]) this.touch(i);
      this.distribute(i, L);
    }
    // 3. Checks.
    for (const i of touched) {
      this.touchedFlag[i] = 0;
      res.changed.push(i);
      if (!this.alive[i]) continue;
      const uOld = this.util[i];
      this.evaluate(i);
      const u = this.util[i];
      const om = dynamic ? dynamicFactor(memberMaterial(g, i)) : 1;
      const uDyn = u + (om - 1) * Math.max(0, u - uOld);
      const soil = g.type[i] === MT_FOUNDATION || g.ground[i] === 1;
      const limit = soil ? 1 : OVERLOAD;
      if (uDyn >= limit && (g.structural[i] || soil)) {
        res.failed.push({ i, cause: this.governing(i), u: uDyn, trigger: this.originStamp[i] === this.stamp ? this.origin[i] : -1 });
      }
    }
    touched.length = 0;
    for (const e of this.edgeTouched) {
      this.edgeFlag[e] = 0;
      if (!this.edgeAlive[e] || !this.alive[g.eFrom[e]]) continue;
      const u = this.edgeUtil(e);
      const old = this.edgeOld[e];
      const cap = this.edgeCap(e);
      const om = dynamic ? dynamicFactor(memberMaterial(g, g.eFrom[e])) : 1;
      const uDyn = u + (om - 1) * Math.max(0, (this.share[e] - old) / cap);
      this.eUtil[e] = u;
      if (uDyn >= OVERLOAD) {
        const d = g.eFrom[e];
        res.edges.push({ e, u: uDyn, trigger: this.originStamp[d] === this.stamp ? this.origin[d] : -1 });
      }
    }
    this.edgeTouched.length = 0;
    this.stamp++;
    return res;
  }

  private touch(i: number) {
    if (this.touchedFlag[i]) return;
    this.touchedFlag[i] = 1;
    this.touched.push(i);
  }

  /** Pick the support tier and decide whether the member is supported (Phase 17 rules). */
  private evalSupport(i: number) {
    const g = this.g;
    if (g.ground[i]) {
      this.tier[i] = TIER_GROUND;
      this.supported[i] = this.groundFactor[i] >= GROUND_LOST ? 1 : 0;
      this.vc[i] = this.supported[i];
      return;
    }
    this.vc[i] = 0;
    const t = g.type[i];
    if (g.structural[i] && (t === MT_COLUMN || t === MT_WALL)) {
      // Vertical continuity: tier 0 with a continuous member below → tier 0 (Phase 17); tier-0
      // members below exist but none is continuous → shared with the joint's beams / slab.
      let any0 = false, cont = false, any1 = false;
      for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
        if (!this.edgeAlive[e] || !this.alive[g.eTo[e]]) continue;
        if (g.eTier[e] === 0) { any0 = true; if (this.vc[g.eTo[e]] && this.supported[g.eTo[e]]) cont = true; }
        else if (g.eTier[e] === 1) any1 = true;
      }
      if (any0 && !cont && any1) {
        this.tier[i] = TIER_MERGED;
        let ok = 0;
        for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) if (this.ok(e, TIER_MERGED)) { ok = 1; break; }
        this.supported[i] = ok;
        return;
      }
      if (any0 && cont) {
        this.tier[i] = 0;
        this.supported[i] = 1;
        this.vc[i] = 1;
        return;
      }
    }
    let chosen = TIER_NONE;
    for (let t = 0; t <= 2 && chosen < 0; t++) {
      for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
        if (g.eTier[e] === t && this.edgeAlive[e] && this.alive[g.eTo[e]]) { chosen = t; break; }
      }
    }
    if (chosen < 0) {
      const soil = g.soilFallback[i] && this.groundFactor[i] >= GROUND_LOST;
      this.tier[i] = soil ? TIER_SOIL : TIER_NONE;
      this.supported[i] = soil ? 1 : 0;
      this.vc[i] = soil ? 1 : 0;
      return;
    }
    this.tier[i] = chosen;
    let ok = 0;
    for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
      if (g.eTier[e] === chosen && this.edgeAlive[e] && this.alive[g.eTo[e]] && this.supported[g.eTo[e]]) { ok = 1; break; }
    }
    this.supported[i] = ok;
  }

  /** Own weight + surcharge + what the dependents pass on. */
  private collect(i: number): number {
    const g = this.g;
    let L = g.weight[i] + this.extra[i];
    for (let q = g.rStart[i]; q < g.rStart[i + 1]; q++) L += this.share[g.rEdge[q]];
    return L;
  }

  /** Split the load equally over the supported supports of the chosen tier. */
  private distribute(i: number, L: number) {
    const g = this.g;
    this.load[i] = L;
    const t = this.tier[i];
    let count = 0;
    const carry = this.alive[i] && this.supported[i] && ((t >= 0 && t <= 2) || t === TIER_MERGED);
    if (carry) for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) if (this.ok(e, t)) count++;
    const s = count > 0 ? L / count : 0;
    for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
      const v = carry && count > 0 && this.ok(e, t) ? s : 0;
      const old = this.share[e];
      if (v === old) continue;
      if (Math.abs(v - old) <= 1e-12 * Math.max(1, L)) { this.share[e] = v; continue; }
      if (!this.edgeFlag[e]) { this.edgeFlag[e] = 1; this.edgeOld[e] = old; this.edgeTouched.push(e); }
      this.share[e] = v;
      const j = g.eTo[e];
      if (this.alive[j]) {
        if (this.originStamp[i] === this.stamp) this.mark(j, this.origin[i]);
        this.loadHeap.push(j);
      }
    }
  }

  private ok(e: number, t: number) {
    const j = this.g.eTo[e];
    const et = this.g.eTier[e];
    return (et === t || (t === TIER_MERGED && et <= 1)) && this.edgeAlive[e] === 1 && this.alive[j] === 1 && this.supported[j] === 1;
  }

  // ── Reserve of a floor system (falling-block impacts, debris strikes) ─────────

  private frac: Float64Array | null = null;
  private probeHeap: IndexHeap | null = null;
  private fracList: number[] = [];

  /**
   * Additional static load (N) that `receivers` (weights: share of the load each takes, Σ = 1) can
   * take before the first member or connection on their load path reaches its limit (u = OVERLOAD;
   * foundations: ultimate bearing). A unit load is passed down with the current shares; the reserve
   * of a member is its load × (OVERLOAD / u − 1) (demand taken proportional to its load), of a
   * connection (OVERLOAD·cap − share). Returns the governing member / edge and its deformation
   * capacity. Non-structural members (cladding, partitions, openings, roof coverings) have no reserve.
   */
  reserve(receivers: readonly number[], weights: readonly number[]): { P: number; member: number; edge: number; deltaU: number } {
    const g = this.g;
    const frac = (this.frac ??= new Float64Array(this.n));
    const list = this.fracList;
    let P = Infinity, member = -1, edge = -1;
    const heap = (this.probeHeap ??= new IndexHeap(this.n, g.rank, -1));
    for (let k = 0; k < receivers.length; k++) {
      const r = receivers[k];
      if (!this.alive[r]) continue;
      if (frac[r] === 0) list.push(r);
      frac[r] += weights[k];
      heap.push(r);
    }
    while (heap.length) {
      const i = heap.pop();
      const f = frac[i];
      if (f <= 1e-9) continue;
      // Member reserve.
      let res = Infinity;
      if (g.type[i] === MT_FOUNDATION || g.ground[i]) {
        const u = this.bearingUtil(i);
        if (u > 0) res = this.load[i] * (1 / u - 1);
      } else if (g.structural[i] && this.util[i] > 0) res = this.load[i] * (OVERLOAD / this.util[i] - 1);
      // Cladding, partitions, openings and roof coverings carry nothing more than their own weight.
      else if (!g.structural[i] && !g.ground[i]) res = 0;
      if (res !== Infinity) {
        const p = Math.max(0, res) / f;
        if (p < P) { P = p; member = i; edge = -1; }
      }
      const t = this.tier[i];
      if (!(this.supported[i] && ((t >= 0 && t <= 2) || t === TIER_MERGED))) continue;
      let count = 0;
      for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) if (this.ok(e, t)) count++;
      if (!count) continue;
      const fe = f / count;
      for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
        if (!this.ok(e, t)) continue;
        const cap = this.edgeCap(e);
        if (cap !== Infinity) {
          const p = Math.max(0, OVERLOAD * cap - this.share[e]) / fe;
          if (p < P) { P = p; edge = e; member = -1; }
        }
        const j = g.eTo[e];
        if (frac[j] === 0) list.push(j);
        frac[j] += fe;
        heap.push(j);
      }
    }
    for (const i of list) frac[i] = 0;
    list.length = 0;
    return { P, member, edge, deltaU: this.deformationCapacity(member, edge) };
  }

  /** Deformation capacity (m) of the governing member / connection (see capacity.ts). */
  deformationCapacity(member: number, edge: number): number {
    const g = this.g;
    if (edge >= 0) return CONNECTION_SLIP;
    if (member < 0) return 0;
    const b = 6 * member, t = g.type[member];
    const th = rotationCapacity(memberMaterial(g, member));
    if (t === MT_BEAM) return (th * g.length[member]) / 2;
    if (t === MT_SLAB) return (th * Math.min(g.box[b + 3] - g.box[b], g.box[b + 5] - g.box[b + 2])) / 2;
    if (t === MT_FOUNDATION) return BEARING_SETTLEMENT * Math.min(g.box[b + 3] - g.box[b], g.box[b + 5] - g.box[b + 2]);
    return AXIAL_STRAIN * (g.box[b + 4] - g.box[b + 1]);
  }

  // ── Demand / capacity ───────────────────────────────────────

  private edgeCap(e: number): number {
    const g = this.g;
    return g.eCap[e] * Math.min(this.capFactor[g.eFrom[e]], this.capFactor[g.eTo[e]]);
  }

  private edgeUtil(e: number): number {
    const cap = this.edgeCap(e);
    return cap === Infinity ? 0 : this.share[e] / Math.max(1, cap);
  }

  private governing(i: number): FailCause {
    const g = this.g;
    if (g.type[i] === MT_FOUNDATION || g.ground[i]) return 'bearing';
    const n = this.uN[i], m = this.uM[i], v = this.uV[i];
    return n >= m && n >= v ? 'axial' : m >= v ? 'bending' : 'shear';
  }

  /** Static utilization components of a member under its current load and supports. */
  evaluate(i: number) {
    const g = this.g;
    const cf = Math.max(1e-3, this.capFactor[i]);
    let n = 0, m = 0, v = 0;
    const t = g.type[i];
    if (g.structural[i] && this.alive[i]) {
      if ((t === MT_COLUMN || t === MT_WALL) && g.capN[i] > 0) n = this.load[i] / (g.capN[i] * cf);
      else if (t === MT_BEAM) { this.beamDemand(i); m = this.dM / (g.capM[i] * cf); v = this.dV / (g.capV[i] * cf); }
      else if (t === MT_SLAB && g.capM[i] > 0) m = this.slabMoment(i) / (g.capM[i] * cf);
    }
    // Footings and ground slabs: bearing pressure on the soil.
    if ((t === MT_FOUNDATION || g.ground[i]) && this.alive[i]) n = this.bearingUtil(i);
    this.uN[i] = n; this.uM[i] = m; this.uV[i] = v;
    this.util[i] = Math.max(n, m, v);
  }

  /**
   * Bearing pressure / ULTIMATE bearing pressure under a foundation member: the building-level static
   * ratio of the original world (pressure / allowable, Phase 17 — the foundations are taken as sized
   * for it), scaled by the member's load change and its remaining ground support, over the factor of
   * safety of allowable-pressure design (q_ult = 3·q_a).
   */
  bearingUtil(i: number): number {
    if (this.bearing0 <= 0 || this.load0[i] <= 0) return 0;
    const f = Math.max(1e-3, this.groundFactor[i]) * this.capFactor[i];
    return (this.bearing0 * (this.load[i] / this.load0[i])) / f / BEARING_FS;
  }

  private dM = 0;
  private dV = 0;
  private lp: Float64Array = new Float64Array(64);

  /**
   * Beam bending / shear: own weight as a uniform load over the length, each dependent's share as a
   * uniform load over its footprint along the beam (a column standing on it: almost a point load);
   * supports at their centres. Two-sided (supports beyond ±L/4 on both sides): simply supported
   * between the extreme supports (overhangs included) — intermediate supports are ignored
   * (conservative). One-sided: cantilever from the support closest to the centre.
   */
  private beamDemand(i: number) {
    const g = this.g;
    const L = g.length[i], h = L / 2;
    // Loads as [a, b, P] triples.
    let nl = 0;
    const push = (a: number, b: number, P: number) => {
      if (P <= 0) return;
      if (nl * 3 + 3 > this.lp.length) { const x = new Float64Array(this.lp.length * 2); x.set(this.lp); this.lp = x; }
      if (b - a < 0.05) { const c = (a + b) / 2; a = c - 0.025; b = c + 0.025; }
      this.lp[nl * 3] = a; this.lp[nl * 3 + 1] = b; this.lp[nl * 3 + 2] = P; nl++;
    };
    push(-h, h, g.weight[i] + this.extra[i]);
    for (let q = g.rStart[i]; q < g.rStart[i + 1]; q++) {
      const e = g.rEdge[q];
      if (this.share[e] > 0) push(g.eA0[e], g.eA1[e], this.share[e]);
    }
    let tmin = Infinity, tmax = -Infinity, tc = Infinity, tcAbs = Infinity;
    const t = this.tier[i];
    for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
      if (!this.ok(e, t)) continue;
      const p = Math.max(-h, Math.min(h, g.ePos[e]));
      tmin = Math.min(tmin, p);
      tmax = Math.max(tmax, p);
      if (Math.abs(p) < tcAbs) { tcAbs = Math.abs(p); tc = p; }
    }
    if (!Number.isFinite(tmin)) { this.dM = 0; this.dV = 0; return; }
    const lp = this.lp;
    if (tmin < -L / 4 && tmax > L / 4) {
      let P = 0, Mo = 0;
      for (let k = 0; k < nl; k++) { const a = lp[3 * k], b = lp[3 * k + 1], F = lp[3 * k + 2]; P += F; Mo += F * ((a + b) / 2 - tmin); }
      const RR = Mo / (tmax - tmin), RL = P - RR;
      const momentAt = (x: number) => {
        let M = 0;
        if (x > tmin) M += RL * (x - tmin);
        if (x > tmax) M += RR * (x - tmax);
        for (let k = 0; k < nl; k++) {
          const a = lp[3 * k], b = lp[3 * k + 1];
          if (x <= a) continue;
          const l = Math.min(x, b) - a;
          M -= (lp[3 * k + 2] / (b - a)) * l * (x - (a + l / 2));
        }
        return Math.abs(M);
      };
      let M = 0;
      for (let s = 0; s <= SAMPLES; s++) M = Math.max(M, momentAt(-h + (L * s) / SAMPLES));
      M = Math.max(M, momentAt(tmin), momentAt(tmax));
      for (let k = 0; k < nl; k++) M = Math.max(M, momentAt(lp[3 * k]), momentAt(lp[3 * k + 1]), momentAt((lp[3 * k] + lp[3 * k + 1]) / 2));
      this.dM = M;
      this.dV = Math.max(Math.abs(RL), Math.abs(RR));
      return;
    }
    // Cantilever about tc.
    let ML = 0, MR = 0, FL = 0, FR = 0;
    for (let k = 0; k < nl; k++) {
      const a = lp[3 * k], b = lp[3 * k + 1], q = lp[3 * k + 2] / (b - a);
      if (a < tc) { const e = Math.min(b, tc); const F = q * (e - a); FL += F; ML += F * (tc - (a + e) / 2); }
      if (b > tc) { const s0 = Math.max(a, tc); const F = q * (b - s0); FR += F; MR += F * ((s0 + b) / 2 - tc); }
    }
    this.dM = Math.max(ML, MR);
    this.dV = Math.max(FL, FR);
  }

  /** Slab plate moment per metre (N·m/m). */
  private slabMoment(i: number): number {
    const g = this.g, b = 6 * i;
    const ex = g.box[b + 3] - g.box[b], ez = g.box[b + 5] - g.box[b + 2];
    const w = this.load[i] / Math.max(0.01, ex * ez);
    let nx = false, px = false, nz = false, pz = false, sx = 0, sz = 0, c = 0;
    const t = this.tier[i];
    for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
      if (!this.ok(e, t)) continue;
      const dx = g.eDX[e], dz = g.eDZ[e];
      if (dx < -ex / 4) nx = true;
      if (dx > ex / 4) px = true;
      if (dz < -ez / 4) nz = true;
      if (dz > ez / 4) pz = true;
      sx += dx; sz += dz; c++;
    }
    if (!c) return 0;
    let span = Infinity;
    if (nx && px) span = Math.min(span, ex);
    if (nz && pz) span = Math.min(span, ez);
    // Phase 17: one-way plate across the shorter span when held on opposite sides.
    if (span < Infinity) return (w * span * span) / 8;
    const lc = Math.min(ex / 2 + Math.abs(sx / c), ez / 2 + Math.abs(sz / c));
    return (w * lc * lc) / 2;
  }
}

export { MT_SLAB };
