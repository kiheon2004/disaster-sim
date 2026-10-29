import { useEffect, useMemo, useRef, useState } from 'react';
import { type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useT } from '@/i18n/i18n';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor, type TerrainSampler } from '@/terrain/TerrainSampler';
import { centerlineOf, minRadius, resample, type Centerline, type P2 } from '@/roads/curve';
import { degree, drawRoad, findNode, findSegment, moveControl, moveNode, segmentLine, SNAP_NODE, SNAP_SEGMENT } from '@/roads/network';
import { blockAt, blocksOf } from '@/roads/blocks';
import type { RoadNetwork, RoadProfile } from '@/roads/types';
import { deleteRoadSegments, finishDraft, moveRoadControl, moveRoadNode, placeNeighborhood, splitRoadAt } from '@/app/roadActions';
import { useRoadStore, EMPTY_SELECTION } from '../roadStore';
import { GroundCatcher, groundHitOf, useOrbitLock } from './shared';

const LIFT = 0.25;
const COLORS = {
  ok: '#5fd38a',
  bad: '#ff6b5e',
  node: '#ffd166',
  road: '#7fb8ff',
  sel: '#4f8cff',
  zone: { residential: '#8fd18a', commercial: '#f2b45c', industrial: '#b39ddb', park: '#4caf50', mixed: '#f48fb1', none: '#cfd8dc' },
};

type Snap = { x: number; z: number; kind: 'node' | 'road' | 'free'; id?: string };

/** Snap a ground point: existing node > point on a road > grid > free. */
function snapPoint(n: RoadNetwork, x: number, z: number, grid: number): Snap {
  const node = findNode(n, x, z, SNAP_NODE);
  if (node) return { x: node.x, z: node.z, kind: 'node', id: node.id };
  const hit = findSegment(n, x, z, SNAP_SEGMENT);
  if (hit && hit.dist <= hit.segment.profile.width / 2 + 0.5) return { x: hit.x, z: hit.z, kind: 'road', id: hit.segment.id };
  if (grid > 0) return { x: Math.round(x / grid) * grid, z: Math.round(z / grid) * grid, kind: 'free' };
  return { x, z, kind: 'free' };
}

/** A draped polyline (terrain height + lift). */
function drapedPositions(pts: readonly P2[], sampler: TerrainSampler, lift = LIFT): Float32Array {
  const out = new Float32Array(pts.length * 3);
  pts.forEach(([x, z], i) => {
    out[i * 3] = x;
    out[i * 3 + 1] = sampler.sampleHeight(x, z) + lift;
    out[i * 3 + 2] = z;
  });
  return out;
}

/** Left / right edges of a centerline at ±half (with fold-over protection like the mesh). */
function edges(line: Centerline, half: number): [P2[], P2[]] {
  const L: P2[] = [], R: P2[] = [];
  for (const p of line.samples) {
    L.push([p.x + p.tz * half, p.z - p.tx * half]);
    R.push([p.x - p.tz * half, p.z + p.tx * half]);
  }
  return [L, R];
}

/** Imperative group of preview lines (rebuilt as a whole: a handful of lines). */
class PreviewLines {
  readonly root = new THREE.Group();
  private mats = new Map<string, THREE.LineBasicMaterial>();
  clear() {
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      (c as THREE.Line).geometry.dispose();
    }
  }
  line(pts: readonly P2[], color: string, sampler: TerrainSampler, closed = false, lift = LIFT) {
    if (pts.length < 2) return;
    let mat = this.mats.get(color);
    if (!mat) this.mats.set(color, (mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(drapedPositions(closed ? [...pts, pts[0]] : pts, sampler, lift), 3));
    const l = new THREE.Line(g, mat);
    l.renderOrder = 20;
    l.frustumCulled = false;
    l.raycast = () => {};
    this.root.add(l);
  }
  ring(x: number, z: number, r: number, color: string, sampler: TerrainSampler) {
    const pts: P2[] = [];
    for (let i = 0; i < 32; i++) pts.push([x + Math.cos((i / 32) * Math.PI * 2) * r, z + Math.sin((i / 32) * Math.PI * 2) * r]);
    this.line(pts, color, sampler, true);
  }
  /** Road outline: both edges + centerline. */
  road(line: Centerline, p: RoadProfile, color: string, sampler: TerrainSampler) {
    const [L, R] = edges(line, p.width / 2);
    this.line(L, color, sampler);
    this.line(R, color, sampler);
    this.line(line.samples.map((s) => [s.x, s.z] as P2), color, sampler);
  }
  dispose() {
    this.clear();
    for (const m of this.mats.values()) m.dispose();
  }
}

interface DraftInfo {
  ok: boolean;
  length: number;
  grade: number;
  dh: number;
  crossings: number;
  minR: number;
  snap: Snap['kind'];
}

/** Road Editing Mode in the viewport (Phase 18). */
export function RoadTool() {
  const t = useT();
  const mode = useRoadStore((s) => s.mode);
  const draft = useRoadStore((s) => s.draft);
  const profile = useRoadStore((s) => s.profile);
  const selection = useRoadStore((s) => s.selection);
  const block = useRoadStore((s) => s.block);
  const hood = useRoadStore((s) => s.hood);
  const grid = useRoadStore((s) => s.gridSnap);
  const roads = useWorldStore((s) => s.doc.roads);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const sampler = samplerFor(terrain);
  const orbit = useOrbitLock();
  const lines = useMemo(() => new PreviewLines(), []);
  useEffect(() => () => lines.dispose(), [lines]);
  const [hover, setHover] = useState<Snap | null>(null);
  /** Handle drag in edit mode: node or control point being moved, with its live position. */
  const [drag, setDrag] = useState<{ kind: 'node'; id: string; x: number; z: number } | { kind: 'control'; seg: string; index: number; x: number; z: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // Finish a handle drag on release (one undo step), wherever the pointer is.
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      orbit.unlock();
      try {
        if (d.kind === 'node') moveRoadNode(d.id, d.x, d.z);
        else moveRoadControl(d.seg, d.index, d.x, d.z);
      } catch {
        /* reported by the action */
      }
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [orbit]);

  // Preview network of the current draft + hover point (what a click / finish would build).
  /** Draft + hover point (unless the hover sits on the last placed point). */
  const draftPts = useMemo(() => {
    const pts: P2[] = [...draft];
    const last = pts[pts.length - 1];
    if (hover && !(last && Math.hypot(last[0] - hover.x, last[1] - hover.z) < 0.5)) pts.push([hover.x, hover.z]);
    return pts;
  }, [draft, hover]);

  const preview = useMemo(() => {
    if ((mode !== 'draw' && mode !== 'curve') || hood) return null;
    const pts = draftPts;
    if (pts.length < 2) return null;
    try {
      const r = drawRoad(roads, pts, { curved: mode === 'curve', profile });
      return { net: r.network, segments: r.segments, ok: true };
    } catch {
      return { net: null, segments: [], ok: false, pts };
    }
  }, [mode, draftPts, roads, profile, hood]);

  // Live network while dragging a handle (outline only; the commit bakes).
  const dragged = useMemo(() => {
    if (!drag) return null;
    try {
      return drag.kind === 'node' ? moveNode(roads, drag.id, drag.x, drag.z) : moveControl(roads, drag.seg, drag.index, drag.x, drag.z);
    } catch {
      return null;
    }
  }, [drag, roads]);

  const info: DraftInfo | null = useMemo(() => {
    if (!preview) return null;
    const pts = draftPts;
    const line = mode === 'curve' ? centerlineOf(pts) : resample(pts);
    const a = pts[0], b = pts[pts.length - 1];
    const dh = sampler.sampleHeight(b[0], b[1]) - sampler.sampleHeight(a[0], a[1]);
    let crossings = 0;
    if (preview.net) for (const id of Object.keys(preview.net.nodes)) if (!roads.nodes[id] && degree(preview.net, id) >= 3) crossings++;
    // Polylines are straight legs joined at nodes: a radius only means something for curves.
    return { ok: preview.ok, length: line.length, grade: line.length > 0 ? (dh / line.length) * 100 : 0, dh, crossings, minR: mode === 'curve' ? minRadius(line) : Infinity, snap: hover?.kind ?? 'free' };
  }, [preview, draftPts, hover, mode, sampler, roads]);

  // Rebuild preview lines.
  useEffect(() => {
    lines.clear();
    // Selected roads + handles' context.
    for (const id of selection.segments) {
      const s = roads.segments[id];
      if (s) lines.road(segmentLine(roads, s), s.profile, COLORS.sel, sampler);
    }
    if (dragged) {
      const affected = new Set<string>();
      if (drag?.kind === 'node') for (const s of Object.values(dragged.segments)) { if (s.a === drag.id || s.b === drag.id) affected.add(s.id); }
      else if (drag) affected.add(drag.seg);
      for (const id of affected) lines.road(segmentLine(dragged, dragged.segments[id]), dragged.segments[id].profile, COLORS.ok, sampler);
    }
    if (preview?.net) {
      for (const id of preview.segments) {
        const s = preview.net.segments[id];
        if (s) lines.road(segmentLine(preview.net, s), s.profile, COLORS.ok, sampler);
      }
      for (const id of Object.keys(preview.net.nodes)) {
        if (!roads.nodes[id] && degree(preview.net, id) >= 3) lines.ring(preview.net.nodes[id].x, preview.net.nodes[id].z, 1.5, COLORS.node, sampler);
      }
    } else if (preview && !preview.ok && 'pts' in preview && preview.pts) {
      lines.line(preview.pts as P2[], COLORS.bad, sampler);
    }
    for (const p of draft) lines.ring(p[0], p[1], 0.6, COLORS.ok, sampler);
    if (hover && (mode === 'draw' || mode === 'curve' || mode === 'split' || hood)) {
      lines.ring(hover.x, hover.z, hover.kind === 'node' ? 2 : 1.2, hover.kind === 'node' ? COLORS.node : hover.kind === 'road' ? COLORS.road : '#ffffff', sampler);
    }
    if (mode === 'zone') {
      for (const b of blocksOf(roads)) lines.line(b.polygon, b.id === block ? COLORS.sel : COLORS.zone[b.zone ?? 'none'], sampler, true, b.id === block ? 0.6 : 0.35);
    }
    if (hood && hover) {
      // Footprint of the neighbourhood (its road layout box).
      const half: P2 = hood.kind === 'industrialBlock' ? [50, 40] : hood.kind === 'parkBlock' ? [40, 40] : [hood.kind === 'commercialStreet' ? 70 : 60, 25];
      const c = Math.cos(hood.yaw), s = Math.sin(hood.yaw);
      const at = (u: number, v: number): P2 => [hover.x + u * c + v * s, hover.z - u * s + v * c];
      lines.line([at(-half[0], -half[1]), at(half[0], -half[1]), at(half[0], half[1]), at(-half[0], half[1])], COLORS.node, sampler, true);
    }
  }, [lines, selection, roads, preview, draft, hover, mode, block, hood, sampler, dragged, drag]);

  const groundPoint = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const h = groundHitOf(e);
    return h && sampler.inside(h[0], h[2]) ? h : null;
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const h = groundPoint(e);
    if (!h) return setHover(null);
    if (drag) {
      const sn = drag.kind === 'node' ? snapPoint({ ...roads, nodes: Object.fromEntries(Object.entries(roads.nodes).filter(([k]) => k !== drag.id)) }, h[0], h[2], grid) : { x: h[0], z: h[2] };
      setDrag({ ...drag, x: Math.round(sn.x * 100) / 100, z: Math.round(sn.z * 100) / 100 });
      return;
    }
    setHover(mode === 'zone' || mode === 'edit' || mode === 'delete' ? { x: h[0], z: h[2], kind: 'free' } : snapPoint(roads, h[0], h[2], grid));
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5 || drag) return;
    const h = groundPoint(e);
    if (!h) return;
    const rs = useRoadStore.getState();
    if (rs.hood) {
      placeNeighborhood(rs.hood.kind, h[0], h[2], rs.hood.yaw, rs.hood.seed);
      rs.setHood(null);
      return;
    }
    if (mode === 'draw' || mode === 'curve') {
      const sn = snapPoint(roads, h[0], h[2], grid);
      const last = rs.draft[rs.draft.length - 1];
      if (last && Math.hypot(last[0] - sn.x, last[1] - sn.z) < 0.5) return;
      rs.addPoint([Math.round(sn.x * 100) / 100, Math.round(sn.z * 100) / 100]);
      return;
    }
    const hit = findSegment(roads, h[0], h[2], SNAP_SEGMENT);
    if (mode === 'split') {
      if (hit) splitRoadAt(hit.segment.id, hit.x, hit.z);
      return;
    }
    if (mode === 'delete') {
      if (hit) deleteRoadSegments([hit.segment.id]);
      return;
    }
    if (mode === 'zone') {
      rs.setBlock(blockAt(roads, h[0], h[2])?.id ?? null);
      return;
    }
    if (mode === 'edit') {
      const node = findNode(roads, h[0], h[2], 2.5);
      if (node && !e.nativeEvent.shiftKey) {
        rs.select({ node: node.id });
        return;
      }
      if (!hit) {
        if (!e.nativeEvent.shiftKey) rs.select(EMPTY_SELECTION);
        return;
      }
      const id = hit.segment.id;
      const cur = rs.selection.segments;
      rs.select({ segments: e.nativeEvent.shiftKey ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id], node: null });
    }
  };

  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    if (mode !== 'draw' && mode !== 'curve') return;
    e.stopPropagation();
    // The double-click's second click added a duplicate point (ignored by the 0.5 m check).
    finishDraft();
  };

  // Handles of the selected roads' nodes and control points (edit mode).
  const handles = useMemo(() => {
    if (mode !== 'edit') return [];
    const out: ({ kind: 'node'; id: string; x: number; z: number } | { kind: 'control'; seg: string; index: number; x: number; z: number })[] = [];
    const nodes = new Set<string>();
    for (const id of selection.segments) {
      const s = roads.segments[id];
      if (!s) continue;
      nodes.add(s.a);
      nodes.add(s.b);
      s.control.forEach((c, index) => out.push({ kind: 'control', seg: id, index, x: c[0], z: c[1] }));
    }
    if (selection.node) nodes.add(selection.node);
    for (const id of nodes) if (roads.nodes[id]) out.push({ kind: 'node', id, x: roads.nodes[id].x, z: roads.nodes[id].z });
    return out;
  }, [mode, selection, roads]);

  const label = info && hover && (
    <Html position={[hover.x, sampler.sampleHeight(hover.x, hover.z) + 2.5, hover.z]} center style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
      <div data-testid="road-preview" style={{ background: 'rgba(20,24,32,0.85)', color: info.ok ? '#e8f5e9' : '#ffcdd2', padding: '4px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap', lineHeight: 1.45 }}>
        {info.ok ? (
          <>
            <div>{t('road.preview.length', { v: info.length.toFixed(1) })} · {t('road.preview.grade', { v: info.grade.toFixed(1) })} · {t('road.preview.dh', { v: info.dh.toFixed(2) })}</div>
            {(info.snap !== 'free' || info.crossings > 0 || Number.isFinite(info.minR)) && (
              <div>
                {info.snap === 'node' && t('road.preview.snapNode')}
                {info.snap === 'road' && t('road.preview.snapRoad')}
                {info.crossings > 0 && ` ${t('road.preview.crossings', { n: info.crossings })}`}
                {Number.isFinite(info.minR) && ` ${t('road.preview.minRadius', { v: info.minR.toFixed(0) })}`}
              </div>
            )}
          </>
        ) : t('road.preview.invalid')}
      </div>
    </Html>
  );

  return (
    <>
      <primitive object={lines.root} />
      <GroundCatcher onMove={onMove} onClick={onClick} onDoubleClick={onDoubleClick} onOut={() => setHover(null)} />
      {handles.map((h) => {
        const x = drag && ((drag.kind === 'node' && h.kind === 'node' && drag.id === h.id) || (drag.kind === 'control' && h.kind === 'control' && drag.seg === h.seg && drag.index === h.index)) ? drag.x : h.x;
        const z = drag && ((drag.kind === 'node' && h.kind === 'node' && drag.id === h.id) || (drag.kind === 'control' && h.kind === 'control' && drag.seg === h.seg && drag.index === h.index)) ? drag.z : h.z;
        return (
          <mesh
            key={h.kind === 'node' ? `n:${h.id}` : `c:${h.seg}:${h.index}`}
            position={[x, sampler.sampleHeight(x, z) + 0.6, z]}
            renderOrder={30}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button !== 0) return;
              orbit.lock();
              setDrag({ ...h });
              if (h.kind === 'node') useRoadStore.getState().select({ node: h.id });
            }}
            onPointerOver={() => (document.body.style.cursor = 'grab')}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            <sphereGeometry args={[h.kind === 'node' ? 0.9 : 0.6, 16, 12]} />
            <meshBasicMaterial color={h.kind === 'node' ? (selection.node === h.id ? COLORS.sel : COLORS.node) : COLORS.ok} depthTest={false} transparent opacity={0.95} />
          </mesh>
        );
      })}
      {label}
    </>
  );
}
