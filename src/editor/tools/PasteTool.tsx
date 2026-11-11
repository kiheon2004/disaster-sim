import { useMemo, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec2 } from '../build/distribution';
import { instantiateBlueprint } from '../build/blueprint';
import type { PlannedObject } from '../build/placementPlan';
import { useEditorStore } from '../editorStore';
import { gridStep, useBuildStore } from '../buildStore';
import { pasteAt } from '@/app/buildActions';
import { useWorldStore } from '@/world/worldStore';
import { pasteRoads } from '@/roads/blueprintRoads';
import { RoadOutlines } from './RoadTool';
import { GroundCatcher, PlanPreview, groundHitOf, useSampler } from './shared';
import { checkStamp } from '../build/placementCheck';
import { FootprintIndex } from '../build/footprint';

/**
 * Paste: the clipboard (a blueprint) follows the cursor as a ghost, anchored at the center of
 * its bounds; R / Shift+R turn it 90°; each click places a copy with new ids (one undo step).
 * Stays armed for repeated stamping until Esc.
 */
export function PasteTool() {
  const clipboard = useBuildStore((s) => s.clipboard);
  const yaw = useBuildStore((s) => s.pasteYaw);
  const grid = useBuildStore((s) => s.snapping.grid);
  const snap = useEditorStore((s) => s.snap);
  const sampler = useSampler();
  const [at, setAt] = useState<Vec2 | null>(null);
  const step = gridStep(grid, 3);

  const objects = useWorldStore((s) => s.doc.objects);
  const existing = useMemo(() => FootprintIndex.fromObjects(Object.values(objects)), [objects]);
  // Phase 36 §16: the stamp is checked like a placement — outside the world refused (red), overlaps warned (orange).
  const plan = useMemo((): PlannedObject[] => {
    if (!clipboard || !at) return [];
    const inputs = instantiateBlueprint(clipboard, at[0], at[1], yaw, sampler);
    const check = checkStamp(inputs, existing);
    return inputs.map((input, i) => ({ input, ok: check.items[i].ok, warnings: check.items[i].warnings }));
  }, [clipboard, at, yaw, sampler, existing]);

  const policy = useBuildStore((s) => s.roadPaste);
  const roads = useWorldStore((s) => s.doc.roads);
  // Pasted roads preview (Phase 18): outline of the network the click would create.
  const roadPreview = useMemo(() => {
    if (!clipboard?.roads || !at) return null;
    try {
      const r = pasteRoads(roads, clipboard.roads, at[0], at[1], yaw, policy, sampler.sampleHeight(at[0], at[1]));
      return { network: r.network, segments: r.segments.flat(), ok: true };
    } catch {
      return null;
    }
  }, [clipboard, at, yaw, policy, roads, sampler]);

  if (!clipboard) return null;
  const hit = (e: ThreeEvent<PointerEvent | MouseEvent>): Vec2 | null => {
    const p = groundHitOf(e);
    if (!p) return null;
    return snap ? [Math.round(p[0] / step) * step, Math.round(p[2] / step) * step] : [p[0], p[2]];
  };
  return (
    <>
      <GroundCatcher
        onMove={(e) => setAt(hit(e))}
        onOut={() => setAt(null)}
        onClick={(e) => {
          if (e.delta > 5) return;
          const p = hit(e);
          if (!p) return;
          e.stopPropagation();
          pasteAt(p[0], p[1]);
          // Keep stamping: the paste tool stays active (selection shows the last copy).
          useEditorStore.getState().setTool('paste');
        }}
      />
      <PlanPreview plan={plan} />
      {roadPreview && <RoadOutlines network={roadPreview.network} segments={roadPreview.segments} />}
    </>
  );
}
