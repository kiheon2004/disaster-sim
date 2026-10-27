import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { DAMAGE_STATE_COLORS, DamageState } from '@/simulation/damage/DamageState';
import { useViewStore } from '../viewStore';

const RING = new THREE.RingGeometry(0.86, 1, 40);
const materials = Object.fromEntries(
  Object.entries(DAMAGE_STATE_COLORS).map(([k, c]) => [
    k,
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
  ]),
) as Record<DamageState, THREE.MeshBasicMaterial>;

/** Colored ground ring per entity showing its damage state (follows moving bodies). */
function StateRing({ e }: { e: RuntimeEntity }) {
  const ref = useRef<THREE.Mesh>(null);
  const radius = useMemo(() => Math.max(e.dims[0], e.dims[2]) * 0.62 + 0.4, [e]);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    m.position.set(e.pose.position[0], 0.06, e.pose.position[2]);
    m.material = materials[e.state];
    const pulse = e.state >= DamageState.CRITICAL && e.state < DamageState.DESTROYED ? 1 + Math.sin(clock.elapsedTime * 6) * 0.06 : 1;
    m.scale.setScalar(radius * pulse);
    m.visible = e.state !== DamageState.NORMAL;
  });
  return <mesh ref={ref} geometry={RING} rotation-x={-Math.PI / 2} raycast={() => null} renderOrder={5} />;
}

export function DamageOverlay({ entities }: { entities: RuntimeEntity[] }) {
  const show = useViewStore((s) => s.showDamage);
  if (!show) return null;
  return (
    <>
      {entities.map((e) => (
        <StateRing key={e.id} e={e} />
      ))}
    </>
  );
}
