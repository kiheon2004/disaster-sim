import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { createLocalWind } from '../wind/SpatialWindField';

const scratch = createLocalWind();

/**
 * Cheap kinematic particles (leaves, glass shards) carried by the wind; no physics bodies.
 * Purely visual (never read by physics or damage), so it runs at 30 Hz; the renderer
 * extrapolates positions between updates.
 */
export class ParticleSystem implements SimulationSystem {
  readonly name = 'particles';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['particles', 'airflow'] as const;
  readonly writes = ['particles'] as const;
  readonly interval = 2;

  private step = 0;

  update({ runtime, env, time }: SystemContext, dt: number) {
    const ps = runtime.particles;
    // Each particle re-samples the wind every 2nd update (15 Hz), staggered.
    this.step = (this.step + 1) % 2;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const leaf = p.kind === 'leaf';
      const dust = p.kind === 'dust';
      const ground = env.terrain.sampleHeight(p.position[0], p.position[2]) + 0.02;
      const onGround = p.position[1] <= ground;
      if (!p.wind || (i & 1) === this.step) {
        const v = env.windField.sample(p.position, time, undefined, undefined, scratch).velocity;
        const pw = (p.wind ??= [0, 0, 0]);
        pw[0] = v[0]; pw[1] = v[1]; pw[2] = v[2];
      }
      const wv = p.wind;
      // Relax toward the wind velocity (light leaves follow it closely, glass less so).
      const k = (leaf ? 1.6 : dust ? 1.2 : 0.5) * (onGround ? 0.25 : 1);
      p.velocity[0] += (wv[0] - p.velocity[0]) * Math.min(1, k * dt);
      p.velocity[2] += (wv[2] - p.velocity[2]) * Math.min(1, k * dt);
      // Dust settles slowly (fine particles, drag-dominated); visual only.
      p.velocity[1] = dust ? p.velocity[1] + (-0.15 - p.velocity[1]) * Math.min(1, 1.5 * dt) : p.velocity[1] - (leaf ? 2.2 : 9.81) * dt;
      if (leaf) p.velocity[1] += Math.sin(time * 5 + i) * 1.5 * dt; // flutter
      p.position[0] += p.velocity[0] * dt;
      p.position[1] += p.velocity[1] * dt;
      p.position[2] += p.velocity[2] * dt;
      if (p.position[1] < ground) {
        p.position[1] = ground;
        p.velocity[1] = 0;
        p.velocity[0] *= 0.9;
        p.velocity[2] *= 0.9;
      }
      p.rotation[0] += p.spin[0] * dt;
      p.rotation[1] += p.spin[1] * dt;
      p.rotation[2] += p.spin[2] * dt;
      ps[w++] = p;
    }
    ps.length = w;
    runtime.particlesTime = time + dt;
  }
}
