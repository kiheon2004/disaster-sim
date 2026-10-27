/** Development-only handles for debugging from the browser console (window.__ds). */
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useLocaleStore } from '@/i18n/i18n';
import * as actions from './actions';

export function installDevtools() {
  (window as unknown as Record<string, unknown>).__ds = {
    world: useWorldStore,
    editor: useEditorStore,
    locale: useLocaleStore,
    actions,
  };
}
