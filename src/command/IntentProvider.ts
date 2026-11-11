/**
 * Phase 37 §16 — the seam for an optional language-model adapter: the INTERFACE, the rule parser as its default
 * implementation, the validation every provider answer goes through, and the summary a provider may be shown.
 * No network code and no key handling here (whether a real provider is built is an open decision — spec §26).
 *
 * A provider returns Intent JSON only. `providerOutcome` puts that JSON through the same zod schema and
 * `intentProblem` rules as everything else, and through canonical text and back: a value the grammar cannot write
 * never reaches resolve / plan — a provider cannot smuggle one in.
 */
import type { WorldDocument } from '@/core/model';
import type { I18nMessage } from '@/i18n/i18n';
import { formatCanonical, parseCanonical } from './canonical';
import { validateIntents, type Intent } from './intent';
import { kindOfObject } from './kinds';
import { parseCommand, suggest, type ParseOutcome } from './parse';

/**
 * What a provider is told about the world: kinds, names, ids, counts and rounded coordinates — a SUMMARY, never the
 * document (no geometry, no parameters, no terrain, no settings). The settings screen can show it as it is.
 */
export interface ProviderContext {
  /** Objects per kind (`building:house`, `tree:conifer` …), sorted by kind. */
  kinds: { kind: string; count: number }[];
  counts: { objects: number; selected: number; groups: number; nodes: number; segments: number; disasters: number };
  /** User-given object names (the first `PROVIDER_LIST_LIMIT`, sorted). */
  names: string[];
  groups: { name: string; count: number }[];
  /** Ids a sentence may name: the selection, road nodes (with their position, 1 m), road segments, placed disasters. */
  selection: string[];
  nodes: { id: string; x: number; z: number }[];
  segments: { id: string; a: string; b: string }[];
  disasters: { id: string; type: string }[];
  /** The ground point under the mouse / in the middle of the view, rounded to 1 m. */
  cursor: [number, number] | null;
  view: [number, number] | null;
  /** A list above was cut at `PROVIDER_LIST_LIMIT`. */
  truncated: boolean;
}

export const PROVIDER_LIST_LIMIT = 100;

/** The UI state a summary needs (structurally a part of the planner's command context). */
export interface ProviderInput {
  selection: readonly string[];
  cursor: readonly [number, number] | null;
  view: readonly [number, number] | null;
}

const round = (p: readonly [number, number] | null): [number, number] | null => (p ? [Math.round(p[0]) + 0, Math.round(p[1]) + 0] : null);

/** The summary of a document for a provider. Pure and deterministic (sorted; lists cut at the limit). */
export function summarizeForProvider(doc: WorldDocument, ctx: ProviderInput): ProviderContext {
  let truncated = false;
  const cut = <T>(list: T[]): T[] => { if (list.length > PROVIDER_LIST_LIMIT) truncated = true; return list.slice(0, PROVIDER_LIST_LIMIT); };
  const objects = Object.values(doc.objects);
  const byKind = new Map<string, number>();
  const groupCount = new Map<string, number>();
  for (const o of objects) {
    const kind = kindOfObject(o);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    if (o.group) groupCount.set(o.group, (groupCount.get(o.group) ?? 0) + 1);
  }
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const names = [...new Set(objects.map((o) => o.name).filter(Boolean))].sort(text);
  const groups = [...groupCount].map(([id, count]) => ({ name: doc.groups?.[id]?.name ?? '', count })).filter((g) => g.name).sort((a, b) => text(a.name, b.name));
  const nodes = Object.values(doc.roads.nodes).map((n) => ({ id: n.id, x: Math.round(n.x) + 0, z: Math.round(n.z) + 0 })).sort((a, b) => text(a.id, b.id));
  const segments = Object.values(doc.roads.segments).map((s) => ({ id: s.id, a: s.a, b: s.b })).sort((a, b) => text(a.id, b.id));
  const instances = doc.scenario.experiment?.instances ?? [];
  return {
    kinds: [...byKind].map(([kind, count]) => ({ kind, count })).sort((a, b) => text(a.kind, b.kind)),
    counts: { objects: objects.length, selected: ctx.selection.length, groups: groupCount.size, nodes: nodes.length, segments: segments.length, disasters: instances.length },
    names: cut(names),
    groups: cut(groups),
    selection: cut([...ctx.selection].sort(text)),
    nodes: cut(nodes),
    segments: cut(segments),
    disasters: cut(instances.map((i) => ({ id: i.id, type: i.type }))),
    cursor: round(ctx.cursor),
    view: round(ctx.view),
    truncated,
  };
}

/** Text → intents. The rule parser is the default; a language-model adapter implements the same interface. */
export interface IntentProvider {
  readonly id: string;
  parse(text: string, ctx: ProviderContext): Promise<ParseOutcome>;
}

/** The offline, deterministic default: the rule-based parser (it does not look at the context). */
export const ruleProvider: IntentProvider = {
  id: 'rules',
  parse: async (text) => parseCommand(text),
};

const refuse = (key: I18nMessage['key'], detail: string): ParseOutcome => ({ kind: 'unknown', reason: { key, params: { detail } }, suggestions: suggest('', []) });

/**
 * A provider's raw answer (`{ "intents": [ … ] }`) → an outcome. Anything that is not exactly a list of valid intents
 * — a wrong shape, an unknown key, a value the grammar cannot write, an empty list — is `unknown`: nothing runs.
 */
export function providerOutcome(json: unknown): ParseOutcome {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return refuse('cmd37.nl.unknown.provider', 'not an object');
  const keys = Object.keys(json);
  if (keys.length !== 1 || keys[0] !== 'intents') return refuse('cmd37.nl.unknown.provider', `keys: ${keys.join(', ') || '(none)'}`);
  const list = (json as { intents: unknown }).intents;
  if (!Array.isArray(list) || list.length === 0) return refuse('cmd37.nl.unknown.provider', 'intents: not a list, or empty');
  const valid = validateIntents(list);
  if (!valid.ok) return refuse('cmd37.nl.unknown.provider', valid.issues.slice(0, 3).join('; '));
  // Through canonical text and back: what is returned is what the grammar writes — nothing more.
  const intents: Intent[] = [];
  const canonical: string[] = [];
  for (const intent of valid.intents) {
    const text = formatCanonical(intent);
    const back = parseCanonical(text);
    if (!back.ok) return refuse('cmd37.nl.unknown.provider', `cannot be written: ${text}`);
    if (!sameIntent(intent, back.intent)) return refuse('cmd37.nl.unknown.provider', `not what the grammar writes: ${text}`);
    intents.push(back.intent);
    canonical.push(text);
  }
  return { kind: 'ok', intents, canonical, source: 'provider', notes: [{ key: 'cmd37.nl.note.provider' }] };
}

/** Deep equality of two intents, ignoring key order and `undefined` members. */
function sameIntent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameIntent((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
