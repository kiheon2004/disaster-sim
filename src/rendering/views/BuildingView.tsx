import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ComponentKind, ComponentSpec } from '@/core/model';
import { buildingHeight, type BuildingParams } from '@/objects/definitions/building';
import type { RuntimeComponent, RuntimeEntity } from '@/simulation/SimulationRuntime';
import { shade } from '../materials';
import { Box } from './Box';
import { ComponentInstances } from './ComponentInstances';
import type { ViewProps } from './types';

const GLASS = { roughness: 0.15, metalness: 0.3, emissive: '#2a4258', emissiveIntensity: 0.35 };
const BROKEN_GLASS = new THREE.Color(0.1, 0.11, 0.13);
const WHITE = new THREE.Color(1, 1, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const dummy = new THREE.Object3D();

export function groupComponents(components: ComponentSpec[]) {
  const groups: Partial<Record<ComponentKind, ComponentSpec[]>> = {};
  for (const c of components) (groups[c.kind] ??= []).push(c);
  return groups;
}

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
  const H = buildingHeight(p);
  const groups = useMemo(() => groupComponents(obj.components), [obj.components]);
  const bandColor = shade(p.color, -0.12);
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

  return (
    <group ref={structureRef}>
      {/* Core volume */}
      <Box size={[p.width, H, p.depth]} position={[0, H / 2, 0]} color={p.color} />
      {/* Plinth */}
      <Box size={[p.width + 0.16, 0.45, p.depth + 0.16]} position={[0, 0.225, 0]} color={shade(p.color, -0.22)} />
      {/* Floor slabs as horizontal bands */}
      {Array.from({ length: p.floors - 1 }, (_, i) => (
        <Box
          key={i}
          size={[p.width + 0.1, 0.16, p.depth + 0.1]}
          position={[0, (i + 1) * p.floorHeight, 0]}
          color={bandColor}
          shadow={false}
        />
      ))}
      {/* Roof slab */}
      <Box size={[p.width + 0.06, 0.1, p.depth + 0.06]} position={[0, H, 0]} color={shade(p.color, -0.3)} shadow={false} />

      <ComponentInstances meshRef={refs.window} components={groups.window ?? []} color="#7fa8cc" mat={GLASS} shadow={false} />
      <ComponentInstances meshRef={refs.roof} components={groups.roof ?? []} color="#76797e" />
      <ComponentInstances meshRef={refs.wall} components={groups.wall ?? []} color={shade(p.color, -0.06)} />
      <ComponentInstances meshRef={refs.exterior} components={groups.exterior ?? []} color="#d6d9dc" mat={{ roughness: 0.5, metalness: 0.3 }} />

      {sign && (
        <group position={sign.position} ref={signRef}>
          <Box size={sign.size} color={sign.color ?? '#e8483b'} mat={{ emissive: '#5a0d08', emissiveIntensity: 0.4 }} />
          {/* Lettering strip so the sign reads as a sign */}
          <Box
            size={sign.normal && sign.normal[2] !== 0
              ? [sign.size[0] * 0.8, sign.size[1] * 0.36, sign.size[2] + 0.02]
              : [sign.size[0] + 0.02, sign.size[1] * 0.36, sign.size[2] * 0.8]}
            color="#fff4d6"
            mat={{ emissive: '#fff0c0', emissiveIntensity: 0.25 }}
            shadow={false}
          />
        </group>
      )}
    </group>
  );
}
