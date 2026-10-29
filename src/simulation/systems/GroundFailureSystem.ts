/**
 * Ground failure (Phase 22, prePhysics — right BEFORE the DeformationSystem).
 *
 * Every fixed step: Newmark sliding of the landslide areas under the current ground acceleration
 * (earthquakes are sampled at 60 Hz; a 10 Hz sampling would miss the peaks).
 * Every DEFORM_INTERVAL steps (10 Hz, the same steps as the deformation engine and the water
 * solver): water tables from infiltration, sinkhole roofs and pits, landslide stability and
 * failures, the granular runout over the interval, the sediment budget, object responses to
 * sediment, road blockage, timeline events. The resulting field (bed + mobile layer) is applied
 * to the terrain by the DeformationSystem in the SAME step (one atomic terrain / collider / water
 * bed / foundation / road update, Phase 21).
 *
 * Reads the terrain as last applied, last step's water and the ground motion of this step.
 */
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { DEFORM_INTERVAL } from './DeformationSystem';
import type { GroundEnv } from '@/ground/common';
import { areaCentroid } from '@/ground/common';
import { flowStep, XI_DEFAULT } from '@/ground/granular';
import { createGroundMotionSample } from '../seismic/GroundMotionField';
import { footprint, stateOf, CONTACT_LOST } from '../deformation/response';
import { respondToSediment } from '../ground/objects';
import type { GroundFailureChannel } from '../ground/GroundFailureChannel';
import { gammaW, gNow } from '@/ground/materials';

const gm = createGroundMotionSample();
/** Loose material on a road thicker than this blocks ordinary vehicles (same as the Phase 21 step). */
export const ROAD_BLOCK_DEPTH = 0.3;

export class GroundFailureSystem implements SimulationSystem {
  readonly name = 'groundFailure';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['terrain', 'water', 'groundMotion', 'poses'] as const;
  readonly writes = ['terrain', 'damage'] as const;
  readonly lagged = ['terrain', 'water', 'poses'] as const;
  private structures: Float32Array | null = null;
  private reported = new Set<string>();

  isActive(ctx: SystemContext) {
    return ctx.env.groundFailure.active;
  }

  update(ctx: SystemContext, dt: number) {
    const ch = ctx.env.groundFailure;
    const f = ch.field!;
    const st = ch.stats;
    // Newmark sliding: every step while the ground shakes.
    const quake = ctx.env.groundMotion;
    if (quake.active && ch.landslides.length) {
      const t0 = performance.now();
      for (const m of ch.landslides) {
        if (ctx.time < m.startTime) continue;
        const [cx, cz] = areaCentroid(m.spec.area);
        quake.sample(cx, cz, ctx.time, gm);
        m.newmark(gm.a[0], gm.a[2], dt);
      }
      st.newmarkMs = performance.now() - t0;
    }
    if (ctx.step % DEFORM_INTERVAL !== 0) return;
    const a = performance.now();
    ch.urgent = false;
    const H = ctx.env.terrain.data.heights;
    const env = this.environment(ctx, ch, H);
    // Sinkholes.
    for (const m of ch.sinkholes) {
      const before = m.events.length;
      m.update(ctx.time - m.startTime, ctx.time, env);
      for (const ev of m.events.slice(before)) this.sinkholeEvent(ctx, ch, m.name, ev.kind, ev.value);
    }
    const b = performance.now();
    // Landslides.
    for (const m of ch.landslides) {
      const before = m.events.length;
      m.update(ctx.time - m.startTime, ctx.time, env);
      for (const ev of m.events.slice(before)) this.landslideEvent(ctx, m.name, ev.kind, ev.value);
    }
    const c = performance.now();
    // Runout over the interval.
    const fl = flowStep(f, DEFORM_INTERVAL * dt, { ground: env.ground, xi: Number.isFinite(ch.turbulence) ? ch.turbulence : XI_DEFAULT, boundary: ch.boundary });
    f.closeBudget(ctx.time);
    const d = performance.now();
    st.flowSubsteps = fl.substeps;
    st.maxSpeed = fl.maxSpeed;
    st.flowCells = fl.cells;
    // Peak transport: the moving volume fell clearly below its maximum.
    const bud = f.budget;
    if (bud.peakMobile > 1 && bud.mobile < 0.8 * bud.peakMobile) {
      ctx.milestone?.({ time: bud.peakTime, kind: 'peakSediment', hazard: 'ground', label: { key: 'milestone.peakSediment', params: { v: Math.round(bud.peakMobile) } } }, 'peakSediment');
    }
    // Objects, roads, foundations.
    let objects = 0;
    if (bud.released > 0 || bud.intoCavity > 0) {
      objects = respondToSediment(ctx, ch, DEFORM_INTERVAL * dt);
      this.roads(ctx, ch);
      this.foundations(ctx, ch);
    }
    const e = performance.now();
    st.updates++;
    st.sinkholeMs = b - a;
    st.stabilityMs = c - b;
    st.flowMs = d - c;
    st.objectsMs = e - d;
    st.totalMs += e - a;
    void objects;
  }

  /** What the models read from the run. */
  private environment(ctx: SystemContext, ch: GroundFailureChannel, H: Float32Array): GroundEnv {
    const f = ch.field!, src = ch.source!;
    const wf = ctx.env.flood.field;
    // Phase 31: the footprint pressures follow the step's gravity (rebuilt when it changed).
    if (this.structuresG !== gNow()) { this.structures = null; this.structuresG = gNow(); }
    const structures = (this.structures ??= this.structureLoads(ctx, ch));
    const A = f.dx * f.dx;
    const cell = (i: number) => {
      const ix = i % f.nx, iz = (i - ix) / f.nx;
      return Math.min(iz, wf!.nz - 1) * wf!.nx + Math.min(ix, wf!.nx - 1);
    };
    return {
      ground: (i) => H[i] - src.applied[i] + f.bed[i],
      infiltrated: (i) => (wf ? wf.infiltrated[cell(i)] : 0),
      surcharge: (i) => structures[i] + (wf ? gammaW() * wf.h[cell(i)] : 0) + ((f.looseMass[i] + f.mass[i]) / A) * gNow() / 1000,
    };
  }

  /** Foundation pressure of every building on its footprint vertices (kPa), once per run. */
  private structuresG = NaN;

  private structureLoads(ctx: SystemContext, ch: GroundFailureChannel): Float32Array {
    const f = ch.field!;
    const q = new Float32Array(f.n);
    for (const e of ctx.runtime.entities.values()) {
      if (e.source.type !== 'building') continue;
      const { hx, hz, yaw } = footprint(e);
      const [x0, , z0] = e.initialPose.position;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const p = (e.source.physics.mass * gNow()) / (4 * hx * hz) / 1000;
      const r = Math.hypot(hx, hz);
      for (let iz = Math.max(0, Math.floor((z0 - r - f.originZ) / f.dx)); iz <= Math.min(f.nz - 1, Math.ceil((z0 + r - f.originZ) / f.dx)); iz++) {
        for (let ix = Math.max(0, Math.floor((x0 - r - f.originX) / f.dx)); ix <= Math.min(f.nx - 1, Math.ceil((x0 + r - f.originX) / f.dx)); ix++) {
          const dx = f.originX + ix * f.dx - x0, dz = f.originZ + iz * f.dx - z0;
          const lx = dx * c - dz * s, lz = dx * s + dz * c;
          if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) q[iz * f.nx + ix] += p;
        }
      }
    }
    return q;
  }

  private sinkholeEvent(ctx: SystemContext, ch: GroundFailureChannel, name: string, kind: string, value: number) {
    const t = ctx.time;
    if (kind === 'initiation') {
      ctx.log(null, 'danger', { key: 'log.ground.sinkholeInit', params: { id: name, fs: value.toFixed(2) } });
      ctx.milestone?.({ time: t, kind: 'sinkholeInit', hazard: 'ground', subject: 'sinkhole', label: { key: 'milestone.sinkholeInit', params: { id: name } } }, `sinkInit:${name}`);
      ctx.milestone?.({ time: t, kind: 'supportLoss', hazard: 'ground', label: { key: 'milestone.supportLoss' } }, 'supportLoss');
    } else if (kind === 'choked') {
      ctx.log(null, 'warn', { key: 'log.ground.sinkholeChoked', params: { id: name } });
    } else if (kind === 'collapsed') {
      ctx.log(null, 'danger', { key: 'log.ground.sinkholeCollapsed', params: { id: name, d: value.toFixed(2) } });
    } else if (kind === 'expansion') {
      ctx.log(null, 'warn', { key: 'log.ground.sinkholeExpanded', params: { id: name, r: value.toFixed(1) } });
      ctx.milestone?.({ time: t, kind: 'sinkholeExpansion', hazard: 'ground', subject: 'sinkhole', label: { key: 'milestone.sinkholeExpansion', params: { id: name, r: value.toFixed(1) } } }, `sinkExp:${name}:${Math.round(value)}`);
    }
    void ch;
  }

  private landslideEvent(ctx: SystemContext, name: string, kind: string, value: number) {
    const t = ctx.time;
    if (kind === 'instability') {
      ctx.log(null, 'warn', { key: 'log.ground.slopeInstability', params: { id: name, fs: value.toFixed(2) } });
      ctx.milestone?.({ time: t, kind: 'slopeInstability', hazard: 'ground', subject: 'landslide', label: { key: 'milestone.slopeInstability', params: { id: name } } }, `slope:${name}`);
    } else if (kind === 'initiation') {
      ctx.log(null, 'danger', { key: 'log.ground.landslide', params: { id: name, n: value } });
      ctx.milestone?.({ time: t, kind: 'landslideInit', hazard: 'ground', subject: 'landslide', label: { key: 'milestone.landslideInit', params: { id: name } } }, `slide:${name}`);
    } else if (kind === 'retrogression' && !this.reported.has(`retro:${name}`)) {
      this.reported.add(`retro:${name}`);
      ctx.log(null, 'warn', { key: 'log.ground.retrogression', params: { id: name } });
    }
  }

  /** Roads under loose material: blocked (the network itself is never edited). */
  private roads(ctx: SystemContext, ch: GroundFailureChannel) {
    const roads = ctx.runtime.roads;
    const src = ch.source!;
    if (!roads) return;
    for (const rs of roads.segments) {
      let debris = 0;
      for (const p of rs.samples) debris = Math.max(debris, src.overburdenAt(p.x, p.z));
      if (debris <= 0.01 && !rs.deform?.debris) continue;
      rs.deform ??= { offset: 0, grade: 0, grade0: 0, settlement: 0, passable: true };
      if (debris > (rs.deform.debris ?? 0)) {
        rs.deform.debris = debris;
        roads.rev++;
      }
      // Blocked by the deposit — also when the height change already made it impassable (the
      // deformation step check runs on the same surface): the cause is recorded once.
      if (debris >= ROAD_BLOCK_DEPTH && !this.reported.has(`road:${rs.id}`)) {
        this.reported.add(`road:${rs.id}`);
        rs.deform.passable = false;
        roads.rev++;
        roads.mark(rs, 'impassable', ctx.time, debris);
        {
          ctx.log(null, 'danger', { key: 'log.ground.roadBlocked', params: { id: rs.id, m: debris.toFixed(2) } });
          ctx.milestone?.({ time: ctx.time, kind: 'roadBlocked', hazard: 'ground', label: { key: 'milestone.roadBlocked', params: { id: rs.id } } }, `roadBlocked:${rs.id}`);
        }
      }
    }
  }

  /** Buildings that lost their foundation support on failing ground (once each). */
  private foundations(ctx: SystemContext, ch: GroundFailureChannel) {
    const f = ch.field!;
    for (const e of ctx.runtime.entities.values()) {
      if (e.source.type !== 'building' || !e.ground) continue;
      const g = e.ground;
      if (g.noted.has('foundationFailure')) continue;
      const i = f.index(e.initialPose.position[0], e.initialPose.position[2]);
      const onFailure = i >= 0 && (f.owner[i] >= 0 || f.bed[i] < -0.05 || f.loose[i] > 0.05);
      if (!onFailure) continue;
      if (g.minContact < CONTACT_LOST || g.damage >= 1 || g.bearingRatio > 1) {
        g.noted.add('foundationFailure');
        stateOf(e).source ??= undefined;
        ctx.log(e.id, 'danger', { key: 'log.ground.foundationFailure', params: { pct: Math.round(g.minContact * 100) } });
        ctx.milestone?.({ time: ctx.time, kind: 'foundationFailure', hazard: 'ground', subject: 'building', label: { key: 'milestone.foundationFailure' } }, `found:${e.id}`);
      }
    }
  }
}
