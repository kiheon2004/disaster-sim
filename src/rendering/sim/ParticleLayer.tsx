import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { MAX_PARTICLES } from '@/simulation/damage/spawn';
import { UNIT_BOX } from '../geometry/primitives';

const dummy = new THREE.Object3D();
/** Parsed colors cached by hex string (avoids re-parsing every particle every frame). */
const colorCache = new Map<string, THREE.Color>();
function cachedColor(hex: string) {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new THREE.Color(hex)));
  return c;
}

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
    // Particles are integrated at a lower rate than physics: extrapolate to the current time.
    const ahead = Math.max(-0.05, Math.min(0.05, simulationController.getTime() - rt.particlesTime));
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const fade = Math.min(1, p.life / 1.5);
      const v = p.velocity;
      dummy.position.set(p.position[0] + v[0] * ahead, Math.max(0.02, p.position[1] + v[1] * ahead), p.position[2] + v[2] * ahead);
      dummy.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
      const s = p.size * fade;
      if (p.kind === 'leaf') dummy.scale.set(s * 1.6, s * 0.15, s);
      else dummy.scale.set(s, s, s * 0.3);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, cachedColor(p.color));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[UNIT_BOX, material, MAX_PARTICLES]} frustumCulled={false} />;
}
