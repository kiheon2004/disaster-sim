import { z } from 'zod';
import type { WorldDocument, WorldObject } from '@/core/model';
import { getDefinition, hasDefinition } from '@/objects/registry';
import { SCHEMA_VERSION } from './WorldDocument';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

const physicsSchema = z.object({
  mass: z.number().positive(),
  friction: z.number().min(0),
  restitution: z.number().min(0),
  anchored: z.boolean(),
  dragCoefficient: z.number().positive(),
  windResistance: z.number().positive(),
  durability: z.number().min(0),
  breakThreshold: z.number().positive(),
  frontalAreaOverride: z.number().positive().optional(),
});

const objectSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  name: z.string().default(''),
  serial: z.number().int().nonnegative().default(1),
  seed: z.number().default(1),
  transform: z.object({ position: vec3, rotation: vec3, scale: vec3 }),
  physics: physicsSchema,
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  components: z.array(z.any()).optional(),
});

const documentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  meta: z.object({ name: z.string(), createdAt: z.string(), updatedAt: z.string() }),
  settings: z.object({
    size: z.tuple([z.number(), z.number()]),
    gravity: z.number(),
    airDensity: z.number(),
  }),
  terrain: z.object({ kind: z.literal('flat') }),
  objects: z.record(z.string(), objectSchema),
});

export type LoadResult = { ok: true; doc: WorldDocument; skipped: number } | { ok: false; error: string };

export function serializeDocument(doc: WorldDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Validate + normalize a document. Unknown object types are skipped and components are
 * regenerated from params so files stay consistent with the current object definitions.
 */
export function parseDocument(json: string): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const res = documentSchema.safeParse(raw);
  if (!res.success) {
    const issue = res.error.issues[0];
    return { ok: false, error: `${issue.path.join('.')}: ${issue.message}` };
  }
  const objects: Record<string, WorldObject> = {};
  let skipped = 0;
  for (const [id, o] of Object.entries(res.data.objects)) {
    if (!hasDefinition(o.type)) {
      skipped++;
      continue;
    }
    const def = getDefinition(o.type);
    const params = { ...def.defaultParams, ...o.params };
    objects[id] = {
      ...o,
      id,
      type: o.type,
      params,
      components: def.createComponents(params, o.seed),
    };
  }
  return { ok: true, doc: { ...res.data, objects }, skipped };
}

const SAVE_KEY = 'ds.project';
const AUTOSAVE_KEY = 'ds.autosave';

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const storage = {
  save: (doc: WorldDocument) => safeSet(SAVE_KEY, serializeDocument(doc)),
  load: (): LoadResult | null => {
    const s = safeGet(SAVE_KEY);
    return s ? parseDocument(s) : null;
  },
  hasSave: () => safeGet(SAVE_KEY) !== null,
  autosave: (doc: WorldDocument) => safeSet(AUTOSAVE_KEY, JSON.stringify(doc)),
  loadAutosave: (): LoadResult | null => {
    const s = safeGet(AUTOSAVE_KEY);
    return s ? parseDocument(s) : null;
  },
};

export function downloadDocument(doc: WorldDocument) {
  const blob = new Blob([serializeDocument(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = (doc.meta.name || 'world').replace(/[^\w\-가-힣]+/g, '_');
  a.href = url;
  a.download = `${base}.world.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickDocumentFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}
