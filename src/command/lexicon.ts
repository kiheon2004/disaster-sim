/**
 * Phase 37 — the lexicon of the natural-language parser (§7 "손으로 중복 정의 금지"): built ONCE at module load from
 *
 *  - the object palette through `KINDS` (kinds.ts): the Korean / English palette labels, split at `/`, `·`, `(…)`;
 *  - the phenomenon registry (`phenomena.listImplemented()`): the Korean / English names of every implemented disaster;
 *  - `aliases.ts`: the hand-written aliases and grammar words.
 *
 * `lex(text)` cuts a normalised line into tokens with a longest-match dictionary (Korean without spaces works:
 * 주택세채 → 주택 + 3채), choosing the cut with the fewest unknown characters, then the fewest tokens.
 * Pure: no store, no clock, no randomness.
 */
import { translate, type Locale, type MessageKey } from '@/i18n/i18n';
import { phenomena } from '@/phenomena/registry';
import { KINDS, KIND_TYPES } from './kinds';
import {
  DISASTER_ALIASES, DISASTER_PRIORITY, DISASTER_VARIANTS, FILLERS, KIND_ALIASES, KIND_EXCLUDED_TYPES, KIND_PRIORITY, LEGACY_WORDS, LIGHT_CONNECTIVES,
  PARTICLES_KO, PLURALS_EN, PREPOSITIONS_EN, SEPARATORS, VERBS, WORDS, type UnitId,
} from './aliases';
import { ID_CLOSE, ID_OPEN, QUOTE_CLOSE, QUOTE_OPEN, readQuantity, readUnit, type Normalized } from './normalize';

// ── Senses and tokens ────────────────────────────────────────────────────────────────────

export type Sense =
  | { c: 'kind'; key: string; plural?: boolean }
  | { c: 'dis'; type: string; fields?: Record<string, number | string> }
  | { c: 'verb'; id: string; conn?: boolean }
  /** A grammar word (`dir:north`, `rank:tallest`, `gap` …). */
  | { c: 'w'; id: string }
  /** A Korean particle (marks the word before it) / an English preposition (marks the phrase after it). */
  | { c: 'part'; id: string }
  | { c: 'prep'; id: string }
  /** Politeness, endings, articles: never change the meaning. */
  | { c: 'fill' }
  /** A clause separator (그리고, and, then …). */
  | { c: 'sep' }
  /** A word only the old disaster grammar reads. */
  | { c: 'legacy' };

type TokBody =
  | { t: 'num'; v: number; typed: number; u: UnitId | null; counter?: string; text: string }
  | { t: 'w'; s: Sense[]; text: string }
  | { t: 'q'; text: string }
  | { t: 'id'; kind: 'obj' | 'node' | 'seg' | 'inst'; id: string; text: string }
  | { t: 'btw'; a: string; b: string; text: string }
  | { t: 'xz'; x: number; z: number; text: string }
  | { t: 'p'; text: string }
  | { t: '?'; text: string };

/** A token with its place in the normalised text (`at` … `end`). `?` = not understood. */
export type Tok = TokBody & { at: number; end: number };

// ── Names from the tables in code ────────────────────────────────────────────────────────

const clean = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The names in a UI label: without `(…)`, split at `/` and `·`. "소형 주택 (목조)" → 소형 주택; "바람 / 태풍" → 바람, 태풍. */
export function labelNames(label: string): string[] {
  return label.replace(/[(（][^)）]*[)）]/g, ' ').split(/[/·]/).map(clean).filter(Boolean);
}

const HANGUL = /[가-힣]/;
const langOf = (word: string): Locale => (HANGUL.test(word) ? 'ko' : 'en');

function pluralEn(word: string): string {
  if (PLURALS_EN[word]) return PLURALS_EN[word];
  const i = word.lastIndexOf(' ');
  const head = word.slice(0, i + 1), last = word.slice(i + 1);
  if (PLURALS_EN[last]) return head + PLURALS_EN[last];
  if (/(?:s|x|ch|sh)$/.test(last)) return `${head}${last}es`;
  if (/[^aeiou]y$/.test(last)) return `${head}${last.slice(0, -1)}ies`;
  return `${head}${last}s`;
}

export interface NameTable {
  /** word → the key it means (after the priority table). */
  words: Map<string, string>;
  /** Words claimed by more than one key: word → the keys (in table order). Each must be in the priority table. */
  collisions: Map<string, string[]>;
}

function nameTable(entries: [key: string, word: string][], priority: Record<string, string>): NameTable {
  const claims = new Map<string, string[]>();
  for (const [key, raw] of entries) {
    const word = clean(raw);
    if (!word) continue;
    const list = claims.get(word) ?? [];
    if (!list.includes(key)) list.push(key);
    claims.set(word, list);
  }
  const words = new Map<string, string>();
  const collisions = new Map<string, string[]>();
  for (const [word, keys] of claims) {
    if (keys.length > 1) collisions.set(word, keys);
    words.set(word, keys.length > 1 && priority[word] && keys.includes(priority[word]) ? priority[word] : keys[0]);
  }
  return { words, collisions };
}

/** Kind words: palette labels and object type names (Korean, English), then the aliases. */
export const KIND_NAMES: NameTable = (() => {
  const entries: [string, string][] = [];
  for (const k of KINDS) {
    if (KIND_EXCLUDED_TYPES.includes(k.type)) continue;
    for (const lang of ['ko', 'en'] as const) for (const name of labelNames(translate(lang, k.item.labelKey))) entries.push([k.key, name]);
  }
  for (const type of KIND_TYPES) {
    if (KIND_EXCLUDED_TYPES.includes(type)) continue;
    for (const lang of ['ko', 'en'] as const) for (const name of labelNames(translate(lang, `object.${type}` as MessageKey))) entries.push([type, name]);
  }
  for (const [key, w] of Object.entries(KIND_ALIASES)) for (const word of [...(w.ko ?? []), ...(w.en ?? [])]) entries.push([key, word]);
  return nameTable(entries, KIND_PRIORITY);
})();

/** Disaster words: registry labels (Korean, English), then the aliases. */
export const DISASTER_NAMES: NameTable = (() => {
  const entries: [string, string][] = [];
  for (const def of phenomena.listImplemented()) for (const lang of ['ko', 'en'] as const) for (const name of labelNames(translate(lang, def.labelKey))) entries.push([def.type, name]);
  for (const [type, w] of Object.entries(DISASTER_ALIASES)) for (const word of [...(w.ko ?? []), ...(w.en ?? [])]) entries.push([type, word]);
  return nameTable(entries, DISASTER_PRIORITY);
})();

// ── Korean verb forms ────────────────────────────────────────────────────────────────────

const FINAL_L = 8, FINAL_B = 17;
const isSyllable = (c: string) => c >= '가' && c <= '힣';
const finalOf = (c: string): number => (isSyllable(c) ? (c.charCodeAt(0) - 0xac00) % 28 : -1);
const withFinal = (c: string, t: number): string => String.fromCharCode(c.charCodeAt(0) - finalOf(c) + t);
const lastWithFinal = (stem: string, t: number): string => stem.slice(0, -1) + withFinal(stem[stem.length - 1], t);

/**
 * The forms of a Korean verb the parser accepts: the command itself (놓아), polite and plain endings, and the two
 * connectives that end a clause (놓고, 놓아서). `줘 / 주세요 / 봐` after the command are separate filler words.
 */
export function koVerbForms(stem: string, aForms: readonly string[]): { form: string; conn: boolean }[] {
  const out: { form: string; conn: boolean }[] = [];
  const t = finalOf(stem[stem.length - 1]);
  for (const a of aForms) {
    for (const end of ['', '라', '요']) out.push({ form: a + end, conn: false });
    out.push({ form: `${a}서`, conn: true });
  }
  out.push({ form: `${stem}고`, conn: true }, { form: `${stem}자`, conn: false });
  if (t === 0) out.push({ form: `${stem}세요`, conn: false }, { form: `${lastWithFinal(stem, FINAL_L)}래`, conn: false }, { form: `${lastWithFinal(stem, FINAL_B)}니다`, conn: false });
  else if (t === FINAL_L) out.push({ form: `${lastWithFinal(stem, 0)}세요`, conn: false }, { form: `${stem}래`, conn: false }, { form: `${lastWithFinal(stem, FINAL_B)}니다`, conn: false });
  else if (t > 0) out.push({ form: `${stem}으세요`, conn: false }, { form: `${stem}을래`, conn: false }, { form: `${stem}습니다`, conn: false });
  return out;
}

// ── The dictionary ───────────────────────────────────────────────────────────────────────

/** Every word of the lexicon → its senses. */
export const LEXICON: Map<string, Sense[]> = (() => {
  const map = new Map<string, Sense[]>();
  const add = (raw: string, sense: Sense) => {
    const word = clean(raw).replace(/-/g, ' ');
    if (!word) return;
    const list = map.get(word) ?? [];
    if (!list.some((s) => JSON.stringify(s) === JSON.stringify(sense))) list.push(sense);
    map.set(word, list);
  };
  for (const [word, key] of KIND_NAMES.words) {
    add(word, { c: 'kind', key });
    if (langOf(word) === 'en') add(pluralEn(word), { c: 'kind', key, plural: true });
  }
  for (const [word, type] of DISASTER_NAMES.words) {
    const fields = DISASTER_VARIANTS[word];
    add(word, fields ? { c: 'dis', type, fields } : { c: 'dis', type });
    if (langOf(word) === 'en' && !/s$/.test(word)) add(pluralEn(word), fields ? { c: 'dis', type, fields } : { c: 'dis', type });
  }
  for (const [id, v] of Object.entries(VERBS)) {
    for (const [stem, ...aForms] of v.ko ?? []) for (const f of koVerbForms(stem, aForms)) add(f.form, f.conn ? { c: 'verb', id, conn: true } : { c: 'verb', id });
    for (const n of v.noun ?? []) add(n, { c: 'verb', id });
    for (const e of v.en ?? []) add(e, { c: 'verb', id });
  }
  for (const [id, w] of Object.entries(WORDS)) for (const word of [...(w.ko ?? []), ...(w.en ?? [])]) add(word, { c: 'w', id });
  for (const [id, forms] of Object.entries(PARTICLES_KO)) for (const f of forms) add(f, { c: 'part', id });
  for (const [id, forms] of Object.entries(PREPOSITIONS_EN)) for (const f of forms) add(f, { c: 'prep', id });
  for (const f of [...(FILLERS.ko ?? []), ...(FILLERS.en ?? [])]) add(f, { c: 'fill' });
  for (const f of [...(SEPARATORS.ko ?? []), ...(SEPARATORS.en ?? []), ...LIGHT_CONNECTIVES]) add(f, { c: 'sep' });
  for (const f of [...(LEGACY_WORDS.ko ?? []), ...(LEGACY_WORDS.en ?? [])]) add(f, { c: 'legacy' });
  return map;
})();

interface Node {
  next: Map<string, Node>;
  /** A space of the entry: optional in a Korean entry (선택한 것 = 선택한것), required (or a hyphen) in an English one. */
  space?: Node;
  optionalSpace?: boolean;
  senses?: Sense[];
  word?: string;
}

const TRIE: Node = (() => {
  const root: Node = { next: new Map() };
  for (const [word, senses] of LEXICON) {
    const korean = HANGUL.test(word);
    let n = root;
    for (const ch of word) {
      if (ch === ' ') {
        n.space ??= { next: new Map() };
        if (korean) n.optionalSpace = true;
        n = n.space;
      } else {
        let c = n.next.get(ch);
        if (!c) { c = { next: new Map() }; n.next.set(ch, c); }
        n = c;
      }
    }
    n.senses = senses;
    n.word = word;
  }
  return root;
})();

const isLatinChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);

/** Every lexicon entry that starts at `i` (longest first). */
export function matchAt(text: string, i: number): { len: number; senses: Sense[]; word: string }[] {
  const out: { len: number; senses: Sense[]; word: string }[] = [];
  const startsLatin = isLatinChar(text[i]);
  if (startsLatin && isLatinChar(text[i - 1])) return out;
  const walk = (n: Node, p: number) => {
    if (n.senses && p > i && !(isLatinChar(text[p - 1]) && isLatinChar(text[p]))) out.push({ len: p - i, senses: n.senses, word: n.word! });
    if (n.space) {
      let j = p;
      while (text[j] === ' ' || (text[j] === '-' && j === p)) j++;
      if (j > p) walk(n.space, j);
      if (n.optionalSpace) walk(n.space, p);
    }
    const c = text[p];
    const child = c === undefined ? undefined : n.next.get(c);
    if (child) walk(child, p + 1);
  };
  walk(TRIE, i);
  return out.sort((a, b) => b.len - a.len);
}

// ── Lexer ────────────────────────────────────────────────────────────────────────────────

interface Candidate { len: number; toks: TokBody[]; cost: number }

const NUM = '-?\\d+(?:\\.\\d+)?';
const RE_PAREN_XZ = new RegExp(`^\\(\\s*(${NUM})\\s*m?\\s*,\\s*(${NUM})\\s*m?\\s*\\)`);
const RE_BARE_XZ = new RegExp(`^(${NUM}), ?(${NUM})(?![\\d.,a-z])`);
const RE_LABEL_XZ = new RegExp(`^x\\s*=?\\s*(${NUM})\\s*m?\\s*,?\\s*z\\s*=?\\s*(${NUM})(?![\\d.a-z])`);
const RE_BETWEEN = /^(n\d+)\s*-\s*(n\d+)(?![a-z0-9])/;
const RE_ID = /^([nsp])(\d+)(?![a-z0-9])/;
const RE_HASH = /^#\s*(\d+)(?![\d.a-z])/;
const RE_MAGNITUDE = /^m\s?(\d+(?:\.\d+)?)(?![\d.a-z])/;
const PUNCT = new Set([',', ';', '?', '!', '.', '(', ')', '=', ':', '-', '/', '+', '*']);

const UNKNOWN_COST = 1000;

function candidatesAt(text: string, i: number, n: Normalized): Candidate[] {
  const c = text[i];
  const rest = text.slice(i, i + 64);
  const out: Candidate[] = [];
  const one = (len: number, tok: TokBody, cost = 1) => out.push({ len, toks: [tok], cost });
  if (c === QUOTE_OPEN || c === ID_OPEN) {
    const end = text.indexOf(c === QUOTE_OPEN ? QUOTE_CLOSE : ID_CLOSE, i);
    const index = Number(text.slice(i + 1, end));
    if (c === QUOTE_OPEN) one(end + 1 - i, { t: 'q', text: n.quotes[index] });
    else {
      const id = n.ids[index];
      one(end + 1 - i, /^p\d+$/i.test(id) ? { t: 'id', kind: 'inst', id: id.toLowerCase(), text: `#${id}` } : { t: 'id', kind: 'obj', id, text: `#${id}` });
    }
    return out;
  }
  const wordStart = !isLatinChar(text[i - 1]);
  const numeric = (c >= '0' && c <= '9') || c === '-';
  let m: RegExpExecArray | null;
  if (c === '(' && (m = RE_PAREN_XZ.exec(rest))) one(m[0].length, { t: 'xz', x: Number(m[1]), z: Number(m[2]), text: m[0] });
  // 40,60 · -20, 35: two numbers with NO unit ("5 m, 30도" are two amounts)
  if (numeric && wordStart && text[i - 1] !== '.' && text[i - 1] !== ',' && (m = RE_BARE_XZ.exec(rest)) && !readUnit(text, i + m[0].length) && !readUnit(text, i + m[1].length)) {
    one(m[0].length, { t: 'xz', x: Number(m[1]), z: Number(m[2]), text: m[0] });
  }
  if (c === 'x' && wordStart && (m = RE_LABEL_XZ.exec(rest))) one(m[0].length, { t: 'xz', x: Number(m[1]), z: Number(m[2]), text: m[0] });
  if (c === 'n' && wordStart && (m = RE_BETWEEN.exec(rest))) one(m[0].length, { t: 'btw', a: m[1], b: m[2], text: m[0] });
  if ((c === 'n' || c === 's' || c === 'p') && wordStart && (m = RE_ID.exec(rest))) one(m[0].length, { t: 'id', kind: m[1] === 'n' ? 'node' : m[1] === 's' ? 'seg' : 'inst', id: m[0], text: m[0] });
  if (c === '#' && (m = RE_HASH.exec(rest))) one(m[0].length, { t: 'num', v: Number(m[1]), typed: Number(m[1]), u: 'hash', text: m[0] });
  if (c === 'm' && wordStart && (m = RE_MAGNITUDE.exec(rest))) {
    out.push({ len: m[0].length, cost: 2, toks: [{ t: 'w', s: [{ c: 'w', id: 'magnitude' }], text: 'm' }, { t: 'num', v: Number(m[1]), typed: Number(m[1]), u: null, text: m[1] }] });
  }
  for (const q of readQuantity(text, i)) {
    one(q.len, { t: 'num', v: q.value, typed: q.typed, u: q.unit, text: text.slice(i, i + q.len), ...(q.counter ? { counter: q.counter } : {}) });
  }
  for (const hit of matchAt(text, i)) one(hit.len, { t: 'w', s: hit.senses, text: text.slice(i, i + hit.len) });
  if (rest.startsWith('->')) one(2, { t: 'p', text: '->' });
  else if (PUNCT.has(c)) one(1, { t: 'p', text: c });
  // Not understood: a whole Latin word, or one other character.
  const unknown = isLatinChar(c) ? /^[a-z0-9_']+/.exec(rest)![0].length : 1;
  out.push({ len: unknown, toks: [{ t: '?', text: text.slice(i, i + unknown) }], cost: UNKNOWN_COST });
  return out.sort((a, b) => b.len - a.len);
}

/** Cut a normalised line into tokens: fewest unknown pieces, then fewest tokens, then the longest first match. */
export function lex(n: Normalized): Tok[] {
  const text = n.text;
  const L = text.length;
  const cost = new Float64Array(L + 1);
  const pick: (Candidate | null)[] = new Array(L + 1).fill(null);
  for (let i = L - 1; i >= 0; i--) {
    if (text[i] === ' ') { cost[i] = cost[i + 1]; continue; }
    let best: Candidate | null = null, bestCost = Infinity;
    for (const cand of candidatesAt(text, i, n)) {
      const total = cand.cost + cost[Math.min(L, i + cand.len)];
      if (total < bestCost) { best = cand; bestCost = total; }
    }
    cost[i] = bestCost;
    pick[i] = best;
  }
  const out: Tok[] = [];
  for (let i = 0; i < L; ) {
    const cand = pick[i];
    if (!cand) { i++; continue; }
    for (const tok of cand.toks) {
      const last = out[out.length - 1];
      // Unknown characters next to each other are one unknown word.
      if (tok.t === '?' && last?.t === '?' && last.end === i) { last.text += tok.text; last.end = i + cand.len; }
      else out.push({ ...tok, at: i, end: i + cand.len });
    }
    i += cand.len;
  }
  return out;
}

// ── Helpers for the rules ────────────────────────────────────────────────────────────────

export const sensesOf = (tok: Tok): Sense[] => (tok.t === 'w' ? tok.s : []);

/** The language a sentence is written in, from its script (a Korean sentence may hold Latin ids and units). */
export function detectLanguage(text: string): Locale {
  return HANGUL.test(text) ? 'ko' : 'en';
}

/** Lexicon ids (verb ids, word ids, `kind`, `disaster`) of the words found in a text — for suggestions. */
export function tagsOf(toks: Tok[]): Set<string> {
  const out = new Set<string>();
  for (const tok of toks) for (const s of sensesOf(tok)) {
    if (s.c === 'kind') out.add('kind');
    else if (s.c === 'dis') out.add('disaster');
    else if (s.c === 'verb' || s.c === 'w') out.add(s.id);
  }
  return out;
}
