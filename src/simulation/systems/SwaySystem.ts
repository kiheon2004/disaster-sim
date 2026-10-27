import { clamp, smoothstep } from '@/core/math';
import type { SimulationSystem, SystemContext } from './SimulationSystem';

/**
 * Visual-only response of anchored objects (postPhysics):
 * trees bend downwind with a damped spring; people brace and lean into the wind.
 */
export class SwaySystem implements SimulationSystem {
  readonly name = 'sway';
  readonly phase = 'postPhysics' as const;

  update({ env, runtime, time }: SystemContext, dt: number) {
    const flow = env.wind.flow();
    // Horizontal axis perpendicular to the flow: positive rotation tips the top downwind.
    const axis: [number, number, number] = [flow[2], 0, -flow[0]];

    for (const e of runtime.entities.values()) {
      const vis = e.visual;
      vis.swayAxis = axis;
      const r = e.loadRatio;

      if (e.source.type === 'tree' && !e.flags.snapped && !e.flags.uprooted) {
        const conifer = e.source.params.species === 'conifer';
        const maxBend = conifer ? 0.14 : 0.2;
        // Permanent lean grows as the trunk weakens.
        const lean = (1 - e.health) * 0.12;
        const target = maxBend * clamp(r / 1.3, 0, 1.2) + lean;
        // Damped spring at the tree's natural frequency (~0.4–0.6 Hz).
        const omega = 2 * Math.PI * (conifer ? 0.55 : 0.42);
        const accel = -omega * omega * (vis.swayAngle - target) - 2 * 0.18 * omega * vis.swayVel;
        vis.swayVel += accel * dt;
        vis.swayAngle += vis.swayVel * dt;
        // Leaf flutter
        vis.swayAngle += Math.sin(time * 9 + e.source.seed) * 0.004 * smoothstep(0.05, 0.5, r);
      } else if (e.source.type === 'human') {
        const target = e.flags.fallen ? 0 : smoothstep(0.12, 0.9, r);
        vis.brace += (target - vis.brace) * Math.min(1, dt * 4);
        // People lean INTO the wind (negative = upwind).
        vis.swayAngle = -0.2 * vis.brace + Math.sin(time * 3.1 + e.source.seed) * 0.03 * vis.brace;
      }
    }
  }
}
