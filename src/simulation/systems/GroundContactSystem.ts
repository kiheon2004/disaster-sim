import { groundFrictionFactor } from '@/terrain/GroundMaterials';
import type { SimulationSystem, SystemContext } from './SimulationSystem';

/** Each free body re-samples its ground every ROUNDS steps (6 Hz), staggered by entity order. */
const ROUNDS = 10;
/** Water depth (m) above which the ground counts as wet, and the friction factor of wet ground. */
export const WET_GROUND_DEPTH = 0.005;
export const WET_GRIP = 0.8;

/**
 * Ground-contact friction (Phase 14, prePhysics) — fixes the Phase 12 limitation that a car or
 * person kept the grip of the ground it STARTED on.
 *
 * Every free-standing body (cars, people) looks up the ground type under its CURRENT position
 * and, if the result differs, changes its colliders' friction in place (PhysicsEngine.setFriction
 * — no collider is rebuilt). A wet surface (water ≥ 5 mm) multiplies the grip by WET_GRIP
 * (approximate). The larger flood effect — buoyancy taking weight off the contact — comes from
 * the WaterForceSystem.
 *
 * Unchanged results: on uniform ground with no water the factor never changes, so no call is
 * ever made (the Phase 11–13 golden runs on the flat grass town stay bit-identical). Objects
 * that cross onto a different ground type on painted terrain now grip according to it.
 */
export class GroundContactSystem implements SimulationSystem {
  readonly name = 'groundContact';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['poses', 'water'] as const;
  readonly writes = ['forces'] as const;
  readonly lagged = ['poses'] as const;

  isActive(ctx: SystemContext) {
    return !ctx.env.terrain.uniformGround || ctx.env.flood.field !== null;
  }

  update(ctx: SystemContext) {
    const terrain = ctx.env.terrain;
    const water = ctx.env.flood.field;
    // Uniform default ground and no water: every factor is exactly the initial one.
    if (terrain.uniformGround && !water) return;
    let k = 0;
    for (const e of ctx.runtime.entities.values()) {
      if (e.profile !== 'dynamic' && e.profile !== 'upright') continue;
      if ((k++ + ctx.step) % ROUNDS !== 0) continue;
      if (!e.dynamic || e.body === null) continue;
      const p = e.pose.position;
      let f = groundFrictionFactor(terrain.sampleGroundType(p[0], p[2]));
      if (water && (e.flood?.depth ?? 0) > WET_GROUND_DEPTH) f *= WET_GRIP;
      if (f === e.groundFriction) continue;
      e.groundFriction = f;
      ctx.physics.setFriction(e.body, e.source.physics.friction * f);
    }
  }
}
