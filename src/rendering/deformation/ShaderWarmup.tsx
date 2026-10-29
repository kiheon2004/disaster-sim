/**
 * Compiles, while the simulation scene loads, the shader programs a terrain deformation needs
 * later (Phase 21): the heightfield terrain material (the flat world draws a plain plane) and the
 * RGBA vertex-color overlay. Without this the first deformation update stalls one frame by
 * ~100 ms on shader compilation. Two tiny triangles far below the world, drawn for a few frames,
 * then removed; materials with the same shader share the compiled program.
 */
import { useEffect, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createTerrainMaterial } from '../terrain/TerrainSurface';

function tri(colorSize: 3 | 4) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, 0.01]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * colorSize).fill(1), colorSize));
  return g;
}

export function ShaderWarmup() {
  const [frames, setFrames] = useState(0);
  const parts = useMemo(() => {
    const terrain = createTerrainMaterial().material;
    const overlay = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const skirt = new THREE.MeshStandardMaterial({ color: '#7a6249', roughness: 1, side: THREE.DoubleSide });
    return { terrain, overlay, skirt, g3: tri(3), g4: tri(4) };
  }, []);
  useEffect(() => () => {
    parts.terrain.dispose();
    parts.overlay.dispose();
    parts.skirt.dispose();
    parts.g3.dispose();
    parts.g4.dispose();
  }, [parts]);
  useFrame(() => {
    if (frames < 4) setFrames((f) => f + 1);
  });
  if (frames >= 4) return null;
  return (
    <group position={[0, -500, 0]}>
      <mesh geometry={parts.g3} material={parts.terrain} frustumCulled={false} receiveShadow castShadow />
      <mesh geometry={parts.g4} material={parts.overlay} frustumCulled={false} />
      <mesh geometry={parts.g3} material={parts.skirt} frustumCulled={false} receiveShadow />
    </group>
  );
}
