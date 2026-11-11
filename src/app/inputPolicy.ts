/**
 * Input ownership policy (Phase 36): ONE owner of the viewport's left button at a time, and one
 * selection that keyboard commands (Delete, Esc, Ctrl+Z …) act on.
 *
 *  - Arming disaster placement, or selecting a disaster pin, leaves the active editor tool (road,
 *    terrain, building edit, blueprint, placement …) and clears the object selection.
 *  - Arming any editor tool other than Select disarms disaster placement and drops the pin selection.
 *  - Selecting objects drops the pin selection (before, a pin selected earlier kept capturing Delete:
 *    "select a pin, select a building, press Delete" deleted the disaster).
 *  - Closing the right panel disarms disaster placement (its bar lives there; before, placement
 *    stayed armed with no visible bar).
 *  - Switching editor ⇄ simulation or replacing the document ends every gesture (cancelled) and
 *    every camera lock, and clears the drag flag (nothing survives a mode switch half-done).
 *  - Selected ids that no longer exist (undo of an add, delete) are pruned (before, undoing a
 *    multi-object add left a phantom group gizmo at the origin).
 *
 * Installed once from the app bootstrap. Pure store subscriptions: no React, no DOM.
 */
import { useEditorStore } from '@/editor/editorStore';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { useUiStore } from '@/ui/uiStore';
import { useWorldStore } from '@/world/worldStore';
import { abortGestures } from '@/editor/input/gesture';
import { releaseAllCameraLocks } from '@/editor/input/cameraLock';
import { exitBuildingEdit } from './buildingActions';
import { backToLibrary } from './blueprintActions';
import { useCommandSession } from '@/ui/Command/commandSession';

/** Leave the active editor tool the way its own Esc / Done would (sessions and modes cleaned up). */
export function exitEditorTool(): void {
  const ed = useEditorStore.getState();
  switch (ed.tool) {
    case 'select':
      return;
    case 'building':
      exitBuildingEdit();
      return;
    case 'road':
      ed.setRoadEdit(false);
      return;
    case 'terrain':
      ed.setTerrainTool(null);
      return;
    case 'blueprint':
      backToLibrary();
      return;
    case 'place':
    case 'brush':
    case 'line':
    case 'area':
      ed.armPlacement(null);
      return;
    case 'paste':
      ed.setTool('select');
      return;
  }
}

let installed: (() => void) | null = null;

export function installInputPolicy(): () => void {
  if (installed) return installed;
  const unsubs: (() => void)[] = [];

  unsubs.push(usePlacementStore.subscribe((s, p) => {
    const armed = s.type !== null && p.type === null;
    const picked = s.selected !== null && s.selected !== p.selected;
    // Phase 37: arming a disaster placement drops an open command plan (its ghosts) — one preview owner at a time.
    if (armed) useCommandSession.getState().cancelPlan();
    if (!armed && !picked) return;
    if (useEditorStore.getState().mode !== 'editor') return;
    exitEditorTool();
    if (useEditorStore.getState().selectedIds.length) useEditorStore.getState().select(null);
  }));

  unsubs.push(useEditorStore.subscribe((s, p) => {
    if (s.mode !== p.mode) {
      abortGestures('abort');
      releaseAllCameraLocks();
      if (s.dragging) useEditorStore.getState().setDragging(false);
      // Phase 37: an open command plan was made for the other mode's document state.
      useCommandSession.getState().cancelPlan();
      return;
    }
    if (s.tool !== p.tool) {
      abortGestures('abort');
      if (s.tool !== 'select') {
        // Phase 37: arming an edit tool drops an open command plan (the tool's own ghost takes the viewport).
        useCommandSession.getState().cancelPlan();
        const pl = usePlacementStore.getState();
        if (pl.type) pl.disarm();
        if (pl.selected) pl.select(null);
      }
    }
    if (s.selectedIds !== p.selectedIds && s.selectedIds.length > 0) {
      const pl = usePlacementStore.getState();
      if (pl.selected) pl.select(null);
    }
  }));

  unsubs.push(useUiStore.subscribe((s, p) => {
    if (p.rightOpen && !s.rightOpen && usePlacementStore.getState().type) usePlacementStore.getState().disarm();
  }));

  unsubs.push(useWorldStore.subscribe((s, p) => {
    if (s.docVersion !== p.docVersion) {
      abortGestures('abort');
      releaseAllCameraLocks();
      // Phase 37: a plan made on the document that was replaced.
      useCommandSession.getState().cancelPlan();
    }
    if (s.doc.objects !== p.doc.objects) {
      const ed = useEditorStore.getState();
      if (ed.mode !== 'editor' || ed.selectedIds.length === 0) return;
      const objects = s.doc.objects;
      const kept = ed.selectedIds.filter((id) => objects[id]);
      if (kept.length !== ed.selectedIds.length) ed.setSelection(kept, ed.selectedId ?? undefined);
    }
  }));

  installed = () => {
    for (const u of unsubs) u();
    installed = null;
  };
  return installed;
}
