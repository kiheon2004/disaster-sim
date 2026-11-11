import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import { seededRandom } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import { getPaletteItem } from '@/objects/palette';
import { createWorldObject } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { MaterialModeContext } from '@/rendering/materials';
import { StaticObjectView } from '@/rendering/views';
import { useEditorStore } from '../editorStore';
import { gridStep, useBuildStore } from '../buildStore';
import { isInsideWorld } from '../placement';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundPose, type GroundPose } from '@/terrain/groundPlacement';
import { collisionFootprint, FootprintIndex } from '../build/footprint';
import { checkPlacement, type PlacementWarning } from '../build/placementCheck';
import { GroundCatcher } from './shared';
import { itemDesign } from '../build/itemDesign';
import { placeRoadPiece } from '@/app/roadActions';
import { footprintHalves, snapPoint, type SnapTarget } from '../snap/snapEngine';
import { snapHint } from '../snap/snapHint';

/** Warnings of the place ghost, for the viewport hint (render-only state). */
export const useGhostWarnings = (() => {
  let current: PlacementWarning[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (w: PlacementWarning[]) => {
      if (w.join() === current.join()) return;
      current = w;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
})();

/**
 * Ghost preview that follows the cursor on the ground; click places the armed preset.
 * Phase 16: configurable grid step, terrain surface snapping on/off, and a collision / slope
 * warning tint (orange) — placement stays allowed; outside the world it is refused (red).
 */
export function PlaceTool() {
  const itemId = useEditorStore((s) => s.placeItemId);
  const ghostYaw = useEditorStore((s) => s.ghostYaw);
  const snap = useEditorStore((s) => s.snap);
  const randomize = useEditorStore((s) => s.randomize);
  const snapping = useBuildStore((s) => s.snapping);
  const item = getPaletteItem(itemId);
  const [pos, setPos] = useState<Vec3 | null>(null);
  // Phase 36 §13: what the cursor is snapped to (road lane / frontage give the heading too) + the previous target (hysteresis).
  const [snapped, setSnapped] = useState<SnapTarget | null>(null);
  const prevSnap = useRef<SnapTarget | null>(null);
  useEffect(() => () => snapHint.set(null), []);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const objects = useWorldStore((s) => s.doc.objects);
  const roads = useWorldStore((s) => s.doc.roads);
  const [variant, setVariant] = useState(() => Math.floor(Math.random() * 1e9));
  const creatorDesign = useBuildStore((s) => s.creator.design);

  // Re-roll the variation whenever a new preset is armed.
  useEffect(() => setVariant(Math.floor(Math.random() * 1e9)), [itemId]);
  useEffect(() => () => useGhostWarnings.set([]), []);
  // Published after each render (never during it).
  const warnRef = useRef<PlacementWarning[]>([]);
  useEffect(() => useGhostWarnings.set(warnRef.current));

  const preview = useMemo(() => {
    if (!item) return null;
    const def = getDefinition(item.type);
    // Modular building presets / the Building Creator's design (Phase 17).
    const building = itemDesign(item);
    let params: ObjectParams = { ...def.defaultParams, ...(item.params ?? {}) };
    if (!building && item.randomize && randomize && def.randomizeParams) {
      params = { ...params, ...(def.randomizeParams(params, seededRandom(variant)) as ObjectParams) };
    }
    const obj = createWorldObject({ type: item.type, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, params, seed: variant, building }, 0);
    return { obj, dims: def.getDimensions(obj.params), building };
  }, [item, variant, randomize, creatorDesign]);
  const existing = useMemo(() => (snapping.collisionWarning ? FootprintIndex.fromObjects(Object.values(objects)) : null), [objects, snapping.collisionWarning]);

  if (!item || !preview) return null;

  const footprint = Math.max(preview.dims[0], preview.dims[2]);
  const step = gridStep(snapping.grid, footprint);
  const yaw = snapped?.yaw ?? ghostYaw;
  const valid = pos ? isInsideWorld(pos, preview.dims, yaw) : false;
  const sampler = samplerFor(terrain);
  /** Seated pose: on the terrain by category rules, or level at the cursor height (snapping off). */
  const poseAt = (p: Vec3): GroundPose =>
    snapping.surface ? groundPose(preview.obj, p[0], p[2], yaw, sampler) : { position: [p[0], sampler.sampleHeight(p[0], p[2]), p[2]], rotation: [0, yaw, 0] };
  const ghost = pos ? poseAt(pos) : null;

  let warnings: PlacementWarning[] = [];
  if (ghost && valid && snapping.collisionWarning) {
    const placed = { type: item.type, params: preview.obj.params, transform: { position: ghost.position, rotation: ghost.rotation, scale: [1, 1, 1] as Vec3 } };
    warnings = checkPlacement(placed, sampler, useBuildStore.getState().placement.slopeLimit).warnings;
    const fp = collisionFootprint(item.type, preview.obj.params, [1, 1, 1], ghost.position[0], ghost.position[2], yaw);
    if (fp && existing?.overlaps(fp)) warnings.push('overlap');
  }
  warnRef.current = valid ? warnings : pos ? ['outside'] : [];

  /** Pointer ray → terrain hit, snapped (road / objects / structural grid / grid — editor/snap/snapEngine.ts). */
  const groundHit = (e: ThreeEvent<PointerEvent | MouseEvent>): { p: Vec3; target: SnapTarget | null } | null => {
    const o = e.ray.origin;
    const d = e.ray.direction;
    const hit: Vec3 = [0, 0, 0];
    if (!sampler.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, hit)) return null;
    if (!snap) return { p: [hit[0], 0, hit[2]], target: null };
    const target = snapPoint(
      { x: hit[0], z: hit[2], yaw: ghostYaw, half: footprintHalves(item.type, preview.obj.params), type: item.type },
      { objects: Object.values(objects), roads, grid: step, prev: prevSnap.current },
    );
    return { p: [target.x, 0, target.z], target };
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const h = groundHit(e);
    prevSnap.current = h?.target ?? null;
    setPos(h?.p ?? null);
    setSnapped(h?.target ?? null);
    snapHint.set(h?.target && h.target.kind !== 'grid' && h.target.kind !== 'free' ? h.target.kind : null, h?.target ? [h.target.x, h.target.z] : undefined);
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return; // ignore camera drags
    // Use the click's own hit point (hover state may lag behind a fast click).
    const h = groundHit(e);
    const at = h?.p ?? null;
    const placeYaw = h?.target?.yaw ?? ghostYaw;
    if (!at || !isInsideWorld(at, preview.dims, placeYaw)) return;
    e.stopPropagation();
    // Phase 35.5: palette roads are network roads with the item's cross-section preset (same section as the road tool and
    // the default world; ends join existing roads). Older files keep their road objects.
    if (item.type === 'road') {
      const params = preview.obj.params as { length?: number; lanes?: number };
      if (placeRoadPiece((params.lanes ?? 2) >= 4 ? 'avenue' : 'street', [at[0], at[2]], placeYaw, params.length ?? 20)) useBuildStore.getState().pushRecent(item.id);
      return;
    }
    useWorldStore.getState().addObject({
      type: item.type,
      params: preview.obj.params,
      seed: preview.obj.seed,
      building: preview.building,
      transform: { ...(snapping.surface ? groundPose(preview.obj, at[0], at[2], placeYaw, sampler) : { position: [at[0], sampler.sampleHeight(at[0], at[2]), at[2]] as Vec3, rotation: [0, placeYaw, 0] as Vec3 }), scale: [1, 1, 1] },
    });
    useBuildStore.getState().pushRecent(item.id);
    setVariant(Math.floor(Math.random() * 1e9));
  };

  return (
    <>
      <GroundCatcher onMove={onMove} onOut={() => setPos(null)} onClick={onClick} />
      {ghost && (
        <MaterialModeContext.Provider value={!valid ? 'ghostInvalid' : warnings.length ? 'ghostWarn' : 'ghost'}>
          <group position={ghost.position} rotation={ghost.rotation} raycast={() => null}>
            <StaticObjectView obj={preview.obj} />
          </group>
        </MaterialModeContext.Provider>
      )}
    </>
  );
}
