/**
 * Phase 36 autosave: an unreadable autosave is backed up (not silently replaced), nothing is written mid-stroke or
 * mid-drag, the last edits are written when the page is hidden, and a refused write is reported.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  data = new Map<string, string>();
  full = false;
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string) { if (this.full) throw new Error('QuotaExceededError'); this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}
const store = new MemoryStorage();
class FakeDocument extends EventTarget { visibilityState: 'visible' | 'hidden' = 'visible'; querySelector() { return null; } }
const win = new EventTarget();
const doc = new FakeDocument();
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = store;
  (globalThis as { window?: unknown }).window ??= win;
  (globalThis as { document?: unknown }).document ??= doc;
});

import { AUTOSAVE_KEY, BACKUP_KEY, installAutosave, loadAutosave, saveNow } from './autosave';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { identityTransform } from '@/core/types';
import * as toastMod from '@/ui/common/toast';

const W = () => useWorldStore.getState();

beforeEach(() => {
  store.clear();
  store.full = false;
  W().replaceDocument(createEmptyDocument());
});

describe('autosave', () => {
  it('an unreadable autosave is kept as a backup instead of being lost', () => {
    store.setItem(AUTOSAVE_KEY, '{"schemaVersion": 99, "broken": true');
    const r = loadAutosave();
    expect(r.result).toBe(null);
    expect(r.backedUp).toBe(true);
    expect(store.getItem(BACKUP_KEY)).toBe('{"schemaVersion": 99, "broken": true');
  });

  it('a readable autosave restores the world', () => {
    W().addObject({ type: 'wall', transform: identityTransform() });
    expect(saveNow()).toBe(true);
    const r = loadAutosave();
    expect(r.result?.ok).toBe(true);
    expect(r.result && r.result.ok && Object.keys(r.result.doc.objects).length).toBe(1);
  });

  it('nothing is written while a terrain stroke or an object transaction is open', () => {
    W().beginTerrainStroke();
    W().terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 5, strength: 1 }, dt: 0.05 });
    expect(saveNow()).toBe(false);
    expect(store.getItem(AUTOSAVE_KEY)).toBe(null);
    W().endTerrainStroke();
    W().beginTransaction();
    expect(saveNow()).toBe(false);
    W().cancelTransaction();
    expect(saveNow()).toBe(true);
  });

  it('a refused write (quota) is reported', () => {
    const spy = vi.spyOn(toastMod, 'toast');
    store.full = true;
    expect(saveNow()).toBe(false);
    expect(spy).toHaveBeenCalledWith('warn', { key: 'ed36.autosave.failed' });
    spy.mockRestore();
  });

  it('the pending edit is written when the page is hidden (tab close / switch)', () => {
    vi.useFakeTimers();
    try {
      installAutosave();
      W().addObject({ type: 'wall', transform: identityTransform() });
      expect(store.getItem(AUTOSAVE_KEY)).toBe(null); // still debounced
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
      doc.visibilityState = 'visible';
      expect(store.getItem(AUTOSAVE_KEY)).not.toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});
