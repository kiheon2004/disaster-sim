import { useMemo } from 'react';
import type * as THREE from 'three';
import type { StreetLightParams } from '@/objects/definitions/streetLight';
import { POLE_HALF } from '@/objects/definitions/streetLight';
import type { SignParams } from '@/objects/definitions/sign';
import type { WallParams } from '@/objects/definitions/wall';
import { ROAD_THICKNESS, type RoadParams } from '@/objects/definitions/road';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { shade } from '../materials';
import { asphaltTexture } from '../textures';
import { Box } from './Box';
import type { ViewProps } from './types';
import { useComponentHidden } from './useComponentHidden';

type LiveProps = ViewProps & { live?: RuntimeEntity };

export function StreetLightView({ obj, live }: LiveProps) {
  const p = obj.params as StreetLightParams;
  const lamp = useComponentHidden(live, 'lamp');
  return (
    <group>
      <Box size={[0.36, 0.3, 0.36]} position={[0, 0.15, 0]} color={shade(p.color, -0.1)} />
      <Box size={[POLE_HALF * 2, p.height, POLE_HALF * 2]} position={[0, p.height / 2, 0]} color={p.color} mat={{ metalness: 0.4, roughness: 0.5 }} />
      <Box size={[p.armLength, 0.1, 0.1]} position={[p.armLength / 2, p.height - 0.05, 0]} color={p.color} mat={{ metalness: 0.4, roughness: 0.5 }} />
      <group ref={lamp as React.Ref<THREE.Group>} position={[p.armLength, p.height - 0.2, 0]}>
        <Box size={[0.7, 0.18, 0.34]} color="#3d444c" />
        <Box size={[0.6, 0.06, 0.28]} position={[0, -0.11, 0]} color="#fff3c4" mat={{ emissive: '#ffe9a0', emissiveIntensity: 0.9 }} shadow={false} />
      </group>
    </group>
  );
}

export function SignView({ obj, live }: LiveProps) {
  const p = obj.params as SignParams;
  const panel = useComponentHidden(live, 'panel');
  const twoPosts = p.panelWidth > 3;
  const postX = twoPosts ? [-p.panelWidth * 0.32, p.panelWidth * 0.32] : [0];
  return (
    <group>
      {postX.map((x) => (
        <Box key={x} size={[0.12, p.height, 0.12]} position={[x, p.height / 2, 0]} color="#9aa3ad" mat={{ metalness: 0.5, roughness: 0.4 }} />
      ))}
      <group ref={panel as React.Ref<THREE.Group>} position={[0, p.height - p.panelHeight / 2, 0.08]}>
        <Box size={[p.panelWidth, p.panelHeight, 0.06]} color={p.color} />
        {/* White border + text bars so it reads as a sign from afar */}
        <Box size={[p.panelWidth * 0.92, 0.05, 0.065]} position={[0, p.panelHeight * 0.42, 0]} color="#f4f4f0" shadow={false} />
        <Box size={[p.panelWidth * 0.92, 0.05, 0.065]} position={[0, -p.panelHeight * 0.42, 0]} color="#f4f4f0" shadow={false} />
        <Box size={[p.panelWidth * 0.55, p.panelHeight * 0.12, 0.07]} position={[0, p.panelHeight * 0.1, 0]} color="#f4f4f0" shadow={false} />
        <Box size={[p.panelWidth * 0.35, p.panelHeight * 0.1, 0.07]} position={[-p.panelWidth * 0.1, -p.panelHeight * 0.15, 0]} color="#f4f4f0" shadow={false} />
      </group>
    </group>
  );
}

export function WallView({ obj }: LiveProps) {
  const p = obj.params as WallParams;
  // Brick courses for a voxel look.
  const courses = Math.max(1, Math.round(p.height / 0.5));
  return (
    <group>
      <Box size={[p.length, p.height, p.thickness]} position={[0, p.height / 2, 0]} color={p.color} />
      {Array.from({ length: courses - 1 }, (_, i) => (
        <Box
          key={i}
          size={[p.length + 0.01, 0.03, p.thickness + 0.01]}
          position={[0, ((i + 1) * p.height) / courses, 0]}
          color={shade(p.color, -0.12)}
          shadow={false}
        />
      ))}
      <Box size={[p.length + 0.06, 0.08, p.thickness + 0.06]} position={[0, p.height + 0.04, 0]} color={shade(p.color, -0.18)} />
    </group>
  );
}

export function RoadView({ obj }: LiveProps) {
  const p = obj.params as RoadParams;
  const tex = useMemo(() => {
    const t = asphaltTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(p.length / 2, p.width / 2);
    return t;
  }, [p.length, p.width]);
  const lanes = Math.max(1, Math.round(p.lanes));
  const laneW = p.width / lanes;
  const dashes = Math.max(1, Math.floor(p.length / 6));
  return (
    <group>
      <mesh position={[0, ROAD_THICKNESS / 2, 0]} receiveShadow>
        <boxGeometry args={[p.length, ROAD_THICKNESS, p.width]} />
        <meshStandardMaterial map={tex} roughness={0.95} />
      </mesh>
      {/* Edge lines */}
      {[-1, 1].map((s) => (
        <Box key={s} size={[p.length, 0.01, 0.15]} position={[0, ROAD_THICKNESS + 0.006, s * (p.width / 2 - 0.25)]} color="#e9e9e2" shadow={false} />
      ))}
      {/* Lane dividers: yellow center line, dashed white elsewhere */}
      {Array.from({ length: lanes - 1 }, (_, i) => {
        const z = -p.width / 2 + laneW * (i + 1);
        const center = lanes % 2 === 0 && i === lanes / 2 - 1;
        return center ? (
          <Box key={i} size={[p.length, 0.01, 0.2]} position={[0, ROAD_THICKNESS + 0.006, z]} color="#e8c547" shadow={false} />
        ) : (
          <group key={i}>
            {Array.from({ length: dashes }, (_, d) => (
              <Box key={d} size={[3, 0.01, 0.14]} position={[-p.length / 2 + 3 + d * 6, ROAD_THICKNESS + 0.006, z]} color="#e9e9e2" shadow={false} />
            ))}
          </group>
        );
      })}
    </group>
  );
}
