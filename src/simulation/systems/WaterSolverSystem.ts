import type { SimulationSystem, SystemContext } from './SimulationSystem';

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

  update(ctx: SystemContext, dt: number) {
    const solver = ctx.env.flood.solver;
    if (!solver) return;
    solver.step(dt);
  }
}
