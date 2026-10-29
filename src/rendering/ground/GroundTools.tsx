/**
 * Experiment-tab helpers in the 3D view for sinkholes and landslides (Phase 22), both modes:
 *
 *  - GroundPicker: 'point' — the next click on the ground sets the sinkhole centre or the centre
 *    of a landslide area (a polygon is moved, not reshaped); 'polygon' — clicks add the corners of
 *    a landslide source area (Enter, a double click or a click on the first corner closes it,
 *    Backspace removes the last corner, Esc cancels). Clicks are captured before the editor tools
 *    see them, so picking never selects / moves anything.
 *  - GroundPreview: the PREDICTED outcome on the current ground, before running — sinkhole: the
 *    cavity (initial / final), the critical radius of the roof and the expected pit; landslide: the
 *    infinite-slope factor of safety of every vertex of the area at the trigger's water table.
 *    Purely visual: the document and the simulation are not touched.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import type { TerrainData } from '@/core/model';
import { useWorldStore } from '@/world/worldStore';
import { useViewStore } from '../viewStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { updatePhenomenon } from '@/app/actions';
import { currentDeformation } from '../terrain/runtimeGround';
import { FieldPatch } from '../deformation/fieldMesh';
import { fsColor } from './groundColors';
import type { GroundArea, LandslideSpec, SinkholeSpec } from '@/ground/types';
import type { ImpactSpec } from '@/impact/types';
import { areaCentroid } from '@/ground/common';
import { GeoField } from '@/ground/GeoField';
import { LandslideModel } from '@/ground/landslide';
import { sinkholeOutlook } from '@/phenomena/groundDefinitions';
import { ImpactPreview } from '../impact/ImpactPreview';
import { BlastPreview } from '../blast/BlastPreview';
import type { BlastSpec } from '@/blast/types';
import type { PhenomenonInstance } from '@/phenomena/types';

const round1 = (v: number) => Math.round(v * 10) / 10;

function groundTerrain(): TerrainData {
  return currentDeformation()?.terrain ?? useWorldStore.getState().doc.terrain;
}

function useGroundInstance(id: string | null): PhenomenonInstance | null {
  return useWorldStore((s) => (id ? s.doc.scenario.experiment?.instances.find((i) => i.id === id && (i.type === 'sinkhole' || i.type === 'landslide' || i.type === 'impact' || i.type === 'blast')) ?? null : null));
}

/** Points of a closed (or open) line on the ground, lifted a little. */
function draped(pts: [number, number][], closed: boolean, step = 1): THREE.Vector3[] {
  const s = samplerFor(groundTerrain());
  const out: THREE.Vector3[] = [];
  const n = pts.length;
  for (let k = 0; k < (closed ? n : n - 1); k++) {
    const [x0, z0] = pts[k], [x1, z1] = pts[(k + 1) % n];
    const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
    for (let j = 0; j < m; j++) {
      const x = x0 + ((x1 - x0) * j) / m, z = z0 + ((z1 - z0) * j) / m;
      out.push(new THREE.Vector3(x, s.sampleHeight(x, z) + 0.2, z));
    }
  }
  const [xe, ze] = closed ? pts[0] : pts[n - 1];
  if (n) out.push(new THREE.Vector3(xe, s.sampleHeight(xe, ze) + 0.2, ze));
  return out;
}

export function circlePts(cx: number, cz: number, r: number, n = 72): [number, number][] {
  return Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r] as [number, number]);
}

export function areaOutline(a: GroundArea): [number, number][] {
  return a.kind === 'circle' ? circlePts(a.center[0], a.center[1], a.radius) : a.points;
}

export function GroundLine({ pts, closed = true, color, dashed = false }: { pts: [number, number][]; closed?: boolean; color: string; dashed?: boolean }) {
  const line = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(draped(pts, closed));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 0.7, depthTest: false, transparent: true, opacity: 0.95 })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const l = new THREE.Line(geo, mat);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 7;
    l.raycast = () => {};
    return l;
  }, [pts, closed, color, dashed]);
  useEffect(() => () => {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }, [line]);
  return <primitive object={line} />;
}

function moveArea(a: GroundArea, to: [number, number]): GroundArea {
  if (a.kind === 'circle') return { ...a, center: to };
  const [cx, cz] = areaCentroid(a);
  return { kind: 'polygon', points: a.points.map(([x, z]) => [round1(x + to[0] - cx), round1(z + to[1] - cz)] as [number, number]) };
}

export function GroundPicker() {
  const pick = useViewStore((s) => s.groundPick);
  const inst = useGroundInstance(pick?.id ?? null);
  const { gl, camera } = useThree();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [corners, setCorners] = useState<[number, number][]>([]);
  const cornersRef = useRef(corners);
  cornersRef.current = corners;
  const ray = useRef(new THREE.Raycaster());
  useEffect(() => {
    if (!pick) return;
    const { id, mode } = pick;
    const el = gl.domElement;
    const hit: Vec3 = [0, 0, 0];
    const pointAt = (ev: MouseEvent): [number, number] | null => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.current.setFromCamera(ndc, camera);
      const o = ray.current.ray.origin, d = ray.current.ray.direction;
      return samplerFor(groundTerrain()).raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, hit) ? [round1(hit[0]), round1(hit[2])] : null;
    };
    const current = () => useWorldStore.getState().doc.scenario.experiment?.instances.find((i) => i.id === id);
    const done = () => useViewStore.getState().setGroundPick(null);
    const closePolygon = () => {
      const pts = cornersRef.current;
      const cur = current();
      if (pts.length >= 3 && cur?.type === 'landslide') updatePhenomenon(id, { spec: { ...(cur.spec as LandslideSpec), area: { kind: 'polygon', points: pts.slice(0, 64) } } });
      done();
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
      const cur = current();
      if (!cur) return done();
      if (mode === 'point') {
        if (cur.type === 'impact') updatePhenomenon(id, { spec: { ...(cur.spec as ImpactSpec), target: p } });
        else if (cur.type === 'blast') updatePhenomenon(id, { spec: { ...(cur.spec as BlastSpec), position: p } });
        else if (cur.type === 'sinkhole') updatePhenomenon(id, { spec: { ...(cur.spec as SinkholeSpec), center: p } });
        else updatePhenomenon(id, { spec: { ...(cur.spec as LandslideSpec), area: moveArea((cur.spec as LandslideSpec).area, p) } });
        return done();
      }
      const pts = cornersRef.current;
      // A click on the first corner (within 2 m) closes the polygon.
      if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 2) return closePolygon();
      if (pts.length < 64) setCorners([...pts, p]);
    };
    const swallow = (ev: MouseEvent) => {
      if (ev.target === el) ev.stopImmediatePropagation();
    };
    const onDbl = (ev: MouseEvent) => {
      if (ev.target !== el) return;
      ev.stopImmediatePropagation();
      if (mode === 'polygon') closePolygon();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') done();
      else if (mode === 'polygon' && ev.key === 'Enter') closePolygon();
      else if (mode === 'polygon' && ev.key === 'Backspace') {
        ev.preventDefault();
        setCorners((c) => c.slice(0, -1));
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('dblclick', onDbl, true);
    window.addEventListener('keydown', onKey);
    el.style.cursor = 'crosshair';
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('dblclick', onDbl, true);
      window.removeEventListener('keydown', onKey);
      el.style.cursor = '';
      setHover(null);
      setCorners([]);
    };
  }, [pick, gl, camera]);
  if (!pick || !inst) return null;
  if (pick.mode === 'polygon') {
    const pts = hover ? [...corners, hover] : corners;
    return pts.length >= 2 ? <GroundLine pts={pts} closed={false} color="#ffd34d" /> : null;
  }
  if (!hover) return null;
  let outline: [number, number][];
  if (inst.type === 'impact' || inst.type === 'blast') return <AimMarker x={hover[0]} z={hover[1]} color="#ffd34d" />;
  if (inst.type === 'sinkhole') outline = circlePts(hover[0], hover[1], (inst.spec as SinkholeSpec).cavityRadius);
  else outline = areaOutline(moveArea((inst.spec as LandslideSpec).area, hover));
  return <GroundLine pts={outline} color="#ffd34d" />;
}

function SinkholePreview({ inst }: { inst: PhenomenonInstance }) {
  const docTerrain = useWorldStore((s) => s.doc.terrain);
  const spec = inst.spec as SinkholeSpec;
  const o = useMemo(() => sinkholeOutlook(spec, { seed: 0, terrain: docTerrain }), [spec, docTerrain]);
  const [cx, cz] = spec.center;
  const final = spec.initiation === 'growth' ? spec.cavityRadius + (spec.growthRate ?? 0) * spec.duration : spec.cavityRadius;
  return (
    <group name="sinkhole-preview">
      <GroundLine pts={circlePts(cx, cz, spec.cavityRadius)} color="#7fb6ff" dashed />
      {final > spec.cavityRadius + 0.05 && <GroundLine pts={circlePts(cx, cz, final)} color="#4f86e0" dashed />}
      {o.criticalRadius < 200 && <GroundLine pts={circlePts(cx, cz, o.criticalRadius)} color="#e0483a" dashed />}
      {o.fails && o.pitRadius > 0 && <GroundLine pts={circlePts(cx, cz, o.pitRadius)} color="#ffd34d" />}
    </group>
  );
}

function LandslidePreview({ inst }: { inst: PhenomenonInstance }) {
  const docTerrain = useWorldStore((s) => s.doc.terrain);
  const spec = inst.spec as LandslideSpec;
  const built = useMemo(() => {
    const t = docTerrain;
    const f = new GeoField(t);
    const p = LandslideModel.preview(spec, f, (i) => t.heights[i]);
    if (!p.cells.length) return null;
    const fsOf = new Map<number, number>();
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    p.cells.forEach((i, k) => {
      fsOf.set(i, p.fs[k]);
      const ix = i % t.nx, iz = (i - ix) / t.nx;
      x0 = Math.min(x0, ix); x1 = Math.max(x1, ix); z0 = Math.min(z0, iz); z1 = Math.max(z1, iz);
    });
    const patch = new FieldPatch(t, { x0, z0, x1, z1 });
    patch.write(t.heights, 0.06, (_l, g, out) => {
      const fs = fsOf.get(g);
      if (fs === undefined || !Number.isFinite(fs)) return 0;
      fsColor(fs, out);
      return 0.75;
    });
    return patch;
  }, [spec, docTerrain]);
  useEffect(() => () => built?.dispose(), [built]);
  return (
    <group name="landslide-preview">
      {built && (
        <mesh geometry={built.geometry} renderOrder={3} raycast={() => null}>
          <meshBasicMaterial vertexColors transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
        </mesh>
      )}
      <GroundLine pts={areaOutline(spec.area)} color="#ffd34d" />
    </group>
  );
}

/** A cross + small ring on the ground (impact aim / impact point). */
export function AimMarker({ x, z, color, r = 2 }: { x: number; z: number; color: string; r?: number }) {
  return (
    <group>
      <GroundLine pts={circlePts(x, z, r, 32)} color={color} />
      <GroundLine pts={[[x - 2 * r, z], [x + 2 * r, z]]} closed={false} color={color} />
      <GroundLine pts={[[x, z - 2 * r], [x, z + 2 * r]]} closed={false} color={color} />
    </group>
  );
}

export function GroundPreview() {
  const id = useViewStore((s) => s.groundPreview);
  const inst = useGroundInstance(id);
  if (!inst) return null;
  if (inst.type === 'impact') return <ImpactPreview inst={inst} />;
  if (inst.type === 'blast') return <BlastPreview inst={inst} />;
  return inst.type === 'sinkhole' ? <SinkholePreview inst={inst} /> : <LandslidePreview inst={inst} />;
}
