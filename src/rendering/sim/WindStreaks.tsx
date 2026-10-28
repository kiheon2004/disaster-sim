import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../viewStore';
import { UNIT_BOX } from '../geometry/primitives';
import { Rng } from '@/core/random';

const COUNT = 700;
const RANGE = 90; // m around the camera target
const dummy = new THREE.Object3D();

/** Translucent streaks advected by the wind field — makes direction and strength visible. */
export function WindStreaks() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const show = useViewStore((s) => s.showWind && s.windViz !== 'arrows');
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#f4f8ff', transparent: true, opacity: 0, depthWrite: false }),
    [],
  );
  const pts = useMemo(() => {
    const rng = new Rng(97);
    return Array.from({ length: COUNT }, () => ({
        p: new THREE.Vector3(rng.spread(RANGE), rng.range(0.5, 28), rng.spread(RANGE)),
      }));
  }, []);

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
    const field = env.windField;
    const t = env.time;
    // Advect each streak with the LOCAL wind (same field as physics): slow and veering in wakes.
    const visualScale = Math.min(speed, 60) * 0.9 / Math.max(1, speed);
    for (let i = 0; i < COUNT; i++) {
      const s = pts[i];
      const v = field.velocityAt([s.p.x, s.p.y, s.p.z], t);
      const sp = Math.hypot(v[0], v[2]);
      const local = sp / Math.max(1, speed);
      const yaw = Math.atan2(-v[2], v[0]);
      s.p.x += v[0] * visualScale * dt;
      s.p.z += v[2] * visualScale * dt;
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
