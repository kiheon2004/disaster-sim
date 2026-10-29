/**
 * Headless simulation cost of 1000 modular buildings (earthquake 0.5 g + wind 30 m/s, 5 s) —
 * the bench-buildings scene without rendering, for build-to-build comparisons.
 *
 *   BENCH=1 npx vitest run src/bench/modularSim --silent=false
 */
import { describe, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';

describe.skipIf(!process.env.BENCH)('modular simulation cost', () => {
  it('1000 modular buildings', { timeout: 600_000 }, async () => {
    const d = createEmptyDocument('m');
    const house = createDesign({ ...presetSpec('house')! }, 'house');
    const block = createDesign({ ...presetSpec('apartment')!, width: 12, depth: 10, floors: 4, floorHeight: 3.2, groundFloorHeight: 3.2, core: false }, 'apartment');
    const side = 32, pitch = 190 / side;
    for (let i = 0; i < 1000; i++) {
      const o = createWorldObject({ type: 'building', building: i % 2 ? block : house, seed: i + 1, transform: { position: [-95 + pitch * ((i % side) + 0.5), 0, -95 + pitch * (Math.floor(i / side) + 0.5)], rotation: [0, 0, 0], scale: [1, 1, 1] } }, i + 1);
      d.objects[o.id] = o;
    }
    const rows = [];
    for (let rep = 0; rep < 3; rep++) {
      const c = new SimulationController();
      await c.load(d);
      c.addEvent({ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 2 });
      c.addEvent({ event: 'wind', speed: 30, direction: 'E', duration: 30, gustStrength: 0.25, rampDuration: 2 });
      c.advance(1);
      const t0 = performance.now();
      c.advance(5);
      rows.push(+((performance.now() - t0) / 300).toFixed(2));
      c.unload();
    }
    console.log('MS_PER_STEP', JSON.stringify(rows));
  });
});
