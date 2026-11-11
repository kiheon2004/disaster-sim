import { useEffect } from 'react';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { deleteInstance, disarmPlacement } from './placementActions';
import { useWorldStore } from '@/world/worldStore';
import { focusObject, focusSelection, togglePlay } from '@/app/actions';
import { clearSelection, copySelection, deleteSelection, duplicateSelection, groupSelection, selectAll, startPaste, ungroupSelection } from '@/app/buildActions';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { applyAreaSession } from '@/editor/tools/BulkTools';
import { useViewStore } from '@/rendering/viewStore';
import { degToRad } from '@/core/math';
import { useMemberStore } from '@/editor/memberStore';
import { deleteRoadSegments, finishDraft } from '@/app/roadActions';
import { useRoadStore, EMPTY_SELECTION } from '@/editor/roadStore';
import { useNatureStore } from '@/editor/natureStore';
import { deleteFeature, finishNatureDraft } from '@/app/natureActions';
import type { TerrainToolId } from '@/editor/editorStore';
import { deleteSelectedMembers, duplicateSelectedMembers, exitBuildingEdit, modularBuilding } from '@/app/buildingActions';
import { useBlueprintStore } from '@/editor/blueprintStore';
import { backToLibrary, pinPlacement, rotatePlacement } from '@/app/blueprintActions';
import { closePolygon } from '@/editor/tools/BlueprintTool';
import { activeGesture } from '@/editor/input/gesture';
import { isTyping, keyOf, opensCommandBar } from '@/editor/input/keys';
import { focusCommandBar } from '@/ui/Command/barStore';
import { escapeCommand } from './commandActions';

export { isTyping, keyOf };

/** Building Edit Mode keys. Returns true when the key was handled. */
function buildingKeys(e: KeyboardEvent, key: string, mod: boolean): boolean {
  const ms = useMemberStore.getState();
  if (mod && key === 'd') {
    e.preventDefault();
    duplicateSelectedMembers();
    return true;
  }
  if (mod && key === 'a') {
    if (hasTextSelection()) return false;
    e.preventDefault();
    const o = modularBuilding(useEditorStore.getState().buildingId);
    if (o) ms.select(o.building!.members.map((m) => m.id));
    return true;
  }
  if (mod) return false;
  switch (key) {
    case 'delete':
    case 'backspace':
      deleteSelectedMembers();
      return true;
    case 'escape':
      if (ms.adding) ms.setAdding(null);
      else if (ms.selected.length) ms.select([]);
      else exitBuildingEdit();
      return true;
    case 'w':
      ms.setGizmo('translate');
      return true;
    case 'e':
      ms.setGizmo('rotate');
      return true;
    case 'r':
      ms.rotateAdd();
      return true;
    case 'x':
      ms.setXray(!ms.xray);
      return true;
    case 'h':
      ms.setLoadPath(!ms.loadPath);
      return true;
  }
  return false;
}

/** A modal dialog (help, results, comparison, blueprint dialogs) owns the keyboard while open. */
function modalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/** Text selected on the page: Ctrl+C / Ctrl+A keep their browser meaning then. */
function hasTextSelection() {
  const s = typeof window !== 'undefined' ? window.getSelection() : null;
  return !!s && !s.isCollapsed && s.toString().length > 0;
}

/** Road Editing Mode keys (Phase 18). Returns true when the key was handled. */
function roadKeys(e: KeyboardEvent, key: string): boolean {
  const rs = useRoadStore.getState();
  switch (key) {
    case 'enter':
      if (rs.draft.length >= 2) {
        e.preventDefault();
        finishDraft();
        return true;
      }
      return false;
    case 'escape':
      if (rs.hood) rs.setHood(null);
      else if (rs.draft.length) rs.clearDraft();
      else if (rs.selection.segments.length || rs.selection.node) rs.select(EMPTY_SELECTION);
      else if (rs.block) rs.setBlock(null);
      else useEditorStore.getState().setRoadEdit(false);
      return true;
    case 'backspace':
      if (rs.draft.length) {
        e.preventDefault();
        rs.popPoint();
        return true;
      }
      if (rs.mode === 'edit' && rs.selection.segments.length) {
        deleteRoadSegments(rs.selection.segments);
        return true;
      }
      return false;
    case 'delete':
      if (rs.mode === 'edit' && rs.selection.segments.length) {
        deleteRoadSegments(rs.selection.segments);
        return true;
      }
      return false;
  }
  return false;
}

/** Natural-feature tool keys (Phase 19). Returns true when the key was handled. */
function natureKeys(e: KeyboardEvent, key: string, tool: TerrainToolId): boolean {
  const ns = useNatureStore.getState();
  switch (key) {
    case 'enter':
      if (ns.draft.length) {
        e.preventDefault();
        finishNatureDraft(tool);
        return true;
      }
      return false;
    case 'backspace':
      if (ns.draft.length) {
        e.preventDefault();
        ns.popPoint();
        return true;
      }
      return false;
    case 'escape':
      if (ns.draft.length) { ns.clearDraft(); return true; }
      if (ns.selected) { ns.select(null); return true; }
      return false;
    case 'delete':
      if (tool === 'feature' && ns.selected) {
        deleteFeature(ns.selected);
        return true;
      }
      return false;
  }
  return false;
}

/** Blueprint Mode keys (Phase 20): capture polygon editing, placement turning / unpinning. */
function blueprintKeys(e: KeyboardEvent, key: string): boolean {
  const bs = useBlueprintStore.getState();
  const step = degToRad(useBuildStore.getState().snapping.rotationStep);
  if (bs.mode === 'capture') {
    const c = bs.capture;
    switch (key) {
      case 'enter':
        if (c.kind === 'polygon' && c.draft.length >= 3) { e.preventDefault(); closePolygon(); return true; }
        return false;
      case 'backspace':
        if (c.kind === 'polygon' && c.draft.length) { e.preventDefault(); bs.setCapture({ draft: c.draft.slice(0, -1) }); return true; }
        return false;
      case 'escape':
        if (c.draft.length) bs.setCapture({ draft: [] });
        else backToLibrary();
        return true;
    }
    return false;
  }
  if (bs.mode === 'place') {
    switch (key) {
      case 'r':
        rotatePlacement(e.shiftKey ? -Math.PI / 2 : Math.PI / 2);
        return true;
      case 't':
        rotatePlacement(e.shiftKey ? -step : step);
        return true;
      case 'escape':
        if (bs.place.pinned) pinPlacement(null);
        else backToLibrary();
        return true;
      case 'enter':
        return true; // (confirmed by the placement tool itself)
    }
  }
  return false;
}

/**
 * Disaster placement keys (Phase 35.5), before every other shortcut:
 *  - Esc: leave placement mode, otherwise deselect the selected disaster pin;
 *  - Delete / Backspace: remove the selected disaster (cancel / stop it when it is in the run);
 *  (Undo / redo: one world history for geometry and placements since Phase 36 — no tab-dependent routing.)
 */
function placementKeys(e: KeyboardEvent, key: string, mod: boolean): boolean {
  const st = usePlacementStore.getState();
  if (key === 'escape') {
    if (st.type) { e.preventDefault(); disarmPlacement(); return true; }
    if (st.selected) { st.select(null); return true; }
    return false;
  }
  if ((key === 'delete' || key === 'backspace') && !mod && st.selected && !st.type) {
    e.preventDefault();
    deleteInstance(st.selected);
    return true;
  }
  // (Ctrl/⌘+Z: Phase 36 — placements are steps of the world history; the editor's undo below handles them.)
  return false;
}

/** Tool keys (Phase 16). Chosen not to collide with W/E/R/F/G/T, Space, [ ], Shift+P. */
const TOOL_KEYS: Record<string, 'select' | 'place' | 'brush' | 'line' | 'area'> = { v: 'select', p: 'place', b: 'brush', l: 'line', a: 'area' };

/**
 * Global editor shortcuts. Mounted once at the app root. Browser shortcuts are only taken over
 * (preventDefault) when the key is ours and the user is not typing in a field: Ctrl+C / Ctrl+A
 * stay the browser's while text is selected; Ctrl+D / Ctrl+G / Ctrl+V are always ours in the
 * viewport (bookmark / find-next / paste have no use there).
 */
export function useEditorHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.isComposing) return;
      // Phase 36: no shortcut acts behind a modal dialog, and none during a drag (Delete / Ctrl+Z /
      // tool keys used to unmount a gizmo mid-drag; Esc of a drag is handled by the gesture itself).
      if (modalOpen() || activeGesture()) return;
      const ed = useEditorStore.getState();
      const world = useWorldStore.getState();
      const build = useBuildStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = keyOf(e);

      // Phase 37: the command bar, in both modes (so before the simulation branch below, which returns early).
      // `/` or Ctrl / ⌘ + K puts the keyboard in the bar; the key itself is not typed into it.
      if (opensCommandBar(e)) {
        e.preventDefault();
        focusCommandBar();
        return;
      }
      // Esc: a plan opened with Enter (or an open question) is cancelled first, also when the viewport has the keyboard —
      // before a disaster placement is disarmed or anything is deselected.
      if (key === 'escape' && escapeCommand()) return;

      // Phase 35.5: disaster placement keys come first, in both modes.
      if (placementKeys(e, key, mod)) return;

      // Developer performance HUD (every mode).
      if (key === 'p' && e.shiftKey && !mod) {
        useViewStore.getState().togglePerfHud();
        return;
      }

      // Camera focus works in every mode.
      if (key === 'f' && !mod && ed.selectedId) {
        if (ed.selectedIds.length > 1) focusSelection();
        else focusObject(ed.selectedId);
        return;
      }

      if (ed.mode === 'simulation') {
        if (e.code === 'Space') {
          e.preventDefault();
          togglePlay();
        } else if (key === 'escape') ed.select(null);
        else if (mod && key === 'c' && !hasTextSelection() && copySelection()) e.preventDefault();
        return;
      }

      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) world.redo();
        else world.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        world.redo();
        return;
      }
      // Building Edit Mode (Phase 17): member shortcuts.
      if (ed.tool === 'building' && buildingKeys(e, key, mod)) return;
      if (mod && key === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && key === 'c') {
        if (hasTextSelection()) return;
        if (copySelection()) e.preventDefault();
        return;
      }
      if (mod && key === 'v') {
        e.preventDefault();
        startPaste();
        return;
      }
      if (mod && key === 'a') {
        if (hasTextSelection()) return;
        e.preventDefault();
        selectAll();
        if (ed.tool !== 'select') ed.setTool('select');
        return;
      }
      if (mod && key === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (mod) return;

      const brushTool = ed.tool === 'terrain' || ed.tool === 'brush' || (ed.tool === 'area' && build.area.shape === 'brush');
      if (brushTool && (key === '[' || key === ']')) {
        const d = (key === ']' ? 1 : -1) * (e.shiftKey ? 5 : 1);
        if (ed.tool === 'terrain') ed.setBrush({ radius: ed.brushRadius + d });
        else build.setBrushSettings({ radius: build.brush.radius + d });
        return;
      }

      // Natural features (Phase 19): drawing / selection keys of the terrain feature tools.
      if (ed.tool === 'terrain' && natureKeys(e, key, ed.terrainTool)) return;
      // Road Editing Mode (Phase 18): draft / selection keys.
      if (ed.tool === 'road' && roadKeys(e, key)) return;
      // Blueprint Mode (Phase 20).
      if (ed.tool === 'blueprint' && blueprintKeys(e, key)) return;
      if (ed.tool !== 'terrain' && ed.tool !== 'road' && ed.tool !== 'blueprint' && TOOL_KEYS[key] && !e.altKey) {
        ed.setTool(TOOL_KEYS[key]);
        return;
      }

      switch (key) {
        case 'escape':
          if (ed.tool === 'terrain') ed.setTerrainTool(null);
          else if (ed.tool === 'line' && build.lineSession.points.length) build.setLineSession({ points: [] });
          else if (ed.tool === 'area' && build.areaSession.shape) build.setAreaSession({ shape: null, dragging: false });
          else if (ed.tool === 'place' || ed.tool === 'brush' || ed.tool === 'line' || ed.tool === 'area') ed.armPlacement(null);
          else if (ed.tool === 'paste') ed.setTool('select');
          else clearSelection();
          break;
        case 'enter':
          if (ed.tool === 'area' && build.areaSession.shape && !build.areaSession.dragging) {
            e.preventDefault();
            applyAreaSession();
          }
          break;
        case 'delete':
        case 'backspace':
          // (Backspace in the line tool removes its last point — handled by the tool.)
          if (ed.tool === 'select') deleteSelection();
          break;
        case 'w':
          ed.setTransformMode('translate');
          break;
        // Phase 36 §11: Q = move in world / object (local) axes; X / Y / Z = lock the gizmo to that axis (again = unlock).
        case 'q':
          if (ed.tool === 'select') ed.setTransformSpace(ed.transformSpace === 'world' ? 'local' : 'world');
          break;
        case 'x':
        case 'y':
        case 'z':
          if (ed.tool === 'select' && ed.selectedIds.length) ed.setAxisLock(ed.axisLock === key ? null : (key as 'x' | 'y' | 'z'));
          break;
        case 'e':
          ed.setTransformMode('rotate');
          break;
        case 'r':
          if (ed.tool === 'paste') build.rotatePaste(e.shiftKey ? -Math.PI / 2 : Math.PI / 2);
          else if (ed.tool === 'place' || ed.tool === 'line') ed.rotateGhost(e.shiftKey ? -Math.PI / 2 : Math.PI / 2);
          else if (ed.tool === 'select') ed.setTransformMode('scale');
          break;
        case 't': {
          // Fine rotation by the rotation-snap step.
          const step = degToRad(build.snapping.rotationStep) * (e.shiftKey ? -1 : 1);
          if (ed.tool === 'paste') build.rotatePaste(step);
          else if (ed.tool === 'place' || ed.tool === 'line') ed.rotateGhost(step);
          break;
        }
        case 'g':
          ed.toggleSnap();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
