import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useDisposable } from '../../useDisposable';
import { WORLD_HALF } from '@/core/units';
import { useT } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../../viewStore';

const RING = new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2);

function formatDistance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

/**
 * Epicenter marker: a beam + pulsing rings when the epicenter lies on the map, otherwise an
 * arrow at the map edge pointing toward it with its distance and depth. Render-only.
 */
export function EpicenterMarker() {
  const t = useT();
  const show = useViewStore((s) => s.quakeViz.epicenter);
  const quake = useSimStore((s) => s.quake);
  const rings = useRef<THREE.Group>(null);
  const material = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ff5a3c', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }), []);
  const beamMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ff5a3c', transparent: true, opacity: 0.22, depthWrite: false }), []);

  useFrame(({ clock }) => {
    const g = rings.current;
    if (!g) return;
    const active = useSimStore.getState().quake?.active ?? false;
    g.children.forEach((c, i) => {
      const ph = (clock.elapsedTime * (active ? 0.6 : 0.25) + i / g.children.length) % 1;
      c.scale.setScalar(2 + ph * (active ? 26 : 10));
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.8;
    });
  });

  if (!show || !quake) return null;
  const [ex, ez] = quake.epicenter;
  const inside = Math.abs(ex) <= WORLD_HALF && Math.abs(ez) <= WORLD_HALF;
  const label = `${t('quakeHud.epicenter', { dist: formatDistance(Math.hypot(ex, ez)) })} · M${quake.magnitude.toFixed(1)} · ${quake.depth.toFixed(0)} km`;
  if (inside) {
    const y = simulationController.getEnvironment().terrain.sampleHeight(ex, ez);
    return (
      <group position={[ex, y + 0.1, ez]}>
        <group ref={rings}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} geometry={RING} material={material.clone()} raycast={() => null} renderOrder={6} />
          ))}
        </group>
        <mesh position={[0, 30, 0]} material={beamMat} raycast={() => null}>
          <cylinderGeometry args={[0.35, 0.35, 60, 12, 1, true]} />
        </mesh>
        <Html position={[0, 62, 0]} center style={{ pointerEvents: 'none' }}>
          <div style={{ whiteSpace: 'nowrap', fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(120,20,10,0.85)', color: '#fff' }}>{label}</div>
        </Html>
      </group>
    );
  }
  // Off-map: arrow at the boundary toward the epicenter.
  const d = Math.hypot(ex, ez);
  const ux = ex / d;
  const uz = ez / d;
  const s = WORLD_HALF / Math.max(Math.abs(ux), Math.abs(uz));
  const px = ux * s * 0.96;
  const pz = uz * s * 0.96;
  const y = simulationController.getEnvironment().terrain.sampleHeight(px, pz);
  return (
    <group position={[px, y + 1.5, pz]} rotation={[0, Math.atan2(-uz, ux), 0]}>
      <mesh material={material} raycast={() => null} rotation={[0, 0, -Math.PI / 2]} position={[2, 0, 0]}>
        <coneGeometry args={[1.6, 4, 12]} />
      </mesh>
      <mesh material={material} raycast={() => null} position={[-1.5, 0, 0]}>
        <boxGeometry args={[4, 0.6, 0.6]} />
      </mesh>
      <Html position={[0, 3.5, 0]} center style={{ pointerEvents: 'none' }}>
        <div style={{ whiteSpace: 'nowrap', fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(120,20,10,0.85)', color: '#fff' }}>{label}</div>
      </Html>
    </group>
  );
}
