import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { WORLD_SIZE } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import type { TerrainBrushOp } from '@/terrain/TerrainEditor';
import { markTerrainDirty } from '@/rendering/terrain/terrainDirty';
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

/** Bilinear height from a copied height array (the terrain at the start of a slope stroke). */
function heightIn(h: Float32Array, t: { nx: number; nz: number; cellSize: number; originX: number; originZ: number }, x: number, z: number): number {
  const fx = Math.min(t.nx - 1.000001, Math.max(0, (x - t.originX) / t.cellSize));
  const fz = Math.min(t.nz - 1.000001, Math.max(0, (z - t.originZ) / t.cellSize));
  const ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz, i = iz * t.nx + ix;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + t.nx] * (1 - ax) + h[i + t.nx + 1] * ax) * az;
}

/**
 * Terrain Editing Mode in the viewport: a draped brush ring follows the cursor; holding the left
 * button applies the active tool every frame (one undo step per stroke). Pointer hits come from
 * the terrain data (TerrainSampler.raycast), not from mesh raycasting.
 */
export function TerrainTool() {
  const tool = useEditorStore((s) => s.terrainTool);
  const probe = useEditorStore((s) => s.terrainProbe);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const cursor = useRef<Vec3 | null>(null);
  const held = useRef<{ op: TerrainBrushOp; target: number; ax: number; az: number; start: Float32Array | null } | null>(null);
  const lastDelta = useRef(0);
  const ring = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 3), 3));
    const m = new THREE.LineBasicMaterial({ color: TOOL_COLORS[tool], depthTest: false, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(g, m);
    line.renderOrder = 10;
    line.frustumCulled = false;
    line.visible = false;
    return line;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  (ring.material as THREE.LineBasicMaterial).color.set(TOOL_COLORS[tool]);

  const hitFrom = (e: ThreeEvent<PointerEvent | MouseEvent>): Vec3 | null => {
    const sampler = samplerFor(useWorldStore.getState().doc.terrain);
    const o = e.ray.origin;
    const d = e.ray.direction;
    const out: Vec3 = [0, 0, 0];
    if (!sampler.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, out)) return null;
    return sampler.inside(out[0], out[2]) ? out : null;
  };

  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  useEffect(() => {
    const endStroke = () => {
      if (!held.current) return;
      held.current = null;
      useEditorStore.getState().setStrokeDelta(useWorldStore.getState().strokeDelta());
      useWorldStore.getState().endTerrainStroke();
      if (controlsRef.current) controlsRef.current.enabled = true;
    };
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('blur', endStroke);
    return () => {
      window.removeEventListener('pointerup', endStroke);
      window.removeEventListener('blur', endStroke);
      endStroke();
    };
  }, []);

  useEffect(() => () => {
    ring.geometry.dispose();
    (ring.material as THREE.Material).dispose();
  }, [ring]);

  useFrame((_, dt) => {
    const c = cursor.current;
    const ed = useEditorStore.getState();
    const world = useWorldStore.getState();
    const sampler = samplerFor(world.doc.terrain);
    // Apply the brush while held (dt capped so a stalled frame does not make a crater).
    if (held.current && c) {
      const hc = held.current;
      const t = world.doc.terrain;
      const rect = world.terrainDab({
        op: hc.op,
        x: c[0],
        z: c[2],
        brush: { radius: ed.brushRadius, strength: ed.brushStrength },
        dt: Math.min(dt, 1 / 20),
        targetHeight: hc.target,
        groundType: ed.paintType,
        soilType: ed.soilType,
        falloff: ed.brushFalloff,
        shape: ed.brushShape,
        seed: ed.brushSeed,
        minHeight: ed.brushMin,
        maxHeight: ed.brushMax,
        slope: hc.start ? { ax: hc.ax, az: hc.az, ah: hc.target, bx: c[0], bz: c[2], bh: heightIn(hc.start, t, c[0], c[2]) } : undefined,
      });
      markTerrainDirty(rect);
      // Live height change of this stroke (throttled to ~6 Hz for the panel).
      const now = performance.now();
      if (now - lastDelta.current > 160) {
        lastDelta.current = now;
        ed.setStrokeDelta(world.strokeDelta());
      }
    }
    ring.visible = !!c;
    if (!c) return;
    const r = tool === 'inspect' ? 0.6 : ed.brushRadius;
    const pos = ring.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      const x = c[0] + Math.cos(a) * r;
      const z = c[2] + Math.sin(a) * r;
      pos.setXYZ(i, x, sampler.sampleHeight(x, z) + 0.08, z);
    }
    pos.needsUpdate = true;
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
    if (controls) controls.enabled = false; // left-drag sculpts instead of orbiting
    const op = (tool === 'soil' ? 'paintSoil' : tool) as TerrainBrushOp;
    // Slope: the ramp starts at the press point; its far end follows the cursor (heights as
    // they were when the stroke started).
    held.current = { op, target: hit[1], ax: hit[0], az: hit[2], start: op === 'slope' ? useWorldStore.getState().doc.terrain.heights.slice() : null };
    useEditorStore.getState().setStrokeDelta(null);
    useWorldStore.getState().beginTerrainStroke();
  };

  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-60} onPointerMove={onMove} onPointerDown={onDown} onPointerOut={() => (cursor.current = null)}>
        <planeGeometry args={[WORLD_SIZE * 30, WORLD_SIZE * 30]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <primitive object={ring} />
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
