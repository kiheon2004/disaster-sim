import { clamp, smoothstep } from '@/core/math';
import type { SimulationSystem, SystemContext } from './SimulationSystem';

/**
 * Visual-only response of anchored objects (postPhysics):
 * trees bend downwind with a damped spring; people brace and lean into the wind.
 */
export class SwaySystem implements SimulationSystem {
  readonly name = 'sway';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['airflow', 'poses'] as const;
  readonly writes = ['damage'] as const;

  update({ env, runtime, time }: SystemContext, dt: number) {
    const global = env.wind.flow();

    for (const e of runtime.entities.values()) {
      const vis = e.visual;
      // Bend along the LOCAL wind direction (veers in wakes / around corners).
      const v = e.localWind.velocity;
      const sp = Math.hypot(v[0], v[2]);
      const fx = sp > 0.1 ? v[0] / sp : global[0];
      const fz = sp > 0.1 ? v[2] / sp : global[2];
      // Horizontal axis perpendicular to the flow: positive rotation tips the top downwind.
      const axis = vis.swayAxis;
      axis[0] = fz;
      axis[1] = 0;
      axis[2] = -fx;
      const r = e.loadRatio;

      if (e.source.type === 'tree' && !e.flags.snapped && !e.flags.uprooted) {
        const conifer = e.source.params.species === 'conifer';
        const maxBend = conifer ? 0.14 : 0.2;
        // Permanent lean grows as the trunk weakens.
        const lean = (1 - e.health) * 0.12;
        const target = maxBend * clamp(r / 1.3, 0, 1.2) + lean;
        // Damped spring at the tree's natural frequency (~0.4–0.6 Hz).
        const omega = 2 * Math.PI * (conifer ? 0.55 : 0.42);
        let accel = -omega * omega * (vis.swayAngle - target) - 2 * 0.18 * omega * vis.swayVel;
        // Earthquake: base excitation — the crown lags behind the moving ground.
        if (e.seismic && e.seismic.shake > 0) {
          const a = e.seismic.ground.a;
          accel -= (a[0] * fx + a[2] * fz) / (0.6 * Math.max(2, e.dims[1]));
        }
        vis.swayVel += accel * dt;
        vis.swayAngle += vis.swayVel * dt;
        // Leaf flutter
        vis.swayAngle += Math.sin(time * 9 + (e.source.seed % 1000)) * 0.004 * smoothstep(0.05, 0.5, r);
      } else if (e.source.type === 'human') {
        let target = e.flags.fallen ? 0 : smoothstep(0.12, 0.9, r);
        // Earthquake: people crouch and brace while the ground shakes.
        if (e.seismic && !e.flags.fallen) target = Math.max(target, smoothstep(0.05, 0.6, e.seismic.shake));
        vis.brace += (target - vis.brace) * Math.min(1, dt * 4);
        // People lean INTO the wind (negative = upwind).
        vis.swayAngle = -0.2 * vis.brace + Math.sin(time * 3.1 + (e.source.seed % 1000)) * 0.03 * vis.brace;
      }
    }
  }
}
