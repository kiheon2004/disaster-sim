/**
 * Compiles, while the simulation scene loads, the shader programs a terrain deformation needs
 * later (Phase 21; Phase 22 adds the ground-failure overlay's points / instanced arrows / lines): the heightfield terrain material, its skirt, outline and surroundings (the flat
 * world draws a plain plane) and the RGBA vertex-color overlay. Without this the first deformation update stalls one frame by
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
    const outline = new THREE.LineBasicMaterial({ color: '#f5f8ff', transparent: true, opacity: 0.35 });
    const ring = new THREE.MeshStandardMaterial({ color: '#56703f', roughness: 1 });
    // Phase 22 ground-failure overlay: dust points, instanced flow arrows, outlines (solid / dashed).
    const dust = new THREE.PointsMaterial({ color: '#c9b08a', size: 0.9, transparent: true, opacity: 0.35, depthWrite: false });
    const arrow = new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 });
    const line = new THREE.LineBasicMaterial({ color: '#ffd34d', depthTest: false, transparent: true, opacity: 0.95 });
    const dashed = new THREE.LineDashedMaterial({ color: '#7fb6ff', dashSize: 1, gapSize: 0.7, depthTest: false, transparent: true, opacity: 0.95 });
    const arrows = new THREE.InstancedMesh(tri(3), arrow, 1);
    arrows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
    arrows.frustumCulled = false;
    const lines = [line, dashed].map((m) => Object.assign(new THREE.Line(tri(3), m), { frustumCulled: false }));
    return { terrain, overlay, skirt, outline, ring, dust, arrow, line, dashed, arrows, lines, g3: tri(3), g4: tri(4) };
  }, []);
  useEffect(() => () => {
    parts.terrain.dispose();
    parts.overlay.dispose();
    parts.skirt.dispose();
    parts.outline.dispose();
    parts.ring.dispose();
    parts.dust.dispose();
    parts.arrow.dispose();
    parts.line.dispose();
    parts.dashed.dispose();
    parts.arrows.geometry.dispose();
    for (const l of parts.lines) l.geometry.dispose();
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
      <mesh geometry={parts.g3} material={parts.ring} frustumCulled={false} receiveShadow />
      <lineSegments geometry={parts.g3} material={parts.outline} frustumCulled={false} />
      <points geometry={parts.g3} material={parts.dust} frustumCulled={false} />
      <primitive object={parts.arrows} />
      <primitive object={parts.lines[0]} />
      <primitive object={parts.lines[1]} />
    </group>
  );
}
