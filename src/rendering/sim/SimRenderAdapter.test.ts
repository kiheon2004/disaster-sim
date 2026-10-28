import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SimulationController } from '@/simulation/SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { stressScene } from '@/world/stressScene';
import { SimRenderAdapter, LOD_FAR } from './SimRenderAdapter';

async function setup() {
  const doc = createEmptyDocument('adapter');
  for (const input of stressScene(150)) {
    const o = createWorldObject(input, nextSerial(doc.objects, input.type));
    doc.objects[o.id] = o;
  }
  const c = new SimulationController();
  await c.load(doc);
  const rt = c.getRuntime()!;
  const adapter = new SimRenderAdapter(rt);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 40, 0);
  camera.updateMatrixWorld();
  adapter.update(camera, 0, 0);
  const batches = adapter.root.children.filter((o): o is THREE.BatchedMesh => (o as THREE.BatchedMesh).isBatchedMesh);
  const facade = adapter.root.children.filter((o): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh);
  return { c, rt, adapter, camera, batches, facade };
}

describe('SimRenderAdapter (instanced rendering of the simulation state)', () => {
  it('renders every object with a handful of batches and maps instances back to entity ids', async () => {
    const { c, rt, adapter, batches } = await setup();
    expect(batches.length).toBeLessThanOrEqual(8);
    const seen = new Set<string>();
    for (const b of batches) {
      for (let id = 0; id < b.instanceCount; id++) {
        const owner = adapter.pick(b, id);
        expect(owner).not.toBeNull();
        expect(rt.entities.has(owner!)).toBe(true);
        seen.add(owner!);
      }
    }
    const drawn = [...rt.entities.values()].filter((e) => e.source.type !== 'road' && !e.def.inert);
    for (const e of drawn) expect(seen.has(e.id)).toBe(true);
    c.unload();
  });

  it('hides a collapsed building (shell + facade) and darkens broken windows', async () => {
    const { c, rt, adapter, batches, facade, camera } = await setup();
    const b = [...rt.entities.values()].find((e) => e.source.type === 'building')!;
    const instancesOf = (owner: string) =>
      batches.flatMap((m) => Array.from({ length: m.instanceCount }, (_, id) => [m, id] as const).filter(([, id]) => adapter.pick(m, id) === owner));

    const windows = facade.find((m) => m.name === 'facade:window')!;
    const color = new THREE.Color();
    const dark = () =>
      Array.from({ length: windows.count }, (_, i) => {
        windows.getColorAt(i, color);
        return color.r < 0.2;
      }).filter(Boolean).length;
    expect(dark()).toBe(0);
    b.components.find((x) => x.spec.kind === 'window')!.condition = 'broken';
    b.rev++;
    adapter.update(camera, 0.1, 0);
    expect(dark()).toBe(1);

    b.flags.collapsed = true;
    b.rev++;
    adapter.update(camera, 0.2, 0);
    for (const [m, id] of instancesOf(b.id)) expect(m.getVisibleAt(id)).toBe(false);
    c.unload();
  });

  it('follows physics poses and switches to far geometry (render LOD only)', async () => {
    const { c, rt, adapter, batches, camera } = await setup();
    const car = [...rt.entities.values()].find((e) => e.source.type === 'car')!;
    car.pose = { position: [car.pose.position[0] + 3, 0, car.pose.position[2]], quaternion: [0, 0, 0, 1] };
    adapter.update(camera, 0.1, 0);
    const [mesh, id] = batches.flatMap((m) => Array.from({ length: m.instanceCount }, (_, i) => [m, i] as const)).find(([m, i]) => adapter.pick(m, i) === car.id)!;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(id, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(car.pose.position[0], 5);

    const near = mesh.getGeometryIdAt(id);
    camera.position.set(car.pose.position[0] + LOD_FAR * 2, 50, car.pose.position[2]);
    camera.updateMatrixWorld();
    adapter.update(camera, 0.2, 0);
    expect(mesh.getGeometryIdAt(id)).not.toBe(near);
    expect(adapter.stats().far).toBeGreaterThan(0);
    c.unload();
  });

  it('hides detached street-light heads', async () => {
    const { c, rt, adapter, batches, camera } = await setup();
    const sl = [...rt.entities.values()].find((e) => e.source.type === 'streetLight')!;
    sl.components.find((x) => x.spec.id === 'lamp')!.condition = 'detached';
    sl.rev++;
    adapter.update(camera, 0.1, 0);
    const parts = batches.flatMap((m) => Array.from({ length: m.instanceCount }, (_, i) => [m, i] as const)).filter(([m, i]) => adapter.pick(m, i) === sl.id);
    expect(parts.length).toBe(2);
    expect(parts.filter(([m, i]) => !m.getVisibleAt(i)).length).toBe(1);
    c.unload();
  });
});
