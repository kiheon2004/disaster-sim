import { useMemo } from 'react';
import type { ComponentKind, ComponentSpec } from '@/core/model';
import { buildingHeight, type BuildingParams } from '@/objects/definitions/building';
import { shade } from '../materials';
import { Box } from './Box';
import { ComponentInstances } from './ComponentInstances';
import type { ViewProps } from './types';

const GLASS = { roughness: 0.15, metalness: 0.3, emissive: '#2a4258', emissiveIntensity: 0.35 };

export function groupComponents(components: ComponentSpec[]) {
  const groups: Partial<Record<ComponentKind, ComponentSpec[]>> = {};
  for (const c of components) (groups[c.kind] ??= []).push(c);
  return groups;
}

export function BuildingView({ obj }: ViewProps) {
  const p = obj.params as BuildingParams;
  const H = buildingHeight(p);
  const groups = useMemo(() => groupComponents(obj.components), [obj.components]);
  const bandColor = shade(p.color, -0.12);
  const sign = groups.sign?.[0];

  return (
    <group>
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
      <Box size={[p.width + 0.06, 0.1, p.depth + 0.06]} position={[0, H + 0.0, 0]} color={shade(p.color, -0.3)} shadow={false} />

      <ComponentInstances components={groups.window ?? []} color="#7fa8cc" mat={GLASS} shadow={false} />
      <ComponentInstances components={groups.roof ?? []} color="#76797e" />
      <ComponentInstances components={groups.wall ?? []} color={shade(p.color, -0.06)} />
      <ComponentInstances components={groups.exterior ?? []} color="#d6d9dc" mat={{ roughness: 0.5, metalness: 0.3 }} />

      {sign && (
        <group position={sign.position}>
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
