import { GRAVITY } from '@/core/units';
import type { Vec3 } from '@/core/types';
import { createGroundMotionSample } from '../seismic/GroundMotionField';
import { ensureSeismicRuntime } from '../seismic/SeismicState';
import type { SimulationSystem, SystemContext } from './SimulationSystem';

const debrisMotion = createGroundMotionSample();
const force: Vec3 = [0, 0, 0];
/** Ground acceleration (m/s²) at which the visual "shaking" channel saturates. */
const SHAKE_FULL = 0.35 * GRAVITY;

/**
 * Ground shaking on free bodies (prePhysics, Phase 13).
 *
 * The rigid-body world is simulated in the GROUND's frame: the ground displacement is a few
 * centimeters, so instead of moving the terrain collider we apply the equivalent inertial
 * (d'Alembert) force −m·a_g(x, t) through the center of mass of every dynamic body — cars,
 * people, debris, toppled poles. Sliding (|a_g| > μg), rocking and toppling then come out of
 * the existing Rapier contact/friction solution; nothing is scripted. The vertical component
 * modulates effective gravity (and friction) the same way.
 *
 * Also samples the ground motion at every reacting object's base for the structural, damage
 * and visual systems. Does nothing (and allocates nothing) while no earthquake is active.
 */
export class SeismicForceSystem implements SimulationSystem {
  readonly name = 'groundMotion';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['groundMotion', 'poses'] as const;
  readonly writes = ['forces', 'structure'] as const;
  readonly lagged = ['poses'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.groundMotion.active || ctx.runtime.seismic?.wasActive === true;
  }

  update(ctx: SystemContext, dt: number) {
    const gm = ctx.env.groundMotion;
    const rt = ctx.runtime;
    if (!gm.active) {
      if (rt.seismic?.wasActive) this.settle(ctx, dt);
      return;
    }
    const sr = ensureSeismicRuntime(rt, ctx.env.terrain, GRAVITY, ctx.interactions);
    sr.wasActive = true;
    const { physics, time } = ctx;
    const ease = Math.min(1, dt * 10);
    for (const e of sr.entities) {
      const st = e.seismic!;
      const p = e.dynamic ? e.pose.position : e.initialPose.position;
      const g = gm.sample(p[0], p[2], time, st.ground);
      const ax = g.a[0];
      const az = g.a[2];
      const ah = Math.sqrt(ax * ax + az * az);
      if (ah > st.pga) st.pga = ah;
      st.shake += (Math.min(1, ah / SHAKE_FULL) - st.shake) * ease;
      if (ah > 1e-6) {
        st.shakeDir[0] = ax / ah;
        st.shakeDir[1] = az / ah;
      }
      if (!e.dynamic || e.body === null) continue;
      const m = physics.getMass(e.body);
      force[0] = -m * ax;
      force[1] = -m * g.a[1];
      force[2] = -m * az;
      ctx.forces.force('groundMotion', e.body, force, e);
    }
    for (const d of rt.debris) {
      const g = gm.sample(d.pose.position[0], d.pose.position[2], time, debrisMotion);
      const m = physics.getMass(d.body);
      force[0] = -m * g.a[0];
      force[1] = -m * g.a[1];
      force[2] = -m * g.a[2];
      ctx.forces.force('groundMotion', d.body, force, d);
    }
  }

  /** After the shaking ends: zero the base motion and let the visual channel fade. */
  private settle(ctx: SystemContext, dt: number) {
    const sr = ctx.runtime.seismic!;
    let any = false;
    for (const e of sr.entities) {
      const st = e.seismic!;
      const g = st.ground;
      g.a[0] = g.a[1] = g.a[2] = g.v[0] = g.v[1] = g.v[2] = g.d[0] = g.d[1] = g.d[2] = 0;
      st.shake *= Math.max(0, 1 - dt * 3);
      if (st.shake > 1e-3) any = true;
      else st.shake = 0;
    }
    if (!any) sr.wasActive = false;
  }
}
