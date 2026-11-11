import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { ManagedTransformControls as TransformControls } from './ManagedTransformControls';
import * as THREE from 'three';
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { degToRad } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { RoadView } from '@/rendering/views/InfrastructureViews';
import { samplerFor } from '@/terrain/TerrainSampler';
import { yawOf } from '@/terrain/groundPlacement';
import { selectionPivot } from './build/groupTransform';
import { selectFromHits, transformSelection } from '@/app/buildActions';
import { clickMods, clickScreen, hitIds, setGroupPicker } from './pick';
import { useEditorStore } from './editorStore';
import { gridStep, useBuildStore } from './buildStore';

const PAD = 0.15;
const BOX_EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const m4 = new THREE.Matrix4();
const v = new THREE.Vector3();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const s = new THREE.Vector3();

/** All selected objects' bounding boxes as ONE line-segment geometry (relative to `origin`). */
export function selectionEdges(objs: readonly WorldObject[], origin: { x: number; y: number; z: number }): THREE.BufferGeometry {
  const pos = new Float32Array(objs.length * BOX_EDGES.length * 2 * 3);
  let k = 0;
  for (const o of objs) {
    const d = getDefinition(o.type).getDimensions(o.params);
    const t = o.transform;
    m4.compose(v.set(t.position[0] - origin.x, t.position[1] - origin.y, t.position[2] - origin.z), q.setFromEuler(e.set(t.rotation[0], t.rotation[1], t.rotation[2])), s.set(t.scale[0], t.scale[1], t.scale[2]));
    const hx = d[0] / 2 + PAD / 2;
    const hz = d[2] / 2 + PAD / 2;
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? hx : -hx, i & 4 ? d[1] + PAD : 0, i & 2 ? hz : -hz).applyMatrix4(m4));
    for (const [a, b] of BOX_EDGES) {
      pos[k++] = corners[a].x; pos[k++] = corners[a].y; pos[k++] = corners[a].z;
      pos[k++] = corners[b].x; pos[k++] = corners[b].y; pos[k++] = corners[b].z;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

/**
 * Multi-selection (Phase 16): the selected objects are drawn as one batched group under a pivot
 * at their bounds center, with one outline geometry. The gizmo moves / turns the pivot; on
 * release the rigid delta is applied to every member in one undo step (relative layout kept,
 * grounded members re-seated on the terrain). The objects keep their own physics bodies.
 */
export function GroupSelection({ ids }: { ids: EntityId[] }) {
  const objects = useWorldStore((st) => st.doc.objects);
  const terrain = useWorldStore((st) => st.doc.terrain);
  const mode = useEditorStore((st) => st.transformMode);
  const lock = useEditorStore((st) => st.axisLock);
  const snap = useEditorStore((st) => st.snap);
  const snapping = useBuildStore((st) => st.snapping);
  const camera = useThree((st) => st.camera);
  const objs = useMemo(() => ids.map((id) => objects[id]).filter((o): o is WorldObject => !!o), [ids, objects]);
  const pivot = useMemo(() => selectionPivot(objs), [objs]);
  const [pivotObj, setPivotObj] = useState<THREE.Group | null>(null);
  const [adapter, setAdapter] = useState<SimRenderAdapter | null>(null);
  const edges = useMemo(() => selectionEdges(objs, pivot), [objs, pivot]);
  useEffect(() => () => edges.dispose(), [edges]);
  const roads = objs.filter((o) => o.type === 'road');

  useEffect(() => {
    const a = new SimRenderAdapter(staticRuntime(objs), samplerFor(terrain));
    a.update(camera, 0, 0);
    a.cullEmpty();
    a.root.position.set(-pivot.x, -pivot.y, -pivot.z);
    // Phase 36: the selected objects stay clickable (Shift / Ctrl+click removes one, a click picks one) — before, the
    // proxy ignored rays and a click on a selected object fell through to the ground and cleared the selection.
    setGroupPicker((o, id) => a.pick(o, id));
    setAdapter(a);
    return () => {
      setGroupPicker(null);
      a.dispose();
    };
  }, [objs, terrain]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the pivot whenever the selection data changes (after a commit or undo).
  useEffect(() => {
    if (!pivotObj) return;
    pivotObj.position.set(pivot.x, pivot.y, pivot.z);
    pivotObj.rotation.set(0, 0, 0);
    pivotObj.scale.set(1, 1, 1);
  }, [pivotObj, pivot]);

  const start = useRef<{ x: number; y: number; z: number } | null>(null);
  const commit = () => {
    if (!pivotObj || !start.current) return;
    // Uniform scale: the axis the user dragged (the one furthest from 1).
    const sc = [pivotObj.scale.x, pivotObj.scale.y, pivotObj.scale.z].reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
    const scale = Math.min(5, Math.max(0.2, sc));
    pivotObj.scale.set(1, 1, 1);
    // Heading from the whole rotation: a turn past 90° is (π, 180° − θ, π) in XYZ Euler angles, so
    // `rotation.y` alone committed 120° as 60° and 180° as nothing (Phase 36 fix).
    const dyaw = yawOf([pivotObj.rotation.x, pivotObj.rotation.y, pivotObj.rotation.z]);
    pivotObj.rotation.set(0, 0, 0);
    const d = { dx: pivotObj.position.x - start.current.x, dy: pivotObj.position.y - start.current.y, dz: pivotObj.position.z - start.current.z, dyaw, scale };
    start.current = null;
    if (Math.abs(d.dx) + Math.abs(d.dy) + Math.abs(d.dz) + Math.abs(d.dyaw) + Math.abs(scale - 1) < 1e-9) return;
    transformSelection(d, { x: pivot.x, z: pivot.z });
  };

  return (
    <>
      <group ref={setPivotObj} onClick={(e) => {
        e.stopPropagation();
        if (e.delta > 5 || useEditorStore.getState().dragging) return;
        selectFromHits(hitIds(e), clickMods(e), clickScreen(e));
      }}>
        {adapter && <primitive object={adapter.root} />}
        <lineSegments geometry={edges} renderOrder={10} raycast={() => null}>
          <lineBasicMaterial color="#4f8cff" depthTest={false} transparent />
        </lineSegments>
        {roads.map((o) => (
          <group key={o.id} position={[o.transform.position[0] - pivot.x, o.transform.position[1] - pivot.y, o.transform.position[2] - pivot.z]} rotation={o.transform.rotation} scale={o.transform.scale}>
            <RoadView obj={o} />
          </group>
        ))}
      </group>
      {pivotObj && !objs.some((o) => o.locked) && (
        <TransformControls
          object={pivotObj}
          mode={mode}
          size={0.9}
          space="world"
          showX={mode !== 'rotate' && (!lock || lock === 'x')}
          showY={!lock || lock === 'y' || mode === 'rotate'}
          showZ={mode !== 'rotate' && (!lock || lock === 'z')}
          translationSnap={snap ? gridStep(snapping.grid, 0) : null}
          rotationSnap={snap ? degToRad(snapping.rotationStep) : null}
          scaleSnap={snap ? 0.1 : null}
          owner="gizmo:group"
          onDragStart={() => {
            start.current = { x: pivot.x, y: pivot.y, z: pivot.z };
            useEditorStore.getState().setDragging(true);
          }}
          onDragEnd={(ok) => {
            if (ok) commit();
            else {
              // Cancelled: nothing was written yet (the group commits on release) — reset the proxy.
              start.current = null;
              pivotObj.position.set(pivot.x, pivot.y, pivot.z);
              pivotObj.rotation.set(0, 0, 0);
              pivotObj.scale.set(1, 1, 1);
            }
            setTimeout(() => useEditorStore.getState().setDragging(false), 0);
          }}
        />
      )}
    </>
  );
}
