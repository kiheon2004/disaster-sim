import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { MAX_PARTICLES } from '@/simulation/damage/spawn';
import { UNIT_BOX } from '../geometry/primitives';

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** Leaves and glass shards: one InstancedMesh, matrices + colors rewritten each frame. */
export function ParticleLayer() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, flatShading: true }),
    [],
  );
  useFrame(() => {
    const mesh = ref.current;
    const rt = simulationController.getRuntime();
    if (!mesh || !rt) return;
    const ps = rt.particles;
    const n = Math.min(ps.length, MAX_PARTICLES);
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const fade = Math.min(1, p.life / 1.5);
      dummy.position.set(p.position[0], p.position[1], p.position[2]);
      dummy.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
      const s = p.size * fade;
      if (p.kind === 'leaf') dummy.scale.set(s * 1.6, s * 0.15, s);
      else dummy.scale.set(s, s, s * 0.3);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(p.color));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[UNIT_BOX, material, MAX_PARTICLES]} frustumCulled={false} />;
}
