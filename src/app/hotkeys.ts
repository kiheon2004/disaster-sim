import { useEffect } from 'react';
import { useWorldStore } from '@/world/worldStore';
import { focusObject, togglePlay } from '@/app/actions';
import { clearSelection, copySelection, deleteSelection, duplicateSelection, groupSelection, selectAll, startPaste, ungroupSelection } from '@/app/buildActions';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { applyAreaSession } from '@/editor/tools/BulkTools';
import { useViewStore } from '@/rendering/viewStore';
import { degToRad } from '@/core/math';

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Text selected on the page: Ctrl+C / Ctrl+A keep their browser meaning then. */
function hasTextSelection() {
  const s = typeof window !== 'undefined' ? window.getSelection() : null;
  return !!s && !s.isCollapsed && s.toString().length > 0;
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
      if (isTyping(e)) return;
      const ed = useEditorStore.getState();
      const world = useWorldStore.getState();
      const build = useBuildStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Developer performance HUD (every mode).
      if (key === 'p' && e.shiftKey && !mod) {
        useViewStore.getState().togglePerfHud();
        return;
      }

      // Camera focus works in every mode.
      if (key === 'f' && !mod && ed.selectedId) {
        focusObject(ed.selectedId);
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

      if (ed.tool !== 'terrain' && TOOL_KEYS[key] && !e.altKey) {
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
