import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../useDisposable';
import { Rng } from '@/core/random';
import { smoothstep } from '@/core/math';
import { UNIT_BOX } from '../../geometry/primitives';
import { globalFlow, weatherIntensity } from './intensity';

const MAX = 3000;
const RANGE = 70;
const TOP = 45;
const FALL = 14; // m/s
const dummy = new THREE.Object3D();
const up = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();

/** Wind-driven rain streaks around the camera target (visual only — no rainfall physics). */
export function Rain() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const material = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#c9d6e3', transparent: true, opacity: 0.4, depthWrite: false }), []);
  const drops = useMemo(() => {
    const rng = new Rng(2024);
    return Array.from({ length: MAX }, () => new THREE.Vector3(rng.spread(RANGE), rng.range(0, TOP), rng.spread(RANGE)));
  }, []);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const amount = smoothstep(0.25, 0.9, weatherIntensity());
    const n = Math.floor(MAX * amount);
    mesh.count = n;
    mesh.visible = n > 0;
    if (!n) return;
    const { flow, speed } = globalFlow();
    const c = controls?.target ?? new THREE.Vector3();
    const vx = flow[0] * speed * 0.55;
    const vz = flow[2] * speed * 0.55;
    dir.set(vx, -FALL, vz).normalize();
    const len = 0.6 + Math.hypot(vx, FALL, vz) * 0.04;
    for (let i = 0; i < n; i++) {
      const d = drops[i];
      d.x += vx * dt;
      d.y -= FALL * dt;
      d.z += vz * dt;
      if (d.y < 0) d.y += TOP;
      if (d.x - c.x > RANGE) d.x -= RANGE * 2;
      if (d.x - c.x < -RANGE) d.x += RANGE * 2;
      if (d.z - c.z > RANGE) d.z -= RANGE * 2;
      if (d.z - c.z < -RANGE) d.z += RANGE * 2;
      dummy.position.copy(d);
      dummy.quaternion.setFromUnitVectors(up, dir);
      dummy.scale.set(0.03, len, 0.03);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[UNIT_BOX, material, MAX]} frustumCulled={false} raycast={() => null} />;
}
