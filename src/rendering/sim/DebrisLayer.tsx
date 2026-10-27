import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import type { DebrisPiece } from '@/simulation/SimulationRuntime';
import { UNIT_BOX } from '../geometry/primitives';
import { getMaterial } from '../materials';

function DebrisMesh({ d }: { d: DebrisPiece }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    m.position.set(d.pose.position[0], d.pose.position[1], d.pose.position[2]);
    m.quaternion.set(d.pose.quaternion[0], d.pose.quaternion[1], d.pose.quaternion[2], d.pose.quaternion[3]);
  });
  return <mesh ref={ref} geometry={UNIT_BOX} material={getMaterial(d.color)} scale={d.size} castShadow receiveShadow />;
}

/** Detached building parts and collapse chunks (rigid bodies). Re-renders only when the set changes. */
export function DebrisLayer() {
  const [pieces, setPieces] = useState<DebrisPiece[]>([]);
  const rev = useRef(-1);
  useFrame(() => {
    const rt = simulationController.getRuntime();
    if (!rt) return;
    if (rt.debrisRev !== rev.current) {
      rev.current = rt.debrisRev;
      setPieces(rt.debris.slice());
    }
  });
  return (
    <>
      {pieces.map((d) => (
        <DebrisMesh key={d.id} d={d} />
      ))}
    </>
  );
}
