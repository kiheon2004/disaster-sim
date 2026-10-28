import { useMemo, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec2 } from '../build/distribution';
import { instantiateBlueprint } from '../build/blueprint';
import type { PlannedObject } from '../build/placementPlan';
import { useEditorStore } from '../editorStore';
import { gridStep, useBuildStore } from '../buildStore';
import { pasteAt } from '@/app/buildActions';
import { GroundCatcher, PlanPreview, groundHitOf, useSampler } from './shared';

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

  const plan = useMemo((): PlannedObject[] => {
    if (!clipboard || !at) return [];
    return instantiateBlueprint(clipboard, at[0], at[1], yaw, sampler).map((input) => ({ input, ok: true, warnings: [] }));
  }, [clipboard, at, yaw, sampler]);

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
    </>
  );
}
