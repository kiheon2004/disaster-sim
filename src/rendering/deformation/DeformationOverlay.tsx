/**
 * Terrain deformation overlay in simulation mode (Phase 21, render-only):
 *
 *  - displacement  heatmap of the runtime field W on the deformed ground (blue down / red up);
 *  - original      wireframe of the ORIGINAL ground H₀ over the deformed region, so the
 *                  original and current surfaces can be compared directly (true scale);
 *  - vectors       vertical arrows from the original to the current ground on a 4 m lattice
 *                  (length × the chosen exaggeration — labelled in the panel; the ground,
 *                  objects and water are always drawn at true scale);
 *  - foundations   a ring at the base of every building on moving ground, colored by the
 *                  share of its footprint still in contact (green ≥ 95 %, amber ≥ 75 %, red).
 *
 * Everything is refreshed only when the engine applied a new update (engine.rev).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { unionRect, type GridRect } from '@/terrain/TerrainData';
import type { DeformationEngine } from '@/deformation/engine';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../viewStore';
import { useDeformationEngine } from '../terrain/runtimeGround';
import { FieldPatch, swapGeometry } from './fieldMesh';
import { footprint } from '@/simulation/deformation/response';
import { contactColor, displacementAlpha, displacementColor, displacementScale } from './deformColors';

const LATTICE = 4;
const MAX_ARROWS = 4096;
const MAX_RINGS = 1024;

/**
 * Union of the prescribed sources' vertex rectangles (where they make W non-zero). The ground-
 * failure field (Phase 22) covers the whole grid and has its own overlay (GroundOverlay).
 */
function regionOf(engine: DeformationEngine): GridRect | null {
  let r: GridRect | null = null;
  for (const s of engine.sources) if (s.kind !== 'groundFailure') r = unionRect(r, s.rect);
  return r;
}

function Overlay({ engine }: { engine: DeformationEngine }) {
  const viz = useViewStore((s) => s.deformViz);
  const nSources = useRef(-1);
  const patchRef = useRef<FieldPatch | null>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const lastRev = useRef(-1);
  const lastMode = useRef('');
  const groupRef = useRef<THREE.Group>(null);
  const { gl, camera } = useThree();
  // Compile the overlay's programs now (also while nothing is drawn yet): mounting happens while
  // the run is being prepared, not mid-run (Phase 22 first-frame analysis).
  useEffect(() => {
    if (groupRef.current) gl.compile(groupRef.current, camera);
  }, [gl, camera]);
  const arrows = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.12, 0.12, 1, 5).translate(0, 0.5, 0);
    // Drawn over the ground: an exaggerated downward arrow reaches below the current surface.
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }), MAX_ARROWS);
    // Instance colors must exist before the first render (the shader is compiled with them).
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ARROWS * 3).fill(1), 3);
    m.renderOrder = 6;
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => {};
    return m;
  }, []);
  const rings = useMemo(() => {
    const geo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }), MAX_RINGS);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3).fill(1), 3);
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => {};
    m.renderOrder = 5;
    return m;
  }, []);
  useEffect(() => () => {
    patchRef.current?.dispose();
    arrows.geometry.dispose();
    (arrows.material as THREE.Material).dispose();
    rings.geometry.dispose();
    (rings.material as THREE.Material).dispose();
  }, [arrows, rings]);

  useFrame(() => {
    const modeKey = `${viz.mode}|${viz.exaggeration}|${viz.foundations}`;
    if (engine.rev === lastRev.current && modeKey === lastMode.current) return;
    lastRev.current = engine.rev;
    lastMode.current = modeKey;
    const t = engine.terrain;
    // The region grows when a new source starts: rebuild the patch then.
    if (engine.sources.length !== nSources.current) {
      nSources.current = engine.sources.length;
      if (meshRef.current) meshRef.current.visible = false;
      patchRef.current?.dispose();
      const r = regionOf(engine);
      patchRef.current = r ? new FieldPatch(t, r) : null;
      if (meshRef.current) swapGeometry(meshRef.current, patchRef.current?.geometry ?? new THREE.BufferGeometry());
    }
    const p = patchRef.current;
    const scale = displacementScale(engine.maxAbs);
    const W = engine.field;
    if (p && meshRef.current) {
      meshRef.current.visible = viz.mode === 'displacement' || viz.mode === 'original';
      const mat = meshRef.current.material as THREE.MeshBasicMaterial;
      if (viz.mode === 'displacement') {
        p.write(t.heights, 0.05, (_l, g, out) => (displacementColor(W[g], scale, out), displacementAlpha(W[g], scale)));
        mat.wireframe = false;
        mat.opacity = 1;
      } else if (viz.mode === 'original') {
        p.write(engine.original, 0.03, (_l, g, out) => (Math.abs(W[g]) > 0.01 ? (out.set('#ffe9a8'), 0.85) : (out.set('#9aa4ad'), 0.25)));
        mat.wireframe = true;
        mat.opacity = 1;
      }
    }
    // Arrows: original → current ground, exaggerated length (labelled).
    const m4 = new THREE.Matrix4(), c = new THREE.Color(), q = new THREE.Quaternion(), down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    let n = 0;
    const region = p?.rect;
    if (viz.mode === 'vectors' && region) {
      const step = Math.max(1, Math.round(LATTICE / t.cellSize));
      for (let iz = region.z0; iz <= region.z1 && n < MAX_ARROWS; iz += step) for (let ix = region.x0; ix <= region.x1 && n < MAX_ARROWS; ix += step) {
        const g = iz * t.nx + ix, w = W[g];
        if (Math.abs(w) < 0.02) continue;
        const len = Math.abs(w) * viz.exaggeration;
        const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize;
        // Up arrows start at the original ground; down arrows start at the original ground and point down.
        q.copy(w > 0 ? new THREE.Quaternion() : down);
        m4.compose(new THREE.Vector3(x, engine.original[g] + (w > 0 ? 0 : 0.02), z), q, new THREE.Vector3(1, len, 1));
        arrows.setMatrixAt(n, m4);
        arrows.setColorAt(n, displacementColor(w, scale, c));
        n++;
      }
    }
    arrows.count = n;
    arrows.instanceMatrix.needsUpdate = true;
    if (arrows.instanceColor) arrows.instanceColor.needsUpdate = true;
    // Foundation contact rings.
    let k = 0;
    const rt = simulationController.getRuntime();
    const ground = simulationController.getEnvironment().terrain;
    if (viz.mode !== 'off' && viz.foundations && rt) {
      for (const e of rt.entities.values()) {
        if (!e.ground || e.source.type !== 'building' || k >= MAX_RINGS) continue;
        const { hx, hz } = footprint(e);
        const r = Math.max(1.5, Math.hypot(hx, hz));
        const pos = e.pose.position;
        m4.compose(new THREE.Vector3(pos[0], ground.sampleHeight(pos[0], pos[2]) + 0.12, pos[2]), new THREE.Quaternion(), new THREE.Vector3(r, 1, r));
        rings.setMatrixAt(k, m4);
        rings.setColorAt(k, contactColor(e.ground.contact, c));
        k++;
      }
    }
    rings.count = k;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  });

  return (
    <group name="deformation-overlay" ref={groupRef}>
      <mesh ref={meshRef} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial vertexColors transparent opacity={0.72} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <primitive object={arrows} />
      <primitive object={rings} />
    </group>
  );
}

export function DeformationOverlay() {
  const engine = useDeformationEngine();
  const mode = useViewStore((s) => s.deformViz.mode);
  if (!engine || mode === 'off') return null;
  return <Overlay engine={engine} />;
}
