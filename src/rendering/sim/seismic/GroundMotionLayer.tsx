import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GRAVITY, WORLD_SIZE } from '@/core/units';
import { simulationController } from '@/simulation/SimulationController';
import { createGroundMotionSample } from '@/simulation/seismic/GroundMotionField';
import { useViewStore } from '../../viewStore';
import { accelColor } from './quakeColors';

const SEG = 64; // grid cells per side
const UPDATE_INTERVAL = 1 / 30;
const ARROW_HALF = 6; // → 13 × 13 arrows
const ARROW_SPACING = 15; // m
const sample = createGroundMotionSample();
/** Envelope decay per second: colors / arrows show the recent peak, not the zero crossings. */
const ENVELOPE_DECAY = 1.6;
const color = new THREE.Color();
const dummy = new THREE.Object3D();

/**
 * Ground-motion surface: a translucent grid over the map, displaced by the (exaggerated)
 * ground displacement and colored by the horizontal ground acceleration at each vertex —
 * sampled from the same GroundMotionField the structures and bodies feel. Render-only.
 */
function GroundSurface() {
  const show = useViewStore((s) => s.quakeViz.ground);
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEG, SEG).rotateX(-Math.PI / 2);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    return g;
  }, []);
  const base = useMemo(() => Float32Array.from(geometry.attributes.position.array as Float32Array), [geometry]);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }), []);
  const ref = useRef<THREE.Mesh>(null);
  const since = useRef(Infinity);
  const envelope = useMemo(() => new Float32Array(geometry.attributes.position.count), [geometry]);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const env = simulationController.getEnvironment();
    const gm = env.groundMotion;
    mesh.visible = show && gm.active;
    if (!mesh.visible) return;
    since.current += dt;
    if (since.current < UPDATE_INTERVAL) return;
    const decay = Math.exp(-ENVELOPE_DECAY * since.current);
    since.current = 0;
    const k = useViewStore.getState().quakeViz.exaggeration;
    let peak = 0;
    const pos = geometry.attributes.position.array as Float32Array;
    const col = geometry.attributes.color.array as Float32Array;
    const n = pos.length / 3;
    const t = env.time;
    for (let i = 0; i < n; i++) {
      const x = base[i * 3];
      const z = base[i * 3 + 2];
      gm.sample(x, z, t, sample);
      const y = env.terrain.sampleHeight(x, z) + 0.12;
      pos[i * 3] = x + sample.d[0] * k;
      pos[i * 3 + 1] = y + sample.d[1] * k;
      pos[i * 3 + 2] = z + sample.d[2] * k;
      const g = Math.max(Math.hypot(sample.a[0], sample.a[2]) / GRAVITY, envelope[i] * decay);
      envelope[i] = g;
      if (g > peak) peak = g;
      accelColor(g, color);
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.computeBoundingSphere();
    // Stronger shaking → more opaque surface (calm ground stays readable underneath).
    material.opacity = 0.2 + 0.38 * Math.min(1, peak / 0.4);
  });

  return <mesh ref={ref} geometry={geometry} material={material} renderOrder={3} raycast={() => null} frustumCulled={false} />;
}

function arrowGeometry() {
  const shaft = new THREE.BoxGeometry(0.7, 0.18, 0.18).translate(0.35, 0, 0);
  const head = new THREE.ConeGeometry(0.3, 0.3, 6).rotateZ(-Math.PI / 2).translate(0.85, 0, 0);
  const g = mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed()])!;
  shaft.dispose();
  head.dispose();
  return g;
}

/** Horizontal ground-acceleration vectors: direction of the acceleration, length ∝ magnitude. */
function AccelerationArrows() {
  const show = useViewStore((s) => s.quakeViz.arrows);
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(arrowGeometry, []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }), []);
  const count = (ARROW_HALF * 2 + 1) ** 2;
  const envelope = useMemo(() => new Float32Array(count), [count]);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const env = simulationController.getEnvironment();
    const gm = env.groundMotion;
    mesh.visible = show && gm.active;
    if (!mesh.visible) return;
    const k = useViewStore.getState().quakeViz.exaggeration;
    const decay = Math.exp(-ENVELOPE_DECAY * Math.min(dt, 0.1));
    let i = 0;
    for (let gx = -ARROW_HALF; gx <= ARROW_HALF; gx++) {
      for (let gz = -ARROW_HALF; gz <= ARROW_HALF; gz++) {
        const x = gx * ARROW_SPACING;
        const z = gz * ARROW_SPACING;
        gm.sample(x, z, env.time, sample);
        const ah = Math.hypot(sample.a[0], sample.a[2]);
        // Length: recent peak (envelope); direction: the current acceleration.
        const g = Math.max(ah / GRAVITY, envelope[i] * decay);
        envelope[i] = g;
        const len = Math.max(0.5, Math.min(13, (g / 0.5) * 11));
        dummy.position.set(x + sample.d[0] * k, env.terrain.sampleHeight(x, z) + 1.2 + sample.d[1] * k, z + sample.d[2] * k);
        dummy.rotation.set(0, Math.atan2(-sample.a[2], sample.a[0]), 0);
        dummy.scale.set(len, 1 + len * 0.12, 1 + len * 0.12);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, accelColor(g, color));
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} raycast={() => null} renderOrder={4} />;
}

export function GroundMotionLayer() {
  return (
    <>
      <GroundSurface />
      <AccelerationArrows />
    </>
  );
}
