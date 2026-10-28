import { z } from 'zod';
import { SCHEMA_VERSION, defaultScenario } from './WorldDocument';
import { DEFAULT_WIND_MODEL, defaultSimulationSettings, type WorldDocument, type WorldObject } from '@/core/model';
import { earthquakeEventSchema } from '@/events/earthquake/earthquakeSchema';
import { normalizeSeismic } from '@/simulation/seismic/structuralProps';
import { getDefinition, hasDefinition } from '@/objects/registry';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { decodeTerrain, encodeTerrain } from '@/terrain/terrainCodec';
import { TERRAIN_PRESETS } from '@/terrain/TerrainPresets';

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
  // Phase 13 (schema v3). Validated leniently and normalized (defaults / clamping) below.
  seismic: z.object({ structure: z.record(z.string(), z.any()).optional(), foundation: z.record(z.string(), z.any()).optional() }).optional(),
});

const terrainSchema = z.union([
  // Schema v1 (Phase 0–11): always flat.
  z.object({ kind: z.literal('flat') }),
  z.object({
    kind: z.literal('heightfield'),
    nx: z.number().int().min(2).max(2001),
    nz: z.number().int().min(2).max(2001),
    cellSize: z.number().positive(),
    originX: z.number(),
    originZ: z.number(),
    elevation: z.object({ encoding: z.literal('cm-delta-rle'), data: z.string() }).nullable(),
    ground: z.object({ encoding: z.literal('u8-rle'), data: z.string() }).nullable(),
    // Phase 13: soil profile layer (absent in v2 files → default soil everywhere).
    soil: z.object({ encoding: z.literal('u8-rle'), data: z.string() }).nullable().optional(),
    settings: z.object({
      preset: z.enum(TERRAIN_PRESETS as [string, ...string[]]).catch('flat'),
      seed: z.number().int().nonnegative().catch(1),
      waterLevel: z.number().nullable().catch(null),
    }).partial().default({}),
  }),
]);

const documentSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  meta: z.object({ name: z.string(), createdAt: z.string(), updatedAt: z.string() }),
  settings: z.object({
    size: z.tuple([z.number(), z.number()]),
    gravity: z.number(),
    airDensity: z.number(),
    // Added in Phase 8 — older files get defaults.
    simulation: z
      .object({
        seed: z.number().int().nonnegative(),
        wind: z.object({
          shelterEnabled: z.boolean(),
          shadowStrength: z.number().min(0).max(0.95),
          wakeLength: z.number().min(0),
          wakeRecovery: z.number().positive(),
          wakeSpread: z.number().min(0),
          cornerSpeedup: z.number().min(0),
          turbulence: z.number().min(0).max(1),
        }).partial().optional(),
      })
      .partial()
      .optional(),
  }),
  terrain: terrainSchema.default({ kind: 'flat' }),
  objects: z.record(z.string(), objectSchema),
  // Phase 13: saved hazard scenarios. An invalid earthquake is dropped rather than failing the file.
  scenario: z.object({ earthquake: earthquakeEventSchema.nullable().catch(null).default(null) }).partial().optional(),
});

export type LoadResult = { ok: true; doc: WorldDocument; skipped: number } | { ok: false; error: string };

/** JSON-ready copy of a document (terrain layers → compact encoded strings). */
export function toSerializable(doc: WorldDocument) {
  return { ...doc, schemaVersion: SCHEMA_VERSION, terrain: encodeTerrain(doc.terrain) };
}

export function serializeDocument(doc: WorldDocument, pretty = true): string {
  return JSON.stringify(toSerializable(doc), null, pretty ? 2 : undefined);
}

/**
 * Validate + normalize a document. Unknown object types are skipped and components are
 * regenerated from params so files stay consistent with the current object definitions.
 *
 * Migration (automatic, any older schema → v3):
 *   v1 → flat terrain;  v1/v2 → default soil layer (dense soil), default structural and
 *   foundation properties on buildings, empty scenario. Positions, physics, terrain heights
 *   and surfaces are kept exactly, so wind results of old projects do not change.
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
    const { seismic: rawSeismic, ...rest } = o;
    const obj: WorldObject = {
      ...rest,
      id,
      type: o.type,
      params,
      components: def.createComponents(params, o.seed),
    };
    const seismic = normalizeSeismic(o.type, rawSeismic as Parameters<typeof normalizeSeismic>[1]);
    if (seismic) obj.seismic = seismic;
    objects[id] = obj;
  }
  // Old (v1) files and missing terrain → flat terrain at 0 m.
  let terrain;
  try {
    terrain = res.data.terrain.kind === 'flat' ? createFlatTerrain() : decodeTerrain(res.data.terrain as Parameters<typeof decodeTerrain>[0]);
  } catch (e) {
    return { ok: false, error: `terrain: ${(e as Error).message}` };
  }
  const defaults = defaultSimulationSettings();
  const sim = res.data.settings.simulation;
  const settings = {
    ...res.data.settings,
    simulation: { seed: sim?.seed ?? defaults.seed, wind: { ...DEFAULT_WIND_MODEL, ...(sim?.wind ?? {}) } },
  };
  const scenario = { ...defaultScenario(), ...(res.data.scenario ?? {}) };
  return { ok: true, doc: { ...res.data, schemaVersion: SCHEMA_VERSION, settings, terrain, objects, scenario }, skipped };
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
  autosave: (doc: WorldDocument) => safeSet(AUTOSAVE_KEY, serializeDocument(doc, false)),
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
