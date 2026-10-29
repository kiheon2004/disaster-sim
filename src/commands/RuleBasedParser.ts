/**
 * Rule-based natural-language parser (Korean + English).
 *
 *   "동쪽에서 서쪽 방향으로 풍속 45m/s의 태풍 발생"  → wind 45 m/s from E
 *   "풍속을 50m/s까지 20초 동안 증가시켜"            → ramp to 50 m/s over 20 s
 *   "Wind 45m/s from East for 90 seconds"           → wind 45 m/s from E, 90 s
 *   "폭우를 시간당 100mm로 발생시켜"                  → recognized, not yet simulated
 *
 * Deliberately dependency-free and synchronous at its core so it is easy to unit test.
 */
import type { CompassDir } from '@/core/compass';
import { SIM_SPEEDS, type SimSpeed } from '@/core/units';
import type { I18nMessage } from '@/i18n/i18n';
import type { WindEventSpec } from '@/events/specs';
import type { CommandParser, ParseDefaults, ParseResult, ParsedCommand } from './CommandParser';
import { simulationCommandSchema } from './schema';
import { phenomena } from '@/phenomena/registry';
import { isEarthquakeClause, parseEarthquake } from './earthquakeParser';
import { floodKind, parseFlood } from './floodParser';

// ── Normalization ─────────────────────────────────────────────────────────

export function normalize(input: string): string {
  let s = input.normalize('NFKC').replace(/[∕⁄]/g, '/').toLowerCase();
  s = s.replace(/\s*\/\s*/g, '/');
  // Acceleration units ("m/s²" is "m/s2" after NFKC) → one letter-only token.
  s = s.replace(/(?:m\/s\^?2|m\/sec\^?2|meters?\s+per\s+second\s+squared|미터\/초\^?2)/g, 'mpss');
  // Flood units (Phase 14). Volume units contain a digit ("m3"), so they become letter-only
  // tokens: cms = m³/s, cmm = m³/min, cmh = m³/h, cbm = m³ (rate from context: "초당 5cbm").
  s = s.replace(/(?:m3|세제곱\s*미터|입방\s*미터|cubic\s+met(?:er|re)s?)\s*(?:\/\s*s(?:ec)?\b|\/\s*초|per\s+second|a\s+second)/g, 'cms');
  s = s.replace(/(?:m3|세제곱\s*미터|입방\s*미터|cubic\s+met(?:er|re)s?)\s*(?:\/\s*min\b|\/\s*분|per\s+minute)/g, 'cmm');
  s = s.replace(/(?:m3|세제곱\s*미터|입방\s*미터|cubic\s+met(?:er|re)s?)\s*(?:\/\s*h(?:r|our)?\b|\/\s*시간?|per\s+hour|an\s+hour)/g, 'cmh');
  s = s.replace(/(?:m3|세제곱\s*미터|입방\s*미터|cubic\s+met(?:er|re)s?)/g, 'cbm');
  s = s.replace(/(?:liters?|litres?|리터)\s*(?:\/\s*s(?:ec)?\b|\/\s*초|per\s+second)/g, 'lps');
  s = s.replace(/(?:mm|밀리미터|밀리)\s*(?:\/\s*h(?:r|our)?\b|\/\s*시간|per\s+hour|an\s+hour|an\s+hr)/g, 'mm/h');
  s = s.replace(/(?:millimet(?:er|re)s?)\s*(?:per\s+hour|an\s+hour|\/\s*h)/g, 'mm/h');
  s = s.replace(/millimet(?:er|re)s?|밀리미터|밀리(?=[\s의로]|$)/g, 'mm');
  s = s.replace(/(?:m|met(?:er|re)s?|미터)\s*(?:\/\s*min\b|per\s+minute|a\s+minute)/g, 'm/min');
  s = s.replace(/미터\s*퍼\s*세컨드|미터\/초|미터\s*매\s*초|meters?\s+per\s+second|metres?\s+per\s+second|m\/sec|\bmps\b/g, 'm/s');
  s = s.replace(/킬로미터\/시|kilometers?\s+per\s+hour|\bkmh\b|\bkph\b/g, 'km/h');
  s = s.replace(/miles?\s+per\s+hour/g, 'mph');
  s = s.replace(/초속\s*(\d+(?:\.\d+)?)\s*(?:m\/s|미터|m)?/g, '$1m/s');
  s = s.replace(/시속\s*(\d+(?:\.\d+)?)\s*(?:km\/h|킬로미터|킬로|km)?/g, '$1km/h');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Split into clauses on strong sequence separators. */
export function splitClauses(s: string): string[] {
  return s
    // Phase 15: also after a Korean connective verb ending ("태풍을 발생시키고 10초 후 지진…").
    .split(/\n|;|\.\s+|,?\s*(?:그리고 나서|그런 다음|그 다음에?|그다음에?|그 후에|그리고|and then|after that|afterwards|then)\s+|(?<=(?:시키|일으키|내리|올리|만들))고\s+/)
    .map((c) => c.trim().replace(/[.,]+$/, ''))
    .filter(Boolean);
}

// ── Number + unit tokens ──────────────────────────────────────────────────

type UnitKind =
  | 'speed' | 'time' | 'percent' | 'degree' | 'mm' | 'cm' | 'meter' | 'multiplier' | 'accel' | 'km' | 'freq' | 'bare'
  // Flood (Phase 14): rain intensity (mm/h), volume flow (m³/s), volume (m³), rise rate (m/min)
  | 'rainRate' | 'flow' | 'volume' | 'riseRate';

export interface NumToken {
  value: number;
  kind: UnitKind;
  /** m/s for speed, seconds for time, g for acceleration, km for distance, Hz for frequency,
   *  mm/h for rain, m³/s for flow, m³ for volume, m/min for rise rate */
  si: number;
  index: number;
  end: number;
  /** Text right after the token (for 후/뒤/까지 …). */
  after: string;
  before: string;
}

const UNIT_TABLE: [string, UnitKind, number][] = [
  // Flood (Phase 14) — before their prefixes (mm, m, cm).
  ['mm/h', 'rainRate', 1],
  ['cms', 'flow', 1],
  ['cmm', 'flow', 1 / 60],
  ['cmh', 'flow', 1 / 3600],
  ['cbm', 'volume', 1],
  ['lps', 'flow', 0.001],
  ['m/min', 'riseRate', 1],
  ['톤', 'volume', 1],
  ['meters', 'meter', 1],
  ['meter', 'meter', 1],
  ['metres', 'meter', 1],
  ['metre', 'meter', 1],
  // Acceleration (earthquake intensity) → g. "m/s²" is normalized to "mpss".
  ['mpss', 'accel', 1 / 9.81],
  ['gal', 'accel', 0.01 / 9.81],
  ['갈', 'accel', 0.01 / 9.81],
  ['m/s', 'speed', 1],
  ['km/h', 'speed', 1 / 3.6],
  ['km', 'km', 1],
  ['킬로미터', 'km', 1],
  ['킬로', 'km', 1],
  ['hz', 'freq', 1],
  ['헤르츠', 'freq', 1],
  ['mph', 'speed', 0.44704],
  ['knots', 'speed', 0.514444],
  ['knot', 'speed', 0.514444],
  ['kts', 'speed', 0.514444],
  ['kt', 'speed', 0.514444],
  ['노트', 'speed', 0.514444],
  ['미터', 'speed', 1],
  ['mm', 'mm', 1],
  ['cm', 'cm', 1],
  ['%', 'percent', 1],
  ['퍼센트', 'percent', 1],
  ['percent', 'percent', 1],
  ['°', 'degree', 1],
  ['도', 'degree', 1],
  ['degrees', 'degree', 1],
  ['degree', 'degree', 1],
  ['deg', 'degree', 1],
  ['배속', 'multiplier', 1],
  ['배', 'multiplier', 1],
  ['×', 'multiplier', 1],
  ['x', 'multiplier', 1],
  ['seconds', 'time', 1],
  ['second', 'time', 1],
  ['secs', 'time', 1],
  ['sec', 'time', 1],
  ['초', 'time', 1],
  ['s', 'time', 1],
  ['minutes', 'time', 60],
  ['minute', 'time', 60],
  ['mins', 'time', 60],
  ['min', 'time', 60],
  ['분', 'time', 60],
  ['hours', 'time', 3600],
  ['hour', 'time', 3600],
  ['hrs', 'time', 3600],
  ['hr', 'time', 3600],
  ['시간', 'time', 3600],
  ['h', 'time', 3600],
  ['g', 'accel', 1],
  ['m', 'meter', 1],
];

const HANGUL = /[가-힣]/;

export function tokenizeNumbers(s: string): NumToken[] {
  const out: NumToken[] = [];
  const re = /(\d+(?:\.\d+)?)\s*([a-z가-힣/%°×]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const value = parseFloat(m[1]);
    const word = m[2];
    let kind: UnitKind = 'bare';
    let factor = 1;
    let unitLen = 0;
    for (const [u, k, f] of UNIT_TABLE) {
      if (!word.startsWith(u)) continue;
      const rest = word.slice(u.length);
      // Latin units must end at a word boundary (or be followed by a Korean particle): "45 south" ≠ seconds.
      if (/^[a-z]/.test(u) && rest && !HANGUL.test(rest[0])) continue;
      kind = k;
      factor = f;
      unitLen = u.length;
      break;
    }
    const end = m.index + m[0].length - (word.length - unitLen);
    out.push({
      value,
      kind,
      si: value * factor,
      index: m.index,
      end,
      after: s.slice(end, end + 14),
      before: s.slice(Math.max(0, m.index - 16), m.index),
    });
  }
  return out;
}

// ── Keyword sets ──────────────────────────────────────────────────────────

const WIND_WORDS = /바람|풍속|태풍|강풍|돌풍|폭풍|미풍|허리케인|사이클론|wind|typhoon|hurricane|cyclone|gale|storm|gust|breeze/;
/** Non-wind executable requests (earthquake, rain, flood / water level) — they take precedence over the climate hint. */
const EXECUTABLE_WORDS = /지진|규모|진도|earthquake|quake|magnitude|폭우|강우|호우|시간당|mm\/h|rain|홍수|침수|수위|flood|water\s*level/;
const RAMP_UP = /증가|강해|강하게|올려|올리|높여|높이|세져|세지|세게|키워|increase|ramp|rise|raise|strengthen|build|intensif|grow/;
const RAMP_DOWN = /감소|약해|약하게|낮춰|낮추|줄여|줄이|잦아|decrease|reduce|weaken|drop|lower|die down|ease/;
const STOP_WIND = /멈춰|멈추|그쳐|그치|중지|없애|꺼|끄|stop|cease|calm down|end the/;
const RESET = /초기화|리셋|되돌려|되돌리|원래대로|처음으로|reset|restore|rewind/;
const PAUSE = /일시\s*정지|일시정지|멈춰|멈추|정지|중지|pause|halt|freeze|stop/;
const PLAY = /재생|시작|계속|재개|실행|play|start|resume|continue|run|go\b/;
const SIM_SPEED_CTX = /속도|배속|speed|x\b|×|slow|fast|빠르게|느리게|슬로우/;

// Phase 15: hazards that are recognized but not simulated come from the PhenomenonRegistry
// (planned phenomena: tornado, sinkhole, meteor, black hole …) — they are never executed.

/**
 * Relative start ("10초 후 지진 … 태풍이 시작되고", "10 seconds after the typhoon begins"):
 * returns the clause without the relation and the reference (phenomenon type, anchor, offset s).
 */
export function extractAfter(clause: string): { rest: string; after?: { type: string; anchor: 'start' | 'end'; offset: number } } {
  const typeOf = (word: string) => phenomena.listImplemented().find((d) => d.keywords.test(word))?.type;
  const unit = (u: string) => (/^(?:분|min)/.test(u) ? 60 : 1);
  let m = clause.match(/(\S+?)(?:이|가|을|를|의)?\s*(시작|발생|끝|종료)[가-힣]*\s*(\d+(?:\.\d+)?)\s*(초|분)\s*(?:후|뒤)에?/);
  if (m) {
    const type = typeOf(m[1]);
    if (type) return { rest: clause.replace(m[0], ' ').trim(), after: { type, anchor: /끝|종료/.test(m[2]) ? 'end' : 'start', offset: parseFloat(m[3]) * unit(m[4]) } };
  }
  m = clause.match(/(?:(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?)\s+)?after\s+(?:the\s+)?([a-z][a-z\s]*?)\s+(begins|starts|started|start|ends|ended|stops|stopped|finishes|is over)\b/);
  if (m) {
    const type = typeOf(m[3]);
    if (type) {
      const offset = m[1] ? parseFloat(m[1]) * unit(m[2]) : 0;
      return { rest: clause.replace(m[0], ' ').trim(), after: { type, anchor: /end|stop|finish|over/.test(m[4]) ? 'end' : 'start', offset } };
    }
  }
  return { rest: clause };
}

const CATEGORY_SPEED: [RegExp, number, number][] = [
  // [pattern, speed m/s, default gust]
  [/초강력\s*태풍|super\s*typhoon|super-typhoon|category\s*5/, 60, 0.4],
  [/매우\s*강한\s*태풍|very\s*strong\s*typhoon|major\s*hurricane/, 48, 0.38],
  [/태풍|typhoon|hurricane|cyclone/, 40, 0.35],
  [/폭풍|storm/, 28, 0.3],
  [/강풍|gale/, 20, 0.28],
  [/강한\s*바람|strong\s*wind/, 14, 0.25],
  [/돌풍|gusty/, 18, 0.5],
  [/미풍|약한\s*바람|산들|breeze|light\s*wind/, 6, 0.15],
];

// ── Direction ─────────────────────────────────────────────────────────────

export const KO_DIR: Record<string, CompassDir> = {
  북동: 'NE', 동북: 'NE', 북서: 'NW', 서북: 'NW', 남동: 'SE', 동남: 'SE', 남서: 'SW', 서남: 'SW',
  북: 'N', 남: 'S', 동: 'E', 서: 'W',
};
const EN_DIR: Record<string, CompassDir> = {
  northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW',
  north: 'N', south: 'S', east: 'E', west: 'W',
  ne: 'NE', nw: 'NW', se: 'SE', sw: 'SW', n: 'N', s: 'S', e: 'E', w: 'W',
};
const OPPOSITE: Record<CompassDir, CompassDir> = { N: 'S', NE: 'SW', E: 'W', SE: 'NW', S: 'N', SW: 'NE', W: 'E', NW: 'SE' };

export const KO_DIR_WORD = '(북동|북서|남동|남서|동북|동남|서북|서남|북|남|동|서)';
export const EN_DIR_WORD = '(north[\\s-]?east|north[\\s-]?west|south[\\s-]?east|south[\\s-]?west|north|south|east|west)';

export function enDir(w: string): CompassDir | undefined {
  return EN_DIR[w.replace(/[\s-]/g, '')];
}

export interface DirectionResult {
  dir: CompassDir | number;
  /** How it was derived (for notes). */
  via: 'from' | 'toward' | 'degrees';
}

export function extractDirection(clause: string, original: string, tokens: NumToken[]): DirectionResult | null {
  // "A에서 B로", "A → B", "east to west", "east_to_west"
  let m = clause.match(new RegExp(`${KO_DIR_WORD}\\s*(?:쪽)?\\s*(?:→|->|에서)\\s*${KO_DIR_WORD}`));
  if (m) return { dir: KO_DIR[m[1]], via: 'from' };
  m = clause.match(new RegExp(`${EN_DIR_WORD}\\s*(?:→|->|_to_|\\s+to\\s+)\\s*${EN_DIR_WORD}`));
  if (m && enDir(m[1])) return { dir: enDir(m[1])!, via: 'from' };

  // Korean with an explicit suffix (avoids 동안/동시 …)
  const ko = new RegExp(`${KO_DIR_WORD}(쪽에서|에서|방향에서|으로부터|풍|쪽으로|으로|방향으로|쪽\\s*방향|쪽|방향|로)`, 'g');
  let from: CompassDir | null = null;
  let toward: CompassDir | null = null;
  for (const k of clause.matchAll(ko)) {
    const d = KO_DIR[k[1]];
    const suf = k[2];
    if (/에서|풍|부터/.test(suf) || suf === '쪽' || suf === '방향') from ??= d;
    else toward ??= d;
  }
  if (from) return { dir: from, via: 'from' };
  if (toward) return { dir: OPPOSITE[toward], via: 'toward' };

  // English
  m = clause.match(new RegExp(`from\\s+(?:the\\s+)?${EN_DIR_WORD}`));
  if (m && enDir(m[1])) return { dir: enDir(m[1])!, via: 'from' };
  m = clause.match(new RegExp(`from\\s+(?:the\\s+)?(ne|nw|se|sw|n|s|e|w)\\b`));
  if (m && enDir(m[1])) return { dir: enDir(m[1])!, via: 'from' };
  m = clause.match(new RegExp(`\\b${EN_DIR_WORD}(?:erly|ern)\\b`));
  if (m && enDir(m[1])) return { dir: enDir(m[1])!, via: 'from' };
  m = clause.match(new RegExp(`\\b${EN_DIR_WORD}\\s+(?:wind|winds|gale|storm|typhoon|breeze|gusts?)\\b`));
  if (m && enDir(m[1])) return { dir: enDir(m[1])!, via: 'from' };
  m = clause.match(new RegExp(`(?:toward|towards|to\\s+the|blowing|heading)\\s+(?:the\\s+)?${EN_DIR_WORD}`));
  if (m && enDir(m[1])) return { dir: OPPOSITE[enDir(m[1])!], via: 'toward' };

  // Upper-case compass abbreviations in the original text: "Wind 45m/s NE"
  const abbr = original.match(/(?:^|[\s(])(NE|NW|SE|SW|N|E|S|W)(?=$|[\s,.)])/);
  if (abbr) return { dir: abbr[1] as CompassDir, via: 'from' };

  // Bearing in degrees
  const deg = tokens.find((t) => t.kind === 'degree' && t.value >= 0 && t.value <= 360);
  if (deg) return { dir: deg.value % 360, via: 'degrees' };
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function nearestSimSpeed(v: number): SimSpeed {
  return SIM_SPEEDS.reduce((best, s) => (Math.abs(Math.log(s / v)) < Math.abs(Math.log(best / v)) ? s : best), 1 as SimSpeed);
}

export function isDelay(t: NumToken): boolean {
  return /^\s*(?:후|뒤|이후|있다가|지나서|later|from now)/.test(t.after) || /(?:after|in)\s+$/.test(t.before);
}

function parseSimSpeed(clause: string, tokens: NumToken[]): number | null {
  const mult = tokens.find((t) => t.kind === 'multiplier');
  if (mult) return mult.value;
  if (/두\s*배/.test(clause)) return 2;
  if (/네\s*배/.test(clause)) return 4;
  if (/절반|반\s*속|half|slow\s*motion|슬로우/.test(clause)) return 0.5;
  if (/4분의\s*1|quarter/.test(clause)) return 0.25;
  if (/정상\s*속도|normal\s*speed|원래\s*속도|real\s*time|실시간/.test(clause)) return 1;
  if (/(?:speed|속도)/.test(clause)) {
    const bare = tokens.find((t) => t.kind === 'bare');
    if (bare) return bare.value;
  }
  return null;
}

function gustFrom(clause: string, tokens: NumToken[], speed: number): number | undefined {
  if (/돌풍\s*(?:없|제외)|without\s+gusts?|no\s+gusts?|steady|일정한|균일/.test(clause)) return 0;
  const near = (t: NumToken) => /돌풍|gust/.test(t.before) || /^\s*(?:의\s*)?돌풍|^\s*gusts?/.test(t.after);
  const pct = tokens.find((t) => t.kind === 'percent' && near(t));
  if (pct) return Math.min(1, pct.value / 100);
  const frac = tokens.find((t) => t.kind === 'bare' && t.value <= 1 && near(t));
  if (frac) return frac.value;
  const gustSpeed = tokens.find((t) => t.kind === 'speed' && near(t));
  if (gustSpeed && speed > 0) return Math.max(0, Math.min(1, (gustSpeed.si / speed - 1) / 1.15));
  if (/강한\s*돌풍|strong\s+gusts?|very\s+gusty|돌풍이?\s*심/.test(clause)) return 0.55;
  if (/약한\s*돌풍|light\s+gusts?|slight\s+gusts?/.test(clause)) return 0.12;
  return undefined;
}

// ── Core ──────────────────────────────────────────────────────────────────

const CHAIN_OVERLAP = 4; // s — start a follow-up wind event before the previous one fades out

export function parseCommands(input: string, defaults: ParseDefaults): ParseResult {
  const result: ParseResult = { ok: false, commands: [], unsupported: [], errors: [], warnings: [] };
  const text = normalize(input);
  if (!text) {
    result.errors.push({ key: 'parse.empty' });
    return result;
  }
  const originals = input.split(/\n|;/).join(' ');
  const clauses = splitClauses(text);
  let lastWind: { spec: WindEventSpec; delay: number } | null = null;

  for (const raw of clauses) {
    // Phase 27: a fire is recognized but placed in the experiment editor (the ignition point must be on
    // fuel the user picks on the map) — text never starts a fire.
    if (phenomena.implemented('fire')!.keywords.test(raw) && !WIND_WORDS.test(raw)) {
      result.unsupported.push({ event: 'fire', params: {} });
      result.warnings.push({ key: 'parse.fire.editor' });
      continue;
    }
    // Phase 28: an eruption is recognized but placed in the experiment editor (vents are placed on the
    // terrain the user picks) — text never starts an eruption.
    if (phenomena.implemented('volcano')!.keywords.test(raw)) {
      result.unsupported.push({ event: 'volcano', params: {} });
      result.warnings.push({ key: 'parse.volcano.editor' });
      continue;
    }
    // Phase 30: a climate experiment (heatwave, cold wave, snow, icing …) is recognized but set up in the experiment
    // editor (temperature path, humidity, precipitation, sun) — text never starts one.
    // Only a clause without an executable request: the climate words also occur in ordinary phrases (모서리, 태풍의 눈,
    // humid wind) — a wind, earthquake or water command in the clause is parsed as before Phase 30.
    if (phenomena.implemented('climate')!.keywords.test(raw) && !WIND_WORDS.test(raw) && !EXECUTABLE_WORDS.test(raw)) {
      result.unsupported.push({ event: 'climate', params: {} });
      result.warnings.push({ key: 'parse.climate.editor' });
      continue;
    }
    // Phase 29: an atmosphere experiment is recognized but set up in the experiment editor (reference state,
    // removal schedule, boundary) — text never removes air.
    if (phenomena.implemented('atmosphere')!.keywords.test(raw)) {
      result.unsupported.push({ event: 'atmosphere', params: {} });
      result.warnings.push({ key: 'parse.atmosphere.editor' });
      continue;
    }
    // Phase 15: a phenomenon that is not implemented is reported, never executed.
    const planned = phenomena.matchPlanned(raw);
    if (planned) {
      result.unsupported.push({ event: planned.type, params: {} });
      result.warnings.push({ key: 'parse.unsupported.planned' });
      continue;
    }
    // Phase 32: a black hole / celestial source is recognized but set up in the experiment editor (mass, softening,
    // capture radius, probes) — text never creates one. Before the gravity check: "a black hole's gravity" is celestial.
    if (phenomena.implemented('celestial')!.keywords.test(raw)) {
      result.unsupported.push({ event: 'celestial', params: {} });
      result.warnings.push({ key: 'parse.celestial.editor' });
      continue;
    }
    // Phase 31: a gravity experiment is recognized but set up in the experiment editor (magnitude, direction, profile,
    // local sources) — text never changes gravity.
    if (phenomena.implemented('gravity')!.keywords.test(raw)) {
      result.unsupported.push({ event: 'gravity', params: {} });
      result.warnings.push({ key: 'parse.gravity.editor' });
      continue;
    }
    const rel = extractAfter(raw);
    const clause = rel.rest;
    const firstCommand = result.commands.length;
    const tokens = tokenizeNumbers(clause);
    const notes: I18nMessage[] = [];
    const attach = () => {
      if (rel.after) for (const c of result.commands.slice(firstCommand)) if (c.command.kind === 'event') c.after = rel.after;
    };
    const windish = WIND_WORDS.test(clause) || tokens.some((t) => t.kind === 'speed');

    // 1) Earthquake (Phase 13)
    if (!windish && isEarthquakeClause(clause, tokens)) {
      const parsed = parseEarthquake(clause, originals, tokens, notes, result);
      if (parsed) {
        const check = simulationCommandSchema.safeParse({ kind: 'event', spec: parsed.spec });
        if (!check.success) result.errors.push({ key: 'parse.invalid', params: { detail: check.error.issues[0]?.message ?? '' } });
        else result.commands.push({ command: check.data, source: clause, notes, delay: parsed.delay } satisfies ParsedCommand);
      }
      attach();
      continue;
    }

    // 2) Water: rain, rising water at an edge, local source (Phase 14). A clause with both a
    //    typhoon and rain ("태풍과 함께 시간당 80mm 비") yields a rain AND a wind command.
    const water = floodKind(clause, tokens);
    if (water) {
      const parsed = parseFlood(water, clause, tokens, notes, result);
      if (parsed) {
        const check = simulationCommandSchema.safeParse({ kind: 'event', spec: parsed.spec });
        if (!check.success) result.errors.push({ key: 'parse.invalid', params: { detail: check.error.issues[0]?.message ?? '' } });
        else result.commands.push({ command: check.data, source: clause, notes, delay: parsed.delay } satisfies ParsedCommand);
      }
      if (!(water === 'rain' && WIND_WORDS.test(clause) && /태풍|폭풍|강풍|바람|typhoon|hurricane|storm|wind|gale/.test(clause))) {
        attach();
        continue;
      }
      const windNotes: I18nMessage[] = [];
      const w = parseWind(clause, originals, tokens.filter((t) => t.kind !== 'rainRate' && t.kind !== 'mm'), defaults, lastWind, windNotes, result);
      if (w) {
        const check = simulationCommandSchema.safeParse({ kind: 'event', spec: w.spec });
        if (check.success) {
          result.commands.push({ command: check.data, source: clause, notes: windNotes, delay: w.delay } satisfies ParsedCommand);
          lastWind = w;
        }
      }
      attach();
      continue;
    }

    // 3) Ground phenomena (Phase 21–23) and air-pressure waves (Phase 24): the phenomenon with its default parameters — position,
    //    material and triggers are set in the experiment tab (the note says so).
    const ground = (['impact', 'blast', 'sinkhole', 'landslide', 'terrainDeformation'] as const).map((t) => phenomena.implemented(t)!).find((d) => d.keywords.test(clause));
    if (ground && !windish) {
      const check = simulationCommandSchema.safeParse({ kind: 'event', spec: ground.defaults() });
      if (!check.success) result.errors.push({ key: 'parse.invalid', params: { detail: check.error.issues[0]?.message ?? '' } });
      else result.commands.push({ command: check.data, source: clause, notes: [...notes, { key: 'parse.note.groundDefaults' }], delay: tokens.find((t) => t.kind === 'time' && isDelay(t))?.si ?? 0 } satisfies ParsedCommand);
      attach();
      continue;
    }

    // 4) Wind
    const ramping = RAMP_UP.test(clause) || RAMP_DOWN.test(clause);
    if (windish || (ramping && lastWind)) {
      const parsed = parseWind(clause, originals, tokens, defaults, lastWind, notes, result);
      if (parsed) {
        const { spec, delay } = parsed;
        const check = simulationCommandSchema.safeParse({ kind: 'event', spec });
        if (!check.success) {
          result.errors.push({ key: 'parse.invalid', params: { detail: check.error.issues[0]?.message ?? '' } });
        } else {
          result.commands.push({ command: check.data, source: clause, notes, delay } satisfies ParsedCommand);
          lastWind = { spec, delay };
        }
      }
      attach();
      continue;
    }

    // 5) Simulation controls
    if (RESET.test(clause)) {
      result.commands.push({ command: { kind: 'control', action: 'reset' }, source: clause, notes });
      continue;
    }
    if (SIM_SPEED_CTX.test(clause) || tokens.some((t) => t.kind === 'multiplier')) {
      const v = parseSimSpeed(clause, tokens);
      if (v !== null) {
        const s = nearestSimSpeed(v);
        if (s !== v) notes.push({ key: 'parse.note.speedRounded', params: { from: v, to: s } });
        result.commands.push({ command: { kind: 'speed', value: s }, source: clause, notes });
        continue;
      }
    }
    if (PAUSE.test(clause)) {
      result.commands.push({ command: { kind: 'control', action: 'pause' }, source: clause, notes });
      continue;
    }
    if (PLAY.test(clause)) {
      result.commands.push({ command: { kind: 'control', action: 'play' }, source: clause, notes });
      continue;
    }

    result.errors.push({ key: 'parse.noIntent', params: { clause } });
  }

  result.ok = result.errors.length === 0 && (result.commands.length > 0 || result.unsupported.length > 0);
  return result;
}

function parseWind(
  clause: string,
  original: string,
  tokens: NumToken[],
  defaults: ParseDefaults,
  lastWind: { spec: WindEventSpec; delay: number } | null,
  notes: I18nMessage[],
  result: ParseResult,
): { spec: WindEventSpec; delay: number } | null {
  const up = RAMP_UP.test(clause);
  const down = RAMP_DOWN.test(clause);

  // Stop the wind → ramp to calm.
  if (STOP_WIND.test(clause) && !tokens.some((t) => t.kind === 'speed')) {
    const span = tokens.find((t) => t.kind === 'time' && !isDelay(t));
    const delayTok = tokens.find((t) => t.kind === 'time' && isDelay(t));
    const ramp = span?.si ?? 4;
    return {
      spec: { event: 'wind', speed: 0, direction: lastWind?.spec.direction ?? defaults.direction, duration: ramp + 2, rampDuration: ramp, gustStrength: 0 },
      delay: delayTok?.si ?? 0,
    };
  }

  // Speeds: explicit units first, then bare numbers in a wind context.
  const gustNear = (t: NumToken) => /돌풍|gust/.test(t.before.slice(-8));
  let speeds = tokens.filter((t) => t.kind === 'speed' && !gustNear(t)).map((t) => t.si);
  if (speeds.length === 0) {
    speeds = tokens
      .filter((t) => t.kind === 'bare' && t.value > 1 && !gustNear(t) && !/규모|magnitude/.test(t.before))
      .map((t) => t.value);
    if (speeds.length) notes.push({ key: 'parse.note.assumedUnit' });
  }
  if (tokens.some((t) => t.kind === 'speed' && /km\/h|mph|kt|knot|노트/.test(clause))) notes.push({ key: 'parse.note.converted' });

  let speed: number | undefined;
  let rampFrom: number | undefined;
  let isRamp = up || down;
  const fromTo = clause.match(/(\d+(?:\.\d+)?)\s*(?:m\/s|km\/h|mph)?\s*(?:에서|부터|from)\s*(\d+(?:\.\d+)?)/) ??
    clause.match(/from\s+(\d+(?:\.\d+)?)\s*(?:m\/s)?\s*to\s+(\d+(?:\.\d+)?)/);
  if (speeds.length >= 2 && (fromTo || /(?:→|->|~|에서|from)/.test(clause))) {
    rampFrom = speeds[0];
    speed = speeds[1];
    isRamp = true;
  } else if (speeds.length >= 1) {
    speed = speeds[0];
  }

  // Category words ("태풍", "gale" …) give a default speed and gust.
  let categoryGust: number | undefined;
  for (const [re, v, g] of CATEGORY_SPEED) {
    if (re.test(clause)) {
      categoryGust = g;
      if (speed === undefined && !isRamp) {
        speed = v;
        notes.push({ key: 'parse.note.categorySpeed', params: { speed: v } });
      }
      break;
    }
  }
  if (speed === undefined) {
    result.errors.push({ key: 'parse.noSpeed', params: { clause } });
    return null;
  }
  if (speed > 150) {
    result.errors.push({ key: 'parse.speedRange', params: { speed: Math.round(speed) } });
    return null;
  }

  // Times: delay ("10초 후"), span ("20초 동안")
  const times = tokens.filter((t) => t.kind === 'time');
  const delayTok = times.find(isDelay);
  const spans = times.filter((t) => t !== delayTok).map((t) => t.si);
  let duration: number;
  let rampDuration: number | undefined;
  if (isRamp) {
    rampDuration = spans[0] ?? 10;
    const hold = spans[1];
    duration = hold !== undefined ? (/유지|hold|지속|keep/.test(clause) ? rampDuration + hold : Math.max(hold, rampDuration + 1)) : rampDuration + 30;
    if (spans[0] === undefined) notes.push({ key: 'parse.note.defaultRamp', params: { s: rampDuration } });
    if (hold === undefined) notes.push({ key: 'parse.note.hold', params: { s: 30 } });
  } else {
    duration = spans[0] ?? defaults.duration;
    if (spans[0] === undefined) notes.push({ key: 'parse.note.defaultDuration', params: { s: duration } });
  }

  // Direction
  const dirRes = extractDirection(clause, original, tokens);
  let direction: CompassDir | number;
  if (dirRes) {
    direction = dirRes.dir;
    if (dirRes.via === 'toward') notes.push({ key: 'parse.note.toward' });
  } else if (lastWind) {
    direction = lastWind.spec.direction;
  } else {
    direction = defaults.direction;
    notes.push({ key: 'parse.note.defaultDirection', params: { dir: defaults.direction } });
  }

  const gust = gustFrom(clause, tokens, speed) ?? categoryGust ?? lastWind?.spec.gustStrength ?? defaults.gustStrength;

  // Sequencing: a follow-up wind command starts as the previous one winds down.
  let delay = delayTok?.si ?? 0;
  if (!delayTok && lastWind) {
    delay = lastWind.delay + Math.max(1, lastWind.spec.duration - CHAIN_OVERLAP);
    notes.push({ key: 'parse.note.chained', params: { s: Math.round(delay) } });
  }

  const spec: WindEventSpec = { event: 'wind', speed: round1(speed), direction, duration: round1(duration), gustStrength: round2(gust) };
  if (isRamp) {
    spec.rampDuration = round1(rampDuration!);
    if (rampFrom !== undefined) spec.rampFrom = round1(rampFrom);
  }
  return { spec, delay };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

export class RuleBasedParser implements CommandParser {
  readonly id = 'rule-based';
  async parse(input: string, defaults: ParseDefaults): Promise<ParseResult> {
    return parseCommands(input, defaults);
  }
}
