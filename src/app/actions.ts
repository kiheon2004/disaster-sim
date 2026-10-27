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
