/**
 * Collapse model of one building (Phase 25): member states, redistribution rounds and the time
 * evolution of what falls — pure (no physics engine, no rendering). The simulation adapter feeds
 * external failures in (drift, overpressure, foundation …) and reads events out (records, fragments
 * leaving the building, rubble piles).
 *
 * Per fixed step (`step`):
 *  1. one redistribution round of the solver (members that lost their load path, members /
 *     connections over capacity under the redistributed load — dynamic increase for sudden losses);
 *  2. members that left the structure this step form FALLING BLOCKS (connected components of the
 *     support graph), with the horizontal velocity of the structure where they were (no momentum is
 *     added); members whose ballistic landing point lies outside the building's plan leave as
 *     FRAGMENTS (the adapter turns them into rigid bodies);
 *  3. blocks fall freely (exact constant-gravity kinematics) until the first contact with what is
 *     under them — standing members, rubble resting on a floor, or the ground; the struck floor
 *     system arrests the block or fails (falling.ts: momentum-conserving collision + rigid-plastic
 *     energy absorption with the floor's computed reserve capacity); a failed floor joins the block,
 *     which continues with its residual speed (progressive "pancake" collapse that can stop);
 *     arrested blocks REST on the floor (their weight becomes its static load, which can still fail
 *     it later); blocks reaching the ground SETTLE into a rubble pile (rubble.ts).
 *
 * Member failures are recorded with their immediate cause, the member whose loss triggered them,
 * the root of the chain and its hazard (the primary hazard) — the collapse sequence.
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { MT_FOUNDATION, MT_SLAB, MT_WALL, MT_COLUMN, MT_WINDOW, memberMaterial, membersInRect, type StructuralGraph } from './graph';
import { StructuralSolver, type RoundResult } from './solver';
import { impactOutcome, fallTime, type ImpactOutcome } from './falling';
import { MassLedger } from './ledger';
import { bulkVolume, settlePile, type RubblePile } from './rubble';
import { canTransition, DAMAGED_AT, MS, SEVERE_AT, FAIL_CAUSES, type FailCause } from './types';
import { STRENGTH_LOSS } from './policy';

export interface CollapseRecord {
  seq: number;
  i: number;
  time: number;
  /** Redistribution round of the building (0 = applied from outside). */
  round: number;
  cause: FailCause;
  /** Primary hazard of the chain (the root failure's hazard). */
  hazard: string;
  /** Member whose loss / failure triggered this one (−1 = applied from outside). */
  trigger: number;
  root: number;
  depth: number;
  /** Utilization / ratio at failure (dynamic utilization, drift / capacity, impact damage …). */
  u: number;
  /** Set by the adapter for strikes by debris from elsewhere. */
  secondary?: { striker: string; source: string; sourceMember?: string };
}

export type CollapseEvent =
  | { kind: 'fail'; rec: CollapseRecord }
  | { kind: 'connection'; e: number; time: number; u: number; trigger: number; hazard: string }
  | { kind: 'redistribution'; time: number; round: number; changed: number; failed: number; hazard: string }
  | { kind: 'block'; group: number; time: number; members: number; mass: number; root: number; hazard: string }
  | { kind: 'impact'; group: number; time: number; arrested: boolean; receivers: number[]; outcome: ImpactOutcome; mass: number; hazard: string; governing: number }
  | { kind: 'ground'; group: number; time: number; mass: number; energy: number; pile: number; members: number[]; hazard: string }
  | { kind: 'exit'; i: number; time: number; velocity: Vec3; hazard: string; root: number; impulse: boolean }
  | { kind: 'resume'; group: number; time: number; members: number }
  | { kind: 'crush'; i: number; time: number; hazard: string };

export interface FallingBlock {
  id: number;
  members: number[];
  /** Fall distance D of the block when each member joined. */
  join: number[];
  mass: number;
  /** Fall distance (m, down positive) and speed (m/s, down positive). */
  D: number;
  v: number;
  vx: number;
  vz: number;
  Dx: number;
  Dz: number;
  active: boolean;
  hazard: string;
  root: number;
  t0: number;
  /** Cached landing surfaces per member (top y, surface member or −1 = ground) and the structure revision they were computed at. */
  surf: Float64Array;
  surfM: Int32Array;
  surfRev: number;
  /** Non-structural standing members under the block, highest top first, and how many were swept. */
  sweep: number[];
  sweepAt: number[];
  swept: number;
  /** Indices (into members) of the bottom layer — the only members that can touch first. */
  bottomK: number[];
  /** Plan bounds of the block and the highest bottom of its bottom layer (relevance of changes). */
  bx0: number; bz0: number; bx1: number; bz1: number; byMax: number;
  /** Position in the structural change log already accounted for. */
  seen: number;
  kOf?: Map<number, number>;
  bottomSet?: Set<number>;
}

/** Horizontal velocity of the standing structure at a member (building-local frame, m/s). */
export type Kinematics = (i: number, out: Vec3) => void;

/** Members of the building's plan bounds (local) for fragment exits. */
const EXIT_MARGIN = 0.3;
/** Members whose gaps are within this of the first contact land together (m). */
const CONTACT_TOL = 0.05;

export class CollapseModel {
  readonly g: StructuralGraph;
  readonly s: StructuralSolver;
  readonly n: number;
  readonly state: Uint8Array;
  readonly damage: Float64Array;
  readonly failTime: Float32Array;
  readonly failCause: Int8Array;
  readonly trigger: Int32Array;
  readonly root: Int32Array;
  readonly depth: Int16Array;
  readonly hazardOf: Int8Array;
  /** Hazard of the last outside change applied to a member (ground loss, damage, load) — for failures it starts. */
  readonly causeHazard: Int8Array;
  /** Displacement of fallen members from their original place (local, m). */
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  readonly dz: Float32Array;
  /** Vertical scale of fallen members (crushed / compacted into rubble; 1 = intact shape). */
  readonly sy: Float32Array;
  readonly restOn: Int32Array;
  /** 1 = handed to the physics engine / aggregated by the adapter (not drawn by the member layer). */
  readonly external: Uint8Array;
  readonly blockOf: Int32Array;
  readonly blocks: FallingBlock[] = [];
  readonly records: CollapseRecord[] = [];
  events: CollapseEvent[] = [];
  readonly piles: RubblePile[] = [];
  readonly ledger: MassLedger;
  readonly hazards: string[] = [];
  /** Plan bounds of the building (local). */
  readonly bounds: { x0: number; z0: number; x1: number; z1: number };
  round = 0;
  seq = 0;
  /** Bumped on member state / position changes (renderers). */
  rev = 0;
  /** Bumped when what blocks can land on changes (standing / resting / settled members). */
  structRev = 0;
  /** Members whose state / resting position changed, in order (landing-cache relevance). */
  private changeLog: number[] = [];
  /** Superstructure mass of the original world (kg). */
  readonly superMass: number;
  /** Members leaving the structure this step (with their hazard index and optional velocity / impulse flag). */
  private dead: { i: number; vel?: Vec3; impulse?: boolean; crush?: boolean }[] = [];
  private dynamicNext = false;
  private resting = new Map<number, number[]>();
  private tmp: number[] = [];
  private tmp2: number[] = [];
  private refreshK = new Set<number>();
  private kin: Vec3 = [0, 0, 0];

  constructor(g: StructuralGraph, damage?: Float64Array) {
    this.g = g;
    this.n = g.n;
    this.s = new StructuralSolver(g);
    const n = this.n;
    this.state = new Uint8Array(n);
    this.damage = damage ?? new Float64Array(n);
    this.failTime = new Float32Array(n).fill(NaN);
    this.failCause = new Int8Array(n).fill(-1);
    this.trigger = new Int32Array(n).fill(-1);
    this.root = new Int32Array(n).fill(-1);
    this.depth = new Int16Array(n);
    this.hazardOf = new Int8Array(n).fill(-1);
    this.causeHazard = new Int8Array(n).fill(-1);
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.dz = new Float32Array(n);
    this.sy = new Float32Array(n).fill(1);
    this.restOn = new Int32Array(n).fill(-1);
    this.external = new Uint8Array(n);
    this.blockOf = new Int32Array(n).fill(-1);
    let total = 0, sup = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (g.absent[i]) { this.state[i] = MS.ABSENT; continue; }
      total += g.mass[i];
      if (g.level[i] >= 0) sup += g.mass[i];
      const b = 6 * i;
      x0 = Math.min(x0, g.box[b]); z0 = Math.min(z0, g.box[b + 2]); x1 = Math.max(x1, g.box[b + 3]); z1 = Math.max(z1, g.box[b + 5]);
    }
    this.superMass = sup;
    this.ledger = new MassLedger(total);
    this.bounds = Number.isFinite(x0) ? { x0, z0, x1, z1 } : { x0: 0, z0: 0, x1: 0, z1: 0 };
  }

  /**
   * Solve the original world; returns the members that would fall at once (no load path / over
   * capacity in the original world — Phase 17 rule). `bearing0`: static bearing ratio of the building.
   */
  init(bearing0 = 0): number[] {
    this.s.bearing0 = bearing0;
    const pending = this.s.init();
    for (let i = 0; i < this.n; i++) if (this.state[i] !== MS.ABSENT) this.applyDamageState(i);
    return pending;
  }

  /** Hazard index (registry). */
  hz(h: string): number {
    let k = this.hazards.indexOf(h);
    if (k < 0) { k = this.hazards.length; this.hazards.push(h); }
    return k;
  }

  hazardName(i: number): string {
    return this.hazardOf[i] >= 0 ? this.hazards[this.hazardOf[i]] : '';
  }

  /**
   * Vertical members that fail in their own capacity (drift, crushing / buckling, story mechanism)
   * are crushed where they stand — they do not fall as a rigid spacer under the block they carried.
   */
  private crushes(i: number, cause: FailCause): boolean {
    const t = this.g.type[i];
    return (t === MT_COLUMN || t === MT_WALL) && (cause === 'drift' || cause === 'axial' || cause === 'story');
  }

  private fallbackHazard(i: number): number {
    return this.causeHazard[i] >= 0 ? this.causeHazard[i] : this.hz('');
  }

  /** Still in the structure. */
  alive(i: number): boolean {
    return this.state[i] <= MS.SEVERE;
  }

  get active(): boolean {
    return this.s.pending || this.dead.length > 0 || this.blocks.some((b) => b.active);
  }

  private set(i: number, to: number) {
    const from = this.state[i];
    if (from === to) return;
    if (!canTransition(from, to)) throw new Error(`member ${i}: illegal state transition ${from} → ${to}`);
    this.state[i] = to;
    this.rev++;
    this.structRev++;
    this.changeLog.push(i);
  }

  /** INTACT / DAMAGED / SEVERE from the damage index; residual gravity capacity 1 − 0.3·D (Phase 15 law). */
  private applyDamageState(i: number) {
    const d = this.damage[i];
    const st = this.state[i];
    if (st > MS.SEVERE) return;
    const want = d >= SEVERE_AT ? MS.SEVERE : d >= DAMAGED_AT ? MS.DAMAGED : MS.INTACT;
    if (want > st) this.set(i, want);
    this.s.setCapFactor(i, 1 - STRENGTH_LOSS * Math.min(1, d));
  }

  /** Raise a member's damage index (any hazard); gravity capacity follows. Returns true when it changed. */
  setDamage(i: number, d: number, hazard?: string): boolean {
    if (!this.alive(i) || d <= this.damage[i]) return false;
    if (hazard) this.causeHazard[i] = this.hz(hazard);
    this.damage[i] = Math.min(1, d);
    this.applyDamageState(i);
    return true;
  }

  private record(i: number, time: number, cause: FailCause, hazard: number, trigger: number, u: number): CollapseRecord {
    this.failTime[i] = time;
    this.failCause[i] = FAIL_CAUSES.indexOf(cause);
    this.trigger[i] = trigger;
    const r = trigger >= 0 && this.root[trigger] >= 0 ? this.root[trigger] : i;
    this.root[i] = r;
    this.depth[i] = trigger >= 0 ? this.depth[trigger] + 1 : 0;
    const h = trigger >= 0 && this.hazardOf[r] >= 0 ? this.hazardOf[r] : hazard;
    this.hazardOf[i] = h;
    const rec: CollapseRecord = { seq: this.seq++, i, time, round: trigger >= 0 ? this.round : 0, cause, hazard: this.hazards[h] ?? '', trigger, root: r, depth: this.depth[i], u };
    this.records.push(rec);
    this.events.push({ kind: 'fail', rec });
    return rec;
  }

  /**
   * Members failed by an outside model (drift capacity, wall out of plane, foundation, story
   * mechanism …). They leave the structure now and fall from the next step on.
   */
  fail(list: readonly number[], cause: FailCause, hazard: string, time: number, opts: { u?: number; trigger?: number; velocity?: (i: number) => Vec3 | undefined; impulse?: boolean } = {}): CollapseRecord[] {
    const h = this.hz(hazard);
    const out: CollapseRecord[] = [];
    for (const i of list) {
      if (!this.alive(i)) continue;
      out.push(this.record(i, time, cause, h, opts.trigger ?? -1, opts.u ?? 1));
      this.set(i, MS.FAILED);
      this.set(i, MS.DETACHED);
      this.damage[i] = 1;
      this.s.kill(i, i);
      this.dead.push({ i, vel: opts.velocity?.(i), impulse: opts.impulse, crush: this.crushes(i, cause) && !opts.impulse });
      this.dynamicNext = true;
    }
    return out;
  }

  /**
   * A facade part (cladding panel, window, door, roof covering) detached by its own hazard model:
   * it leaves as a fragment right away (the adapter already spawned it / its particles).
   */
  detachFacade(i: number, hazard: string, time: number, u = 1): CollapseRecord | null {
    if (!this.alive(i)) return null;
    const rec = this.record(i, time, 'facade', this.hz(hazard), -1, u);
    this.set(i, MS.FAILED);
    this.set(i, MS.DETACHED);
    this.set(i, MS.FALLING);
    this.damage[i] = 1;
    this.external[i] = 1;
    this.ledger.move('structure', this.g.type[i] === MT_WINDOW ? 'fines' : 'bodies', this.g.mass[i]);
    // Glass leaves as visual shards: nothing left to simulate (its mass is booked as fines).
    if (this.g.type[i] === MT_WINDOW) this.set(i, MS.SETTLED);
    this.s.kill(i, i);
    this.dynamicNext = true;
    return rec;
  }

  /** A fragment handed to the physics engine came to rest (fixed body / aggregated). */
  settleExternal(i: number) {
    if (this.state[i] === MS.FALLING && this.external[i]) this.set(i, MS.SETTLED);
  }

  /** Sidesway collapse of a story (lumped story model): its vertical members fail. */
  failStory(level: number, cause: FailCause, hazard: string, time: number, u = 1, velocity?: (i: number) => Vec3 | undefined): CollapseRecord[] {
    const list: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const t = this.g.type[i];
      if (this.g.level[i] === level && this.g.structural[i] && (t === MT_COLUMN || t === MT_WALL) && this.alive(i)) list.push(i);
    }
    return this.fail(list, cause, hazard, time, { u, velocity });
  }

  /** Ground support of a ground-bearing member changed (0 = lost). */
  setGround(i: number, f: number, hazard?: string) {
    if (hazard) this.causeHazard[i] = this.hz(hazard);
    this.s.setGround(i, f);
    if (f < this.s.groundFactor[i]) this.dynamicNext = true;
  }

  /** Static surcharge (e.g. rubble resting on a member) — not dynamic. */
  addLoad(i: number, N: number, hazard?: string) {
    if (hazard) this.causeHazard[i] = this.hz(hazard);
    this.s.addExtra(i, N);
  }

  // ── Time evolution ─────────────────────────────────────────

  /** One fixed step. `kin`: horizontal velocity of the standing structure at a member (local). */
  step(dt: number, time: number, kin?: Kinematics, g = GRAVITY) {
    if (this.s.pending) this.redistribute(time);
    if (this.dead.length) this.formBlocks(time, kin, g);
    for (const b of this.blocks) if (b.active) this.advance(b, dt, time, g);
  }

  private redistribute(time: number) {
    this.round++;
    const r: RoundResult = this.s.propagate(this.dynamicNext);
    this.dynamicNext = true;
    let failed = 0;
    for (const l of r.lost) {
      if (!this.alive(l.i)) continue;
      const trig = l.trigger >= 0 && l.trigger !== l.i ? l.trigger : -1;
      this.record(l.i, time, this.g.type[l.i] === MT_FOUNDATION || this.g.ground[l.i] ? 'foundation' : 'support', this.fallbackHazard(l.i), trig, 0);
      this.set(l.i, MS.FAILED);
      this.set(l.i, MS.DETACHED);
      this.damage[l.i] = 1;
      this.dead.push({ i: l.i });
      failed++;
    }
    for (const f of r.failed) {
      if (!this.alive(f.i)) continue;
      const trig = f.trigger >= 0 && f.trigger !== f.i ? f.trigger : -1;
      this.record(f.i, time, f.cause, this.fallbackHazard(f.i), trig, f.u);
      this.set(f.i, MS.FAILED);
      this.set(f.i, MS.DETACHED);
      this.damage[f.i] = 1;
      this.s.kill(f.i, f.i);
      this.dead.push({ i: f.i, crush: this.crushes(f.i, f.cause) });
      failed++;
    }
    for (const e of r.edges) {
      const d = this.g.eFrom[e.e];
      const trig = e.trigger >= 0 ? e.trigger : d;
      const root = this.root[trig] >= 0 ? this.root[trig] : trig;
      this.events.push({ kind: 'connection', e: e.e, time, u: e.u, trigger: trig, hazard: this.hazardOf[root] >= 0 ? this.hazards[this.hazardOf[root]] : '' });
      this.s.killEdge(e.e, trig);
    }
    if (failed || r.edges.length) {
      // Hazard of the round: the most recent chain root involved.
      let h = '';
      for (let k = this.records.length - 1; k >= 0 && k >= this.records.length - failed; k--) if (this.records[k].hazard) { h = this.records[k].hazard; break; }
      this.events.push({ kind: 'redistribution', time, round: this.round, changed: r.changed.length, failed, hazard: h });
    }
    // Members resting on members that just failed fall again.
    for (const d of this.dead) this.resumeResting(d.i);
  }

  private resumeResting(i: number) {
    const list = this.resting.get(i);
    if (!list) return;
    this.resting.delete(i);
    for (const m of list) {
      if (this.state[m] !== MS.RESTING) continue;
      this.s.addExtra(i, -this.g.weight[m]);
      this.restOn[m] = -1;
      this.dead.push({ i: m });
      this.resumeResting(m);
    }
  }

  /** Members that left the structure this step → falling blocks / fragments. */
  private formBlocks(time: number, kin: Kinematics | undefined, g: number) {
    const dead = this.dead;
    this.dead = [];
    const G = this.g;
    // Union-find over support edges among the members leaving together.
    const idx = new Map<number, number>();
    dead.forEach((d, k) => idx.set(d.i, k));
    const parent = dead.map((_, k) => k);
    const find = (k: number): number => { while (parent[k] !== k) k = parent[k] = parent[parent[k]]; return k; };
    for (const d of dead) {
      for (let e = G.eStart[d.i]; e < G.eStart[d.i + 1]; e++) {
        const o = idx.get(G.eTo[e]);
        if (o !== undefined) parent[find(idx.get(d.i)!)] = find(o);
      }
      if (this.restOn[d.i] >= 0) { const o = idx.get(this.restOn[d.i]); if (o !== undefined) parent[find(idx.get(d.i)!)] = find(o); }
    }
    const comps = new Map<number, number[]>();
    dead.forEach((_, k) => { const r = find(k); (comps.get(r) ?? comps.set(r, []).get(r)!).push(k); });
    const B = this.bounds;
    for (const ks of comps.values()) {
      const members: number[] = [];
      let mass = 0, px = 0, pz = 0, root = -1, h = -1;
      for (const k of ks) {
        const d = dead[k];
        const i = d.i;
        if (d.crush) { this.crushInPlace(i, time); continue; }
        const v = d.vel ?? (kin ? (kin(i, this.kin), this.kin) : null);
        const vx = v ? v[0] : 0, vz = v ? v[2] : 0;
        // Ballistic landing estimate (fall to the ground floor level, 0): outside the plan → fragment.
        const b = 6 * i;
        const bottom = G.box[b + 1] + this.dy[i];
        const tf = Math.sqrt((2 * Math.max(0, bottom)) / g);
        const cx = (G.box[b] + G.box[b + 3]) / 2 + this.dx[i] + vx * tf, cz = (G.box[b + 2] + G.box[b + 5]) / 2 + this.dz[i] + vz * tf;
        const from = this.state[i] === MS.RESTING ? 'resting' : 'structure';
        if (cx < B.x0 - EXIT_MARGIN || cx > B.x1 + EXIT_MARGIN || cz < B.z0 - EXIT_MARGIN || cz > B.z1 + EXIT_MARGIN || (d.vel && d.impulse)) {
          if (this.state[i] === MS.RESTING) this.set(i, MS.FALLING);
          else this.set(i, MS.FALLING);
          this.external[i] = 1;
          this.ledger.move(from, G.type[i] === MT_WINDOW ? 'fines' : 'bodies', G.mass[i]);
          if (d.vel) {
            const p = G.mass[i] * Math.hypot(vx, vz);
            if (d.impulse) this.ledger.momentum.impulse += p; else this.ledger.momentum.inherited += p;
          } else this.ledger.momentum.inherited += G.mass[i] * Math.hypot(vx, vz);
          if (G.type[i] === MT_WINDOW) { this.set(i, MS.SETTLED); continue; }
          this.events.push({ kind: 'exit', i, time, velocity: [vx, 0, vz], hazard: this.hazardName(i), root: this.root[i], impulse: !!d.impulse });
          continue;
        }
        if (this.state[i] === MS.RESTING) { this.set(i, MS.FALLING); this.ledger.move('resting', 'falling', G.mass[i]); }
        else { this.set(i, MS.FALLING); this.ledger.move('structure', 'falling', G.mass[i]); }
        members.push(i);
        mass += G.mass[i];
        px += G.mass[i] * vx;
        pz += G.mass[i] * vz;
        if (root < 0) { root = this.root[i]; h = this.hazardOf[i]; }
      }
      if (!members.length) continue;
      this.ledger.momentum.inherited += Math.hypot(px, pz);
      const blk: FallingBlock = {
        id: this.blocks.length, members, join: members.map(() => 0), mass, D: 0, v: 0, vx: mass > 0 ? px / mass : 0, vz: mass > 0 ? pz / mass : 0, Dx: 0, Dz: 0,
        active: true, hazard: h >= 0 ? this.hazards[h] : '', root, t0: time, surf: new Float64Array(0), surfM: new Int32Array(0), surfRev: -1, sweep: [], sweepAt: [], swept: 0, bottomK: [], bx0: 0, bz0: 0, bx1: 0, bz1: 0, byMax: 0, seen: 0,
      };
      this.layer(blk);
      this.sweepList(blk);
      // Members that had already moved (rubble resting on a floor) keep their offsets.
      for (let k = 0; k < members.length; k++) blk.join[k] = 0;
      for (const i of members) this.blockOf[i] = blk.id;
      this.blocks.push(blk);
      this.events.push({ kind: 'block', group: blk.id, time, members: members.length, mass, root, hazard: blk.hazard });
    }
  }

  /** Centre / bottom / top of member i now (local y; fallen members are displaced and compacted). */
  private centre(i: number) {
    const o = 6 * i;
    return (this.g.box[o + 1] + this.g.box[o + 4]) / 2 + this.dy[i];
  }

  private bottom(i: number) {
    const o = 6 * i;
    return this.centre(i) - ((this.g.box[o + 4] - this.g.box[o + 1]) / 2) * this.sy[i];
  }

  private top(i: number) {
    const o = 6 * i;
    return this.centre(i) + ((this.g.box[o + 4] - this.g.box[o + 1]) / 2) * this.sy[i];
  }

  /** Highest surface under member i (standing member, resting / settled rubble; −1 = the ground floor level 0). */
  private surfaceUnder(i: number, block: number): { top: number; member: number } {
    const G = this.g;
    const o = 6 * i;
    const x0 = G.box[o] + this.dx[i] + 0.05, x1 = G.box[o + 3] + this.dx[i] - 0.05;
    const z0 = G.box[o + 2] + this.dz[i] + 0.05, z1 = G.box[o + 5] + this.dz[i] - 0.05;
    const yb = this.bottom(i);
    let best = 0, bm = -1;
    membersInRect(G, Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), this.tmp);
    for (const j of this.tmp) {
      if (j === i || (block >= 0 && this.blockOf[j] === block)) continue;
      const st = this.state[j];
      const standing = st <= MS.SEVERE;
      if (!standing && st !== MS.RESTING && st !== MS.SETTLED) continue;
      if (this.external[j]) continue;
      // Cladding, partitions and openings are crushed by a falling block (swept), never a landing surface.
      if (block >= 0 && standing && !G.structural[j] && !G.ground[j] && G.type[j] !== MT_SLAB) continue;
      const jo = 6 * j;
      if (!standing && (G.box[jo] + this.dx[j] > x1 || G.box[jo + 3] + this.dx[j] < x0 || G.box[jo + 2] + this.dz[j] > z1 || G.box[jo + 5] + this.dz[j] < z0)) continue;
      const t = this.top(j);
      if (t <= yb + 0.02 && t > best) { best = t; bm = j; }
    }
    return { top: best, member: bm };
  }

  /**
   * A vertical member crushed where it stood: it becomes a rubble layer at its base (vertically
   * compacted to its plan thickness) resting on what is under it — a load on that floor — or on the
   * ground (rubble pile).
   */
  private crushInPlace(i: number, time: number) {
    const G = this.g;
    const o = 6 * i;
    const h = G.box[o + 4] - G.box[o + 1];
    const t = Math.min(h, Math.max(0.05, Math.min(G.box[o + 3] - G.box[o], G.box[o + 5] - G.box[o + 2])));
    this.set(i, MS.FALLING);
    this.ledger.move('structure', 'falling', G.mass[i]);
    const s = this.surfaceUnder(i, -1);
    this.sy[i] = Math.max(0.02, t / Math.max(1e-3, h));
    this.dy[i] += s.top + t / 2 - this.centre(i);
    let r = s.member;
    while (r >= 0 && this.state[r] === MS.RESTING) r = this.restOn[r];
    if (r >= 0 && this.alive(r) && !G.ground[r]) {
      this.set(i, MS.RESTING);
      this.restOn[i] = r;
      (this.resting.get(r) ?? this.resting.set(r, []).get(r)!).push(i);
      this.ledger.move('falling', 'resting', G.mass[i]);
      this.s.addExtra(r, G.weight[i], i);
    } else {
      this.set(i, MS.SETTLED);
      this.ledger.move('falling', 'rubble', G.mass[i]);
      this.addToPile(G.box[o] + this.dx[i], G.box[o + 2] + this.dz[i], G.box[o + 3] + this.dx[i], G.box[o + 5] + this.dz[i], Math.max(0, s.top), G.mass[i], G.mass[i] / Math.max(100, memberMaterial(G, i).density));
    }
    this.events.push({ kind: 'crush', i, time, hazard: this.hazardName(i) });
    this.rev++;
    this.structRev++;
    this.changeLog.push(i);
  }

  /** Add rubble to the building's pile overlapping a footprint (or a new pile). */
  private addToPile(x0: number, z0: number, x1: number, z1: number, y: number, mass: number, solid: number): number {
    let pile = this.piles.find((p) => p.x0 <= x1 && p.x1 >= x0 && p.z0 <= z1 && p.z1 >= z0);
    if (!pile) {
      pile = { x0, z0, x1, z1, y, mass: 0, volume: 0, height: 0 };
      this.piles.push(pile);
    } else {
      pile.x0 = Math.min(pile.x0, x0); pile.z0 = Math.min(pile.z0, z0); pile.x1 = Math.max(pile.x1, x1); pile.z1 = Math.max(pile.z1, z1);
    }
    pile.mass += mass;
    pile.volume += bulkVolume(solid);
    settlePile(pile);
    return this.piles.indexOf(pile);
  }

  /**
   * Bottom layer of a block: in every plan cell its members cover, the members within 0.3 m of the
   * lowest bottom there — the only ones that can touch something first. Also the block's plan bounds.
   */
  private layer(b: FallingBlock) {
    const G = this.g, grid = G.grid;
    const low = new Map<number, number>();
    const cells = (i: number, fn: (c: number) => void) => {
      const o = 6 * i;
      const ix0 = Math.max(0, Math.floor((G.box[o] + this.dx[i] - grid.x0) / 2)), ix1 = Math.min(grid.nx - 1, Math.floor((G.box[o + 3] + this.dx[i] - grid.x0 - 1e-6) / 2));
      const iz0 = Math.max(0, Math.floor((G.box[o + 2] + this.dz[i] - grid.z0) / 2)), iz1 = Math.min(grid.nz - 1, Math.floor((G.box[o + 5] + this.dz[i] - grid.z0 - 1e-6) / 2));
      for (let iz = iz0; iz <= Math.max(iz0, iz1); iz++) for (let ix = ix0; ix <= Math.max(ix0, ix1); ix++) fn(iz * grid.nx + ix);
    };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const i of b.members) {
      const yb = this.bottom(i);
      cells(i, (c) => { const v = low.get(c); if (v === undefined || yb < v) low.set(c, yb); });
      const o = 6 * i;
      x0 = Math.min(x0, G.box[o] + this.dx[i]); z0 = Math.min(z0, G.box[o + 2] + this.dz[i]); x1 = Math.max(x1, G.box[o + 3] + this.dx[i]); z1 = Math.max(z1, G.box[o + 5] + this.dz[i]);
    }
    b.bottomK = [];
    let byMax = -Infinity;
    b.members.forEach((i, k) => {
      const yb = this.bottom(i);
      let isBottom = false;
      cells(i, (c) => { if (yb <= low.get(c)! + 0.3) isBottom = true; });
      if (isBottom) { b.bottomK.push(k); byMax = Math.max(byMax, yb); }
    });
    b.bx0 = x0; b.bz0 = z0; b.bx1 = x1; b.bz1 = z1; b.byMax = byMax;
    b.kOf = new Map(b.members.map((i, k) => [i, k]));
    b.bottomSet = new Set(b.bottomK);
    b.surfRev = -1;
  }

  /** Landing surfaces under the bottom layer of a block (highest standing member / resting rubble / ground). */
  private surfaces(b: FallingBlock) {
    const n = b.members.length;
    if (b.surf.length !== n) { b.surf = new Float64Array(n).fill(-Infinity); b.surfM = new Int32Array(n).fill(-1); }
    for (const k of b.bottomK) {
      const r = this.surfaceUnder(b.members[k], b.id);
      b.surf[k] = r.top;
      b.surfM[k] = r.member;
    }
    b.surfRev = this.structRev;
    b.seen = this.changeLog.length;
  }

  /**
   * Bring the landing cache up to date: a full pass after the block's layer changed, otherwise only
   * the bottom-layer members above each member that changed since (incremental).
   */
  private refresh(b: FallingBlock) {
    if (b.surfRev < 0) { this.surfaces(b); return; }
    if (b.surfRev === this.structRev) return;
    const G = this.g, log = this.changeLog;
    const hit = this.refreshK;
    hit.clear();
    for (let q = b.seen; q < log.length; q++) {
      const j = log[q];
      if (this.blockOf[j] === b.id) continue;
      const o = 6 * j;
      const x0 = G.box[o] + this.dx[j], x1 = G.box[o + 3] + this.dx[j], z0 = G.box[o + 2] + this.dz[j], z1 = G.box[o + 5] + this.dz[j];
      if (x0 > b.bx1 || x1 < b.bx0 || z0 > b.bz1 || z1 < b.bz0) continue;
      membersInRect(G, x0, z0, x1, z1, this.tmp2);
      for (const i of this.tmp2) {
        if (this.blockOf[i] !== b.id) continue;
        const k = b.kOf!.get(i);
        if (k !== undefined && b.bottomSet!.has(k)) hit.add(k);
      }
      if (hit.size > b.bottomK.length / 2) break;
    }
    if (hit.size > b.bottomK.length / 2) { this.surfaces(b); return; }
    for (const k of hit) {
      const r = this.surfaceUnder(b.members[k], b.id);
      b.surf[k] = r.top;
      b.surfM[k] = r.member;
    }
    b.seen = log.length;
    b.surfRev = this.structRev;
  }

  /**
   * Non-structural standing members (walls, openings) under the block's members, with the fall
   * distance at which the member above reaches their top (crushed then).
   */
  private sweepList(b: FallingBlock) {
    const G = this.g;
    const at = new Map<number, number>();
    for (const k of b.bottomK) {
      const i = b.members[k];
      const o = 6 * i;
      const yb = this.bottom(i);
      membersInRect(G, G.box[o] + this.dx[i] + 0.05, G.box[o + 2] + this.dz[i] + 0.05, G.box[o + 3] + this.dx[i] - 0.05, G.box[o + 5] + this.dz[i] - 0.05, this.tmp);
      for (const j of this.tmp) {
        if (!this.alive(j) || G.structural[j] || G.ground[j] || G.type[j] === MT_SLAB || this.blockOf[j] === b.id) continue;
        const t = this.top(j);
        if (t > yb + 0.05) continue;
        const d = b.D + Math.max(0, yb - t);
        const prev = at.get(j);
        if (prev === undefined || d < prev) at.set(j, d);
      }
    }
    b.sweep = [...at.keys()].sort((p, q) => at.get(p)! - at.get(q)! || p - q);
    b.sweepAt = b.sweep.map((j) => at.get(j)!);
    b.swept = 0;
  }

  /** Crush the non-structural members the block has swept through. */
  private sweepCrush(b: FallingBlock, time: number) {
    const trig = b.root >= 0 ? b.root : b.members[0];
    while (b.swept < b.sweep.length && b.sweepAt[b.swept] <= b.D + 1e-9) {
      const j = b.sweep[b.swept++];
      if (!this.alive(j)) continue;
      this.record(j, time, 'impact', this.hz(b.hazard), trig, 1);
      this.set(j, MS.FAILED);
      this.set(j, MS.DETACHED);
      this.damage[j] = 1;
      this.s.kill(j, trig);
      this.crushInPlace(j, time);
    }
  }

  private advance(b: FallingBlock, dt: number, time: number, g: number) {
    this.sweepCrush(b, time);
    this.refresh(b);
    let gap = Infinity;
    for (const k of b.bottomK) gap = Math.min(gap, this.bottom(b.members[k]) - b.surf[k]);
    gap = Math.max(0, gap);
    const t = fallTime(gap, b.v, g);
    if (t > dt) {
      const d = b.v * dt + 0.5 * g * dt * dt;
      this.move(b, d, dt);
      b.v += g * dt;
      this.ledger.energy.released += b.mass * g * d;
      this.ledger.energy.kinetic = this.kineticOfBlocks();
      return;
    }
    // Contact within this step.
    this.move(b, gap, t);
    const vc = b.v + g * t;
    this.ledger.energy.released += b.mass * g * gap;
    b.v = vc;
    this.land(b, gap, time + t, g);
    this.ledger.energy.kinetic = this.kineticOfBlocks();
  }

  private kineticOfBlocks() {
    let k = 0;
    for (const b of this.blocks) if (b.active) k += 0.5 * b.mass * b.v * b.v;
    return k;
  }

  private move(b: FallingBlock, d: number, dt: number) {
    b.D += d;
    b.Dx += b.vx * dt;
    b.Dz += b.vz * dt;
    for (let k = 0; k < b.members.length; k++) {
      const i = b.members[k];
      this.dy[i] -= d;
      this.dx[i] += b.vx * dt;
      this.dz[i] += b.vz * dt;
    }
    if (d > 0) this.rev++;
  }

  /** Resolve a contact: arrest on the floor, fail it, or settle on the ground. */
  private land(b: FallingBlock, _gap: number, time: number, g: number) {
    const G = this.g;
    const contacts: number[] = [];
    let minGap = Infinity;
    for (const k of b.bottomK) minGap = Math.min(minGap, this.bottom(b.members[k]) - b.surf[k]);
    const recv = new Map<number, number>();
    let ground = 0;
    for (const k of b.bottomK) {
      const i = b.members[k];
      if (this.bottom(i) - b.surf[k] > minGap + CONTACT_TOL) continue;
      contacts.push(i);
      let j = b.surfM[k];
      // Rubble resting on a floor transmits to the floor member under it.
      while (j >= 0 && this.state[j] === MS.RESTING) j = this.restOn[j];
      if (j < 0 || this.state[j] === MS.SETTLED || !this.alive(j) || G.ground[j]) { ground += G.mass[i]; continue; }
      recv.set(j, (recv.get(j) ?? 0) + G.mass[i]);
    }
    if (!recv.size) {
      this.settle(b, time, g);
      return;
    }
    const R = [...recv.keys()].sort((p, q) => p - q);
    let wsum = 0;
    for (const r of R) wsum += recv.get(r)!;
    const w = R.map((r) => recv.get(r)! / wsum);
    let mR = 0;
    for (const r of R) mR += G.mass[r] + this.s.extra[r] / g;
    const res = this.s.reserve(R, w);
    // Part of the block on the ground: the (rigid) ground arrests the block; the floor takes no more
    // than the collision with its members (rotation of the block is not modelled).
    const P = ground > 0 ? Infinity : res.P;
    const out = impactOutcome({ M: b.mass, v: b.v, mR, P, deltaU: res.deltaU, g });
    this.ledger.energy.collision += out.collisionLoss;
    if (ground > 0) this.ledger.energy.ground += out.absorbed;
    else this.ledger.energy.absorbed += out.absorbed;
    this.ledger.energy.released += (b.mass + mR) * g * out.distance;
    const governing = res.member >= 0 ? res.member : res.edge >= 0 ? G.eFrom[res.edge] : -1;
    this.events.push({ kind: 'impact', group: b.id, time, arrested: out.arrested, receivers: R, outcome: out, mass: b.mass, hazard: b.hazard, governing });
    if (out.arrested) {
      for (const r of R) this.setDamage(r, Math.max(this.damage[r], Math.min(0.99, out.damage)));
      this.rest(b, contacts, R);
      return;
    }
    // The struck floor fails and joins the block.
    const trig = b.root >= 0 ? b.root : b.members[0];
    for (const r of R) {
      if (!this.alive(r)) continue;
      this.record(r, time, 'impact', this.hz(b.hazard), trig, out.damage);
      this.set(r, MS.FAILED);
      this.set(r, MS.DETACHED);
      this.set(r, MS.FALLING);
      this.damage[r] = 1;
      this.s.kill(r, trig);
      this.ledger.move('structure', 'falling', G.mass[r]);
      this.join(b, r);
      // Rubble that rested on it comes along.
      const stack = [r];
      while (stack.length) {
        const x = stack.pop()!;
        const list = this.resting.get(x);
        if (!list) continue;
        this.resting.delete(x);
        for (const m of list) {
          if (this.state[m] !== MS.RESTING) continue;
          this.s.addExtra(x, -G.weight[m]);
          this.set(m, MS.FALLING);
          this.restOn[m] = -1;
          this.ledger.move('resting', 'falling', G.mass[m]);
          this.join(b, m);
          stack.push(m);
        }
      }
    }
    b.v = out.vResidual;
    // The merged block has crushed through the failed floor over its deformation capacity.
    this.move(b, out.distance, 0);
    this.layer(b);
    this.sweepList(b);
    this.rev++;
  }

  private join(b: FallingBlock, i: number) {
    b.members.push(i);
    b.join.push(b.D);
    b.mass += this.g.mass[i];
    this.blockOf[i] = b.id;
  }

  /** Arrested on a floor: the block rests there; its weight becomes the floor's static load. */
  private rest(b: FallingBlock, contacts: number[], R: number[]) {
    const G = this.g;
    b.active = false;
    // Each member rests on the receiver under its bottom-layer member in the same plan cell
    // (upper layers of the block bear on the layer below), else the first receiver.
    const surfOf = new Map<number, number>();
    const cellRecv = new Map<number, number>();
    const grid = G.grid;
    const cellOf = (i: number) => {
      const o = 6 * i;
      const cx = (G.box[o] + G.box[o + 3]) / 2 + this.dx[i], cz = (G.box[o + 2] + G.box[o + 5]) / 2 + this.dz[i];
      return Math.min(grid.nz - 1, Math.max(0, Math.floor((cz - grid.z0) / 2))) * grid.nx + Math.min(grid.nx - 1, Math.max(0, Math.floor((cx - grid.x0) / 2)));
    };
    for (const k of b.bottomK) {
      let j = b.surfM[k];
      while (j >= 0 && this.state[j] === MS.RESTING) j = this.restOn[j];
      surfOf.set(b.members[k], j);
      if (j >= 0) cellRecv.set(cellOf(b.members[k]), j);
    }
    for (const i of b.members) if (!surfOf.has(i)) surfOf.set(i, cellRecv.get(cellOf(i)) ?? -1);
    const onGround: number[] = [];
    for (const i of b.members) {
      let r = surfOf.get(i) ?? -1;
      if (r >= 0 && (this.state[r] === MS.SETTLED || G.ground[r])) r = -2;
      if (r === -1 && this.bottom(i) <= 0.05) r = -2;
      if (r === -2) { onGround.push(i); continue; }
      if (r < 0 || !this.alive(r)) r = R[0];
      this.set(i, MS.RESTING);
      this.restOn[i] = r;
      (this.resting.get(r) ?? this.resting.set(r, []).get(r)!).push(i);
      this.ledger.move('falling', 'resting', G.mass[i]);
      // The rubble is what loads the floor now: a later overload failure is part of its chain.
      this.s.addExtra(r, G.weight[i], i);
    }
    for (const i of onGround) {
      const o = 6 * i;
      this.set(i, MS.SETTLED);
      this.ledger.move('falling', 'rubble', G.mass[i]);
      this.addToPile(G.box[o] + this.dx[i], G.box[o + 2] + this.dz[i], G.box[o + 3] + this.dx[i], G.box[o + 5] + this.dz[i], Math.max(0, this.bottom(i)), G.mass[i], G.mass[i] / Math.max(100, memberMaterial(G, i).density));
    }
    this.compact(b, contacts.length ? Math.min(...contacts.map((i) => this.bottom(i))) : 0);
  }

  /** On the ground: the block settles into a rubble pile. */
  private settle(b: FallingBlock, time: number, g: number) {
    const G = this.g;
    b.active = false;
    const K = 0.5 * b.mass * b.v * b.v;
    this.ledger.energy.ground += K;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, solid = 0, base = Infinity;
    for (const i of b.members) {
      const o = 6 * i;
      x0 = Math.min(x0, G.box[o] + this.dx[i]); x1 = Math.max(x1, G.box[o + 3] + this.dx[i]);
      z0 = Math.min(z0, G.box[o + 2] + this.dz[i]); z1 = Math.max(z1, G.box[o + 5] + this.dz[i]);
      solid += G.mass[i] / Math.max(100, memberMaterial(G, i).density);
      base = Math.min(base, this.bottom(i));
      this.set(i, MS.SETTLED);
      this.ledger.move('falling', 'rubble', G.mass[i]);
    }
    const pi = this.addToPile(x0, z0, x1, z1, Math.max(0, base), b.mass, solid);
    const pile = this.piles[pi];
    this.compact(b, pile.y, pile.height);
    this.events.push({ kind: 'ground', group: b.id, time, mass: b.mass, energy: K, pile: pi, members: b.members.slice(), hazard: b.hazard });
    void g;
  }

  /**
   * Fallen members are drawn (and act as surfaces) compacted into the height their bulk volume
   * occupies over the block's footprint — the pile geometry is approximate, the mass exact.
   */
  private compact(b: FallingBlock, base: number, pileHeight?: number) {
    const G = this.g;
    let lo = Infinity, hi = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, solid = 0;
    for (const i of b.members) {
      const o = 6 * i;
      lo = Math.min(lo, this.bottom(i)); hi = Math.max(hi, this.top(i));
      x0 = Math.min(x0, G.box[o] + this.dx[i]); x1 = Math.max(x1, G.box[o + 3] + this.dx[i]);
      z0 = Math.min(z0, G.box[o + 2] + this.dz[i]); z1 = Math.max(z1, G.box[o + 5] + this.dz[i]);
      solid += G.mass[i] / Math.max(100, memberMaterial(G, i).density);
    }
    const H = hi - lo;
    if (!(H > 0)) return;
    const target = pileHeight ?? Math.min(H, bulkVolume(solid) / Math.max(0.5, (x1 - x0) * (z1 - z0)));
    const k = Math.min(1, Math.max(0.02, target / H));
    for (const i of b.members) {
      const c = this.centre(i);
      this.dy[i] += base + (c - lo) * k - c;
      this.sy[i] *= k;
      this.changeLog.push(i);
    }
    this.rev++;
    this.structRev++;
  }

  // ── Summaries ───────────────────────────────────────────────

  /** Superstructure mass still standing (kg). */
  standingMass(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.g.level[i] >= 0 && this.alive(i)) m += this.g.mass[i];
    return m;
  }

  /** Classification of the building's state (thresholds are classification only). */
  collapseLevel(): 'intact' | 'damaged' | 'local' | 'partial' | 'global' {
    let failedStruct = 0, damaged = 0, fell = 0;
    for (let i = 0; i < this.n; i++) {
      const st = this.state[i];
      if (st === MS.ABSENT) continue;
      if (st === MS.DAMAGED || st === MS.SEVERE) damaged++;
      if (st >= MS.FAILED && st !== MS.ABSENT) {
        if (this.g.structural[i]) failedStruct++;
        if (this.g.level[i] >= 0 && !this.external[i]) fell += this.g.mass[i];
      }
    }
    const standing = this.standingMass();
    if (this.superMass > 0 && standing < GLOBAL_STANDING * this.superMass) return 'global';
    if (fell > LOCAL_FALLEN * this.superMass) return 'partial';
    if (failedStruct > 0) return 'local';
    if (damaged > 0) return 'damaged';
    return 'intact';
  }
}

/** Standing superstructure share below which a collapse is called global. */
export const GLOBAL_STANDING = 0.1;
/** Fallen (non-facade) superstructure share above which it is a partial collapse rather than local failure. */
export const LOCAL_FALLEN = 0.05;

export { MT_SLAB };
