/**
 * Experiment-tab helpers in the 3D view (Phase 21), both modes:
 *
 *  - DeformationPicker: while an instance is being positioned, the next click on the ground sets
 *    its centre (a ring of its radius follows the cursor; Esc cancels). It captures the click
 *    before the editor tools see it, so picking never selects / moves anything.
 *  - DeformationPreview: the PREDICTED final displacement of one instance, before it runs —
 *    colored on the current ground (blue down / red up) with a wireframe of the predicted final
 *    surface at TRUE scale. Purely visual: the document and the simulation are not touched.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { useWorldStore } from '@/world/worldStore';
import { useViewStore } from '../viewStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { shapeGrid, deformationBounds } from '@/deformation/field';
import type { TerrainDeformationSpec } from '@/deformation/types';
import { updatePhenomenon } from '@/app/actions';
import { currentDeformation } from '../terrain/runtimeGround';
import { FieldPatch } from './fieldMesh';
import { displacementAlpha, displacementColor, displacementScale } from './deformColors';

function groundTerrain() {
  return currentDeformation()?.terrain ?? useWorldStore.getState().doc.terrain;
}

function useInstance(id: string | null) {
  return useWorldStore((s) => (id ? s.doc.scenario.experiment?.instances.find((i) => i.id === id && i.type === 'terrainDeformation') ?? null : null));
}

/** A ring on the ground (n segments) at a centre / radius. */
function ringPoints(cx: number, cz: number, r: number, n = 72): THREE.Vector3[] {
  const s = samplerFor(groundTerrain());
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    pts.push(new THREE.Vector3(x, s.sampleHeight(x, z) + 0.15, z));
  }
  return pts;
}

function Ring({ cx, cz, r, color }: { cx: number; cz: number; r: number; color: string }) {
  const geo = useMemo(() => new THREE.BufferGeometry().setFromPoints(ringPoints(cx, cz, r)), [cx, cz, r]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <line>
      <primitive object={geo} attach="geometry" />
      <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
    </line>
  );
}

export function DeformationPicker() {
  const id = useViewStore((s) => s.deformPick);
  const inst = useInstance(id);
  const { gl, camera } = useThree();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const ray = useRef(new THREE.Raycaster());
  useEffect(() => {
    if (!id) return;
    const el = gl.domElement;
    const hit: Vec3 = [0, 0, 0];
    const pointAt = (ev: MouseEvent): [number, number] | null => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.current.setFromCamera(ndc, camera);
      const o = ray.current.ray.origin, d = ray.current.ray.direction;
      return samplerFor(groundTerrain()).raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, hit) ? [hit[0], hit[2]] : null;
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.target === el) setHover(pointAt(ev));
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.target !== el || ev.button !== 0) return;
      const p = pointAt(ev);
      ev.stopImmediatePropagation();
      ev.preventDefault();
      if (!p) return;
      const cur = useWorldStore.getState().doc.scenario.experiment?.instances.find((i) => i.id === id);
      if (cur) updatePhenomenon(id, { spec: { ...(cur.spec as TerrainDeformationSpec), center: [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] } });
      useViewStore.getState().setDeformPick(null);
    };
    // The click that follows the pointerdown must not reach the editor either.
    const swallow = (ev: MouseEvent) => {
      if (ev.target === el) ev.stopImmediatePropagation();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') useViewStore.getState().setDeformPick(null);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('keydown', onKey);
    el.style.cursor = 'crosshair';
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('keydown', onKey);
      el.style.cursor = '';
      setHover(null);
    };
  }, [id, gl, camera]);
  if (!id || !inst || !hover) return null;
  const spec = inst.spec as TerrainDeformationSpec;
  return <Ring cx={hover[0]} cz={hover[1]} r={spec.radius} color="#ffd34d" />;
}

export function DeformationPreview() {
  const id = useViewStore((s) => s.deformPreview);
  const inst = useInstance(id);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const docTerrain = useWorldStore((s) => s.doc.terrain);
  const built = useMemo(() => {
    if (!inst) return null;
    const spec = inst.spec as TerrainDeformationSpec;
    const t = groundTerrain();
    const g = shapeGrid(spec, t, spec.seed ?? inst.seed ?? seed);
    if (!g) return null;
    let max = 0;
    for (const v of g.values) max = Math.max(max, Math.abs(v));
    const scale = displacementScale(max);
    const color = new FieldPatch(t, g.rect);
    color.write(t.heights, 0.06, (l, _g, out) => (displacementColor(g.values[l], scale, out), displacementAlpha(g.values[l], scale)));
    const ghost = new FieldPatch(t, g.rect);
    ghost.write(t.heights, 0.02, (l, _g, out) => (out.set('#ffe9a8'), Math.abs(g.values[l]) < 0.01 ? 0 : 0.8), (l) => g.values[l]);
    const b = deformationBounds(spec);
    return { color, ghost, spec, bounds: b };
  }, [inst, seed, docTerrain]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    built?.color.dispose();
    built?.ghost.dispose();
  }, [built]);
  if (!built) return null;
  const { spec } = built;
  return (
    <group name="deformation-preview">
      <mesh geometry={built.color.geometry} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial vertexColors transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={built.ghost.geometry} renderOrder={4} raycast={() => null}>
        <meshBasicMaterial vertexColors wireframe transparent opacity={0.45} depthWrite={false} depthTest={false} />
      </mesh>
      {spec.kind !== 'ridge' && spec.kind !== 'prescribed' && <Ring cx={spec.center[0]} cz={spec.center[1]} r={spec.radius} color="#ffd34d" />}
    </group>
  );
}
