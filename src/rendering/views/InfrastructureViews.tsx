import { useContext, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { StreetLightParams } from '@/objects/definitions/streetLight';
import type { SignParams } from '@/objects/definitions/sign';
import type { WallParams } from '@/objects/definitions/wall';
import { ROAD_THICKNESS, type RoadParams } from '@/objects/definitions/road';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { asphaltTexture } from '../textures';
import { PART_MATS, roadLineParts, signParts, streetLightParts, wallParts } from '../parts/objectParts';
import { MergedBoxes } from './MergedBoxes';
import type { ViewProps } from './types';
import { useComponentHidden } from './useComponentHidden';
import { MaterialModeContext } from '../materials';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { drapedRoadLines, drapedRoadSurface } from '../terrain/drapeRoad';

type LiveProps = ViewProps & { live?: RuntimeEntity };

export function StreetLightView({ obj, live }: LiveProps) {
  const p = obj.params as StreetLightParams;
  const lamp = useComponentHidden(live, 'lamp');
  const { pole, head, headPos } = useMemo(() => streetLightParts(p), [p]);
  return (
    <group>
      <MergedBoxes parts={pole} mat={PART_MATS.pole} />
      <group ref={lamp as React.Ref<THREE.Group>} position={headPos}>
        <MergedBoxes parts={head} mat={PART_MATS.lamp} />
      </group>
    </group>
  );
}

export function SignView({ obj, live }: LiveProps) {
  const p = obj.params as SignParams;
  const panelRef = useComponentHidden(live, 'panel');
  const { posts, panel, panelPos } = useMemo(() => signParts(p), [p]);
  return (
    <group>
      <MergedBoxes parts={posts} mat={PART_MATS.signPost} />
      <group ref={panelRef as React.Ref<THREE.Group>} position={panelPos}>
        <MergedBoxes parts={panel} />
      </group>
    </group>
  );
}

export function WallView({ obj }: LiveProps) {
  const p = obj.params as WallParams;
  const parts = useMemo(() => wallParts(p), [p]);
  return <MergedBoxes parts={parts} />;
}

export function RoadView({ obj }: LiveProps) {
  const p = obj.params as RoadParams;
  const tex = useMemo(() => {
    const t = asphaltTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(p.length / 2, p.width / 2);
    return t;
  }, [p.length, p.width]);
  const lines = useMemo(() => roadLineParts(p), [p]);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const ghost = useContext(MaterialModeContext) !== 'normal';
  // On relief the road surface follows the ground (placement ghosts stay a flat preview).
  const drape = useMemo(() => {
    const sampler = samplerFor(terrain);
    if (ghost || sampler.flat) return null;
    return { surface: drapedRoadSurface(p, obj.transform, sampler), lines: drapedRoadLines(lines, obj.transform, sampler) };
  }, [terrain, ghost, p, obj.transform, lines]);
  useEffect(() => () => {
    drape?.surface.dispose();
    drape?.lines.dispose();
  }, [drape]);
  if (drape) {
    return (
      <group>
        <mesh geometry={drape.surface} receiveShadow>
          <meshStandardMaterial map={tex} roughness={0.95} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
        <mesh geometry={drape.lines}>
          <meshStandardMaterial vertexColors roughness={0.8} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  }
  return (
    <group>
      <mesh position={[0, ROAD_THICKNESS / 2, 0]} receiveShadow>
        <boxGeometry args={[p.length, ROAD_THICKNESS, p.width]} />
        <meshStandardMaterial map={tex} roughness={0.95} />
      </mesh>
      <MergedBoxes parts={lines} shadow={false} />
    </group>
  );
}
