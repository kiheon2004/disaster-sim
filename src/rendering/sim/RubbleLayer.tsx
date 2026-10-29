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
 * blockage / burial use). Rebuilt when the rubble field changed, at most every REBUILD_MS while it keeps
 * changing (a 1000-house blast adds heaps every step; the last state is always drawn); the old geometry
 * is disposed. Mass and footprint are computed; the mound shape is an approximation (documented).
 * Flat shading derives the face normals in the shader, so no normal attribute is computed.
 */
const REBUILD_MS = 100;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;

export function RubbleLayer() {
  const ref = useRef<THREE.Mesh>(null);
  const rev = useRef(-1);
  const built = useRef(0);
  const field = useRef<object | null>(null);
  const tone = useRef(new Map<number, number>());
  const material = useDisposable(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true }), []);
  const geom = useRef<THREE.BufferGeometry | null>(null);
  useEffect(() => () => geom.current?.dispose(), []);
  useFrame(() => {
    const mesh = ref.current;
    const S = simulationController.getRuntime()?.structures;
    if (!mesh) return;
    mesh.visible = useViewStore.getState().structureViz.rubble && !!S && S.rubble.heaps.length > 0;
    if (!S) return;
    // A new run has a new field (heap ids start again): forget the old revision and tones.
    if (S.rubble !== field.current) { field.current = S.rubble; rev.current = -1; tone.current.clear(); }
    if (S.rubble.rev === rev.current) return;
    const now = performance.now();
    if (rev.current >= 0 && now - built.current < REBUILD_MS) return;
    rev.current = S.rubble.rev;
    built.current = now;
    let n = 0;
    for (const h of S.rubble.heaps) if (h.height >= 0.02) n++;
    const pos = new Float32Array(n * 24), col = new Float32Array(n * 24), idx = new Uint32Array(n * 30);
    let v = 0, t = 0;
    for (const h of S.rubble.heaps) {
      if (h.height < 0.02) continue;
      const r = moundReach(h.height);
      const cs = Math.cos(h.yaw), sn = Math.sin(h.yaw);
      const base = v / 3;
      for (let q = 0; q < 8; q++) {
        const [x, z] = CORNERS[q & 3];
        const top = q < 4, lx = x * (top ? h.hx : h.hx + r), lz = z * (top ? h.hz : h.hz + r);
        pos[v] = h.cx + lx * cs + lz * sn; pos[v + 1] = h.y + (top ? h.height : 0.02); pos[v + 2] = h.cz - lx * sn + lz * cs;
        v += 3;
      }
      let k = tone.current.get(h.id);
      if (k === undefined) tone.current.set(h.id, (k = (hashString(`${h.owner}/${h.pile}`) >>> 0) % 1000 / 1000));
      const cr = 0.42 + 0.06 * k, cg = 0.4 + 0.05 * k, cb = 0.37 + 0.04 * k;
      for (let q = 0; q < 8; q++) { const f = q < 4 ? 1 : 0.8, o = (base + q) * 3; col[o] = cr * f; col[o + 1] = cg * f; col[o + 2] = cb * f; }
      idx[t++] = base; idx[t++] = base + 2; idx[t++] = base + 1; idx[t++] = base; idx[t++] = base + 3; idx[t++] = base + 2;
      for (let q = 0; q < 4; q++) {
        const a = base + q, b = base + ((q + 1) % 4), a2 = a + 4, b2 = b + 4;
        idx[t++] = a; idx[t++] = b; idx[t++] = b2; idx[t++] = a; idx[t++] = b2; idx[t++] = a2;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    geom.current?.dispose();
    geom.current = g;
    mesh.geometry = g;
  });
  return <mesh ref={ref} material={material} castShadow receiveShadow raycast={() => null} />;
}
