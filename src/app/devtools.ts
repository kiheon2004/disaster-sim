/** Development-only handles for debugging from the browser console (window.__ds). */
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useLocaleStore } from '@/i18n/i18n';
import * as actions from './actions';
import { useViewStore } from '@/rendering/viewStore';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { waterRenderStats } from '@/rendering/sim/water/WaterLayer';
import { simProfiler } from '@/simulation/profiling/SimProfiler';

export function installDevtools() {
  (window as unknown as Record<string, unknown>).__ds = {
    world: useWorldStore,
    editor: useEditorStore,
    locale: useLocaleStore,
    actions,
    view: useViewStore,
    sim: simulationController,
    simStore: useSimStore,
    waterRenderStats,
    profiler: simProfiler,
  };
}
