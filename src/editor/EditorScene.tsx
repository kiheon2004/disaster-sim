import { memo, useEffect, useMemo, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { WORLD_SIZE } from '@/core/units';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { StaticObjectView } from '@/rendering/views';
import { SelectionBox } from '@/rendering/SelectionBox';
import { entityNodeName } from '@/rendering/objectNames';
import { CastShadowContext, castsShadow } from '@/rendering/materials';
import { EditorBatches } from '@/rendering/editor/EditorBatches';
import { setEditorBatches } from '@/rendering/editor/editorRenderStats';
import { samplerFor } from '@/terrain/TerrainSampler';
import { clickSelect } from '@/app/buildActions';
import { useEditorStore } from './editorStore';
import { PlaceTool } from './tools/PlaceTool';
import { TerrainTool, isBrushTool } from './tools/TerrainTool';
import { NatureTool } from './tools/NatureTool';
import { StaticWaterLayer } from '@/rendering/landscape/StaticWaterLayer';
import { RoadTool } from './tools/RoadTool';
import { AreaTool, BrushTool, LineTool } from './tools/BulkTools';
import { PasteTool } from './tools/PasteTool';
import { TransformGizmo } from './TransformGizmo';
import { GroupSelection } from './GroupSelection';
import { MarqueeSelect } from './MarqueeSelect';
import { BuildingEditor } from './BuildingEditor';
import { useBuildingDraft } from './buildingDraft';

const mods = (e: ThreeEvent<MouseEvent>) => ({ shift: e.nativeEvent.shiftKey, alt: e.nativeEvent.altKey });

/**
 * One object drawn as its own React view: roads (few, textured, ground layer) and the single
 * selected object (the transform gizmo binds to its scene node). Everything else is batched.
 */
const EditorEntity = memo(function EditorEntity({
  obj,
  interactive,
  selected,
  hovered,
  objectCount,
}: {
  obj: WorldObject;
  objectCount: number;
  interactive: boolean;
  selected: boolean;
  hovered: boolean;
}) {
  const dims = useMemo(() => getDefinition(obj.type).getDimensions(obj.params), [obj.type, obj.params]);
  const handlers = interactive
    ? {
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.delta > 5 || useEditorStore.getState().dragging) return;
          clickSelect(obj.id, mods(e));
        },
        onPointerOver: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          useEditorStore.getState().hover(obj.id);
          document.body.style.cursor = 'pointer';
        },
        onPointerOut: () => {
          useEditorStore.getState().hover(null);
          document.body.style.cursor = '';
        },
      }
    : {};

  const { position, rotation, scale } = obj.transform;
  return (
    <group name={entityNodeName(obj.id)} position={position} rotation={rotation} scale={scale} {...handlers}>
      <CastShadowContext.Provider value={castsShadow(obj.type, objectCount)}>
        <StaticObjectView obj={obj} />
      </CastShadowContext.Provider>
      {(selected || hovered) && <SelectionBox dims={dims} color={selected ? '#4f8cff' : '#cfe0ff'} opacity={selected ? 1 : 0.6} />}
    </group>
  );
});

/**
 * Every non-road object through the instanced adapter (Phase 16 — same batches as the
 * simulation). `hide`: ids drawn elsewhere right now (the selection being edited).
 */
function EditorBatchLayer({ hide, interactive }: { hide: ReadonlySet<EntityId>; interactive: boolean }) {
  const objects = useWorldStore((s) => s.doc.objects);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const camera = useThree((s) => s.camera);
  // Created in an effect (StrictMode-safe, like SimRenderLayer).
  const [batches, setBatches] = useState<EditorBatches | null>(null);
  useEffect(() => {
    const b = new EditorBatches(samplerFor(useWorldStore.getState().doc.terrain));
    setBatches(b);
    setEditorBatches(b);
    return () => {
      setEditorBatches(null);
      b.dispose();
    };
  }, []);
  useEffect(() => {
    if (!batches) return;
    batches.setTerrain(samplerFor(terrain));
    batches.sync(objects, hide, camera);
  }, [batches, objects, terrain, hide, camera]);
  useFrame(({ camera: cam }) => batches?.updateLod(cam));

  const handlers = useMemo(
    () => ({
      onClick: (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.delta > 5 || useEditorStore.getState().dragging) return;
        const id = batches?.pick(e.object, e.batchId ?? e.instanceId);
        if (id) clickSelect(id, mods(e));
      },
      onPointerMove: (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        const id = batches?.pick(e.object, e.batchId ?? e.instanceId) ?? null;
        useEditorStore.getState().hover(id);
        document.body.style.cursor = id ? 'pointer' : '';
      },
      onPointerOut: () => {
        useEditorStore.getState().hover(null);
        document.body.style.cursor = '';
      },
    }),
    [batches],
  );
  if (!batches) return null;
  return <primitive object={batches.root} {...(interactive ? handlers : {})} />;
}

/** Hover outline for a batched object (one component for all). */
function HoverBox({ id }: { id: EntityId }) {
  const obj = useWorldStore((s) => s.doc.objects[id]);
  const dims = useMemo(() => (obj ? getDefinition(obj.type).getDimensions(obj.params) : null), [obj]);
  if (!obj || !dims) return null;
  const { position, rotation, scale } = obj.transform;
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <SelectionBox dims={dims} color="#cfe0ff" opacity={0.6} />
    </group>
  );
}

/** Click on empty ground clears the selection (Shift keeps it). */
function GroundDeselect() {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position-y={0.001}
      onClick={(e) => {
        if (e.delta > 5 || useEditorStore.getState().dragging || e.nativeEvent.shiftKey) return;
        useEditorStore.getState().select(null);
      }}
    >
      <planeGeometry args={[WORLD_SIZE * 3, WORLD_SIZE * 3]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

const EMPTY = new Set<EntityId>();

/** Editor-mode scene: renders the WorldDocument directly. */
export function EditorScene() {
  const objects = useWorldStore((s) => s.doc.objects);
  const tool = useEditorStore((s) => s.tool);
  const terrainTool = useEditorStore((s) => s.terrainTool);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const selectedId = useEditorStore((s) => s.selectedId);
  const hoveredId = useEditorStore((s) => s.hoveredId);
  const buildingId = useEditorStore((s) => s.buildingId);
  const draft = useBuildingDraft((s) => s.obj);
  const interactive = tool === 'select';
  const editingBuilding = tool === 'building' && buildingId ? buildingId : null;
  const count = Object.keys(objects).length;
  const multi = interactive && selectedIds.length > 1;
  const single = interactive && selectedIds.length === 1 ? selectedIds[0] : null;

  // Selected objects leave the batches while selected: the single one is a React view (gizmo),
  // a multi-selection is drawn by GroupSelection (rigid group drag without batch rebuilds).
  // Building Edit Mode (Phase 17): the edited building is drawn by the BuildingEditor.
  const hide = useMemo(
    () => (editingBuilding ? new Set([editingBuilding]) : interactive && selectedIds.length ? new Set(selectedIds) : EMPTY),
    [interactive, selectedIds, editingBuilding],
  );
  const live = useMemo(() => {
    const out: WorldObject[] = [];
    // (Roads of a multi-selection move with the group drawing.) A Building Creator draft is
    // drawn in place of the selected building while its parameters are being edited.
    for (const o of Object.values(objects)) {
      if ((o.type === 'road' && !(multi && hide.has(o.id))) || o.id === single) out.push(draft && draft.id === o.id ? draft : o);
    }
    return out;
  }, [objects, single, multi, hide, draft]);
  const hoverBatched = interactive && hoveredId && !hide.has(hoveredId) && objects[hoveredId]?.type !== 'road' ? hoveredId : null;

  return (
    <>
      <EditorBatchLayer hide={hide} interactive={interactive} />
      <StaticWaterLayer />
      {live.map((o) => (
        <EditorEntity
          key={o.id}
          obj={o}
          interactive={interactive}
          selected={interactive && (o.id === single || (multi && selectedIds.includes(o.id)))}
          hovered={interactive && o.id === hoveredId && o.id !== selectedId}
          objectCount={count}
        />
      ))}
      {hoverBatched && <HoverBox id={hoverBatched} />}
      {interactive && <GroundDeselect />}
      {interactive && <MarqueeSelect />}
      {tool === 'place' && <PlaceTool />}
      {tool === 'brush' && <BrushTool />}
      {tool === 'line' && <LineTool />}
      {tool === 'area' && <AreaTool />}
      {tool === 'paste' && <PasteTool />}
      {tool === 'terrain' && (isBrushTool(terrainTool) || terrainTool === 'inspect' ? <TerrainTool /> : <NatureTool />)}
      {tool === 'road' && <RoadTool />}
      {editingBuilding && <BuildingEditor />}
      {interactive && single && <TransformGizmo />}
      {multi && <GroupSelection ids={selectedIds} />}
    </>
  );
}
