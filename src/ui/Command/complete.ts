/**
 * Phase 37 (§14) — Tab completion of the command bar: the word under the caret → what could stand there, as a pure
 * function of (text, caret, document). Candidates come from the tables the grammar itself is made of — the canonical
 * verbs, the placeable kinds, the disaster registry and its field names — and from the ids and names of the current
 * document; nothing here is a second list of them.
 */
import type { WorldDocument } from '@/core/model';
import { quote, VERB_ALIASES_KO, VERBS, type Verb } from '@/command/canonical';
import { orderedObjects } from '@/command/context';
import { ALIGN_AXES, ALIGN_EDGES, ALIGN_MODES, ALIGN_REFS, COPY_PROPS, DISTRIBUTE_AXES, INSTANCE_OPS, MATCH_WHAT, QUERY_TOPICS, SIDES, TERRAIN_OPS } from '@/command/intent';
import { KIND_TYPES, KINDS } from '@/command/kinds';
import { assignSpecValue } from '@/phenomena/fields';
import { phenomena } from '@/phenomena/registry';
import { PROFILE_PRESETS } from '@/roads/types';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';

/** What a candidate is — the list shows it as a word next to the text (never by colour alone). */
export type CandidateKind = 'verb' | 'kind' | 'key' | 'value' | 'word' | 'id' | 'name' | 'disaster';

export interface Candidate {
  /** The text that replaces `[from, to)`. */
  text: string;
  kind: CandidateKind;
  /** Document data that tells candidates apart (the type and name behind an id, the members of a group). */
  hint?: string;
  /** More is typed right after it (`at=`, `type:`): no space is added. */
  open?: boolean;
}

export interface Completion {
  /** The part of the text the candidates replace (the word under the caret, or the value after its `key=`). */
  from: number;
  to: number;
  candidates: Candidate[];
  /** How many matched before the list was cut to MAX_CANDIDATES. */
  total: number;
}

export const MAX_CANDIDATES = 40;

/** The `key=` names each verb takes (the canonical grammar's own option lists — a test parses every one of them). */
export const VERB_KEYS: Record<Verb, readonly string[]> = {
  place: ['count', 'at', 'along', 'side', 'gap', 'floors', 'heading'],
  select: [], add: [], remove: [],
  move: ['by', 'to'], rotate: ['by'], scale: [],
  set: ['x', 'y', 'z', 'heading', 'scale', 'lift'],
  align: ['axis', 'mode', 'ref', 'edge'], distribute: ['axis'], match: ['to'], copy: ['from', 'to'],
  group: ['name'], ungroup: [], rename: [], hide: [], show: [], lock: [], unlock: [], delete: [],
  duplicate: ['offset'], terrain: ['by', 'to'], paint: ['ground'], road: ['preset'], forest: ['density', 'seed'],
  disaster: ['at', 'start'],
  run: [], pause: [], reset: [], speed: [], focus: ['at'], undo: [], redo: [], count: [], list: [], measure: [], info: [],
};

/** Verbs whose first argument is a target (objects). */
const TARGET_VERBS: ReadonlySet<Verb> = new Set<Verb>([
  'select', 'add', 'remove', 'move', 'rotate', 'scale', 'set', 'align', 'distribute', 'match', 'group', 'ungroup', 'rename', 'hide', 'show', 'lock', 'unlock',
  'delete', 'duplicate', 'focus', 'count', 'list', 'measure', 'info',
]);

const TARGET_WORDS = ['selection', 'last', 'it', 'all'] as const;
const TARGET_MORE = ['where', 'largest', 'tallest', 'nearest', 'first'] as const;
const PREDICATES: readonly Candidate[] = [
  { text: 'floors>=', kind: 'word', open: true }, { text: 'slope>', kind: 'word', open: true }, { text: 'height>', kind: 'word', open: true },
  { text: 'near', kind: 'word' }, { text: 'on road', kind: 'word' }, { text: 'hidden', kind: 'word' }, { text: 'locked', kind: 'word' },
  { text: 'visible', kind: 'word' }, { text: 'unlocked', kind: 'word' }, { text: 'warning', kind: 'word' },
];
const PLACE_WORDS = ['cursor', 'view', 'center', 'junction', 'selection', 'last'] as const;
const AREA_WORDS = ['rect', 'circle', 'around'] as const;
const DENSITIES = ['low', 'medium', 'high'] as const;

interface Tok {
  start: number;
  end: number;
  text: string;
}

/** The tokens of one line with their positions: white space separates, "quoted text" and (groups) stay together — an open quote runs to the end. */
function scan(line: string, offset: number): Tok[] {
  const out: Tok[] = [];
  let start = -1, depth = 0;
  for (let i = 0; i <= line.length; i++) {
    const c = line[i];
    if (c === undefined || (/\s/.test(c) && depth === 0)) {
      if (start >= 0) out.push({ start: offset + start, end: offset + i, text: line.slice(start, i) });
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      i = Math.min(j, line.length - 1);
    } else if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
  }
  return out;
}

const word = (text: string, kind: CandidateKind = 'word'): Candidate => ({ text, kind });
const words = (list: readonly string[], kind: CandidateKind = 'word'): Candidate[] => list.map((x) => word(x, kind));
const keyOf = (name: string): Candidate => ({ text: `${name}=`, kind: 'key', open: true });

function verbOf(tok: string): Verb | null {
  const low = tok.toLowerCase();
  if ((VERBS as readonly string[]).includes(low)) return low as Verb;
  if (low.startsWith('speed=')) return 'speed';
  return VERB_ALIASES_KO[tok] ?? null;
}

function verbCandidates(prefix: string): Candidate[] {
  // A Korean prefix completes to the Korean aliases; anything else to the canonical verbs.
  if (/[ㄱ-ㆎ가-힣]/.test(prefix)) return Object.keys(VERB_ALIASES_KO).map((k) => ({ text: k, kind: 'verb' as const, hint: VERB_ALIASES_KO[k] }));
  return VERBS.map((v) => (v === 'speed' ? { text: 'speed=', kind: 'verb' as const, open: true } : word(v, 'verb')));
}

// ── The document's names ─────────────────────────────────────────────────────────────

function objectIds(doc: WorldDocument): Candidate[] {
  return orderedObjects(doc).map((o) => ({ text: `#${o.id}`, kind: 'id' as const, hint: o.name ? `${o.type} ${o.serial} "${o.name}"` : `${o.type} ${o.serial}` }));
}

/** Named groups that still have members (the planner resolves no others), each with its member count. */
function groupNames(doc: WorldDocument): { name: string; count: number }[] {
  const members = new Map<string, number>();
  for (const o of orderedObjects(doc)) if (o.group) members.set(o.group, (members.get(o.group) ?? 0) + 1);
  const byName = new Map<string, number>();
  for (const [id, g] of Object.entries(doc.groups ?? {})) {
    const n = members.get(id);
    if (n && g.name) byName.set(g.name, (byName.get(g.name) ?? 0) + n);
  }
  return [...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, count]) => ({ name, count }));
}

const groupCandidates = (doc: WorldDocument): Candidate[] => groupNames(doc).map((g) => ({ text: `group:${quote(g.name)}`, kind: 'name' as const, hint: String(g.count) }));

function nameCandidates(doc: WorldDocument): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const o of orderedObjects(doc)) {
    if (!o.name || seen.has(o.name)) continue;
    seen.add(o.name);
    out.push({ text: `name:${quote(o.name)}`, kind: 'name', hint: `${o.type} ${o.serial}` });
  }
  return out;
}

const byNumber = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1)) || (a < b ? -1 : a > b ? 1 : 0);
const nodeIds = (doc: WorldDocument) => Object.keys(doc.roads.nodes).sort(byNumber);
const segmentIds = (doc: WorldDocument) => Object.keys(doc.roads.segments).sort(byNumber);
const featureCandidates = (doc: WorldDocument): Candidate[] => doc.landscape.features.map((f) => ({ text: `feature:${f.id}`, kind: 'id' as const, hint: f.kind }));

function placeCandidates(doc: WorldDocument): Candidate[] {
  return [
    ...words(PLACE_WORDS),
    ...nodeIds(doc).map((id) => word(`node:${id}`, 'id')),
    ...segmentIds(doc).map((id) => word(`seg:${id}`, 'id')),
    ...featureCandidates(doc),
    ...groupCandidates(doc),
    ...objectIds(doc),
  ];
}

function roadCandidates(doc: WorldDocument): Candidate[] {
  return [word('road:main'), word('road:any'), ...segmentIds(doc).map((id) => word(`seg:${id}`, 'id'))];
}

function targetCandidates(doc: WorldDocument): Candidate[] {
  return [
    ...words(TARGET_WORDS),
    ...KIND_TYPES.map((t) => word(`type:${t}`, 'kind')),
    ...KINDS.filter((k) => k.preset !== undefined).map((k) => word(`type:${k.key}`, 'kind')),
    ...groupCandidates(doc),
    ...nameCandidates(doc),
    ...objectIds(doc),
  ];
}

function areaCandidates(doc: WorldDocument): Candidate[] {
  return [...words(AREA_WORDS), ...featureCandidates(doc)];
}

// ── Disasters ────────────────────────────────────────────────────────────────────────

const instancesOf = (doc: WorldDocument) => doc.scenario.experiment?.instances ?? [];

function disasterCandidates(doc: WorldDocument): Candidate[] {
  return [
    ...phenomena.listImplemented().map((d) => word(d.type, 'disaster')),
    ...instancesOf(doc).map((i) => ({ text: i.id, kind: 'id' as const, hint: i.type })),
  ];
}

/**
 * The value names a disaster type takes, exactly as the planner knows them: `assignSpecValue` lists them when it is
 * asked for a name no type has (so this list cannot drift from what a command accepts).
 */
export function disasterFieldNames(type: string): string[] {
  const def = phenomena.implemented(type) ?? phenomena.listImplemented().find((d) => d.type.toLowerCase() === type.toLowerCase());
  if (!def) return [];
  const r = assignSpecValue(def, def.defaults(), '\u0000', 0);
  return r.ok ? [] : r.known;
}

function disasterOptions(type: string, field: string): string[] {
  const def = phenomena.implemented(type) ?? phenomena.listImplemented().find((d) => d.type.toLowerCase() === type.toLowerCase());
  const f = def?.fields.find((x) => x.key === field) ?? def?.fields.find((x) => x.key.toLowerCase() === field.toLowerCase());
  return f?.options?.map((o) => o.value) ?? [];
}

// ── What can stand at a position ─────────────────────────────────────────────────────

/** Values of `key=` for a verb. */
function valueCandidates(verb: Verb, key: string, before: readonly string[], doc: WorldDocument): Candidate[] {
  const v = (list: readonly string[]) => words(list, 'value');
  switch (key) {
    case 'at': return placeCandidates(doc);
    case 'to':
      if (verb === 'match' || verb === 'copy') return targetCandidates(doc);
      return verb === 'terrain' ? [] : placeCandidates(doc);
    case 'from': return verb === 'copy' ? targetCandidates(doc) : [];
    case 'along': return roadCandidates(doc);
    case 'side': return v(SIDES);
    case 'axis': return v(verb === 'distribute' ? DISTRIBUTE_AXES : ALIGN_AXES);
    case 'mode': return v(ALIGN_MODES);
    case 'ref': return v(ALIGN_REFS);
    case 'edge': return v(ALIGN_EDGES);
    case 'ground': return v(GROUND_MATERIALS.map((g) => g.key));
    case 'preset': return verb === 'road' ? v(Object.keys(PROFILE_PRESETS)) : [];
    case 'density': return v(DENSITIES);
    case 'name': return groupNames(doc).map((g) => ({ text: quote(g.name), kind: 'name' as const, hint: String(g.count) }));
  }
  if (verb === 'disaster' && before[1]) return v(disasterOptions(before[1], key));
  return [];
}

/** Words (not `key=value`) that can stand at token `index` after the tokens `before`. */
function wordCandidates(verb: Verb, before: readonly string[], doc: WorldDocument): Candidate[] {
  const index = before.length;
  const last = before[index - 1]?.toLowerCase() ?? '';
  const prev = before[index - 2]?.toLowerCase() ?? '';
  const used = new Set(before.map((t) => /^([A-Za-z_]\w*)=/.exec(t)?.[1].toLowerCase()).filter((k): k is string => !!k));
  const keys = (names: readonly string[]) => names.filter((k) => !used.has(k.toLowerCase())).map(keyOf);

  // Words that are followed by a place / a road / a target, wherever they stand.
  if (last === 'nearest' || last === 'near' || last === 'circle') return placeCandidates(doc);
  if (last === 'around') return targetCandidates(doc);
  if (last === 'on') return [word('road')];
  if (last === 'road' && prev === 'on') return [...roadCandidates(doc), ...words(TARGET_MORE), word('and')];
  if (last === 'where' || last === 'and') return [...PREDICATES];

  switch (verb) {
    // (a bare type places its default preset: `tree`, `building` — then every kind with its preset)
    case 'place': return index === 1 ? [...words(KIND_TYPES, 'kind'), ...KINDS.map((k) => word(k.key, 'kind'))] : keys(VERB_KEYS.place);
    case 'disaster': {
      if (index === 1) return disasterCandidates(doc);
      const isOp = (INSTANCE_OPS as readonly string[]).includes(before[2]?.toLowerCase() ?? '');
      if (isOp) return before[2].toLowerCase() === 'move' ? keys(['to']) : [];
      const fields = [...keys(['at']), ...keys(disasterFieldNames(before[1])), ...keys(['start']), word('now')];
      // Right after the name: a placed instance takes an operation, a type takes values — the name may be either.
      return index === 2 ? [...fields, ...words(INSTANCE_OPS)] : fields;
    }
    case 'terrain':
      if (index === 1) return words(TERRAIN_OPS);
      if (index === 2) return areaCandidates(doc);
      return [...keys(['r']), ...keys(VERB_KEYS.terrain)];
    case 'paint': case 'forest':
      if (index === 1) return areaCandidates(doc);
      return [...keys(['r']), ...keys(VERB_KEYS[verb])];
    case 'road':
      if (index === 1 || last === '->') return placeCandidates(doc);
      return index === 2 ? [word('->')] : keys(VERB_KEYS.road);
    case 'copy': return index === 1 ? words(COPY_PROPS, 'value') : keys(VERB_KEYS.copy);
    case 'speed': case 'run': case 'pause': case 'reset': case 'undo': case 'redo': return [];
  }
  if (!TARGET_VERBS.has(verb)) return [];
  if (index === 1) {
    // (the short fixed words first: the document's own names can be many)
    return [
      ...(verb === 'select' ? [word('none')] : []),
      ...(verb === 'count' || verb === 'list' || verb === 'info' ? words(QUERY_TOPICS) : []),
      ...(verb === 'focus' ? keys(VERB_KEYS.focus) : []),
      ...targetCandidates(doc),
      ...(verb === 'measure' ? placeCandidates(doc) : []),
    ];
  }
  return [
    ...keys(VERB_KEYS[verb]),
    ...(verb === 'match' ? words(MATCH_WHAT, 'value') : []),
    ...(verb === 'distribute' ? [word('gaps')] : []),
    ...words(TARGET_MORE),
  ];
}

/** No duplicates (the same text offered twice by two lists), in the order first offered. */
function unique(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)));
}

/**
 * The completion of the word under the caret. `caret` is an index into `text`; a script's lines are completed one by
 * one (the line the caret is on). No candidates = nothing to offer there.
 */
export function complete(text: string, caret: number, doc: WorldDocument): Completion {
  const at = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at);
  const lineEnd = nl < 0 ? text.length : nl;
  const toks = scan(text.slice(lineStart, lineEnd), lineStart);
  // The token the caret is in or at the end of; between words there is an empty one.
  const k = toks.findIndex((t) => at >= t.start && at <= t.end);
  const cur: Tok = k >= 0 ? toks[k] : { start: at, end: at, text: '' };
  const before = (k >= 0 ? toks.slice(0, k) : toks.filter((t) => t.end < at)).map((t) => t.text);
  const typed = text.slice(cur.start, at);

  let from = cur.start;
  let prefix = typed;
  let list: Candidate[];
  if (before.length === 0) list = verbCandidates(typed);
  else {
    const verb = verbOf(before[0]);
    if (!verb) return { from, to: cur.end, candidates: [], total: 0 };
    const eq = /^([A-Za-z_]\w*)=/.exec(typed);
    if (eq) {
      // `key=value`: only the value is replaced.
      from = cur.start + eq[0].length;
      prefix = typed.slice(eq[0].length);
      list = valueCandidates(verb, eq[1].toLowerCase(), before, doc);
    } else list = wordCandidates(verb, before, doc);
  }
  const low = prefix.toLowerCase();
  const hits = unique(list).filter((c) => c.text.toLowerCase().startsWith(low) && c.text !== prefix);
  return { from, to: cur.end, candidates: hits.slice(0, MAX_CANDIDATES), total: hits.length };
}

/** The text with candidate `k` in place, and where the caret goes (a finished word is followed by one space). */
export function applyCompletion(text: string, c: Completion, k: number): { text: string; caret: number } {
  const cand = c.candidates[k];
  if (!cand) return { text, caret: c.to };
  const rest = text.slice(c.to);
  // (a space or a tab already follows; the end of a script line does not count)
  const space = !cand.open && !/^[^\S\n]/.test(rest) ? ' ' : '';
  const head = text.slice(0, c.from) + cand.text + space;
  return { text: head + rest, caret: head.length };
}
