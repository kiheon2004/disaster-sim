/** Development-only handles for debugging from the browser console (window.__ds). */
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useLocaleStore } from '@/i18n/i18n';
import * as actions from './actions';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';

export function installDevtools() {
  (window as unknown as Record<string, unknown>).__ds = {
    world: useWorldStore,
    editor: useEditorStore,
    locale: useLocaleStore,
    actions,
    sim: simulationController,
    simStore: useSimStore,
  };
}
