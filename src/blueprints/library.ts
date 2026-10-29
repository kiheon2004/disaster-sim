/**
 * Blueprint Library (Phase 20): local storage of blueprints and world templates — no server,
 * no account. Each entry is an index record (name, category, tags, counts, thumbnail, favorite,
 * last use) plus a body (the canonical file text), so the library lists instantly and bodies
 * are read only when used.
 *
 * Backends: IndexedDB in the browser (large bodies, survives reloads); an in-memory backend for
 * tests and as the fallback when IndexedDB is unavailable (private windows) — the UI then says
 * that the library is not persisted.
 *
 * Built-in examples (blueprints and world templates) are listed from code and generated on
 * demand; they cannot be renamed or deleted (duplicate them to edit).
 */
import { create } from 'zustand';
import { createId } from '@/core/id';
import { BUILTIN_BLUEPRINTS, BUILTIN_PREFIX, buildBuiltinBlueprint, isBuiltinId, type BuiltinBlueprint } from './builtin';
import { blueprintHash, parseBlueprintText, serializeBlueprint, type BlueprintParseReport } from './schema';
import type { BlueprintCategory, UnifiedBlueprint } from './types';
import { BUILTIN_TEMPLATES, buildTemplate, TEMPLATE_EXPERIMENT, type BuiltinTemplate } from '@/templates/builtin';
import { countsOf as templateCounts, createTemplate, parseTemplate, serializeTemplate, type WorldTemplate } from '@/templates/template';

export type EntryKind = 'blueprint' | 'world';
export type LibraryCategory = BlueprintCategory | 'world';
export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = ['buildings', 'residential', 'commercial', 'industrial', 'infrastructure', 'roads', 'nature', 'mixed', 'world'];

export interface LibraryEntry {
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  category: LibraryCategory;
  tags: string[];
  favorite: boolean;
  builtin: boolean;
  /** Built-in: i18n key stem (bp.builtin.<id> / tpl.builtin.<id>) for name / description. */
  builtinKey?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  bytes: number;
  hash: string;
  thumbnail: string | null;
  counts: Record<string, number>;
  /** World templates: the saved scenario is included. */
  experiment?: boolean;
}

export interface LibraryBackend {
  readonly persistent: boolean;
  list(): Promise<LibraryEntry[]>;
  getBody(id: string): Promise<string | null>;
  put(entry: LibraryEntry, body: string | null): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryBackend implements LibraryBackend {
  readonly persistent = false;
  private entries = new Map<string, LibraryEntry>();
  private bodies = new Map<string, string>();
  async list() { return [...this.entries.values()].map((e) => ({ ...e })); }
  async getBody(id: string) { return this.bodies.get(id) ?? null; }
  async put(entry: LibraryEntry, body: string | null) {
    this.entries.set(entry.id, { ...entry });
    if (body !== null) this.bodies.set(entry.id, body);
  }
  async remove(id: string) { this.entries.delete(id); this.bodies.delete(id); }
}

const DB = 'ds.library';
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class IndexedDbBackend implements LibraryBackend {
  readonly persistent = true;
  private db: Promise<IDBDatabase>;
  constructor() {
    this.db = new Promise((res, rej) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('entries', { keyPath: 'id' });
        open.result.createObjectStore('bodies');
      };
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
  }
  private async tx(stores: string[], mode: IDBTransactionMode) { return (await this.db).transaction(stores, mode); }
  async list() { return req((await this.tx(['entries'], 'readonly')).objectStore('entries').getAll() as IDBRequest<LibraryEntry[]>); }
  async getBody(id: string) { return (await req((await this.tx(['bodies'], 'readonly')).objectStore('bodies').get(id))) ?? null; }
  async put(entry: LibraryEntry, body: string | null) {
    const t = await this.tx(['entries', 'bodies'], 'readwrite');
    t.objectStore('entries').put(entry);
    if (body !== null) t.objectStore('bodies').put(body, entry.id);
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  async remove(id: string) {
    const t = await this.tx(['entries', 'bodies'], 'readwrite');
    t.objectStore('entries').delete(id);
    t.objectStore('bodies').delete(id);
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  }
}

/** The best backend available here (IndexedDB when it opens, memory otherwise). */
export async function defaultBackend(): Promise<LibraryBackend> {
  if (typeof indexedDB === 'undefined') return new MemoryBackend();
  try {
    const b = new IndexedDbBackend();
    await b.list();
    return b;
  } catch {
    return new MemoryBackend();
  }
}

// ── Entries from values ───────────────────────────────────────────────────────

export function blueprintEntry(bp: UnifiedBlueprint, body: string, prev?: LibraryEntry): LibraryEntry {
  return {
    id: bp.id, kind: 'blueprint', name: bp.meta.name, description: bp.meta.description, category: bp.meta.category, tags: [...bp.meta.tags],
    favorite: prev?.favorite ?? false, builtin: isBuiltinId(bp.id), createdAt: bp.meta.createdAt, updatedAt: bp.meta.updatedAt, lastUsedAt: prev?.lastUsedAt ?? null,
    bytes: body.length, hash: blueprintHash(bp), thumbnail: bp.preview.thumbnail, counts: { ...bp.preview.counts },
  };
}

export function templateEntry(t: WorldTemplate, body: string, prev?: LibraryEntry): LibraryEntry {
  return {
    id: t.id, kind: 'world', name: t.meta.name, description: t.meta.description, category: 'world', tags: [...t.meta.tags],
    favorite: prev?.favorite ?? false, builtin: t.id.startsWith(BUILTIN_PREFIX), createdAt: t.meta.createdAt, updatedAt: t.meta.updatedAt, lastUsedAt: prev?.lastUsedAt ?? null,
    bytes: body.length, hash: hashText(body), thumbnail: t.preview.thumbnail, counts: { ...t.preview.counts }, experiment: t.includesExperiment,
  };
}

function hashText(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const FIXED = '2026-01-01T00:00:00.000Z';
/** Index records of the built-in examples (generated on use). */
export function builtinEntries(): LibraryEntry[] {
  const bps: LibraryEntry[] = BUILTIN_BLUEPRINTS.map((b) => ({
    id: `${BUILTIN_PREFIX}${b.id}`, kind: 'blueprint', name: b.id, description: '', category: b.category, tags: b.tags, favorite: false, builtin: true, builtinKey: `bp.builtin.${b.id}`,
    createdAt: FIXED, updatedAt: FIXED, lastUsedAt: null, bytes: 0, hash: '', thumbnail: null, counts: {},
  }));
  const tpls: LibraryEntry[] = BUILTIN_TEMPLATES.map((k) => ({
    id: `${BUILTIN_PREFIX}tpl-${k}`, kind: 'world', name: k, description: '', category: 'world', tags: [], favorite: false, builtin: true, builtinKey: `tpl.builtin.${k}`,
    createdAt: FIXED, updatedAt: FIXED, lastUsedAt: null, bytes: 0, hash: '', thumbnail: null, counts: {}, experiment: !!TEMPLATE_EXPERIMENT[k],
  }));
  return [...bps, ...tpls];
}

export const builtinTemplateKind = (id: string): BuiltinTemplate | null => {
  const k = id.startsWith(`${BUILTIN_PREFIX}tpl-`) ? id.slice(`${BUILTIN_PREFIX}tpl-`.length) : null;
  return k && (BUILTIN_TEMPLATES as readonly string[]).includes(k) ? (k as BuiltinTemplate) : null;
};

// ── Store ────────────────────────────────────────────────────────────────────

export type ImportCheck =
  | { ok: true; kind: 'blueprint'; blueprint: UnifiedBlueprint; report: BlueprintParseReport; duplicate: { sameContent: boolean; existing: LibraryEntry } | null; bytes: number }
  | { ok: true; kind: 'world'; template: WorldTemplate; duplicate: { sameContent: boolean; existing: LibraryEntry } | null; bytes: number; skipped: number }
  | { ok: false; code: string; detail: string };

/** User-local state of built-in entries (favorite / last use) kept next to user entries. */
interface BuiltinState { favorite: boolean; lastUsedAt: string | null }

interface LibraryState {
  ready: boolean;
  persistent: boolean;
  entries: LibraryEntry[];
  builtinState: Record<string, BuiltinState>;
  /** Rendered thumbnails of built-in entries (this session). */
  builtinThumbs: Record<string, string>;
  /** Parsed bodies (blueprints / templates) by id. */
  cache: Map<string, UnifiedBlueprint | WorldTemplate>;
  init: (backend?: LibraryBackend) => Promise<void>;
  /** All entries: built-ins (with their user state) + user entries. */
  all: () => LibraryEntry[];
  saveBlueprint: (bp: UnifiedBlueprint) => Promise<LibraryEntry>;
  saveTemplate: (t: WorldTemplate) => Promise<LibraryEntry>;
  update: (id: string, patch: Partial<Pick<LibraryEntry, 'name' | 'description' | 'category' | 'tags'>>) => Promise<void>;
  setThumbnail: (id: string, thumbnail: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  markUsed: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string, name: string) => Promise<LibraryEntry | null>;
  loadBlueprint: (id: string) => Promise<UnifiedBlueprint | null>;
  loadTemplate: (id: string, seed?: number) => Promise<WorldTemplate | null>;
  /** Text of an entry as a file (export). */
  exportText: (id: string) => Promise<string | null>;
  checkImport: (text: string) => ImportCheck;
  /** Store a checked import: 'copy' = new id when the id exists, 'replace' = overwrite. */
  commitImport: (check: Extract<ImportCheck, { ok: true }>, mode: 'copy' | 'replace') => Promise<LibraryEntry>;
}

let backend: LibraryBackend = new MemoryBackend();
const BUILTIN_STATE_KEY = 'ds.library.builtin';
const readBuiltinState = (): Record<string, BuiltinState> => {
  try {
    const raw = JSON.parse(localStorage.getItem(BUILTIN_STATE_KEY) ?? '{}');
    const out: Record<string, BuiltinState> = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (isBuiltinId(k) && v && typeof v === 'object') out[k] = { favorite: !!(v as BuiltinState).favorite, lastUsedAt: typeof (v as BuiltinState).lastUsedAt === 'string' ? (v as BuiltinState).lastUsedAt : null };
    return out;
  } catch {
    return {};
  }
};
const writeBuiltinState = (s: Record<string, BuiltinState>) => { try { localStorage.setItem(BUILTIN_STATE_KEY, JSON.stringify(s)); } catch { /* not persisted */ } };

export const useLibraryStore = create<LibraryState>((set, get) => {
  const replaceEntry = (e: LibraryEntry) => set({ entries: [...get().entries.filter((x) => x.id !== e.id), e] });
  const userEntry = (id: string) => get().entries.find((e) => e.id === id) ?? null;
  const touchBuiltin = (id: string, patch: Partial<BuiltinState>) => {
    const cur = get().builtinState[id] ?? { favorite: false, lastUsedAt: null };
    const builtinState = { ...get().builtinState, [id]: { ...cur, ...patch } };
    set({ builtinState });
    writeBuiltinState(builtinState);
  };
  return {
    ready: false,
    persistent: false,
    entries: [],
    builtinState: {},
    builtinThumbs: {},
    cache: new Map(),

    init: async (b) => {
      backend = b ?? (await defaultBackend());
      const entries = await backend.list();
      set({ ready: true, persistent: backend.persistent, entries, builtinState: readBuiltinState(), cache: new Map() });
    },

    all: () => {
      const st = get().builtinState;
      const builtins = builtinEntries().map((e) => {
        const cached = get().cache.get(e.id);
        const counts = cached ? { ...cached.preview.counts } : e.counts;
        const thumb = get().builtinThumbs[e.id] ?? null;
        return { ...e, counts, thumbnail: thumb, favorite: st[e.id]?.favorite ?? false, lastUsedAt: st[e.id]?.lastUsedAt ?? null };
      });
      return [...builtins, ...get().entries];
    },

    saveBlueprint: async (bp) => {
      const body = serializeBlueprint(bp);
      const e = blueprintEntry(bp, body, userEntry(bp.id) ?? undefined);
      await backend.put(e, body);
      get().cache.set(bp.id, bp);
      replaceEntry(e);
      return e;
    },

    saveTemplate: async (t) => {
      const body = serializeTemplate(t);
      const e = templateEntry(t, body, userEntry(t.id) ?? undefined);
      await backend.put(e, body);
      get().cache.set(t.id, t);
      replaceEntry(e);
      return e;
    },

    update: async (id, patch) => {
      if (isBuiltinId(id)) return;
      const e = userEntry(id);
      if (!e) return;
      const now = new Date().toISOString();
      if (e.kind === 'blueprint') {
        const bp = await get().loadBlueprint(id);
        if (!bp) return;
        const next: UnifiedBlueprint = { ...bp, meta: { ...bp.meta, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.category && patch.category !== 'world' ? { category: patch.category } : {}), ...(patch.tags ? { tags: patch.tags } : {}), updatedAt: now } };
        await get().saveBlueprint(next);
      } else {
        const t = await get().loadTemplate(id);
        if (!t) return;
        await get().saveTemplate({ ...t, meta: { ...t.meta, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.tags ? { tags: patch.tags } : {}), updatedAt: now } });
      }
    },

    setThumbnail: async (id, thumbnail) => {
      if (isBuiltinId(id)) {
        set({ builtinThumbs: { ...get().builtinThumbs, [id]: thumbnail } });
        return;
      }
      const e = userEntry(id);
      if (!e || e.thumbnail === thumbnail) return;
      if (e.kind === 'blueprint') {
        const bp = await get().loadBlueprint(id);
        if (bp) await get().saveBlueprint({ ...bp, preview: { ...bp.preview, thumbnail } });
      } else {
        const t = await get().loadTemplate(id);
        if (t) await get().saveTemplate({ ...t, preview: { ...t.preview, thumbnail } });
      }
    },

    toggleFavorite: async (id) => {
      if (isBuiltinId(id)) { touchBuiltin(id, { favorite: !(get().builtinState[id]?.favorite ?? false) }); return; }
      const e = userEntry(id);
      if (!e) return;
      const next = { ...e, favorite: !e.favorite };
      await backend.put(next, null);
      replaceEntry(next);
    },

    markUsed: async (id) => {
      const now = new Date().toISOString();
      if (isBuiltinId(id)) { touchBuiltin(id, { lastUsedAt: now }); return; }
      const e = userEntry(id);
      if (!e) return;
      const next = { ...e, lastUsedAt: now };
      await backend.put(next, null);
      replaceEntry(next);
    },

    remove: async (id) => {
      if (isBuiltinId(id)) return;
      await backend.remove(id);
      get().cache.delete(id);
      set({ entries: get().entries.filter((e) => e.id !== id) });
    },

    duplicate: async (id, name) => {
      const src = get().all().find((e) => e.id === id);
      if (!src) return null;
      const now = new Date().toISOString();
      if (src.kind === 'blueprint') {
        const bp = await get().loadBlueprint(id);
        if (!bp) return null;
        return get().saveBlueprint({ ...structuredClone({ ...bp, preview: { ...bp.preview, thumbnail: null } }), id: createId('bp'), meta: { ...bp.meta, name, createdAt: now, updatedAt: now }, preview: { ...bp.preview } });
      }
      const t = await get().loadTemplate(id);
      if (!t) return null;
      return get().saveTemplate({ ...t, id: createId('tpl'), meta: { ...t.meta, name, createdAt: now, updatedAt: now } });
    },

    loadBlueprint: async (id) => {
      const c = get().cache.get(id);
      if (c && (c as UnifiedBlueprint).format === 'disaster-sim/blueprint') return c as UnifiedBlueprint;
      if (isBuiltinId(id)) {
        const key = id.slice(BUILTIN_PREFIX.length) as BuiltinBlueprint;
        if (!BUILTIN_BLUEPRINTS.some((b) => b.id === key)) return null;
        const bp = buildBuiltinBlueprint(key);
        get().cache.set(id, bp);
        set({ cache: new Map(get().cache) });
        return bp;
      }
      const body = await backend.getBody(id);
      if (!body) return null;
      const r = parseBlueprintText(body);
      if (!r.ok) return null;
      get().cache.set(id, r.blueprint);
      return r.blueprint;
    },

    loadTemplate: async (id, seed) => {
      const kind = builtinTemplateKind(id);
      if (kind) {
        const s = seed ?? 1;
        const key = `${id}#${s}`;
        const c = get().cache.get(key);
        if (c) return c as WorldTemplate;
        const doc = buildTemplate(kind, s, { name: kind, now: FIXED });
        const t = createTemplate(doc, { name: kind, createdAt: FIXED }, !!TEMPLATE_EXPERIMENT[kind], { id, now: FIXED, builtin: { kind, seed: s } });
        get().cache.set(key, t);
        if (!get().cache.has(id)) get().cache.set(id, t);
        set({ cache: new Map(get().cache) });
        return t;
      }
      const c = get().cache.get(id);
      if (c && (c as WorldTemplate).format === 'disaster-sim/world-template') return c as WorldTemplate;
      const body = await backend.getBody(id);
      if (!body) return null;
      const r = parseTemplate(body);
      if (!r.ok) return null;
      get().cache.set(id, r.template);
      return r.template;
    },

    exportText: async (id) => {
      const e = get().all().find((x) => x.id === id);
      if (!e) return null;
      if (e.kind === 'blueprint') { const bp = await get().loadBlueprint(id); return bp ? serializeBlueprint(bp) : null; }
      const t = await get().loadTemplate(id);
      return t ? serializeTemplate(t) : null;
    },

    checkImport: (text) => {
      let format: unknown = null;
      try { format = (JSON.parse(text) as { format?: unknown })?.format; } catch { /* reported below */ }
      if (format === 'disaster-sim/world-template') {
        const r = parseTemplate(text);
        if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
        const existing = get().all().find((e) => e.id === r.template.id) ?? null;
        const same = existing ? existing.hash === hashText(serializeTemplate(r.template)) : false;
        return { ok: true, kind: 'world', template: r.template, duplicate: existing ? { sameContent: same, existing } : null, bytes: text.length, skipped: r.skipped };
      }
      const r = parseBlueprintText(text);
      if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
      const hash = blueprintHash(r.blueprint);
      const existing = get().all().find((e) => e.id === r.blueprint.id) ?? get().entries.find((e) => e.hash === hash) ?? null;
      return { ok: true, kind: 'blueprint', blueprint: r.blueprint, report: r.report, duplicate: existing ? { sameContent: existing.hash === hash, existing } : null, bytes: text.length };
    },

    commitImport: async (check, mode) => {
      const now = new Date().toISOString();
      if (check.kind === 'blueprint') {
        let bp = check.blueprint;
        const clash = get().all().some((e) => e.id === bp.id);
        if (clash && (mode === 'copy' || isBuiltinId(bp.id))) bp = { ...bp, id: createId('bp'), meta: { ...bp.meta, updatedAt: now } };
        return get().saveBlueprint(bp);
      }
      let t = check.template;
      const clash = get().all().some((e) => e.id === t.id);
      if (clash && (mode === 'copy' || isBuiltinId(t.id))) t = { ...t, id: createId('tpl'), meta: { ...t.meta, updatedAt: now } };
      return get().saveTemplate(t);
    },
  };
});

/** Counts of a template's world (for entries built from documents). */
export { templateCounts };

/** Sort for the "recent" row: most recently used first. */
export const recentEntries = (entries: readonly LibraryEntry[], n = 8) => entries.filter((e) => e.lastUsedAt).sort((a, b) => (a.lastUsedAt! < b.lastUsedAt! ? 1 : -1)).slice(0, n);
