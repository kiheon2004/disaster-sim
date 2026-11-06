/** Development-only handles for debugging from the browser console (window.__ds). */
import { CELESTIAL_SCENARIOS, type CelestialScenario, type CelestialSpec } from '@/celestial/types';
import { presetSpec as celestialPresetSpec } from '@/celestial/presets';
import { celestialDemo } from '@/celestial/demos';
import { celestialOutlook } from '@/celestial/outlook';
import { celestialCsv } from '@/ui/Results/CelestialResults';
import { HUMAN_PRESETS, humanPreset, type HumanPresetId } from '@/human/presets';
import { aggregateHumans, humanCsv, humanEntities, humanJson, humanRow } from '@/simulation/human/summary';
import { PHYSIO_PRESETS, physioPreset, type PhysioPresetId } from '@/physiology/presets';
import { aggregatePhysio, physioCsv, physioEntities, physioJson, physioRow } from '@/simulation/physiology/summary';
import { createInstance } from '@/phenomena/schedule';
import type { PhenomenonInstance } from '@/phenomena/types';
import { parseCommands } from '@/commands/RuleBasedParser';
import { CLIMATE_PRESETS } from '@/climate/presets';
import { GRAVITY_SCENARIOS, type GravityScenario, type GravitySpec } from '@/gravity/types';
import { presetSpec as gravityPresetSpec } from '@/gravity/presets';
import { gravityOutlook } from '@/gravity/outlook';
import { climateOutlook } from '@/climate/outlook';
import type { ClimateSpec } from '@/climate/types';
import { ATMOS_PRESETS } from '@/atmosphere/presets';
import { atmosphereOutlook } from '@/atmosphere/outlook';
import type { AtmosphereSpec } from '@/atmosphere/types';
import { FIRE_PRESETS } from '@/fire/presets';
import { VOLCANO_PRESETS } from '@/volcano/presets';
import { volcanoOutlook } from '@/volcano/outlook';
import type { VolcanoSpec } from '@/volcano/types';
import { fireOutlook } from '@/fire/outlook';
import { defaultFireSettings, type FireSpec } from '@/fire/types';
import * as THREE from 'three';
import { useWorldStore } from '@/world/worldStore';
import { landslideOutlook, sinkholeOutlook } from '@/phenomena/groundDefinitions';
import { planImpact } from '@/impact/plan';
import type { ImpactSpec } from '@/impact/types';
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
import { planBlast } from '@/blast/plan';
import { previewField } from '@/rendering/blast/BlastPreview';
import type { BlastSpec } from '@/blast/types';
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
import { warmUpMs as rapierWarmUpMs, rapierWorlds } from '@/physics/RapierEngine';
import { currentDeformation } from '@/rendering/terrain/runtimeGround';
import { useMemberStore } from '@/editor/memberStore';
import { removalPreview } from '@/structure/preview';
import { graphOf } from '@/structure/graph';
import { qRotate } from '@/core/math';
import type { HeatSourceSpec } from '@/thermal/types';
import { thermalOutlook } from '@/rendering/thermal/ThermalPreview';

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
    deformLib: { terrainStats, getRoadBatches, validateDeformation, currentDeformation, phenomena, rapierWarmUpMs: () => rapierWarmUpMs, rapierWorlds },
    /**
     * GPU-resource tracking (Phase 23 stress test): every geometry the renderer uploads registers a
     * 'dispose' listener; record it with its creation stack until it is disposed.
     */
    trackGeometries: () => {
      const live = new Map<THREE.BufferGeometry, string>();
      const proto = THREE.BufferGeometry.prototype as unknown as { addEventListener: (t: string, l: unknown) => void; __tracked?: boolean };
      if (!proto.__tracked) {
        proto.__tracked = true;
        const add = proto.addEventListener;
        proto.addEventListener = function (this: THREE.BufferGeometry, t: string, l: unknown) {
          if (t === 'dispose' && !live.has(this)) {
            live.set(this, (new Error().stack ?? '').split('\n').slice(2, 14).join(' | '));
            const g = this;
            add.call(this, 'dispose', () => live.delete(g));
          }
          return add.call(this, t, l);
        };
      }
      return () => [...live.entries()].map(([g, stack]) => ({ type: g.type, name: g.name, vertices: g.attributes.position?.count ?? 0, attrs: Object.keys(g.attributes).join(','), stack }));
    },
    /** Phase 25 structural destruction (browser verification). */
    members: useMemberStore,
    structureLib: {
      removalPreview, graphOf,
      /** World centre of a member of a building in the running simulation (fallen members displaced). */
      memberWorld: (id: string, i: number) => {
        const e = simulationController.getRuntime()?.entities.get(id);
        const mr = e?.modular;
        if (!e || !mr) return null;
        const g = mr.structure?.model.g ?? graphOf(mr.design, mr.scale);
        const m = mr.structure?.model;
        const o = 6 * i;
        const local: [number, number, number] = [(g.box[o] + g.box[o + 3]) / 2 + (m?.dx[i] ?? 0), (g.box[o + 1] + g.box[o + 4]) / 2 + (m?.dy[i] ?? 0), (g.box[o + 2] + g.box[o + 5]) / 2 + (m?.dz[i] ?? 0)];
        const p = qRotate(e.pose.quaternion, local);
        return [e.pose.position[0] + p[0], e.pose.position[1] + p[1], e.pose.position[2] + p[2]];
      },
    },
    /** Phase 22 ground failure (benchmarks / browser verification). */
    groundLib: {
      sinkholeOutlook, landslideOutlook,
      /** Phase 23: the impact plan of a spec on the document terrain (same function as the run). */
      impactPlan: (spec: ImpactSpec) => { const d = useWorldStore.getState().doc; return planImpact(spec, d.terrain, spec.seed ?? d.settings.simulation.seed); },
      blastPlan: (spec: BlastSpec) => { const d = useWorldStore.getState().doc; return planBlast(spec, d.terrain, d.settings.airDensity); },
      blastField: (spec: BlastSpec) => { const d = useWorldStore.getState().doc; return previewField(planBlast(spec, d.terrain, d.settings.airDensity), d.terrain, d.objects); },
    },
    /** Phase 26 thermal physics (benchmarks / browser verification): the run's thermal state and the preview model. */
    thermalLib: {
      rt: () => simulationController.getEnvironment().thermal.rt,
      outlook: (spec: HeatSourceSpec) => { const d = useWorldStore.getState().doc; return thermalOutlook(spec, d.terrain, d.settings.simulation.thermal?.ambient, d.objects); },
    },
    /** Phase 27 fire (benchmarks / browser verification): the run's fire state, presets and the preview outlook. */
    fireLib: {
      rt: () => simulationController.getEnvironment().fire.rt,
      presets: FIRE_PRESETS,
      outlook: (spec: FireSpec) => { const d = useWorldStore.getState().doc; const s = samplerFor(d.terrain); return fireOutlook(spec, d.objects, (x, z) => s.sampleHeight(x, z), { ...defaultFireSettings(), ...(d.settings.simulation.fire ?? {}) }); },
    },
    /** Phase 28 volcano (benchmarks / browser verification): the run's volcano state, presets and the preview outlook. */
    atmosLib: {
      rt: () => simulationController.getEnvironment().atmosphere.rt,
      presets: ATMOS_PRESETS,
      outlook: (spec: AtmosphereSpec) => { const d = useWorldStore.getState().doc; const s = samplerFor(d.terrain); return atmosphereOutlook(spec, d.terrain, (x, z) => s.sampleHeight(x, z)); },
    },
    /** Phase 30 climate (benchmarks / browser verification): the run's climate state, presets and the outlook. */
    climateLib: {
      rt: () => simulationController.getEnvironment().climate.rt,
      presets: CLIMATE_PRESETS,
      outlook: (spec: ClimateSpec) => climateOutlook(spec),
    },
    /** Phase 31 gravity (benchmarks / browser verification): the run's gravity channel / runtime, presets and the outlook. */
    gravityLib: {
      channel: () => simulationController.getEnvironment().gravity,
      rt: () => simulationController.getEnvironment().gravity.rt,
      physics: () => simulationController.getPhysics(),
      scenarios: GRAVITY_SCENARIOS,
      preset: (s: GravityScenario) => gravityPresetSpec(s),
      outlook: (spec: GravitySpec) => gravityOutlook(spec),
    },
    /** Phase 32 celestial (benchmarks / browser verification): the runtime, presets, demos and the outlook. */
    celestialLib: {
      rt: () => simulationController.getEnvironment().gravity.rt?.celestial ?? null,
      field: () => simulationController.getEnvironment().gravity.field,
      scenarios: CELESTIAL_SCENARIOS,
      preset: (s: CelestialScenario) => celestialPresetSpec(s),
      demo: (s: CelestialScenario) => celestialDemo(s),
      outlook: (spec: CelestialSpec, zeroG = false) => celestialOutlook(spec, 9.81, zeroG),
      csv: () => { const c = simulationController.celestialLive(); return c ? celestialCsv(c) : ''; },
      /** The text-command parser's verdict on a sentence (black holes are pointed to the editor, never executed). */
      parse: (text: string) => parseCommands(text, { direction: 'E', duration: 60, gustStrength: 0.25 }),
    },
    /** Phase 33 human model (browser verification): the run's people, aggregate, the human CSV / JSON, the presets. */
    humanLib: {
      people: () => { const rt = simulationController.getRuntime(); return rt ? humanEntities(rt.entities.values()).map(humanRow) : []; },
      aggregate: () => { const rt = simulationController.getRuntime(); return rt ? aggregateHumans(rt.entities.values()) : null; },
      csv: () => { const rt = simulationController.getRuntime(); return rt ? humanCsv(rt.entities.values(), useSimStore.getState().damageEvents, simulationController.getTime()) : ''; },
      json: () => { const rt = simulationController.getRuntime(); return rt ? humanJson(rt.entities.values(), useSimStore.getState().damageEvents) ?? null : null; },
      presets: HUMAN_PRESETS.map((p) => ({ id: p.id, seed: p.seed, seconds: p.seconds, keys: p.keys })),
      /** Replace the world with a preset's world, its events as experiment instances (no undo history). */
      loadPreset: (id: HumanPresetId) => {
        const p = humanPreset(id);
        if (!p) return false;
        const { doc, events } = p.build();
        const instances: PhenomenonInstance[] = [];
        for (const ev of events) instances.push(createInstance(ev.event, instances, ev));
        doc.scenario.experiment = { ...doc.scenario.experiment, instances };
        useEditorStore.getState().select(null);
        useWorldStore.getState().replaceDocument(doc);
        useWorldStore.setState({ past: [], future: [] });
        return true;
      },
    },
    /** Phase 34 physiology (browser verification): the run's physiology rows / aggregate / CSV / JSON, a person's snapshot, the presets. */
    physioLib: {
      people: () => { const rt = simulationController.getRuntime(); return rt ? physioEntities(rt.entities.values()).map(physioRow) : []; },
      aggregate: () => { const rt = simulationController.getRuntime(); return rt?.physiology ? aggregatePhysio(rt.entities.values()) : null; },
      csv: () => { const rt = simulationController.getRuntime(); return rt ? physioCsv(rt.entities.values(), useSimStore.getState().damageEvents, simulationController.getTime()) : ''; },
      json: () => { const rt = simulationController.getRuntime(); return rt ? physioJson(rt.entities.values(), useSimStore.getState().damageEvents, rt.physiology) ?? null : null; },
      /** JSON-safe copy of one person's physiology (or of every person's when id is omitted); null without physiology. */
      snapshot: (id?: string) => {
        const rt = simulationController.getRuntime();
        if (!rt?.physiology) return null;
        const one = (e: ReturnType<typeof physioEntities>[number]) => {
          const pe = e.physio;
          return JSON.parse(JSON.stringify({ id: e.id, row: physioRow(e), cfg: pe.cfg, s: { ...pe.s, flags: [...pe.s.flags] }, provenance: pe.provenance, sample: pe.sample, couple: pe.couple, frozen: pe.frozen, series: pe.series ? { dt: pe.series.dt, n: pe.series.t.length } : null, human: e.human ? { posture: e.human.posture, standing: e.human.standing, fallCause: e.human.fallCause, impacts: e.human.impacts, collapsed: e.human.collapsed } : null }));
        };
        const all = physioEntities(rt.entities.values());
        if (id !== undefined) { const e = all.find((x) => x.id === id); return e ? one(e) : null; }
        return all.map(one);
      },
      compartments: () => { const rt = simulationController.getRuntime(); return rt?.physiology ? [...rt.physiology.compartments.values()].map((c) => ({ ...c, ledger: { ...c.ledger } })) : []; },
      presets: PHYSIO_PRESETS.map((p) => ({ id: p.id, seed: p.seed, seconds: p.seconds, keys: p.keys })),
      /** Replace the world with a preset's world, its events as experiment instances (no undo history). */
      loadPreset: (id: PhysioPresetId) => {
        const p = physioPreset(id);
        if (!p) return false;
        const { doc, events } = p.build();
        const instances: PhenomenonInstance[] = [];
        for (const ev of events) instances.push(createInstance(ev.event, instances, ev));
        doc.scenario.experiment = { ...doc.scenario.experiment, instances };
        useEditorStore.getState().select(null);
        useWorldStore.getState().replaceDocument(doc);
        useWorldStore.setState({ past: [], future: [] });
        return true;
      },
    },
    volcanoLib: {
      rt: () => simulationController.getEnvironment().volcano.rt,
      presets: VOLCANO_PRESETS,
      outlook: (spec: VolcanoSpec) => { const d = useWorldStore.getState().doc; const s = samplerFor(d.terrain); return volcanoOutlook(spec, d.terrain, (x, z) => s.sampleHeight(x, z)); },
    },
    /** Benchmarks: the next run starts with `depth` m of still water on every open cell. */
    floodStart: (depth: number) => {
      const doc = useWorldStore.getState().doc;
      const f = new WaterField(samplerFor(doc.terrain), doc.settings.simulation.water);
      f.h.fill(depth);
      simulationController.setInitialWaterState(captureWaterState(f, 0));
    },
  };
}
