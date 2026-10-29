/** Development-only handles for debugging from the browser console (window.__ds). */
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import * as buildActions from './buildActions';
import * as buildingActions from './buildingActions';
import { deriveFields, withDesign } from '@/buildings/design';
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
import * as roadActions from './roadActions';
import * as natureActions from './natureActions';
import { useNatureStore } from '@/editor/natureStore';
import * as landscapeLib from '@/landscape/compose';
import { buildEnvironment } from '@/landscape/presets';
import { initialWater } from '@/landscape/hydrology';
import { useRoadStore } from '@/editor/roadStore';
import { getRoadBatches } from '@/rendering/roads/RoadLayer';
import { roadStats } from '@/roads/stats';
import * as roadNetwork from '@/roads/network';
import * as roadCity from '@/roads/city';
import { blocksOf } from '@/roads/blocks';
import { intersectionsOf } from '@/roads/intersections';
import { emptyNetwork, defaultProfile, PROFILE_PRESETS } from '@/roads/types';
import * as blueprintActions from './blueprintActions';
import { useBlueprintStore } from '@/editor/blueprintStore';
import { useLibraryStore } from '@/blueprints/library';
import { captureBlueprint } from '@/blueprints/capture';
import { planPlacement as planBlueprint, defaultPlacement } from '@/blueprints/place';
import { parseBlueprintText, serializeBlueprint } from '@/blueprints/schema';
import { buildBuiltinBlueprint } from '@/blueprints/builtin';
import { buildTemplate } from '@/templates/builtin';
import { createTemplate, serializeTemplate, parseTemplate } from '@/templates/template';
import { worldFingerprint } from '@/world/fingerprint';
import { terrainStats } from '@/terrain/terrainStats';
import { validateDeformation } from '@/deformation/field';
import { phenomena } from '@/phenomena/registry';
import { currentDeformation } from '@/rendering/terrain/runtimeGround';

export function installDevtools() {
  (window as unknown as Record<string, unknown>).__ds = {
    world: useWorldStore,
    editor: useEditorStore,
    build: useBuildStore,
    buildActions,
    buildingActions,
    editorBatches: getEditorBatches,
    /** Phase 16 benchmarks (scripts/bench-build.mjs). */
    buildLib: { areaFill, planPlacement, acceptedInputs, DEFAULT_PLACEMENT, FootprintIndex, parseDocument, serializeDocument, stressScene, createEmptyDocument, samplerFor },
    /** Phase 17 modular buildings (benchmarks / browser verification). */
    buildingLib: { createDesign, presetSpec, BUILDING_PRESETS, analyzeBuilding, foundationContact, deriveFields, withDesign },
    /** Phase 18 roads (benchmarks / browser verification). */
    roadActions,
    /** Phase 19 nature (benchmarks / browser verification). */
    natureActions,
    nature: useNatureStore,
    landscapeLib: { ...landscapeLib, buildEnvironment, initialWater },
    roads: useRoadStore,
    roadBatches: getRoadBatches,
    roadStats,
    roadLib: { ...roadNetwork, ...roadCity, blocksOf, intersectionsOf, emptyNetwork, defaultProfile, PROFILE_PRESETS },
    /** Phase 20 blueprints / templates (benchmarks / browser verification). */
    blueprintActions,
    blueprints: useBlueprintStore,
    library: useLibraryStore,
    blueprintLib: { captureBlueprint, planPlacement: planBlueprint, defaultPlacement, parseBlueprintText, serializeBlueprint, buildBuiltinBlueprint, buildTemplate, createTemplate, serializeTemplate, parseTemplate, worldFingerprint },
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
    /** Phase 21 terrain deformation (benchmarks / browser verification). */
    deformLib: { terrainStats, getRoadBatches, validateDeformation, currentDeformation, phenomena },
    /** Benchmarks: the next run starts with `depth` m of still water on every open cell. */
    floodStart: (depth: number) => {
      const doc = useWorldStore.getState().doc;
      const f = new WaterField(samplerFor(doc.terrain), doc.settings.simulation.water);
      f.h.fill(depth);
      simulationController.setInitialWaterState(captureWaterState(f, 0));
    },
  };
}
