import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ComponentKind, ComponentSpec } from '@/core/model';
import type { BuildingParams } from '@/objects/definitions/building';
import type { RuntimeComponent, RuntimeEntity } from '@/simulation/SimulationRuntime';
import { buildingPlinthParts, buildingShellParts, buildingSignParts, FACADE_STYLE, facadeColor, groupComponents, PART_MATS } from '../parts/objectParts';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { MergedBoxes } from './MergedBoxes';
import { ComponentInstances } from './ComponentInstances';
import type { ViewProps } from './types';

export { groupComponents };
const BROKEN_GLASS = new THREE.Color(0.1, 0.11, 0.13);
const WHITE = new THREE.Color(1, 1, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const dummy = new THREE.Object3D();

type InstancedKinds = 'window' | 'roof' | 'wall' | 'exterior';
const INSTANCED: InstancedKinds[] = ['window', 'roof', 'wall', 'exterior'];

/**
 * Applies runtime component conditions to the instanced meshes when `live.rev` changes:
 * broken windows turn dark, detached parts are hidden (they continue as debris bodies).
 */
function useLiveComponents(
  live: RuntimeEntity | undefined,
  groups: Partial<Record<ComponentKind, ComponentSpec[]>>,
  refs: Record<InstancedKinds, React.RefObject<THREE.InstancedMesh | null>>,
  signRef: React.RefObject<THREE.Group | null>,
  structureRef: React.RefObject<THREE.Group | null>,
) {
  const lastRev = useRef(-1);
  const byId = useMemo(() => {
    const m = new Map<string, RuntimeComponent>();
    live?.components.forEach((c) => m.set(c.spec.id, c));
    return m;
  }, [live]);

  useFrame(() => {
    if (!live || live.rev === lastRev.current) return;
    lastRev.current = live.rev;
    for (const kind of INSTANCED) {
      const mesh = refs[kind].current;
      const list = groups[kind];
      if (!mesh || !list) continue;
      list.forEach((spec, i) => {
        const rc = byId.get(spec.id);
        if (rc?.condition === 'detached') {
          mesh.setMatrixAt(i, HIDDEN);
        } else {
          dummy.position.set(...spec.position);
          dummy.scale.set(...spec.size);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        if (kind === 'window') mesh.setColorAt(i, rc && rc.condition !== 'intact' ? BROKEN_GLASS : WHITE);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const sign = byId.get('sign');
    if (signRef.current) signRef.current.visible = !sign || sign.condition !== 'detached';
    if (structureRef.current) structureRef.current.visible = !live.flags.collapsed;
  });
}

export function BuildingView({ obj, live }: ViewProps & { live?: RuntimeEntity }) {
  const p = obj.params as BuildingParams;
  const groups = useMemo(() => groupComponents(obj.components), [obj.components]);
  const sign = groups.sign?.[0];

  const refs = {
    window: useRef<THREE.InstancedMesh>(null),
    roof: useRef<THREE.InstancedMesh>(null),
    wall: useRef<THREE.InstancedMesh>(null),
    exterior: useRef<THREE.InstancedMesh>(null),
  };
  const signRef = useRef<THREE.Group>(null);
  const structureRef = useRef<THREE.Group>(null);
  useLiveComponents(live, groups, refs, signRef, structureRef);

  // Core volume, plinth, floor bands and roof slab baked into one mesh.
  const shell = useMemo(() => buildingShellParts(p), [p]);
  const signParts = useMemo(() => (sign ? buildingSignParts(sign) : null), [sign]);
  // Slope foundation (editor view; the simulation adapter draws the same parts).
  const terrain = useWorldStore((s) => s.doc.terrain);
  const plinthDepth = useMemo(() => foundationPlinth(obj, samplerFor(terrain)) / obj.transform.scale[1], [obj, terrain]);
  const plinth = useMemo(() => buildingPlinthParts(p, plinthDepth), [p, plinthDepth]);

  return (
    <group ref={structureRef}>
      <MergedBoxes parts={shell} />
      {plinth.length > 0 && <MergedBoxes parts={plinth} />}

      {INSTANCED.map((kind) => (
        <ComponentInstances
          key={kind}
          meshRef={refs[kind]}
          components={groups[kind] ?? []}
          color={facadeColor(kind, p)}
          mat={FACADE_STYLE[kind].mat}
          shadow={FACADE_STYLE[kind].shadow}
        />
      ))}

      {sign && signParts && (
        <group position={sign.position} ref={signRef}>
          <MergedBoxes parts={signParts} mat={PART_MATS.shopSign} />
        </group>
      )}
    </group>
  );
}
