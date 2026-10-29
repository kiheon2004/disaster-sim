/**
 * Air-pressure waves (Phase 24, prePhysics — after the ground-motion forces, before the water
 * solver). Every step:
 *  - new waves of the pressure channel get an arrival queue of the objects (unshielded arrival at
 *    their centre — shielding only delays);
 *  - an object is ACTIVATED just before the front reaches it: its shielding (terrain, other
 *    buildings) is evaluated once, its face loads (static objects) and facade parts are built;
 *  - active objects respond through the pressure-channel handlers (blast/responses.ts): structural
 *    lateral loads, facade / attachment SDOF elements, ForceLedger forces on bodies, tree moments;
 *  - debris pieces inside a pulse are pushed the same way as bodies;
 *  - with multi-hazard interactions, water feels the pressure-gradient force of the pulse (the
 *    exact time integral ∫p dt per cell is handed to the water solver, momentum only — mass exact);
 *  - wave events (release, first arrival at an object, peak overpressure and impulse felt by the
 *    objects once the front has left the world) become log entries and timeline milestones — only
 *    what was computed.
 * Nothing is applied before a wave arrives (arrival times from the tables, exact step integrals).
 * Inactive (and free) without a wave.
 */
import { blastAirDensity } from '../atmosphere/runtime';
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { responses } from '../response/responses';
import { ensureSeismicRuntime } from '../seismic/SeismicState';
import { newBlastState, type WaveLoad } from '../blast/state';
import { buildParts, buildWalls, respondBody } from '../blast/responses';
import { boxFaces, dragImpulse, faceLoads, netImpulse, pressureCentre, projectedArea, type FaceLoad } from '@/blast/loads';
import { impulse, peakOf, positiveImpulseOf, span } from '@/blast/pulse';
import { NO_SHIELD, ShieldIndex, shielding, type Contribution } from '@/blast/wave';
import { qRotate } from '@/core/math';
import { newSample } from '@/blast/source';
import { obstacleFromEntity } from '../wind/obstacles';
import { simProfiler } from '../profiling/SimProfiler';
import type { ShieldBox } from '@/blast/wave';

/** Objects are activated this long before the front can reach them (s). */
const LEAD = 0.05;
/** Debris pieces are only evaluated while a pulse is within this distance of them (s of travel). */
const ZONE_ORDER = { weak: 0, transition: 1, strong: 2, core: 3 } as const;

interface Pending { e: RuntimeEntity; t: number }

const J: Vec3 = [0, 0, 0], L: Vec3 = [0, 0, 0], D: Vec3 = [0, 0, 0], P: Vec3 = [0, 0, 0];
const loads: FaceLoad[] = [];

export class BlastSystem implements SimulationSystem {
  readonly name = 'blast';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['terrain', 'poses'] as const;
  readonly writes = ['forces', 'structure', 'damage', 'debris', 'particles'] as const;
  readonly lagged = ['poses'] as const;
  private known = 0;
  private queues: { list: Pending[]; next: number }[] = [];
  private active: RuntimeEntity[] = [];
  private loadedUnits: number[] = [];
  private index: ShieldIndex | null = null;
  private indexRev = -1;
  private noted = new Set<string>();
  private exited = new Set<number>();
  private water: { wave: number; cells: Int32Array; t: Float32Array; dp: Float32Array; dn: Float32Array; T: Float32Array; n: number; wf: 'nWave' | 'positive' }[] = [];

  isActive(ctx: SystemContext) {
    const ch = ctx.env.blast;
    return ch.active && (this.known < ch.waves.length || this.active.length > 0 || ch.passing(ctx.time) || this.loadedUnits.length > 0);
  }

  update(ctx: SystemContext, dt: number) {
    const w0 = performance.now();
    const ch = ctx.env.blast;
    const t0 = ctx.time, t1 = t0 + dt;
    ch.loading = false;
    const sr = ctx.runtime.seismic;
    if (sr) for (const ui of this.loadedUnits) { sr.model.fbx[ui] = 0; sr.model.fbz[ui] = 0; }
    this.loadedUnits.length = 0;
    // New waves → arrival queues and the release event.
    while (this.known < ch.waves.length) this.addWave(ctx, this.known++);
    // Activation.
    for (let wi = 0; wi < this.queues.length; wi++) {
      const q = this.queues[wi];
      while (q.next < q.list.length && q.list[q.next].t - LEAD <= t1) this.activate(ctx, q.list[q.next++].e, wi);
    }
    const a0 = performance.now();
    // Responses of the active objects.
    let parts = 0;
    const still: RuntimeEntity[] = [];
    for (const e of this.active) {
      const st = e.blast!;
      const tr = simProfiler.now();
      responses.respond('pressure', e, ctx, dt);
      simProfiler.add(`blast.respond.${e.source.type}`, tr);
      if (st.parts) for (const p of st.parts) if (!p.done) parts++;
      if (sr && e.seismic && e.seismic.unit >= 0 && (sr.model.fbx[e.seismic.unit] !== 0 || sr.model.fbz[e.seismic.unit] !== 0)) this.loadedUnits.push(e.seismic.unit);
      const end = st.waves.reduce((m, w) => Math.max(m, w.end), -Infinity);
      const partsDone = (!st.parts || st.parts.every((p) => p.done)) && st.pendingWalls.length === 0;
      const sdofDone = !st.sdof || t0 > end + 0.5;
      if (t0 > end + dt && partsDone && sdofDone && !(e.dynamic && t0 <= end + 0.2)) st.done = true;
      else still.push(e);
    }
    this.active = still;
    const a1 = performance.now();
    const td = simProfiler.now();
    this.debris(ctx, t0, t1, dt);
    simProfiler.add('blast.debris', td);
    if (ctx.interactions && ctx.env.flood.field) this.waterImpulse(ctx, t0, t1);
    this.milestones(ctx, t0);
    const st = ch.stats;
    st.updates++;
    st.objects = this.active.length;
    st.parts = parts;
    st.fieldMs = a0 - w0;
    st.forceMs = a1 - a0;
    st.fieldTotalMs += st.fieldMs;
    st.forceTotalMs += st.forceMs;
    st.totalMs += performance.now() - w0;
  }

  /** Building / wall boxes that can shield (current state: collapsed buildings no longer shield). */
  private shieldIndex(ctx: SystemContext): ShieldIndex {
    const rev = ctx.runtime.debrisRev;
    if (!this.index || rev !== this.indexRev) {
      const boxes: ShieldBox[] = [];
      for (const e of ctx.runtime.entities.values()) {
        if (e.flags.collapsed || e.flags.toppled) continue;
        const o = obstacleFromEntity(e);
        if (o) boxes.push(o);
      }
      this.index = new ShieldIndex(boxes);
      this.indexRev = rev;
    }
    return this.index;
  }

  private addWave(ctx: SystemContext, wi: number) {
    const rec = ctx.env.blast.waves[wi];
    const w = rec.wave;
    const list: Pending[] = [];
    const s = newSample();
    for (const e of ctx.runtime.entities.values()) {
      if (e.def.inert || e.body === null && e.source.type !== 'building') continue;
      const p = e.dynamic ? e.pose.position : e.initialPose.position;
      const c: Vec3 = [p[0], p[1] + e.dims[1] / 2, p[2]];
      // Earliest possible arrival anywhere on the object: centre distance minus its half diagonal.
      const r = Math.max(0, Math.hypot(c[0] - w.init.position[0], c[1] - w.init.position[1], c[2] - w.init.position[2]) - 0.5 * Math.hypot(e.dims[0], e.dims[1], e.dims[2]));
      list.push({ e, t: w.init.time + w.main.at(r, s).t });
    }
    list.sort((a, b) => a.t - b.t);
    this.queues[wi] = { list, next: 0 };
    const id = w.init.name;
    ctx.log(null, 'danger', { key: w.init.kind === 'release' ? 'log.blast.release' : 'log.blast.impactBlast', params: { id, E: fmtEnergy(w.init.energy), h: w.height.toFixed(1) } });
    ctx.milestone?.({ time: w.init.time, kind: 'blastSource', hazard: 'blast', label: { key: 'milestone.blastSource', params: { id, E: fmtEnergy(w.init.energy) } } }, `blastSource:${w.init.id}`);
  }

  private activate(ctx: SystemContext, e: RuntimeEntity, wi: number) {
    if (e.flags.collapsed) return;
    const w = ctx.env.blast.waves[wi].wave;
    const st = (e.blast ??= newBlastState());
    const fresh = st.waves.length === 0;
    const pos = e.dynamic ? e.pose.position : e.initialPose.position;
    const q = e.dynamic ? e.pose.quaternion : e.initialPose.quaternion;
    const faces = boxFaces(pos, e.dims, q, e.areaFactor);
    const centre: Vec3 = faces.center;
    const s0 = w.sample(Math.hypot(centre[0] - w.init.position[0], centre[1] - w.init.position[1], centre[2] - w.init.position[2]));
    const ts = simProfiler.now();
    const sh = shielding(w.init.position, centre, s0.T, w.sourceAmbient.c, ctx.env.terrain, this.shieldIndex(ctx), e.id);
    simProfiler.add('blast.shielding', ts);
    const centreC: Contribution[] = [];
    w.contributions(centre, sh, centreC);
    const statik = !e.dynamic;
    // Drag area of a static object along the strongest wave at its centre (horizontal blast wind).
    let cdA = 0;
    if (statik && centreC.length) {
      const main = centreC.reduce((a, b) => (b.dp > a.dp ? b : a));
      const local = qRotate([-q[0], -q[1], -q[2], q[3]], main.k);
      cdA = e.source.physics.dragCoefficient * projectedArea(e.dims, local) * e.areaFactor;
    }
    const wl: WaveLoad = { wave: wi, shield: sh, faces: statik ? faces : null, loads: [], center: centreC, first: Infinity, end: -Infinity, cdA, tDone: w.init.time };
    if (statik) {
      wl.end = faceLoads(faces, (p, out) => w.contributions(p, sh, out), w.sourceAmbient.c, wl.loads);
      wl.first = wl.loads.reduce((m, l) => Math.min(m, l.a.t), Infinity);
    } else {
      wl.first = centreC.reduce((m, c) => Math.min(m, c.t), Infinity) - 0.5 * Math.hypot(e.dims[0], e.dims[1], e.dims[2]) / w.sourceAmbient.c;
      wl.end = centreC.reduce((m, c) => Math.max(m, c.t + span(c) + 0.05), -Infinity);
    }
    st.waves.push(wl);
    // Object summary: side-on peak / impulse at the centre (all waves so far), exposure, source.
    const all = st.waves.flatMap((x) => x.center);
    const peak = peakOf(all);
    if (peak >= st.peak) st.source = w.init.source;
    st.peak = peak;
    st.impulse = positiveImpulseOf(all);
    st.arrival = Math.min(st.arrival, ...centreC.map((c) => c.t));
    for (const c of centreC) if (ZONE_ORDER[c.zone] > ZONE_ORDER[st.zone]) st.zone = c.zone;
    if (sh.kind !== 'direct' && (st.exposure === 'direct' || sh.il > st.il)) { st.exposure = sh.kind; st.il = sh.il; st.shieldedBy = sh.by; }
    // Structures: the structural model (prepared when the event was scheduled) is activated now.
    const structure = statik && (e.source.type === 'building' || e.source.type === 'streetLight' || e.source.type === 'sign' || e.source.type === 'wall');
    if (structure) {
      ensureSeismicRuntime(ctx.runtime, ctx.env.terrain, GRAVITY, ctx.interactions);
      // Parts are rebuilt with every wave they will see.
      const tp = simProfiler.now();
      if (e.components.length > 1 || e.modular) st.parts = [...buildParts(e, ctx, faces), ...buildWalls(e, ctx, faces)];
      simProfiler.add('blast.buildParts', tp);
    }
    if (fresh || st.done) {
      st.done = false;
      this.active.push(e);
    }
    const rec = ctx.env.blast.waves[wi];
    rec.reached++;
    if (peak > rec.peak) { rec.peak = peak; rec.peakObject = e.id; rec.peakTime = st.arrival; }
    if (st.impulse > rec.impulse) { rec.impulse = st.impulse; rec.impulseObject = e.id; }
    if (rec.reached === 1) {
      ctx.env.blast.events.push({ wave: w.init.id, kind: 'arrival', time: st.arrival, value: peak, object: e.id });
      ctx.milestone?.({ time: st.arrival, kind: 'blastArrival', hazard: 'blast', subject: e.source.type, label: { key: 'milestone.blastArrival', params: { id: w.init.name, p: (peak / 1000).toFixed(2) } } }, `blastArrival:${w.init.id}`);
    }
  }

  /** Debris pieces inside a pulse: impulse + drag through the ledger (as bodies). */
  private debris(ctx: SystemContext, t0: number, t1: number, dt: number) {
    const ch = ctx.env.blast;
    const deb = ctx.runtime.debris;
    if (!deb.length) return;
    const s = newSample();
    for (const d of deb) {
      let any = false;
      J[0] = J[1] = J[2] = 0;
      const Ls: Vec3 = [0, 0, 0];
      let faces = null;
      for (const rec of ch.waves) {
        const w = rec.wave;
        const p = d.pose.position;
        const r = Math.hypot(p[0] - w.init.position[0], p[1] - w.init.position[1], p[2] - w.init.position[2]);
        const smp = w.main.at(Math.max(0, r - 1), s);
        const ta = w.init.time + smp.t;
        const dn = Math.min(smp.dp, 0.3 * smp.p);
        if (t1 < ta || t0 > ta + smp.T + (smp.dp * smp.T) / Math.max(1e-9, dn) + 0.1) continue;
        faces ??= boxFaces([p[0], p[1] - d.size[1] / 2, p[2]], d.size, d.pose.quaternion, 1, true);
        faceLoads(faces, (x, out) => w.contributions(x, NO_SHIELD, out), w.sourceAmbient.c, loads);
        netImpulse(faces, loads, t0, t1, L, P);
        J[0] += L[0]; J[1] += L[1]; J[2] += L[2];
        Ls[0] += P[0]; Ls[1] += P[1]; Ls[2] += P[2];
        const centre: Contribution[] = [];
        w.contributions(faces.center, NO_SHIELD, centre);
        if (centre.length) {
          const main = centre.reduce((a, b) => (b.dp > a.dp ? b : a));
          const q = d.pose.quaternion;
          const local = qRotate([-q[0], -q[1], -q[2], q[3]], main.k);
          const v = ctx.physics.getLinearVelocity(d.body);
          dragImpulse(centre, 1.15 * projectedArea(d.size, local), blastAirDensity(ctx.env, d.pose.position), v, t0, t1, D);
          J[0] += D[0]; J[1] += D[1]; J[2] += D[2];
        }
        any = true;
      }
      if (!any || !faces) continue;
      if (Math.hypot(J[0], J[1], J[2]) < 1e-9) continue;
      const at = pressureCentre(faces, d.size, J, Ls, [0, 0, 0]);
      ctx.forces.forceAtPoint('blast', d.body, [J[0] / dt, J[1] / dt, J[2] / dt], at, d);
    }
  }

  /**
   * Pressure-gradient forcing of the water (interactions): ∫p dt over the step at every wet cell the
   * pulse crosses, accumulated for the next solver call (WaterForcing.airImpulse).
   */
  private waterImpulse(ctx: SystemContext, t0: number, t1: number) {
    const f = ctx.env.flood.field!, forcing = ctx.env.flood.forcing!;
    const ch = ctx.env.blast;
    for (let wi = 0; wi < ch.waves.length; wi++) {
      const rec = ch.waves[wi];
      if (t1 < rec.wave.init.time || t0 > rec.exit + 0.2) continue;
      let wd = this.water.find((x) => x.wave === wi);
      if (!wd) {
        // Contributions at the wet cells, once (the water barely moves during the pulse).
        const cells: number[] = [];
        for (let i = 0; i < f.count; i++) if (f.h[i] > 1e-3) cells.push(i);
        const n = cells.length * 3;
        wd = { wave: wi, cells: Int32Array.from(cells), t: new Float32Array(n).fill(Infinity), dp: new Float32Array(n), dn: new Float32Array(n), T: new Float32Array(n), n: 0, wf: rec.wave.init.waveform };
        const tmp: Contribution[] = [];
        cells.forEach((i, k) => {
          const ix = i % f.nx, iz = (i - ix) / f.nx;
          const p: Vec3 = [f.originX + (ix + 0.5) * f.cell, f.bed[i] + f.h[i], f.originZ + (iz + 0.5) * f.cell];
          tmp.length = 0;
          rec.wave.contributions(p, NO_SHIELD, tmp);
          tmp.slice(0, 3).forEach((c, j) => { wd!.t[k * 3 + j] = c.t; wd!.dp[k * 3 + j] = c.dp; wd!.dn[k * 3 + j] = c.dn ?? c.dp; wd!.T[k * 3 + j] = c.T; });
        });
        this.water.push(wd);
      }
      const buf = forcing.ensureAirImpulse(f.count);
      const a: { t: number; dp: number; T: number; waveform: 'nWave' | 'positive'; dn: number } = { t: 0, dp: 0, T: 0, waveform: wd.wf, dn: 0 };
      for (let k = 0; k < wd.cells.length; k++) {
        let s = 0;
        for (let j = 0; j < 3; j++) {
          const q = k * 3 + j;
          if (wd.dp[q] <= 0 || t1 < wd.t[q]) continue;
          a.t = wd.t[q]; a.dp = wd.dp[q]; a.T = wd.T[q]; a.dn = wd.dn[q];
          if (t0 > a.t + span(a)) continue;
          s += impulse(a, t0, t1);
        }
        if (s !== 0) buf[wd.cells[k]] += s;
      }
    }
  }

  private milestones(ctx: SystemContext, t: number) {
    const ch = ctx.env.blast;
    ch.waves.forEach((rec, wi) => {
      if (this.exited.has(wi) || t < rec.exit) return;
      this.exited.add(wi);
      const id = rec.wave.init.name;
      ch.events.push({ wave: rec.wave.init.id, kind: 'passed', time: rec.exit, value: rec.peak });
      if (rec.peak > 0) {
        ch.events.push({ wave: rec.wave.init.id, kind: 'peak', time: rec.peakTime, value: rec.peak, object: rec.peakObject ?? undefined });
        ch.events.push({ wave: rec.wave.init.id, kind: 'impulse', time: rec.peakTime, value: rec.impulse, object: rec.impulseObject ?? undefined });
        ctx.milestone?.({ time: rec.peakTime, kind: 'blastPeak', hazard: 'blast', label: { key: 'milestone.blastPeak', params: { id, p: (rec.peak / 1000).toFixed(2) } } }, `blastPeak:${rec.wave.init.id}`);
        ctx.milestone?.({ time: rec.peakTime, kind: 'blastImpulse', hazard: 'blast', label: { key: 'milestone.blastImpulse', params: { id, i: rec.impulse.toFixed(0) } } }, `blastImpulse:${rec.wave.init.id}`);
        ctx.log(null, 'warn', { key: 'log.blast.passed', params: { id, p: (rec.peak / 1000).toFixed(2), i: rec.impulse.toFixed(0) } });
      }
    });
    void this.noted;
  }
}

export const fmtEnergy = (E: number) => (E >= 1e12 ? `${(E / 1e12).toFixed(2)} TJ` : E >= 1e9 ? `${(E / 1e9).toFixed(2)} GJ` : E >= 1e6 ? `${(E / 1e6).toFixed(2)} MJ` : `${(E / 1e3).toFixed(1)} kJ`);

export { respondBody };
