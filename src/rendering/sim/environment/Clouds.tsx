import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Rng } from '@/core/random';
import { UNIT_BOX } from '../../geometry/primitives';
import { globalFlow, weatherIntensity } from './intensity';

const COUNT = 160;
const RANGE = 420;
const dummy = new THREE.Object3D();
const LIGHT = new THREE.Color('#f2f5f8');
const DARK = new THREE.Color('#3f464f');

/** Voxel cloud deck drifting with the global wind; denser and darker as the storm builds. */
export function Clouds() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useMemo(() => new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false, fog: false }), []);
  const blocks = useMemo(() => {
    const rng = new Rng(4711);
    return Array.from({ length: COUNT }, (_, i) => ({
      x: rng.spread(RANGE),
      z: rng.spread(RANGE),
      y: rng.range(85, 115),
      sx: rng.range(25, 70),
      sy: rng.range(6, 14),
      sz: rng.range(20, 55),
      /** Clouds with a higher threshold only appear in stronger storms. */
      threshold: i / COUNT,
    }));
  }, []);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const k = weatherIntensity();
    const { flow, speed } = globalFlow();
    const cover = 0.25 + k * 0.75;
    material.color.copy(LIGHT).lerp(DARK, k);
    material.opacity = 0.45 + k * 0.4;
    for (let i = 0; i < COUNT; i++) {
      const b = blocks[i];
      b.x += flow[0] * speed * 0.6 * dt;
      b.z += flow[2] * speed * 0.6 * dt;
      if (b.x > RANGE) b.x -= RANGE * 2;
      if (b.x < -RANGE) b.x += RANGE * 2;
      if (b.z > RANGE) b.z -= RANGE * 2;
      if (b.z < -RANGE) b.z += RANGE * 2;
      const visible = b.threshold < cover;
      dummy.position.set(b.x, b.y - k * 12, b.z);
      dummy.scale.set(visible ? b.sx : 0, visible ? b.sy * (1 + k) : 0, visible ? b.sz : 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[UNIT_BOX, material, COUNT]} frustumCulled={false} raycast={() => null} />;
}
