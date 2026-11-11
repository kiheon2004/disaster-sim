/**
 * Phase 37 — the canonical command language (§5): one line of text ⇄ one Intent.
 *
 * The natural-language parser's result is always shown back as canonical text ("understood as: …"), scripts are
 * written in it, and `formatCanonical(parseCanonical(s))` is stable: canonical → Intent → canonical gives the same
 * string. The grammar (also in docs/COMMAND_EDITOR.md):
 *
 *   place <type>[:<preset>] [count=N] [at=<place>] [along=<road>] [side=left|right|north|south|east|west] [gap=<m>] [floors=N] [heading=<°>]
 *   select <target> | add <target> | remove <target> | select none
 *   move <target> by=<dx,dy,dz> | move <target> to=<place> | rotate <target> by=<°> | scale <target> x<k>
 *   set <target> [x=<m>] [y=<m>] [z=<m>] [heading=<°>] [scale=<k>] [lift=<m>]
 *   align <target> axis=x|z mode=min|center|max ref=origin|footprint | align <target> edge=front|back ref=origin|footprint
 *   distribute <target> axis=x|z|auto [gaps]
 *   match <target> heading|height|scale [to=<target>] | copy <prop,…> from=<target> to=<target>
 *   group <target> [name="…"] | ungroup <target> | rename <target> "…" | hide|show|lock|unlock <target>
 *   delete <target> | duplicate <target> [offset=<dx,dz>]
 *   terrain raise|lower|flatten|smooth <area> [by=<m>] [to=<m>] | paint <area> ground=<name>
 *   road <place> -> <place> [preset=<name>] | forest <area> [density=<v>] [seed=N]
 *   disaster <type> [at=<place>] [<field>=<value> …] [start=<s>] [now] | disaster <instance> move to=<place> | disaster <instance> delete|stop|pause|resume
 *   run | pause | reset | speed=<k> | focus <target> | focus at=<place> | undo | redo
 *   count|list|info <target> | count|list|info disasters|groups|roads|sim | measure <target> | measure <place> <place>
 *
 *   target   = selection | last | it | all | #<id> | group:"…" | group:<group id> | name:"…" | type:<type>[:<preset>]
 *              [where <pred> {and <pred>}] [largest | tallest | nearest <place>] [first N]
 *   pred     = floors|slope|height (>=|<=|>|<|=) <n> | near <place> r=<m> | on road [<road>] | hidden | locked | visible | unlocked | warning[=<code>]
 *   place    = <x>,<z> | node:<id> | seg:<id>[@<0…1>] | junction | cursor | view | center | selection | last | #<id> | group:"…" | name:"…"
 *              | feature:<id or kind>
 *              | north|south|east|west(<place>[,<m>]) | next(<place>)
 *   road     = seg:<id> | road:<node>-<node> | road:main | road:any | road:nearest(<place>)
 *   area     = rect <x0>,<z0>,<x1>,<z1> | circle <place> r=<m> | around <target> r=<m> | feature:<id or kind>
 *   instance = p<k> | <type>[#<n>] | all
 *
 * A target given as a key's value is one token, or several in parentheses: from=#id, from=(selection first 1).
 * Verbs have Korean aliases (배치, 선택 …); upper / lower case and full-width characters do not matter (see normalize).
 * Pure: no store, no clock, no randomness.
 */
import {
  ALIGN_AXES, ALIGN_EDGES, ALIGN_MODES, ALIGN_REFS, COMPARE_OPS, DISTRIBUTE_AXES, COPY_PROPS, DIRECTIONS, FLAG_OPS, INSTANCE_OPS, MATCH_WHAT, QUERY_TOPICS, SIDES, TERRAIN_OPS,
  intentProblem, intentSchema,
  type AreaRef, type CompareOp, type Direction, type InstanceRef, type Intent, type PlaceRef, type Predicate, type Rank, type RoadRef, type TargetBase, type TargetRef,
} from './intent';

// ── Numbers and strings ──────────────────────────────────────────────────────────────

/** Shortest text that reads back as the same number; large / tiny values in exponent form (1.8e9). */
export function formatNumber(v: number): string {
  if (Object.is(v, -0)) return '0';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential().replace('e+', 'e');
  return String(v);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** A number token (an optional unit the grammar allows there is dropped: m, °, s, x). */
function readNumber(tok: string, units: readonly string[] = []): number | null {
  let t = tok;
  for (const u of units) if (t.length > u.length && t.toLowerCase().endsWith(u)) { t = t.slice(0, -u.length); break; }
  if (!NUMBER.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquote(tok: string): string | null {
  if (tok.length < 2 || tok[0] !== '"' || tok[tok.length - 1] !== '"') return null;
  let out = '';
  for (let i = 1; i < tok.length - 1; i++) {
    if (tok[i] === '\\' && i + 1 < tok.length - 1) out += tok[++i];
    else if (tok[i] === '"') return null;
    else out += tok[i];
  }
  return out;
}

// ── Tokens ───────────────────────────────────────────────────────────────────────────

/** Split on white space, keeping "quoted text" and (parenthesised groups) inside one token. */
export function tokenize(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < line.length && line[i] !== '"') { if (line[i] === '\\') i++; i++; }
      if (i >= line.length) return null; // unterminated
      cur += line.slice(start, i + 1);
    } else if (c === '(') { depth++; cur += c; }
    else if (c === ')') { if (depth === 0) return null; depth--; cur += c; }
    else if (/\s/.test(c) && depth === 0) { if (cur) out.push(cur); cur = ''; }
    else cur += c;
  }
  if (depth !== 0) return null;
  if (cur) out.push(cur);
  return out;
}

/** Split `a,b,c` at top-level commas (not inside quotes / parentheses). */
function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') cur += s[++i] ?? ''; else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; cur += c; }
    else if (c === '(') { depth++; cur += c; }
    else if (c === ')') { depth--; cur += c; }
    else if (c === sep && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ── Verbs ────────────────────────────────────────────────────────────────────────────

export const VERBS = [
  'place', 'select', 'add', 'remove', 'move', 'rotate', 'scale', 'set', 'align', 'distribute', 'match', 'copy', 'group', 'ungroup', 'rename',
  'hide', 'show', 'lock', 'unlock', 'delete', 'duplicate', 'terrain', 'paint', 'road', 'forest', 'disaster', 'run', 'pause', 'reset', 'speed',
  'focus', 'undo', 'redo', 'count', 'list', 'measure', 'info',
] as const;
export type Verb = (typeof VERBS)[number];

/** Korean aliases of the canonical verbs (§5). */
export const VERB_ALIASES_KO: Record<string, Verb> = {
  배치: 'place', 선택: 'select', 추가: 'add', 제외: 'remove', 이동: 'move', 회전: 'rotate', 크기: 'scale', 설정: 'set', 정렬: 'align', 분배: 'distribute',
  맞춤: 'match', 복사: 'copy', 그룹: 'group', 그룹해제: 'ungroup', 이름: 'rename', 숨김: 'hide', 표시: 'show', 잠금: 'lock', 잠금해제: 'unlock',
  삭제: 'delete', 복제: 'duplicate', 지형: 'terrain', 칠하기: 'paint', 도로: 'road', 숲: 'forest', 재난: 'disaster', 실행: 'run', 일시정지: 'pause',
  리셋: 'reset', 배속: 'speed', 보기: 'focus', 실행취소: 'undo', 다시실행: 'redo', 개수: 'count', 목록: 'list', 측정: 'measure', 정보: 'info',
};

// ── Parse errors ─────────────────────────────────────────────────────────────────────

export type CanonicalErrorCode = 'empty' | 'unterminated' | 'unknownVerb' | 'expected' | 'badValue' | 'unknownKey' | 'duplicateKey' | 'extra' | 'invalid';

export interface CanonicalError {
  code: CanonicalErrorCode;
  /** The token the parser stopped at (when there is one). */
  token?: string;
  /** What it expected there (a grammar term: target, place, number …). */
  expected?: string;
}

class Fail extends Error {
  constructor(readonly detail: CanonicalError) {
    super(detail.code);
  }
}
const fail = (code: CanonicalErrorCode, token?: string, expected?: string): never => {
  throw new Fail({ code, ...(token !== undefined ? { token } : {}), ...(expected !== undefined ? { expected } : {}) });
};

const ID = /^[A-Za-z_][\w.-]*$/;
const WORD = /^[A-Za-z_][\w.]*$/;
/** A preset key may start with a digit (container:20ft). */
const PRESET = /^\w[\w.]*$/;

// ── Places, roads ────────────────────────────────────────────────────────────────────

const PLACE_WORDS = new Set(['cursor', 'view', 'center', 'junction', 'selection', 'last']);

/** One token → a place, or null when the token is not a place. */
export function parsePlace(tok: string): PlaceRef | null {
  const low = tok.toLowerCase();
  if (PLACE_WORDS.has(low)) return { p: low as 'cursor' | 'view' | 'center' | 'junction' | 'selection' | 'last' };
  if (tok[0] === '#') return ID.test(tok.slice(1)) ? { p: 'object', id: tok.slice(1) } : null;
  // (40,60) is the same point as 40,60
  const bare = tok[0] === '(' && tok[tok.length - 1] === ')' ? tok.slice(1, -1) : tok;
  const xz = splitTop(bare);
  if (xz.length === 2) {
    const x = readNumber(xz[0].trim(), ['m']), z = readNumber(xz[1].trim(), ['m']);
    if (x !== null && z !== null) return { p: 'xz', x, z };
  }
  const call = /^([a-z]+)\((.*)\)$/i.exec(tok);
  if (call) {
    const fn = call[1].toLowerCase();
    const args = splitTop(call[2]).map((a) => a.trim());
    if (fn === 'next') {
      const of = parsePlace(args.join(','));
      return of ? { p: 'next', of } : null;
    }
    if ((DIRECTIONS as readonly string[]).includes(fn) && args.length >= 1) {
      // north(<place>) or north(<place>,<m>) — the place itself may hold a comma (north(40,60) / north(40,60,5)).
      const whole = parsePlace(args.join(','));
      if (whole) return { p: 'dir', dir: fn as Direction, of: whole };
      if (args.length < 2) return null;
      const of = parsePlace(args.slice(0, -1).join(','));
      const dist = readNumber(args[args.length - 1], ['m']);
      return of && dist !== null && dist >= 0 ? { p: 'dir', dir: fn as Direction, of, dist } : null;
    }
    return null;
  }
  const colon = tok.indexOf(':');
  if (colon > 0) {
    const head = tok.slice(0, colon).toLowerCase(), rest = tok.slice(colon + 1);
    if (head === 'node') return ID.test(rest) ? { p: 'node', id: rest } : null;
    if (head === 'feature') return ID.test(rest) ? { p: 'feature', id: rest } : null;
    if (head === 'seg') {
      const [id, t] = rest.split('@');
      if (!ID.test(id)) return null;
      if (t === undefined) return { p: 'seg', id, t: 0.5 };
      const v = readNumber(t);
      return v !== null && v >= 0 && v <= 1 ? { p: 'seg', id, t: v } : null;
    }
    if (head === 'group' || head === 'name') {
      const name = unquote(rest);
      if (name) return { p: head, name };
      // group:<id> — a group by its id (unquoted)
      return head === 'group' && ID.test(rest) ? { p: 'groupId', id: rest } : null;
    }
  }
  return null;
}

export function formatPlace(p: PlaceRef): string {
  switch (p.p) {
    case 'xz': return `${formatNumber(p.x)},${formatNumber(p.z)}`;
    case 'node': return `node:${p.id}`;
    case 'seg': return `seg:${p.id}@${formatNumber(p.t)}`;
    case 'object': return `#${p.id}`;
    case 'group': return `group:${quote(p.name)}`;
    case 'groupId': return `group:${p.id}`;
    case 'name': return `name:${quote(p.name)}`;
    case 'feature': return `feature:${p.id}`;
    case 'dir': return `${p.dir}(${formatPlace(p.of)}${p.dist !== undefined ? `,${formatNumber(p.dist)}` : ''})`;
    case 'next': return `next(${formatPlace(p.of)})`;
    default: return p.p;
  }
}

export function parseRoad(tok: string): RoadRef | null {
  const colon = tok.indexOf(':');
  if (colon <= 0) return null;
  const head = tok.slice(0, colon).toLowerCase(), rest = tok.slice(colon + 1);
  if (head === 'seg') return ID.test(rest) ? { r: 'seg', id: rest } : null;
  if (head !== 'road') return null;
  if (rest.toLowerCase() === 'main') return { r: 'main' };
  if (rest.toLowerCase() === 'any') return { r: 'any' };
  const near = /^nearest\((.*)\)$/i.exec(rest);
  if (near) {
    const at = parsePlace(near[1].trim());
    return at ? { r: 'nearest', at } : null;
  }
  const ends = rest.split('-');
  return ends.length === 2 && WORD.test(ends[0]) && WORD.test(ends[1]) ? { r: 'between', a: ends[0], b: ends[1] } : null;
}

export function formatRoad(r: RoadRef): string {
  switch (r.r) {
    case 'seg': return `seg:${r.id}`;
    case 'between': return `road:${r.a}-${r.b}`;
    case 'main': return 'road:main';
    case 'any': return 'road:any';
    case 'nearest': return `road:nearest(${formatPlace(r.at)})`;
  }
}

// ── Token cursor ─────────────────────────────────────────────────────────────────────

class Cursor {
  i = 0;
  constructor(readonly toks: string[]) {}
  peek(): string | undefined { return this.toks[this.i]; }
  next(): string | undefined { return this.toks[this.i++]; }
  done(): boolean { return this.i >= this.toks.length; }
  /** `key=` of the next token (lower case), when it is a key=value token. */
  key(): string | null {
    const t = this.peek();
    if (!t) return null;
    const m = /^([A-Za-z_]\w*)=/.exec(t);
    return m ? m[1].toLowerCase() : null;
  }
}

const valueOf = (tok: string) => tok.slice(tok.indexOf('=') + 1);

function place(c: Cursor, what = 'place'): PlaceRef {
  const t = c.next();
  const p = t === undefined ? null : parsePlace(t);
  return p ?? fail('expected', t, what);
}

function number(tok: string | undefined, what: string, units: readonly string[] = []): number {
  const v = tok === undefined ? null : readNumber(tok, units);
  return v ?? fail('badValue', tok, what);
}

function integer(tok: string | undefined, what: string): number {
  const v = number(tok, what);
  return Number.isInteger(v) && v > 0 ? v : fail('badValue', tok, what);
}

// ── Targets ──────────────────────────────────────────────────────────────────────────

function parseBase(tok: string): TargetBase | null {
  const low = tok.toLowerCase();
  if (low === 'selection' || low === 'last' || low === 'it' || low === 'all') return { b: low };
  if (tok[0] === '#') return ID.test(tok.slice(1)) ? { b: 'id', id: tok.slice(1) } : null;
  const colon = tok.indexOf(':');
  if (colon <= 0) return null;
  const head = tok.slice(0, colon).toLowerCase(), rest = tok.slice(colon + 1);
  if (head === 'group' || head === 'name') {
    const name = unquote(rest);
    if (name) return { b: head, name };
    return head === 'group' && ID.test(rest) ? { b: 'groupId', id: rest } : null;
  }
  if (head === 'type') {
    const [type, preset, more] = rest.split(':');
    if (more !== undefined || !WORD.test(type) || (preset !== undefined && !PRESET.test(preset))) return null;
    return preset !== undefined ? { b: 'type', type, preset } : { b: 'type', type };
  }
  return null;
}

const CMP = new RegExp(`^(floors|slope|height)(${COMPARE_OPS.map((o) => o.replace(/[<>=]/g, '\\$&')).join('|')})(.+)$`, 'i');
const FLAG_PREDS = new Set(['hidden', 'locked', 'visible', 'unlocked']);

function predicate(c: Cursor): Predicate {
  const t = c.next();
  if (t === undefined) return fail('expected', t, 'condition');
  const low = t.toLowerCase();
  if (FLAG_PREDS.has(low)) return { f: low as 'hidden' | 'locked' | 'visible' | 'unlocked' };
  if (low === 'warning') return { f: 'warning' };
  if (low.startsWith('warning=')) {
    const code = valueOf(t);
    return WORD.test(code) ? { f: 'warning', code } : fail('badValue', t, 'warning code');
  }
  if (low === 'near') {
    const at = place(c);
    if (c.key() !== 'r') return fail('expected', c.peek(), 'r=<m>');
    const r = number(valueOf(c.next()!), 'radius', ['m']);
    return r > 0 ? { f: 'near', at, r } : fail('badValue', String(r), 'radius');
  }
  if (low === 'on') {
    if (c.peek()?.toLowerCase() !== 'road') return fail('expected', c.peek(), 'road');
    c.next();
    const nx = c.peek();
    const road = nx !== undefined ? parseRoad(nx) : null;
    if (road) { c.next(); return { f: 'onRoad', road }; }
    return { f: 'onRoad' };
  }
  const m = CMP.exec(t);
  if (m) {
    const v = number(m[3], m[1], ['°', 'm']);
    return { f: m[1].toLowerCase() as 'floors' | 'slope' | 'height', op: m[2] as CompareOp, v };
  }
  return fail('expected', t, 'condition');
}

/** A target starting at the cursor (stops before the first token that cannot continue it). */
function target(c: Cursor): TargetRef {
  const t = c.next();
  const base = t === undefined ? null : parseBase(t);
  if (!base) return fail('expected', t, 'target');
  const out: TargetRef = { base };
  if (c.peek()?.toLowerCase() === 'where') {
    c.next();
    out.where = [predicate(c)];
    while (c.peek()?.toLowerCase() === 'and') { c.next(); out.where.push(predicate(c)); }
  }
  const r = c.peek()?.toLowerCase();
  if (r === 'largest' || r === 'tallest') { c.next(); out.rank = { by: r }; }
  else if (r === 'nearest') { c.next(); out.rank = { by: 'nearest', at: place(c) }; }
  if (c.peek()?.toLowerCase() === 'first') { c.next(); out.first = integer(c.next(), 'count'); }
  return out;
}

/** A target written as one key value: a single token, or several in parentheses. */
function targetValue(tok: string): TargetRef {
  const inner = tok[0] === '(' && tok[tok.length - 1] === ')' ? tok.slice(1, -1) : tok;
  const toks = tokenize(inner);
  if (!toks || !toks.length) return fail('expected', tok, 'target');
  const c = new Cursor(toks);
  const t = target(c);
  if (!c.done()) return fail('extra', c.peek());
  return t;
}

function formatPredicate(p: Predicate): string {
  switch (p.f) {
    case 'floors': case 'slope': case 'height': return `${p.f}${p.op}${formatNumber(p.v)}`;
    case 'near': return `near ${formatPlace(p.at)} r=${formatNumber(p.r)}`;
    case 'onRoad': return p.road ? `on road ${formatRoad(p.road)}` : 'on road';
    case 'warning': return p.code ? `warning=${p.code}` : 'warning';
    default: return p.f;
  }
}

function formatBase(b: TargetBase): string {
  switch (b.b) {
    case 'id': return `#${b.id}`;
    case 'group': return `group:${quote(b.name)}`;
    case 'groupId': return `group:${b.id}`;
    case 'name': return `name:${quote(b.name)}`;
    case 'type': return b.preset ? `type:${b.type}:${b.preset}` : `type:${b.type}`;
    default: return b.b;
  }
}

const formatRank = (r: Rank): string => (r.by === 'nearest' ? `nearest ${formatPlace(r.at)}` : r.by);

export function formatTarget(t: TargetRef): string {
  const parts = [formatBase(t.base)];
  if (t.where?.length) parts.push('where', t.where.map(formatPredicate).join(' and '));
  if (t.rank) parts.push(formatRank(t.rank));
  if (t.first !== undefined) parts.push('first', String(t.first));
  return parts.join(' ');
}

const formatTargetValue = (t: TargetRef): string => {
  const s = formatTarget(t);
  return s.includes(' ') ? `(${s})` : s;
};

// ── Areas ────────────────────────────────────────────────────────────────────────────

function area(c: Cursor): AreaRef {
  const t = c.next();
  const low = t?.toLowerCase();
  if (low === 'rect') {
    const v = c.next();
    const n = v === undefined ? [] : splitTop(v).map((s) => readNumber(s.trim(), ['m']));
    if (n.length !== 4 || n.some((x) => x === null)) return fail('badValue', v, 'x0,z0,x1,z1');
    const [x0, z0, x1, z1] = n as number[];
    return { a: 'rect', x0, z0, x1, z1 };
  }
  if (low === 'circle' || low === 'around') {
    const at = low === 'circle' ? place(c) : null;
    const around = low === 'around' ? target(c) : null;
    if (c.key() !== 'r') return fail('expected', c.peek(), 'r=<m>');
    const r = number(valueOf(c.next()!), 'radius', ['m']);
    if (!(r > 0)) return fail('badValue', String(r), 'radius');
    return at ? { a: 'circle', at, r } : { a: 'around', target: around!, r };
  }
  if (t !== undefined && low!.startsWith('feature:') && ID.test(t.slice(8))) return { a: 'feature', id: t.slice(8) };
  return fail('expected', t, 'area');
}

function formatArea(a: AreaRef): string {
  switch (a.a) {
    case 'rect': return `rect ${[a.x0, a.z0, a.x1, a.z1].map(formatNumber).join(',')}`;
    case 'circle': return `circle ${formatPlace(a.at)} r=${formatNumber(a.r)}`;
    case 'around': return `around ${formatTarget(a.target)} r=${formatNumber(a.r)}`;
    case 'feature': return `feature:${a.id}`;
  }
}

// ── key=value options ────────────────────────────────────────────────────────────────

/** The remaining tokens as key=value options (each key once, only the allowed ones). */
function options(c: Cursor, allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  while (!c.done()) {
    const k = c.key();
    const t = c.next()!;
    if (!k) return fail('extra', t);
    if (!allowed.includes(k)) return fail('unknownKey', t, allowed.join(' '));
    if (out.has(k)) return fail('duplicateKey', t);
    out.set(k, valueOf(t));
  }
  return out;
}

function oneOf<T extends string>(v: string | undefined, list: readonly T[], what: string): T {
  const low = v?.toLowerCase();
  return (list as readonly string[]).includes(low ?? '') ? (low as T) : fail('badValue', v, what);
}

function pair(v: string, n: number, what: string): number[] {
  const parts = splitTop(v).map((s) => readNumber(s.trim(), ['m']));
  return parts.length === n && parts.every((x) => x !== null) ? (parts as number[]) : fail('badValue', v, what);
}

// ── Instances (placed disasters) ─────────────────────────────────────────────────────

function parseInstance(tok: string): InstanceRef | null {
  if (tok.toLowerCase() === 'all') return { i: 'all' };
  if (/^p\d+$/i.test(tok)) return { i: 'id', id: tok.toLowerCase() };
  const [type, nth, more] = tok.split('#');
  if (more !== undefined || !WORD.test(type)) return null;
  if (nth === undefined) return { i: 'type', type };
  return /^[1-9]\d*$/.test(nth) ? { i: 'type', type, nth: Number(nth) } : null;
}

const formatInstance = (r: InstanceRef): string => (r.i === 'all' ? 'all' : r.i === 'id' ? r.id : r.nth !== undefined ? `${r.type}#${r.nth}` : r.type);

/** A disaster field value: a number when it reads as one (units are the field's own), else a word. */
function fieldValue(v: string): number | string {
  const n = readNumber(v);
  if (n !== null) return n;
  const s = unquote(v);
  if (s !== null) return s;
  return WORD.test(v) ? v : fail('badValue', v, 'value');
}

const formatField = (v: number | string): string => (typeof v === 'number' ? formatNumber(v) : WORD.test(v) ? v : quote(v));

// ── Parse ────────────────────────────────────────────────────────────────────────────

export type CanonicalResult = { ok: true; intent: Intent } | { ok: false; error: CanonicalError };

function parseVerb(tok: string): Verb | null {
  const low = tok.toLowerCase();
  if ((VERBS as readonly string[]).includes(low)) return low as Verb;
  if (low.startsWith('speed=')) return 'speed';
  return VERB_ALIASES_KO[tok] ?? null;
}

function build(toks: string[]): Intent {
  const verb = parseVerb(toks[0]) ?? fail('unknownVerb', toks[0]);
  const c = new Cursor(toks);
  if (verb !== 'speed' || !toks[0].includes('=')) c.next();
  const intent = buildVerb(verb, c);
  // Nothing may be left unread: a command is never accepted with words the grammar did not use.
  if (!c.done()) return fail('extra', c.peek());
  return intent;
}

function buildVerb(verb: Verb, c: Cursor): Intent {
  switch (verb) {
    case 'place': {
      const kind = c.next();
      const [type, preset, more] = (kind ?? '').split(':');
      if (kind === undefined || more !== undefined || !WORD.test(type) || (preset !== undefined && !PRESET.test(preset))) return fail('expected', kind, 'type');
      const o = options(c, ['count', 'at', 'along', 'side', 'gap', 'floors', 'heading']);
      const out: Extract<Intent, { kind: 'place' }> = { kind: 'place', type };
      if (preset !== undefined) out.preset = preset;
      if (o.has('count')) out.count = integer(o.get('count'), 'count');
      if (o.has('at')) out.at = parsePlace(o.get('at')!) ?? fail('badValue', o.get('at'), 'place');
      if (o.has('along')) out.along = parseRoad(o.get('along')!) ?? fail('badValue', o.get('along'), 'road');
      if (o.has('side')) out.side = oneOf(o.get('side'), SIDES, 'side');
      if (o.has('gap')) out.gap = number(o.get('gap'), 'gap', ['m']);
      if (o.has('floors')) out.floors = integer(o.get('floors'), 'floors');
      if (o.has('heading')) out.heading = number(o.get('heading'), 'heading', ['°']);
      return out;
    }
    case 'select':
      if (c.peek()?.toLowerCase() === 'none' && c.toks.length === 2) {
        c.next();
        return { kind: 'deselect' };
      }
      return { kind: 'select', mode: 'set', target: target(c) };
    case 'add': return { kind: 'select', mode: 'add', target: target(c) };
    case 'remove': return { kind: 'select', mode: 'remove', target: target(c) };
    case 'move': {
      const t = target(c);
      const o = options(c, ['by', 'to']);
      if (o.has('by') === o.has('to')) return fail('expected', c.peek(), 'by=<dx,dy,dz> or to=<place>');
      if (o.has('by')) {
        const [dx, dy, dz] = pair(o.get('by')!, 3, 'dx,dy,dz');
        return { kind: 'move', target: t, by: [dx, dy, dz] };
      }
      return { kind: 'move', target: t, to: parsePlace(o.get('to')!) ?? fail('badValue', o.get('to'), 'place') };
    }
    case 'rotate': {
      const t = target(c);
      const o = options(c, ['by']);
      if (!o.has('by')) return fail('expected', undefined, 'by=<°>');
      return { kind: 'rotate', target: t, by: number(o.get('by'), 'angle', ['°']) };
    }
    case 'scale': {
      const t = target(c);
      const k = c.next();
      const v = k !== undefined && /^x/i.test(k) ? readNumber(k.slice(1)) : null;
      if (v === null || !(v > 0)) return fail('expected', k, 'x<k>');
      return { kind: 'scale', target: t, factor: v };
    }
    case 'set': {
      const t = target(c);
      const o = options(c, ['x', 'y', 'z', 'heading', 'scale', 'lift']);
      if (!o.size) return fail('expected', undefined, 'x= y= z= heading= scale= lift=');
      const out: Extract<Intent, { kind: 'set' }> = { kind: 'set', target: t };
      for (const k of ['x', 'y', 'z', 'lift'] as const) if (o.has(k)) out[k] = number(o.get(k), k, ['m']);
      if (o.has('heading')) out.heading = number(o.get('heading'), 'heading', ['°']);
      if (o.has('scale')) out.scale = number(o.get('scale'), 'scale');
      return out;
    }
    case 'align': {
      const t = target(c);
      const o = options(c, ['axis', 'mode', 'edge', 'ref']);
      const ref = o.has('ref') ? oneOf(o.get('ref'), ALIGN_REFS, 'ref') : 'origin';
      if (o.has('edge')) {
        if (o.has('axis') || o.has('mode')) return fail('expected', undefined, 'edge=… or axis=… mode=…');
        return { kind: 'align', target: t, edge: oneOf(o.get('edge'), ALIGN_EDGES, 'edge'), ref };
      }
      return { kind: 'align', target: t, axis: oneOf(o.get('axis'), ALIGN_AXES, 'axis'), mode: oneOf(o.get('mode'), ALIGN_MODES, 'mode'), ref };
    }
    case 'distribute': {
      const t = target(c);
      let gaps = false;
      if (c.toks[c.toks.length - 1].toLowerCase() === 'gaps') { gaps = true; c.toks.pop(); }
      const o = options(c, ['axis']);
      return { kind: 'distribute', target: t, axis: o.has('axis') ? oneOf(o.get('axis'), DISTRIBUTE_AXES, 'axis') : 'auto', gaps };
    }
    case 'match': {
      const t = target(c);
      const what = oneOf(c.next(), MATCH_WHAT, 'heading|height|scale');
      const o = options(c, ['to']);
      return o.has('to') ? { kind: 'match', target: t, what, to: targetValue(o.get('to')!) } : { kind: 'match', target: t, what };
    }
    case 'copy': {
      const list = c.next();
      const props = (list ?? '').split(',').map((p) => oneOf(p, COPY_PROPS, 'property'));
      const o = options(c, ['from', 'to']);
      if (!o.has('from')) return fail('expected', undefined, 'from=<target>');
      return { kind: 'copy', props: [...new Set(props)], from: targetValue(o.get('from')!), target: o.has('to') ? targetValue(o.get('to')!) : { base: { b: 'selection' } } };
    }
    case 'group': {
      const t = target(c);
      const o = options(c, ['name']);
      if (!o.has('name')) return { kind: 'group', target: t };
      return { kind: 'group', target: t, name: unquote(o.get('name')!) ?? fail('badValue', o.get('name'), '"name"') };
    }
    case 'ungroup': return { kind: 'ungroup', target: target(c) };
    case 'rename': {
      const t = target(c);
      const n = c.next();
      return { kind: 'rename', target: t, name: (n !== undefined ? unquote(n) : null) ?? fail('expected', n, '"name"') };
    }
    case 'hide': case 'show': case 'lock': case 'unlock': return { kind: 'flag', op: oneOf(verb, FLAG_OPS, 'verb'), target: target(c) };
    case 'delete': return { kind: 'delete', target: target(c) };
    case 'duplicate': {
      const t = target(c);
      const o = options(c, ['offset']);
      if (!o.has('offset')) return { kind: 'duplicate', target: t };
      const [dx, dz] = pair(o.get('offset')!, 2, 'dx,dz');
      return { kind: 'duplicate', target: t, offset: [dx, dz] };
    }
    case 'terrain': {
      const op = oneOf(c.next(), TERRAIN_OPS, 'raise|lower|flatten|smooth');
      const a = area(c);
      const o = options(c, ['by', 'to']);
      const out: Extract<Intent, { kind: 'terrain' }> = { kind: 'terrain', op, area: a };
      if (o.has('by')) out.by = number(o.get('by'), 'by', ['m']);
      if (o.has('to')) out.to = number(o.get('to'), 'to', ['m']);
      return out;
    }
    case 'paint': {
      const a = area(c);
      const o = options(c, ['ground']);
      const g = o.get('ground');
      return { kind: 'paint', area: a, ground: g !== undefined && WORD.test(g) ? g : fail('expected', g, 'ground=<name>') };
    }
    case 'road': {
      const from = place(c);
      if (c.next() !== '->') return fail('expected', c.toks[c.i - 1], '->');
      const to = place(c);
      const o = options(c, ['preset']);
      const p = o.get('preset');
      if (p !== undefined && !WORD.test(p)) return fail('badValue', p, 'preset');
      return p !== undefined ? { kind: 'road', from, to, preset: p } : { kind: 'road', from, to };
    }
    case 'forest': {
      const a = area(c);
      const o = options(c, ['density', 'seed']);
      const out: Extract<Intent, { kind: 'forest' }> = { kind: 'forest', area: a };
      if (o.has('density')) out.density = fieldValue(o.get('density')!);
      if (o.has('seed')) {
        const s = number(o.get('seed'), 'seed');
        out.seed = Number.isInteger(s) && s >= 0 ? s : fail('badValue', o.get('seed'), 'seed');
      }
      return out;
    }
    case 'disaster': {
      const first = c.next();
      if (first === undefined) return fail('expected', first, 'type');
      const op = c.peek()?.toLowerCase();
      if (op !== undefined && (INSTANCE_OPS as readonly string[]).includes(op)) {
        const ref = parseInstance(first) ?? fail('expected', first, 'instance');
        c.next();
        const o = options(c, op === 'move' ? ['to'] : []);
        if (op !== 'move') return { kind: 'instance', ref, op: op as (typeof INSTANCE_OPS)[number] };
        if (!o.has('to')) return fail('expected', undefined, 'to=<place>');
        return { kind: 'instance', ref, op: 'move', to: parsePlace(o.get('to')!) ?? fail('badValue', o.get('to'), 'place') };
      }
      if (!WORD.test(first)) return fail('expected', first, 'type');
      const out: Extract<Intent, { kind: 'disaster' }> = { kind: 'disaster', type: first, fields: {} };
      // `now` (run it at once) is the last word.
      if (c.toks.length > c.i && c.toks[c.toks.length - 1].toLowerCase() === 'now') {
        out.now = true;
        c.toks.pop();
      }
      while (!c.done()) {
        const k = c.key();
        const t = c.next()!;
        if (!k) return fail('extra', t);
        // (keys keep their case: they are the phenomenon's own field names)
        const name = t.slice(0, t.indexOf('='));
        const v = valueOf(t);
        if (k === 'at') {
          if (out.at) return fail('duplicateKey', t);
          out.at = parsePlace(v) ?? fail('badValue', v, 'place');
        } else if (k === 'start') {
          if (out.start !== undefined) return fail('duplicateKey', t);
          const s = number(v, 'start', ['s']);
          out.start = s >= 0 ? s : fail('badValue', v, 'start');
        } else {
          if (name in out.fields) return fail('duplicateKey', t);
          out.fields[name] = fieldValue(v);
        }
      }
      return out;
    }
    case 'run': case 'pause': case 'reset': return { kind: 'sim', op: verb };
    case 'speed': {
      const t = c.next();
      const v = t !== undefined && t.toLowerCase().startsWith('speed=') ? readNumber(valueOf(t), ['x']) : t !== undefined ? readNumber(t, ['x']) : null;
      return v !== null && v > 0 ? { kind: 'speed', value: v } : fail('expected', t, 'speed=<k>');
    }
    case 'focus': {
      if (c.key() === 'at') {
        const v = valueOf(c.next()!);
        return { kind: 'focus', at: parsePlace(v) ?? fail('badValue', v, 'place') };
      }
      return { kind: 'focus', target: target(c) };
    }
    case 'undo': case 'redo': return { kind: verb };
    case 'count': case 'list': case 'measure': case 'info': {
      const t = c.peek();
      if (t === undefined) return fail('expected', t, 'target');
      if ((QUERY_TOPICS as readonly string[]).includes(t.toLowerCase()) && c.toks.length === 2) {
        c.next();
        return { kind: 'query', op: verb, topic: t.toLowerCase() as (typeof QUERY_TOPICS)[number] };
      }
      if (verb === 'measure' && c.toks.length === 3) {
        const from = parsePlace(c.toks[1]), to = parsePlace(c.toks[2]);
        if (from && to) { c.i = 3; return { kind: 'query', op: 'measure', from, to }; }
      }
      return { kind: 'query', op: verb, target: target(c) };
    }
  }
}

/** One canonical line → one intent. Never guesses: anything it cannot read is an error with the offending token. */
export function parseCanonical(line: string): CanonicalResult {
  const toks = tokenize(line.trim());
  if (toks === null) return { ok: false, error: { code: 'unterminated' } };
  if (toks.length === 0) return { ok: false, error: { code: 'empty' } };
  try {
    const check = intentSchema.safeParse(build(toks.slice()));
    if (!check.success) return { ok: false, error: { code: 'invalid', expected: check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } };
    const problem = intentProblem(check.data);
    if (problem) return { ok: false, error: { code: 'invalid', expected: problem } };
    return { ok: true, intent: check.data };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.detail };
    throw e;
  }
}

// ── Format ───────────────────────────────────────────────────────────────────────────

/** Intent → its canonical line (fixed key order; the inverse of `parseCanonical`). */
export function formatCanonical(i: Intent): string {
  const kv = (k: string, v: string | undefined) => (v === undefined ? [] : [`${k}=${v}`]);
  const n = (v: number | undefined) => (v === undefined ? undefined : formatNumber(v));
  switch (i.kind) {
    case 'place':
      return [
        'place', i.preset ? `${i.type}:${i.preset}` : i.type,
        ...kv('count', n(i.count)), ...kv('at', i.at && formatPlace(i.at)), ...kv('along', i.along && formatRoad(i.along)), ...kv('side', i.side),
        ...kv('gap', n(i.gap)), ...kv('floors', n(i.floors)), ...kv('heading', n(i.heading)),
      ].join(' ');
    case 'select': return `${i.mode === 'set' ? 'select' : i.mode} ${formatTarget(i.target)}`;
    case 'deselect': return 'select none';
    case 'move': return `move ${formatTarget(i.target)} ${i.by ? `by=${i.by.map(formatNumber).join(',')}` : `to=${formatPlace(i.to!)}`}`;
    case 'rotate': return `rotate ${formatTarget(i.target)} by=${formatNumber(i.by)}`;
    case 'scale': return `scale ${formatTarget(i.target)} x${formatNumber(i.factor)}`;
    case 'set':
      return ['set', formatTarget(i.target), ...kv('x', n(i.x)), ...kv('y', n(i.y)), ...kv('z', n(i.z)), ...kv('heading', n(i.heading)), ...kv('scale', n(i.scale)), ...kv('lift', n(i.lift))].join(' ');
    case 'align': return i.edge ? `align ${formatTarget(i.target)} edge=${i.edge} ref=${i.ref}` : `align ${formatTarget(i.target)} axis=${i.axis} mode=${i.mode} ref=${i.ref}`;
    case 'distribute': return `distribute ${formatTarget(i.target)} axis=${i.axis}${i.gaps ? ' gaps' : ''}`;
    case 'match': return `match ${formatTarget(i.target)} ${i.what}${i.to ? ` to=${formatTargetValue(i.to)}` : ''}`;
    case 'copy': return `copy ${i.props.join(',')} from=${formatTargetValue(i.from)} to=${formatTargetValue(i.target)}`;
    case 'group': return `group ${formatTarget(i.target)}${i.name !== undefined ? ` name=${quote(i.name)}` : ''}`;
    case 'ungroup': return `ungroup ${formatTarget(i.target)}`;
    case 'rename': return `rename ${formatTarget(i.target)} ${quote(i.name)}`;
    case 'flag': return `${i.op} ${formatTarget(i.target)}`;
    case 'delete': return `delete ${formatTarget(i.target)}`;
    case 'duplicate': return `duplicate ${formatTarget(i.target)}${i.offset ? ` offset=${i.offset.map(formatNumber).join(',')}` : ''}`;
    case 'terrain': return ['terrain', i.op, formatArea(i.area), ...kv('by', n(i.by)), ...kv('to', n(i.to))].join(' ');
    case 'paint': return `paint ${formatArea(i.area)} ground=${i.ground}`;
    case 'road': return `road ${formatPlace(i.from)} -> ${formatPlace(i.to)}${i.preset ? ` preset=${i.preset}` : ''}`;
    case 'forest': return ['forest', formatArea(i.area), ...kv('density', i.density === undefined ? undefined : formatField(i.density)), ...kv('seed', n(i.seed))].join(' ');
    case 'disaster':
      return [
        'disaster', i.type, ...kv('at', i.at && formatPlace(i.at)),
        ...Object.keys(i.fields).sort().map((k) => `${k}=${formatField(i.fields[k])}`),
        ...kv('start', n(i.start)), ...(i.now ? ['now'] : []),
      ].join(' ');
    case 'instance': return `disaster ${formatInstance(i.ref)} ${i.op}${i.op === 'move' && i.to ? ` to=${formatPlace(i.to)}` : ''}`;
    case 'sim': return i.op;
    case 'speed': return `speed=${formatNumber(i.value)}`;
    case 'focus': return i.at ? `focus at=${formatPlace(i.at)}` : `focus ${formatTarget(i.target!)}`;
    case 'undo': case 'redo': return i.kind;
    case 'query':
      if (i.topic) return `${i.op} ${i.topic}`;
      if (i.from && i.to) return `measure ${formatPlace(i.from)} ${formatPlace(i.to)}`;
      return `${i.op} ${formatTarget(i.target!)}`;
  }
}
