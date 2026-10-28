/**
 * Shared pieces of the Creative Build tools (Phase 16): the invisible ground catcher that
 * turns pointer rays into terrain hits, batched ghost previews of placement plans, and
 * terrain-draped outlines. Pointer hits come from the terrain data (TerrainSampler.raycast),
 * exactly like the place and terrain tools.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { WORLD_SIZE } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { createWorldObject } from '@/world/WorldDocument';
import { samplerFor, type TerrainSampler } from '@/terrain/TerrainSampler';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { ghostFor, type MaterialMode } from '@/rendering/materials';
import type { PlannedObject } from '../build/placementPlan';
import type { AreaShape, Vec2 } from '../build/distribution';

export function useSampler(): TerrainSampler {
  const terrain = useWorldStore((s) => s.doc.terrain);
  return samplerFor(terrain);
}

/** Terrain point under a pointer event, or null (outside the terrain / sky). */
export function groundHitOf(e: ThreeEvent<PointerEvent | MouseEvent>): Vec3 | null {
  const sampler = samplerFor(useWorldStore.getState().doc.terrain);
  const o = e.ray.origin;
  const d = e.ray.direction;
  const out: Vec3 = [0, 0, 0];
  return sampler.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, out) ? out : null;
}

/** Disable / restore the orbit controls while a tool drags with the left button. */
export function useOrbitLock() {
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const ref = useRef(controls);
  ref.current = controls;
  // Stable identity: tools use it in effect dependencies.
  return useMemo(() => ({
    lock: () => { if (ref.current) ref.current.enabled = false; },
    unlock: () => { if (ref.current) ref.current.enabled = true; },
  }), []);
}

/** Big invisible plane under the world that receives the tool's pointer events. */
export function GroundCatcher(props: {
  onMove?: (e: ThreeEvent<PointerEvent>) => void;
  onDown?: (e: ThreeEvent<PointerEvent>) => void;
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
  onDoubleClick?: (e: ThreeEvent<MouseEvent>) => void;
  onOut?: () => void;
}) {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position-y={-60}
      onPointerMove={props.onMove}
      onPointerDown={props.onDown}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onPointerOut={props.onOut}
    >
      <planeGeometry args={[WORLD_SIZE * 30, WORLD_SIZE * 30]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Ghost objects (one batched adapter per material mode); rebuilt when `objects` changes. */
function GhostBatch({ objects, mode }: { objects: WorldObject[]; mode: MaterialMode }) {
  const [adapter, setAdapter] = useState<SimRenderAdapter | null>(null);
  const camera = useThree((s) => s.camera);
  const terrain = useSampler();
  useEffect(() => {
    if (!objects.length) {
      setAdapter(null);
      return;
    }
    const a = new SimRenderAdapter(staticRuntime(objects), terrain);
    a.update(camera, 0, 0);
    a.setMaterialOverride(ghostFor(mode));
    a.cullEmpty();
    a.root.traverse((o) => (o.raycast = () => {}));
    setAdapter(a);
    return () => a.dispose();
  }, [objects, mode, terrain]); // eslint-disable-line react-hooks/exhaustive-deps
  return adapter ? <primitive object={adapter.root} /> : null;
}

/**
 * Preview of a placement plan: placeable objects as blue ghosts, ones with warnings orange,
 * rejected ones red. Append-only growth (brush strokes) only builds the new tail.
 */
export function PlanPreview({ plan, showRejected = true }: { plan: readonly PlannedObject[]; showRejected?: boolean }) {
  // Segments of the plan already turned into ghost batches (prefix-stable while growing).
  const segs = useRef<{ start: number; end: number; first: PlannedObject | undefined; groups: Record<MaterialMode, WorldObject[]> }[]>([]);
  const segments = useMemo(() => {
    let list = segs.current;
    const done = list.length ? list[list.length - 1].end : 0;
    if (!list.length || list[0].first !== plan[0] || done > plan.length) list = [];
    // Small tail segments are merged into the next rebuild, so a long stroke ends up with about
    // plan.length / SEGMENT_SIZE ghost batches (bounded draw calls), not one per pointer move.
    const last = list[list.length - 1];
    if (last && plan.length > last.end && last.end - last.start < SEGMENT_SIZE) list = list.slice(0, -1);
    const from = list.length ? list[list.length - 1].end : 0;
    if (plan.length > from) {
      const groups: Record<MaterialMode, WorldObject[]> = { normal: [], ghost: [], ghostWarn: [], ghostInvalid: [] };
      for (let i = from; i < plan.length; i++) {
        const p = plan[i];
        const mode: MaterialMode = !p.ok ? 'ghostInvalid' : p.warnings.length ? 'ghostWarn' : 'ghost';
        if (mode === 'ghostInvalid' && !showRejected) continue;
        groups[mode].push(createWorldObject(p.input, 0));
      }
      list = [...list, { start: from, end: plan.length, first: plan[0], groups }];
    }
    segs.current = list;
    return list;
  }, [plan, showRejected]);
  return (
    <>
      {segments.map((s) => (
        <group key={`${s.start}`}>
          {(['ghost', 'ghostWarn', 'ghostInvalid'] as const).map((m) => (s.groups[m].length ? <GhostBatch key={m} objects={s.groups[m]} mode={m} /> : null))}
        </group>
      ))}
    </>
  );
}

const SEGMENTS = 96;
/** Ghost objects per preview batch before a new batch is started (brush strokes). */
const SEGMENT_SIZE = 96;

/** A polyline draped on the terrain (always drawn on top). */
export function DrapedLine({ points, color, closed = false, dashed = false }: { points: Vec2[]; color: string; closed?: boolean; dashed?: boolean }) {
  const sampler = useSampler();
  const line = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const src = closed && points.length > 2 ? [...points, points[0]] : points;
    for (let i = 1; i < src.length; i++) {
      const [ax, az] = src[i - 1];
      const [bx, bz] = src[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const z = az + ((bz - az) * k) / n;
        pts.push(new THREE.Vector3(x, sampler.sampleHeight(x, z) + 0.12, z));
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.8, gapSize: 0.5, depthTest: false, transparent: true })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const l = new THREE.Line(g, m);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 12;
    l.frustumCulled = false;
    l.raycast = () => {};
    return l;
  }, [points, color, closed, dashed, sampler]);
  useEffect(() => () => {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }, [line]);
  return <primitive object={line} />;
}

/** Outline of an area shape on the terrain. */
export function ShapeOutline({ shape, color }: { shape: AreaShape; color: string }) {
  const outlines = useMemo((): Vec2[][] => {
    const circle = (x: number, z: number, r: number): Vec2[] =>
      Array.from({ length: SEGMENTS }, (_, i) => [x + Math.cos((i / SEGMENTS) * Math.PI * 2) * r, z + Math.sin((i / SEGMENTS) * Math.PI * 2) * r]);
    if (shape.kind === 'rect') return [[[shape.x0, shape.z0], [shape.x1, shape.z0], [shape.x1, shape.z1], [shape.x0, shape.z1]]];
    if (shape.kind === 'circle') return [circle(shape.x, shape.z, shape.r)];
    return shape.discs.length > 60 ? [] : shape.discs.map((d) => circle(d.x, d.z, d.r));
  }, [shape]);
  return (
    <>
      {outlines.map((pts, i) => <DrapedLine key={i} points={pts} color={color} closed />)}
      {shape.kind === 'mask' && <MaskDots shape={shape} color={color} />}
    </>
  );
}

/** Painted brush region drawn as a light dot grid (cheap for any number of discs). */
function MaskDots({ shape, color }: { shape: Extract<AreaShape, { kind: 'mask' }>; color: string }) {
  const sampler = useSampler();
  const pts = useMemo(() => {
    const out: number[] = [];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const d of shape.discs) { x0 = Math.min(x0, d.x - d.r); x1 = Math.max(x1, d.x + d.r); z0 = Math.min(z0, d.z - d.r); z1 = Math.max(z1, d.z + d.r); }
    for (let x = Math.floor(x0); x <= x1; x += 1.5) {
      for (let z = Math.floor(z0); z <= z1; z += 1.5) {
        if (shape.discs.some((d) => (x - d.x) ** 2 + (z - d.z) ** 2 <= d.r * d.r)) out.push(x, sampler.sampleHeight(x, z) + 0.1, z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    return g;
  }, [shape, sampler]);
  useEffect(() => () => pts.dispose(), [pts]);
  return (
    <points geometry={pts} raycast={() => null} renderOrder={11}>
      <pointsMaterial color={color} size={0.35} sizeAttenuation transparent opacity={0.8} depthTest={false} />
    </points>
  );
}

/** Brush ring following the cursor (draped on the terrain). */
export function BrushRing({ at, radius, color }: { at: React.RefObject<Vec3 | null>; radius: number; color: string }) {
  const sampler = useSampler();
  const ring = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
    l.renderOrder = 10;
    l.frustumCulled = false;
    l.visible = false;
    l.raycast = () => {};
    return l;
  }, [color]);
  useEffect(() => () => {
    ring.geometry.dispose();
    (ring.material as THREE.Material).dispose();
  }, [ring]);
  useFrame(() => {
    const c = at.current;
    ring.visible = !!c;
    if (!c) return;
    const pos = ring.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const x = c[0] + Math.cos(a) * radius;
      const z = c[2] + Math.sin(a) * radius;
      pos.setXYZ(i, x, sampler.sampleHeight(x, z) + 0.1, z);
    }
    pos.needsUpdate = true;
  });
  return <primitive object={ring} />;
}
