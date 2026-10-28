import type { SimulationSystem, SystemContext } from './SimulationSystem';

/** Cheap kinematic particles (leaves, glass shards) carried by the wind; no physics bodies. */
export class ParticleSystem implements SimulationSystem {
  readonly name = 'particles';
  readonly phase = 'postPhysics' as const;

  private step = 0;

  update({ runtime, env, time }: SystemContext, dt: number) {
    const ps = runtime.particles;
    this.step = (this.step + 1) % 4;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const leaf = p.kind === 'leaf';
      const onGround = p.position[1] <= 0.02;
      if (!p.wind || (i & 3) === this.step) p.wind = env.windField.velocityAt(p.position, time) as [number, number, number];
      const wv = p.wind;
      // Relax toward the wind velocity (light leaves follow it closely, glass less so).
      const k = (leaf ? 1.6 : 0.5) * (onGround ? 0.25 : 1);
      p.velocity[0] += (wv[0] - p.velocity[0]) * Math.min(1, k * dt);
      p.velocity[2] += (wv[2] - p.velocity[2]) * Math.min(1, k * dt);
      p.velocity[1] -= (leaf ? 2.2 : 9.81) * dt;
      if (leaf) p.velocity[1] += Math.sin(time * 5 + i) * 1.5 * dt; // flutter
      p.position[0] += p.velocity[0] * dt;
      p.position[1] += p.velocity[1] * dt;
      p.position[2] += p.velocity[2] * dt;
      if (p.position[1] < 0.02) {
        p.position[1] = 0.02;
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
  }
}
