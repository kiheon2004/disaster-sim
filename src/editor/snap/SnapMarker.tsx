import { useSyncExternalStore } from 'react';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { snapHint } from './snapHint';
import type { SnapKind } from './snapEngine';

const COLORS: Partial<Record<SnapKind, string>> = {
  roadNode: '#ffd166', roadLane: '#ffd166', roadFront: '#ffd166', objectCenter: '#9fd0ff', objectEdge: '#9fd0ff', structGrid: '#c3a6ff',
};

/** A ring + post at the point the cursor is snapped to (Phase 36 §13): the snap is visible in the scene, not only in the hint. */
export function SnapMarker() {
  const kind = useSyncExternalStore(snapHint.subscribe, snapHint.get);
  const at = useSyncExternalStore(snapHint.subscribe, snapHint.point);
  const terrain = useWorldStore((s) => s.doc.terrain);
  if (!kind || !at) return null;
  const y = samplerFor(terrain).sampleHeight(at[0], at[1]);
  const color = COLORS[kind] ?? '#ffffff';
  return (
    <group position={[at[0], y + 0.05, at[1]]} renderOrder={40} raycast={() => null}>
      <mesh rotation-x={-Math.PI / 2} raycast={() => null}>
        <ringGeometry args={[0.55, 0.8, 32]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
      </mesh>
      <mesh position-y={1} raycast={() => null}>
        <cylinderGeometry args={[0.05, 0.05, 2, 8]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}
