import { useEffect, useMemo, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import { WORLD_SIZE } from '@/core/units';
import { seededRandom } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import { getPaletteItem } from '@/objects/palette';
import { createWorldObject } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { MaterialModeContext } from '@/rendering/materials';
import { StaticObjectView } from '@/rendering/views';
import { useEditorStore } from '../editorStore';
import { isInsideWorld, snapPoint } from '../placement';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundPose, type GroundPose } from '@/terrain/groundPlacement';

/** Ghost preview that follows the cursor on the ground; click places the armed preset. */
export function PlaceTool() {
  const itemId = useEditorStore((s) => s.placeItemId);
  const yaw = useEditorStore((s) => s.ghostYaw);
  const snap = useEditorStore((s) => s.snap);
  const randomize = useEditorStore((s) => s.randomize);
  const item = getPaletteItem(itemId);
  const [pos, setPos] = useState<Vec3 | null>(null);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const [variant, setVariant] = useState(() => Math.floor(Math.random() * 1e9));

  // Re-roll the variation whenever a new preset is armed.
  useEffect(() => setVariant(Math.floor(Math.random() * 1e9)), [itemId]);

  const preview = useMemo(() => {
    if (!item) return null;
    const def = getDefinition(item.type);
    let params: ObjectParams = { ...def.defaultParams, ...(item.params ?? {}) };
    if (item.randomize && randomize && def.randomizeParams) {
      params = { ...params, ...(def.randomizeParams(params, seededRandom(variant)) as ObjectParams) };
    }
    const obj = createWorldObject({ type: item.type, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, params, seed: variant }, 0);
    return { obj, dims: def.getDimensions(params) };
  }, [item, variant, randomize]);

  if (!item || !preview) return null;

  const footprint = Math.max(preview.dims[0], preview.dims[2]);
  const valid = pos ? isInsideWorld(pos, preview.dims, yaw) : false;
  const sampler = samplerFor(terrain);
  /** Seated pose on the terrain for the armed preset (level / tilted per category). */
  const poseAt = (p: Vec3): GroundPose => groundPose(preview.obj, p[0], p[2], yaw, sampler);
  const ghost = pos ? poseAt(pos) : null;

  /** Intersect the pointer ray with the terrain data (independent of mesh matrices), snap x/z. */
  const groundHit = (e: ThreeEvent<PointerEvent | MouseEvent>): Vec3 | null => {
    const o = e.ray.origin;
    const d = e.ray.direction;
    const hit: Vec3 = [0, 0, 0];
    return sampler.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, hit) ? snapPoint(hit, snap, footprint) : null;
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => setPos(groundHit(e));
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return; // ignore camera drags
    // Use the click's own hit point (hover state may lag behind a fast click).
    const at = groundHit(e);
    if (!at || !isInsideWorld(at, preview.dims, yaw)) return;
    e.stopPropagation();
    useWorldStore.getState().addObject({
      type: item.type,
      params: preview.obj.params,
      seed: preview.obj.seed,
      transform: { ...poseAt(at), scale: [1, 1, 1] },
    });
    setVariant(Math.floor(Math.random() * 1e9));
  };

  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-60} onPointerMove={onMove} onPointerOut={() => setPos(null)} onClick={onClick}>
        <planeGeometry args={[WORLD_SIZE * 3, WORLD_SIZE * 3]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {ghost && (
        <MaterialModeContext.Provider value={valid ? 'ghost' : 'ghostInvalid'}>
          <group position={ghost.position} rotation={ghost.rotation} raycast={() => null}>
            <StaticObjectView obj={preview.obj} />
          </group>
        </MaterialModeContext.Provider>
      )}
    </>
  );
}
