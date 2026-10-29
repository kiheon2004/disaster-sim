/**
 * Thermal physics (Phase 26, postPhysics — after every hazard's damage evaluation, BEFORE the
 * structural collapse engine): every THERMAL_INTERVAL steps (0.1 s) it
 *   1. integrates each heat source exactly over the interval since its last update and deposits it
 *      on the receivers (radiation with view factors, convection into air / rooms, surface heating);
 *   2–3. advances the thermal state (conduction, convection, radiation, water / air heat transport)
 *      with stability-limited sub-steps;
 *   4–6. turns member temperatures into material factors and restrained thermal forces of the
 *      collapse engine (only changes beyond a quantum) — the StructuralCollapseSystem right after it
 *      redistributes the load (one round per step, unchanged), so a heat-weakened member fails only
 *      when its real load exceeds its reduced capacity;
 *   and records exposure, statistics and timeline milestones.
 * Inactive and free until the first heat source (or impact heat deposit): runs without heat are
 * bit-identical to Phase 25.
 *
 * Phase 29: an atmosphere experiment runs here too (it shares the air temperature with the thermal
 * state): its mass / flow step comes first (the volcano's ash, the fire's O₂ and the thermal step read
 * the air it leaves), its gas transport and ledgers after the fire's smoke transport.
 */
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { ThermalRuntime } from '../thermal/runtime';
import { FireRuntime } from '../fire/runtime';
import { VolcanoRuntime } from '../volcano/runtime';
import { AtmosphereRuntime } from '../atmosphere/runtime';
import { ClimateRuntime } from '../climate/runtime';
import { datumState } from '@/events/atmosphere/AtmosphereEvent';
import { simProfiler } from '../profiling/SimProfiler';

/** Thermal solver period in fixed steps (6 × 1/60 s = 0.1 s). Deterministic: the step counter only. */
export const THERMAL_INTERVAL = 6;

export class ThermalSystem implements SimulationSystem {
  readonly name = 'thermal';
  readonly phase = 'postPhysics' as const;
  readonly interval = THERMAL_INTERVAL;
  readonly reads = ['temperature', 'water', 'airflow', 'poses', 'structure', 'debris'] as const;
  readonly writes = ['temperature', 'structure', 'exposure', 'damage'] as const;
  /** Debris of this step is placed after the collapse system; the thermal state follows it next time. */
  readonly lagged = ['debris', 'structure'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.thermal.active || ctx.env.fire.active || ctx.env.volcano.active || ctx.env.atmosphere.active || ctx.env.climate.active;
  }

  update(ctx: SystemContext, dt: number) {
    const t0 = simProfiler.now();
    const w0 = performance.now();
    const ch = ctx.env.thermal;
    const ac = ctx.env.atmosphere;
    // Phase 29: the thermal reference IS the atmosphere's datum temperature when the experiment comes first.
    if (!ch.rt && !ac.rt) {
      const first = ac.experiments.find((r) => !r.done && AtmosphereRuntime.reject(r, null) === null);
      if (first) ch.settings.ambient = datumState(first.spec).T;
      // Phase 30: likewise the climate's start temperature when the climate experiment comes first.
      else {
        const cl = ctx.env.climate.experiments.find((r) => !r.done && ClimateRuntime.reject(r, null) === null);
        if (cl) ch.settings.ambient = cl.spec.temperature;
      }
    }
    if (!ch.rt) {
      ch.rt = new ThermalRuntime(ctx);
      for (const s of ch.sources) ctx.milestone?.({ time: s.start, kind: 'heatSource', hazard: 'thermal', subject: 'heatSource', label: { key: 'milestone.heatSource', params: { id: s.name, kind: s.spec.kind } } }, `heat:${s.id}`);
    }
    const rt = ch.rt;
    for (const s of ch.sources) ctx.milestone?.({ time: s.start, kind: 'heatSource', hazard: 'thermal', subject: 'heatSource', label: { key: 'milestone.heatSource', params: { id: s.name, kind: s.spec.kind } } }, `heat:${s.id}`);
    const steps = rt.prepare(ctx, dt);
    for (const rec of ac.experiments) {
      if (rec.done || rec.start >= ctx.time + dt) continue;
      rec.done = true;
      rec.reason = AtmosphereRuntime.reject(rec, ac.rt);
      if (rec.reason) {
        ctx.milestone?.({ time: ctx.time, kind: 'atmosRejected', subject: 'atmosphere', label: { key: 'milestone.atmosRejected', params: { id: rec.name, reason: rec.reason } } }, `atmos:reject:${rec.id}`);
        ctx.log(null, 'warn', { key: 'log.atmos.rejected', params: { id: rec.name, reason: rec.reason } });
      } else ac.rt = new AtmosphereRuntime(ctx, rec, rt);
    }
    const atmos = ac.rt;
    if (atmos) {
      const ta = simProfiler.now();
      atmos.prepare(ctx, dt);
      simProfiler.add('atmosphere.prepare', ta);
    }
    // Phase 30: the climate (created with its experiment) — after the atmosphere (it reads the pressure / flow /
    // removal), before the volcano and fire (they read the air and surfaces it forces).
    const cc = ctx.env.climate;
    for (const rec of cc.experiments) {
      if (rec.done || rec.start >= ctx.time + dt) continue;
      rec.done = true;
      rec.reason = ClimateRuntime.reject(rec, cc.rt);
      if (rec.reason) {
        ctx.milestone?.({ time: ctx.time, kind: 'climateRejected', subject: 'climate', label: { key: 'milestone.climateRejected', params: { id: rec.name, reason: rec.reason } } }, `climate:reject:${rec.id}`);
        ctx.log(null, 'warn', { key: 'log.climate.rejected', params: { id: rec.name, reason: rec.reason } });
      } else cc.rt = new ClimateRuntime(ctx, rec, rt);
    }
    const climate = cc.rt;
    if (climate) {
      const tc = simProfiler.now();
      steps.push(...climate.prepare(ctx, dt));
      simProfiler.add('climate.prepare', tc);
    }
    // Phase 28: the volcano (created with the first eruption) — its heat joins the step's sources
    // before the fire model reads the incident fluxes, so lava heat is judged by the normal ignition rules.
    const vc = ctx.env.volcano;
    if (!vc.rt && vc.eruptions.length) vc.rt = new VolcanoRuntime(ctx, rt);
    const volcano = vc.rt;
    if (volcano) {
      const tv = simProfiler.now();
      steps.push(...volcano.prepare(ctx, dt));
      simProfiler.add('volcano.prepare', tv);
    }
    // Phase 27: combustion on top of the thermal state (created with the first ignition; with a volcano
    // the combustion model runs too — lava heat may ignite fuel).
    const fc = ctx.env.fire;
    if (!fc.rt && (fc.wanted() || volcano)) fc.rt = new FireRuntime(ctx, rt);
    const fire = fc.rt;
    if (fire && volcano) volcano.attachFire(fire);
    if (fire) {
      const tf = simProfiler.now();
      steps.push(...fire.prepare(ctx, dt, steps));
      simProfiler.add('fire.combustion', tf);
    }
    const t1 = simProfiler.now();
    rt.world.step(dt, steps);
    simProfiler.add('thermal.solve', t1);
    if (fire) {
      const tf = simProfiler.now();
      fire.after(ctx, dt);
      simProfiler.add('fire.after', tf);
    }
    if (atmos) {
      const ta = simProfiler.now();
      atmos.after(ctx, dt);
      simProfiler.add('atmosphere.after', ta);
    }
    if (climate) {
      const tc = simProfiler.now();
      climate.after(ctx, dt);
      simProfiler.add('climate.after', tc);
    }
    if (volcano) {
      const tv = simProfiler.now();
      volcano.after(ctx, dt);
      simProfiler.add('volcano.after', tv);
    }
    const t2 = simProfiler.now();
    rt.after(ctx);
    simProfiler.add('thermal.couple', t2);
    simProfiler.add('thermal.total', t0);
    rt.ms = performance.now() - w0;
    rt.msTotal += rt.ms;
  }
}
