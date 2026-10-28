import { useMemo } from 'react';
import type * as THREE from 'three';
import type { TreeParams } from '@/objects/definitions/tree';
import { PART_MATS, treeParts } from '../parts/objectParts';
import { MergedBoxes } from './MergedBoxes';
import type { ViewProps } from './types';

export { buildCanopy } from '../parts/objectParts';

export function TreeView({
  obj,
  part = 'all',
  canopyRef,
}: ViewProps & { part?: 'all' | 'stump' | 'upper'; canopyRef?: React.Ref<THREE.Group> }) {
  const p = obj.params as TreeParams;
  const { stump, trunk, canopy, pivot } = useMemo(() => treeParts(p, obj.seed), [p, obj.seed]);
  return (
    <group>
      {/* Stump: stays in place when the trunk snaps */}
      {part !== 'upper' && <MergedBoxes parts={stump} />}
      {/* Upper part: sways as one unit and becomes the falling body after failure */}
      {part !== 'stump' && (
        <group>
          <MergedBoxes parts={trunk} />
          <group ref={canopyRef} position={[0, pivot, 0]}>
            <MergedBoxes parts={canopy} mat={PART_MATS.foliage} />
          </group>
        </group>
      )}
    </group>
  );
}
