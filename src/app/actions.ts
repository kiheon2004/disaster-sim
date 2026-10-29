/**
 * Application services: orchestrate several systems (world, editor, simulation, view)
 * so UI components never wire them together themselves.
 */
import type { EntityId } from '@/core/types';
import type { TerrainPresetId } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useViewStore } from '@/rendering/viewStore';
import { downloadDocument, parseDocument, pickDocumentFile, storage, type LoadResult } from '@/world/serialization';
import { sampleTown } from '@/world/sampleScene';
import { stressScene } from '@/world/stressScene';
import { createEmptyDocument } from '@/world/WorldDocument';
import { toast } from '@/ui/common/toast';
import { useUiStore } from '@/ui/uiStore';
import { t } from '@/i18n/i18n';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import type { EventSpec } from '@/events/specs';
import { RuleBasedParser } from '@/commands/RuleBasedParser';
import type { CommandParser, ParseDefaults, ParseResult } from '@/commands/CommandParser';
import { dispatchCommands, type CommandTarget } from '@/commands/CommandDispatcher';
import { phenomena } from '@/phenomena/registry';
import { createInstance, resolveSchedule } from '@/phenomena/schedule';
import { defaultScenarios, runComparison, type ScenarioResult } from '@/phenomena/experiment';
import { defaultExperiment, type PhenomenonContext, type PhenomenonInstance } from '@/phenomena/types';
import { parseWaterState, serializeWaterState } from '@/simulation/water/waterStateCodec';
import { deleteSelection, duplicateSelection } from './buildActions';
import { useBuildStore } from '@/editor/buildStore';
import { worldFingerprint } from '@/world/fingerprint';

/** Select an object and center the camera on it (its live pose while simulating). */
export function focusObject(id: EntityId) {
  const o = useWorldStore.getState().doc.objects[id];
  if (!o) return;
  useEditorStore.getState().select(id);
  const dims = getDefinition(o.type).getDimensions(o.params);
  const size = Math.max(dims[0] * o.transform.scale[0], dims[1] * o.transform.scale[1], dims[2] * o.transform.scale[2]);
  const live = simulationController.getRuntime()?.entities.get(id);
  const p = live ? live.pose.position : o.transform.position;
  useViewStore.getState().requestFocus([p[0], p[1] + dims[1] * o.transform.scale[1] * 0.4, p[2]], Math.max(8, size * 2.6));
}

/** Camera to a world position (e.g. a damage event), optionally selecting the object. */
export function focusPosition(pos: [number, number, number], id?: EntityId) {
  if (id && useWorldStore.getState().doc.objects[id]) useEditorStore.getState().select(id);
  useViewStore.getState().setFollow(null);
  useViewStore.getState().requestFocus(pos, 18);
}

export function toggleFollow(id: EntityId) {
  const v = useViewStore.getState();
  v.setFollow(v.followId === id ? null : id);
}

/** Delete every selected object (one undo step). */
export function deleteSelected() {
  deleteSelection();
}

/** Duplicate the selection (one undo step; a single object keeps the pre-Phase-16 behavior). */
export function duplicateSelected() {
  duplicateSelection();
}

// ── Project / file actions ────────────────────────────────────────────────


function applyLoad(res: LoadResult | null, emptyKey: 'toast.noSave' | 'toast.importCancelled') {
  if (!res) {
    toast('warn', { key: emptyKey });
    return;
  }
  if (!res.ok) {
    toast('error', { key: 'toast.loadFailed' }, res.error);
    return;
  }
  useEditorStore.getState().select(null);
  useWorldStore.getState().replaceDocument(res.doc);
  toast('success', { key: 'toast.loaded', params: { name: res.doc.meta.name || t('app.untitled'), count: Object.keys(res.doc.objects).length } });
  if (res.skipped) toast('warn', { key: 'toast.skipped', params: { count: res.skipped } });
}

export function saveProject() {
  const ok = storage.save(useWorldStore.getState().doc);
  toast(ok ? 'success' : 'error', { key: ok ? 'toast.saved' : 'toast.saveFailed' });
}

export function loadProject() {
  applyLoad(storage.load(), 'toast.noSave');
}

export function exportProject() {
  downloadDocument(useWorldStore.getState().doc);
  toast('info', { key: 'toast.exported' });
}

export async function importProject() {
  const text = await pickDocumentFile();
  if (text === null) return;
  applyLoad(parseDocument(text), 'toast.importCancelled');
}

/** Replace the terrain with a generated preset (one undo step; grounded objects follow). */
export function applyTerrainPreset(preset: TerrainPresetId, seed: number) {
  const name = t(`terrain.preset.${preset}`);
  if (!window.confirm(t('terrain.preset.confirm', { name }))) return;
  useWorldStore.getState().applyTerrainPreset(preset, seed);
  toast('success', { key: 'toast.terrainPreset', params: { name } });
}

export function newProject() {
  if (Object.keys(useWorldStore.getState().doc.objects).length && !window.confirm(t('confirm.new'))) return;
  useEditorStore.getState().select(null);
  useWorldStore.getState().newDocument();
}

/** Performance test scene with `count` objects (dev / benchmarking). */
export function loadStressScene(count: number) {
  const doc = createEmptyDocument(`Stress ${count}`);
  useEditorStore.getState().select(null);
  useWorldStore.getState().replaceDocument(doc);
  useWorldStore.getState().addObjects(stressScene(count));
  useWorldStore.setState({ past: [], future: [] });
}

export function loadSampleTown() {
  const doc = createEmptyDocument(t('sample.name'));
  useEditorStore.getState().select(null);
  useWorldStore.getState().replaceDocument(doc);
  useWorldStore.getState().addObjects(sampleTown());
  // The sample itself should not be an undo step.
  useWorldStore.setState({ past: [], future: [] });
}

/** Restore the last session (autosave) or start with the sample town on first launch. */
export function bootstrapWorld() {
  useSimStore.subscribe((s, prev) => {
    if (s.status === 'finished' && prev.status !== 'finished') toast('info', { key: 'toast.finished' });
  });
  const res = storage.loadAutosave();
  if (res && res.ok) {
    useWorldStore.getState().replaceDocument(res.doc);
  } else {
    loadSampleTown();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  useWorldStore.subscribe((s, prev) => {
    if (s.doc === prev.doc) return;
    clearTimeout(timer);
    timer = setTimeout(() => storage.autosave(useWorldStore.getState().doc), 800);
  });
}

// ── Simulation actions ────────────────────────────────────────────────────


/** Switch to simulation mode: snapshot the world and build the runtime (paused at t = 0). */
export async function enterSimulation() {
  const ed = useEditorStore.getState();
  if (ed.mode === 'simulation') return;
  ed.setMode('simulation');
  useBuildStore.getState().clearSessions();
  // The original world is read-only while the experiment runs on its snapshot (Phase 16).
  useWorldStore.getState().setLocked(true);
  const doc = useWorldStore.getState().doc;
  useSimStore.getState().set({ baseline: { hash: worldFingerprint(doc), objects: Object.keys(doc.objects).length } });
  try {
    await simulationController.load(useWorldStore.getState().doc);
  } catch (err) {
    console.error(err);
    toast('error', { key: 'toast.physicsFailed' }, String(err));
    exitSimulation();
  }
}

/** Back to the editor. The document was never modified, so this is also a full restore. */
export function exitSimulation() {
  useViewStore.getState().setFollow(null);
  useUiStore.getState().setResultsOpen(false);
  simulationController.unload();
  // The simulation never writes to the document: leaving shows exactly the original world.
  useSimStore.getState().set({ baseline: null });
  useWorldStore.getState().setLocked(false);
  useEditorStore.getState().setMode('editor');
}

/** Add events (now, or at their startTime) and play. Enters simulation mode if needed. */
export async function runSimulation(specs: EventSpec[]) {
  if (useEditorStore.getState().mode === 'editor') await enterSimulation();
  if (!simulationController.isLoaded()) return;
  for (const s of specs) simulationController.addEvent(s);
  simulationController.play();
}

export async function resetSimulation() {
  await simulationController.reset();
  toast('info', { key: 'toast.reset' });
}

export function togglePlay() {
  if (useSimStore.getState().status === 'loading') return;
  simulationController.togglePlay();
}

// ── Experiment (Phase 15) ───────────────────────────────────────────────

function experiment() {
  return useWorldStore.getState().doc.scenario.experiment ?? defaultExperiment();
}

export function phenomenonContext(): PhenomenonContext {
  const doc = useWorldStore.getState().doc;
  return { seed: doc.settings.simulation.seed, terrain: doc.terrain, water: doc.settings.simulation.water };
}

/** Add a phenomenon (default parameters, or a spec from one of the detailed hazard forms). */
export function addPhenomenon(type: string, spec?: EventSpec): string | null {
  const cur = experiment().instances;
  if (!phenomena.implemented(type)) return null;
  const inst = createInstance(type, cur, spec);
  useWorldStore.getState().setExperiment({ instances: [...cur, inst] });
  toast('success', { key: 'exp.toast.added', params: { name: t(phenomena.get(type)!.labelKey) } });
  return inst.id;
}

export function updatePhenomenon(id: string, patch: Partial<PhenomenonInstance>) {
  useWorldStore.getState().setExperiment({ instances: experiment().instances.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
}

export function removePhenomenon(id: string) {
  // Instances that started after the removed one keep their resolved time.
  const ctx = phenomenonContext();
  const sched = resolveSchedule(experiment().instances, ctx);
  const startOf = new Map(sched.items.map((r) => [r.instance.id, r.start]));
  const rest = experiment().instances.filter((i) => i.id !== id).map((i) => ('after' in i.start && i.start.after === id ? { ...i, start: { at: startOf.get(i.id) ?? 0 } } : i));
  useWorldStore.getState().setExperiment({ instances: rest });
}

/** Per-phenomenon visualization → the existing view layers (render-only). */
function applyVisualization(instances: readonly PhenomenonInstance[]) {
  const on = (types: string[]) => instances.some((i) => i.enabled && types.includes(i.type) && i.visualize);
  const has = (types: string[]) => instances.some((i) => i.enabled && types.includes(i.type));
  const v = useViewStore.getState();
  if (has(['wind'])) useViewStore.setState({ showWind: on(['wind']) });
  if (has(['earthquake'])) v.setQuakeViz({ ground: on(['earthquake']), arrows: on(['earthquake']), epicenter: on(['earthquake']) });
  if (has(['rain', 'risingWater', 'waterSource'])) v.setFloodViz({ visible: on(['rain', 'risingWater', 'waterSource']) });
}

/** Run every enabled phenomenon of the experiment on one clock (now = experiment time 0). */
export async function runExperiment() {
  const exp = experiment();
  const inSim = useEditorStore.getState().mode === 'simulation';
  const base = inSim ? simulationController.getTime() : 0;
  const sched = resolveSchedule(exp.instances, phenomenonContext(), base);
  for (const issue of sched.issues) toast('warn', { key: `exp.issue.${issue.problem}`, params: { id: issue.id } });
  if (!sched.items.length) {
    toast('warn', { key: 'exp.toast.nothing' });
    return;
  }
  applyVisualization(exp.instances);
  await runSimulation(sched.items.map((r) => r.spec));
}

export interface ComparisonRun {
  cancel: () => void;
  done: Promise<ScenarioResult[]>;
}

/** Compare the experiment's phenomena alone and together on the current world (headless). */
export function compareExperiment(onProgress: (scenario: number, simTime: number, total: number) => void): ComparisonRun {
  const doc = structuredClone(useWorldStore.getState().doc);
  const exp = doc.scenario.experiment;
  let stop = false;
  const done = runComparison(doc, exp.instances, defaultScenarios(exp.instances), {
    duration: exp.compareDuration,
    initialWater: simulationController.getInitialWaterState(),
    onProgress,
    yieldFn: () => new Promise((r) => setTimeout(r, 0)),
    cancelled: () => stop,
  });
  return { cancel: () => (stop = true), done };
}

// ── Water state (mid-simulation snapshot, separate from the project file) ─

/** Download the current water (depth + soil saturation) as a *.water.json file. */
export function saveWaterState() {
  // Mid-run water over a DEFORMED ground is explicitly unsupported (Phase 21): the state fits
  // only the terrain it was computed on, and the deformation itself is not part of the file.
  if ((simulationController.getEnvironment().deformation.engine?.rev ?? 0) > 0) {
    toast('warn', { key: 'toast.waterDeformed' });
    return;
  }
  const state = simulationController.captureWaterState();
  if (!state) {
    toast('warn', { key: 'toast.noWater' });
    return;
  }
  const doc = useWorldStore.getState().doc;
  const url = URL.createObjectURL(new Blob([serializeWaterState(state)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(doc.meta.name || 'world').replace(/[^\w\-가-힣]+/g, '_')}-t${Math.round(state.time)}s.water.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('success', { key: 'toast.waterSaved' });
}

/** Pick a *.water.json file: the next run (reset) starts from it. */
export async function loadWaterState() {
  const text = await pickDocumentFile();
  if (text === null) return;
  const res = parseWaterState(text, useWorldStore.getState().doc.terrain);
  if (!res.ok) {
    toast('error', { key: 'toast.waterLoadFailed' }, res.error);
    return;
  }
  simulationController.setInitialWaterState(res.state);
  useSimStore.getState().set({ initialWaterTime: res.state.time });
  toast('success', { key: 'toast.waterLoaded' });
}

export function clearWaterState() {
  simulationController.setInitialWaterState(null);
  useSimStore.getState().set({ initialWaterTime: null });
}

// ── Command system wiring ─────────────────────────────────────────────────


/** Active parser. Swap for `new LlmParser(transport)` to use an LLM. */
export const commandParser: CommandParser = new RuleBasedParser();

const commandTarget: CommandTarget = {
  findScheduled: (type, anchor) => (simulationController.isLoaded() ? simulationController.scheduledTime(type, anchor) : null),
  runEvents: async (events) => {
    if (useEditorStore.getState().mode === 'editor') await enterSimulation();
    if (!simulationController.isLoaded()) return;
    const now = simulationController.getTime();
    for (const { spec, delay } of events) {
      simulationController.addEvent(delay > 0 ? { ...spec, startTime: now + delay } : spec);
    }
    simulationController.play();
  },
  play: () => {
    if (useEditorStore.getState().mode === 'editor') void enterSimulation().then(() => simulationController.play());
    else simulationController.play();
  },
  pause: () => simulationController.pause(),
  reset: async () => {
    if (simulationController.isLoaded()) await resetSimulation();
  },
  setSpeed: (v) => simulationController.setSpeed(v),
};

export function parseCommand(input: string, defaults: ParseDefaults): Promise<ParseResult> {
  return commandParser.parse(input, defaults);
}

/** Parse + execute. Returns the parse result for display. */
export async function executeCommand(input: string, defaults: ParseDefaults): Promise<ParseResult> {
  const result = await commandParser.parse(input, defaults);
  if (result.ok && result.commands.length) {
    const report = await dispatchCommands(result.commands, commandTarget);
    for (const u of report.unresolved) {
      const def = phenomena.get(u.type);
      toast('warn', { key: 'cmd.warn.noRef', params: { name: def ? t(def.labelKey) : u.type, s: u.offset } });
    }
  }
  return result;
}
