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
 */
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { ThermalRuntime } from '../thermal/runtime';
import { FireRuntime } from '../fire/runtime';
import { VolcanoRuntime } from '../volcano/runtime';
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
    return ctx.env.thermal.active || ctx.env.fire.active || ctx.env.volcano.active;
  }

  update(ctx: SystemContext, dt: number) {
    const t0 = simProfiler.now();
    const w0 = performance.now();
    const ch = ctx.env.thermal;
    if (!ch.rt) {
      ch.rt = new ThermalRuntime(ctx);
      for (const s of ch.sources) ctx.milestone?.({ time: s.start, kind: 'heatSource', hazard: 'thermal', subject: 'heatSource', label: { key: 'milestone.heatSource', params: { id: s.name, kind: s.spec.kind } } }, `heat:${s.id}`);
    }
    const rt = ch.rt;
    for (const s of ch.sources) ctx.milestone?.({ time: s.start, kind: 'heatSource', hazard: 'thermal', subject: 'heatSource', label: { key: 'milestone.heatSource', params: { id: s.name, kind: s.spec.kind } } }, `heat:${s.id}`);
    const steps = rt.prepare(ctx, dt);
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
