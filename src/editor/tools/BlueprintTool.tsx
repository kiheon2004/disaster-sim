/**
 * Blueprint Mode in the viewport (Phase 20).
 *
 * Capture: drag a rectangle, or click polygon corners (double-click / Enter closes, Backspace
 * removes the last one); the area and the roads / water it would take are outlined.
 *
 * Placement: the blueprint follows the cursor as a RIGID ghost in its own frame — one batched
 * adapter built once per blueprint, moved / turned by a group transform, so moving never
 * rebuilds geometry and never touches the world or physics. A click PINS it there: the full
 * plan (terrain policy, roads, collisions, connections) is computed once and drawn exactly
 * (objects where they will stand, pasted roads, river / road connection lines, footprint in the
 * validity colour). Enter or the panel button confirms.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { createWorldObject } from '@/world/WorldDocument';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { ghostFor, type MaterialMode } from '@/rendering/materials';
import { flatSampler } from '@/terrain/TerrainSampler';
import { featureLine } from '@/landscape/features';
import type { Feature, P2 } from '@/landscape/types';
import { centerlineOf } from '@/roads/curve';
import { useWorldStore } from '@/world/worldStore';
import { useBlueprintStore } from '../blueprintStore';
import { useEditorStore } from '../editorStore';
import { confirmPlacement, pinPlacement, schedulePlan, setCaptureShape, snapPoint } from '@/app/blueprintActions';
import { perimeterMean, shapePolygon, validPolygon } from '@/blueprints/selection';
import { footprintOf, preFeatureAt } from '@/blueprints/place';
import type { UnifiedBlueprint } from '@/blueprints/types';
import { RoadOutlines } from './RoadTool';
import { DrapedLine, GroundCatcher, groundHitOf, useOrbitLock, useSampler } from './shared';

/** Above this many objects the pinned preview keeps the rigid ghost (see PlaceTool). */
const EXACT_GHOST_LIMIT = 600;

const COLOR = { area: '#6fd28a', draft: '#ffd36b', ok: '#5ad37e', warn: '#ffb347', bad: '#ff5d5d', busy: '#7aa7ff', water: '#58a6ff', link: '#e6e6e6' };

export function BlueprintTool() {
  const mode = useBlueprintStore((s) => s.mode);
  if (mode === 'capture') return <CaptureTool />;
  if (mode === 'place') return <PlaceTool />;
  return null;
}

// ── Capture ─────────────────────────────────────────────────────────────────

function CaptureTool() {
  const c = useBlueprintStore((s) => s.capture);
  const orbit = useOrbitLock();
  const drag = useRef<P2 | null>(null);
  const [live, setLive] = useState<P2 | null>(null);
  const hit = (e: ThreeEvent<PointerEvent | MouseEvent>): P2 | null => {
    const p = groundHitOf(e);
    return p ? snapPoint(p[0], p[2]) : null;
  };
  useEffect(() => {
    const up = () => {
      if (!drag.current) return;
      orbit.unlock();
      const a = drag.current;
      drag.current = null;
      const b = useBlueprintStore.getState().capture.shape;
      if (b && b.kind === 'rect' && Math.abs(b.x1 - b.x0) >= 2 && Math.abs(b.z1 - b.z0) >= 2) setCaptureShape(b);
      else useBlueprintStore.getState().setCapture({ shape: null });
      void a;
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [orbit]);

  const outline = useMemo(() => (c.shape ? shapePolygon(c.shape) : null), [c.shape]);
  const result = c.result;
  // Captured roads / water back in world coordinates (anchor + local).
  const lines = useMemo(() => (result ? worldLines(result.blueprint, result.report.anchor) : null), [result]);
  return (
    <>
      <GroundCatcher
        onDown={(e) => {
          if (e.button !== 0 || c.kind !== 'rect') return;
          const p = hit(e);
          if (!p) return;
          e.stopPropagation();
          orbit.lock();
          drag.current = p;
          useBlueprintStore.getState().setCapture({ shape: { kind: 'rect', x0: p[0], z0: p[1], x1: p[0], z1: p[1] }, result: null });
        }}
        onMove={(e) => {
          const p = hit(e);
          setLive(p);
          if (drag.current && p) useBlueprintStore.getState().setCapture({ shape: { kind: 'rect', x0: drag.current[0], z0: drag.current[1], x1: p[0], z1: p[1] } });
        }}
        onClick={(e) => {
          if (c.kind !== 'polygon' || e.delta > 5) return;
          const p = hit(e);
          if (!p) return;
          e.stopPropagation();
          const s = useBlueprintStore.getState();
          s.setCapture({ draft: [...s.capture.draft, p], shape: null, result: null });
        }}
        onDoubleClick={(e) => {
          if (c.kind !== 'polygon') return;
          e.stopPropagation();
          closePolygon();
        }}
      />
      {outline && <DrapedLine points={outline} color={c.result ? COLOR.area : COLOR.draft} closed />}
      {c.kind === 'polygon' && c.draft.length > 0 && <DrapedLine points={live ? [...c.draft, live] : c.draft} color={COLOR.draft} />}
      {c.kind === 'polygon' && c.draft.length > 2 && live && <DrapedLine points={[live, c.draft[0]]} color={COLOR.draft} dashed />}
      {lines?.roads.map((pts, i) => <DrapedLine key={`r${i}`} points={pts} color={COLOR.ok} />)}
      {lines?.water.map((pts, i) => <DrapedLine key={`w${i}`} points={pts} color={COLOR.water} />)}
    </>
  );
}

/** Close the polygon being drawn (≥ 3 points, simple). */
export function closePolygon() {
  const s = useBlueprintStore.getState();
  // A double-click adds the same point twice: drop duplicates.
  const pts = s.capture.draft.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.5);
  if (pts.length >= 3 && validPolygon(pts)) setCaptureShape({ kind: 'polygon', points: pts });
  else setCaptureShape({ kind: 'polygon', points: pts.length >= 3 ? pts : [] });
}

function worldLines(bp: UnifiedBlueprint, [ax, az]: P2): { roads: P2[][]; water: P2[][] } {
  const nodes = new Map(bp.roads.nodes.map((n) => [n.id, n]));
  const roads = bp.roads.segments.map((s) => {
    const a = nodes.get(s.a)!, b = nodes.get(s.b)!;
    return centerlineOf([[a.x, a.z], ...s.control, [b.x, b.z]]).samples.filter((_, i, arr) => i % 3 === 0 || i === arr.length - 1).map((p) => [p.x + ax, p.z + az] as P2);
  });
  const water = bp.features.filter((f) => f.kind === 'river' || f.kind === 'lake').map((f) => featurePoints(f).map(([x, z]) => [x + ax, z + az] as P2));
  return { roads, water };
}

function featurePoints(f: Feature): P2[] {
  if (f.kind === 'lake') return [...f.points, f.points[0]];
  if (f.kind === 'mountain' || f.kind === 'hill') return Array.from({ length: 33 }, (_, i) => [f.x + Math.cos((i / 32) * Math.PI * 2) * f.radius, f.z + Math.sin((i / 32) * Math.PI * 2) * f.radius] as P2);
  return featureLine(f as Exclude<Feature, { kind: 'mountain' | 'hill' | 'lake' }>).samples.filter((_, i, a) => i % 3 === 0 || i === a.length - 1).map((p) => [p.x, p.z] as P2);
}

// ── Placement ───────────────────────────────────────────────────────────────

/** Ghost objects of a blueprint in its LOCAL frame (built once per blueprint / toggles). */
function localObjects(bp: UnifiedBlueprint, inc: { buildings: boolean; objects: boolean; vegetation: boolean }): WorldObject[] {
  const items = [...bp.objects.filter((o) => (o.type === 'building' ? inc.buildings : inc.objects)), ...(inc.vegetation ? bp.vegetation : [])];
  return items.map((o, i) => {
    const obj = createWorldObject({ type: o.type, seed: o.seed, ...(o.design ? { building: bp.designs[o.design] } : { params: o.params }), transform: { position: [o.offset[0], o.base, o.offset[2]] as Vec3, rotation: o.rotation, scale: o.scale } }, 0);
    return { ...obj, id: `ghost_${i}` };
  });
}

function Ghost({ objects, mode, local }: { objects: WorldObject[]; mode: MaterialMode; local: boolean }) {
  const [adapter, setAdapter] = useState<SimRenderAdapter | null>(null);
  const camera = useThree((s) => s.camera);
  const sampler = useSampler();
  useEffect(() => {
    if (!objects.length) { setAdapter(null); return; }
    const a = new SimRenderAdapter(staticRuntime(objects), local ? flatSampler() : sampler);
    a.update(camera, 0, 0);
    a.setMaterialOverride(ghostFor(mode));
    a.cullEmpty();
    a.root.traverse((o) => (o.raycast = () => {}));
    setAdapter(a);
    return () => a.dispose();
  }, [objects, mode, local]); // eslint-disable-line react-hooks/exhaustive-deps
  return adapter ? <primitive object={adapter.root} /> : null;
}

/** Flat outlines (area, roads, water) of the blueprint in its local frame, drawn inside the ghost group. */
function LocalOutlines({ bp, color }: { bp: UnifiedBlueprint; color: string }) {
  const obj = useMemo(() => {
    const g = new THREE.Group();
    const add = (pts: P2[], c: string, y: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z)));
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, depthTest: false, transparent: true }));
      l.renderOrder = 12;
      l.raycast = () => {};
      g.add(l);
    };
    const area = bp.area.length >= 3 ? bp.area : (() => { const [a, b, c, d] = bp.preview.bounds; return [[a, b], [c, b], [c, d], [a, d]] as P2[]; })();
    add([...area, area[0]], color, 0.3);
    const nodes = new Map(bp.roads.nodes.map((n) => [n.id, n]));
    for (const s of bp.roads.segments) {
      const a = nodes.get(s.a)!, b = nodes.get(s.b)!;
      add(centerlineOf([[a.x, a.z], ...s.control, [b.x, b.z]]).samples.map((p) => [p.x, p.z]), COLOR.link, 0.4);
    }
    for (const f of bp.features) add(featurePoints(f), f.kind === 'river' || f.kind === 'lake' ? COLOR.water : '#c9a46a', 0.5);
    return g;
  }, [bp, color]);
  useEffect(() => () => obj.traverse((o) => { if (o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } }), [obj]);
  return <primitive object={obj} />;
}

function PlaceTool() {
  const p = useBlueprintStore((s) => s.place);
  const doc = useWorldStore((s) => s.doc);
  const bp = p.blueprint;
  const inc = p.options.include;
  const objects = useMemo(() => (bp ? localObjects(bp, inc) : []), [bp, inc.buildings, inc.objects, inc.vegetation]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = p.pinned ?? p.hover;
  // Datum under the ghost: the destination level along the footprint (as the plan computes it).
  const datum = useMemo(() => {
    if (!bp || !at) return 0;
    if (!p.options.terrainSnap) return bp.origin.datum + p.options.heightOffset;
    const t = doc.terrain;
    const cx = (v: number) => Math.min(t.originX + (t.nx - 1) * t.cellSize, Math.max(t.originX, v));
    const cz = (v: number) => Math.min(t.originZ + (t.nz - 1) * t.cellSize, Math.max(t.originZ, v));
    return perimeterMean(footprintOf(bp, { x: at[0], z: at[1], yaw: p.yaw }), (x, z) => preFeatureAt(doc, cx(x), cz(z)), 2) + p.options.heightOffset;
  }, [bp, at, p.yaw, p.options.terrainSnap, p.options.heightOffset, doc]);
  const plan = p.pinned ? p.plan : null;
  // Pinned: objects drawn where they will stand. Very large blueprints keep the rigid ghost
  // (rebuilding thousands of ghosts per option change would stall) and show only the
  // colliding objects exactly.
  const exact = useMemo(() => {
    if (!plan) return null;
    const bad = new Set(plan.report.collisions);
    const all = plan.edit.add.length <= EXACT_GHOST_LIMIT;
    const ok: WorldObject[] = [], warn: WorldObject[] = [];
    plan.edit.add.forEach((inp, i) => {
      if (bad.has(i)) warn.push({ ...createWorldObject(inp, 0), id: `pin_${i}` });
      else if (all) ok.push({ ...createWorldObject(inp, 0), id: `pin_${i}` });
    });
    return { ok, warn, all };
  }, [plan]);
  const status = !p.plan ? COLOR.busy : p.plan.report.errors.length ? COLOR.bad : p.plan.report.warnings.length ? COLOR.warn : COLOR.ok;
  if (!bp) return null;
  return (
    <>
      <GroundCatcher
        onMove={(e) => {
          const h = groundHitOf(e);
          const q = h ? snapPoint(h[0], h[2]) : null;
          const cur = useBlueprintStore.getState().place.hover;
          if (q && cur && q[0] === cur[0] && q[1] === cur[1]) return;
          useBlueprintStore.getState().setPlace({ hover: q });
          if (!useBlueprintStore.getState().place.pinned) schedulePlan();
        }}
        onOut={() => useBlueprintStore.getState().setPlace({ hover: null })}
        onClick={(e) => {
          if (e.delta > 5) return;
          const h = groundHitOf(e);
          if (!h) return;
          e.stopPropagation();
          pinPlacement(snapPoint(h[0], h[2]));
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (useBlueprintStore.getState().place.pinned) confirmPlacement();
        }}
      />
      {at && !exact?.all && (
        <group position={[at[0], datum, at[1]]} rotation={[0, p.yaw, 0]}>
          <Ghost objects={objects} mode="ghost" local />
          <LocalOutlines bp={bp} color={status} />
        </group>
      )}
      {exact && (
        <>
          <Ghost objects={exact.ok} mode="ghost" local={false} />
          <Ghost objects={exact.warn} mode="ghostInvalid" local={false} />
        </>
      )}
      {plan && <DrapedLine points={plan.report.footprint} color={status} closed />}
      {plan?.report.roads.network && <RoadOutlines network={plan.report.roads.network} segments={plan.report.roads.segments} color={status} />}
      {plan?.edit.landscape?.features?.slice(useWorldStore.getState().doc.landscape.features.length).map((f) => <DrapedLine key={f.id} points={featurePoints(f)} color={f.kind === 'river' || f.kind === 'lake' ? COLOR.water : '#c9a46a'} />)}
      {plan?.report.connections.map((c, i) => <DrapedLine key={`c${i}`} points={[c.from, c.to]} color={c.kind === 'river' || c.kind === 'lake' || c.kind === 'edge' ? COLOR.water : COLOR.link} dashed />)}
      {p.pinned && <PinMarker at={p.pinned} />}
      <EnterToConfirm />
    </>
  );
}

function PinMarker({ at }: { at: P2 }) {
  const pts = useMemo(() => Array.from({ length: 25 }, (_, i) => [at[0] + Math.cos((i / 24) * Math.PI * 2) * 1.2, at[1] + Math.sin((i / 24) * Math.PI * 2) * 1.2] as P2), [at]);
  return <DrapedLine points={pts} color="#ffffff" closed />;
}

/** Keyboard confirm while the placement tool is active (Enter); handled here so it only acts in place mode. */
function EnterToConfirm() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.key === 'Enter' && useEditorStore.getState().tool === 'blueprint' && useBlueprintStore.getState().place.pinned) {
        e.preventDefault();
        confirmPlacement();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
