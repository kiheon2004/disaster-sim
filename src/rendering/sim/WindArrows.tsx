import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../viewStore';
import { windColor } from './windColors';

const SPACING = 6; // m
const HALF_CELLS = 11; // → 23 × 23 = 529 arrows
const COUNT = (HALF_CELLS * 2 + 1) ** 2;
const UPDATE_INTERVAL = 0.12; // s (≈8 Hz) — arrows show the field, not every flicker

/** Unit arrow pointing +X: shaft from 0 to 0.72, head to 1.0. */
function arrowGeometry() {
  const shaft = new THREE.BoxGeometry(0.72, 0.13, 0.13).translate(0.36, 0, 0);
  const head = new THREE.ConeGeometry(0.24, 0.3, 6).rotateZ(-Math.PI / 2).translate(0.86, 0, 0);
  const g = mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed()])!;
  shaft.dispose();
  head.dispose();
  return g;
}

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/**
 * Grid of arrows sampled from the SAME SpatialWindField used by physics and damage.
 * Length ∝ local speed, color = local speed, direction = local wind direction.
 */
export function WindArrows() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const show = useViewStore((s) => s.showWind && s.windViz !== 'particles');
  const height = useViewStore((s) => s.arrowHeight);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const geometry = useMemo(arrowGeometry, []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }), []);
  const since = useRef(Infinity);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const env = simulationController.getEnvironment();
    mesh.visible = show && env.wind.baseSpeed > 0.3;
    if (!mesh.visible) return;
    since.current += dt;
    if (since.current < UPDATE_INTERVAL) return;
    since.current = 0;

    const field = env.windField;
    const t = env.time;
    const target = controls?.target;
    // Snap the grid to world cells so arrows stay put while the camera moves.
    const ox = Math.round((target?.x ?? 0) / SPACING) * SPACING;
    const oz = Math.round((target?.z ?? 0) / SPACING) * SPACING;
    const ref10 = Math.max(env.wind.baseSpeed, 1);
    let i = 0;
    for (let gx = -HALF_CELLS; gx <= HALF_CELLS; gx++) {
      for (let gz = -HALF_CELLS; gz <= HALF_CELLS; gz++) {
        const x = ox + gx * SPACING;
        const z = oz + gz * SPACING;
        // Arrows float `height` meters above the local ground (same reference as the wind profile).
        const y = env.terrain.sampleHeight(x, z) + height;
        const s = field.sample([x, y, z], t);
        const len = Math.max(0.15, Math.min(1.6, s.speed / ref10)) * SPACING * 0.7;
        dummy.position.set(x - (s.velocity[0] / Math.max(s.speed, 1e-6)) * len * 0.5, y, z - (s.velocity[2] / Math.max(s.speed, 1e-6)) * len * 0.5);
        dummy.rotation.set(0, Math.atan2(-s.velocity[2], s.velocity[0]), 0);
        dummy.scale.set(len, 1 + len * 0.15, 1 + len * 0.15);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, windColor(s.speed, color));
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometry, material, COUNT]} frustumCulled={false} raycast={() => null} renderOrder={4} />;
}
