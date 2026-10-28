import { forwardRef, useContext, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { UNIT_BOX } from '../geometry/primitives';
import { CastShadowContext, useMaterialMode, ghostFor } from '../materials';

import type { BoxPart, MergedMatOptions } from '../parts/objectParts';
export type { BoxPart, MergedMatOptions };

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpC = new THREE.Color();
const nonIndexed = UNIT_BOX.toNonIndexed();
const BASE_POS = nonIndexed.getAttribute('position') as THREE.BufferAttribute;
const BASE_NRM = nonIndexed.getAttribute('normal') as THREE.BufferAttribute;
const VPB = BASE_POS.count; // vertices per box (36)

/** Bake many colored boxes into one BufferGeometry (one draw call instead of one per box). */
export function buildMergedGeometry(parts: BoxPart[]): THREE.BufferGeometry {
  const pos = new Float32Array(parts.length * VPB * 3);
  const nrm = new Float32Array(parts.length * VPB * 3);
  const col = new Float32Array(parts.length * VPB * 3);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  parts.forEach((p, i) => {
    tmpQ.setFromEuler(tmpE.set(...(p.rotation ?? [0, 0, 0])));
    tmpM.compose(new THREE.Vector3(...(p.position ?? [0, 0, 0])), tmpQ, new THREE.Vector3(...p.size));
    nm.getNormalMatrix(tmpM);
    tmpC.set(p.color);
    for (let k = 0; k < VPB; k++) {
      const o = (i * VPB + k) * 3;
      v.fromBufferAttribute(BASE_POS, k).applyMatrix4(tmpM);
      pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
      v.fromBufferAttribute(BASE_NRM, k).applyMatrix3(nm).normalize();
      nrm[o] = v.x; nrm[o + 1] = v.y; nrm[o + 2] = v.z;
      col[o] = tmpC.r; col[o + 1] = tmpC.g; col[o + 2] = tmpC.b;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function vertexColorMaterial(o: MergedMatOptions = {}) {
  const key = `${o.roughness ?? 0.85}|${o.metalness ?? 0}|${o.emissive ?? ''}|${o.emissiveIntensity ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: o.roughness ?? 0.85,
      metalness: o.metalness ?? 0,
      emissive: o.emissive ? new THREE.Color(o.emissive) : undefined,
      emissiveIntensity: o.emissiveIntensity ?? 0,
    });
    matCache.set(key, m);
  }
  return m;
}

/** Renders a memoized list of box parts as a single mesh. Pass a stable (memoized) `parts` array. */
export const MergedBoxes = forwardRef<THREE.Mesh, { parts: BoxPart[]; mat?: MergedMatOptions; shadow?: boolean; position?: Vec3 }>(
  function MergedBoxes({ parts, mat, shadow = true, position }, ref) {
    const geometry = useMemo(() => buildMergedGeometry(parts), [parts]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    const mode = useMaterialMode();
    const lod = useContext(CastShadowContext);
    const ghost = mode !== 'normal';
    const material = ghost ? ghostFor(mode) : vertexColorMaterial(mat);
    return <mesh ref={ref} geometry={geometry} material={material} position={position} castShadow={shadow && !ghost && lod} receiveShadow={!ghost} />;
  },
);
