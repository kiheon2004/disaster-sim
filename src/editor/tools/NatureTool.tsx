import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useT } from '@/i18n/i18n';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { centerlineOf, type Centerline } from '@/roads/curve';
import { featureLine } from '@/landscape/features';
import type { Feature, P2 } from '@/landscape/types';
import { useEditorStore } from '../editorStore';
import { useNatureStore } from '../natureStore';
import { beginForestStroke, commitForest, featureAt, finishNatureDraft, forestDab, moveFeaturePoint, placePeak } from '@/app/natureActions';
import { GroundCatcher, groundHitOf, useOrbitLock } from './shared';
import { PreviewLines } from './RoadTool';

const COLORS = { line: '#7fd37a', water: '#5fb4ff', sea: '#3d8bd6', sel: '#ffd166', forest: '#3fa34d', handle: '#ffd166' };
/** Tools drawn as a path (≥ 2 points) or a polygon (lake, ≥ 3). */
export const PATH_TOOLS = ['ridgeLine', 'valleyLine', 'canyon', 'river', 'coast', 'lake'] as const;

function offsets(line: Centerline, d: number): P2[] {
  return line.samples.map((p) => [p.x - p.tz * d, p.z + p.tx * d]);
}

/** Natural-feature tools in the viewport (Terrain Editing Mode, Phase 19). */
export function NatureTool() {
  const t = useT();
  const tool = useEditorStore((s) => s.terrainTool);
  const draft = useNatureStore((s) => s.draft);
  const params = useNatureStore((s) => s.params);
  const forest = useNatureStore((s) => s.forest);
  const selected = useNatureStore((s) => s.selected);
  const features = useWorldStore((s) => s.doc.landscape.features);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const sampler = samplerFor(terrain);
  const orbit = useOrbitLock();
  const lines = useMemo(() => new PreviewLines(), []);
  useEffect(() => () => lines.dispose(), [lines]);
  const [hover, setHover] = useState<P2 | null>(null);
  const [forestPts, setForestPts] = useState<P2[]>([]);
  const painting = useRef(false);
  const [drag, setDrag] = useState<{ id: string; index: number; x: number; z: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  useEffect(() => {
    const up = () => {
      if (painting.current) {
        painting.current = false;
        orbit.unlock();
        setForestPts((pts) => {
          commitForest(pts);
          return [];
        });
      }
      const d = dragRef.current;
      if (d) {
        setDrag(null);
        orbit.unlock();
        moveFeaturePoint(d.id, d.index, d.x, d.z);
      }
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [orbit]);

  const sel = features.find((f) => f.id === selected) ?? null;
  const isPath = (PATH_TOOLS as readonly string[]).includes(tool);

  // Preview lines: draft + hover, selected feature outline, forest stroke points.
  useEffect(() => {
    lines.clear();
    const pts: P2[] = [...draft];
    if (hover && isPath) pts.push(hover);
    if (isPath && pts.length >= 2) {
      const closed = tool === 'lake';
      const line = closed ? null : centerlineOf(pts);
      const color = tool === 'river' || tool === 'lake' ? COLORS.water : tool === 'coast' ? COLORS.sea : COLORS.line;
      if (closed) lines.line(pts, color, sampler, true);
      else if (line) {
        lines.line(line.samples.map((p) => [p.x, p.z] as P2), color, sampler);
        const half = tool === 'river' ? params.river.width / 2 : tool === 'ridgeLine' ? params.ridge.width / 2 : tool === 'valleyLine' ? params.valley.width / 2 : tool === 'canyon' ? params.canyon.width / 2 : 0;
        if (half > 0) {
          lines.line(offsets(line, half), color, sampler);
          lines.line(offsets(line, -half), color, sampler);
        }
        if (tool === 'coast') {
          // Sea side: a line offshore; beach band inland.
          lines.line(offsets(line, 12 * params.coast.seaSide), COLORS.sea, sampler);
          lines.line(offsets(line, -params.coast.beachWidth * params.coast.seaSide), '#e8d28a', sampler);
        }
      }
    }
    for (const p of draft) lines.ring(p[0], p[1], 0.8, COLORS.sel, sampler);
    if (hover && (tool === 'mountain' || tool === 'hill')) {
      lines.ring(hover[0], hover[1], params[tool].radius, COLORS.line, sampler);
      lines.ring(hover[0], hover[1], params[tool].radius * 0.35, COLORS.line, sampler);
    }
    if (hover && tool === 'forest') lines.ring(hover[0], hover[1], forest.radius, COLORS.forest, sampler);
    for (const p of forestPts) lines.ring(p[0], p[1], 0.5, COLORS.forest, sampler);
    if (sel) outline(lines, sel, sampler);
  }, [lines, draft, hover, tool, isPath, params, forest, forestPts, sel, sampler]);

  useFrame(() => {
    // Forest painting follows the cursor while the button is held.
    if (painting.current && hover) {
      const add = forestDab(hover[0], hover[1]);
      if (add.length) setForestPts((pts) => [...pts, ...add]);
    }
  });

  const hit = (e: ThreeEvent<PointerEvent | MouseEvent>): P2 | null => {
    const h = groundHitOf(e);
    return h && sampler.inside(h[0], h[2]) ? [h[0], h[2]] : null;
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const p = hit(e);
    setHover(p);
    if (p && drag) setDrag({ ...drag, x: p[0], z: p[1] });
  };
  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0 || tool !== 'forest') return;
    const p = hit(e);
    if (!p) return;
    e.stopPropagation();
    orbit.lock();
    painting.current = true;
    beginForestStroke();
    setForestPts(forestDab(p[0], p[1]));
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5 || drag) return;
    const p = hit(e);
    if (!p) return;
    const ns = useNatureStore.getState();
    if (tool === 'mountain' || tool === 'hill') placePeak(tool, p[0], p[1]);
    else if (isPath) {
      const last = ns.draft[ns.draft.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.5) ns.addPoint([Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    } else if (tool === 'feature') ns.select(featureAt(p[0], p[1])?.id ?? null);
  };
  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    if (!isPath) return;
    e.stopPropagation();
    finishNatureDraft(tool);
  };

  // Handles of the selected feature (edit tool): its points / center.
  const handles: { index: number; x: number; z: number }[] = !sel || tool !== 'feature' ? [] : 'points' in sel ? sel.points.map(([x, z], index) => ({ index, x, z })) : [{ index: 0, x: sel.x, z: sel.z }];

  return (
    <>
      <primitive object={lines.root} />
      <GroundCatcher onMove={onMove} onDown={onDown} onClick={onClick} onDoubleClick={onDoubleClick} onOut={() => setHover(null)} />
      {handles.map((h) => {
        const active = drag && drag.index === h.index;
        const x = active ? drag.x : h.x, z = active ? drag.z : h.z;
        return (
          <mesh key={h.index} position={[x, sampler.sampleHeight(x, z) + 0.8, z]} renderOrder={30}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button !== 0 || !sel) return;
              orbit.lock();
              setDrag({ id: sel.id, index: h.index, x: h.x, z: h.z });
            }}>
            <sphereGeometry args={[1, 16, 12]} />
            <meshBasicMaterial color={COLORS.handle} depthTest={false} transparent opacity={0.95} />
          </mesh>
        );
      })}
      {hover && isPath && draft.length > 0 && (
        <Html position={[hover[0], sampler.sampleHeight(hover[0], hover[1]) + 2.5, hover[1]]} center style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
          <div data-testid="nature-preview" style={{ background: 'rgba(20,24,32,0.85)', color: '#e8f5e9', padding: '4px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap' }}>
            {t('nature.preview.points', { n: draft.length + 1 })} · {t('nature.preview.finish')}
          </div>
        </Html>
      )}
    </>
  );
}

function outline(lines: PreviewLines, f: Feature, sampler: ReturnType<typeof samplerFor>) {
  const c = COLORS.sel;
  if (f.kind === 'mountain' || f.kind === 'hill') {
    lines.ring(f.x, f.z, f.radius, c, sampler);
    return;
  }
  if (f.kind === 'lake') {
    lines.line(f.points, c, sampler, true);
    return;
  }
  const line = featureLine(f as Exclude<Feature, { kind: 'mountain' | 'hill' | 'lake' }>);
  lines.line(line.samples.map((p) => [p.x, p.z] as P2), c, sampler);
  if ('width' in f) {
    lines.line(offsets(line, f.width / 2), c, sampler);
    lines.line(offsets(line, -f.width / 2), c, sampler);
  }
}
