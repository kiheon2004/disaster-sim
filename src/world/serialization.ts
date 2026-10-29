import { z } from 'zod';
import { SCHEMA_VERSION, defaultScenario } from './WorldDocument';
import { DEFAULT_WIND_MODEL, defaultFloodScenario, defaultSimulationSettings, defaultWaterSettings, type WaterSettings, type WorldDocument, type WorldObject } from '@/core/model';
import { earthquakeEventSchema } from '@/events/earthquake/earthquakeSchema';
import { rainEventSchema, risingWaterEventSchema, waterSourceEventSchema } from '@/events/flood/floodSchema';
import { parseExperiment } from '@/phenomena/experimentSchema';
import { normalizeSeismic } from '@/simulation/seismic/structuralProps';
import { getDefinition, hasDefinition } from '@/objects/registry';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { decodeTerrain, encodeTerrain } from '@/terrain/terrainCodec';
import { TERRAIN_PRESETS } from '@/terrain/TerrainPresets';
import { parseDesign } from '@/buildings/schema';
import { deriveFields } from '@/buildings/design';

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
  // Phase 16: editing group (optional; still schema v5 — older readers simply drop it).
  group: z.string().min(1).max(80).optional().catch(undefined),
  // Phase 17: modular building design (validated by buildings/schema) and slope alignment.
  building: z.unknown().optional(),
  terrainAlign: z.number().min(0).max(1).optional().catch(undefined),
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

const boundarySchema = z.object({
  type: z.enum(['auto', 'closed', 'open', 'fixedLevel']).catch('auto'),
  level: z.number().min(-100).max(200).optional().catch(undefined),
});

/** Phase 14 water settings: validated leniently (bad fields fall back to defaults). */
const waterSchema = z.object({
  boundaries: z.object({ N: boundarySchema, E: boundarySchema, S: boundarySchema, W: boundarySchema }).partial(),
  infiltration: z.boolean(),
  infiltrationScale: z.number().min(0).max(10),
  drainageCapacity: z.number().min(0).max(500),
  roughnessScale: z.number().min(0.1).max(10),
  initialFromReference: z.boolean(),
}).partial();

/** Phase 14 flood scenario: an invalid event is dropped rather than failing the file. */
const floodScenarioSchema = z.object({
  rain: rainEventSchema.nullable().catch(null).default(null),
  risingWater: risingWaterEventSchema.nullable().catch(null).default(null),
  sources: z.array(z.unknown()).catch([]).default([]).transform((a) => a.flatMap((x) => {
    const r = waterSourceEventSchema.safeParse(x);
    return r.success ? [r.data] : [];
  })),
  enabled: z.object({ rain: z.boolean(), risingWater: z.boolean(), sources: z.boolean() }).partial().catch({}).default({}),
}).partial();

function normalizeWater(raw: z.infer<typeof waterSchema> | undefined): WaterSettings {
  const d = defaultWaterSettings();
  if (!raw) return d;
  const b = raw.boundaries ?? {};
  return {
    ...d,
    ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => k !== 'boundaries' && v !== undefined)),
    boundaries: { N: b.N ?? d.boundaries.N, E: b.E ?? d.boundaries.E, S: b.S ?? d.boundaries.S, W: b.W ?? d.boundaries.W },
  } as WaterSettings;
}

const documentSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
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
        // Phase 14: water model settings (absent before v4 → defaults).
        water: waterSchema.optional().catch(undefined),
        // Phase 15: multi-hazard interactions (absent before v5 → off, see parseDocument).
        interactions: z.object({ enabled: z.boolean() }).optional().catch(undefined),
      })
      .partial()
      .optional(),
  }),
  terrain: terrainSchema.default({ kind: 'flat' }),
  objects: z.record(z.string(), objectSchema),
  // Phase 13: saved hazard scenarios. An invalid earthquake is dropped rather than failing the file.
  scenario: z.object({
    earthquake: earthquakeEventSchema.nullable().catch(null).default(null),
    flood: floodScenarioSchema.optional().catch(undefined),
    // Phase 15: experiment plan, validated per instance in parseExperiment().
    experiment: z.unknown().optional(),
  }).partial().optional(),
});

/**
 * Phase 17: modular building designs that could not be read completely. `invalidDesigns`: the
 * design was unusable — the object stays a legacy building built from its saved params;
 * `droppedMembers` / `repairedMembers`: individual members removed / repaired in valid designs.
 */
export interface DesignLoadReport {
  invalidDesigns: number;
  droppedMembers: number;
  repairedMembers: number;
}

export type LoadResult = { ok: true; doc: WorldDocument; skipped: number; designs: DesignLoadReport } | { ok: false; error: string };

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
 * Migration (automatic, any older schema → v4):
 *   v1 → flat terrain;  v1/v2 → default soil layer (dense soil), default structural and
 *   foundation properties on buildings, empty scenario;  v1–v3 → default water settings
 *   (all edges 'auto', infiltration on, 30 mm/h drainage) and an empty flood scenario;
 *   v1–v4 → empty experiment and multi-hazard interactions OFF, so a combined scenario saved
 *   before Phase 15 reproduces exactly (the user can switch interactions on).
 *   Positions, physics, terrain heights and surfaces are kept exactly, so wind and earthquake
 *   results of old projects do not change.
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
  const designs: DesignLoadReport = { invalidDesigns: 0, droppedMembers: 0, repairedMembers: 0 };
  for (const [id, o] of Object.entries(res.data.objects)) {
    if (!hasDefinition(o.type)) {
      skipped++;
      continue;
    }
    const def = getDefinition(o.type);
    const params = { ...def.defaultParams, ...o.params };
    const { seismic: rawSeismic, group, building: rawBuilding, terrainAlign, ...rest } = o;
    const obj: WorldObject = {
      ...rest,
      id,
      type: o.type,
      params,
      components: def.createComponents(params, o.seed),
    };
    const seismic = normalizeSeismic(o.type, rawSeismic as Parameters<typeof normalizeSeismic>[1]);
    if (seismic) obj.seismic = seismic;
    if (group) obj.group = group;
    if (terrainAlign !== undefined) obj.terrainAlign = terrainAlign;
    if (rawBuilding !== undefined && o.type === 'building') {
      const r = parseDesign(rawBuilding);
      designs.droppedMembers += r.dropped;
      designs.repairedMembers += r.repaired;
      if (r.design) {
        // Derived fields follow the design; saved physics (incl. manual overrides) are kept.
        const d = deriveFields(r.design, o.seed, obj.seismic);
        obj.building = r.design;
        obj.params = d.params;
        obj.components = d.components;
        obj.seismic = d.seismic;
      } else designs.invalidDesigns++;
    }
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
    simulation: {
      seed: sim?.seed ?? defaults.seed,
      wind: { ...DEFAULT_WIND_MODEL, ...(sim?.wind ?? {}) },
      water: normalizeWater(sim?.water),
      interactions: { enabled: sim?.interactions?.enabled ?? res.data.schemaVersion >= 5 },
    },
  };
  const rawFlood = res.data.scenario?.flood;
  const floodDefaults = defaultFloodScenario();
  const flood = {
    rain: rawFlood?.rain ?? null,
    risingWater: rawFlood?.risingWater ?? null,
    sources: rawFlood?.sources ?? [],
    enabled: { ...floodDefaults.enabled, ...(rawFlood?.enabled ?? {}) },
  };
  const scenario = { ...defaultScenario(), earthquake: res.data.scenario?.earthquake ?? null, flood, experiment: parseExperiment(res.data.scenario?.experiment) };
  return { ok: true, doc: { ...res.data, schemaVersion: SCHEMA_VERSION, settings, terrain, objects, scenario }, skipped, designs };
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
