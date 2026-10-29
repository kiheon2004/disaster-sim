/**
 * World templates (Phase 20): a whole world saved for reuse — terrain layers, roads, buildings,
 * nature, objects, the initial environment (simulation / water settings) and, optionally, the
 * experiment setup (saved earthquake / flood scenario and phenomenon plan).
 *
 * The world itself is stored exactly as a project file stores it (schema v7, toSerializable),
 * so a template opens through the same validated loader as a project, migrations included.
 *
 *   { format: 'disaster-sim/world-template', version: 1, id, meta, includesExperiment,
 *     builtin?: { kind, seed }, world: <v7 document>, preview }
 */
import { z } from 'zod';
import type { WorldDocument } from '@/core/model';
import { parseDocument, toSerializable } from '@/world/serialization';
import { defaultScenario } from '@/world/WorldDocument';
import { createId } from '@/core/id';
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from './builtin';

export const TEMPLATE_FORMAT = 'disaster-sim/world-template';
export const TEMPLATE_VERSION = 1;
export const TEMPLATE_MAX_BYTES = 128 * 1024 * 1024;

export interface TemplateMeta {
  name: string;
  description: string;
  tags: string[];
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateCounts {
  objects: number;
  buildings: number;
  trees: number;
  roads: number;
  features: number;
}

export interface WorldTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: typeof TEMPLATE_VERSION;
  id: string;
  meta: TemplateMeta;
  /** The saved scenario (hazards, experiment plan) is part of the template. */
  includesExperiment: boolean;
  /** Generated from a built-in kind + seed (informational). */
  builtin?: { kind: BuiltinTemplate; seed: number };
  /** The world, as a v7 project file stores it. */
  world: Record<string, unknown>;
  preview: { counts: TemplateCounts; thumbnail: string | null };
}

export function countsOf(doc: WorldDocument): TemplateCounts {
  const objs = Object.values(doc.objects);
  return {
    objects: objs.length,
    buildings: objs.filter((o) => o.type === 'building').length,
    trees: objs.filter((o) => o.type === 'tree').length,
    roads: Object.keys(doc.roads.segments).length,
    features: doc.landscape.features.length,
  };
}

/** A template of a world. Without the experiment setup the scenario is reset to the defaults. */
export function createTemplate(doc: WorldDocument, meta: Partial<TemplateMeta> & { name: string }, includeExperiment: boolean, opts: { id?: string; now?: string; builtin?: WorldTemplate['builtin'] } = {}): WorldTemplate {
  const now = opts.now ?? new Date().toISOString();
  const world = toSerializable({ ...doc, meta: { ...doc.meta, name: meta.name }, scenario: includeExperiment ? doc.scenario : defaultScenario() });
  const t: WorldTemplate = {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    id: opts.id ?? createId('tpl'),
    meta: { name: meta.name, description: meta.description ?? '', tags: [...(meta.tags ?? [])], createdAt: meta.createdAt ?? now, updatedAt: now, ...(meta.author ? { author: meta.author } : {}) },
    includesExperiment: includeExperiment,
    world: JSON.parse(JSON.stringify(world)),
    preview: { counts: countsOf(doc), thumbnail: null },
  };
  if (opts.builtin) t.builtin = opts.builtin;
  return t;
}

export function serializeTemplate(t: WorldTemplate): string {
  const out: Record<string, unknown> = { format: t.format, version: t.version, id: t.id, meta: t.meta, includesExperiment: t.includesExperiment };
  if (t.builtin) out.builtin = t.builtin;
  out.world = t.world;
  out.preview = t.preview;
  return JSON.stringify(out);
}

const THUMB = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const templateSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  version: z.literal(TEMPLATE_VERSION),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  meta: z.object({
    name: z.string().max(120),
    description: z.string().max(4000).catch(''),
    tags: z.array(z.string().max(40)).max(32).catch([]),
    author: z.string().max(120).optional().catch(undefined),
    createdAt: z.string().max(40).catch(''),
    updatedAt: z.string().max(40).catch(''),
  }),
  includesExperiment: z.boolean().catch(false),
  builtin: z.object({ kind: z.enum(BUILTIN_TEMPLATES as [BuiltinTemplate, ...BuiltinTemplate[]]), seed: z.number().int().nonnegative() }).optional().catch(undefined),
  world: z.record(z.string(), z.unknown()),
  preview: z.object({
    counts: z.object({ objects: z.number(), buildings: z.number(), trees: z.number(), roads: z.number(), features: z.number() }).partial().catch({}),
    thumbnail: z.string().max(1024 * 1024).refine((s) => THUMB.test(s)).nullable().catch(null),
  }).catch({ counts: {}, thumbnail: null }),
});

export type TemplateParseResult = { ok: true; template: WorldTemplate; doc: WorldDocument; skipped: number } | { ok: false; code: 'json' | 'tooLarge' | 'format' | 'schema' | 'world' | 'unsafe'; detail: string };

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
function unsafeKey(v: unknown, depth = 0): string | null {
  if (depth > 64) return '(nesting too deep)';
  if (Array.isArray(v)) { for (const x of v) { const k = unsafeKey(x, depth + 1); if (k) return k; } return null; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (UNSAFE.has(k)) return k; const r = unsafeKey((v as Record<string, unknown>)[k], depth + 1); if (r) return r; }
  return null;
}

/** Validate a template file: its envelope, then its world through the project loader. */
export function parseTemplate(text: string): TemplateParseResult {
  if (text.length > TEMPLATE_MAX_BYTES) return { ok: false, code: 'tooLarge', detail: String(text.length) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'json', detail: (e as Error).message };
  }
  const bad = unsafeKey(raw);
  if (bad) return { ok: false, code: 'unsafe', detail: bad };
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== TEMPLATE_FORMAT) return { ok: false, code: 'format', detail: String((raw as { format?: unknown })?.format ?? '') };
  const r = templateSchema.safeParse(raw);
  if (!r.success) return { ok: false, code: 'schema', detail: `${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}` };
  const world = parseDocument(JSON.stringify(r.data.world));
  if (!world.ok) return { ok: false, code: 'world', detail: world.error };
  const t = r.data as WorldTemplate;
  const meta: TemplateMeta = { name: t.meta.name, description: t.meta.description, tags: t.meta.tags, createdAt: t.meta.createdAt, updatedAt: t.meta.updatedAt };
  if (t.meta.author) meta.author = t.meta.author;
  const template: WorldTemplate = { format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, id: t.id, meta, includesExperiment: t.includesExperiment, world: t.world, preview: { counts: { ...countsOf(world.doc) }, thumbnail: t.preview.thumbnail ?? null } };
  if (t.builtin) template.builtin = t.builtin;
  return { ok: true, template, doc: world.doc, skipped: world.skipped };
}

/** The world of a template as a NEW document (fresh timestamps, the given name). */
export function templateDocument(t: WorldTemplate, name?: string): WorldDocument {
  const r = parseDocument(JSON.stringify(t.world));
  if (!r.ok) throw new Error(r.error);
  const now = new Date().toISOString();
  return { ...r.doc, meta: { name: name ?? t.meta.name, createdAt: now, updatedAt: now } };
}
