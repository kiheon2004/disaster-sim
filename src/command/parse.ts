/**
 * Phase 37 — one line of text → command intents (§4, §6; NL-CONVENTIONS.md). The rule-based Korean / English parser.
 *
 *   parseCommand(text) → ok (intents + their canonical text) | ask (one missing piece) | unknown (reason + suggestions)
 *
 * Order: (1) canonical text, when the line starts with a canonical verb (or a Korean verb alias) and parses — a line
 * written in canonical syntax (key=value, type:…, ->) that does NOT parse is `unknown` with the canonical error and is
 * not read as natural language; (2) the rules (rules.ts), clause by clause; (3) the old disaster grammar
 * (legacyDisaster.ts) for a clause the rules read nothing in; (4) `unknown`.
 *
 * Safety: negated and conditional sentences are refused before any rule runs; a clause with a word outside the
 * lexicon is `unknown`; every clause must be read completely by one rule (the leftover rule, rules.ts); every intent
 * returned has been through `formatCanonical` → `parseCanonical` → `validateIntents` (what is returned is exactly what
 * its canonical text parses to).
 *
 * Pure and synchronous: no store, no clock, no randomness, no network.
 */
import type { I18nMessage } from '@/i18n/i18n';
import { formatCanonical, formatTarget, parseCanonical, VERBS as CANONICAL_VERBS, VERB_ALIASES_KO, type CanonicalError } from './canonical';
import { validateIntents, type Intent, type TargetRef } from './intent';
import { CONDITIONAL, NEGATION, NEGATION_ALLOWED, TEMPLATES } from './aliases';
import { eventsOf, legacyClause, type LegacyEvent } from './legacyDisaster';
import { lex, tagsOf, type Sense, type Tok } from './lexicon';
import { ID_CLOSE, ID_OPEN, QUOTE_CLOSE, QUOTE_OPEN, normalizeText } from './normalize';
import { Clause, parseClause, type AskSlot, type CT, type Ctx, type Out } from './rules';

export type { AskSlot } from './rules';
export type Msg = I18nMessage;

export type ParseOutcome =
  | { kind: 'ok'; intents: Intent[]; canonical: string[]; source: 'canonical' | 'rules' | 'legacy' | 'provider'; notes: Msg[] }
  /** `understood`: what was read so far, as text for the user (the missing piece is a `?`). */
  | { kind: 'ask'; slot: AskSlot; question: Msg; understood: string }
  /** `suggestions`: the 2–3 nearest canonical commands. */
  | { kind: 'unknown'; reason: Msg; suggestions: string[] };

// ── Suggestions ──────────────────────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(up + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * The nearest canonical commands for a sentence that was not understood: templates ranked by the words they share
 * with it (verb / word ids of the lexicon), then by edit distance to the text, then by table order. Deterministic.
 */
export function suggest(text: string, toks: Tok[]): string[] {
  const tags = tagsOf(toks);
  const line = text.trim().toLowerCase();
  const first = line.split(/\s+/)[0] ?? '';
  // A line that starts like a canonical command: the verbs nearest to its first word count as shared words.
  const nearVerb = /^[a-z=]+$/.test(first) ? [...CANONICAL_VERBS].sort((a, b) => editDistance(first, a) - editDistance(first, b) || (a < b ? -1 : 1))[0] : null;
  const ranked = TEMPLATES.map((t, index) => ({
    text: t.text,
    index,
    shared: t.tags.filter((tag) => tags.has(tag)).length + (nearVerb && editDistance(first, nearVerb) <= 2 && t.text.startsWith(nearVerb) ? 2 : 0),
    distance: editDistance(line.slice(0, 80), t.text),
  }));
  ranked.sort((a, b) => b.shared - a.shared || a.distance - b.distance || a.index - b.index);
  return ranked.slice(0, 3).map((r) => r.text);
}

const unknownOf = (reason: Msg, text: string, toks: Tok[]): ParseOutcome => ({ kind: 'unknown', reason, suggestions: suggest(text, toks) });

// ── (1) Canonical text ───────────────────────────────────────────────────────────────────

const canonicalDetail = (e: CanonicalError): string => [e.code, e.token !== undefined ? `"${e.token}"` : '', e.expected ? `→ ${e.expected}` : ''].filter(Boolean).join(' ');

/** Marks of the canonical syntax outside quoted text: key=value, type: / node: / seg: … references, `->`, `where`. */
const CANONICAL_SYNTAX = /(?:^|\s)[A-Za-z_]\w*=\S|(?:^|[\s(=])(?:type|node|seg|road|group|name|feature):\S|->|\swhere\s/;

function canonicalStep(line: string): ParseOutcome | null {
  const first = line.split(/\s+/)[0];
  const lower = first.toLowerCase();
  const english = (CANONICAL_VERBS as readonly string[]).includes(lower) || lower.startsWith('speed=');
  if (!english && VERB_ALIASES_KO[first] === undefined) return null;
  const r = parseCanonical(line);
  if (r.ok) return { kind: 'ok', intents: [r.intent], canonical: [formatCanonical(r.intent)], source: 'canonical', notes: [] };
  // A line in canonical syntax that does not parse is an error of that syntax — never a guess in natural language.
  if (english && CANONICAL_SYNTAX.test(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
    return unknownOf({ key: 'cmd37.nl.unknown.canonical', params: { detail: canonicalDetail(r.error) } }, line, []);
  }
  return null;
}

// ── Refused before any rule ──────────────────────────────────────────────────────────────

const re = (sources: readonly string[], flags = '') => new RegExp(sources.map((s) => `(?:${s})`).join('|'), flags);
const RE_NEGATION = re(NEGATION);
const RE_NEGATION_ALLOWED = re(NEGATION_ALLOWED, 'g');
const RE_CONDITIONAL = re(CONDITIONAL);
const RE_PLACEHOLDER = new RegExp(`[${QUOTE_OPEN}${ID_OPEN}]\\d+[${QUOTE_CLOSE}${ID_CLOSE}]`, 'g');

/** Negation / prohibition and conditionals / loops (conventions §5): the reason, or null. */
function refused(normalized: string): Msg | null {
  const text = normalized.replace(RE_PLACEHOLDER, ' ').replace(RE_NEGATION_ALLOWED, ' ');
  if (RE_NEGATION.test(text)) return { key: 'cmd37.nl.unknown.negation' };
  if (RE_CONDITIONAL.test(text)) return { key: 'cmd37.nl.unknown.conditional' };
  return null;
}

// ── Clauses (conventions §4) ─────────────────────────────────────────────────────────────

interface Segment { toks: Tok[]; question: boolean }

const has = (t: Tok | undefined, test: (s: Sense) => boolean): boolean => !!t && t.t === 'w' && t.s.some(test);
const isWeak = (t: Tok): boolean => t.t === 'w' && t.s.every((s) => s.c === 'part' || s.c === 'prep' || s.c === 'fill');
const nounLike = (t: Tok | undefined): boolean => !!t && (t.t === 'q' || t.t === 'id' || t.t === 'xz' || t.t === 'num' || has(t, (s) => s.c === 'kind' || s.c === 'dis' || (s.c === 'w' && /^(?:det:|place:|feature:|prop:|thing$|plural$)/.test(s.id))));
const isProp = (t: Tok | undefined): boolean => has(t, (s) => s.c === 'w' && (s.id.startsWith('prop:') || s.id === 'height'));

/** Cut a line into segments at `,` `;` `?` `.`, the separator words (그리고, and, then …) and connective verb endings (-고, -서). */
function segments(toks: Tok[]): Segment[] {
  const out: Segment[] = [];
  let cur: Tok[] = [];
  let betweenAt = -99;
  const close = (question = false) => {
    if (cur.length) out.push({ toks: cur, question });
    else if (question && out.length) out[out.length - 1].question = true;
    cur = [];
    betweenAt = -99;
  };
  const lastContent = (): Tok | undefined => [...cur].reverse().find((t) => !isWeak(t));
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'p') {
      // structure, parameters and physics: one list of properties
      if (t.text === ',' && isProp(lastContent()) && isProp(toks.slice(k + 1).find((x) => !isWeak(x)))) continue;
      if (t.text === ',' || t.text === ';' || t.text === '.') close();
      else if (t.text === '?') close(true);
      else if (t.text === '->' || t.text === '=') cur.push(t);
      else if (t.text !== '!') cur.push({ ...t, t: '?' }); // stray punctuation is not understood
      continue;
    }
    if (t.t === 'w' && t.s.some((s) => s.c === 'sep')) {
      // 나무하고 차: "하고" after a noun is "and" (one list), not a clause boundary.
      const before = cur[cur.length - 1];
      if (t.s.some((s) => s.c === 'part') && before && !isWeak(before) && nounLike(before)) { cur.push({ ...t, s: t.s.filter((s) => s.c === 'part') }); continue; }
      if (t.text === 'and') {
        // between n2 and n3 · the size and heading of … : one phrase
        if (cur.length - betweenAt <= 3) continue;
        const next = toks.slice(k + 1).find((x) => !isWeak(x));
        if (isProp(lastContent()) && isProp(next)) continue;
      }
      close();
      continue;
    }
    if (has(t, (s) => s.c === 'w' && s.id === 'between')) betweenAt = cur.length;
    cur.push(t);
    const verbs = t.t === 'w' ? t.s.filter((s) => s.c === 'verb') : [];
    if (verbs.length && verbs.every((v) => v.c === 'verb' && v.conn)) close();
  }
  close();
  return out;
}

/** Word ids of fragments that only modify the command before them (간격 2 m · 5초 뒤 · 밀도 낮게 · 반경 3 m · 2 m apart). */
const MODIFIERS = /^(?:gap|spaced|touching|heading|density|dens:.*|seed|after|during|ref:.*|basis|clockwise|counterclockwise|byOrigins|daxis:.*|radius|diameter|height|atHeight|magnitude|pga|tnt|perHour|perMinute|perSecond|windSpeed|speedNoun|angle|coreRadius|wind:.*|boundary|level)$/;

const disasterTypes = (seg: Segment): Set<string> => {
  const out = new Set<string>();
  for (const t of seg.toks) if (t.t === 'w') for (const s of t.s) if (s.c === 'dis') out.add(s.type);
  return out;
};

/**
 * What a segment is: a `modifier` fragment with no head of its own (…, 간격 2 m · …, 5초 뒤 · …, 수위 2 m · …, 북쪽 경계 ·
 * …, like #id · …, called "X"), a `bareKind` (a kind noun and nothing else: a list going on), or a `full` clause.
 */
function segmentKind(seg: Segment, prev: Segment | undefined): 'modifier' | 'bareKind' | 'full' {
  const firstWord = seg.toks.find((t) => !(t.t === 'w' && t.s.every((s) => s.c === 'fill')));
  // …, like #id · …, as the first one · …, called "X" · …, named "X": a reference / a name for the command before
  if (prev && firstWord?.t === 'w' && (firstWord.s.some((s) => s.c === 'prep' && (s.id === 'like' || s.id === 'as')) || firstWord.s.some((s) => s.c === 'w' && s.id === 'called'))) return 'modifier';
  const earlier = prev ? disasterTypes(prev) : new Set<string>();
  const hasBoundary = seg.toks.some((t) => has(t, (s) => s.c === 'w' && s.id === 'boundary'));
  const speedRate = seg.toks.some((t) => t.t === 'num' && t.u === 'mps');
  let modifier = true, bareKind = true, kinds = 0;
  for (const t of seg.toks) {
    if (isWeak(t) || (t.t === 'p' && (t.text === '->' || t.text === '='))) continue;
    // 2배속 · 2x · 두 배로 · 10% are commands by themselves (speed, scale)
    if (t.t === 'num') { bareKind = false; if (t.u === 'x' || t.u === 'speedx' || t.u === 'pct') return 'full'; continue; }
    if (t.t !== 'w') return 'full';
    const content = t.s.filter((s) => s.c !== 'part' && s.c !== 'prep' && s.c !== 'fill');
    if (content.some((s) => s.c === 'verb')) return 'full';
    // "…, 수위 2 m" / "…, 2 m 침하": the disaster word of the command before, used as a label
    if (content.some((s) => s.c === 'dis')) { if (content.some((s) => s.c === 'dis' && earlier.has(s.type))) { bareKind = false; continue; } return 'full'; }
    if (content.some((s) => s.c === 'kind')) { modifier = false; kinds++; continue; }
    // "speed 2" is a command; "속도 20 km/s" is a field of the disaster before
    if (content.some((s) => s.c === 'w' && s.id === 'speedNoun') && !speedRate) return 'full';
    const compass = hasBoundary && content.some((s) => s.c === 'w' && /^dir:(?:north|south|east|west)$/.test(s.id));
    if (!compass && !content.some((s) => s.c === 'w' && MODIFIERS.test(s.id))) modifier = false;
    if (!content.every((s) => s.c === 'w' && (s.id === 'all' || s.id === 'plural'))) bareKind = false;
  }
  return modifier && seg.toks.some((t) => !isWeak(t)) ? 'modifier' : bareKind && kinds > 0 ? 'bareKind' : 'full';
}

/**
 * A fragment with no head of its own belongs to the command before it ("…, 간격 2 m", "…, 5초 뒤"); a bare kind noun
 * after a separator continues a list ("나무, 차" / "trees and cars" — two kinds in one target, which is not supported).
 */
function mergeFragments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    // Only politeness / particles ("…, please."): no meaning of its own.
    if (seg.toks.every((t) => isWeak(t))) { if (out.length) out[out.length - 1].question ||= seg.question; continue; }
    const prev = out[out.length - 1];
    if (prev && segmentKind(seg, prev) !== 'full') {
      prev.toks = [...prev.toks, ...seg.toks];
      prev.question ||= seg.question;
    } else out.push({ ...seg });
  }
  return out;
}

/** Tokens → content tokens with the roles of the particles / prepositions around them. */
function toClause(seg: Segment): Clause {
  const ts: CT[] = [];
  let pre: string[] = [];
  const toks = seg.toks;
  const lastWord = [...toks].reverse().find((t) => !(t.t === 'w' && t.s.every((s) => s.c === 'fill')));
  for (let k = 0; k < toks.length; k++) {
    let t = toks[k];
    if (t.t === 'p') { pre.push(t.text === '->' ? 'to' : 'eq'); continue; }
    if (t.t === 'w') {
      let content = t.s.filter((s) => s.c !== 'part' && s.c !== 'prep' && s.c !== 'fill' && s.c !== 'sep');
      // "이" before a kind is "this" (이 건물들); anywhere else a particle. "가" ends a sentence as "go" (n4로 가).
      if (content.some((s) => s.c === 'w' && s.id === 'det:this') && t.s.some((s) => s.c === 'part') && !has(toks[k + 1], (s) => s.c === 'kind')) content = [];
      if (content.some((s) => s.c === 'verb' && s.id === 'go') && t.s.some((s) => s.c === 'part') && t !== lastWord) content = [];
      if (!content.length) {
        for (const s of t.s) {
          if (s.c === 'part' && ts.length) ts[ts.length - 1].post.push(s.id);
          else if (s.c === 'prep') pre.push(s.id);
        }
        continue;
      }
      // "the first one" / "the largest one": one = a thing, not the number 1.
      t = { ...t, s: content };
    } else if (t.t === 'num' && /^ones?$/.test(t.text) && has(toks[k - 1], (s) => s.c === 'w' && /^(?:first|rank:)/.test(s.id))) {
      t = { t: 'w', s: [{ c: 'w', id: 'thing' }], text: t.text, at: t.at, end: t.end };
    }
    ts.push({ tok: t, pre, post: [], used: false });
    pre = [];
  }
  // 좌표 40, 60 · coordinates 40 60 → one point (the comma was a clause boundary only between two commands)
  for (let i = 0; i + 2 < ts.length; i++) {
    const a = ts[i + 1].tok, b = ts[i + 2].tok;
    if (has(ts[i].tok, (s) => s.c === 'w' && s.id === 'coordNoun') && a.t === 'num' && b.t === 'num' && a.u === null && b.u === null) {
      ts.splice(i, 3, { tok: { t: 'xz', x: a.v, z: b.v, text: `${a.text},${b.text}`, at: a.at, end: b.end }, pre: ts[i].pre, post: ts[i + 2].post, used: false });
    }
  }
  for (let i = ts.length - 2; i >= 0; i--) {
    if (has(ts[i].tok, (s) => s.c === 'w' && s.id === 'coordNoun') && ts[i + 1].tok.t === 'xz') { ts[i + 1].pre.push(...ts[i].pre); ts.splice(i, 1); }
  }
  const c = new Clause(ts);
  c.question = seg.question;
  return c;
}

// ── (2)–(4) Rules, legacy grammar, unknown ───────────────────────────────────────────────

const LAST: TargetRef = { base: { b: 'last' } };
type OkOut = Extract<Out, { r: 'ok' }>;

const sameTarget = (a: TargetRef | undefined, b: TargetRef | undefined): boolean => !!a && !!b && formatTarget(a) === formatTarget(b);

/** Fold a clause into the commands so far: "묶고 이름을 'X'으로" is one group command; several set fields are one set. */
function fold(intents: Intent[], prev: OkOut | null, out: OkOut): boolean {
  const last = intents[intents.length - 1];
  const now = out.intents[0];
  if (!prev || !last || out.intents.length !== 1) return false;
  if (now.kind === 'rename' && last.kind === 'group' && last.name === undefined && prev.cls === 'group' && !out.said) {
    last.name = now.name;
    return true;
  }
  if (now.kind === 'set' && last.kind === 'set' && sameTarget(now.target, last.target)) {
    const keys = ['x', 'y', 'z', 'heading', 'scale', 'lift'] as const;
    if (keys.some((k) => now[k] !== undefined && last[k] !== undefined)) return false;
    for (const k of keys) if (now[k] !== undefined) last[k] = now[k];
    return true;
  }
  return false;
}

/** The comma of "좌표 40, 60" is not a clause boundary: put the two halves back together. */
function rejoinCoordinates(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    const prev = out[out.length - 1];
    const a = prev?.toks[prev.toks.length - 1], b = prev?.toks[prev.toks.length - 2];
    if (prev && !prev.question && a?.t === 'num' && a.u === null && has(b, (s) => s.c === 'w' && s.id === 'coordNoun') && seg.toks[0]?.t === 'num' && seg.toks[0].u === null) {
      prev.toks = [...prev.toks, ...seg.toks];
      prev.question = seg.question;
    } else out.push({ ...seg });
  }
  return out;
}

/** One line of text → intents, a question about one missing piece, or "not understood". */
export function parseCommand(text: string): ParseOutcome {
  const line = text.trim();
  if (!line) return unknownOf({ key: 'cmd37.nl.unknown.empty' }, line, []);
  const canonical = canonicalStep(line);
  if (canonical) return canonical;

  const n = normalizeText(line);
  const toks = lex(n).map((t, k, all): Tok => {
    // 와 / 과 / 랑 join nouns; glued to a verb (불러와 = load) it is part of a word the lexicon does not know.
    const prev = all[k - 1];
    const joins = t.t === 'w' && t.s.every((s) => s.c === 'part' && s.id === 'and');
    const afterVerb = prev?.t === 'w' && prev.end === t.at && prev.s.some((s) => s.c === 'verb') && !prev.s.some((s) => s.c === 'kind' || s.c === 'dis' || s.c === 'w');
    return joins && afterVerb ? { t: '?', text: t.text, at: t.at, end: t.end } : t;
  });
  const no = refused(n.text);
  if (no) return unknownOf(no, line, toks);
  const strange = toks.filter((t) => t.t === '?').map((t) => t.text);

  const segs = mergeFragments(rejoinCoordinates(segments(toks)));
  if (!segs.length) return unknownOf({ key: 'cmd37.nl.unknown.empty' }, line, toks);

  const intents: Intent[] = [];
  const notes: Msg[] = [];
  let source: 'rules' | 'legacy' = 'rules';
  let ctx: Ctx = {};
  let prev: OkOut | null = null;
  let asked: Extract<Out, { r: 'ask' }> | null = null;
  const started: LegacyEvent[] = [];
  for (const seg of segs) {
    if (seg.toks.some((t) => t.t === '?')) {
      // "rename it to Depot" / "이름을 창고A로": a name that is not in quotes is asked for (never guessed) — only where a
      // name is marked (to … / called … / …(으)로 / …(이)라고); any other unknown word → unknown.
      const marked = seg.toks.every((t, k) => t.t !== '?'
        || has(seg.toks[k - 1], (s) => (s.c === 'prep' && (s.id === 'to' || s.id === 'as')) || (s.c === 'w' && s.id === 'called'))
        || has(seg.toks[k + 1], (s) => s.c === 'part' && (s.id === 'to' || s.id === 'called')));
      const named = marked ? parseClause(toClause({ toks: seg.toks.filter((t) => t.t !== '?'), question: seg.question }), ctx) : null;
      if (named?.r === 'ask' && named.slot === 'name') { asked ??= named; prev = null; continue; }
      return unknownOf({ key: 'cmd37.nl.unknown.words', params: { words: strange.join(', ') } }, line, toks);
    }
    let out = parseClause(toClause(seg), ctx);
    if (!out) {
      const old = legacyClause(n.text.slice(seg.toks[0].at, seg.toks[seg.toks.length - 1].end), seg.toks, started);
      if (old) { out = { r: 'ok', cls: 'legacy', intents: old.intents, notes: old.notes }; source = 'legacy'; }
    }
    if (!out) return unknownOf({ key: 'cmd37.nl.unknown.sentence' }, line, toks);
    if (out.r === 'bad') return unknownOf(out.reason, line, toks);
    if (out.r === 'ask') { asked ??= out; prev = null; continue; }
    started.push(...eventsOf(out.intents));
    if (out.notes) notes.push(...out.notes);
    if (!fold(intents, prev, out)) intents.push(...out.intents);
    // A later clause without a target: what this clause made, else what it acted on (§4).
    ctx = { inherit: out.makes ? LAST : out.target ?? ctx.inherit, area: out.area ?? ctx.area };
    prev = out;
  }
  // One clause is missing a piece: the whole sentence is that question — nothing runs (§6 D23).
  if (asked) return { kind: 'ask', slot: asked.slot, question: { key: `cmd37.nl.ask.${asked.slot}` }, understood: asked.understood };

  // What is returned is exactly what its canonical text parses to.
  const canonicalText: string[] = [];
  const checked: Intent[] = [];
  for (const intent of intents) {
    const textOf = formatCanonical(intent);
    const back = parseCanonical(textOf);
    if (!back.ok) return unknownOf({ key: 'cmd37.nl.unknown.unwritable', params: { detail: `${textOf} — ${canonicalDetail(back.error)}` } }, line, toks);
    canonicalText.push(formatCanonical(back.intent));
    checked.push(back.intent);
  }
  const valid = validateIntents(checked);
  if (!valid.ok) return unknownOf({ key: 'cmd37.nl.unknown.unwritable', params: { detail: valid.issues.join('; ') } }, line, toks);
  return { kind: 'ok', intents: valid.intents, canonical: canonicalText, source, notes };
}
