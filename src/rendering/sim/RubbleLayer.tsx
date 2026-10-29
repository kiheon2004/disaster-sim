import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { moundReach } from '@/structure/rubble';
import { hashString } from '@/core/math';
import { useDisposable } from '../useDisposable';
import { useViewStore } from '../viewStore';

/**
 * Rubble piles of the structural engine (Phase 25): one merged mesh of mounds — a flat top over the
 * pile's footprint at its computed height and sides at the angle of repose (the geometry the road
 * blockage / burial use). Rebuilt only when the rubble field changes; the old geometry is disposed.
 * Mass and footprint are computed; the mound shape is an approximation (documented).
 */
export function RubbleLayer() {
  const ref = useRef<THREE.Mesh>(null);
  const rev = useRef(-1);
  const material = useDisposable(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true }), []);
  const geom = useRef<THREE.BufferGeometry | null>(null);
  useEffect(() => () => geom.current?.dispose(), []);
  useFrame(() => {
    const mesh = ref.current;
    const S = simulationController.getRuntime()?.structures;
    if (!mesh) return;
    mesh.visible = useViewStore.getState().structureViz.rubble && !!S && S.rubble.heaps.length > 0;
    if (!S || S.rubble.rev === rev.current) return;
    rev.current = S.rubble.rev;
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const c = new THREE.Color();
    for (const h of S.rubble.heaps) {
      if (h.height < 0.02) continue;
      const r = moundReach(h.height);
      const cs = Math.cos(h.yaw), sn = Math.sin(h.yaw);
      const P = (lx: number, ly: number, lz: number) => pos.push(h.cx + lx * cs + lz * sn, h.y + ly, h.cz - lx * sn + lz * cs);
      const base = pos.length / 3;
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) P(x * h.hx, h.height, z * h.hz);
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) P(x * (h.hx + r), 0.02, z * (h.hz + r));
      const k = (hashString(`${h.owner}/${h.pile}`) >>> 0) % 1000 / 1000;
      c.setRGB(0.42 + 0.06 * k, 0.4 + 0.05 * k, 0.37 + 0.04 * k);
      for (let q = 0; q < 8; q++) col.push(c.r * (q < 4 ? 1 : 0.8), c.g * (q < 4 ? 1 : 0.8), c.b * (q < 4 ? 1 : 0.8));
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      for (let q = 0; q < 4; q++) {
        const a = base + q, b = base + ((q + 1) % 4), a2 = a + 4, b2 = b + 4;
        idx.push(a, b, b2, a, b2, a2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    geom.current?.dispose();
    geom.current = g;
    mesh.geometry = g;
  });
  return <mesh ref={ref} material={material} castShadow receiveShadow raycast={() => null} />;
}
