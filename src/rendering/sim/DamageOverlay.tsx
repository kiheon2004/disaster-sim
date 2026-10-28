import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { DAMAGE_STATE_COLORS, DamageState } from '@/simulation/damage/DamageState';
import { useViewStore } from '../viewStore';

const RING = new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2);
const COLORS = Object.fromEntries(Object.entries(DAMAGE_STATE_COLORS).map(([k, c]) => [k, new THREE.Color(c)])) as Record<DamageState, THREE.Color>;
const dummy = new THREE.Object3D();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** Colored ground ring per entity showing its damage state — one InstancedMesh for all entities. */
export function DamageOverlay({ entities }: { entities: RuntimeEntity[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const show = useViewStore((s) => s.showDamage);
  const list = useMemo(() => entities.filter((e) => !e.def.inert), [entities]);
  const radii = useMemo(() => list.map((e) => Math.max(e.dims[0], e.dims[2]) * 0.62 + 0.4), [list]);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }), []);

  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.visible = show;
    if (!show) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 6) * 0.06;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.state === DamageState.NORMAL) {
        mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      const s = radii[i] * (e.state === DamageState.CRITICAL ? pulse : 1);
      dummy.position.set(e.pose.position[0], 0.06, e.pose.position[2]);
      dummy.scale.set(s, 1, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, COLORS[e.state]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (!list.length) return null;
  return <instancedMesh ref={ref} args={[RING, material, list.length]} frustumCulled={false} raycast={() => null} renderOrder={5} />;
}
