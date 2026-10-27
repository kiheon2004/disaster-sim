import { memo, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { WorldObject } from '@/core/model';
import { WORLD_SIZE } from '@/core/units';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { StaticObjectView } from '@/rendering/views';
import { SelectionBox } from '@/rendering/SelectionBox';
import { entityNodeName } from '@/rendering/objectNames';
import { useEditorStore } from './editorStore';
import { PlaceTool } from './tools/PlaceTool';
import { TransformGizmo } from './TransformGizmo';

const EditorEntity = memo(function EditorEntity({
  obj,
  interactive,
  selected,
  hovered,
}: {
  obj: WorldObject;
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
          useEditorStore.getState().select(obj.id);
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
      <StaticObjectView obj={obj} />
      {(selected || hovered) && <SelectionBox dims={dims} color={selected ? '#4f8cff' : '#cfe0ff'} opacity={selected ? 1 : 0.6} />}
    </group>
  );
});

/** Click on empty ground clears the selection. */
function GroundDeselect() {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position-y={0.001}
      onClick={(e) => {
        if (e.delta > 5 || useEditorStore.getState().dragging) return;
        useEditorStore.getState().select(null);
      }}
    >
      <planeGeometry args={[WORLD_SIZE * 3, WORLD_SIZE * 3]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** Editor-mode scene: renders the WorldDocument directly. */
export function EditorScene() {
  const objects = useWorldStore((s) => s.doc.objects);
  const tool = useEditorStore((s) => s.tool);
  const selectedId = useEditorStore((s) => s.selectedId);
  const hoveredId = useEditorStore((s) => s.hoveredId);
  const interactive = tool === 'select';

  return (
    <>
      {Object.values(objects).map((o) => (
        <EditorEntity
          key={o.id}
          obj={o}
          interactive={interactive}
          selected={o.id === selectedId}
          hovered={interactive && o.id === hoveredId && o.id !== selectedId}
        />
      ))}
      {interactive && <GroundDeselect />}
      {tool === 'place' && <PlaceTool />}
      {interactive && <TransformGizmo />}
    </>
  );
}
