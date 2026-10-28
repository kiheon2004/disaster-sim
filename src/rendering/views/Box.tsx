import { forwardRef } from 'react';
import type * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { UNIT_BOX } from '../geometry/primitives';
import { useContext } from 'react';
import { CastShadowContext, useMat, useMaterialMode, type MatOptions } from '../materials';

/** Voxel-style box primitive: unit geometry scaled to `size`, positioned at its center. */
export const Box = forwardRef<THREE.Mesh, {
  size: Vec3;
  position?: Vec3;
  rotation?: Vec3;
  color: string;
  mat?: MatOptions;
  shadow?: boolean;
}>(function Box({ size, position, rotation, color, mat, shadow = true }, ref) {
  const m = useMat();
  const ghost = useMaterialMode() !== 'normal';
  const lod = useContext(CastShadowContext);
  return (
    <mesh
      ref={ref}
      geometry={UNIT_BOX}
      material={m(color, mat)}
      position={position}
      rotation={rotation}
      scale={size}
      castShadow={shadow && !ghost && lod}
      receiveShadow={!ghost}
    />
  );
});
