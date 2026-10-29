/** Development-only handles for debugging from the browser console (window.__ds). */
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import * as buildActions from './buildActions';
import { getEditorBatches } from '@/rendering/editor/editorRenderStats';
import { translate, useLocaleStore, type MessageKey } from '@/i18n/i18n';
import * as actions from './actions';
import { useViewStore } from '@/rendering/viewStore';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useUiStore } from '@/ui/uiStore';
import { waterRenderStats } from '@/rendering/sim/water/WaterLayer';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { WaterField } from '@/simulation/water/WaterField';
import { captureWaterState } from '@/simulation/water/waterStateCodec';
import { samplerFor } from '@/terrain/TerrainSampler';
import { areaFill } from '@/editor/build/distribution';
import { DEFAULT_PLACEMENT, acceptedInputs, planPlacement } from '@/editor/build/placementPlan';
import { FootprintIndex } from '@/editor/build/footprint';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { stressScene } from '@/world/stressScene';
import { createEmptyDocument } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec, BUILDING_PRESETS } from '@/buildings/spec';
import { analyzeBuilding } from '@/buildings/analysis';
import { foundationContact } from '@/buildings/foundation';

export function installDevtools() {
  (window as unknown as Record<string, unknown>).__ds = {
    world: useWorldStore,
    editor: useEditorStore,
    build: useBuildStore,
    buildActions,
    editorBatches: getEditorBatches,
    /** Phase 16 benchmarks (scripts/bench-build.mjs). */
    buildLib: { areaFill, planPlacement, acceptedInputs, DEFAULT_PLACEMENT, FootprintIndex, parseDocument, serializeDocument, stressScene, createEmptyDocument, samplerFor },
    /** Phase 17 modular buildings (benchmarks / browser verification). */
    buildingLib: { createDesign, presetSpec, BUILDING_PRESETS, analyzeBuilding, foundationContact },
    locale: useLocaleStore,
    /** Translate a key in the current locale (browser verification finds buttons by label). */
    tr: (key: MessageKey) => translate(useLocaleStore.getState().locale, key),
    actions,
    view: useViewStore,
    sim: simulationController,
    simStore: useSimStore,
    ui: useUiStore,
    waterRenderStats,
    profiler: simProfiler,
    /** Benchmarks: the next run starts with `depth` m of still water on every open cell. */
    floodStart: (depth: number) => {
      const doc = useWorldStore.getState().doc;
      const f = new WaterField(samplerFor(doc.terrain), doc.settings.simulation.water);
      f.h.fill(depth);
      simulationController.setInitialWaterState(captureWaterState(f, 0));
    },
  };
}
