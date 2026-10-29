import { it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
const S = () => useWorldStore.getState();
it('smoke', async () => {
  S().newDocument();
  const house = createDesign(presetSpec('house')!, 'house');
  S().applyEdit({ add: [
    { type: 'building', building: house, seed: 1, transform: { position: [8, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'car', seed: 2, transform: { position: [-3, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'tree', seed: 3, transform: { position: [0, 0, -6], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ] });
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(S().doc));
  c.addEvent({ event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 15, amount: 3, duration: 3, profile: 'smooth' } as never);
  const t0 = performance.now();
  c.advance(5);
  console.log('ms', (performance.now() - t0).toFixed(0));
  const rt = c.getRuntime()!;
  for (const e of rt.entities.values()) console.log(e.source.type, e.pose.position.map((v) => v.toFixed(2)).join(','), e.state, JSON.stringify(e.ground && { s: e.ground.settlement.toFixed(2), tilt: e.ground.tilt.toFixed(3), beta: e.ground.beta.toFixed(4), contact: e.ground.contact }));
  const env = c.getEnvironment();
  console.log('h(0,0)', env.terrain.sampleHeight(0, 0), 'stats', JSON.stringify(env.deformation.stats));
  console.log(rt.log.map((l) => l.message.key).join(' | '));
  console.log(JSON.stringify(c.getMilestones().map((m) => [m.kind, m.time.toFixed(2)])));
  c.unload();
});
