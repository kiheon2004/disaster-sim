import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';

/** Wireframe bounding box + footprint used for hover/selection feedback. */
export function SelectionBox({ dims, color, opacity = 1 }: { dims: Vec3; color: string; opacity?: number }) {
  const geom = useMemo(() => {
    const pad = 0.15;
    return new THREE.EdgesGeometry(new THREE.BoxGeometry(dims[0] + pad, dims[1] + pad, dims[2] + pad));
  }, [dims[0], dims[1], dims[2]]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <group>
      <lineSegments geometry={geom} position={[0, dims[1] / 2, 0]} raycast={() => null} renderOrder={10}>
        <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={false} />
      </lineSegments>
      <mesh rotation-x={-Math.PI / 2} position-y={0.04} raycast={() => null}>
        <planeGeometry args={[dims[0] + 0.6, dims[2] + 0.6]} />
        <meshBasicMaterial color={color} transparent opacity={0.16 * opacity} depthWrite={false} />
      </mesh>
    </group>
  );
}
