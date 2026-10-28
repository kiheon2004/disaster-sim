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
import { parseWaterState, serializeWaterState } from '@/simulation/water/waterStateCodec';

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

export function deleteSelected() {
  const id = useEditorStore.getState().selectedId;
  if (!id) return;
  useWorldStore.getState().remove([id]);
  useEditorStore.getState().select(null);
}

export function duplicateSelected() {
  const id = useEditorStore.getState().selectedId;
  if (!id) return;
  const copy = useWorldStore.getState().duplicate(id);
  if (copy) useEditorStore.getState().select(copy);
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

// ── Water state (mid-simulation snapshot, separate from the project file) ─

/** Download the current water (depth + soil saturation) as a *.water.json file. */
export function saveWaterState() {
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
