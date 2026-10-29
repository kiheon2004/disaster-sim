import { describe, expect, it } from 'vitest';
import { SimulationController } from '../SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { defaultWaterSettings, type WorldDocument } from '@/core/model';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField } from '../water/WaterField';
import { captureWaterState } from '../water/waterStateCodec';
import { canopyFactor } from './vegetation';

function forest(veg?: { canopyShelter: boolean; floodResponse: boolean }): WorldDocument {
  const d = createEmptyDocument('forest');
  for (let x = -40; x <= 40; x += 5) for (let z = -20; z <= 20; z += 5) {
    const o = createWorldObject({ type: 'tree', seed: x * 100 + z, params: { species: 'broadleaf', height: 9, canopyRadius: 2.8, trunkRadius: 0.28 }, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } }, nextSerial(d.objects, 'tree'));
    d.objects[o.id] = o;
  }
  if (veg) d.settings.simulation.vegetation = veg;
  return d;
}

describe('vegetation (opt-in)', { timeout: 240_000 }, () => {
  it('canopy shelter: windward edge trees keep the full wind, interior trees less; off = no factors', async () => {
    const c = new SimulationController();
    await c.load(forest({ canopyShelter: true, floodResponse: false }));
    const trees = [...c.getRuntime()!.entities.values()];
    const at = (x: number, z: number) => trees.find((e) => e.initialPose.position[0] === x && e.initialPose.position[2] === z)!;
    // Wind from the west blowing toward +x.
    expect(canopyFactor(at(-40, 0), 1, 0)).toBe(1);
    expect(canopyFactor(at(40, 0), 1, 0)).toBeLessThan(0.7);
    expect(canopyFactor(at(0, 0), 1, 0)).toBeLessThan(canopyFactor(at(-35, 0), 1, 0));
    c.unload();
    const off = new SimulationController();
    await off.load(forest());
    expect([...off.getRuntime()!.entities.values()].every((e) => !e.canopy)).toBe(true);
    off.unload();
  });

  it('a sheltered forest takes less wind load inside; the edge row is unchanged', async () => {
    const run = async (canopy: boolean) => {
      const c = new SimulationController();
      await c.load(forest({ canopyShelter: canopy, floodResponse: false }));
      c.addEvent({ event: 'wind', speed: 30, direction: 'W', duration: 10, gustStrength: 0, rampDuration: 1 });
      c.advance(4);
      const es = [...c.getRuntime()!.entities.values()];
      const inside = es.filter((e) => Math.abs(e.initialPose.position[0]) < 10).reduce((s, e) => s + e.windAtCop, 0);
      const edge = es.filter((e) => e.initialPose.position[0] === -40).reduce((s, e) => s + e.windAtCop, 0);
      c.unload();
      return { inside, edge };
    };
    const a = await run(false), b = await run(true);
    expect(b.inside).toBeLessThan(a.inside * 0.8);
    expect(b.edge).toBeCloseTo(a.edge, 5);
  });

  it('tree flood response: deep fast water topples trees only when the option is on', async () => {
    const run = async (on: boolean) => {
      const d = forest({ canopyShelter: false, floodResponse: on });
      const w = { ...defaultWaterSettings(), infiltration: false, drainageCapacity: 0, initialFromReference: false };
      d.settings.simulation.water = w;
      // 5 m of water piled west of the forest: a strong surge eastward through the trees.
      const f = new WaterField(new TerrainSampler(createFlatTerrain()), w);
      for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) if (f.cellX(ix) < -45) f.h[iz * f.nx + ix] = 5;
      const c = new SimulationController();
      c.setInitialWaterState(captureWaterState(f, 0));
      await c.load(d);
      c.addEvent({ event: 'rain', intensity: 0.1, duration: 600 });
      c.advance(25);
      const toppled = [...c.getRuntime()!.entities.values()].filter((e) => e.flags.toppled).length;
      c.unload();
      return toppled;
    };
    expect(await run(false)).toBe(0);
    expect(await run(true)).toBeGreaterThan(0);
  });
});
