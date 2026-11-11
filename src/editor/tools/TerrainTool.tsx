import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { WORLD_SIZE } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { dabPath, paintCore, previewDab, type DabOptions, type DabPreview, type TerrainBrushOp } from '@/terrain/TerrainEditor';
import { groundMaterial } from '@/terrain/GroundMaterials';
import { markTerrainDirty } from '@/rendering/terrain/terrainDirty';
import { unionRect, type GridRect } from '@/terrain/TerrainData';
import { beginGesture, type Gesture } from '../input/gesture';
import { useEditorStore, type TerrainToolId } from '../editorStore';

const RING_SEGMENTS = 72;
const TOOL_COLORS: Record<string, string> = {
  raise: '#7fd37a',
  lower: '#f08a5d',
  flatten: '#f2d36b',
  smooth: '#8fc7ff',
  paint: '#ffffff',
  soil: '#6a9bb3',
  inspect: '#ffb067',
  plateau: '#e8c26a',
  ridge: '#b9e07a',
  valley: '#e09a6a',
  slope: '#d7b7ff',
  noise: '#9fd9d0',
  erode: '#c9a27c',
};

/** Terrain tools that paint with the brush (the others place / draw natural features). */
export const BRUSH_TOOLS: readonly TerrainToolId[] = ['raise', 'lower', 'flatten', 'smooth', 'paint', 'soil', 'plateau', 'ridge', 'valley', 'slope', 'noise', 'erode'];
export const isBrushTool = (t: TerrainToolId) => (BRUSH_TOOLS as readonly string[]).includes(t);
/** Brushes that relax toward a target level (shown as a level ring at that height). */
const LEVEL_TOOLS: readonly string[] = ['flatten', 'plateau', 'slope'];

/** Bilinear height from a copied height array (the terrain at the start of a slope stroke). */
function heightIn(h: Float32Array, t: { nx: number; nz: number; cellSize: number; originX: number; originZ: number }, x: number, z: number): number {
  const fx = Math.min(t.nx - 1.000001, Math.max(0, (x - t.originX) / t.cellSize));
  const fz = Math.min(t.nz - 1.000001, Math.max(0, (z - t.originZ) / t.cellSize));
  const ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz, i = iz * t.nx + ix;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + t.nx] * (1 - ax) + h[i + t.nx + 1] * ax) * az;
}

/** A line object for the tool's guides (always on top, never picked). */
function guideLine(points: number, color: string, order = 10): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3));
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
  line.renderOrder = order;
  line.frustumCulled = false;
  line.visible = false;
  line.raycast = () => {};
  return line;
}

/**
 * Outline of the brush where it acts: a circle, or a square for the square shape (max-norm distance), at radius `r`;
 * `y(x, z)` gives the height of each point (draped on the ground, or a level at the target height).
 */
function setOutline(line: THREE.Line, cx: number, cz: number, r: number, square: boolean, y: (x: number, z: number) => number) {
  const pos = line.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    let dx = Math.cos(a), dz = Math.sin(a);
    // The square is the unit circle pushed out to the max-norm: same parametrisation, corners included.
    if (square) { const m = Math.max(Math.abs(dx), Math.abs(dz)); dx /= m; dz /= m; }
    const x = cx + dx * r, z = cz + dz * r;
    pos.setXYZ(i, x, y(x, z), z);
  }
  pos.needsUpdate = true;
  line.visible = true;
}

/**
 * Draped preview of a dab (Phase 36, §22): one vertex per terrain vertex of the predicted rectangle, coloured by the
 * predicted height change of 1 s of brush time (warm = raise, cool = lower, stronger = more), or by the paint colour
 * where a paint brush would paint. Alpha 0 where nothing changes.
 */
class PreviewMesh {
  readonly mesh: THREE.Mesh;
  private size = { w: 0, h: 0 };
  constructor() {
    const g = new THREE.BufferGeometry();
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  show(p: DabPreview, t: { nx: number; cellSize: number; originX: number; originZ: number; heights: Float32Array }, paintColor: THREE.Color | null) {
    const w = p.rect.x1 - p.rect.x0 + 1, h = p.rect.z1 - p.rect.z0 + 1, n = w * h;
    const g = this.mesh.geometry;
    if (w !== this.size.w || h !== this.size.h) {
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      const idx: number[] = [];
      for (let z = 0; z < h - 1; z++) for (let x = 0; x < w - 1; x++) {
        const a = z * w + x;
        idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
      }
      g.setIndex(idx);
      this.size = { w, h };
    }
    const pos = g.attributes.position as THREE.BufferAttribute, col = g.attributes.color as THREE.BufferAttribute;
    const scale = Math.max(p.up, -p.down, 1e-6);
    for (let k = 0; k < n; k++) {
      const ix = p.rect.x0 + (k % w), iz = p.rect.z0 + Math.floor(k / w);
      const d = p.dh[k];
      pos.setXYZ(k, t.originX + ix * t.cellSize, t.heights[iz * t.nx + ix] + Math.max(0, d) + 0.06, t.originZ + iz * t.cellSize);
      if (paintColor) col.setXYZW(k, paintColor.r, paintColor.g, paintColor.b, p.painted[k] ? 0.55 : 0);
      else if (d > 0) col.setXYZW(k, 1, 0.55, 0.2, 0.18 + 0.6 * (d / scale));
      else if (d < 0) col.setXYZW(k, 0.25, 0.6, 1, 0.18 + 0.6 * (-d / scale));
      else col.setXYZW(k, 0, 0, 0, 0);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Dab options of the current tool settings at (x, z) (shared by the stroke and the preview). */
function dabOptions(op: TerrainBrushOp, x: number, z: number, dt: number, target: number): DabOptions {
  const ed = useEditorStore.getState();
  return {
    op, x, z, dt, targetHeight: target,
    brush: { radius: ed.brushRadius, strength: ed.brushStrength },
    groundType: ed.paintType, soilType: ed.soilType, falloff: ed.brushFalloff, shape: ed.brushShape, seed: ed.brushSeed,
    minHeight: ed.brushMin, maxHeight: ed.brushMax,
  };
}

const opOf = (tool: TerrainToolId) => (tool === 'soil' ? 'paintSoil' : tool) as TerrainBrushOp;

/**
 * Terrain Editing Mode in the viewport: the brush outline follows the cursor (its true shape and, for paint, the core
 * it paints), with a draped preview of what 1 s of the brush would do there (Phase 36); holding the left button applies
 * the tool every frame (one undo step per stroke), interpolated along the drag. Pointer hits come from the terrain data
 * (TerrainSampler.raycast), not from mesh raycasting.
 */
export function TerrainTool() {
  const tool = useEditorStore((s) => s.terrainTool);
  const probe = useEditorStore((s) => s.terrainProbe);
  const cursor = useRef<Vec3 | null>(null);
  const held = useRef<{ op: TerrainBrushOp; target: number; ax: number; az: number; start: Float32Array | null; last: [number, number] | null } | null>(null);
  const lastDelta = useRef(0);
  const lastPreview = useRef({ key: '', at: 0 });
  const ring = useMemo(() => guideLine(RING_SEGMENTS + 1, TOOL_COLORS[tool]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const level = useMemo(() => guideLine(RING_SEGMENTS + 1, '#fff3c4', 11), []);
  const ramp = useMemo(() => guideLine(2, '#fff3c4', 11), []);
  const preview = useMemo(() => new PreviewMesh(), []);
  (ring.material as THREE.LineBasicMaterial).color.set(TOOL_COLORS[tool]);

  const hitFrom = (e: ThreeEvent<PointerEvent | MouseEvent>): Vec3 | null => {
    const sampler = samplerFor(useWorldStore.getState().doc.terrain);
    const o = e.ray.origin;
    const d = e.ray.direction;
    const out: Vec3 = [0, 0, 0];
    if (!sampler.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, out)) return null;
    return sampler.inside(out[0], out[2]) ? out : null;
  };

  // Phase 36: a stroke is a gesture — release / window blur commit it (one undo step), Esc /
  // pointercancel / unmount cancel it (the ground from before comes back). Before, Esc left the
  // tool and COMMITTED the stroke, and after a pointercancel the brush kept sculpting unpressed.
  const gesture = useRef<Gesture | null>(null);
  useEffect(() => () => gesture.current?.finish(false, 'abort'), []);

  useEffect(() => () => {
    for (const l of [ring, level, ramp]) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    preview.dispose();
    useEditorStore.getState().setBrushPreview(null);
  }, [ring, level, ramp, preview]);

  useFrame((_, dt) => {
    const c = cursor.current;
    const ed = useEditorStore.getState();
    const world = useWorldStore.getState();
    const t = world.doc.terrain;
    const sampler = samplerFor(t);
    // Apply the brush while held (dt capped so a stalled frame does not make a crater). Phase 36: the dabs follow the
    // drag from the previous dab to the cursor, sharing the frame's brush time (no gaps when dragging fast).
    if (held.current && c) {
      const hc = held.current;
      const from = hc.last ?? [c[0], c[2]];
      const path = hc.last ? dabPath(from[0], from[1], c[0], c[2], ed.brushRadius, t.cellSize) : [[c[0], c[2]] as [number, number]];
      const step = Math.min(dt, 1 / 20) / path.length;
      let rect: GridRect | null = null;
      for (const [x, z] of path) {
        const o = dabOptions(hc.op, x, z, step, hc.target);
        if (hc.start) o.slope = { ax: hc.ax, az: hc.az, ah: hc.target, bx: x, bz: z, bh: heightIn(hc.start, t, x, z) };
        rect = unionRect(rect, world.terrainDab(o));
      }
      hc.last = [c[0], c[2]];
      markTerrainDirty(rect);
      // Live height change of this stroke (throttled to ~6 Hz for the panel).
      const now = performance.now();
      if (now - lastDelta.current > 160) {
        lastDelta.current = now;
        ed.setStrokeDelta(world.strokeDelta());
      }
    }
    ring.visible = !!c;
    level.visible = false;
    ramp.visible = false;
    if (!c) {
      preview.mesh.visible = false;
      if (ed.brushPreview) ed.setBrushPreview(null);
      return;
    }
    const brush = isBrushTool(tool);
    const op = opOf(tool);
    const paint = op === 'paint' || op === 'paintSoil';
    const square = ed.brushShape === 'square' && brush;
    // Paint brushes act on their core only: the outline shows where they actually paint.
    const r = tool === 'inspect' ? 0.6 : paint ? paintCore(ed.brushRadius, ed.brushStrength) : ed.brushRadius;
    setOutline(ring, c[0], c[2], r, square, (x, z) => sampler.sampleHeight(x, z) + 0.08);
    if (brush && LEVEL_TOOLS.includes(op)) {
      const hc = held.current;
      if (hc?.start) {
        // Slope: the ramp from A (press point, its height) to B (the cursor, its height at the stroke start).
        const pos = ramp.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, hc.ax, hc.target + 0.1, hc.az);
        pos.setXYZ(1, c[0], heightIn(hc.start, t, c[0], c[2]) + 0.1, c[2]);
        pos.needsUpdate = true;
        ramp.visible = true;
      } else {
        // Flatten / plateau (and a slope before pressing): the level the brush relaxes to.
        const y = (hc?.target ?? c[1]) + 0.05;
        setOutline(level, c[0], c[2], ed.brushRadius * 0.5, square, () => y);
      }
    }
    // §22 preview: what 1 s of the brush would do at the cursor (not while sculpting: the real change is visible).
    if (!brush || held.current) {
      preview.mesh.visible = false;
      if (!brush && ed.brushPreview) ed.setBrushPreview(null);
      return;
    }
    const key = `${tool}|${c[0].toFixed(1)},${c[2].toFixed(1)}|${ed.brushRadius},${ed.brushStrength},${ed.brushShape},${ed.brushFalloff},${ed.brushMin},${ed.brushMax},${ed.brushSeed},${ed.paintType},${ed.soilType}|${t.revision}`;
    const now = performance.now();
    if (key === lastPreview.current.key || now - lastPreview.current.at < 100) return;
    lastPreview.current = { key, at: now };
    // Slope before pressing = its first dab: a level at the press height (A = B).
    const p = previewDab(t, dabOptions(op, c[0], c[2], 1, c[1]));
    if (!p) {
      preview.mesh.visible = false;
      ed.setBrushPreview(null);
      return;
    }
    const color = op === 'paint' ? new THREE.Color(groundMaterial(ed.paintType).color) : op === 'paintSoil' ? new THREE.Color(TOOL_COLORS.soil) : null;
    preview.show(p, t, color);
    ed.setBrushPreview({ up: p.up, down: p.down, area: p.area });
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    cursor.current = hitFrom(e);
  };
  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    const hit = hitFrom(e);
    cursor.current = hit;
    if (!hit) return;
    e.stopPropagation();
    if (tool === 'inspect') {
      useEditorStore.getState().setTerrainProbe({ x: hit[0], z: hit[2] });
      return;
    }
    if (!isBrushTool(tool)) return;
    const op = opOf(tool);
    useEditorStore.getState().setStrokeDelta(null);
    useWorldStore.getState().beginTerrainStroke();
    // Slope: the ramp starts at the press point; its far end follows the cursor (heights as they were when the stroke
    // started — the stroke's own snapshot, no second copy of the map).
    held.current = { op, target: hit[1], ax: hit[0], az: hit[2], start: op === 'slope' ? useWorldStore.getState().strokeHeights() : null, last: null };
    // Left-drag sculpts instead of orbiting (owned camera lock for the gesture's lifetime).
    gesture.current = beginGesture('terrain', {
      end: (commit) => {
        gesture.current = null;
        held.current = null;
        const world = useWorldStore.getState();
        if (commit) {
          useEditorStore.getState().setStrokeDelta(world.strokeDelta());
          world.endTerrainStroke();
        } else {
          useEditorStore.getState().setStrokeDelta(null);
          markTerrainDirty(world.cancelTerrainStroke());
        }
      },
    }, { lockCamera: true });
  };

  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-60} onPointerMove={onMove} onPointerDown={onDown} onPointerOut={() => (cursor.current = null)}>
        <planeGeometry args={[WORLD_SIZE * 30, WORLD_SIZE * 30]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <primitive object={ring} />
      <primitive object={level} />
      <primitive object={ramp} />
      <primitive object={preview.mesh} />
      {probe && <ProbeMarker x={probe.x} z={probe.z} />}
    </>
  );
}

function ProbeMarker({ x, z }: { x: number; z: number }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const y = samplerFor(terrain).sampleHeight(x, z);
  return (
    <group position={[x, y, z]} raycast={() => null}>
      <mesh position-y={1.2} renderOrder={11}>
        <cylinderGeometry args={[0.06, 0.06, 2.4, 6]} />
        <meshBasicMaterial color="#ffb067" depthTest={false} transparent />
      </mesh>
      <mesh position-y={2.5} renderOrder={11}>
        <sphereGeometry args={[0.22, 10, 8]} />
        <meshBasicMaterial color="#ffb067" depthTest={false} transparent />
      </mesh>
    </group>
  );
}

