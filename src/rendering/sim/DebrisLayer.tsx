import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { MAX_DEBRIS } from '@/simulation/damage/spawn';
import { UNIT_BOX } from '../geometry/primitives';

const m = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();
/** Parsed colors cached by hex string. */
const colorCache = new Map<string, THREE.Color>();
function cachedColor(hex: string) {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new THREE.Color(hex)));
  return c;
}

/**
 * Detached building parts and collapse chunks (rigid bodies): one InstancedMesh, matrices from
 * the physics poses every frame, colors rewritten only when the set of pieces changes.
 */
export function DebrisLayer() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const rev = useRef(-1);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0, flatShading: true }), []);
  useFrame(() => {
    const mesh = ref.current;
    const rt = simulationController.getRuntime();
    if (!mesh || !rt) return;
    const list = rt.debris;
    const n = Math.min(list.length, MAX_DEBRIS);
    const colors = rt.debrisRev !== rev.current;
    rev.current = rt.debrisRev;
    for (let i = 0; i < n; i++) {
      const d = list[i];
      const p = d.pose.position;
      const q = d.pose.quaternion;
      m.compose(pos.set(p[0], p[1], p[2]), quat.set(q[0], q[1], q[2], q[3]), scale.set(d.size[0], d.size[1], d.size[2]));
      mesh.setMatrixAt(i, m);
      if (colors) mesh.setColorAt(i, cachedColor(d.color));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[UNIT_BOX, material, MAX_DEBRIS]} frustumCulled={false} castShadow receiveShadow raycast={() => null} />;
}
