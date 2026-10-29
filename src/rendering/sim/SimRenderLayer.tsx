import { countRender } from '@/utils/renderCounter';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { RuntimeEntity, SimulationRuntime } from '@/simulation/SimulationRuntime';
import { useEditorStore } from '@/editor/editorStore';
import { RoadView } from '../views/InfrastructureViews';
import { SelectionBox } from '../SelectionBox';
import { stormIntensity } from './environment/intensity';
import { SimRenderAdapter } from './SimRenderAdapter';
import { setActiveAdapter } from './renderStats';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../viewStore';

/** Roads are few, textured and static: plain meshes (not part of the batches). */
const SimRoad = memo(function SimRoad({ e }: { e: RuntimeEntity }) {
  const { position, rotation, scale } = e.source.transform;
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <RoadView obj={e.source} />
    </group>
  );
});

const tmpQ = new THREE.Quaternion();

/** Selection outline that follows the selected entity's live pose (one component for all). */
function SelectionFollower({ runtime }: { runtime: SimulationRuntime }) {
  const selectedId = useEditorStore((s) => s.selectedId);
  const e = selectedId ? runtime.entities.get(selectedId) : undefined;
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = ref.current;
    if (!g || !e) return;
    // Snapped trees: the outline follows the falling upper part, like the old per-entity view.
    const pose = e.source.type === 'building' || e.source.type === 'road' ? null : e.pose;
    const p = pose ? pose.position : e.source.transform.position;
    g.position.set(p[0], p[1], p[2]);
    if (pose) g.quaternion.copy(tmpQ.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]));
    else g.rotation.set(...e.source.transform.rotation);
  });
  if (!e || e.def.inert) return null;
  const k = e.source.transform.scale;
  return (
    <group ref={ref} scale={k}>
      <SelectionBox dims={[e.dims[0] / k[0], e.dims[1] / k[1], e.dims[2] / k[2]]} color="#ffb067" />
    </group>
  );
}

/**
 * All simulated objects, rendered through the instancing adapter. React only mounts it; every
 * per-frame update is a single useFrame that copies simulation state into GPU batches.
 */
export function SimRenderLayer({ runtime }: { runtime: SimulationRuntime }) {
  countRender('SimRenderLayer');
  // Created inside the effect (not useMemo): StrictMode runs effect cleanups once in dev, and a
  // memoized adapter would be disposed there and then reused.
  const [adapter, setAdapter] = useState<SimRenderAdapter | null>(null);
  useEffect(() => {
    const a = new SimRenderAdapter(runtime, simulationController.getEnvironment().terrain);
    a.thermal = () => simulationController.getEnvironment().thermal.rt;
    setAdapter(a);
    setActiveAdapter(a);
    return () => {
      setActiveAdapter(null);
      a.dispose();
    };
  }, [runtime]);
  useFrame(({ camera, clock }) => {
    const q = useViewStore.getState().quakeViz;
    adapter?.update(camera, clock.elapsedTime, stormIntensity(), { exaggeration: q.exaggeration, stress: q.stress });
  });

  const roads = useMemo(() => [...runtime.entities.values()].filter((e) => e.source.type === 'road'), [runtime]);
  const handlers = useMemo(
    () => ({
      onClick: (ev: ThreeEvent<MouseEvent>) => {
        ev.stopPropagation();
        if (ev.delta > 5) return;
        const id = adapter?.pick(ev.object, ev.batchId ?? ev.instanceId);
        if (id) useEditorStore.getState().select(id);
        // Phase 25: the member under the cursor of a modular building (structural inspector).
        useViewStore.getState().setSimMember(adapter?.pickMember(ev.object, ev.batchId ?? ev.instanceId) ?? null);
      },
      onPointerOver: (ev: ThreeEvent<PointerEvent>) => {
        ev.stopPropagation();
        document.body.style.cursor = 'pointer';
      },
      onPointerOut: () => {
        document.body.style.cursor = '';
      },
    }),
    [adapter],
  );

  return (
    <>
      {adapter && <primitive object={adapter.root} {...handlers} />}
      {roads.map((e) => (
        <SimRoad key={e.id} e={e} />
      ))}
      <SelectionFollower runtime={runtime} />
    </>
  );
}
