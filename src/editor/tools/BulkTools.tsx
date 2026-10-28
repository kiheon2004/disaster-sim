/**
 * Bulk placement tools (Phase 16): Brush (drag to scatter), Line (click points along a path)
 * and Area (rectangle / circle / painted region, previewed before Apply). Each commits its
 * whole result as ONE undo step through commitPlan(). The armed palette preset decides what is
 * placed; tool options come from the build store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '@/core/types';
import { getPaletteItem, type PaletteItem } from '@/objects/palette';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useEditorStore } from '../editorStore';
import { gridStep, useBuildStore } from '../buildStore';
import { BrushScatter, areaFill, lineLayout, type AreaShape, type Vec2 } from '../build/distribution';
import { FootprintIndex } from '../build/footprint';
import { planPlacement, type PlacementSettings, type PlannedObject } from '../build/placementPlan';
import { commitPlan } from '@/app/buildActions';
import { BrushRing, DrapedLine, GroundCatcher, PlanPreview, ShapeOutline, groundHitOf, useOrbitLock, useSampler } from './shared';

function useArmedItem(): PaletteItem | undefined {
  return getPaletteItem(useEditorStore((s) => s.placeItemId));
}

/** Placement settings with the editor's natural-variation toggle applied. */
function usePlacementSettings(): PlacementSettings {
  const placement = useBuildStore((s) => s.placement);
  const randomize = useEditorStore((s) => s.randomize);
  return useMemo(() => ({ ...placement, variation: placement.variation && randomize }), [placement, randomize]);
}

/** Footprints of the current world (rebuilt when the objects change). */
function useExistingIndex(): FootprintIndex {
  const objects = useWorldStore((s) => s.doc.objects);
  return useMemo(() => FootprintIndex.fromObjects(Object.values(objects)), [objects]);
}

function snap2(p: Vec3, on: boolean, step: number): Vec2 {
  return on ? [Math.round(p[0] / step) * step, Math.round(p[2] / step) * step] : [p[0], p[2]];
}

// ── Brush ────────────────────────────────────────────────────────────────

export function BrushTool() {
  const item = useArmedItem();
  const brush = useBuildStore((s) => s.brush);
  const settings = usePlacementSettings();
  const existing = useExistingIndex();
  const sampler = useSampler();
  const orbit = useOrbitLock();
  const cursor = useRef<Vec3 | null>(null);
  const stroke = useRef<{ scatter: BrushScatter; plan: PlannedObject[]; planned: FootprintIndex } | null>(null);
  const [plan, setPlan] = useState<PlannedObject[]>([]);

  const end = useCallback((commit: boolean) => {
    const s = stroke.current;
    stroke.current = null;
    orbit.unlock();
    if (s && commit) commitPlan(s.plan, useEditorStore.getState().placeItemId);
    setPlan([]);
  }, [orbit]);

  useEffect(() => {
    const up = () => stroke.current && end(true);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && stroke.current && end(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', up);
      if (stroke.current) end(false);
    };
  }, [end]);

  const extend = (hit: Vec3) => {
    const s = stroke.current;
    if (!s || !item) return;
    const pts = s.scatter.extend([hit[0], hit[2]]);
    if (!pts.length) return;
    const added = planPlacement(item, pts.map(([x, z]) => ({ x, z })), settings, { terrain: sampler, existing }, s.plan.length, s.planned);
    s.plan = [...s.plan, ...added];
    setPlan(s.plan);
  };

  if (!item) return null;
  return (
    <>
      <GroundCatcher
        onMove={(e) => {
          cursor.current = groundHitOf(e);
          if (cursor.current && stroke.current) extend(cursor.current);
        }}
        onOut={() => (cursor.current = null)}
        onDown={(e: ThreeEvent<PointerEvent>) => {
          if (e.button !== 0) return;
          const hit = groundHitOf(e);
          if (!hit) return;
          e.stopPropagation();
          orbit.lock();
          stroke.current = {
            scatter: new BrushScatter({ radius: brush.radius, density: brush.density, spacing: brush.spacing, seed: settings.seed }),
            plan: [],
            planned: new FootprintIndex(),
          };
          extend(hit);
        }}
      />
      <BrushRing at={cursor} radius={brush.radius} color="#7fd3a0" />
      <PlanPreview plan={plan} showRejected={false} />
    </>
  );
}

// ── Line ─────────────────────────────────────────────────────────────────

export function LineTool() {
  const item = useArmedItem();
  const line = useBuildStore((s) => s.line);
  const points = useBuildStore((s) => s.lineSession.points);
  const settings = usePlacementSettings();
  const existing = useExistingIndex();
  const sampler = useSampler();
  const snap = useEditorStore((s) => s.snap);
  const grid = useBuildStore((s) => s.snapping.grid);
  const yaw = useEditorStore((s) => s.ghostYaw);
  const [cursor, setCursor] = useState<Vec2 | null>(null);

  const path = useMemo(() => (cursor && points.length ? [...points, cursor] : points), [points, cursor]);
  const plan = useMemo(() => {
    if (!item || path.length < 2) return [];
    const pts = lineLayout(path, { spacing: line.spacing, orient: line.orient, yaw, offset: line.offset, bothSides: line.bothSides });
    return planPlacement(item, pts, { ...settings, randomRotation: false, baseYaw: 0 }, { terrain: sampler, existing });
  }, [item, path, line, yaw, settings, sampler, existing]);

  // Enter = place, Backspace = remove the last point (the hotkey layer handles Esc).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      const b = useBuildStore.getState();
      if (e.key === 'Enter' && b.lineSession.points.length >= 2) {
        e.preventDefault();
        finishLine(item?.id ?? null, b.lineSession.points);
      } else if (e.key === 'Backspace' && b.lineSession.points.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        b.setLineSession({ points: b.lineSession.points.slice(0, -1) });
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [item, settings, sampler]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const step = gridStep(grid, 1);
  return (
    <>
      <GroundCatcher
        onMove={(e) => {
          const hit = groundHitOf(e);
          setCursor(hit ? snap2(hit, snap, step) : null);
        }}
        onOut={() => setCursor(null)}
        onClick={(e) => {
          if (e.delta > 5) return; // camera drag
          const hit = groundHitOf(e);
          if (!hit) return;
          e.stopPropagation();
          const p = snap2(hit, snap, step);
          const b = useBuildStore.getState();
          const pts = b.lineSession.points;
          const last = pts[pts.length - 1];
          // Clicking the last point again (or double-click) finishes the line.
          if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 0.3) {
            if (pts.length >= 2) finishLine(item.id, pts);
            return;
          }
          b.setLineSession({ points: [...pts, p] });
        }}
      />
      {path.length >= 2 && <DrapedLine points={path} color="#ffd36b" />}
      {points.length >= 1 && <PointMarkers points={points} />}
      <PlanPreview plan={plan} />
    </>
  );

  function finishLine(itemId: string | null, pts: Vec2[]) {
    // Re-plan on exactly the clicked points (no cursor rubber band).
    const it = getPaletteItem(itemId);
    if (!it) return;
    const l = useBuildStore.getState().line;
    const layout = lineLayout(pts, { spacing: l.spacing, orient: l.orient, yaw: useEditorStore.getState().ghostYaw, offset: l.offset, bothSides: l.bothSides });
    const s = { ...settings, randomRotation: false, baseYaw: 0 };
    commitPlan(planPlacement(it, layout, s, { terrain: sampler, existing: FootprintIndex.fromObjects(Object.values(useWorldStore.getState().doc.objects)) }), itemId);
    useBuildStore.getState().setLineSession({ points: [] });
  }
}

function PointMarkers({ points }: { points: Vec2[] }) {
  const sampler = useSampler();
  return (
    <>
      {points.map(([x, z], i) => (
        <mesh key={i} position={[x, sampler.sampleHeight(x, z) + 0.15, z]} renderOrder={12} raycast={() => null}>
          <sphereGeometry args={[0.35, 10, 8]} />
          <meshBasicMaterial color={i === 0 ? '#7fd3a0' : '#ffd36b'} depthTest={false} transparent />
        </mesh>
      ))}
    </>
  );
}

// ── Area ─────────────────────────────────────────────────────────────────

/** Plan for an area shape with the current options (also used by the Apply button). */
export function planArea(item: PaletteItem, shape: AreaShape, settings: PlacementSettings): PlannedObject[] {
  const a = useBuildStore.getState().area;
  const doc = useWorldStore.getState().doc;
  const pts = areaFill(shape, { mode: a.mode, spacing: a.spacing, density: a.density, jitter: a.mode === 'grid' ? a.jitter : 0, seed: settings.seed });
  const sampler = samplerFor(doc.terrain);
  return planPlacement(item, pts.map(([x, z]) => ({ x, z })), settings, { terrain: sampler, existing: FootprintIndex.fromObjects(Object.values(doc.objects)) });
}

/** Apply the area tool's shape with the current options (Apply button / Enter). One undo step. */
export function applyAreaSession(): number {
  const ed = useEditorStore.getState();
  const b = useBuildStore.getState();
  const item = getPaletteItem(ed.placeItemId);
  const shape = b.areaSession.shape;
  if (!item || !shape) return 0;
  const settings = { ...b.placement, variation: b.placement.variation && ed.randomize };
  const ids = commitPlan(planArea(item, shape, settings), item.id);
  b.setAreaSession({ shape: null, dragging: false });
  return ids.length;
}

export function AreaTool() {
  const item = useArmedItem();
  const area = useBuildStore((s) => s.area);
  const session = useBuildStore((s) => s.areaSession);
  const brush = useBuildStore((s) => s.brush);
  const settings = usePlacementSettings();
  const objects = useWorldStore((s) => s.doc.objects);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const snap = useEditorStore((s) => s.snap);
  const grid = useBuildStore((s) => s.snapping.grid);
  const orbit = useOrbitLock();
  const cursor = useRef<Vec3 | null>(null);
  const drag = useRef<{ start: Vec2 } | null>(null);

  const shape = session.shape;
  // Preview follows the options live (spacing, density, seed …) — not while dragging a mask.
  const plan = useMemo(
    () => (item && shape && !(session.dragging && shape.kind === 'mask') ? planArea(item, shape, settings) : []),
    [item, shape, session.dragging, settings, area, objects, terrain], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      orbit.unlock();
      const s = useBuildStore.getState().areaSession;
      useBuildStore.getState().setAreaSession({ shape: s.shape, dragging: false });
    };
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointerup', up);
      up();
    };
  }, [orbit]);

  if (!item) return null;
  const step = gridStep(grid, 1);
  const set = (s: AreaShape) => useBuildStore.getState().setAreaSession({ shape: s, dragging: true });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    cursor.current = groundHitOf(e);
    const d = drag.current;
    const hit = cursor.current;
    if (!d || !hit) return;
    const p = snap2(hit, snap && area.shape !== 'brush', step);
    if (area.shape === 'rect') set({ kind: 'rect', x0: d.start[0], z0: d.start[1], x1: p[0], z1: p[1] });
    else if (area.shape === 'circle') set({ kind: 'circle', x: d.start[0], z: d.start[1], r: Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) });
    else {
      const cur = useBuildStore.getState().areaSession.shape;
      const discs = cur?.kind === 'mask' ? cur.discs : [];
      const last = discs[discs.length - 1];
      if (!last || Math.hypot(last.x - p[0], last.z - p[1]) > brush.radius * 0.35) set({ kind: 'mask', discs: [...discs, { x: p[0], z: p[1], r: brush.radius }] });
    }
  };

  return (
    <>
      <GroundCatcher
        onMove={onMove}
        onOut={() => (cursor.current = null)}
        onDown={(e) => {
          if (e.button !== 0) return;
          const hit = groundHitOf(e);
          if (!hit) return;
          e.stopPropagation();
          orbit.lock();
          const p = snap2(hit, snap && area.shape !== 'brush', step);
          drag.current = { start: p };
          if (area.shape === 'brush') {
            // Painting adds to the current region (Shift starts a new one).
            const cur = useBuildStore.getState().areaSession.shape;
            const discs = cur?.kind === 'mask' && !e.shiftKey ? cur.discs : [];
            set({ kind: 'mask', discs: [...discs, { x: p[0], z: p[1], r: brush.radius }] });
          } else set(area.shape === 'rect' ? { kind: 'rect', x0: p[0], z0: p[1], x1: p[0], z1: p[1] } : { kind: 'circle', x: p[0], z: p[1], r: 0 });
        }}
      />
      {area.shape === 'brush' && <BrushRing at={cursor} radius={brush.radius} color="#8fc7ff" />}
      {shape && <ShapeOutline shape={shape} color="#8fc7ff" />}
      <PlanPreview plan={plan} />
    </>
  );
}
