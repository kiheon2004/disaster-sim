/**
 * Phase 37 — text normalisation for the natural-language parser (NL-CONVENTIONS.md §1). Pure string functions.
 *
 *  - `normalizeText`: quoted text and `#ids` are set aside (never touched), scientific notation is read BEFORE Unicode
 *    NFKC (NFKC alone turns `10⁹` into `109`), then NFKC + lower case, punctuation variants, thousands separators and
 *    Korean large numbers after digits (18억, 3만, 2천, 5백).
 *  - `readQuantity`: a number at a position of the normalised text — digits, a Korean numeral with its counter / unit
 *    (세 채, 이층, 삼십 도), an English number word — and the unit after it, converted to the canonical unit
 *    (5 km → 5000 m, 30분 → 1800 s, 1.8 GJ → 1.8e9 J).
 *
 * The word tables (units, numerals, counters) are in aliases.ts.
 */
import {
  COUNTERS, LARGE_KO, NATIVE_ALONE, NATIVE_ONES, NATIVE_TENS, NUMBERS_EN, NUMBER_PHRASES_EN, ORDINALS_EN, SINO_DIGITS, SINO_PLACES, SINO_UNITS, UNITS,
  type UnitId,
} from './aliases';

// ── Placeholders ─────────────────────────────────────────────────────────────────────────

/** Quoted text is replaced by `\uE000<index>\uE001`, a typed `#id` by `\uE002<index>\uE003` (private-use characters). */
export const QUOTE_OPEN = '\uE000';
export const QUOTE_CLOSE = '\uE001';
export const ID_OPEN = '\uE002';
export const ID_CLOSE = '\uE003';

export interface Normalized {
  /** The normalised text (placeholders for quotes and ids). */
  text: string;
  /** Quoted texts, literally as typed. */
  quotes: string[];
  /** Typed ids (without the `#`), case kept. */
  ids: string[];
}

const QUOTE_PAIRS: Record<string, string> = { '"': '"', '“': '”', '‘': '’', '「': '」', '『': '』', "'": "'" };
const LATIN = /[A-Za-z0-9]/;

/** Set quoted text aside. A single quote after a Latin letter is an apostrophe (don't, buildings'), not a quotation. */
function extractQuotes(raw: string, quotes: string[]): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const close = QUOTE_PAIRS[c];
    if (close !== undefined && !(c === "'" && i > 0 && LATIN.test(raw[i - 1]))) {
      let j = raw.indexOf(close, i + 1);
      // A closing single quote is not followed by a Latin letter ('it's' is not handled: use double quotes).
      while (c === "'" && j !== -1 && j + 1 < raw.length && LATIN.test(raw[j + 1])) j = raw.indexOf(close, j + 1);
      if (j !== -1) {
        out += `${QUOTE_OPEN}${quotes.length}${QUOTE_CLOSE}`;
        quotes.push(raw.slice(i + 1, j));
        i = j;
        continue;
      }
    }
    out += c;
  }
  return out;
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUP_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g;
const fromSuperscript = (s: string): string => [...s].map((c) => (c === '⁻' ? '-' : c === '⁺' ? '' : String(SUPERSCRIPT.indexOf(c)))).join('');

/** `1.8×10⁹`, `1.8 x 10^9`, `1.8*10**9`, `10^9` → `1.8e9`, `1e9`. Runs before NFKC (superscripts are still superscripts). */
function scientific(text: string): string {
  // Full-width digits and operators → ASCII, leaving the superscripts alone.
  let s = '';
  let last = 0;
  for (const m of text.matchAll(SUP_RUN)) {
    s += text.slice(last, m.index).normalize('NFKC') + m[0];
    last = m.index + m[0].length;
  }
  s += text.slice(last).normalize('NFKC');
  const exp = '(?:(?:\\^|\\*\\*)\\s*([+\\-−]?\\d+)|([⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+))';
  const power = (ascii: string | undefined, sup: string | undefined) => (ascii !== undefined ? ascii.replace('−', '-').replace('+', '') : fromSuperscript(sup!));
  s = s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[×xX*·⋅]\\s*10\\s*${exp}`, 'g'), (_, m: string, a?: string, b?: string) => `${m}e${power(a, b)}`);
  s = s.replace(new RegExp(`(?<![\\d.])10\\s*${exp}`, 'g'), (_, a?: string, b?: string) => `1e${power(a, b)}`);
  return s;
}

const num = (digits: string, exp10: number): number => Number(`${digits}e${exp10}`);

/** Digits followed by 억 / 만 / 천 / 백 → the plain number (1억 5천만 → 150000000). Not 만들…, 천천히. */
function largeNumbers(s: string): string {
  let out = '';
  let i = 0;
  const digitsAt = (p: number) => /^\d+(?:\.\d+)?/.exec(s.slice(p))?.[0] ?? null;
  const unitAt = (p: number): string | null => {
    const c = s[p];
    if (c === undefined || LARGE_KO[c] === undefined) return null;
    const next = s[p + 1] ?? '';
    if ((c === '만' && /[들큼]/.test(next)) || (c === '천' && next === '천')) return null;
    return c;
  };
  const skip = (p: number) => { while (s[p] === ' ') p++; return p; };
  while (i < s.length) {
    const d = /\d/.test(s[i]) && !(i > 0 && /[\d.]/.test(s[i - 1])) ? digitsAt(i) : null;
    if (d === null || unitAt(skip(i + d.length)) === null) { out += s[i++]; continue; }
    // total = Σ sections × 10⁸ / 10⁴; a section = [n]천 [n]백 n
    let total = 0, section = 0, pending: string | null = d, p = i + d.length, end = p;
    for (;;) {
      const q = skip(p);
      const u = unitAt(q);
      if (u !== null) {
        const e = LARGE_KO[u];
        if (e <= 3) { section += pending !== null ? num(pending, e) : 10 ** e; }
        else { total += (section + (pending !== null ? Number(pending) : section === 0 ? 1 : 0)) * 10 ** e; section = 0; }
        pending = null;
        p = q + 1;
        end = p;
        continue;
      }
      const more: string | null = pending === null ? digitsAt(q) : null;
      if (more !== null && unitAt(skip(q + more.length)) !== null) { pending = more; p = q + more.length; continue; }
      break;
    }
    total += section + (pending !== null ? Number(pending) : 0);
    out += Number.isFinite(total) ? String(Math.round(total * 1e6) / 1e6) : s.slice(i, end);
    i = end;
  }
  return out;
}

/**
 * Normalise one line: quotes and `#ids` set aside, scientific notation, NFKC, lower case, punctuation variants,
 * thousands separators (1,800,000 · 1,800 kg — only groups of three; `40,60` and a unit-less `100,200` stay coordinate
 * pairs), Korean large numbers.
 */
export function normalizeText(raw: string): Normalized {
  const quotes: string[] = [];
  const ids: string[] = [];
  let s = extractQuotes(raw, quotes);
  s = s.replace(/#([A-Za-z_][\w.-]*)/g, (_, id: string) => {
    const clean = id.replace(/[.-]+$/, '');
    ids.push(clean);
    return `${ID_OPEN}${ids.length - 1}${ID_CLOSE}${id.slice(clean.length)}`;
  });
  s = scientific(s).normalize('NFKC').toLowerCase();
  s = s
    .replace(/[’`´]/g, "'")
    .replace(/(?:→|⟶|➔|=>)/g, ' -> ')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[〜~]/g, ' ')
    .replace(/[、，]/g, ',')
    .replace(/。/g, '.')
    .replace(/[·ㆍ・]/g, ' ')
    .replace(/[∕⁄]/g, '/')
    .replace(/\s*\/\s*/g, '/');
  // Thousands separators — not inside a parenthesised coordinate pair; and two groups with no unit after them
  // ("100,200에 나무") are a coordinate pair, not the number 100200 ("1,800 kg" and "1,800,000" are numbers).
  s = s.replace(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])/g, (m, at: number) => {
    const before = s.slice(0, at).trimEnd();
    if (/[(,]-?$/.test(before) && /^\s*\)/.test(s.slice(at + m.length))) return m;
    if (m.split(',').length === 2 && !readUnit(s, at + m.length)) return m;
    return m.replace(/,/g, '');
  });
  s = largeNumbers(s);
  s = s.replace(/\s+/g, ' ').trim();
  return { text: s, quotes, ids };
}

// ── Units ────────────────────────────────────────────────────────────────────────────────

export interface UnitMatch {
  unit: UnitId;
  /** Multiply the typed number by this to get the canonical unit. */
  factor: number;
  /** For counters: the palette category the counter belongs to (`any` for 개). */
  counter?: string;
  /** Characters consumed (leading spaces included). */
  len: number;
  /** The unit as typed. */
  said: string;
}

interface UnitEntry { surface: string; re: RegExp; unit: UnitId; factor: number; counter?: string; latin: boolean }

const UNIT_ENTRIES: UnitEntry[] = (() => {
  const out: UnitEntry[] = [];
  const add = (surface: string, unit: UnitId, factor: number, counter?: string) => {
    const latin = /^[a-z]/.test(surface);
    const body = surface.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+');
    // A Latin unit ends at a word boundary ("5 m", not "5 minutes" read as m) and may follow a hyphen (2-storey).
    out.push({ surface, re: new RegExp(`^(?:\\s*|\\s*-)${body}${/[a-z0-9]$/.test(surface) ? '(?![a-z0-9])' : ''}`), unit, factor, counter, latin });
  };
  for (const [surfaces, unit, factor] of UNITS) for (const s of surfaces) add(s, unit, factor);
  for (const [category, words] of Object.entries(COUNTERS)) for (const w of words ?? []) add(w, 'count', 1, category);
  return out.sort((a, b) => b.surface.length - a.surface.length || (a.surface < b.surface ? -1 : 1));
})();

/** First characters a unit can start with (after spaces / a hyphen) — a quick "no unit here". */
const UNIT_STARTS = new Set(UNIT_ENTRIES.map((e) => e.surface[0]));

/** The unit (or counter) at a position, after optional spaces. Null when there is none. */
export function readUnit(s: string, i: number): UnitMatch | null {
  let p = i;
  while (s[p] === ' ') p++;
  if (s[p] === '-') p++;
  if (!UNIT_STARTS.has(s[p])) return null;
  const rest = s.slice(i, i + 40);
  for (const e of UNIT_ENTRIES) {
    if (e.surface[0] !== s[p]) continue;
    const m = e.re.exec(rest);
    if (!m) continue;
    if (!e.latin && m[0].startsWith('-')) continue;
    return { unit: e.unit, factor: e.factor, len: m[0].length, said: e.surface, ...(e.counter ? { counter: e.counter } : {}) };
  }
  return null;
}

// ── Numbers ──────────────────────────────────────────────────────────────────────────────

export interface Quantity {
  /** Value in the canonical unit (typed number × factor). */
  value: number;
  /** The number as typed (before the unit's factor). */
  typed: number;
  unit: UnitId | null;
  counter?: string;
  /** Characters consumed from the start position. */
  len: number;
  /** How the number was written. */
  form: 'digits' | 'native' | 'sino' | 'word';
}

const isLatin = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);

const mul = (typed: number, factor: number): number => {
  const v = typed * factor;
  // 0.01 × 30 = 0.3 exactly; remove binary dust from decimal factors (1/3.6 keeps its digits).
  return Number.isInteger(1 / factor) || Number.isInteger(factor) ? Number(v.toPrecision(12)) : v;
};

function withUnit(typed: number, len: number, form: Quantity['form'], unit: UnitMatch | null): Quantity {
  if (!unit) return { value: typed, typed, unit: null, len, form };
  return { value: mul(typed, unit.factor), typed, unit: unit.unit, len: len + unit.len, form, ...(unit.counter ? { counter: unit.counter } : {}) };
}

/** Digits (optional sign, decimals, exponent) at `i`: with the unit after them, and without (both readings). */
export function readDigits(s: string, i: number): Quantity[] {
  if (isLatin(s[i - 1]) || s[i - 1] === '.') return [];
  const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/.exec(s.slice(i, i + 40));
  if (!m || !/\d/.test(m[0])) return [];
  let text = m[0];
  // A sign only at the start of a word: "n2-3" is not −3, "5-10" neither.
  if (/^[-+]/.test(text) && i > 0 && !/[\s(,=:]/.test(s[i - 1])) return [];
  if (text.endsWith('.')) text = text.slice(0, -1);
  const typed = Number(text);
  if (!Number.isFinite(typed)) return [];
  const out: Quantity[] = [];
  const ord = /^(?:st|nd|rd|th)(?![a-z0-9])/.exec(s.slice(i + text.length, i + text.length + 3));
  if (ord) out.push({ value: typed, typed, unit: 'ord', len: text.length + ord[0].length, form: 'digits' });
  const unit = readUnit(s, i + text.length);
  if (unit) out.push(withUnit(typed, text.length, 'digits', unit));
  // Bare: not when a letter is glued to the digits ("40ft" is a word, "3d" too).
  if (!isLatin(s[i + text.length])) out.push({ value: typed, typed, unit: null, len: text.length, form: 'digits' });
  return out;
}

const NATIVE_TENS_KEYS = Object.keys(NATIVE_TENS).sort((a, b) => b.length - a.length);
/** The syllables a Korean numeral can start with. */
const NUMERAL_STARTS = new Set([...Object.keys(NATIVE_TENS), ...Object.keys(NATIVE_ONES), ...Object.keys(NATIVE_ALONE), ...Object.keys(SINO_DIGITS), ...Object.keys(SINO_PLACES)].map((w) => w[0]));
const NATIVE_ONES_KEYS = Object.keys(NATIVE_ONES).sort((a, b) => b.length - a.length);
const startsAt = (s: string, i: number, keys: string[]): string | null => keys.find((k) => s.startsWith(k, i)) ?? null;

/** A Korean numeral at `i` — native with a counter (세 채, 스물한 그루), Sino-Korean with a unit (이층, 삼십 도), or 하나 / 둘 / 셋 / 넷 alone. */
export function readKoreanNumeral(s: string, i: number): Quantity | null {
  if (!NUMERAL_STARTS.has(s[i])) return null;
  // Native: [tens][ones] + counter / unit
  let p = i, value = 0, syllables = 0;
  const tens = startsAt(s, p, NATIVE_TENS_KEYS);
  if (tens) { value += NATIVE_TENS[tens]; p += tens.length; syllables += tens.length; }
  const ones = tens === '스무' ? null : startsAt(s, p, NATIVE_ONES_KEYS);
  if (ones) { value += NATIVE_ONES[ones]; p += ones.length; syllables += ones.length; }
  if (value > 0) {
    const unit = readUnit(s, p);
    if (unit && (unit.unit === 'count' || unit.unit === 'ord' || unit.unit === 'x' || unit.unit === 'floors' || (unit.unit === 's' && unit.said === '시간'))) {
      return withUnit(value, p - i, 'native', unit);
    }
  }
  // Sino-Korean: [d]천 [d]백 [d]십 [d] + unit
  p = i; value = 0; syllables = 0;
  let lastPlace = Infinity;
  for (;;) {
    const d = SINO_DIGITS[s[p]];
    const placeAfterDigit = d !== undefined ? SINO_PLACES[s[p + 1]] : undefined;
    const place = SINO_PLACES[s[p]];
    if (d !== undefined && placeAfterDigit !== undefined && placeAfterDigit < lastPlace) { value += d * placeAfterDigit; lastPlace = placeAfterDigit; p += 2; syllables += 2; continue; }
    if (place !== undefined && place < lastPlace) { value += place; lastPlace = place; p += 1; syllables += 1; continue; }
    if (d !== undefined && lastPlace > 1) { value += d; lastPlace = 1; p += 1; syllables += 1; }
    break;
  }
  if (value > 0) {
    const unit = readUnit(s, p);
    if (unit && (SINO_UNITS.includes(unit.unit) || syllables >= 2)) return withUnit(value, p - i, 'sino', unit);
  }
  // Stand-alone native numerals (나무 하나): followed by a space, a particle or the end.
  for (const [w, v] of Object.entries(NATIVE_ALONE)) {
    if (s.startsWith(w, i) && /^(?:$|[\s,.!?]|[를을만씩이가])/.test(s.slice(i + w.length, i + w.length + 1))) return { value: v, typed: v, unit: null, len: w.length, form: 'native' };
  }
  return null;
}

const EN_WORDS = Object.keys(NUMBERS_EN);
const wordAt = (s: string, i: number, words: string[]): string | null => {
  if (isLatin(s[i - 1])) return null;
  let best: string | null = null;
  for (const w of words) if (s.startsWith(w, i) && !isLatin(s[i + w.length]) && (!best || w.length > best.length)) best = w;
  return best;
};

/** An English number at `i`: one … ninety-nine, a hundred, `a couple of`, `a dozen`, `half a`, `a` / `an` before a unit, first … tenth. */
export function readEnglishNumber(s: string, i: number): Quantity[] {
  if (isLatin(s[i - 1])) return [];
  const out: Quantity[] = [];
  const phrase = wordAt(s, i, Object.keys(NUMBER_PHRASES_EN));
  if (phrase) {
    const unit = readUnit(s, i + phrase.length);
    const v = NUMBER_PHRASES_EN[phrase];
    if (unit) out.push(withUnit(v, phrase.length, 'word', unit));
    else if (Number.isInteger(v)) out.push({ value: v, typed: v, unit: null, len: phrase.length, form: 'word' });
    return out;
  }
  // ("first" is a word of the grammar — the first three — not a number.)
  const ordinal = wordAt(s, i, Object.keys(ORDINALS_EN).filter((w) => w !== 'first'));
  if (ordinal) return [{ value: ORDINALS_EN[ordinal], typed: ORDINALS_EN[ordinal], unit: 'ord', len: ordinal.length, form: 'word' }];
  const article = wordAt(s, i, ['a', 'an']);
  if (article) {
    // "a metre", "an hour" = 1 — only before a unit of two letters or more ("a m…" is not one metre).
    const unit = readUnit(s, i + article.length);
    return unit && unit.said.length >= 2 && unit.unit !== 'count' ? [withUnit(1, article.length, 'word', unit)] : [];
  }
  const first = wordAt(s, i, EN_WORDS);
  if (!first) return [];
  let value = NUMBERS_EN[first];
  let len = first.length;
  if (value >= 20 && value % 10 === 0) {
    const m = /^[\s-]/.test(s[i + len] ?? '') ? wordAt(s, i + len + 1, EN_WORDS) : null;
    if (m && NUMBERS_EN[m] >= 1 && NUMBERS_EN[m] <= 9) { value += NUMBERS_EN[m]; len += 1 + m.length; }
  }
  if (/^\s+hundred(?![a-z0-9])/.test(s.slice(i + len)) && value >= 1 && value <= 9) { len += /^\s+hundred/.exec(s.slice(i + len))![0].length; value *= 100; }
  const unit = readUnit(s, i + len);
  if (unit) out.push(withUnit(value, len, 'word', unit));
  out.push({ value, typed: value, unit: null, len, form: 'word' });
  return out;
}

/** Every reading of a number at `i` (longest first). Empty when no number starts there. */
export function readQuantity(s: string, i: number): Quantity[] {
  const c = s[i];
  if (c === undefined) return [];
  const out: Quantity[] = [];
  if (/[\d.+-]/.test(c)) out.push(...readDigits(s, i));
  else if (/[가-힣]/.test(c)) { const k = readKoreanNumeral(s, i); if (k) out.push(k); }
  else if (/[a-z]/.test(c)) out.push(...readEnglishNumber(s, i));
  return out.sort((a, b) => b.len - a.len);
}

/** Every number of a normalised text with its unit, left to right (the longest reading at each position) — for tests and help. */
export function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  for (let i = 0; i < text.length; ) {
    const q = readQuantity(text, i)[0];
    if (q) { out.push(q); i += q.len; } else i++;
  }
  return out;
}
