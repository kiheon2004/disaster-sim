/**
 * Autosave (Phase 36 §48). The world is saved to localStorage after edits (800 ms debounce, as before) and now also:
 *
 *  - when the page is hidden or closed (`pagehide`, `visibilitychange` → hidden): the last edits are no longer lost on
 *    tab close / reload;
 *  - never while a terrain stroke or an object transaction is open (the terrain arrays are edited in place during a
 *    stroke and are folded into the layers only at its end — a save then wrote the terrain without its layers);
 *  - with a visible warning when the browser refuses the write (storage quota) — before, failures were silent.
 *
 * Loading: an autosave that cannot be read (parse / migration error, a file from a newer version, an exception in the
 * rebuild) is copied to a BACKUP key before anything else happens, the user is told, and the backup can be exported
 * from the ⋯ menu. Before, the app silently opened the sample town and the first edit overwrote the user's world.
 */
import { useWorldStore } from '@/world/worldStore';
import { parseDocument, serializeDocument, type LoadResult } from '@/world/serialization';
import { toast } from '@/ui/common/toast';

export const AUTOSAVE_KEY = 'ds.autosave';
export const BACKUP_KEY = 'ds.autosave.unreadable';
const DEBOUNCE_MS = 800;
/** Above this size the write is still tried, but the user is told the storage may be too small. */
const LARGE_BYTES = 4_000_000;

function get(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function put(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export interface AutosaveLoad {
  /** The restored document, or null (nothing saved, or unreadable — then `backedUp`). */
  result: LoadResult | null;
  /** The saved text could not be read and was copied to BACKUP_KEY. */
  backedUp: boolean;
  error?: string;
}

/** Read the autosave; an unreadable one is kept under BACKUP_KEY (never overwritten by the next edit). */
export function loadAutosave(): AutosaveLoad {
  const text = get(AUTOSAVE_KEY);
  if (!text) return { result: null, backedUp: false };
  let result: LoadResult;
  try {
    result = parseDocument(text);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) } as LoadResult;
  }
  if (result.ok) return { result, backedUp: false };
  const backedUp = put(BACKUP_KEY, text);
  return { result: null, backedUp, error: (result as { error?: string }).error };
}

export function hasBackup(): boolean {
  return get(BACKUP_KEY) !== null;
}

/** Download the unreadable autosave as a file (it can be repaired / opened by a newer version). */
export function exportBackup(): boolean {
  const text = get(BACKUP_KEY);
  if (!text) return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'autosave-unreadable.world.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

let lastFailureToast = 0;
let warnedLarge = false;

/** Write the current world now (unless a stroke / transaction is open). Returns false when nothing was written. */
export function saveNow(): boolean {
  const w = useWorldStore.getState();
  if (w.busy()) return false;
  let text: string;
  try {
    text = serializeDocument(w.doc, false);
  } catch {
    return false;
  }
  if (text.length > LARGE_BYTES && !warnedLarge) {
    warnedLarge = true;
    toast('warn', { key: 'ed36.autosave.large', params: { mb: (text.length / 1e6).toFixed(1) } });
  }
  const ok = put(AUTOSAVE_KEY, text);
  if (!ok && Date.now() - lastFailureToast > 30_000) {
    lastFailureToast = Date.now();
    toast('warn', { key: 'ed36.autosave.failed' });
  }
  return ok;
}

let installed = false;

/** Debounced saving after edits + a flush when the page is hidden / closed. Installed once from the bootstrap. */
export function installAutosave(): void {
  if (installed) return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(function tick() {
      // A stroke / drag in progress: try again shortly (the edit's end changes the document and reschedules too).
      if (useWorldStore.getState().busy()) { timer = setTimeout(tick, DEBOUNCE_MS); return; }
      timer = undefined;
      saveNow();
    }, DEBOUNCE_MS);
  };
  useWorldStore.subscribe((s, prev) => {
    if (s.doc !== prev.doc) schedule();
  });
  if (typeof window === 'undefined') return;
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    saveNow();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}
