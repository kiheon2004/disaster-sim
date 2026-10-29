import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { createGroundMotionSample, horizontal } from '../seismic/GroundMotionField';
import { crackThreshold, ROAD_IMPASSABLE, ROAD_INUNDATED, ROAD_SEVERE, scourThreshold, type RoadRuntime } from '../roads/RoadRuntime';

/** Segments are evaluated in staggered rounds (each every ROUNDS steps with ROUNDS × dt): 20 Hz. */
export const ROAD_ROUNDS = 3;
const gm = createGroundMotionSample();
const vel: [number, number] = [0, 0];

/**
 * Road surface damage (Phase 18, postPhysics). Reads the ground motion (earthquake) and the
 * water field (flood) at each segment's sample points; writes only the road runtime state
 * (cracks, inundation, scour) and log entries. Idle without roads or without a running hazard.
 * See simulation/roads/RoadRuntime.ts for the criteria and their limits.
 */
export class RoadSystem implements SimulationSystem {
  readonly name = 'roads';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['groundMotion', 'water'] as const;
  readonly writes = ['damage'] as const;

  isActive(ctx: SystemContext) {
    const r = ctx.runtime.roads;
    return !!r && !r.empty && (ctx.env.groundMotion.active || ctx.env.flood.field !== null || !!r.groundFailure);
  }

  update(ctx: SystemContext, dt: number) {
    const roads = ctx.runtime.roads as RoadRuntime;
    const quake = ctx.env.groundMotion.active;
    const field = ctx.env.flood.field;
    const rdt = dt * ROAD_ROUNDS;
    const list = roads.segments;
    for (let i = ctx.step % ROAD_ROUNDS; i < list.length; i += ROAD_ROUNDS) {
      const st = list[i];
      if (quake || roads.groundFailure) {
        let pgv = 0;
        let offset = 0;
        for (const p of st.samples) {
          if (quake) pgv = Math.max(pgv, horizontal(ctx.env.groundMotion.sample(p.x, p.z, ctx.time, gm).v));
          if (roads.groundFailure) offset = Math.max(offset, roads.groundFailure.offset(p.x, p.z, ctx.time));
        }
        st.peakPgv = Math.max(st.peakPgv, pgv);
        const thr = crackThreshold(st);
        // Crack index: 0 at the threshold PGV, 1 at twice the threshold (or 10 cm ground offset).
        const crack = Math.min(1, Math.max(pgv > thr ? (pgv - thr) / thr : 0, offset / 0.1));
        if (crack > st.crack) {
          st.crack = crack;
          roads.rev++;
          if (crack >= 0.05 && roads.mark(st, 'cracked', ctx.time, st.peakPgv)) ctx.log(null, 'warn', { key: 'log.road.cracked', params: { id: st.id, v: st.peakPgv.toFixed(2) } });
          if (crack >= ROAD_SEVERE && roads.mark(st, 'severe', ctx.time, st.peakPgv)) ctx.log(null, 'danger', { key: 'log.road.severe', params: { id: st.id } });
        }
      }
      if (field) {
        let crown = 0, speed = 0;
        for (const p of st.samples) {
          const d = field.sampleDepth(p.x, p.z);
          if (d > crown) crown = d;
          if (d > 0.02) {
            field.sampleVelocity(p.x, p.z, vel);
            speed = Math.max(speed, Math.hypot(vel[0], vel[1]));
          }
        }
        let depth = crown;
        for (const p of st.gutters) {
          const d = field.sampleDepth(p.x, p.z);
          if (d > depth) depth = d;
        }
        const changed = Math.abs(depth - st.depth) > 0.01 || Math.abs(crown - st.crownDepth) > 0.01;
        st.depth = depth;
        st.crownDepth = crown;
        st.speed = speed;
        if (depth > st.maxDepth) st.maxDepth = depth;
        if (crown > st.maxCrownDepth) st.maxCrownDepth = crown;
        if (depth >= ROAD_INUNDATED) st.floodTime += rdt;
        if (changed) roads.rev++;
        if (depth >= ROAD_INUNDATED && roads.mark(st, 'inundated', ctx.time, depth)) ctx.log(null, 'warn', { key: 'log.road.inundated', params: { id: st.id, m: depth.toFixed(2) } });
        if (crown >= ROAD_IMPASSABLE && roads.mark(st, 'impassable', ctx.time, crown)) ctx.log(null, 'danger', { key: 'log.road.impassable', params: { id: st.id, m: crown.toFixed(2) } });
        // Scour: sustained flow above the material's permissible speed (like Phase 14 road objects).
        const vs = scourThreshold(st);
        if (speed > vs && depth > 0.05 && st.scour < 1) {
          st.scour = Math.min(1, st.scour + ((speed / vs) ** 2 - 1) * (rdt / 300));
          roads.rev++;
          if (st.scour >= 1 && roads.mark(st, 'scoured', ctx.time, speed)) ctx.log(null, 'danger', { key: 'log.road.scoured', params: { id: st.id } });
        }
      }
    }
  }
}
