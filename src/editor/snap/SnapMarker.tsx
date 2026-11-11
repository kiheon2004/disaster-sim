import { useEffect, useMemo, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { snapHint } from './snapHint';
import type { SnapKind } from './snapEngine';

export const SNAP_COLORS: Partial<Record<SnapKind, string>> = {
  roadNode: '#ffd166', roadLane: '#ffd166', roadFront: '#ffd166', objectCenter: '#9fd0ff', objectEdge: '#9fd0ff', structGrid: '#c3a6ff',
};
const COLORS = SNAP_COLORS;

/** The marker's shape (shared by the cursor's marker and the list of a command plan): a flat ring and a post. */
const RING: [number, number, number] = [0.55, 0.8, 32];
const POST: [number, number, number, number] = [0.05, 0.05, 2, 8];
const RING_OPACITY = 0.9, POST_OPACITY = 0.8, LIFT = 0.05, ORDER = 40;

/** A ring + post at the point the cursor is snapped to (Phase 36 §13): the snap is visible in the scene, not only in the hint. */
export function SnapMarker() {
  const kind = useSyncExternalStore(snapHint.subscribe, snapHint.get);
  const at = useSyncExternalStore(snapHint.subscribe, snapHint.point);
  const terrain = useWorldStore((s) => s.doc.terrain);
  if (!kind || !at) return null;
  const y = samplerFor(terrain).sampleHeight(at[0], at[1]);
  const color = COLORS[kind] ?? '#ffffff';
  return (
    <group position={[at[0], y + LIFT, at[1]]} renderOrder={ORDER} raycast={() => null}>
      <mesh rotation-x={-Math.PI / 2} raycast={() => null}>
        <ringGeometry args={RING} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={RING_OPACITY} />
      </mesh>
      <mesh position-y={1} raycast={() => null}>
        <cylinderGeometry args={POST} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={POST_OPACITY} />
      </mesh>
    </group>
  );
}

export interface SnapMarkItem {
  x: number;
  z: number;
  kind: SnapKind;
}

/**
 * The same marker at many points (Phase 37): what each item of a command plan is snapped to ("three houses" = three
 * road-front markers). Same shapes and colours as the cursor's marker; two instanced meshes for any number of items.
 */
export function SnapMarkers({ items }: { items: readonly SnapMarkItem[] }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const meshes = useMemo(() => {
    const sampler = samplerFor(terrain);
    const n = items.length;
    const ring = new THREE.InstancedMesh(new THREE.RingGeometry(...RING).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: RING_OPACITY }), n);
    const post = new THREE.InstancedMesh(new THREE.CylinderGeometry(...POST).translate(0, 1, 0), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: POST_OPACITY }), n);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    items.forEach((it, k) => {
      m.makeTranslation(it.x, sampler.sampleHeight(it.x, it.z) + LIFT, it.z);
      c.set(COLORS[it.kind] ?? '#ffffff');
      for (const mesh of [ring, post]) {
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, c);
      }
    });
    for (const mesh of [ring, post]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.renderOrder = ORDER;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
    }
    return [ring, post];
  }, [items, terrain]);
  useEffect(() => () => {
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }, [meshes]);
  if (!items.length) return null;
  return (
    <>
      {meshes.map((mesh, k) => <primitive key={k} object={mesh} />)}
    </>
  );
}
