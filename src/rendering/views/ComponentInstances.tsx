import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ComponentSpec } from '@/core/model';
import { UNIT_BOX } from '../geometry/primitives';
import { useMat, useMaterialMode, type MatOptions } from '../materials';

const dummy = new THREE.Object3D();

/**
 * Renders a list of box-shaped components as one InstancedMesh.
 * `onInstances` exposes the mesh so live simulation views can hide/recolor instances.
 */
export function ComponentInstances(props: {
  components: ComponentSpec[];
  color: string;
  mat?: MatOptions;
  meshRef?: React.RefObject<THREE.InstancedMesh | null>;
  shadow?: boolean;
}) {
  const { components } = props;
  const localRef = useRef<THREE.InstancedMesh>(null);
  const ref = props.meshRef ?? localRef;
  const m = useMat();
  const ghost = useMaterialMode() !== 'normal';
  const material = useMemo(() => m(props.color, props.mat), [m, props.color, props.mat]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    components.forEach((c, i) => {
      dummy.position.set(c.position[0], c.position[1], c.position[2]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(c.size[0], c.size[1], c.size[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }, [components, ref]);

  if (components.length === 0) return null;
  return (
    <instancedMesh
      key={components.length}
      ref={ref}
      args={[UNIT_BOX, material, components.length]}
      castShadow={(props.shadow ?? true) && !ghost}
      receiveShadow={!ghost}
    />
  );
}
