import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import type * as THREE from 'three';
import { degToRad } from '@/core/math';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from './editorStore';
import { gridStep, useBuildStore } from './buildStore';
import { entityNodeName } from '@/rendering/objectNames';
import { samplerFor } from '@/terrain/TerrainSampler';
import { isGrounded, reseat } from '@/terrain/groundPlacement';

/** Move / rotate / scale gizmo bound to the selected object. Writes back to the world store. */
export function TransformGizmo() {
  const selectedId = useEditorStore((s) => s.selectedId);
  const mode = useEditorStore((s) => s.transformMode);
  const snap = useEditorStore((s) => s.snap);
  const snapping = useBuildStore((s) => s.snapping);
  const exists = useWorldStore((s) => (selectedId ? !!s.doc.objects[selectedId] : false));
  const scene = useThree((s) => s.scene);
  const [target, setTarget] = useState<THREE.Object3D | null>(null);
  /** The object stood on the ground when the drag began → it keeps standing on it. */
  const grounded = useRef(false);
  const controlsRef = useRef<{ axis: string | null } | null>(null);

  useEffect(() => {
    setTarget(selectedId && exists ? scene.getObjectByName(entityNodeName(selectedId)) ?? null : null);
  }, [selectedId, exists, scene]);

  if (!target || !selectedId) return null;

  const write = () => {
    const world = useWorldStore.getState();
    const obj = world.doc.objects[selectedId];
    const terrain = samplerFor(world.doc.terrain);
    if (obj) {
      const moved = { ...obj, transform: { ...obj.transform, rotation: [target.rotation.x, target.rotation.y, target.rotation.z] as [number, number, number], scale: [target.scale.x, target.scale.y, target.scale.z] as [number, number, number] } };
      const seat = reseat(moved, terrain, target.position.x, target.position.z);
      // Horizontal moves / rotations of a grounded object follow the terrain (height + tilt);
      // dragging the Y handle lifts it on purpose. Nothing may sink below its seated height.
      const axis = controlsRef.current?.axis ?? '';
      if (grounded.current && !axis.includes('Y')) {
        target.position.y = seat.position[1];
        // (Flat ground: keep any manual tilt, exactly as before terrain existed.)
        if (!terrain.flat) target.rotation.set(seat.rotation[0], seat.rotation[1], seat.rotation[2]);
      } else if (target.position.y < seat.position[1]) target.position.y = seat.position[1];
    }
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
      translationSnap={snap ? gridStep(snapping.grid, 0) : null}
      rotationSnap={snap ? degToRad(snapping.rotationStep) : null}
      scaleSnap={snap ? 0.1 : null}
      ref={controlsRef as never}
      onMouseDown={() => {
        const world = useWorldStore.getState();
        const obj = world.doc.objects[selectedId];
        grounded.current = !!obj && mode !== 'scale' && isGrounded(obj, samplerFor(world.doc.terrain));
        world.checkpoint();
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
