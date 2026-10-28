import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';

/** Hide an Object3D once the runtime marks the given component as detached. */
export function useComponentHidden(live: RuntimeEntity | undefined, componentId: string) {
  const ref = useRef<THREE.Object3D>(null);
  const rev = useRef(-1);
  useFrame(() => {
    if (!live || !ref.current || live.rev === rev.current) return;
    rev.current = live.rev;
    const c = live.components.find((x) => x.spec.id === componentId);
    ref.current.visible = !c || c.condition !== 'detached';
  });
  return ref;
}
