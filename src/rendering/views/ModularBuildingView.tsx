import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { WorldObject } from '@/core/model';
import { identityTransform } from '@/core/types';
import type { BuildingParams } from '@/objects/definitions/building';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { flatSampler, samplerFor } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { useWorldStore } from '@/world/worldStore';
import { ghostFor, useMaterialMode } from '../materials';
import { buildingPlinthParts } from '../parts/objectParts';
import { MergedBoxes } from './MergedBoxes';

const cam = new THREE.PerspectiveCamera();

/**
 * One modular building (Phase 17) drawn through the same member layer the batches use — the
 * selected building in the editor, the placement ghost, previews. Object-local: the parent group
 * applies the transform; the slope plinth is drawn here from the real placement.
 */
export function ModularBuildingView({ obj, revealed = false }: { obj: WorldObject; revealed?: boolean }) {
  const mode = useMaterialMode();
  const [adapter, setAdapter] = useState<SimRenderAdapter | null>(null);
  useEffect(() => {
    const local: WorldObject = { ...obj, transform: identityTransform() };
    const a = new SimRenderAdapter(staticRuntime([local]), flatSampler());
    a.update(cam, 0, 0);
    a.cullEmpty();
    if (revealed) a.setRevealed(obj.id, true);
    if (mode !== 'normal') a.setMaterialOverride(ghostFor(mode));
    setAdapter(a);
    return () => a.dispose();
  }, [obj, mode, revealed]);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const plinth = useMemo(() => buildingPlinthParts(obj.params as BuildingParams, foundationPlinth(obj, samplerFor(terrain)) / obj.transform.scale[1]), [obj, terrain]);
  return (
    <>
      {adapter && <primitive object={adapter.root} />}
      {plinth.length > 0 && <MergedBoxes parts={plinth} />}
    </>
  );
}
