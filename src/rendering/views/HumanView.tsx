import { useMemo } from 'react';
import type * as THREE from 'three';
import type { HumanParams } from '@/objects/definitions/human';
import { humanParts } from '../parts/objectParts';
import { MergedBoxes } from './MergedBoxes';
import type { ViewProps } from './types';

/** Minecraft-like blocky person (3 draw calls: body + two arms that can animate). */
export function HumanView({
  obj,
  armLRef,
  armRRef,
}: ViewProps & { armLRef?: React.Ref<THREE.Group>; armRRef?: React.Ref<THREE.Group> }) {
  const p = obj.params as HumanParams;
  const { body, arm, shoulderL, shoulderR } = useMemo(() => humanParts(p), [p]);
  return (
    <group>
      <MergedBoxes parts={body} />
      {/* Arms pivot at the shoulders so they can be raised during a gust */}
      <group ref={armLRef} position={shoulderL}>
        <MergedBoxes parts={arm} />
      </group>
      <group ref={armRRef} position={shoulderR}>
        <MergedBoxes parts={arm} />
      </group>
    </group>
  );
}
