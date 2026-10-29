/**
 * Phase 20: simulation step cost of the Phase 19 baseline landscapes (mixedUrbanNatural,
 * mountainValley; rain + wind), headless — for A/B runs against another checkout of the repo
 * (same machine, alternating), free of browser / GPU scheduling noise.
 *
 *   BENCH=1 npx vitest run src/bench/natureTick --silent=false
 */
import { it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { buildEnvironment } from '@/landscape/presets';
import { SimulationController } from '@/simulation/SimulationController';
it.skipIf(!process.env.BENCH)('tick', { timeout: 600_000 }, async () => {
  for (const kind of ['mixedUrbanNatural', 'mountainValley'] as const) {
    const S = useWorldStore.getState;
    S().newDocument();
    const r = buildEnvironment(kind, 1);
    S().applyEdit({ roads: r.roads, landscape: { base: r.base, features: r.features, next: r.next }, add: r.inputs });
    const d = structuredClone(S().doc);
    const times: number[] = [];
    for (let rep = 0; rep < 3; rep++) {
      const c = new SimulationController();
      await c.load(d);
      c.addEvent({ event: 'rain', intensity: 80, duration: 600 });
      c.addEvent({ event: 'wind', speed: 30, direction: 'E', duration: 60, gustStrength: 0.2, rampDuration: 2 });
      c.advance(2);
      const t0 = performance.now();
      c.advance(10);
      times.push(performance.now() - t0);
      c.unload();
    }
    console.log('TICK', kind, times.map((t) => (t / 600).toFixed(2)).join(' '), 'ms/step');
  }
});
