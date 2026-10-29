/**
 * Blueprint files (Phase 20): validation, migration and canonical serialization.
 *
 * Reading is STRICT about structure and references (a blueprint that would place broken roads,
 * dangling links or missing designs is refused with a reason) and lenient only where Phase 6–19
 * files are lenient (out-of-range parameters are clamped, invalid building members are dropped
 * and counted). Imported data is never executed: plain JSON.parse + schema validation, size and
 * count limits checked before anything is built, prototype keys refused, thumbnails restricted
 * to base64 raster data URLs (never SVG / HTML).
 *
 * Versions
 *   v2            this format (UnifiedBlueprint)
 *   v1            Phase 16–18 copy / paste payload (objects + index-based roads) → migrated
 *   nature-region Phase 19 region (features + sculpt / paint) → migrated
 *   v3+           read when its `minReaderVersion` ≤ 2 (fields this reader does not know are kept
 *                 verbatim and reported); refused otherwise
 *
 * Unknown data is never dropped silently: unknown top-level fields, entries of unknown types /
 * kinds and unknown fields of known entries are kept in `unsupported`, reported, and written
 * back by serializeBlueprint.
 */
import { z } from 'zod';
import type { ObjectType } from '@/core/types';
import { hasDefinition, getDefinition } from '@/objects/registry';
import { parseDesign } from '@/buildings/schema';
import { featureSchema } from '@/landscape/schema';
import { profileSchema } from '@/roads/schema';
import { defaultProfile, LINK_POLICIES, ZONE_TYPES, type RoadProfile } from '@/roads/types';
import type { BuildingDesign } from '@/buildings/types';
import type { Feature } from '@/landscape/types';
import { decodeElevation, decodeGround } from '@/terrain/terrainCodec';
import { NATURE_REGION_FORMAT } from '@/landscape/region';
import { createId } from '@/core/id';
import {
  BLUEPRINT_CATEGORIES, BLUEPRINT_FORMAT, BLUEPRINT_VERSION, MIN_READER_VERSION,
  type BlueprintCategory, type BlueprintItem, type BlueprintRoads, type BlueprintTerrain, type DependencyKind, type UnifiedBlueprint, type UnsupportedData,
} from './types';

// ── Limits ─────────────────────────────────────────────────────────────────

export const LIMITS = {
  fileBytes: 64 * 1024 * 1024,
  objects: 20_000,
  vegetation: 50_000,
  designs: 5_000,
  nodes: 5_000,
  segments: 5_000,
  features: 500,
  attachments: 50_000,
  dependencies: 10_000,
  areaPoints: 512,
  gridSide: 2001,
  tags: 32,
  tag: 40,
  name: 120,
  description: 4_000,
  thumbnail: 512 * 1024,
  coordinate: 100_000,
} as const;

export type ParseErrorCode = 'json' | 'tooLarge' | 'format' | 'version' | 'schema' | 'reference' | 'limits' | 'unsafe';

export interface BlueprintParseReport {
  /** Source format when the file was migrated. */
  migratedFrom: 'v1' | 'nature-region' | null;
  /** Version of a newer writer (read through its minReaderVersion), or null. */
  newerVersion: number | null;
  /** Names of fields / entries this version keeps but does not use. */
  unsupported: string[];
  unsupportedObjects: number;
  unsupportedFeatures: number;
  droppedMembers: number;
  repairedMembers: number;
  /** Parameters outside their limits that were clamped (features, road profiles). */
  clamped: number;
}

export type BlueprintParseResult = { ok: true; blueprint: UnifiedBlueprint; report: BlueprintParseReport } | { ok: false; code: ParseErrorCode; detail: string };

const fail = (code: ParseErrorCode, detail: string): BlueprintParseResult => ({ ok: false, code, detail });

// ── Schemas ────────────────────────────────────────────────────────────────

const coord = z.number().refine((v) => Number.isFinite(v) && Math.abs(v) <= LIMITS.coordinate, 'coordinate out of range');
const p2 = z.tuple([coord, coord]);
const vec3 = z.tuple([coord, coord, coord]);
const localId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}\\d{1,9}$`));
const ISO = z.string().max(40);

const itemKeys = ['id', 'type', 'name', 'seed', 'params', 'physics', 'seismic', 'offset', 'rotation', 'scale', 'grounded', 'base', 'group', 'design', 'terrainAlign'] as const;
const itemSchema = z.object({
  id: z.string().regex(/^[ov]\d{1,9}$/),
  type: z.string().max(40),
  name: z.string().max(LIMITS.name).catch(''),
  seed: z.number().int().refine(Number.isFinite),
  params: z.record(z.string().max(60), z.union([z.number().refine(Number.isFinite), z.string().max(200), z.boolean()])).optional(),
  physics: z.record(z.string().max(60), z.union([z.number().refine(Number.isFinite), z.boolean()])).optional(),
  seismic: z.object({ structure: z.record(z.string(), z.unknown()), foundation: z.record(z.string(), z.unknown()) }).optional().catch(undefined),
  offset: vec3,
  rotation: vec3,
  scale: z.tuple([z.number().min(0.01).max(100), z.number().min(0.01).max(100), z.number().min(0.01).max(100)]),
  grounded: z.boolean(),
  base: coord.catch(0),
  group: localId('g').optional(),
  design: localId('d').optional(),
  terrainAlign: z.number().min(0).max(1).optional().catch(undefined),
});

const nodeKeys = ['id', 'x', 'z', 'y'] as const;
const nodeSchema = z.object({ id: localId('n'), x: coord, z: coord, y: coord.nullable() });
const segmentKeys = ['id', 'a', 'b', 'control', 'profile', 'condition'] as const;
const segmentSchema = z.object({
  id: localId('s'),
  a: localId('n'),
  b: localId('n'),
  control: z.array(p2).max(64),
  profile: profileSchema,
  condition: z.number().min(0).max(1).optional().catch(undefined),
});
const attachmentKeys = ['object', 'segment', 't', 'lateral', 'yaw', 'policy'] as const;
const attachmentSchema = z.object({
  object: z.string().regex(/^[ov]\d{1,9}$/),
  segment: localId('s'),
  t: z.number().min(0).max(1),
  lateral: coord,
  yaw: coord,
  policy: z.enum(LINK_POLICIES as [string, ...string[]]),
});

const DEP_KINDS: readonly DependencyKind[] = ['roadExternal', 'roadPartial', 'riverInflowOutside', 'riverOutletOutside', 'riverPartial', 'lakePartial', 'landformPartial', 'coastExcluded', 'foundationSupport', 'sharedDesign', 'externalLink', 'groupPartial', 'objectCrossesBoundary', 'seaLevel'];
const dependencySchema = z.object({
  kind: z.enum(DEP_KINDS as [string, ...string[]]),
  refs: z.array(z.string().max(16)).max(LIMITS.objects + LIMITS.vegetation),
  resolution: z.enum(['kept', 'clipped', 'dropped', 'detached', 'copied', 'info']),
  value: z.number().refine(Number.isFinite).optional(),
});

const terrainSchema = z.object({
  grid: z.object({
    x0: coord, z0: coord,
    nx: z.number().int().min(2).max(LIMITS.gridSide),
    nz: z.number().int().min(2).max(LIMITS.gridSide),
    cell: z.number().min(0.25).max(10),
  }),
  surface: z.string().nullable(),
  sculpt: z.string().nullable(),
  paint: z.string().nullable(),
  ground: z.string().nullable(),
  soil: z.string().nullable(),
  mask: z.string().nullable(),
});

const THUMB = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const metaSchema = z.object({
  name: z.string().max(LIMITS.name),
  description: z.string().max(LIMITS.description).catch(''),
  category: z.enum(BLUEPRINT_CATEGORIES as [BlueprintCategory, ...BlueprintCategory[]]).catch('mixed'),
  tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags).catch([]),
  author: z.string().max(LIMITS.name).optional().catch(undefined),
  createdAt: ISO.catch(''),
  updatedAt: ISO.catch(''),
});

const previewSchema = z.object({
  size: z.tuple([coord, coord]),
  bounds: z.tuple([coord, coord, coord, coord]),
  relief: z.tuple([coord, coord]).catch([0, 0]),
  counts: z.object({ objects: z.number().int().min(0), buildings: z.number().int().min(0), vegetation: z.number().int().min(0), roads: z.number().int().min(0), features: z.number().int().min(0), water: z.number().int().min(0) }).partial().catch({}),
  thumbnail: z.string().max(LIMITS.thumbnail).refine((s) => THUMB.test(s), 'thumbnail must be a base64 png / jpeg / webp data URL').nullable().catch(null),
});

const TOP_KEYS = ['format', 'version', 'minReaderVersion', 'id', 'meta', 'origin', 'area', 'objects', 'vegetation', 'designs', 'roads', 'attachments', 'features', 'terrain', 'dependencies', 'preview'] as const;
const topSchema = z.object({
  format: z.literal(BLUEPRINT_FORMAT),
  version: z.number().int().min(2),
  minReaderVersion: z.number().int().min(1).default(MIN_READER_VERSION),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  meta: metaSchema,
  origin: z.object({ datum: coord, seaLevel: coord.nullable().catch(null) }),
  area: z.array(p2).max(LIMITS.areaPoints),
  objects: z.array(z.unknown()).max(LIMITS.objects),
  vegetation: z.array(z.unknown()).max(LIMITS.vegetation),
  designs: z.record(localId('d'), z.unknown()),
  roads: z.object({
    nodes: z.array(z.unknown()).max(LIMITS.nodes),
    segments: z.array(z.unknown()).max(LIMITS.segments),
    zones: z.array(z.object({ segments: z.array(localId('s')).min(1).max(256), zone: z.enum(ZONE_TYPES as [string, ...string[]]) })).max(LIMITS.segments).catch([]),
  }),
  attachments: z.array(z.unknown()).max(LIMITS.attachments),
  features: z.array(z.unknown()).max(LIMITS.features),
  terrain: terrainSchema.nullable(),
  dependencies: z.array(dependencySchema).max(LIMITS.dependencies).catch([]),
  preview: previewSchema,
});

// ── Safety ─────────────────────────────────────────────────────────────────

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** First prototype-related key anywhere in the value (refused: such keys are never needed). */
function unsafeKey(v: unknown, depth = 0): string | null {
  if (depth > 64) return '(nesting too deep)';
  if (Array.isArray(v)) {
    for (const x of v) { const k = unsafeKey(x, depth + 1); if (k) return k; }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (UNSAFE.has(k)) return k;
      const r = unsafeKey((v as Record<string, unknown>)[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

const issueText = (e: z.ZodError) => {
  const i = e.issues[0];
  return `${i.path.join('.')}: ${i.message}`;
};

/** Split an entry into the fields this version knows and the rest. */
function extraFields(raw: unknown, known: readonly string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) (out ??= {})[k] = v;
  return out;
}

// ── Parse ──────────────────────────────────────────────────────────────────

export function parseBlueprintText(text: string): BlueprintParseResult {
  if (text.length > LIMITS.fileBytes) return fail('tooLarge', `${text.length} > ${LIMITS.fileBytes}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail('json', (e as Error).message);
  }
  return parseBlueprintValue(raw);
}

export function parseBlueprintValue(raw: unknown): BlueprintParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('format', 'not an object');
  const bad = unsafeKey(raw);
  if (bad) return fail('unsafe', bad);
  const r = raw as Record<string, unknown>;
  if (r.format === NATURE_REGION_FORMAT) return migrateRegion(r);
  if (r.format !== BLUEPRINT_FORMAT) return fail('format', String(r.format ?? '(none)'));
  if (r.version === 1) return migrateV1(r);
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 2) return fail('version', String(r.version));
  const minReader = typeof r.minReaderVersion === 'number' ? r.minReaderVersion : MIN_READER_VERSION;
  if (minReader > BLUEPRINT_VERSION) return fail('version', `${r.version} (needs reader ${minReader})`);
  return parseV2(r);
}

function parseV2(r: Record<string, unknown>): BlueprintParseResult {
  // Counts first: never build anything from an oversized file.
  for (const [k, max] of [['objects', LIMITS.objects], ['vegetation', LIMITS.vegetation], ['features', LIMITS.features], ['attachments', LIMITS.attachments]] as const) {
    if (Array.isArray(r[k]) && (r[k] as unknown[]).length > max) return fail('limits', `${k} > ${max}`);
  }
  const top = topSchema.safeParse(r);
  if (!top.success) return fail('schema', issueText(top.error));
  const d = top.data;
  const report: BlueprintParseReport = { migratedFrom: null, newerVersion: d.version > BLUEPRINT_VERSION ? d.version : null, unsupported: [], unsupportedObjects: 0, unsupportedFeatures: 0, droppedMembers: 0, repairedMembers: 0, clamped: 0 };
  const unsupported: UnsupportedData = {};
  const entryFields: Record<string, Record<string, unknown>> = {};
  const fields = extraFields(r, TOP_KEYS);
  if (fields) {
    unsupported.fields = fields;
    report.unsupported.push(...Object.keys(fields));
  }
  // Designs.
  const designs: Record<string, BuildingDesign> = {};
  if (Object.keys(d.designs).length > LIMITS.designs) return fail('limits', `designs > ${LIMITS.designs}`);
  for (const [k, raw] of Object.entries(d.designs)) {
    const p = parseDesign(raw);
    if (!p.design) return fail('schema', `designs.${k}: invalid building design`);
    designs[k] = p.design;
    report.droppedMembers += p.dropped;
    report.repairedMembers += p.repaired;
  }
  // Objects / vegetation.
  const ids = new Set<string>();
  const items = (list: unknown[], prefix: 'o' | 'v', field: string): BlueprintItem[] | string => {
    const out: BlueprintItem[] = [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] as Record<string, unknown>;
      if (raw && typeof raw === 'object' && typeof raw.type === 'string' && !hasDefinition(raw.type)) {
        (unsupported.objects ??= []).push(raw);
        report.unsupportedObjects++;
        continue;
      }
      const p = itemSchema.safeParse(raw);
      if (!p.success) return `${field}[${i}]: ${issueText(p.error)}`;
      const o = p.data;
      if (!o.id.startsWith(prefix)) return `${field}[${i}]: id ${o.id} in the wrong list`;
      if (ids.has(o.id)) return `${field}[${i}]: duplicate id ${o.id}`;
      ids.add(o.id);
      if (o.design && !designs[o.design]) return `${field}[${i}]: missing design ${o.design}`;
      if (o.design && o.type !== 'building') return `${field}[${i}]: design on a ${o.type}`;
      if (!o.design && !o.params) return `${field}[${i}]: params missing`;
      const def = getDefinition(o.type as ObjectType);
      const item: BlueprintItem = { ...o, type: o.type as ObjectType } as BlueprintItem;
      if (o.params) item.params = { ...def.defaultParams, ...o.params };
      if (!o.group) delete item.group;
      if (!o.design) delete item.design;
      if (o.terrainAlign === undefined) delete item.terrainAlign;
      if (!o.seismic) delete item.seismic;
      if (!o.physics) delete item.physics;
      const extra = extraFields(raw, itemKeys);
      if (extra) { entryFields[o.id] = extra; report.unsupported.push(...Object.keys(extra).map((k) => `${field}[].${k}`)); }
      out.push(item);
    }
    return out;
  };
  const objects = items(d.objects, 'o', 'objects');
  if (typeof objects === 'string') return fail('reference', objects);
  const vegetation = items(d.vegetation, 'v', 'vegetation');
  if (typeof vegetation === 'string') return fail('reference', vegetation);
  // Roads.
  const roads: BlueprintRoads = { nodes: [], segments: [], zones: [] };
  const nodeIds = new Set<string>(), segIds = new Set<string>();
  for (let i = 0; i < d.roads.nodes.length; i++) {
    const p = nodeSchema.safeParse(d.roads.nodes[i]);
    if (!p.success) return fail('schema', `roads.nodes[${i}]: ${issueText(p.error)}`);
    if (nodeIds.has(p.data.id)) return fail('reference', `roads.nodes[${i}]: duplicate id ${p.data.id}`);
    nodeIds.add(p.data.id);
    roads.nodes.push(p.data);
    const extra = extraFields(d.roads.nodes[i], nodeKeys);
    if (extra) { entryFields[p.data.id] = extra; report.unsupported.push(...Object.keys(extra).map((k) => `roads.nodes[].${k}`)); }
  }
  for (let i = 0; i < d.roads.segments.length; i++) {
    const p = segmentSchema.safeParse(d.roads.segments[i]);
    if (!p.success) return fail('schema', `roads.segments[${i}]: ${issueText(p.error)}`);
    const s = p.data;
    if (segIds.has(s.id)) return fail('reference', `roads.segments[${i}]: duplicate id ${s.id}`);
    if (!nodeIds.has(s.a) || !nodeIds.has(s.b)) return fail('reference', `roads.segments[${i}]: missing node ${nodeIds.has(s.a) ? s.b : s.a}`);
    if (s.a === s.b) return fail('reference', `roads.segments[${i}]: both ends on ${s.a}`);
    segIds.add(s.id);
    const profile = { ...defaultProfile(), ...s.profile } as RoadProfile;
    const seg: BlueprintRoads['segments'][number] = { id: s.id, a: s.a, b: s.b, control: s.control as [number, number][], profile };
    if (s.condition) seg.condition = s.condition;
    roads.segments.push(seg);
    const extra = extraFields(d.roads.segments[i], segmentKeys);
    if (extra) { entryFields[s.id] = extra; report.unsupported.push(...Object.keys(extra).map((k) => `roads.segments[].${k}`)); }
  }
  for (const zn of d.roads.zones) {
    if (!zn.segments.every((s) => segIds.has(s))) return fail('reference', `roads.zones: missing segment`);
    roads.zones.push({ segments: zn.segments, zone: zn.zone as BlueprintRoads['zones'][number]['zone'] });
  }
  // Attachments.
  const attachments: UnifiedBlueprint['attachments'] = [];
  const attached = new Set<string>();
  for (let i = 0; i < d.attachments.length; i++) {
    const p = attachmentSchema.safeParse(d.attachments[i]);
    if (!p.success) return fail('schema', `attachments[${i}]: ${issueText(p.error)}`);
    const a = p.data;
    if (!ids.has(a.object)) {
      // An attachment of an object this version could not read stays with it (unsupported).
      if (report.unsupportedObjects) { (unsupported.attachments ??= []).push(d.attachments[i]); continue; }
      return fail('reference', `attachments[${i}]: missing object ${a.object}`);
    }
    if (!segIds.has(a.segment)) return fail('reference', `attachments[${i}]: missing segment ${a.segment}`);
    if (attached.has(a.object)) return fail('reference', `attachments[${i}]: ${a.object} attached twice`);
    attached.add(a.object);
    const extra = extraFields(d.attachments[i], attachmentKeys);
    if (extra) { entryFields[`a:${a.object}`] = extra; report.unsupported.push(...Object.keys(extra).map((k) => `attachments[].${k}`)); }
    attachments.push({ ...a, policy: a.policy as UnifiedBlueprint['attachments'][number]['policy'] });
  }
  // Features (validated by the landscape schema: parameters clamped to their limits).
  const features: Feature[] = [];
  const featureIds = new Set<string>();
  for (let i = 0; i < d.features.length; i++) {
    const raw = d.features[i] as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return fail('schema', `features[${i}]: not an object`);
    const KINDS = ['mountain', 'hill', 'ridge', 'valley', 'canyon', 'river', 'lake'];
    if (typeof raw.kind === 'string' && !KINDS.includes(raw.kind)) {
      (unsupported.features ??= []).push(raw);
      report.unsupportedFeatures++;
      continue;
    }
    const id = typeof raw.id === 'string' && /^r\d{1,9}$/.test(raw.id) ? raw.id : null;
    if (!id) return fail('schema', `features[${i}]: id`);
    if (featureIds.has(id)) return fail('reference', `features[${i}]: duplicate id ${id}`);
    const p = featureSchema.safeParse({ ...raw, id: 'f1' });
    if (!p.success) return fail('schema', `features[${i}]: ${issueText(p.error)}`);
    featureIds.add(id);
    const f = { ...(p.data as Feature), id };
    if (canonicalJson(p.data) !== canonicalJson({ ...pickKnown(raw, Object.keys(p.data as object)), id: 'f1' })) report.clamped++;
    features.push(f);
    const known = Object.keys(p.data as object);
    const extra = extraFields(raw, known);
    if (extra) { entryFields[id] = extra; report.unsupported.push(...Object.keys(extra).map((k) => `features[].${k}`)); }
  }
  // Terrain layers decode to their grid size.
  const terrain = d.terrain;
  if (terrain) {
    const n = terrain.grid.nx * terrain.grid.nz;
    if (n > 4_100_000) return fail('limits', 'terrain grid too large');
    try {
      for (const k of ['surface', 'sculpt'] as const) if (terrain[k]) decodeElevation(terrain[k]!, new Float32Array(n), terrain.grid.nx);
      for (const k of ['paint', 'ground', 'soil', 'mask'] as const) if (terrain[k]) decodeGround(terrain[k]!, new Uint8Array(n));
    } catch (e) {
      return fail('schema', `terrain: ${(e as Error).message}`);
    }
  }
  // Dependencies referring to ids that do not exist are kept (they describe the source) but
  // must at least be well formed — checked by the schema.
  if (Object.keys(entryFields).length) unsupported.entryFields = entryFields;
  const bp: UnifiedBlueprint = {
    format: BLUEPRINT_FORMAT,
    version: BLUEPRINT_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    id: d.id,
    meta: cleanMeta(d.meta),
    origin: { datum: d.origin.datum, seaLevel: d.origin.seaLevel },
    area: d.area as [number, number][],
    objects,
    vegetation,
    designs,
    roads,
    attachments,
    features,
    terrain: terrain as BlueprintTerrain | null,
    dependencies: d.dependencies.map((x) => { const o = { ...x } as UnifiedBlueprint['dependencies'][number]; if (o.value === undefined) delete o.value; return o; }),
    preview: {
      size: d.preview.size,
      bounds: d.preview.bounds,
      relief: d.preview.relief,
      counts: countsOf(objects, vegetation, roads, features),
      thumbnail: d.preview.thumbnail,
    },
  };
  if (unsupported.fields || unsupported.objects || unsupported.features || unsupported.entryFields || unsupported.attachments) bp.unsupported = unsupported;
  return { ok: true, blueprint: bp, report };
}

function cleanMeta(m: z.infer<typeof metaSchema>): UnifiedBlueprint['meta'] {
  const out: UnifiedBlueprint['meta'] = { name: m.name, description: m.description, category: m.category, tags: m.tags, createdAt: m.createdAt, updatedAt: m.updatedAt };
  if (m.author) out.author = m.author;
  return out;
}

function pickKnown(raw: Record<string, unknown>, keys: string[]) {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (raw[k] !== undefined) o[k] = raw[k];
  return o;
}

export function countsOf(objects: readonly BlueprintItem[], vegetation: readonly BlueprintItem[], roads: BlueprintRoads, features: readonly Feature[]): UnifiedBlueprint['preview']['counts'] {
  return {
    objects: objects.length,
    buildings: objects.filter((o) => o.type === 'building').length,
    vegetation: vegetation.length,
    roads: roads.segments.length,
    features: features.length,
    water: features.filter((f) => f.kind === 'river' || f.kind === 'lake').length,
  };
}

// ── Migration ──────────────────────────────────────────────────────────────

const legacyObject = z.object({
  type: z.string(),
  name: z.string().catch(''),
  seed: z.number().refine(Number.isFinite),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  physics: z.record(z.string(), z.union([z.number(), z.boolean()])),
  seismic: z.any().optional(),
  building: z.unknown().optional(),
  terrainAlign: z.number().min(0).max(1).optional().catch(undefined),
  offset: vec3,
  rotation: vec3,
  scale: vec3,
  grounded: z.boolean(),
  group: z.string().optional(),
  roadLink: z.object({ segment: z.number().int().min(0), t: z.number().min(0).max(1), lateral: z.number(), yaw: z.number(), policy: z.enum(['follow', 'preserve', 'detach']).catch('follow') }).optional().catch(undefined),
});
const legacyBlueprint = z.object({
  name: z.string().catch(''),
  size: z.tuple([z.number(), z.number()]).catch([0, 0]),
  objects: z.array(z.unknown()).max(LIMITS.objects + LIMITS.vegetation),
  roads: z.object({
    nodes: z.array(z.object({ x: coord, z: coord, y: coord.nullable().default(null) })).max(LIMITS.nodes),
    segments: z.array(z.object({ a: z.number().int().min(0), b: z.number().int().min(0), control: z.array(p2).max(64).default([]), profile: profileSchema.catch({}).default({}), condition: z.number().min(0).max(1).optional().catch(undefined) })).max(LIMITS.segments),
  }).optional().catch(undefined),
});

/** Phase 16–18 copy / paste payload → v2 (ids made local, designs into the table). */
function migrateV1(r: Record<string, unknown>): BlueprintParseResult {
  const p = legacyBlueprint.safeParse(r);
  if (!p.success) return fail('schema', issueText(p.error));
  const report: BlueprintParseReport = { migratedFrom: 'v1', newerVersion: null, unsupported: [], unsupportedObjects: 0, unsupportedFeatures: 0, droppedMembers: 0, repairedMembers: 0, clamped: 0 };
  const designs: Record<string, BuildingDesign> = {};
  const byContent = new Map<string, string>();
  const objects: BlueprintItem[] = [];
  const vegetation: BlueprintItem[] = [];
  const unsupported: UnsupportedData = {};
  const groups = new Map<string, string>();
  const links: { item: BlueprintItem; link: NonNullable<z.infer<typeof legacyObject>['roadLink']> }[] = [];
  for (let i = 0; i < p.data.objects.length; i++) {
    const raw = p.data.objects[i] as Record<string, unknown>;
    if (raw && typeof raw === 'object' && typeof raw.type === 'string' && !hasDefinition(raw.type)) {
      (unsupported.objects ??= []).push(raw);
      report.unsupportedObjects++;
      continue;
    }
    const o = legacyObject.safeParse(raw);
    if (!o.success) return fail('schema', `objects[${i}]: ${issueText(o.error)}`);
    const v = o.data;
    const veg = v.type === 'tree';
    const list = veg ? vegetation : objects;
    const item: BlueprintItem = {
      id: `${veg ? 'v' : 'o'}${list.length + 1}`, type: v.type as ObjectType, name: v.name, seed: Math.round(v.seed),
      offset: v.offset, rotation: v.rotation, scale: v.scale, grounded: v.grounded, base: v.grounded ? 0 : v.offset[1],
    };
    const def = getDefinition(v.type as ObjectType);
    let modular = false;
    if (v.building !== undefined && v.type === 'building') {
      const d = parseDesign(v.building);
      report.droppedMembers += d.dropped;
      report.repairedMembers += d.repaired;
      if (d.design) {
        const key = JSON.stringify(d.design);
        let k = byContent.get(key);
        if (!k) { k = `d${byContent.size + 1}`; byContent.set(key, k); designs[k] = d.design; }
        item.design = k;
        modular = true;
      }
    }
    if (!modular) {
      item.params = { ...def.defaultParams, ...v.params };
      const dp = def.defaultPhysics(item.params);
      const phys: Record<string, number | boolean> = {};
      for (const [k, val] of Object.entries(v.physics)) if ((dp as unknown as Record<string, unknown>)[k] !== val) phys[k] = val;
      if (Object.keys(phys).length) item.physics = phys as BlueprintItem['physics'];
    }
    if (v.seismic) item.seismic = v.seismic;
    if (v.terrainAlign !== undefined) item.terrainAlign = v.terrainAlign;
    if (v.group) {
      if (!groups.has(v.group)) groups.set(v.group, `g${groups.size + 1}`);
      item.group = groups.get(v.group);
    }
    list.push(item);
    if (v.roadLink) links.push({ item, link: v.roadLink });
  }
  const roads: BlueprintRoads = { nodes: [], segments: [], zones: [] };
  const rr = p.data.roads;
  if (rr) {
    rr.nodes.forEach((n, i) => roads.nodes.push({ id: `n${i + 1}`, x: n.x, z: n.z, y: n.y }));
    rr.segments.forEach((s) => {
      // (v1 dropped segments with missing nodes silently; v2 reports it.)
      if (s.a >= rr.nodes.length || s.b >= rr.nodes.length || s.a === s.b) { report.unsupported.push('roads.segments[] (invalid node reference, dropped)'); return; }
      const seg: BlueprintRoads['segments'][number] = { id: `s${roads.segments.length + 1}`, a: `n${s.a + 1}`, b: `n${s.b + 1}`, control: s.control as [number, number][], profile: { ...defaultProfile(), ...s.profile } as RoadProfile };
      if (s.condition) seg.condition = s.condition;
      roads.segments.push(seg);
    });
  }
  const attachments: UnifiedBlueprint['attachments'] = [];
  for (const { item, link } of links) {
    const sid = `s${link.segment + 1}`;
    if (roads.segments.some((s) => s.id === sid)) attachments.push({ object: item.id, segment: sid, t: link.t, lateral: link.lateral, yaw: link.yaw, policy: link.policy });
  }
  const [w, dd] = p.data.size;
  const area: [number, number][] = w > 0 || dd > 0 ? [[-w / 2, -dd / 2], [w / 2, -dd / 2], [w / 2, dd / 2], [-w / 2, dd / 2]] : [];
  const now = new Date().toISOString();
  const bp: UnifiedBlueprint = {
    format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, minReaderVersion: MIN_READER_VERSION, id: createId('bp'),
    meta: { name: p.data.name, description: '', category: roads.segments.length ? (objects.length ? 'mixed' : 'roads') : 'buildings', tags: [], createdAt: now, updatedAt: now },
    origin: { datum: 0, seaLevel: null },
    area, objects, vegetation, designs, roads, attachments, features: [], terrain: null, dependencies: [],
    preview: { size: [w, dd], bounds: area.length ? [-w / 2, -dd / 2, w / 2, dd / 2] : [0, 0, 0, 0], relief: [0, 0], counts: countsOf(objects, vegetation, roads, []), thumbnail: null },
  };
  if (unsupported.objects) bp.unsupported = unsupported;
  return { ok: true, blueprint: bp, report };
}

const regionSchema = z.object({
  version: z.literal(1),
  size: z.tuple([z.number().positive().max(10_000), z.number().positive().max(10_000)]),
  grid: z.object({ nx: z.number().int().min(1).max(LIMITS.gridSide), nz: z.number().int().min(1).max(LIMITS.gridSide), cell: z.number().positive().max(10) }),
  features: z.array(z.unknown()).max(LIMITS.features),
  sculpt: z.string().nullable(),
  paint: z.string().nullable(),
});

/**
 * Phase 19 nature region → v2. Regions had no datum: elevations were absolute (lake surfaces)
 * and only the sculpt / paint layers were stored — the migrated blueprint has datum 0 and no
 * surface layer ("apply / blend" unavailable; "offset" adds the sculpt like placeRegion did).
 */
function migrateRegion(r: Record<string, unknown>): BlueprintParseResult {
  const p = regionSchema.safeParse(r);
  if (!p.success) return fail('schema', issueText(p.error));
  const report: BlueprintParseReport = { migratedFrom: 'nature-region', newerVersion: null, unsupported: [], unsupportedObjects: 0, unsupportedFeatures: 0, droppedMembers: 0, repairedMembers: 0, clamped: 0 };
  const features: Feature[] = [];
  const unsupported: UnsupportedData = {};
  for (const raw of p.data.features) {
    const f = featureSchema.safeParse({ ...(raw as object), id: 'f1' });
    if (!f.success) { (unsupported.features ??= []).push(raw); report.unsupportedFeatures++; continue; }
    if ((f.data as Feature).kind === 'coast') { report.unsupported.push('features[] (coastline, not part of blueprints)'); continue; }
    features.push({ ...(f.data as Feature), id: `r${features.length + 1}` });
  }
  const { nx, nz, cell } = p.data.grid;
  const [w, d] = p.data.size;
  const terrain: BlueprintTerrain | null = (p.data.sculpt || p.data.paint) && nx >= 2 && nz >= 2
    ? { grid: { x0: -w / 2, z0: -d / 2, nx, nz, cell }, surface: null, sculpt: p.data.sculpt, paint: p.data.paint, ground: null, soil: null, mask: null }
    : null;
  if (terrain) {
    try {
      if (terrain.sculpt) decodeElevation(terrain.sculpt, new Float32Array(nx * nz), nx);
      if (terrain.paint) decodeGround(terrain.paint, new Uint8Array(nx * nz));
    } catch (e) {
      return fail('schema', `terrain: ${(e as Error).message}`);
    }
  }
  const now = new Date().toISOString();
  const roads: BlueprintRoads = { nodes: [], segments: [], zones: [] };
  const bp: UnifiedBlueprint = {
    format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, minReaderVersion: MIN_READER_VERSION, id: createId('bp'),
    meta: { name: '', description: '', category: 'nature', tags: [], createdAt: now, updatedAt: now },
    origin: { datum: 0, seaLevel: null },
    area: [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]],
    objects: [], vegetation: [], designs: {}, roads, attachments: [], features, terrain, dependencies: [],
    preview: { size: [w, d], bounds: [-w / 2, -d / 2, w / 2, d / 2], relief: [0, 0], counts: countsOf([], [], roads, features), thumbnail: null },
  };
  if (unsupported.features) bp.unsupported = unsupported;
  return { ok: true, blueprint: bp, report };
}

// ── Serialize ──────────────────────────────────────────────────────────────

/** JSON with object keys sorted at every level: byte-identical for equal values. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** The value written to files / the library (unsupported data back in place). */
export function exportValue(bp: UnifiedBlueprint): Record<string, unknown> {
  const u = bp.unsupported;
  const fieldsOf = (id: string) => u?.entryFields?.[id];
  const withExtra = <T extends object>(e: T, id: string): T => { const x = fieldsOf(id); return x ? { ...x, ...e } : e; };
  const out: Record<string, unknown> = {
    ...(u?.fields ?? {}),
    format: bp.format,
    version: bp.version,
    minReaderVersion: bp.minReaderVersion,
    id: bp.id,
    meta: bp.meta,
    origin: bp.origin,
    area: bp.area,
    objects: [...bp.objects.map((o) => withExtra(o, o.id)), ...(u?.objects ?? [])],
    vegetation: bp.vegetation.map((o) => withExtra(o, o.id)),
    designs: bp.designs,
    roads: { nodes: bp.roads.nodes.map((n) => withExtra(n, n.id)), segments: bp.roads.segments.map((s) => withExtra(s, s.id)), zones: bp.roads.zones },
    attachments: [...bp.attachments.map((a) => withExtra(a, `a:${a.object}`)), ...(u?.attachments ?? [])],
    features: [...bp.features.map((f) => withExtra(f, f.id)), ...(u?.features ?? [])],
    terrain: bp.terrain,
    dependencies: bp.dependencies,
    preview: bp.preview,
  };
  return out;
}

export function serializeBlueprint(bp: UnifiedBlueprint): string {
  return canonicalJson(exportValue(bp));
}

/** Content hash (ignores id, timestamps and thumbnail): identical content → same hash. */
export function blueprintHash(bp: UnifiedBlueprint): string {
  const v = exportValue(bp);
  const meta = { ...(v.meta as object), createdAt: '', updatedAt: '' };
  const json = canonicalJson({ ...v, id: '', meta, preview: { ...(v.preview as object), thumbnail: null } });
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
