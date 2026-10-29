import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { AIR_DENSITY } from '@/core/units';
import { createGroundMotionSample } from '../seismic/GroundMotionField';
import { WATER_DENSITY } from '../water/waterParams';
import { DOWN_MIN } from '@/gravity/outlook';

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

  /** Phase 29: ∫(p* − mean p*) dt over the call at the wet cells (bilinear in the 5 m columns). */
  private pressureImpulse(ctx: SystemContext, atm: import('../atmosphere/runtime').AtmosphereRuntime, dt: number) {
    const af = atm.field;
    if (af.maxSpeed === 0 && af.maxLayerSpeed === 0) return;
    const wf = ctx.env.flood.solver!.field;
    const mean = af.meanReducedPressure();
    let buf: Float64Array | null = null;
    for (let iz = 0; iz < wf.nz; iz++) for (let ix = 0; ix < wf.nx; ix++) {
      const i = iz * wf.nx + ix;
      if (wf.h[i] <= 0) continue;
      const x = wf.originX + (ix + 0.5) * wf.cell, z = wf.originZ + (iz + 0.5) * wf.cell;
      const gx = Math.max(0, Math.min(af.nx - 1, (x - af.originX) / af.dx - 0.5)), gz = Math.max(0, Math.min(af.nz - 1, (z - af.originZ) / af.dx - 0.5));
      const x0 = Math.min(af.nx - 2, Math.floor(gx)), z0 = Math.min(af.nz - 2, Math.floor(gz));
      if (x0 < 0 || z0 < 0) continue;
      const tx = gx - x0, tz = gz - z0;
      const P = (a: number) => af.sigma[a] * af.red[a] * af.g;
      const a = z0 * af.nx + x0;
      const p = (P(a) * (1 - tx) + P(a + 1) * tx) * (1 - tz) + (P(a + af.nx) * (1 - tx) + P(a + af.nx + 1) * tx) * tz;
      buf ??= ctx.env.flood.forcing!.ensureAirImpulse(wf.count);
      buf[i] += (p - mean) * dt;
    }
  }

  /** Ground velocity at the end of the previous call (map center, reference soil). */
  private lastV: [number, number] = [0, 0];
  private gm = createGroundMotionSample();

  update(ctx: SystemContext, dt: number) {
    const solver = ctx.env.flood.solver;
    if (!solver) return;
    if (ctx.interactions) this.couple(ctx, dt);
    if (ctx.env.gravity.field && !this.gravity(ctx, solver, dt)) return;
    solver.step(dt);
  }

  /** Seconds the water was held (no downward gravity — the free-surface model does not apply, Phase 31). */
  held = 0;
  private cells: { down: Float32Array; x: Float32Array; z: Float32Array } | null = null;

  /**
   * Phase 31: the gravity of this call for the solver — the uniform field's components, or one sample per cell (at the
   * water surface) under a spatial field. Returns false when the water must be HELD: no downward gravity anywhere (the
   * shallow-water model needs water pressed onto its bed; a 3D liquid is not modelled). Held water keeps its state.
   */
  private gravity(ctx: SystemContext, solver: NonNullable<SystemContext['env']['flood']['solver']>, dt: number): boolean {
    const f = ctx.env.gravity.field!, g0 = ctx.env.gravity.g0;
    const G = f.G;
    if (f.uniform) {
      if (-G[1] < DOWN_MIN * g0) { this.held += dt; return false; }
      solver.setGravity(-G[1], G[0], G[2]);
      return true;
    }
    const wf = solver.field;
    const n = wf.count;
    if (!this.cells || this.cells.down.length !== n) this.cells = { down: new Float32Array(n), x: new Float32Array(n), z: new Float32Array(n) };
    const c = this.cells, out: [number, number, number] = [0, 0, 0];
    let any = false;
    for (let iz = 0; iz < wf.nz; iz++) for (let ix = 0; ix < wf.nx; ix++) {
      const i = iz * wf.nx + ix;
      f.sample(wf.originX + (ix + 0.5) * wf.cell, wf.bed[i] + wf.h[i], wf.originZ + (iz + 0.5) * wf.cell, out);
      c.down[i] = Math.max(0, -out[1]);
      c.x[i] = out[0];
      c.z[i] = out[2];
      if (c.down[i] >= DOWN_MIN * g0) any = true;
    }
    if (!any) { this.held += dt; return false; }
    solver.setGravity(-G[1], G[0], G[2], c);
    return true;
  }

  /**
   * Multi-hazard interactions (Phase 15):
   *  - Wind + flood: surface stress τ = ρ_air·C_d·U², C_d = (0.8 + 0.065·U)·10⁻³ (Wu 1982),
   *    along the wind's flow direction — wind setup / drift of the water. Mean stress only:
   *    no waves, no local sheltering by buildings.
   *  - Earthquake + flood: in the ground's frame the water receives −a_g; integrated exactly over
   *    the call as the ground-velocity change Δv_g (map center, reference soil) — no aliasing at
   *    10 Hz, but sloshing faster than ~5 Hz is filtered out.
   *  - Atmosphere (Phase 29, experiments only): the wind stress with the mean air density, and the
   *    atmosphere's surface pressure differences (reduced to the datum) as an impulse on the water
   *    through the Phase 24 air-impulse path (−h·∇∫p dt/ρ_w: inverse-barometer response). A uniform
   *    pressure change does nothing to the water (no gradient) — water never disappears with the air.
   */
  private couple(ctx: SystemContext, dt: number) {
    const f = ctx.env.flood.forcing!;
    const U = ctx.env.wind.baseSpeed;
    const atm = ctx.env.atmosphere.rt;
    if (atm) this.pressureImpulse(ctx, atm, dt);
    if (U > 0.01) {
      const cd = (0.8 + 0.065 * U) * 1e-3;
      const k = ((atm ? atm.meanLayerDensity() : AIR_DENSITY) * cd * U * U) / WATER_DENSITY;
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
