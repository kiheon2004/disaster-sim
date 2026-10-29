/**
 * Volcano adapter (Phase 28): the pure VolcanoWorld on top of the run's Phase 26 thermal state, Phase 27
 * fire model, Phase 21 terrain and Phase 25 structures. It never computes temperatures of anything but the
 * lava: every joule the lava gives up goes into the thermal world as a source step flagged `volcanic`
 * (booked in its own ledger account, equal to the volcano ledger's transferred heat):
 *
 *   volcano:ground   base conduction of lava / hot deposits into the ground surface layer of the cells
 *                    under each vertex (¼ per overlapped cell); retired deposits' remaining heat
 *   volcano:water    top exchange of lava under water into the water's heat
 *   volcano:air      top convection into the air-layer column above
 *   volcano:rad      top / margin radiation, emitted from 4 × 4 m patches: the share each body absorbs
 *                    (diffuse flat emitter: A_proj·cos θ / (π r²), body absorptivity = emissivity; walls of
 *                    other buildings shade) goes to it — with its projected area, so the fire model reads it
 *                    as incident flux exactly once — the rest leaves to the sky
 *   volcano:contact  conduction into objects standing in the lava (car bodies, tree trunks → core, the
 *                    ground-story members of buildings, walls, poles), limited to half of the temperature
 *                    difference per step; bombs landing on objects
 * Ground under lava or a hot deposit exchanges with nothing but the lava (it is `covered`).
 *
 * Objects (objects.ts): burial, lateral lava load, ash roof loads (modular buildings: Phase 25 static
 * surcharge on the roof members), ejecta impacts, movement restriction, roads. Fire: a fuel item in contact
 * with a glowing lava surface (≥ the Draper point, 525 °C) is piloted (`incidentProviders`); its ignition is
 * judged by the Phase 27 rules from the incident flux it actually receives — lava never lights fuel directly.
 */
import type { Vec3 } from '@/core/types';
import type { SystemContext } from '../systems/SimulationSystem';
import { TK, type Deposit, type SourceStep } from '@/thermal/ThermalWorld';
import { BK } from '@/thermal/ThermalBodies';
import { THERMAL_MATERIALS } from '@/thermal/materials';
import { LAYERS } from '@/thermal/TerrainThermal';
import { MT_COLUMN, MT_FOUNDATION, MT_ROOF, MT_WALL, MT_DOOR, MT_WINDOW } from '@/structure/graph';
import { MS } from '@/structure/types';
import { ZERO_C, toC } from '@/thermal/units';
import { VolcanoWorld, type VolcanoEnv } from '@/volcano/VolcanoWorld';
import { LAVA_MATERIALS } from '@/volcano/materials';
import { boundaryLayer } from '@/volcano/crust';
import { volcanoIssues } from '@/volcano/types';
import { temperatureRange } from '@/events/volcano/volcanoSchema';
import type { LavaSurroundings } from '@/volcano/LavaField';
import type { Bomb } from '@/volcano/bombs';
import type { ThermalRuntime, EntityThermal, BuildingThermal } from '../thermal/runtime';
import type { FireRuntime } from '../fire/runtime';
import type { EruptionRecord } from './VolcanoChannel';
import { VolcanoObjects } from './objects';

/** Radiation patch size (vertices) and the irradiance below which a receiver is not listed (W/m²). */
export const PATCH = 4;
export const RAD_FLOOR = 200;
export const RAD_REACH = 40;
/** Receiver lists of the patches are rebuilt this often (s) — the weights inside a list are exact per step. */
export const RAD_PERIOD = 1;
/** Receiver lists refreshed per step at most (new patches are always built). */
export const MAX_REBUILDS = 12;
/** Glowing surface (Draper point): a fuel item touching it is piloted. */
export const DRAPER = 798;
/** Lava at least this deep (m) at an object counts as contact. */
export const CONTACT_DEPTH = 0.02;

interface Patch {
  key: number;
  x: number;
  y: number;
  z: number;
  /** Receivers: body, share of the patch's top emission / side emission absorbed, projected area. */
  bodies: number[];
  fTop: number[];
  fSide: number[];
  ap: number[];
  builtAt: number;
  sx: number;
  sz: number;
}

export interface VolcanoStats {
  activeLava: number;
  hotDeposits: number;
  maxDepth: number;
  maxT: number;
  maxSpeed: number;
  substeps: number;
  faces: number;
  patches: number;
  receivers: number;
  contacts: number;
  /** Cost of the last step by part (ms) and the run totals. */
  ms: { flow: number; cool: number; ash: number; bombs: number; heat: number; objects: number };
  msTotal: { flow: number; cool: number; ash: number; bombs: number; heat: number; objects: number };
  supplyRate: number;
  waterAbove100: number;
}

export class VolcanoRuntime {
  readonly vw: VolcanoWorld | null;
  readonly trt: ThermalRuntime;
  readonly objects: VolcanoObjects;
  readonly stats: VolcanoStats = { activeLava: 0, hotDeposits: 0, maxDepth: 0, maxT: 0, maxSpeed: 0, substeps: 0, faces: 0, patches: 0, receivers: 0, contacts: 0, ms: { flow: 0, cool: 0, ash: 0, bombs: 0, heat: 0, objects: 0 }, msTotal: { flow: 0, cool: 0, ash: 0, bombs: 0, heat: 0, objects: 0 }, supplyRate: 0, waterAbove100: 0 };
  private readonly patches = new Map<number, Patch>();
  /** Cells covered by lava now (and what they were before). */
  private covered: number[] = [];
  private readonly coverMark: Uint8Array;
  private readonly coverOrig: Uint8Array;
  /** Bodies in contact with a glowing lava surface this step (fire pilot). */
  readonly pilotBodies = new Set<number>();
  /** Bodies that received lava heat (contact or radiation) — heat-caused effects on them are the volcano's. */
  readonly heatedBodies = new Set<number>();
  readonly heatedBuildings = new Set<BuildingThermal>();
  /** Steps of this step (kept for the inspector). */
  last: SourceStep[] = [];
  /** Bombs caught by objects this step: body → energy (J). */
  private caught = new Map<number, number>();
  ms = 0;
  msTotal = 0;
  private hooked: FireRuntime | null = null;
  private hazardHook: ((bt: BuildingThermal) => string) | null = null;
  private th = { start: false, peak: 0, arrival: false, cooling: false, solid: false, ash: false, end: false, settled: false, ignition: false, peakRate: 0 };

  constructor(ctx: SystemContext, trt: ThermalRuntime) {
    this.trt = trt;
    const terr = ctx.env.terrain.data;
    const first = ctx.env.volcano.eruptions[0];
    const mat = LAVA_MATERIALS[first?.spec.material ?? 'basalt'];
    this.vw = new VolcanoWorld(terr.nx, terr.nz, terr.cellSize, terr.originX, terr.originZ, terr.heights, mat, trt.world.Tref);
    const n = trt.world.terrain.count;
    this.coverMark = new Uint8Array(n);
    this.coverOrig = new Uint8Array(n);
    this.objects = new VolcanoObjects(ctx, this);
    ctx.env.volcano.attach(this.vw.field);
    this.vw.catchers = {
      ash: (i, m) => this.objects.catchAsh(i, m),
      bomb: (b) => this.catchBomb(ctx, b),
    };
  }

  get world() {
    return this.vw!;
  }

  // ── Surroundings (read from the thermal state) ─────────

  /** Thermal cells overlapped by a vertex's dual cell (¼ each, clipped at the edges). */
  private cellsOf(v: number, out: number[]): number {
    const tr = this.trt.world.terrain, f = this.world.field;
    const vx = v % f.nx, vz = (v / f.nx) | 0;
    let k = 0;
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const cx = vx + dx, cz = vz + dz;
      if (cx < 0 || cz < 0 || cx >= tr.nx || cz >= tr.nz) continue;
      out[k++] = cz * tr.nx + cx;
    }
    return k;
  }
  private readonly cbuf = [0, 0, 0, 0];

  private surroundings(): LavaSurroundings {
    const w = this.trt.world, tr = w.terrain, f = this.world.field, cb = this.cbuf;
    const U2 = w.u10 * Math.pow(2 / 10, 0.14);
    return {
      Tref: w.Tref,
      airT: (i) => w.air.T(w.air.index(f.xOf(i), f.zOf(i), Math.max(1, f.depth(i) + 1))),
      wind: () => U2,
      groundT: (i) => { const k = this.cellsOf(i, cb); let s = 0; for (let j = 0; j < k; j++) s += tr.T(cb[j], 0); return k ? s / k : w.Tref; },
      groundR: (i) => { const k = this.cellsOf(i, cb); let s = 0; for (let j = 0; j < k; j++) s += LAYERS[0] / (2 * tr.k[cb[j] * tr.nl]); return k ? s / k : 0.01; },
      waterDepth: (i) => { const wt = w.water; if (!wt) return 0; const k = this.cellsOf(i, cb); let s = 0; for (let j = 0; j < k; j++) s += wt.h[cb[j]]; return k ? s / k : 0; },
      waterT: (i) => { const wt = w.water; if (!wt) return w.Tref; const k = this.cellsOf(i, cb); let s = 0, h = 0; for (let j = 0; j < k; j++) { s += w.waterT(cb[j]) * wt.h[cb[j]]; h += wt.h[cb[j]]; } return h > 0 ? s / h : w.Tref; },
    };
  }

  private env(ctx: SystemContext): VolcanoEnv {
    const w = this.trt.world;
    const rains = ctx.env.flood.forcing?.rains ?? [];
    return {
      surroundings: this.surroundings(),
      u10: w.u10, flowX: w.flowX, flowZ: w.flowZ,
      rain: (x, z) => { let I = 0; for (const r of rains) I += rainAt(r, x, z); return I; },
      ground: (x, z) => ctx.env.terrain.sampleHeight(x, z),
    };
  }

  // ── Eruptions ──────────────────────────────────────────

  private start(ctx: SystemContext, rec: EruptionRecord) {
    rec.done = true;
    const issues = volcanoIssues(rec.spec, ['basalt', 'andesite'], temperatureRange);
    const vw = this.world;
    let reason: string | null = issues[0] ?? null;
    if (!reason && rec.spec.material !== vw.mat.id) reason = 'volcano.reject.material';
    if (!reason) {
      const f = vw.field;
      const inside = rec.spec.vents.every((v) => f.index(v.position[0], v.position[1]) >= 0 && (!v.end || f.index(v.end[0], v.end[1]) >= 0));
      if (!inside) reason = 'volcano.reject.outside';
    }
    rec.reason = reason;
    if (reason) {
      ctx.milestone?.({ time: ctx.time, kind: 'eruptionRejected', hazard: 'volcano', subject: 'volcano', label: { key: 'milestone.eruptionRejected', params: { id: rec.name, reason } } }, `volcano:reject:${rec.id}`);
      ctx.log(null, 'warn', { key: 'log.volcano.rejected', params: { id: rec.name, reason } });
      return;
    }
    vw.add(rec.id, rec.name, rec.spec, rec.start, (x, z) => ctx.env.terrain.sampleHeight(x, z));
    ctx.milestone?.({ time: rec.start, kind: 'eruptionStart', hazard: 'volcano', subject: 'volcano', label: { key: 'milestone.eruptionStart', params: { id: rec.name } } }, `volcano:start:${rec.id}`);
    ctx.log(null, 'danger', { key: 'log.volcano.start', params: { id: rec.name } });
  }

  // ── Before the thermal step ────────────────────────────

  /** Eruption, flow, ash, bombs, cooling; returns the heat it gives up this step as source steps. */
  prepare(ctx: SystemContext, dt: number): SourceStep[] {
    const t0 = performance.now();
    const ch = ctx.env.volcano;
    for (const rec of ch.eruptions) if (!rec.done && rec.start < ctx.time + dt) this.start(ctx, rec);
    this.hookFire();
    const vw = this.world, f = vw.field;
    this.objects.obstacles(ctx);
    this.caught.clear();
    vw.step(ctx.time, dt, this.env(ctx));
    if (ch.source) ch.source.now = ctx.time + dt;
    const th = performance.now();
    const steps = this.heatSteps(ctx, dt);
    this.updateCover();
    this.stats.ms.heat = performance.now() - th;
    Object.assign(this.stats.ms, vw.cost);
    const T = this.stats.msTotal, M = this.stats.ms;
    T.flow += M.flow; T.cool += M.cool; T.ash += M.ash; T.bombs += M.bombs; T.heat += M.heat;
    this.stats.activeLava = f.mobile.length;
    this.stats.hotDeposits = f.hot.length;
    this.stats.substeps = f.substeps;
    this.stats.faces = f.faces;
    let hMax = 0, TMax = 0, vMax = 0;
    for (const i of f.mobile) { const h = f.depth(i); if (h > hMax) hMax = h; if (f.T[i] > TMax) TMax = f.T[i]; if (f.speed[i] > vMax) vMax = f.speed[i]; }
    for (const i of f.hot) if (f.depT[i] > TMax) TMax = f.depT[i];
    this.stats.maxDepth = hMax; this.stats.maxT = TMax; this.stats.maxSpeed = vMax;
    this.stats.supplyRate = vw.supplyRate(ctx.time);
    this.last = steps;
    this.ms = performance.now() - t0;
    return steps;
  }

  /** Accumulated heat of the field → thermal source steps (exact: the steps carry what the field booked). */
  /** Per-cell / per-column accumulators of the heat steps (reused: no per-step maps or sorting of pairs). */
  private acc: { ground: Float64Array; water: Float64Array; air: Float64Array; gList: number[]; wList: number[]; aList: number[] } | null = null;

  private heatSteps(ctx: SystemContext, dt: number): SourceStep[] {
    const w = this.trt.world, f = this.world.field, cb = this.cbuf;
    const acc = (this.acc ??= { ground: new Float64Array(w.terrain.count), water: new Float64Array(w.terrain.count), air: new Float64Array(w.air.count), gList: [], wList: [], aList: [] });
    let G = 0, W = 0, A = 0, R = 0, above = 0;
    const patchE = new Map<number, { top: number; side: number; x: number; z: number; y: number; sx: number; sz: number; w: number }>();
    f.drain((i, g, a, r, wt) => {
      if (g !== 0 || wt !== 0) {
        const k = this.cellsOf(i, cb);
        for (let j = 0; j < k; j++) {
          const c = cb[j];
          if (g !== 0) { if (acc.ground[c] === 0) acc.gList.push(c); acc.ground[c] += g / k; }
          if (wt !== 0) { if (acc.water[c] === 0) acc.wList.push(c); acc.water[c] += wt / k; }
        }
        if (k) { G += g; W += wt; }
      }
      if (a !== 0) {
        const c = w.air.index(f.xOf(i), f.zOf(i), Math.max(1, f.depth(i) + 1));
        if (c >= 0) { if (acc.air[c] === 0) acc.aList.push(c); acc.air[c] += a; } else above += a;
        A += a;
      }
      if (r !== 0) {
        const ix = i % f.nx, iz = (i / f.nx) | 0;
        const key = ((iz / PATCH) | 0) * 100003 + ((ix / PATCH) | 0);
        let p = patchE.get(key);
        if (!p) patchE.set(key, (p = { top: 0, side: 0, x: 0, z: 0, y: 0, sx: 0, sz: 0, w: 0 }));
        const side = f.qSide[i];
        p.top += r - side; p.side += side;
        p.x += f.xOf(i) * r; p.z += f.zOf(i) * r; p.y += f.surface(i) * r; p.w += r;
        p.sx += f.nSideX[i]; p.sz += f.nSideZ[i];
        R += r;
      }
    });
    const take = (arr: Float64Array, list: number[], kind: number, total: number): Deposit[] => {
      list.sort((x, y) => x - y);
      const out: Deposit[] = new Array(list.length);
      for (let n = 0; n < list.length; n++) { const c = list[n]; out[n] = { kind: kind as Deposit['kind'], index: c, w: arr[c] / total }; arr[c] = 0; }
      list.length = 0;
      return out;
    };
    const steps: SourceStep[] = [];
    // Water heated beyond boiling (no boiling model in Phase 26): reported, not hidden.
    let hot = 0;
    if (w.water) for (const c of acc.wList) if (w.waterT(c) > 373.15) hot++;
    this.stats.waterAbove100 = Math.max(this.stats.waterAbove100, hot);
    if (G !== 0) steps.push({ id: 'volcano:ground', energy: G, deposits: take(acc.ground, acc.gList, TK.ground, G), volcanic: true });
    else { for (const c of acc.gList) acc.ground[c] = 0; acc.gList.length = 0; }
    if (W !== 0) steps.push({ id: 'volcano:water', energy: W, deposits: take(acc.water, acc.wList, TK.water, W), volcanic: true });
    else { for (const c of acc.wList) acc.water[c] = 0; acc.wList.length = 0; }
    if (A !== 0) steps.push({ id: 'volcano:air', energy: A, deposits: take(acc.air, acc.aList, TK.air, A), aboveLayer: above / A, volcanic: true });
    else { for (const c of acc.aList) acc.air[c] = 0; acc.aList.length = 0; }
    if (R !== 0) steps.push(this.radiation(ctx, dt, patchE, R));
    const contact = this.contacts(ctx, dt);
    if (contact) steps.push(contact);
    return steps;
  }

  /** Radiation of the patches to the bodies around them (receiver lists rebuilt every RAD_PERIOD). */
  private radiation(ctx: SystemContext, dt: number, patchE: Map<number, { top: number; side: number; x: number; z: number; y: number; sx: number; sz: number; w: number }>, R: number): SourceStep {
    const trt = this.trt, B = trt.world.bodies;
    const acc = new Map<number, { J: number; a: number }>();
    let receivers = 0;
    let rebuilds = 0;
    for (const [key, e] of [...patchE.entries()].sort((a, b) => a[0] - b[0])) {
      let p = this.patches.get(key);
      const x = e.x / e.w, y = e.y / e.w, z = e.z / e.w;
      // New patches always get their receivers; old lists are refreshed at most MAX_REBUILDS per step
      // (spread over steps, oldest first by key order) — a list is at most a few seconds old.
      const stale = !!p && (ctx.time - p.builtAt >= RAD_PERIOD || Math.hypot(p.x - x, p.z - z) > 1.5);
      if (!p || (stale && rebuilds < MAX_REBUILDS && ctx.time - p.builtAt >= RAD_PERIOD * (1 + (key % 7) / 7))) {
        if (p) rebuilds++;
        p = this.buildPatch(ctx, key, [x, y, z], (e.top + e.side) / dt, e.sx, e.sz);
        this.patches.set(key, p);
      }
      for (let k = 0; k < p.bodies.length; k++) {
        const b = p.bodies[k];
        if (!B.alive[b]) continue;
        const J = e.top * p.fTop[k] + e.side * p.fSide[k];
        if (J <= 0) continue;
        const r = acc.get(b);
        if (r) { r.J += J; r.a = Math.max(r.a, p.ap[k]); } else acc.set(b, { J, a: p.ap[k] });
        receivers++;
      }
    }
    const deposits: Deposit[] = [];
    for (const [b, r] of [...acc.entries()].sort((a, c) => a[0] - c[0])) {
      deposits.push({ kind: TK.body, index: b, w: r.J / R, a: r.a });
      // Heat effects on bodies that receive a meaningful lava irradiance (≥ 1 kW/m²) are the volcano's.
      if (r.J / dt / Math.max(1e-6, r.a) >= 1000) this.markHeated(b);
    }
    this.stats.patches = patchE.size;
    this.stats.receivers = receivers;
    return { id: 'volcano:rad', energy: R, deposits, volcanic: true, bodies: deposits.length };
  }

  private buildPatch(ctx: SystemContext, key: number, P: Vec3, W: number, sx: number, sz: number): Patch {
    const trt = this.trt, B = trt.world.bodies;
    const p: Patch = { key, x: P[0], y: P[1], z: P[2], bodies: [], fTop: [], fSide: [], ap: [], builtAt: ctx.time, sx, sz };
    // Reach: where a receiver facing the patch would get RAD_FLOOR.
    const reach = Math.min(RAD_REACH, Math.sqrt(W / (Math.PI * RAD_FLOOR)) + PATCH);
    const sl = Math.hypot(sx, sz);
    const nx = sl > 0 ? sx / sl : 0, nz = sl > 0 ? sz / sl : 0;
    // Bodies in reach join the thermal network first (activation / member detail where it matters).
    for (const te of this.entsNear(ctx, P, reach)) {
      const q = te.e.pose.position;
      const d = Math.hypot(q[0] - P[0], q[2] - P[2]) - Math.hypot(te.e.dims[0], te.e.dims[2]) / 2;
      if (d > reach) continue;
      if (!te.active) trt.activate(ctx, te);
      if (te.coarse && d <= 8) trt.refine(ctx, te);
    }
    const shields = trt.shields(P, reach);
    for (const i of this.bodiesNear(ctx, P, reach)) {
      if (!B.alive[i]) continue;
      const dx = B.x[i] - P[0], dy = B.y[i] - P[1], dz = B.z[i] - P[2];
      const r = Math.hypot(dx, dy, dz);
      if (r > reach || r < 1e-6) continue;
      if (B.kind[i] === BK.heap && r > 10) continue;
      const vis = trt.visible(i, P, null, shields);
      if (vis <= 0) continue;
      const rr = Math.max(r, 0.5 * PATCH);
      const Ap = trt.projected(i, -dx / r, -dy / r, -dz / r);
      const eps = THERMAL_MATERIALS[B.matS[i]].emissivity;
      // Diffuse flat emitter facing up (top) / outward-horizontal (margins).
      const cosTop = Math.max(0, dy / r);
      const cosSide = Math.max(0, (dx * nx + dz * nz) / r);
      const fT = Math.min(0.5, (Ap * cosTop) / (Math.PI * rr * rr));
      const fS = sl > 0 ? Math.min(0.5, (Ap * cosSide) / (Math.PI * rr * rr)) : 0;
      if ((fT + fS) * W / Math.max(1e-6, Ap) < RAD_FLOOR * 0.25 && fT + fS < 1e-4) continue;
      if (fT <= 0 && fS <= 0) continue;
      p.bodies.push(i); p.fTop.push(fT * eps); p.fSide.push(fS * eps); p.ap.push(Ap);
    }
    return p;
  }

  /** Bodies near a point (8 m grid of body centres, rebuilt once per step when bodies were added / moved). */
  private grid: { step: number; n: number; cells: Map<number, number[]> } = { step: -1, n: -1, cells: new Map() };
  private bodiesNear(ctx: SystemContext, P: Vec3, r: number): number[] {
    const B = this.trt.world.bodies, G = 8;
    if (this.grid.step !== ctx.step || this.grid.n !== B.n) {
      const cells = new Map<number, number[]>();
      for (let i = 0; i < B.n; i++) {
        if (!B.alive[i]) continue;
        const key = Math.floor(B.x[i] / G) * 100003 + Math.floor(B.z[i] / G);
        const l = cells.get(key);
        if (l) l.push(i); else cells.set(key, [i]);
      }
      this.grid = { step: ctx.step, n: B.n, cells };
    }
    const out: number[] = [];
    const x0 = Math.floor((P[0] - r - 4) / G), x1 = Math.floor((P[0] + r + 4) / G), z0 = Math.floor((P[2] - r - 4) / G), z1 = Math.floor((P[2] + r + 4) / G);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) { const l = this.grid.cells.get(gx * 100003 + gz); if (l) for (const i of l) out.push(i); }
    return out.sort((a, b) => a - b);
  }

  /** Thermal entities near a point (16 m grid of their positions, rebuilt once per step; sizes ≤ 40 m covered by the margin). */
  private egrid: { step: number; cells: Map<number, EntityThermal[]> } = { step: -1, cells: new Map() };
  private entsNear(ctx: SystemContext, P: Vec3, r: number): EntityThermal[] {
    const G = 16;
    if (this.egrid.step !== ctx.step) {
      const cells = new Map<number, EntityThermal[]>();
      for (const te of this.trt.ents) {
        const q = te.e.pose.position;
        const key = Math.floor(q[0] / G) * 100003 + Math.floor(q[2] / G);
        const l = cells.get(key);
        if (l) l.push(te); else cells.set(key, [te]);
      }
      this.egrid = { step: ctx.step, cells };
    }
    const out: EntityThermal[] = [];
    const m = r + 24;
    for (let gx = Math.floor((P[0] - m) / G); gx <= Math.floor((P[0] + m) / G); gx++) for (let gz = Math.floor((P[2] - m) / G); gz <= Math.floor((P[2] + m) / G); gz++) {
      const l = this.egrid.cells.get(gx * 100003 + gz);
      if (l) for (const te of l) out.push(te);
    }
    // Registration order (deterministic, as the full scan).
    const order = this.entOrder ??= new Map(this.trt.ents.map((te, k) => [te, k]));
    return out.sort((a, b) => order.get(a)! - order.get(b)!);
  }
  private entOrder: Map<EntityThermal, number> | null = null;

  /** Conduction into objects standing in the lava (and bombs they caught). */
  private contacts(ctx: SystemContext, dt: number): SourceStep | null {
    const trt = this.trt, B = trt.world.bodies, f = this.world.field;
    this.pilotBodies.clear();
    const parts: { b: number; J: number; a: number; core: boolean }[] = [];
    let total = 0;
    const k = this.world.mat.thermal.k;
    for (const c of this.objects.contactPoints(ctx)) {
      const i = c.vertex;
      const mobile = f.M[i] > 0;
      const h = mobile ? f.depth(i) : f.depT[i] > B.TS[c.body] + 1 && f.hot.length ? f.depThicknessLava(i) : 0;
      if (h < CONTACT_DEPTH) continue;
      const Tl = mobile ? f.T[i] : f.depT[i];
      const b = c.body;
      if (!B.alive[b]) continue;
      const Tb = c.core ? B.TC[b] : B.TS[b];
      if (Tl <= Tb) continue;
      const A = c.width * Math.min(h, c.height) + (c.under && h > c.clearance ? c.underArea : 0);
      if (A <= 0) continue;
      const d = boundaryLayer(this.world.mat.kappa, mobile ? f.age[i] : f.depAge[i], h);
      const C = B.capacity(b, c.core);
      const want = Math.min((A * k * (Tl - Tb) * dt) / d, 0.5 * C * (Tl - Tb) / Math.max(1, c.share));
      const got = f.take(i, want);
      if (got <= 0) continue;
      parts.push({ b, J: got, a: A, core: c.core });
      total += got;
      this.markHeated(b);
      if (f.Ts[i] >= DRAPER || Tl >= DRAPER) this.pilotBodies.add(b);
    }
    for (const [b, J] of this.caught) { parts.push({ b, J, a: Math.max(0.05, B.Atop[b] || 1), core: false }); total += J; this.markHeated(b); }
    this.stats.contacts = parts.length;
    if (total <= 0) return null;
    const merged = new Map<string, { b: number; J: number; a: number; core: boolean }>();
    for (const p of parts) { const key = `${p.b}:${p.core ? 1 : 0}`; const m = merged.get(key); if (m) { m.J += p.J; m.a += p.a; } else merged.set(key, { ...p }); }
    const list = [...merged.values()].sort((a, c) => a.b - c.b || Number(a.core) - Number(c.core));
    // Skin deposits first (they carry the contact area → incident flux of the fuel); core deposits after.
    const skin = list.filter((p) => !p.core), core = list.filter((p) => p.core);
    const deposits: Deposit[] = [...skin.map((p) => ({ kind: TK.body, index: p.b, w: p.J / total, a: p.a })), ...core.map((p) => ({ kind: TK.body, index: p.b, w: p.J / total, core: true }))];
    return { id: 'volcano:contact', energy: total, deposits, volcanic: true, bodies: skin.length };
  }

  private markHeated(b: number) {
    this.heatedBodies.add(b);
    const B = this.trt.world.bodies;
    if (B.kind[b] === BK.member && B.sub[b] >= 0) this.heatedBuildings.add(this.trt.buildings[B.ref[b]]);
  }

  /** A bomb landing on an object: its heat goes into the object, its mass is carried there, the impact recorded. */
  private catchBomb(ctx: SystemContext, b: Bomb): boolean {
    const hit = this.objects.bombHit(ctx, b);
    if (hit < 0) return false;
    this.caught.set(hit, (this.caught.get(hit) ?? 0) + b.energy);
    return true;
  }

  /** Ground cells under lava / hot deposits exchange only with the lava (their air side is covered). */
  private updateCover() {
    const tr = this.trt.world.terrain, f = this.world.field, cb = this.cbuf;
    const now: number[] = [];
    const count = new Map<number, number>();
    const visit = (i: number) => { const k = this.cellsOf(i, cb); for (let j = 0; j < k; j++) count.set(cb[j], (count.get(cb[j]) ?? 0) + 1); };
    for (const i of f.mobile) visit(i);
    for (const i of f.hot) if (f.M[i] <= 0) visit(i);
    for (const [c, n] of count) {
      if (n < 2) continue;
      if (!this.coverMark[c]) { this.coverMark[c] = 1; this.coverOrig[c] = tr.covered[c]; tr.covered[c] = 1; tr.activateCell(c); }
      now.push(c);
    }
    const keep = new Set(now);
    for (const c of this.covered) if (!keep.has(c)) { this.coverMark[c] = 0; tr.covered[c] = this.coverOrig[c]; }
    this.covered = now;
  }

  // ── Fire coupling ──────────────────────────────────────

  private hookFire() {
    const trt = this.trt;
    // Heat effects on buildings the lava heated are the volcano's (unless they burn: then the fire's).
    if (trt.hooks.hazard !== this.hazardHook) {
      const prev = trt.hooks.hazard;
      this.hazardHook = (bt) => { const h = prev?.(bt) ?? 'thermal'; return h === 'fire' ? h : this.heatedBuildings.has(bt) ? 'volcano' : h; };
      trt.hooks.hazard = this.hazardHook;
    }
  }

  /** Called once the fire model exists (ThermalSystem): pilot from glowing lava, ignition source label. */
  attachFire(fire: FireRuntime) {
    if (this.hooked === fire) return;
    this.hooked = fire;
    fire.incidentProviders.push((rt, _q, pilot) => {
      if (!this.pilotBodies.size) return;
      const fw = rt.fw;
      for (let i = 0; i < fw.n; i++) if (this.pilotBodies.has(fw.body[i])) pilot[i] = 1;
    });
    fire.ignitionSource = (i) => (this.heatedBodies.has(fire.fw.body[i]) ? 'lava' : null);
    this.hookFire();
  }

  // ── After the thermal step ─────────────────────────────

  after(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    this.objects.respond(ctx, dt);
    this.stats.ms.objects = performance.now() - t0;
    this.stats.msTotal.objects += this.stats.ms.objects;
    this.milestones(ctx);
    this.ms += performance.now() - t0;
    this.msTotal += this.ms;
  }

  private milestones(ctx: SystemContext) {
    const vw = this.world, f = vw.field, th = this.th;
    const m = (kind: import('../analysis/MilestoneRecorder').MilestoneKind, key: string, params: Record<string, string | number> = {}, subject = 'volcano') =>
      ctx.milestone?.({ time: ctx.time, kind, hazard: 'volcano', subject, label: { key: `milestone.${key}` as never, params } }, `volcano:${kind}`);
    const rate = vw.supplyRate(ctx.time);
    if (rate > th.peakRate + 1e-9) { th.peakRate = rate; th.peak = ctx.time; }
    else if (th.peakRate > 0 && rate < th.peakRate && !th.start) { th.start = true; ctx.milestone?.({ time: th.peak, kind: 'peakSupply', hazard: 'volcano', subject: 'volcano', label: { key: 'milestone.peakSupply', params: { q: th.peakRate.toFixed(2) } } }, 'volcano:peakSupply'); }
    // Cooling milestone: the first lava surface below 700 °C (dull red — a crust has formed; the interior still flows).
    if (!th.cooling && f.mobile.some((i) => f.Ts[i] < 973.15 && f.depth(i) > 0.05)) { th.cooling = true; m('lavaCrust', 'lavaCrust'); }
    if (!th.solid && f.ledger.lockedMass > 1000) { th.solid = true; m('solidification', 'solidification', { t: f.ledger.lockedMass / 1000 }); }
    if (!th.ash && f.ledger.ashMass > 1) { th.ash = true; m('ashDeposition', 'ashDeposition'); }
    const stopped = vw.eruptions.length > 0 && vw.eruptions.every((e) => e.phase === 'stopped');
    if (stopped && !th.end) { th.end = true; m('eruptionEnd', 'eruptionEnd'); if (!th.start) { th.start = true; ctx.milestone?.({ time: th.peak, kind: 'peakSupply', hazard: 'volcano', subject: 'volcano', label: { key: 'milestone.peakSupply', params: { q: th.peakRate.toFixed(2) } } }, 'volcano:peakSupply'); } }
    if (th.end && !th.settled && f.mobile.length === 0 && vw.puffs.length === 0 && vw.bombsInFlight().mass === 0) { th.settled = true; m('finalSettling', 'finalSettling'); }
    void toC; void ZERO_C;
  }

  /** Inspector: lava state at a world point. */
  sampleAt(x: number, z: number) {
    const f = this.world.field;
    const i = f.index(x, z);
    if (i < 0) return null;
    const cb = this.cbuf, k = this.cellsOf(i, cb);
    let flux = 0;
    for (const s of this.last) if (s.id === 'volcano:ground') for (const d of s.deposits) for (let j = 0; j < k; j++) if (d.index === cb[j]) flux += s.energy * d.w;
    return {
      depth: f.depth(i), T: f.M[i] > 0 ? f.T[i] : NaN, Ts: f.Ts[i], speed: f.speed[i], crystals: f.M[i] > 0 ? this.crystals(f.T[i]) : NaN,
      deposit: f.dep[i], lavaDeposit: f.depM[i], bombDeposit: f.depB[i], ash: f.depA[i], depositT: f.depM[i] + f.depB[i] > 0 ? f.depT[i] : NaN,
      peakDepth: f.hPeak[i], peakT: f.Tpeak[i], groundFlux: flux / 0.1 / Math.max(1, k),
    };
  }

  private crystals(T: number) {
    const m = this.world.mat;
    return T >= m.thermal.TL ? 0 : T <= m.thermal.TS ? 1 : (m.thermal.TL - T) / (m.thermal.TL - m.thermal.TS);
  }
}

/** Rain intensity of an active rain forcing at a point (mm/h) — rate in m/s over its area (Phase 14). */
function rainAt(r: { rate: number; area?: { center: [number, number]; radius: number } | null }, x: number, z: number): number {
  const a = r.area;
  if (a && Math.hypot(x - a.center[0], z - a.center[1]) > a.radius) return 0;
  return r.rate * 3.6e6;
}

export type { EntityThermal };
void MT_COLUMN; void MT_FOUNDATION; void MT_ROOF; void MT_WALL; void MT_DOOR; void MT_WINDOW; void MS;
