import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { AIR_DENSITY } from '@/core/units';
import { createGroundMotionSample } from '../seismic/GroundMotionField';
import { WATER_DENSITY } from '../water/waterParams';

/**
 * Fixed steps between water solver calls: 6 → 10 Hz, each call covering 0.1 s with as many CFL
 * substeps as the water needs (1 in shallow floods, 2–4 in a few meters of water).
 *
 * This is the one physics-relevant system with interval > 1 (see SimulationSystem): the water
 * is a slow field integrated with its OWN stable time step, and objects keep reading it every
 * 60 Hz step. Running the solver at 60 Hz would cost 6× more for the same water (the substep
 * count is set by the CFL condition, not by the caller). Still deterministic: the schedule
 * depends only on the step counter.
 */
export const WATER_SOLVER_INTERVAL = 6;

/** Advances the water model (prePhysics). Idle — and allocation-free — until a water event starts. */
export class WaterSolverSystem implements SimulationSystem {
  readonly name = 'waterSolver';
  readonly phase = 'prePhysics' as const;
  readonly interval = WATER_SOLVER_INTERVAL;
  readonly reads = ['water', 'airflow', 'groundMotion'] as const;
  readonly writes = ['water'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.flood.solver !== null;
  }

  /** Ground velocity at the end of the previous call (map center, reference soil). */
  private lastV: [number, number] = [0, 0];
  private gm = createGroundMotionSample();

  update(ctx: SystemContext, dt: number) {
    const solver = ctx.env.flood.solver;
    if (!solver) return;
    if (ctx.interactions) this.couple(ctx, dt);
    solver.step(dt);
  }

  /**
   * Multi-hazard interactions (Phase 15):
   *  - Wind + flood: surface stress τ = ρ_air·C_d·U², C_d = (0.8 + 0.065·U)·10⁻³ (Wu 1982),
   *    along the wind's flow direction — wind setup / drift of the water. Mean stress only:
   *    no waves, no local sheltering by buildings.
   *  - Earthquake + flood: in the ground's frame the water receives −a_g; integrated exactly over
   *    the call as the ground-velocity change Δv_g (map center, reference soil) — no aliasing at
   *    10 Hz, but sloshing faster than ~5 Hz is filtered out.
   */
  private couple(ctx: SystemContext, dt: number) {
    const f = ctx.env.flood.forcing!;
    const U = ctx.env.wind.baseSpeed;
    if (U > 0.01) {
      const cd = (0.8 + 0.065 * U) * 1e-3;
      const k = (AIR_DENSITY * cd * U * U) / WATER_DENSITY;
      const flow = ctx.env.wind.flow();
      f.windStress[0] = k * flow[0];
      f.windStress[1] = k * flow[2];
    } else {
      f.windStress[0] = 0;
      f.windStress[1] = 0;
    }
    const gm = ctx.env.groundMotion;
    let vx = 0;
    let vz = 0;
    if (gm.active) {
      gm.reference(ctx.time + dt, this.gm);
      vx = this.gm.v[0];
      vz = this.gm.v[2];
    }
    f.groundDv[0] = vx - this.lastV[0];
    f.groundDv[1] = vz - this.lastV[1];
    this.lastV[0] = vx;
    this.lastV[1] = vz;
  }
}
