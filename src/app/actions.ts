/**
 * Application services: orchestrate several systems (world, editor, simulation, view)
 * so UI components never wire them together themselves.
 */
import type { EntityId } from '@/core/types';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useViewStore } from '@/rendering/viewStore';
import { downloadDocument, parseDocument, pickDocumentFile, storage, type LoadResult } from '@/world/serialization';
import { sampleTown } from '@/world/sampleScene';
import { createEmptyDocument } from '@/world/WorldDocument';
import { toast } from '@/ui/common/toast';
import { t } from '@/i18n/i18n';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import type { EventSpec } from '@/events/specs';
import { RuleBasedParser } from '@/commands/RuleBasedParser';
import type { CommandParser, ParseDefaults, ParseResult } from '@/commands/CommandParser';
import { dispatchCommands, type CommandTarget } from '@/commands/CommandDispatcher';

export function focusObject(id: EntityId) {
  const o = useWorldStore.getState().doc.objects[id];
  if (!o) return;
  useEditorStore.getState().select(id);
  const dims = getDefinition(o.type).getDimensions(o.params);
  const size = Math.max(dims[0] * o.transform.scale[0], dims[1] * o.transform.scale[1], dims[2] * o.transform.scale[2]);
  useViewStore.getState().requestFocus(
    [o.transform.position[0], o.transform.position[1] + dims[1] * o.transform.scale[1] * 0.4, o.transform.position[2]],
    Math.max(8, size * 2.6),
  );
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

export function newProject() {
  if (Object.keys(useWorldStore.getState().doc.objects).length && !window.confirm(t('confirm.new'))) return;
  useEditorStore.getState().select(null);
  useWorldStore.getState().newDocument();
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

// ── Command system wiring ─────────────────────────────────────────────────


/** Active parser. Swap for `new LlmParser(transport)` to use an LLM. */
export const commandParser: CommandParser = new RuleBasedParser();

const commandTarget: CommandTarget = {
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
  if (result.ok && result.commands.length) await dispatchCommands(result.commands, commandTarget);
  return result;
}
