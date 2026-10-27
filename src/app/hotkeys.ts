import { useEffect } from 'react';
import { useWorldStore } from '@/world/worldStore';
import { deleteSelected, duplicateSelected, focusObject } from '@/app/actions';
import { useEditorStore } from '@/editor/editorStore';

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Global editor shortcuts. Mounted once at the app root. */
export function useEditorHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const ed = useEditorStore.getState();
      const world = useWorldStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Camera focus works in every mode.
      if (key === 'f' && !mod && ed.selectedId) {
        focusObject(ed.selectedId);
        return;
      }

      if (ed.mode !== 'editor') return;

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
        duplicateSelected();
        return;
      }
      if (mod) return;

      switch (key) {
        case 'escape':
          if (ed.tool === 'place') ed.armPlacement(null);
          else ed.select(null);
          break;
        case 'delete':
        case 'backspace':
          deleteSelected();
          break;
        case 'w':
          ed.setTransformMode('translate');
          break;
        case 'e':
          ed.setTransformMode('rotate');
          break;
        case 'r':
          if (ed.tool === 'place') ed.rotateGhost(e.shiftKey ? -Math.PI / 2 : Math.PI / 2);
          else ed.setTransformMode('scale');
          break;
        case 'g':
          ed.toggleSnap();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
