import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SimulationRuntime } from '@/simulation/SimulationRuntime';
import { simulationController } from '@/simulation/SimulationController';
import { segmentLine } from '@/roads/network';
import { sectionAt } from '@/roads/crossSection';
import { ROAD_IMPASSABLE, ROAD_INUNDATED, type RoadSegmentState } from '@/simulation/roads/RoadRuntime';

/** Overlay color of a damaged segment (null = intact, nothing drawn). */
export function roadDamageColor(st: RoadSegmentState): string | null {
  if (st.scour >= 1) return '#8d5a2b';
  if (st.crack >= 0.6) return '#e53935';
  if (st.crownDepth >= ROAD_IMPASSABLE) return '#1e63c8';
  // Ground deformation (Phase 21): cut by a step / grade (purple), steeper than 15 % (yellow).
  if (st.deform && !st.deform.passable) return '#9c3fd6';
  if (st.crack >= 0.05) return '#ff9800';
  if (st.deform && st.deform.grade >= 0.15 && st.deform.grade > st.deform.grade0 + 0.01) return '#f2d23c';
  if (st.depth >= ROAD_INUNDATED) return '#4f9be0';
  return null;
}

/**
 * Road damage in the simulation view (Phase 18): one merged ribbon mesh over the damaged
 * segments, colored by state (cracked orange, severe red, inundated light / dark blue, scoured
 * brown) with crack marks across the carriageway growing with the crack index. Rebuilt only when
 * the road runtime's revision changes (at most a few times per second while a hazard runs).
 */
export function RoadDamageOverlay({ runtime }: { runtime: SimulationRuntime }) {
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    m.renderOrder = 3;
    m.frustumCulled = false;
    m.raycast = () => {};
    return m;
  }, []);
  useEffect(() => () => {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }, [mesh]);
  const lastRev = useRef(-1);
  const lastBuild = useRef(0);

  useFrame(({ clock }) => {
    const roads = runtime.roads;
    if (!roads || roads.rev === lastRev.current) return;
    // Throttle rebuilds to 4 Hz (depth changes every few steps during a flood).
    if (clock.elapsedTime - lastBuild.current < 0.25 && lastRev.current >= 0) return;
    lastRev.current = roads.rev;
    lastBuild.current = clock.elapsedTime;
    const terrain = simulationController.getEnvironment().terrain;
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    for (const st of roads.segments) {
      const hex = roadDamageColor(st);
      if (!hex) continue;
      c.set(hex);
      const seg = roads.network.segments[st.id];
      const line = segmentLine(roads.network, seg);
      const S = line.samples;
      // Carriageway half width at each sample (Phase 36: it narrows inside a width taper).
      const half = S.map((p) => sectionAt(roads.network, seg, p.s).w);
      const y = (x: number, z: number) => terrain.sampleHeight(x, z) + 0.08;
      const quad = (a: number[], b: number[], cc: number[], d: number[], col3: THREE.Color) => {
        for (const p of [a, b, cc, a, cc, d]) { pos.push(p[0], p[1], p[2]); col.push(col3.r, col3.g, col3.b); }
      };
      for (let i = 0; i < S.length - 1; i++) {
        const p = S[i], q = S[i + 1];
        const L = (s: typeof p, o: number) => [s.x - s.tz * o, y(s.x - s.tz * o, s.z + s.tx * o), s.z + s.tx * o];
        quad(L(p, -half[i]), L(p, half[i]), L(q, half[i + 1]), L(q, -half[i + 1]), c);
      }
      // Crack marks: dark transverse strips, more of them the worse the cracking.
      if (st.crack >= 0.05) {
        const dark = new THREE.Color('#2b1a10');
        const every = Math.max(2, Math.round(12 * (1 - st.crack)));
        for (let i = 1; i < S.length - 1; i += every) {
          const p = S[i], w = half[i];
          const a = [p.x - p.tz * -w * 0.9 + p.tx * 0.12, 0, p.z + p.tx * -w * 0.9 + p.tz * 0.12];
          const b = [p.x - p.tz * w * 0.9 + p.tx * 0.12, 0, p.z + p.tx * w * 0.9 + p.tz * 0.12];
          const cc = [p.x - p.tz * w * 0.9 - p.tx * 0.12, 0, p.z + p.tx * w * 0.9 - p.tz * 0.12];
          const d = [p.x - p.tz * -w * 0.9 - p.tx * 0.12, 0, p.z + p.tx * -w * 0.9 - p.tz * 0.12];
          for (const v of [a, b, cc, d]) v[1] = y(v[0], v[2]) + 0.01;
          quad(a, b, cc, d, dark);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.visible = pos.length > 0;
  });
  return <primitive object={mesh} />;
}
