import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import type * as THREE from 'three';
import { degToRad } from '@/core/math';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from './editorStore';
import { entityNodeName } from '@/rendering/objectNames';

/** Move / rotate / scale gizmo bound to the selected object. Writes back to the world store. */
export function TransformGizmo() {
  const selectedId = useEditorStore((s) => s.selectedId);
  const mode = useEditorStore((s) => s.transformMode);
  const snap = useEditorStore((s) => s.snap);
  const exists = useWorldStore((s) => (selectedId ? !!s.doc.objects[selectedId] : false));
  const scene = useThree((s) => s.scene);
  const [target, setTarget] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    setTarget(selectedId && exists ? scene.getObjectByName(entityNodeName(selectedId)) ?? null : null);
  }, [selectedId, exists, scene]);

  if (!target || !selectedId) return null;

  const write = () => {
    if (target.position.y < 0) target.position.y = 0;
    target.scale.set(
      Math.max(0.1, target.scale.x),
      Math.max(0.1, target.scale.y),
      Math.max(0.1, target.scale.z),
    );
    useWorldStore.getState().updateTransform(
      selectedId,
      {
        position: [target.position.x, target.position.y, target.position.z],
        rotation: [target.rotation.x, target.rotation.y, target.rotation.z],
        scale: [target.scale.x, target.scale.y, target.scale.z],
      },
      { history: false },
    );
  };

  return (
    <TransformControls
      object={target}
      mode={mode}
      size={0.8}
      space={mode === 'translate' ? 'world' : 'local'}
      showX={mode !== 'rotate'}
      showZ={mode !== 'rotate'}
      translationSnap={snap ? 0.5 : null}
      rotationSnap={snap ? degToRad(15) : null}
      scaleSnap={snap ? 0.1 : null}
      onMouseDown={() => {
        useWorldStore.getState().checkpoint();
        useEditorStore.getState().setDragging(true);
      }}
      onMouseUp={() => {
        write();
        // Let the click that ends the drag pass without changing the selection.
        setTimeout(() => useEditorStore.getState().setDragging(false), 0);
      }}
      onObjectChange={write}
    />
  );
}
