import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ComponentKind, ComponentSpec } from '@/core/model';
import { buildingHeight, type BuildingParams } from '@/objects/definitions/building';
import type { RuntimeComponent, RuntimeEntity } from '@/simulation/SimulationRuntime';
import { shade } from '../materials';
import { MergedBoxes, type BoxPart } from './MergedBoxes';
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

  // Core volume, plinth, floor bands and roof slab baked into one mesh.
  const shell = useMemo<BoxPart[]>(() => {
    const out: BoxPart[] = [
      { size: [p.width, H, p.depth], position: [0, H / 2, 0], color: p.color },
      { size: [p.width + 0.16, 0.45, p.depth + 0.16], position: [0, 0.225, 0], color: shade(p.color, -0.22) },
      { size: [p.width + 0.06, 0.1, p.depth + 0.06], position: [0, H, 0], color: shade(p.color, -0.3) },
    ];
    for (let i = 1; i < p.floors; i++) out.push({ size: [p.width + 0.1, 0.16, p.depth + 0.1], position: [0, i * p.floorHeight, 0], color: bandColor });
    return out;
  }, [p.width, p.depth, p.floors, p.floorHeight, p.color, H, bandColor]);
  const signParts = useMemo<BoxPart[] | null>(() => {
    if (!sign) return null;
    const strip: [number, number, number] = sign.normal && sign.normal[2] !== 0
      ? [sign.size[0] * 0.8, sign.size[1] * 0.36, sign.size[2] + 0.02]
      : [sign.size[0] + 0.02, sign.size[1] * 0.36, sign.size[2] * 0.8];
    return [
      { size: sign.size, color: sign.color ?? '#e8483b' },
      // Lettering strip so the sign reads as a sign
      { size: strip, color: '#fff4d6' },
    ];
  }, [sign]);

  return (
    <group ref={structureRef}>
      <MergedBoxes parts={shell} />

      <ComponentInstances meshRef={refs.window} components={groups.window ?? []} color="#7fa8cc" mat={GLASS} shadow={false} />
      <ComponentInstances meshRef={refs.roof} components={groups.roof ?? []} color="#76797e" />
      <ComponentInstances meshRef={refs.wall} components={groups.wall ?? []} color={shade(p.color, -0.06)} />
      <ComponentInstances meshRef={refs.exterior} components={groups.exterior ?? []} color="#d6d9dc" mat={{ roughness: 0.5, metalness: 0.3 }} />

      {sign && signParts && (
        <group position={sign.position} ref={signRef}>
          <MergedBoxes parts={signParts} mat={{ emissive: '#3a1a10', emissiveIntensity: 0.5 }} />
        </group>
      )}
    </group>
  );
}
