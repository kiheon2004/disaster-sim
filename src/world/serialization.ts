import { normalizePhysiology, physiologySchema } from '@/physiology/settings';
import { normalizeVehicles, vehicleSchema } from '@/vehicle/settings';
import { AMBIENT_LIMITS } from '@/thermal/units';
import { MOISTURE_LIMITS } from '@/fire/types';
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
import type { BuildingDesign } from '@/buildings/types';
import { parseLink, parseNetwork, serializeNetwork, type RoadLoadReport } from '@/roads/schema';
import { rebakeAll } from '@/roads/sync';
import { bakeRegion } from '@/roads/bake';
import { fullRect } from '@/terrain/TerrainData';
import { parseLandscape, serializeLandscape, type LandscapeLoadReport } from '@/landscape/schema';
import { composeAll } from '@/landscape/compose';
import { adoptTerrain, naturalProvider } from '@/landscape/apply';

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
  // Phase 18: link to a road segment (validated by roads/schema; dangling links are dropped).
  roadLink: z.unknown().optional(),
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
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
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
        // Phase 19: vegetation options (absent = off).
        vegetation: z.object({ canopyShelter: z.boolean(), floodResponse: z.boolean() }).partial().optional().catch(undefined),
        // Phase 26: thermal settings (absent = defaults; invalid values are dropped, not fixed).
        thermal: z.object({
          ambient: z.number().min(AMBIENT_LIMITS[0]).max(AMBIENT_LIMITS[1]),
          airLayerHeight: z.number().min(2).max(50),
          restraint: z.enum(['frame', 'full', 'none']),
        }).optional().catch(undefined),
        // Phase 27: fire settings (absent = defaults; invalid values are dropped, not fixed).
        fire: z.object({
          foliageMoisture: z.number().min(MOISTURE_LIMITS[0]).max(MOISTURE_LIMITS[1]),
          openings: z.enum(['asBuilt', 'windowsOpen', 'closed']),
          heatIgnition: z.boolean().optional(),
        }).optional().catch(undefined),
        // Phase 33: extended human model (absent = legacy people; invalid values are dropped, not fixed).
        humans: z.object({ model: z.literal('extended'), riskScale: z.number().min(0.5).max(2).optional() }).optional().catch(undefined),
        // Phase 34: physiology (absent = none; invalid values are dropped, not fixed; needs `humans`, checked below).
        physiology: physiologySchema.optional().catch(undefined),
        // Phase 35: vehicle dynamics (absent = legacy cars; invalid values are dropped, not fixed).
        vehicles: vehicleSchema.optional().catch(undefined),
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
  // Phase 18 (v6): road network and the shared modular-design table.
  roads: z.unknown().optional(),
  designs: z.record(z.string(), z.unknown()).optional(),
  // Phase 19 (v7): terrain layers and natural features.
  landscape: z.unknown().optional(),
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

export type LoadResult = { ok: true; doc: WorldDocument; skipped: number; designs: DesignLoadReport; roads: RoadLoadReport; landscape: LandscapeLoadReport & { recomposedVertices: number } } | { ok: false; error: string };

/**
 * A design written with one fixed key order per member (Phase 19): the file then does not
 * depend on how the design was produced (generator paths, loaded files), so
 * save → load → save is byte-identical. Values are untouched.
 */
const MEMBER_KEYS = ['id', 'type', 'role', 'level', 'position', 'rotation', 'size', 'material', 'host', 'facade', 'initialDamage'] as const;
const canonicalCache = new WeakMap<BuildingDesign, BuildingDesign>();
function canonicalDesign(d: BuildingDesign): BuildingDesign {
  let c = canonicalCache.get(d);
  if (c) return c;
  const members = d.members.map((m) => {
    const out: Record<string, unknown> = {};
    for (const k of MEMBER_KEYS) if (m[k] !== undefined) out[k] = m[k];
    for (const k of Object.keys(m)) if (!(k in out)) out[k] = (m as unknown as Record<string, unknown>)[k];
    return out as unknown as BuildingDesign['members'][number];
  });
  c = { ...d, members };
  canonicalCache.set(d, c);
  return c;
}

/** Reference to an entry of the shared design table (v6). */
const DESIGN_REF = '$design';

/**
 * JSON-ready copy of a document (terrain layers → compact encoded strings).
 *
 * v6 size measures (Phase 17 residual B) — both lossless:
 *  - `components` are not written: the loader always regenerates them from params / design
 *    (it did so since Phase 8 — the saved copy was never read);
 *  - a modular design used by two or more objects (copies of one preset, generated
 *    neighbourhoods) is written ONCE in `designs` and referenced as {"$design": "d<k>"}.
 *    Designs used once stay inline, exactly as in v5.
 */
export function toSerializable(doc: WorldDocument) {
  const uses = new Map<BuildingDesign, number>();
  for (const o of Object.values(doc.objects)) if (o.building) uses.set(o.building, (uses.get(o.building) ?? 0) + 1);
  const table: Record<string, BuildingDesign> = {};
  const refOf = new Map<BuildingDesign, string>();
  for (const [design, n] of uses) {
    if (n < 2) continue;
    const id = `d${refOf.size + 1}`;
    refOf.set(design, id);
    table[id] = canonicalDesign(design);
  }
  const objects: Record<string, unknown> = {};
  for (const [id, o] of Object.entries(doc.objects)) {
    const { components: _c, ...rest } = o;
    void _c;
    const ref = o.building ? refOf.get(o.building) : undefined;
    objects[id] = ref ? { ...rest, building: { [DESIGN_REF]: ref } } : o.building ? { ...rest, building: canonicalDesign(o.building) } : rest;
  }
  const out: Record<string, unknown> = { ...doc, schemaVersion: SCHEMA_VERSION, terrain: encodeTerrain(doc.terrain), objects, roads: serializeNetwork(doc.roads), landscape: serializeLandscape(adoptTerrain(doc.terrain, doc.roads, doc.landscape), doc.terrain.nx) };
  if (refOf.size) out.designs = table;
  return out;
}

export function serializeDocument(doc: WorldDocument, pretty = true): string {
  return JSON.stringify(toSerializable(doc), null, pretty ? 2 : undefined);
}

/**
 * Validate + normalize a document. Unknown object types are skipped and components are
 * regenerated from params so files stay consistent with the current object definitions.
 *
 * Migration (automatic, any older schema → v6):
 *   v1 → flat terrain;  v1/v2 → default soil layer (dense soil), default structural and
 *   foundation properties on buildings, empty scenario;  v1–v3 → default water settings
 *   (all edges 'auto', infiltration on, 30 mm/h drainage) and an empty flood scenario;
 *   v1–v4 → empty experiment and multi-hazard interactions OFF, so a combined scenario saved
 *   before Phase 15 reproduces exactly (the user can switch interactions on);
 *   v1–v5 → an empty road network (Phase 18): legacy 'road' objects stay objects — they are
 *   converted only on request (Road tab → convert), never silently.
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
  // Identical designs in the file (copies of one preset) become one shared, immutable object.
  const sharedDesigns = new Map<string, NonNullable<WorldObject['building']>>();
  // v6 design table: each entry is validated once and shared by every object referencing it.
  const tableDesigns = new Map<string, ReturnType<typeof parseDesign> | null>();
  const tableDesign = (key: string) => {
    if (!tableDesigns.has(key)) {
      const raw = res.data.designs?.[key];
      tableDesigns.set(key, raw === undefined ? null : parseDesign(raw));
    }
    return tableDesigns.get(key) ?? null;
  };
  for (const [id, o] of Object.entries(res.data.objects)) {
    if (!hasDefinition(o.type)) {
      skipped++;
      continue;
    }
    const def = getDefinition(o.type);
    const params = { ...def.defaultParams, ...o.params };
    const { seismic: rawSeismic, group, building: rawBuilding, terrainAlign, roadLink: rawLink, ...rest } = o;
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
    const link = rawLink === undefined ? undefined : parseLink(rawLink);
    if (rawBuilding !== undefined && o.type === 'building') {
      const refKey = rawBuilding && typeof rawBuilding === 'object' && DESIGN_REF in rawBuilding ? String((rawBuilding as Record<string, unknown>)[DESIGN_REF]) : null;
      const counted = refKey !== null && tableDesigns.has(refKey);
      const r = refKey !== null ? tableDesign(refKey) ?? { design: null, dropped: 0, repaired: 0 } : parseDesign(rawBuilding);
      // Member repairs of a shared table entry are counted once.
      if (!counted) {
        designs.droppedMembers += r.dropped;
        designs.repairedMembers += r.repaired;
      }
      if (r.design) {
        // Table entries are shared already; inline designs are deduplicated by content.
        let design = r.design;
        if (refKey === null) {
          const key = JSON.stringify(r.design);
          design = sharedDesigns.get(key) ?? r.design;
          sharedDesigns.set(key, design);
        }
        // Derived fields follow the design; saved physics (incl. manual overrides) are kept.
        const d = deriveFields(design, o.seed, obj.seismic);
        obj.building = design;
        obj.params = d.params;
        obj.components = d.components;
        obj.seismic = d.seismic;
      } else designs.invalidDesigns++;
    }
    // (After `building`: the key order of a created object, so save → load → save is identical.)
    if (link) obj.roadLink = link;
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
      ...(sim?.thermal ? { thermal: { ...sim.thermal } } : {}),
      ...(sim?.fire ? { fire: { ...sim.fire, heatIgnition: !!sim.fire.heatIgnition } } : {}),
      ...(sim?.vegetation ? { vegetation: { canopyShelter: !!sim.vegetation.canopyShelter, floodResponse: !!sim.vegetation.floodResponse } } : {}),
      ...(sim?.humans ? { humans: { model: 'extended' as const, ...(sim.humans.riskScale !== undefined ? { riskScale: sim.humans.riskScale } : {}) } } : {}),
      ...(sim?.humans && sim?.physiology ? { physiology: normalizePhysiology(sim.physiology) } : {}),
      ...(sim?.vehicles ? { vehicles: normalizeVehicles(sim.vehicles) } : {}),
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
  // Roads (v6; older files → no roads, terrain untouched). The saved terrain already carries
  // the baked roads. If parts of the network had to be dropped, the natural ground is restored
  // from the underlay and the remaining roads are baked again, so terrain and network agree.
  const { network, report: roads } = parseNetwork(res.data.roads, terrain.nx * terrain.nz);
  let net = network;
  if (roads.droppedSegments > 0 && !roads.underlayLost) {
    net.underlay.idx.forEach((i, k) => { terrain.heights[i] = net.underlay.h[k]; terrain.ground[i] = net.underlay.g[k]; });
    net = rebakeAll(terrain, { ...net, underlay: { idx: [], h: [], g: [] } });
  }
  // Links to segments that do not exist are dropped (the object stays where it is).
  for (const obj of Object.values(objects)) if (obj.roadLink && !net.segments[obj.roadLink.segment]) delete obj.roadLink;
  // Terrain layers (v7). Older files: the natural terrain (saved terrain with the road underlay
  // put back) becomes the base — no sculpt, paint or features; the terrain itself is unchanged.
  const natural = { heights: terrain.heights.slice(), ground: terrain.ground.slice() };
  net.underlay.idx.forEach((i, k) => { natural.heights[i] = net.underlay.h[k]; natural.ground[i] = net.underlay.g[k]; });
  const { landscape, report: lrep } = parseLandscape(res.data.landscape, terrain, natural);
  let recomposedVertices = 0;
  if (res.data.landscape !== undefined && !lrep.rebuilt) {
    // The layers are the truth: compose them and bake the roads on top; count any vertex that
    // differs from the saved terrain (0 for files written by this version).
    composeAll(landscape, terrain, terrain.settings.waterLevel ?? 0);
    const saved = { h: terrain.heights.slice(), g: terrain.ground.slice() };
    const r = bakeRegion(terrain, net, net, fullRect(terrain), naturalProvider(landscape));
    net = { ...net, underlay: r.underlay };
    for (let i = 0; i < saved.h.length; i++) if (saved.h[i] !== terrain.heights[i] || saved.g[i] !== terrain.ground[i]) recomposedVertices++;
  }
  const { designs: _table, roads: _rawRoads, landscape: _rawLand, ...data } = res.data;
  void _table;
  void _rawRoads;
  void _rawLand;
  return { ok: true, doc: { ...data, schemaVersion: SCHEMA_VERSION, settings, terrain, objects, scenario, roads: net, landscape }, skipped, designs, roads, landscape: { ...lrep, recomposedVertices } };
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
