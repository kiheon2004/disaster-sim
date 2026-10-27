import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../viewStore';
import { UNIT_BOX } from '../geometry/primitives';

const COUNT = 700;
const RANGE = 90; // m around the camera target
const dummy = new THREE.Object3D();

/** Translucent streaks advected by the wind field — makes direction and strength visible. */
export function WindStreaks() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const show = useViewStore((s) => s.showWind);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#f4f8ff', transparent: true, opacity: 0, depthWrite: false }),
    [],
  );
  const pts = useMemo(
    () =>
      Array.from({ length: COUNT }, () => ({
        p: new THREE.Vector3((Math.random() - 0.5) * RANGE * 2, 0.5 + Math.random() * 28, (Math.random() - 0.5) * RANGE * 2),
        phase: Math.random(),
      })),
    [],
  );

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const env = simulationController.getEnvironment();
    const wind = env.wind;
    const speed = wind.baseSpeed;
    material.opacity = show ? Math.min(0.55, speed / 60) : 0;
    mesh.visible = show && speed > 0.5;
    if (!mesh.visible) return;
    const center = controls?.target ?? new THREE.Vector3();
    const flow = wind.flow();
    const yaw = Math.atan2(-flow[2], flow[0]);
    const t = env.time;
    const visualSpeed = Math.min(speed, 60) * 0.9;
    for (let i = 0; i < COUNT; i++) {
      const s = pts[i];
      const local = wind.speedAt([s.p.x, s.p.y, s.p.z], t) / Math.max(1, speed);
      s.p.x += flow[0] * visualSpeed * local * dt;
      s.p.z += flow[2] * visualSpeed * local * dt;
      // Wrap around a box centered on the camera target.
      const dx = s.p.x - center.x;
      const dz = s.p.z - center.z;
      if (dx > RANGE) s.p.x -= RANGE * 2;
      if (dx < -RANGE) s.p.x += RANGE * 2;
      if (dz > RANGE) s.p.z -= RANGE * 2;
      if (dz < -RANGE) s.p.z += RANGE * 2;
      dummy.position.copy(s.p);
      dummy.rotation.set(0, yaw, 0);
      const len = 0.6 + speed * 0.06 * local;
      dummy.scale.set(len, 0.04, 0.04);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[UNIT_BOX, material, COUNT]} frustumCulled={false} raycast={() => null} />;
}
