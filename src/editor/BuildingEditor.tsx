import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { identityTransform } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { degToRad } from '@/core/math';
import { useWorldStore } from '@/world/worldStore';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { flatSampler } from '@/terrain/TerrainSampler';
import { yawOf } from '@/terrain/groundPlacement';
import { analysisOf } from '@/buildings/design';
import { rotateEuler } from '@/buildings/geometry';
import { addMembers, braceJoints, braceMember, floorElevation, nearestJoint, newMember, nextUserIds, snapToGrid, snapToStructure, storyAt } from '@/buildings/edit';
import type { BuildingDesign, BuildingMember } from '@/buildings/types';
import { addMemberAt, commitDesign, moveSelectedMembers, rotateSelectedMembers } from '@/app/buildingActions';
import { ManagedTransformControls } from './ManagedTransformControls';
import { useEditorStore } from './editorStore';
import { useMemberStore } from './memberStore';

const cam = new THREE.PerspectiveCamera();
const EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

/** Edges of member boxes (rotated) as one line geometry (object-local). */
function memberEdges(members: readonly BuildingMember[], pad = 0.04): THREE.BufferGeometry {
  const pos = new Float32Array(members.length * 24 * 3);
  let k = 0;
  for (const m of members) {
    const hx = m.size[0] / 2 + pad, hy = m.size[1] / 2 + pad, hz = m.size[2] / 2 + pad;
    const c = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const r = rotateEuler([i & 1 ? hx : -hx, i & 4 ? hy : -hy, i & 2 ? hz : -hz], m.rotation);
      return [m.position[0] + r[0], m.position[1] + r[1], m.position[2] + r[2]];
    });
    for (const [a, b] of EDGES) {
      pos.set(c[a], k); k += 3;
      pos.set(c[b], k); k += 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

const UTIL_COLORS = [new THREE.Color('#3fbf7f'), new THREE.Color('#e6d14a'), new THREE.Color('#f5973b'), new THREE.Color('#ef4d4d')];
const utilColor = (u: number) => UTIL_COLORS[u < 0.5 ? 0 : u < 0.8 ? 1 : u <= 1 ? 2 : 3];

/** Load path: member center → each support (colored by the supported member's utilization). */
function loadPathGeometry(design: BuildingDesign): { lines: THREE.BufferGeometry; unsupported: BuildingMember[] } {
  const a = analysisOf(design);
  const pos: number[] = [];
  const col: number[] = [];
  const center = (i: number) => {
    const b = a.members[i].box;
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  };
  a.members.forEach((m, i) => {
    if (!m.supported) return;
    const from = center(i);
    for (const j of m.supports) {
      const to = center(j);
      const c = utilColor(a.members[j].utilization);
      pos.push(...from, ...to);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return { lines: g, unsupported: design.members.filter((_, i) => !a.members[i].supported) };
}

/**
 * Building Edit Mode (Phase 17): the building being edited is drawn here (x-ray: interior members
 * visible; optional story cutaway), members are picked by click (Shift: add / remove), moved /
 * turned with a gizmo (grid, floor and structural-connection snapping; one undo step per drag),
 * added by clicking with a member type armed. The load path overlay shows who rests on whom,
 * colored by utilization, and unsupported members in red.
 * Phase 36: a brace is placed joint → joint — two clicks near structural nodes (column ends, beam middles); the first
 * joint is kept in the member store until the second one (Esc / another tool cancels).
 */
export function BuildingEditor() {
  const id = useEditorStore((s) => s.buildingId);
  const obj = useWorldStore((s) => (id ? s.doc.objects[id] : undefined));
  if (!obj?.building) return null;
  return <Editor obj={obj} />;
}

function Editor({ obj }: { obj: WorldObject }) {
  const design = obj.building!;
  const ms = useMemberStore();
  const { selected, adding, xray, loadPath, cut } = ms;
  const camera = useThree((s) => s.camera);

  // Displayed design: story cutaway hides members above the cut level.
  const shown = useMemo(() => (cut === null ? design : { ...design, members: design.members.filter((m) => m.level <= cut) }), [design, cut]);
  const [adapter, setAdapter] = useState<SimRenderAdapter | null>(null);
  useEffect(() => {
    const local: WorldObject = { ...obj, transform: identityTransform(), building: shown };
    const a = new SimRenderAdapter(staticRuntime([local]), flatSampler());
    a.update(cam, 0, 0);
    a.cullEmpty();
    if (xray) a.setRevealed(obj.id, true);
    setAdapter(a);
    return () => a.dispose();
  }, [obj, shown, xray]);

  const selMembers = useMemo(() => design.members.filter((m) => selected.includes(m.id)), [design, selected]);
  const selEdges = useMemo(() => memberEdges(selMembers), [selMembers]);
  useEffect(() => () => selEdges.dispose(), [selEdges]);
  const lp = useMemo(() => (loadPath ? loadPathGeometry(design) : null), [design, loadPath]);
  // Removal preview (Phase 25): removed members white, the members that would follow red.
  const preview = ms.preview && ms.preview.design === design ? ms.preview.result : null;
  const previewEdges = useMemo(() => {
    if (!preview) return null;
    const failed = new Set(preview.failed.map((f) => f.id));
    return memberEdges(design.members.filter((m) => failed.has(m.id)), 0.06);
  }, [design, preview]);
  useEffect(() => () => previewEdges?.dispose(), [previewEdges]);
  const badEdges = useMemo(() => (lp ? memberEdges(lp.unsupported, 0.08) : null), [lp]);
  useEffect(() => () => { lp?.lines.dispose(); badEdges?.dispose(); }, [lp, badEdges]);

  const group = useRef<THREE.Group>(null);
  const gl = useThree((s) => s.gl);
  /**
   * Phase 36: the brace joint under the POINTER — the joint whose screen position is nearest the cursor within 18 px,
   * else the nearest to the hit point (1.5 m). Picking by the 3D hit point alone missed column tops behind a glass
   * façade (the ray passes the glass and hits members metres behind).
   */
  const jointAt = (e: ThreeEvent<MouseEvent | PointerEvent>): Vec3 | null => {
    const g = group.current;
    if (g) {
      const r = gl.domElement.getBoundingClientRect();
      const v = new THREE.Vector3();
      let best: Vec3 | null = null, bd = 18;
      for (const j of braceJoints(design)) {
        v.set(j[0], j[1], j[2]).applyMatrix4(g.matrixWorld).project(camera);
        if (v.z > 1) continue;
        const d = Math.hypot(r.left + ((v.x + 1) / 2) * r.width - e.nativeEvent.clientX, r.top + ((1 - v.y) / 2) * r.height - e.nativeEvent.clientY);
        if (d < bd) { bd = d; best = j; }
      }
      if (best) return best;
    }
    return nearestJoint(design, toLocal(e.point));
  };
  const toLocal = (p: THREE.Vector3): Vec3 => {
    const g = group.current!;
    const l = g.worldToLocal(p.clone());
    return [l.x, l.y, l.z];
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5 || useEditorStore.getState().dragging) return;
    e.stopPropagation();
    if (adding === 'brace') {
      const j = jointAt(e);
      if (!j) return;
      const from = ms.braceFrom;
      if (!from) { ms.setBraceFrom(j); return; }
      if (Math.hypot(j[0] - from[0], j[1] - from[1], j[2] - from[2]) < 0.5) return;
      const [id] = nextUserIds(design, 1);
      if (commitDesign(obj.id, addMembers(design, [braceMember(design, id, from, j)]))) ms.select([id]);
      ms.setBraceFrom(null);
      return;
    }
    if (adding) {
      const at = ghostAt(design, adding, toLocal(e.point), ms);
      if (at) addMemberAt(adding, at, ms.addYaw);
      return;
    }
    const hit = adapter?.pickMember(e.object, e.instanceId);
    const m = hit ? shown.members[hit.member] : undefined;
    if (!m) {
      if (!e.nativeEvent.shiftKey) ms.select([]);
      return;
    }
    if (e.nativeEvent.shiftKey) ms.toggle(m.id);
    else ms.select([m.id]);
  };

  // Add ghost follows the pointer.
  const [ghost, setGhost] = useState<BuildingMember | null>(null);
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!adding) return;
    e.stopPropagation();
    if (adding === 'brace') {
      // The hovered joint (a small marker), or the brace from the first joint to it.
      const j = jointAt(e);
      if (!j) return setGhost(null);
      const from = ms.braceFrom;
      return setGhost(from ? braceMember(design, '~ghost', from, j) : { ...newMember(design, 'column', j, '~ghost'), position: j, rotation: [0, 0, 0], size: [0.35, 0.35, 0.35] });
    }
    const at = ghostAt(design, adding, toLocal(e.point), ms);
    if (!at) return setGhost(null);
    const g = newMember(design, adding, at, '~ghost');
    g.rotation = [g.rotation[0], ms.addYaw, g.rotation[2]];
    setGhost(g);
  };
  useEffect(() => setGhost(null), [adding]);

  const { position, rotation, scale } = obj.transform;
  return (
    <group ref={group} position={position} rotation={rotation} scale={scale}>
      {adapter && <primitive object={adapter.root} onClick={onClick} onPointerMove={onMove} />}
      {/* Ground of the building frame: clicks there add on the ground story / clear the selection. */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.01} onClick={onClick} onPointerMove={onMove} visible={false}>
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial />
      </mesh>
      {selMembers.length > 0 && (
        <lineSegments geometry={selEdges} renderOrder={12} raycast={() => null}>
          <lineBasicMaterial color="#4f8cff" depthTest={false} transparent />
        </lineSegments>
      )}
      {lp && (
        <lineSegments geometry={lp.lines} renderOrder={11} raycast={() => null}>
          <lineBasicMaterial vertexColors depthTest={false} transparent opacity={0.85} />
        </lineSegments>
      )}
      {badEdges && lp && lp.unsupported.length > 0 && (
        <lineSegments geometry={badEdges} renderOrder={13} raycast={() => null}>
          <lineBasicMaterial color="#ff4d4d" depthTest={false} transparent />
        </lineSegments>
      )}
      {previewEdges && (
        <lineSegments geometry={previewEdges} renderOrder={13} raycast={() => null}>
          <lineBasicMaterial color="#ff6a3d" depthTest={false} transparent />
        </lineSegments>
      )}
      {ghost && (
        <mesh position={ghost.position} rotation={ghost.rotation} scale={ghost.size} raycast={() => null} renderOrder={14}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#6fa1ff" transparent opacity={0.5} depthWrite={false} />
        </mesh>
      )}
      {selMembers.length > 0 && !adding && <MemberGizmo design={design} members={selMembers} camera={camera} />}
    </group>
  );
}

/** Snapped building-local point for a new member of `type` near `p`. */
function ghostAt(design: BuildingDesign, type: BuildingMember['type'], p: Vec3, ms: ReturnType<typeof useMemberStore.getState>): Vec3 | null {
  let x = p[0], z = p[2];
  if (ms.snap.structure) {
    const s = snapToStructure(design, type, x, z, 2);
    if (s) [x, z] = s;
  }
  if (ms.snap.grid && !(ms.snap.structure && snapToStructure(design, type, p[0], p[2], 2))) {
    x = snapToGrid(x, ms.gridStep);
    z = snapToGrid(z, ms.gridStep);
  }
  const story = Math.max(0, Math.min(design.spec.floors - 1, storyAt(design, p[1] + 0.05)));
  const probe = newMember(design, type, [x, p[1], z], '~');
  const y = ms.snap.floor ? floorElevation(design, probe, story) : p[1] + probe.size[1] / 2;
  return [x, type === 'foundation' ? probe.position[1] : type === 'roof' ? probe.position[1] : y, z];
}

/** Gizmo on the selection centroid; the drag is applied as one member edit on release. */
function MemberGizmo({ design, members, camera }: { design: BuildingDesign; members: BuildingMember[]; camera: THREE.Camera }) {
  const gizmo = useMemberStore((s) => s.gizmo);
  const snap = useMemberStore((s) => s.snap);
  const gridStep = useMemberStore((s) => s.gridStep);
  const [proxy, setProxy] = useState<THREE.Group | null>(null);
  const center = useMemo<Vec3>(() => {
    const c: Vec3 = [0, 0, 0];
    for (const m of members) for (let k = 0; k < 3; k++) c[k] += m.position[k] / members.length;
    return c;
  }, [members]);
  useEffect(() => {
    if (!proxy) return;
    proxy.position.set(center[0], center[1], center[2]);
    proxy.rotation.set(0, 0, 0);
  }, [proxy, center]);
  void camera;
  const commit = () => {
    if (!proxy) return;
    if (gizmo === 'rotate') {
      // Heading from the whole rotation (a 180° turn is (π, 0, π) in Euler angles — Phase 36 fix).
      let yaw = yawOf([proxy.rotation.x, proxy.rotation.y, proxy.rotation.z]);
      const step = degToRad(snap.structure ? 90 : 15);
      yaw = Math.round(yaw / step) * step;
      if (Math.abs(yaw) > 1e-6) rotateSelectedMembers(yaw, [center[0], center[2]]);
      proxy.rotation.set(0, 0, 0);
      return;
    }
    let d: Vec3 = [proxy.position.x - center[0], proxy.position.y - center[1], proxy.position.z - center[2]];
    if (snap.grid) d = [snapToGrid(d[0], gridStep), d[1], snapToGrid(d[2], gridStep)];
    if (snap.floor && Math.abs(d[1]) > 0.05) {
      // Whole stories up / down: the member keeps its place on the floor.
      const ref = members[0];
      const from = storyAt(design, ref.position[1] - ref.size[1] / 2 + 0.05);
      const to = Math.max(0, Math.min(design.spec.floors - 1, storyAt(design, ref.position[1] - ref.size[1] / 2 + d[1] + 0.05)));
      d[1] = floorElevation(design, ref, to) - floorElevation(design, ref, from);
    } else if (snap.floor) d[1] = 0;
    if (snap.structure && members.length === 1) {
      const m = members[0];
      const s = snapToStructure(design, m.type, m.position[0] + d[0], m.position[2] + d[2], 1.2);
      if (s) d = [s[0] - m.position[0], d[1], s[1] - m.position[2]];
    }
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-6) moveSelectedMembers(d);
    proxy.position.set(center[0], center[1], center[2]);
  };
  return (
    <>
      <group ref={setProxy} />
      {proxy && (
        <ManagedTransformControls
          object={proxy}
          mode={gizmo}
          size={0.7}
          space="local"
          showX={gizmo === 'translate'}
          showZ={gizmo === 'translate'}
          showY
          owner="gizmo:member"
          onDragStart={() => useEditorStore.getState().setDragging(true)}
          onDragEnd={(ok) => {
            if (ok) commit();
            else {
              proxy.position.set(center[0], center[1], center[2]);
              proxy.rotation.set(0, 0, 0);
            }
            setTimeout(() => useEditorStore.getState().setDragging(false), 0);
          }}
        />
      )}
    </>
  );
}
