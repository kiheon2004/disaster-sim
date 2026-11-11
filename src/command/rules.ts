/**
 * Phase 37 — the rules of the natural-language parser (NL-CONVENTIONS.md §2, §3): one clause of tokens → intents.
 *
 * A clause is tried against the sentence classes in a fixed order. Each class reads the words it understands and
 * marks them used; a class answers only when EVERY content word of the clause was used (the leftover rule: a command
 * is never built from part of a sentence while ignoring the rest). Particles, prepositions and fillers are not content
 * words — they are attached to their neighbour as roles (`post`: 에 / 에서 / 로 / 까지 …, `pre`: at / to / from / of …).
 *
 * Pure: no store, no clock, no randomness. The word tables are in aliases.ts — this file holds no vocabulary.
 */
import type { I18nMessage } from '@/i18n/i18n';
import { formatPlace, formatTarget } from './canonical';
import type { AreaRef, CompareOp, Direction, InstanceRef, Intent, IntentOf, PlaceRef, Predicate, Rank, RoadRef, TargetBase, TargetRef } from './intent';
import { findKind } from './kinds';
import { DISASTER_FIELDS, DURATION_TYPES, LEGACY_TYPES, type UnitId } from './aliases';
import { legacyForm } from './legacyDisaster';
import type { Sense, Tok } from './lexicon';

export type AskSlot = 'direction' | 'amount' | 'target' | 'kind' | 'name' | 'field' | 'axis' | 'place';

/** A content token with the roles of the particles / prepositions around it. */
export interface CT {
  tok: Tok;
  /** Roles of the prepositions before it (at, to, from, of, by, with, as, for, like, eq). */
  pre: string[];
  /** Roles of the particles after it (obj, subj, topic, at, from, to, upto, gen, also, and, only, like, called). */
  post: string[];
  used: boolean;
}

export type Out =
  | {
      r: 'ok'; intents: Intent[]; cls: string;
      /** The target this clause acted on (a later clause without one takes it — §4). */
      target?: TargetRef;
      /** The clause makes objects: a later clause without a target means `last`. */
      makes?: boolean;
      area?: AreaRef;
      /** The clause named its target itself (it was not taken from the earlier clause). */
      said?: boolean;
      notes?: I18nMessage[];
    }
  | { r: 'ask'; slot: AskSlot; understood: string }
  | { r: 'bad'; reason: I18nMessage };

export interface Ctx {
  /** The earlier clause's target (or `last` after a clause that makes objects). */
  inherit?: TargetRef;
  /** The earlier clause's area (carried over when this clause needs one and names none). */
  area?: AreaRef;
}

// ── Token tests ──────────────────────────────────────────────────────────────────────────

type NumCT = CT & { tok: Extract<Tok, { t: 'num' }> };

const senses = (t: CT | undefined): Sense[] => (t && t.tok.t === 'w' ? t.tok.s : []);
const hasW = (t: CT | undefined, id: string): boolean => senses(t).some((s) => s.c === 'w' && s.id === id);
/** The rest of the first word id with this prefix (`dir:` → `north`), or null. */
const wPre = (t: CT | undefined, prefix: string): string | null => {
  for (const s of senses(t)) if (s.c === 'w' && s.id.startsWith(prefix)) return s.id.slice(prefix.length);
  return null;
};
const verbIn = (t: CT | undefined, ids: readonly string[]): string | null => {
  for (const id of ids) if (senses(t).some((s) => s.c === 'verb' && s.id === id)) return id;
  return null;
};
const isVerb = (t: CT | undefined): boolean => senses(t).some((s) => s.c === 'verb');
const kindOf = (t: CT | undefined): Extract<Sense, { c: 'kind' }> | null => (senses(t).find((s) => s.c === 'kind') as Extract<Sense, { c: 'kind' }> | undefined) ?? null;
const disOf = (t: CT | undefined): Extract<Sense, { c: 'dis' }> | null => (senses(t).find((s) => s.c === 'dis') as Extract<Sense, { c: 'dis' }> | undefined) ?? null;
const isNum = (t: CT | undefined, ...units: (UnitId | null)[]): t is NumCT => !!t && t.tok.t === 'num' && (units.length === 0 || units.includes(t.tok.u));
const COMPASS = ['north', 'south', 'east', 'west'] as const;
const compassOf = (t: CT | undefined): Direction | null => {
  const d = wPre(t, 'dir:');
  return d !== null && (COMPASS as readonly string[]).includes(d) ? (d as Direction) : null;
};

export class Clause {
  /** The clause ended with a question mark. */
  question = false;
  constructor(readonly ts: CT[]) {}
  get n(): number { return this.ts.length; }
  /** The token at `i` when it is not used yet. */
  free(i: number): CT | undefined { const t = this.ts[i]; return t && !t.used ? t : undefined; }
  use(...idx: number[]): void { for (const i of idx) if (this.ts[i]) this.ts[i].used = true; }
  reset(): void { for (const t of this.ts) t.used = false; }
  find(pred: (t: CT, i: number) => unknown, from = 0): number {
    for (let i = from; i < this.n; i++) { const t = this.free(i); if (t && pred(t, i)) return i; }
    return -1;
  }
  all(pred: (t: CT, i: number) => unknown): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) { const t = this.free(i); if (t && pred(t, i)) out.push(i); }
    return out;
  }
  /** Use every free token that matches; how many. */
  takeAll(pred: (t: CT, i: number) => unknown): number { const idx = this.all(pred); this.use(...idx); return idx.length; }
  /** Use the first free token that matches. */
  take(pred: (t: CT, i: number) => unknown): number { const i = this.find(pred); if (i >= 0) this.use(i); return i; }
  /** Every content word was used ("것" / "ones" alone carry no meaning). */
  done(): boolean { return this.ts.every((t) => t.used || (senses(t).length > 0 && senses(t).every((s) => s.c === 'w' && s.id === 'thing'))); }
  leftovers(): string[] { return this.ts.filter((t) => !t.used).map((t) => t.tok.text); }
}

const IT: TargetRef = { base: { b: 'it' } };
const SELECTION: TargetRef = { base: { b: 'selection' } };
const ok = (cls: string, intents: Intent[], more: Partial<Extract<Out, { r: 'ok' }>> = {}): Out => ({ r: 'ok', cls, intents, ...more });
const ask = (slot: AskSlot, understood: string): Out => ({ r: 'ask', slot, understood });
const bad = (key: I18nMessage['key'], params?: I18nMessage['params']): Out => ({ r: 'bad', reason: params ? { key, params } : { key } });

// ── Kinds ────────────────────────────────────────────────────────────────────────────────

const splitKey = (key: string): { type: string; preset?: string } => {
  const [type, preset] = key.split(':');
  return preset ? { type, preset } : { type };
};
const typeBase = (key: string): TargetBase => ({ b: 'type', ...splitKey(key) });

// ── Places ───────────────────────────────────────────────────────────────────────────────

interface PlaceHit {
  place: PlaceRef; from: number; to: number; pre: string[]; post: string[];
  /** A place relative to another (north of X, next to X). */
  compound: boolean;
  /** … and said so in words that cannot be an offset: "east of X", "X의 동쪽", "X 옆". */
  explicit?: boolean;
}

/** One place word at `i`: here / there / the centre / the junction / node n4 / s2 / (40, 60) / the hill / the selection / #id / "name". */
function atomAt(c: Clause, i: number, noDet: boolean): { place: PlaceRef; n: number } | null {
  const t = c.free(i);
  if (!t) return null;
  const next = c.free(i + 1);
  const word = wPre(t, 'place:');
  if (word === 'junction') return next?.tok.t === 'id' && next.tok.kind === 'node' ? { place: { p: 'node', id: next.tok.id }, n: 2 } : { place: { p: 'junction' }, n: 1 };
  if (word === 'cursor' || word === 'view' || word === 'last' || word === 'center') return { place: { p: word }, n: 1 };
  if (hasW(t, 'nodeNoun') && next?.tok.t === 'id' && next.tok.kind === 'node') return { place: { p: 'node', id: next.tok.id }, n: 2 };
  if (hasW(t, 'segNoun') && next?.tok.t === 'id' && next.tok.kind === 'seg') return { place: { p: 'seg', id: next.tok.id, t: 0.5 }, n: 2 };
  if (t.tok.t === 'id') {
    if (t.tok.kind === 'node') return { place: { p: 'node', id: t.tok.id }, n: 1 };
    if (t.tok.kind === 'seg') return { place: { p: 'seg', id: t.tok.id, t: 0.5 }, n: 1 };
    if (t.tok.kind === 'obj' && !noDet) return { place: { p: 'object', id: t.tok.id }, n: 1 };
    return null;
  }
  if (t.tok.t === 'xz') return { place: { p: 'xz', x: t.tok.x, z: t.tok.z }, n: 1 };
  const feature = wPre(t, 'feature:');
  if (feature) return { place: { p: 'feature', id: feature }, n: 1 };
  if (noDet) return null;
  if (hasW(t, 'det:selection')) return { place: { p: 'selection' }, n: 1 };
  if (hasW(t, 'det:last')) return { place: { p: 'last' }, n: 1 };
  if (t.tok.t === 'q' && t.tok.text) {
    if (hasW(next, 'groupNoun')) return { place: { p: 'group', name: t.tok.text }, n: 2 };
    return { place: { p: 'name', name: t.tok.text }, n: 1 };
  }
  if (hasW(t, 'groupNoun') && next?.tok.t === 'q' && next.tok.text) return { place: { p: 'group', name: next.tok.text }, n: 2 };
  return null;
}

/**
 * A place phrase starting at `i` (§2.4): a place word, with "north of X" / "5 m north of X" / "next to X" before it
 * (English) or "X 북쪽" / "X 북쪽 5 m" / "X 옆" / "X 위" after it (Korean). `noDet`: only pure place words (in a
 * move, "선택한 것 동쪽으로 5 m" is the target and an offset, not a place east of the selection).
 */
function placeAt(c: Clause, i: number, noDet = false): PlaceHit | null {
  const t = c.free(i);
  if (!t) return null;
  const t1 = c.free(i + 1), t2 = c.free(i + 2);
  // English: [5 m] north of X · next to X · on top of X
  if (isNum(t, 'm') && compassOf(t1) && t2?.pre.includes('of')) {
    const of = placeAt(c, i + 2, noDet);
    return of && t.tok.v >= 0 ? { place: { p: 'dir', dir: compassOf(t1)!, of: of.place, dist: t.tok.v }, from: i, to: of.to, pre: t.pre, post: of.post, compound: true, explicit: true } : null;
  }
  if (compassOf(t) && t1?.pre.includes('of')) {
    const of = placeAt(c, i + 1, noDet);
    return of ? { place: { p: 'dir', dir: compassOf(t)!, of: of.place }, from: i, to: of.to, pre: t.pre, post: of.post, compound: true, explicit: true } : null;
  }
  if ((hasW(t, 'next') || hasW(t, 'on')) && /^[a-z]/.test(t.tok.text)) {
    const of = placeAt(c, i + 1, noDet);
    if (!of) return null;
    return { place: hasW(t, 'next') ? { p: 'next', of: of.place } : of.place, from: i, to: of.to, pre: t.pre, post: of.post, compound: true, explicit: true };
  }
  const atom = atomAt(c, i, noDet);
  if (!atom) return null;
  let place = atom.place;
  let to = i + atom.n;
  let compound = false;
  let explicit = false;
  // "by X" = beside X
  if (t.pre.includes('by')) { place = { p: 'next', of: place }; compound = true; explicit = true; }
  // Korean: X [의] 북쪽 [5 m] · X 옆 · X 위
  for (;;) {
    const a = c.free(to), b = c.free(to + 1);
    const dir = compassOf(a);
    if (a && dir && /^[가-힣]/.test(a.tok.text)) {
      // X의 동쪽 / X에서 동쪽으로: the particle on X says "relative to X"
      if (hasRole(c.ts[to - 1], 'gen', 'from')) explicit = true;
      if (isNum(b, 'm') && b.tok.v >= 0 && !a.post.includes('at')) { place = { p: 'dir', dir, of: place, dist: b.tok.v }; to += 2; }
      else { place = { p: 'dir', dir, of: place }; to += 1; }
      compound = true;
      continue;
    }
    if (a && hasW(a, 'next') && /^[가-힣]/.test(a.tok.text)) { place = { p: 'next', of: place }; to += 1; compound = true; explicit = true; continue; }
    if (a && hasW(a, 'on') && /^[가-힣]/.test(a.tok.text) && (place.p === 'feature' || place.p === 'object' || place.p === 'name' || place.p === 'group')) { to += 1; continue; }
    break;
  }
  return { place, from: i, to, pre: t.pre, post: c.ts[to - 1].post, compound, explicit };
}

function usePlace(c: Clause, h: PlaceHit): PlaceRef {
  for (let k = h.from; k < h.to; k++) c.use(k);
  return h.place;
}

/** Every place phrase of the clause, left to right (not used yet). */
function places(c: Clause, noDet = false): PlaceHit[] {
  const out: PlaceHit[] = [];
  for (let i = 0; i < c.n; ) {
    const h = placeAt(c, i, noDet);
    if (h) { out.push(h); i = h.to; } else i++;
  }
  return out;
}

const hasRole = (h: { pre: string[]; post: string[] }, ...roles: string[]): boolean => roles.some((r) => h.pre.includes(r) || h.post.includes(r));

// ── Roads ────────────────────────────────────────────────────────────────────────────────

interface RoadHit { road: RoadRef; from: number; to: number; pre: string[]; post: string[] }

const isNode = (t: CT | undefined): t is CT & { tok: Extract<Tok, { t: 'id' }> } => !!t && t.tok.t === 'id' && t.tok.kind === 'node';
const isSeg = (t: CT | undefined): t is CT & { tok: Extract<Tok, { t: 'id' }> } => !!t && t.tok.t === 'id' && t.tok.kind === 'seg';
const isRoadWord = (t: CT | undefined): boolean => hasW(t, 'road:any');

/** A road phrase starting at `i` (§2.5). */
function roadAt(c: Clause, i: number): RoadHit | null {
  const t = c.free(i);
  if (!t) return null;
  const t1 = c.free(i + 1), t2 = c.free(i + 2), t3 = c.free(i + 3);
  const hit = (road: RoadRef, n: number): RoadHit => ({ road, from: i, to: i + n, pre: t.pre, post: c.ts[i + n - 1].post });
  if (hasW(t, 'road:main')) return hit({ r: 'main' }, 1);
  if (hasW(t, 'road:nearest')) return hit({ r: 'nearest', at: { p: 'cursor' } }, 1);
  if ((hasW(t, 'rank:nearest') || wPre(t, 'place:') === 'cursor') && isRoadWord(t1)) return hit({ r: 'nearest', at: { p: 'cursor' } }, 2);
  if (t.tok.t === 'btw') return hit({ r: 'between', a: t.tok.a, b: t.tok.b }, isRoadWord(t1) ? 2 : 1);
  // n2에서 n3까지(의) 도로 · n2와 n3 사이 도로
  if (isNode(t) && isNode(t1) && t.post.includes('from') && t1.post.includes('upto') && isRoadWord(t2)) return hit({ r: 'between', a: t.tok.id, b: t1.tok.id }, 3);
  if (isNode(t) && isNode(t1) && hasW(t2, 'between') && isRoadWord(t3)) return hit({ r: 'between', a: t.tok.id, b: t1.tok.id }, 4);
  // the road from n2 to n3 · the road between n2 and n3
  if (isRoadWord(t) && isNode(t1) && isNode(t2) && t1.pre.includes('from') && t2.pre.includes('to')) return hit({ r: 'between', a: t1.tok.id, b: t2.tok.id }, 3);
  if (isRoadWord(t) && hasW(t1, 'between') && isNode(t2) && isNode(t3)) return hit({ r: 'between', a: t2.tok.id, b: t3.tok.id }, 4);
  if (isSeg(t)) return hit({ r: 'seg', id: t.tok.id }, isRoadWord(t1) ? 2 : 1);
  if (hasW(t, 'segNoun') && isSeg(t1)) return hit({ r: 'seg', id: t1.tok.id }, 2);
  if (isRoadWord(t) && isSeg(t1)) return hit({ r: 'seg', id: t1.tok.id }, 2);
  if (isRoadWord(t)) return hit({ r: 'any' }, 1);
  return null;
}

function roads(c: Clause): RoadHit[] {
  const out: RoadHit[] = [];
  for (let i = 0; i < c.n; ) {
    const h = roadAt(c, i);
    if (h) { out.push(h); i = h.to; } else i++;
  }
  return out;
}

// ── Targets ──────────────────────────────────────────────────────────────────────────────

const OPS: Record<string, CompareOp> = { gt: '>', ge: '>=', lt: '<', le: '<=' };
const opOf = (t: CT | undefined): CompareOp | null => { const k = wPre(t, 'cmp:'); return k ? OPS[k] : null; };

/** A number with a comparison word before or after it (20도 넘는 · over 20° · 2층 이상 · at least 2 floors). */
function cmpNum(c: Clause, i: number, units: (UnitId | null)[]): { v: number; op: CompareOp | null; idx: number[] } | null {
  const a = c.free(i), b = c.free(i + 1);
  if (isNum(a, ...units)) {
    if (opOf(b)) return { v: a.tok.v, op: opOf(b), idx: [i, i + 1] };
    if (a.post.includes('upto')) return { v: a.tok.v, op: '<=', idx: [i] };
    if (a.post.includes('from')) return { v: a.tok.v, op: '>=', idx: [i] };
    return { v: a.tok.v, op: null, idx: [i] };
  }
  if (opOf(a) && isNum(b, ...units)) return { v: b.tok.v, op: opOf(a), idx: [i, i + 1] };
  return null;
}

interface TargetRead {
  /** Null when the clause names no target at all. */
  target: TargetRef | null;
  /** The clause names WHAT (a kind, the selection, an id …) — not only filters / a rank. */
  based?: boolean;
  err?: Out;
}

/** The filters of a target (§2.3), in the order said. */
function readPredicates(c: Clause): Predicate[] {
  const found: { at: number; p: Predicate }[] = [];
  for (let i = 0; i < c.n; i++) {
    const t = c.free(i);
    if (!t) continue;
    // slope
    if (hasW(t, 'steeper') && isNum(c.free(i + 1), 'deg', null)) {
      found.push({ at: i, p: { f: 'slope', op: '>', v: (c.free(i + 1) as NumCT).tok.v } });
      if (hasW(c.free(i - 1), 'slope')) c.use(i - 1);
      c.use(i, i + 1);
      continue;
    }
    if (hasW(t, 'slope')) {
      const r = hasW(c.free(i + 1), 'steeper') ? null : cmpNum(c, i + 1, ['deg', null]);
      if (r?.op) { found.push({ at: i, p: { f: 'slope', op: r.op, v: r.v } }); c.use(i, ...r.idx); }
      continue;
    }
    // height
    if (hasW(t, 'taller') || hasW(t, 'shorter')) {
      const n = c.free(i + 1);
      if (isNum(n, 'm')) { found.push({ at: i, p: { f: 'height', op: hasW(t, 'taller') ? '>' : '<', v: n.tok.v } }); c.use(i, i + 1); }
      continue;
    }
    if (hasW(t, 'height')) {
      const r = cmpNum(c, i + 1, ['m']);
      if (r?.op) { found.push({ at: i, p: { f: 'height', op: r.op, v: r.v } }); c.use(i, ...r.idx); }
      continue;
    }
    // floors: 2층 이상 · 3층 · at least 2 floors · 3-storey
    if (isNum(t, 'floors')) {
      const after = opOf(c.free(i + 1)), before = opOf(c.free(i - 1));
      const op: CompareOp = after ?? before ?? (t.post.includes('upto') ? '<=' : t.post.includes('from') ? '>=' : '=');
      found.push({ at: i, p: { f: 'floors', op, v: t.tok.v } });
      c.use(i);
      if (after) c.use(i + 1); else if (before) c.use(i - 1);
      continue;
    }
    // near: within 30 m of here · 여기 근처 30 m 안의 · n4에서 30 m 이내
    if (hasW(t, 'within')) {
      const n = c.free(i + 1), p = c.free(i - 1);
      if (/^[a-z]/.test(t.tok.text) && isNum(n, 'm') && n.tok.v > 0) {
        const at = placeAt(c, i + 2);
        if (at) { found.push({ at: i, p: { f: 'near', at: at.place, r: n.tok.v } }); c.use(i, i + 1); usePlace(c, at); }
      } else if (isNum(p, 'm') && p.tok.v > 0) {
        const end = hasW(c.free(i - 2), 'near') ? i - 2 : i - 1;
        for (let k = Math.max(0, end - 4); k < end; k++) {
          const at = placeAt(c, k);
          if (at && at.to === end) {
            found.push({ at: k, p: { f: 'near', at: at.place, r: p.tok.v } });
            usePlace(c, at);
            for (let j = end; j <= i; j++) c.use(j);
            break;
          }
        }
      }
      continue;
    }
    // flags
    const flag = wPre(t, 'flag:');
    if (flag) { found.push({ at: i, p: { f: flag as 'hidden' | 'locked' | 'visible' | 'unlocked' } }); c.use(i); continue; }
    // warnings: 가새 경고 (있는) · with brace warnings
    if (hasW(t, 'warning')) {
      const brace = hasW(c.free(i - 1), 'brace');
      found.push({ at: i, p: brace ? { f: 'warning', code: 'brace' } : { f: 'warning' } });
      c.use(i);
      if (brace) c.use(i - 1);
      if (hasW(c.free(i + 1), 'exist')) c.use(i + 1);
      const before = brace ? i - 2 : i - 1;
      if (hasW(c.free(before), 'exist')) c.use(before);
      continue;
    }
    // on the road: 도로 위의 · 길 위에 있는 · on the road · on road s3
    const road = roadAt(c, i);
    if (road) {
      const over = c.free(road.to);
      const koOn = !!over && hasW(over, 'on') && /^[가-힣]/.test(over.tok.text);
      if (koOn || road.pre.includes('at')) {
        found.push({ at: i, p: road.road.r === 'any' ? { f: 'onRoad' } : { f: 'onRoad', road: road.road } });
        for (let k = road.from; k < road.to; k++) c.use(k);
        if (koOn) { c.use(road.to); if (hasW(c.free(road.to + 1), 'exist')) c.use(road.to + 1); }
        i = road.to - 1;
      }
    }
  }
  if (found.length) c.takeAll((t) => hasW(t, 'exist'));
  return found.sort((a, b) => a.at - b.at).map((f) => f.p);
}

function readRank(c: Clause): Rank | undefined {
  const i = c.find((t) => wPre(t, 'rank:'));
  if (i < 0) return undefined;
  const by = wPre(c.ts[i], 'rank:') as 'largest' | 'tallest' | 'nearest';
  c.use(i);
  if (by !== 'nearest') return { by };
  // n4에서 가장 가까운 · nearest to n4
  for (let k = Math.max(0, i - 3); k < i; k++) {
    const h = placeAt(c, k, true);
    if (h && h.to === i && h.post.includes('from')) return { by, at: usePlace(c, h) };
  }
  const after = placeAt(c, i + 1, true);
  if (after && after.pre.includes('to')) return { by, at: usePlace(c, after) };
  return { by, at: { p: 'cursor' } };
}

function readFirst(c: Clause): number | undefined {
  const i = c.find((t) => hasW(t, 'first'));
  if (i < 0) return undefined;
  c.use(i);
  const n = c.free(i + 1);
  if (isNum(n, 'count', null) && Number.isInteger(n.tok.v) && n.tok.v > 0) { c.use(i + 1); return n.tok.v; }
  return 1;
}

/** The kind phrases of the clause: [all] kind [들] [all]. */
function kindPhrases(c: Clause): { key: string; idx: number[]; all: boolean; plural: boolean }[] {
  const out: { key: string; idx: number[]; all: boolean; plural: boolean }[] = [];
  for (let i = 0; i < c.n; i++) {
    const k = kindOf(c.free(i));
    if (!k) continue;
    const idx = [i];
    let all = false, plural = !!k.plural;
    if (hasW(c.free(i - 1), 'all')) { idx.push(i - 1); all = true; }
    let j = i + 1;
    if (hasW(c.free(j), 'plural')) { idx.push(j); plural = true; j++; }
    if (hasW(c.free(j), 'all')) { idx.push(j); all = true; }
    out.push({ key: k.key, idx, all, plural });
  }
  return out;
}

/** The base of a target from the words not used yet (§2.3). */
function readBase(c: Clause): { base: TargetBase | null; err?: Out } {
  const bases: TargetBase[] = [];
  let kinds = 0;
  // this / these + kind = the selection; "방금 만든 건물들" / "the buildings I just made" = the last result
  for (let i = 0; i < c.n; i++) {
    const t = c.free(i);
    if (!t) continue;
    const det = hasW(t, 'det:this') || hasW(t, 'det:selection') ? 'selection' : hasW(t, 'det:lastOf') ? 'last' : null;
    if (det && kindOf(c.free(i + 1))) {
      c.use(i, i + 1);
      if (hasW(c.free(i + 2), 'plural')) c.use(i + 2);
      bases.push({ b: det });
    } else if (kindOf(t) && hasW(c.free(i + 1), 'det:lastOf')) {
      c.use(i, i + 1);
      bases.push({ b: 'last' });
    }
  }
  for (const k of kindPhrases(c)) { c.use(...k.idx); bases.push(typeBase(k.key)); kinds++; }
  for (let i = 0; i < c.n; i++) {
    const t = c.free(i);
    if (!t) continue;
    if (hasW(t, 'det:selection') || (hasW(t, 'selectionNoun') && !isVerb(t))) { bases.push({ b: 'selection' }); c.use(i); }
    else if (hasW(t, 'det:last')) { bases.push({ b: 'last' }); c.use(i); }
    else if (hasW(t, 'det:it')) { bases.push({ b: 'it' }); c.use(i); }
    else if (t.tok.t === 'id' && t.tok.kind === 'obj') { bases.push({ b: 'id', id: t.tok.id }); c.use(i); }
    else if (t.tok.t === 'q' && t.tok.text) {
      const group = hasW(c.free(i + 1), 'groupNoun') ? i + 1 : hasW(c.free(i - 1), 'groupNoun') ? i - 1 : -1;
      bases.push(group >= 0 ? { b: 'group', name: t.tok.text } : { b: 'name', name: t.tok.text });
      c.use(i, group);
    }
  }
  // 전부 / everything alone = all objects; next to another base it only stresses it (선택한 것 모두, all of them)
  const all = c.takeAll((t) => hasW(t, 'all'));
  c.takeAll((t) => hasW(t, 'thing'));
  if (bases.length > 1) return { base: null, err: bad(kinds > 1 ? 'cmd37.nl.unknown.twoKinds' : 'cmd37.nl.unknown.twoTargets') };
  if (bases.length === 1) return { base: bases[0] };
  return { base: all > 0 ? { b: 'all' } : null };
}

/** The target of the clause: base, filters, rank, first N. With filters / a rank and no base it is every object. */
function readTarget(c: Clause): TargetRead {
  const where = readPredicates(c);
  const rank = readRank(c);
  const first = readFirst(c);
  const { base, err } = readBase(c);
  if (err) return { target: null, err };
  if (!base && !where.length && !rank && first === undefined) return { target: null };
  const target: TargetRef = { base: base ?? (where.length || rank ? { b: 'all' } : { b: 'it' }) };
  if (where.length) target.where = where;
  if (rank) target.rank = rank;
  if (first !== undefined) target.first = first;
  return { target, based: !!base };
}

const isPlainIt = (t: TargetRef): boolean => t.base.b === 'it' && !t.where && !t.rank && t.first === undefined;

/** The clause's target; not said (or just "it") → the earlier clause's target, else `it`. */
function targetOr(c: Clause, ctx: Ctx, fallback: TargetRef = IT): { target: TargetRef; said: boolean; err?: Out } {
  const r = readTarget(c);
  if (r.err) return { target: fallback, said: false, err: r.err };
  if (!r.target) return { target: ctx.inherit ?? fallback, said: false };
  if (isPlainIt(r.target) && ctx.inherit) return { target: ctx.inherit, said: true };
  return { target: r.target, said: true };
}

// ── Areas ────────────────────────────────────────────────────────────────────────────────

/** The area of a terrain / paint / forest clause (§3.9): circle, rectangle, around a target, a terrain feature. */
function readArea(c: Clause): { area: AreaRef } | { ask: AskSlot } | { err: Out } | null {
  // (x0,z0)에서 (x1,z1)까지 (사각형) · the rectangle from … to …
  const xz = c.all((t) => t.tok.t === 'xz');
  if (xz.length === 2) {
    const [a, b] = xz.map((i) => c.ts[i]);
    if ((hasRole(a, 'from') && hasRole(b, 'upto', 'to')) || c.find((t) => hasW(t, 'rect')) >= 0) {
      c.use(...xz);
      c.takeAll((t) => hasW(t, 'rect'));
      const p = a.tok as Extract<Tok, { t: 'xz' }>, q = b.tok as Extract<Tok, { t: 'xz' }>;
      return { area: { a: 'rect', x0: p.x, z0: p.z, x1: q.x, z1: q.z } };
    }
  }
  // <target> 주변 R m · R m around <target>
  const around = c.find((t) => hasW(t, 'around'));
  if (around >= 0) {
    const r = isNum(c.free(around + 1), 'm') ? around + 1 : isNum(c.free(around - 1), 'm') ? around - 1 : -1;
    if (r < 0) return { ask: 'amount' };
    const radius = (c.ts[r] as NumCT).tok.v;
    c.use(around, r);
    const t = readTarget(c);
    if (t.err) return { err: t.err };
    if (!t.target || !(radius > 0)) return { ask: 'target' };
    return { area: { a: 'around', target: t.target, r: radius } };
  }
  // radius: 반경 R m · R m 원 · a R m circle · within R m of · 지름 D m / D m across (r = D / 2)
  let radius: number | null = null;
  for (let i = 0; i < c.n && radius === null; i++) {
    const t = c.free(i);
    if (!t) continue;
    const half = hasW(t, 'diameter');
    if (!(half || hasW(t, 'radius') || hasW(t, 'circle') || (hasW(t, 'within') && /^[a-z]/.test(t.tok.text)))) continue;
    const n = isNum(c.free(i + 1), 'm') ? i + 1 : isNum(c.free(i - 1), 'm') ? i - 1 : -1;
    if (n < 0) {
      // a number with no unit where a length is needed (§6 D24)
      const bare = isNum(c.free(i + 1), null) ? i + 1 : isNum(c.free(i - 1), null) ? i - 1 : -1;
      if (bare < 0) continue;
      c.use(i, bare);
      c.takeAll((t) => hasW(t, 'circle') || hasW(t, 'radius'));
      places(c, true).slice(0, 1).forEach((h) => usePlace(c, h));
      return { ask: 'amount' };
    }
    const across = [n - 1, n + 1].find((k) => k !== i && hasW(c.free(k), 'diameter'));
    radius = (c.ts[n] as NumCT).tok.v / (half || across !== undefined ? 2 : 1);
    c.use(i, n, across ?? -1);
  }
  if (radius !== null) c.takeAll((t) => hasW(t, 'circle') || hasW(t, 'radius'));
  const here = places(c, true)[0];
  if (radius !== null) {
    if (!(radius > 0)) return { ask: 'amount' };
    if (!here) return { ask: 'place' };
    return { area: { a: 'circle', at: usePlace(c, here), r: radius } };
  }
  if (here) {
    usePlace(c, here);
    if (here.place.p === 'feature' && !here.compound) return { area: { a: 'feature', id: here.place.id } };
    // A place and no extent (여기를 평평하게 · a forest here · paint here with grass): the radius is missing (§6 D7, D32).
    return { ask: 'amount' };
  }
  return null;
}

// ── §3.14 undo ───────────────────────────────────────────────────────────────────────────

function pUndo(c: Clause): Out | null {
  const i = c.take((t) => verbIn(t, ['undo', 'redo']));
  if (i < 0) return null;
  c.takeAll((t) => hasW(t, 'det:last') || hasW(t, 'det:it'));
  return c.done() ? ok('undo', [{ kind: verbIn(c.ts[i], ['undo', 'redo']) as 'undo' | 'redo' }]) : null;
}

// ── §3.3 select ──────────────────────────────────────────────────────────────────────────

function pSelect(c: Clause, ctx: Ctx): Out | null {
  if (c.take((t) => verbIn(t, ['selNone'])) >= 0) return c.done() ? ok('select', [{ kind: 'deselect' }]) : null;
  let mode: 'set' | 'add' | 'remove' | null = null;
  const selNoun = c.find((t) => hasW(t, 'selectionNoun'));
  if (c.take((t) => verbIn(t, ['deselect'])) >= 0) mode = 'remove';
  else if (c.take((t) => verbIn(t, ['selRemove'])) >= 0) mode = 'remove';
  else if (c.take((t) => verbIn(t, ['selAdd'])) >= 0) mode = 'add';
  else if (selNoun >= 0 && hasRole(c.ts[selNoun], 'from') && c.find((t) => verbIn(t, ['delete', 'takeOut'])) >= 0) {
    // remove … from the selection · 선택에서 … 빼
    c.use(selNoun, c.find((t) => verbIn(t, ['delete', 'takeOut'])));
    mode = 'remove';
  } else if (selNoun >= 0 && (c.ts[selNoun].pre.includes('to') || c.ts[selNoun].post.includes('at')) && c.find((t) => verbIn(t, ['add'])) >= 0) {
    // add … to the selection · 선택에 … 추가
    c.use(selNoun, c.find((t) => verbIn(t, ['add'])));
    mode = 'add';
  } else if (c.find((t) => verbIn(t, ['select'])) >= 0) {
    // "…도 선택" / "select … too" adds
    mode = c.ts.some((t) => t.post.includes('also')) ? 'add' : 'set';
    c.use(c.find((t) => verbIn(t, ['select'])));
  }
  if (!mode) return null;
  const r = readTarget(c);
  if (r.err) return r.err;
  if (!c.done()) return null;
  // "선택 해제" / "deselect" with nothing named clears the selection.
  if (!r.target && mode === 'remove') return ok('select', [{ kind: 'deselect' }]);
  const target = r.target && !(isPlainIt(r.target) && ctx.inherit) ? r.target : ctx.inherit ?? IT;
  return ok('select', [{ kind: 'select', mode, target }], { target });
}

// ── §3.11 placed disasters, run control ──────────────────────────────────────────────────

const INSTANCE_VERBS = ['resume', 'pause', 'stop', 'delete', 'cancel', 'move'] as const;

function pInstance(c: Clause): Out | null {
  const verb = INSTANCE_VERBS.find((v) => c.find((t) => verbIn(t, [v])) >= 0);
  if (!verb) return null;
  // 지진 취소 / cancel the fire = taken out of the plan (§6 D15)
  const op = verb === 'cancel' ? 'delete' : verb;
  let ref: InstanceRef | null = null;
  const inst = c.find((t) => t.tok.t === 'id' && t.tok.kind === 'inst');
  const dis = c.all((t) => disOf(t));
  const noun = c.find((t) => hasW(t, 'disasterNoun'));
  if (inst >= 0) {
    ref = { i: 'id', id: (c.ts[inst].tok as Extract<Tok, { t: 'id' }>).id };
    c.use(inst, noun);
  } else if (dis.length) {
    const type = disOf(c.ts[dis[0]])!.type;
    if (dis.some((i) => disOf(c.ts[i])!.type !== type)) return null;
    c.use(...dis);
    // 화재 #3 · 3번 화재 · 세 번째 화재 · fire #3 · the third fire
    const nth = c.find((t, i) => (isNum(t, 'hash', 'ord') || hasW(t, 'first')) && (dis.includes(i - 1) || dis.includes(i + 1)));
    if (nth >= 0) {
      const t = c.ts[nth];
      const n = isNum(t) ? t.tok.v : 1;
      if (!Number.isInteger(n) || n < 1) return null;
      ref = { i: 'type', type, nth: n };
      c.use(nth);
    } else ref = { i: 'type', type };
  } else if (noun >= 0 && c.find((t) => hasW(t, 'all')) >= 0) {
    // 재난 전부 · all disasters ("전부 멈춰" without a disaster word pauses the simulation — §6 D17)
    ref = { i: 'all' };
    c.use(noun);
    c.takeAll((t) => hasW(t, 'all'));
  }
  if (!ref) return null;
  c.use(c.find((t) => verbIn(t, [verb])));
  if (op === 'move') {
    const to = places(c).find((h) => hasRole(h, 'to', 'at', 'upto') || h.compound);
    if (!to) return c.done() ? ask('place', `disaster ${refText(ref)} move to=?`) : null;
    const place = usePlace(c, to);
    return c.done() ? ok('instance', [{ kind: 'instance', ref, op, to: place }]) : null;
  }
  return c.done() ? ok('instance', [{ kind: 'instance', ref, op }]) : null;
}

const refText = (r: InstanceRef): string => (r.i === 'all' ? 'all' : r.i === 'id' ? r.id : r.nth ? `${r.type}#${r.nth}` : r.type);

function pSim(c: Clause): Out | null {
  // speed: 2배속 · 속도 2배 · speed 2× · 2 times speed · 2x · 절반 속도 · 정상 속도
  let speed: number | null = null;
  const sx = c.find((t) => isNum(t, 'speedx'));
  const noun = c.find((t) => hasW(t, 'speedNoun'));
  if (sx >= 0) { speed = (c.ts[sx] as NumCT).tok.v; c.use(sx, noun); }
  else if (c.take((t) => hasW(t, 'halfSpeed')) >= 0) speed = 0.5;
  else if (c.take((t) => hasW(t, 'normalSpeed')) >= 0) speed = 1;
  else if (noun >= 0) {
    const n = c.find((t) => isNum(t, 'x', null));
    const half = c.find((t) => hasW(t, 'half'));
    if (n >= 0) { speed = (c.ts[n] as NumCT).tok.v; c.use(n, noun); }
    else if (half >= 0) { speed = 0.5; c.use(half, noun); }
  } else if (c.n === 1 && isNum(c.ts[0], 'x') && /[x×]/.test(c.ts[0].tok.text)) { speed = (c.ts[0] as NumCT).tok.v; c.use(0); }
  if (speed !== null) return c.done() && speed > 0 ? ok('sim', [{ kind: 'speed', value: speed }]) : null;
  // 더 빠르게 · faster: a speed with no value
  if (c.find((t) => hasW(t, 'faster')) >= 0) {
    c.takeAll((t) => hasW(t, 'faster') || hasW(t, 'little') || hasW(t, 'speedNoun') || hasW(t, 'simNoun') || verbIn(t, ['make']) || hasW(t, 'det:it'));
    return c.done() ? ask('amount', 'speed=?') : null;
  }
  // Alone: 다시 시작 / restart = reset; 계속 / resume = run (§6 D16); 전부 멈춰 / stop everything = pause (§6 D17)
  for (const [verb, op] of [['reset', 'reset'], ['run', 'run'], ['resume', 'run'], ['pauseSim', 'pause']] as const) {
    const i = c.find((t) => verbIn(t, [verb]));
    if (i < 0) continue;
    c.use(i);
    c.takeAll((t) => hasW(t, 'simNoun') || (op === 'pause' && hasW(t, 'all')));
    if (c.done()) return ok('sim', [{ kind: 'sim', op }]);
    c.reset();
  }
  return null;
}

// ── §3.13 queries ────────────────────────────────────────────────────────────────────────

function queryAbout(c: Clause, ctx: Ctx, op: 'count' | 'list' | 'info', fallback: TargetRef): Out | null {
  const disaster = c.find((t) => hasW(t, 'disasterNoun'));
  if (disaster >= 0) {
    c.use(disaster);
    c.takeAll((t) => hasW(t, 'all'));
    return c.done() ? ok('query', [{ kind: 'query', op, topic: 'disasters' }]) : null;
  }
  const r = readTarget(c);
  if (r.err) return r.err;
  if (!r.target) {
    // 그룹 몇 개 / how many groups · 도로 목록 / list the roads
    const group = c.find((t) => hasW(t, 'groupNoun')), road = c.find((t) => isRoadWord(t));
    if (group >= 0) { c.use(group); return c.done() ? ok('query', [{ kind: 'query', op, topic: 'groups' }]) : null; }
    if (road >= 0) { c.use(road); return c.done() ? ok('query', [{ kind: 'query', op, topic: 'roads' }]) : null; }
  }
  if (!c.done()) return null;
  let target = r.target && !(isPlainIt(r.target) && ctx.inherit) ? r.target : ctx.inherit ?? fallback;
  // "… 몇 채야? 숨긴 것은?": a later query with filters and no kind is about the earlier clause's kind (§6 D31).
  if (r.target && !r.based && ctx.inherit) target = { ...r.target, base: ctx.inherit.base };
  return ok('query', [{ kind: 'query', op, target }], { target });
}

function pQuery(c: Clause, ctx: Ctx): Out | null {
  if (c.take((t) => hasW(t, 'howMany')) >= 0) return queryAbout(c, ctx, 'count', IT);
  // 피해 · 얼마나 무너졌어 · damage · collapse summary
  if (c.take((t) => hasW(t, 'damage')) >= 0) {
    c.takeAll((t) => hasW(t, 'info') || verbIn(t, ['tell']) || hasW(t, 'simNoun'));
    return c.done() ? ok('query', [{ kind: 'query', op: 'info', topic: 'sim' }]) : null;
  }
  // 거리 · how far (two places)
  if (c.take((t) => hasW(t, 'distance')) >= 0) {
    c.takeAll((t) => hasW(t, 'between') || hasW(t, 'det:it'));
    const ps = places(c);
    if (ps.length > 2) return null;
    if (ps.length < 2) { ps.forEach((h) => usePlace(c, h)); return c.done() ? ask('place', `measure ${ps.map((h) => formatPlace(h.place)).join(' ')} ?`.replace('  ', ' ')) : null; }
    const [a, b] = hasRole(ps[1], 'from') && !hasRole(ps[0], 'from') ? [ps[1], ps[0]] : ps;
    const from = usePlace(c, a), to = usePlace(c, b);
    return c.done() ? ok('query', [{ kind: 'query', op: 'measure', from, to }]) : null;
  }
  // 높이는 · 크기는 · 넓이는 · how tall · how big
  const size = c.find((t) => hasW(t, 'howBig') || ((hasW(t, 'height') || hasW(t, 'prop:scale')) && (t.post.includes('topic') || c.question)));
  if (size >= 0 && c.find((t) => isVerb(t) && !hasW(t, 'prop:scale') && !hasW(t, 'height')) < 0) {
    c.use(size);
    const r = targetOr(c, ctx);
    if (r.err) return r.err;
    return c.done() ? ok('query', [{ kind: 'query', op: 'measure', target: r.target }], { target: r.target }) : null;
  }
  // 정보 · 알려 줘 · 뭐야 · info · tell me about · what is
  if (c.find((t) => hasW(t, 'info') || verbIn(t, ['tell'])) >= 0) {
    c.takeAll((t) => hasW(t, 'info') || verbIn(t, ['tell']));
    return queryAbout(c, ctx, 'info', IT);
  }
  // 어떤 … · … 목록 · …은? · which … · list … · what … are there
  const last = c.ts[c.n - 1];
  const topical = !!last && last.post.includes('topic') && c.find((t) => isVerb(t)) < 0;
  if (c.find((t) => hasW(t, 'which') || hasW(t, 'listNoun')) >= 0 || topical) {
    c.takeAll((t) => hasW(t, 'which') || hasW(t, 'listNoun') || hasW(t, 'exist'));
    return queryAbout(c, ctx, 'list', IT);
  }
  return null;
}

// ── §3.12 camera ─────────────────────────────────────────────────────────────────────────

function pFocus(c: Clause, ctx: Ctx): Out | null {
  const v = c.find((t) => verbIn(t, ['show', 'look', 'go', 'travel']));
  if (v < 0) return null;
  const verb = verbIn(c.ts[v], ['show', 'look', 'go', 'travel'])!;
  // "숨긴 것 다시 보여 줘" / "show hidden" is unhide, not the camera.
  if (verb === 'show' && c.find((t) => wPre(t, 'flag:') || hasW(t, 'again')) >= 0) return null;
  c.use(v);
  if (verb === 'go' || verb === 'travel') {
    // n4로 가 · go to n4 · n4로 이동 (with an object named it is a move)
    const r = readTarget(c);
    if (r.err) return r.err;
    if (r.target) return verb === 'go' && c.done() ? ok('focus', [{ kind: 'focus', target: r.target }]) : null;
    const h = places(c)[0];
    if (!h) return null;
    const at = usePlace(c, h);
    return c.done() ? ok('focus', [{ kind: 'focus', at }]) : null;
  }
  const r = readTarget(c);
  if (r.err) return r.err;
  if (r.target && !isPlainIt(r.target)) return c.done() ? ok('focus', [{ kind: 'focus', target: r.target }]) : null;
  const h = places(c)[0];
  if (h) { const at = usePlace(c, h); return c.done() ? ok('focus', [{ kind: 'focus', at }]) : null; }
  return c.done() ? ok('focus', [{ kind: 'focus', target: ctx.inherit ?? IT }]) : null;
}

// ── §3.7 hide · lock · delete · duplicate · group · name ─────────────────────────────────

function pFlag(c: Clause, ctx: Ctx): Out | null {
  let op: 'hide' | 'show' | 'lock' | 'unlock' | null = null;
  const lockNoun = c.find((t) => verbIn(t, ['lock']));
  if (c.take((t) => verbIn(t, ['unlock'])) >= 0) op = 'unlock';
  else if (lockNoun >= 0 && c.find((t) => verbIn(t, ['release'])) >= 0) { c.use(lockNoun, c.find((t) => verbIn(t, ['release']))); op = 'unlock'; }
  else if (lockNoun >= 0) { c.use(lockNoun); op = 'lock'; }
  else if (c.take((t) => verbIn(t, ['hide'])) >= 0) op = 'hide';
  else if (c.find((t) => verbIn(t, ['unhide'])) >= 0) { c.takeAll((t) => verbIn(t, ['unhide', 'show'])); op = 'show'; }
  else if (c.find((t) => verbIn(t, ['show'])) >= 0 && c.find((t) => wPre(t, 'flag:') || hasW(t, 'again')) >= 0) { c.use(c.find((t) => verbIn(t, ['show']))); op = 'show'; }
  else if (c.find((t) => hasW(t, 'flag:visible')) >= 0 && c.find((t) => hasW(t, 'again')) >= 0 && c.find((t) => verbIn(t, ['make'])) >= 0) {
    // make … visible again
    c.use(c.find((t) => verbIn(t, ['make'])), c.find((t) => hasW(t, 'flag:visible')));
    op = 'show';
  }
  if (!op) return null;
  if (op === 'show') c.takeAll((t) => hasW(t, 'again'));
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  return c.done() ? ok('flag', [{ kind: 'flag', op, target: r.target }], { target: r.target }) : null;
}

function pDelete(c: Clause, ctx: Ctx): Out | null {
  if (c.take((t) => verbIn(t, ['delete'])) < 0) return null;
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  return c.done() ? ok('delete', [{ kind: 'delete', target: r.target }], { target: r.target }) : null;
}

/** A compass direction and a distance next to each other (동쪽으로 10 m · 10 m east) → the two token indices. */
function dirDistance(c: Clause, wantCompass: boolean): { dir: number; dist: number } | null {
  for (let i = 0; i < c.n; i++) {
    const t = c.free(i);
    if (!t || !(wantCompass ? compassOf(t) : wPre(t, 'dir:') || wPre(t, 'diag:'))) continue;
    if (isNum(c.free(i + 1), 'm')) return { dir: i, dist: i + 1 };
    if (isNum(c.free(i - 1), 'm')) return { dir: i, dist: i - 1 };
  }
  return null;
}

function pDuplicate(c: Clause, ctx: Ctx): Out | null {
  const v = c.find((t) => verbIn(t, ['duplicate']));
  if (v < 0 || c.find((t) => wPre(t, 'prop:') && !isVerb(t)) >= 0) return null;
  c.use(v);
  let offset: [number, number] | undefined;
  const dd = dirDistance(c, true);
  const anyDir = c.find((t) => wPre(t, 'dir:') || wPre(t, 'diag:'));
  const dist = c.find((t) => isNum(t, 'm'));
  if (dd) {
    const d = (c.ts[dd.dist] as NumCT).tok.v;
    const dir = compassOf(c.ts[dd.dir])!;
    offset = dir === 'east' ? [d, 0] : dir === 'west' ? [-d, 0] : dir === 'south' ? [0, d] : [0, -d];
    c.use(dd.dir, dd.dist);
  } else if (anyDir >= 0 && !compassOf(c.ts[anyDir])) return bad('cmd37.nl.unknown.direction');
  // 복사해서 동쪽에 10 m 놓아 (§6 D27): the placing verb belongs to the copy
  c.takeAll((t) => hasW(t, 'apartBy') || verbIn(t, ['place', 'move']));
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!dd && (anyDir >= 0 || dist >= 0 || c.find((t) => isNum(t, null)) >= 0)) {
    // a direction without a distance (or a number without a unit — §6 D24) / a distance without a direction
    c.use(anyDir, dist);
    c.takeAll((t) => isNum(t, null));
    return c.done() ? ask(anyDir >= 0 ? 'amount' : 'direction', `duplicate ${formatTarget(r.target)} offset=?`) : null;
  }
  if (!c.done()) return null;
  const intent: IntentOf<'duplicate'> = offset ? { kind: 'duplicate', target: r.target, offset } : { kind: 'duplicate', target: r.target };
  return ok('duplicate', [intent], { target: r.target, makes: true });
}

/** The quoted text that is a NAME being given (…이라고 · …(으)로 · as "…" · called "…"), not a reference to something. */
function givenName(c: Clause, anyQuote: boolean): number {
  const marked = c.find((t, i) => t.tok.t === 'q' && (hasRole(t, 'called', 'to', 'as') || hasW(c.free(i - 1), 'called') || hasW(c.free(i - 1), 'nameNoun')));
  return marked >= 0 || !anyQuote ? marked : c.find((t) => t.tok.t === 'q');
}

function pGroup(c: Clause, ctx: Ctx): Out | null {
  const noun = c.find((t) => hasW(t, 'groupNoun') && !verbIn(t, ['group']));
  const quoteNext = noun >= 0 && (c.free(noun + 1)?.tok.t === 'q' || c.free(noun - 1)?.tok.t === 'q');
  // 그룹 풀어 · 그룹 해제 · ungroup
  if (c.find((t) => verbIn(t, ['ungroup'])) >= 0 || (noun >= 0 && c.find((t) => verbIn(t, ['release'])) >= 0)) {
    c.takeAll((t) => verbIn(t, ['ungroup', 'release']));
    if (!quoteNext) c.use(noun);
    const r = targetOr(c, ctx);
    if (r.err) return r.err;
    return c.done() ? ok('ungroup', [{ kind: 'ungroup', target: r.target }], { target: r.target }) : null;
  }
  // 묶어 · 그룹으로 (묶어) · 그룹 만들어 · group (them)
  const verb = c.find((t) => verbIn(t, ['group']));
  const made = noun >= 0 && !quoteNext && (c.find((t) => verbIn(t, ['create'])) >= 0 || c.ts[noun].post.includes('to'));
  if (verb < 0 && !made) return null;
  c.use(verb);
  if (noun >= 0 && !quoteNext) c.use(noun);
  c.takeAll((t) => verbIn(t, ['create']));
  const q = givenName(c, false);
  let name: string | undefined;
  if (q >= 0) {
    name = (c.ts[q].tok as Extract<Tok, { t: 'q' }>).text;
    c.use(q);
    c.takeAll((t) => hasW(t, 'called') || hasW(t, 'nameNoun') || verbIn(t, ['call', 'change']));
  }
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (name !== undefined && !name) return ask('name', `group ${formatTarget(r.target)} name=?`);
  const intent: IntentOf<'group'> = name ? { kind: 'group', target: r.target, name } : { kind: 'group', target: r.target };
  return ok('group', [intent], { target: r.target });
}

function pRename(c: Clause, ctx: Ctx): Out | null {
  const verb = c.find((t) => verbIn(t, ['rename', 'call']));
  const noun = c.find((t) => hasW(t, 'nameNoun') && !verbIn(t, ['rename']));
  const called = c.find((t) => t.tok.t === 'q' && t.post.includes('called'));
  if (verb < 0 && noun < 0 && called < 0) return null;
  c.takeAll((t) => verbIn(t, ['rename', 'call', 'change']) || hasW(t, 'nameNoun') || hasW(t, 'called'));
  const q = givenName(c, c.all((t) => t.tok.t === 'q').length === 1);
  const name = q >= 0 ? (c.ts[q].tok as Extract<Tok, { t: 'q' }>).text : '';
  c.use(q);
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (!name) return ask('name', `rename ${formatTarget(r.target)} "?"`);
  return ok('rename', [{ kind: 'rename', target: r.target, name }], { target: r.target, said: r.said });
}

// ── §3.5 / §3.6 copy · match · align · distribute ────────────────────────────────────────

const COPY_PROPS = ['structure', 'scale', 'heading', 'params', 'physics'] as const;
type CopyProp = (typeof COPY_PROPS)[number];

/** A reference object: the first one / the first building → (selection first 1) · the largest building · #id · "name". */
function refFrom(c: Clause, idx: number[]): TargetRef | null {
  const ts = idx.map((i) => c.ts[i]);
  const kind = ts.map((t) => kindOf(t)).find(Boolean);
  const rank = ts.map((t) => wPre(t, 'rank:')).find(Boolean) as 'largest' | 'tallest' | 'nearest' | undefined;
  if (ts.some((t) => hasW(t, 'first'))) return { base: { b: 'selection' }, first: 1 };
  if (rank) return kind ? { base: typeBase(kind.key), rank: rank === 'nearest' ? { by: 'nearest', at: { p: 'cursor' } } : { by: rank } } : null;
  const id = ts.find((t) => t.tok.t === 'id' && t.tok.kind === 'obj');
  if (id) return { base: { b: 'id', id: (id.tok as Extract<Tok, { t: 'id' }>).id } };
  const q = ts.find((t) => t.tok.t === 'q' && t.tok.text);
  if (q) return { base: { b: 'name', name: (q.tok as Extract<Tok, { t: 'q' }>).text } };
  if (ts.some((t) => hasW(t, 'det:selection'))) return { base: { b: 'selection' } };
  if (ts.some((t) => hasW(t, 'det:last'))) return { base: { b: 'last' } };
  if (kind) return { base: typeBase(kind.key) };
  return null;
}

/** Words of a described reference (첫 번째 건물 · the largest building) — and the ones that are a reference alone (#id, "name", the selection). */
const isRefPart = (t: CT | undefined): boolean => !!t && (hasW(t, 'first') || !!wPre(t, 'rank:') || !!kindOf(t) || hasW(t, 'plural') || hasW(t, 'thing'));
const isRefAlone = (t: CT | undefined): boolean => !!t && ((t.tok.t === 'id' && t.tok.kind === 'obj') || t.tok.t === 'q' || hasW(t, 'det:selection') || hasW(t, 'det:last'));
const isRefWord = (t: CT | undefined): boolean => isRefPart(t) || isRefAlone(t);

/**
 * The reference phrase marked by one of `post` (Korean: …이랑 / …처럼 / …에 / …의) or `pre` (English: as … / of … /
 * like …): #id, "name", the selection — or a described one: [first | largest …] [kind | 것] (가장 큰 건물과, as the first one).
 */
function refSpan(c: Clause, post: string[], pre: string[]): number[] | null {
  const head = (t: CT | undefined): boolean => !!t && (!!kindOf(t) || hasW(t, 'thing'));
  const lead = (t: CT | undefined): boolean => !!t && (hasW(t, 'first') || !!wPre(t, 'rank:'));
  for (let i = 0; i < c.n; i++) {
    const t = c.free(i);
    if (!t || !isRefWord(t)) continue;
    if (post.some((r) => t.post.includes(r))) {
      const idx = [i];
      if (isRefAlone(t)) return idx;
      let k = i - 1;
      if (hasW(t, 'plural') && head(c.free(k))) idx.unshift(k--);
      if (!lead(t) && lead(c.free(k)) && c.ts[k].post.length === 0) idx.unshift(k);
      return idx;
    }
    if (pre.some((r) => t.pre.includes(r))) {
      const idx = [i];
      if (isRefAlone(t)) return idx;
      let k = i + 1;
      if (lead(t) && head(c.free(k)) && c.ts[k].pre.length === 0) idx.push(k++);
      if (hasW(c.free(k), 'plural')) idx.push(k);
      return idx;
    }
  }
  return null;
}

const COPY_ONLY: readonly CopyProp[] = ['structure', 'params', 'physics'];

/**
 * "Like that one" (§3.5 match, §3.6 copy; §6 D9, D10). COPY: the verb 복사 / copy, a list of properties, or structure /
 * params / physics. MATCH: one of heading / scale / height (with a reference → `to=`). No reference for a copy → ask
 * `target`; a reference and no property → ask `field`.
 */
function pCopyMatch(c: Clause, ctx: Ctx): Out | null {
  const same = c.find((t) => hasW(t, 'same'));
  const sameWay = c.find((t) => hasW(t, 'sameWay'));
  const copyVerb = c.find((t) => verbIn(t, ['duplicate']));
  const give = c.find((t) => verbIn(t, ['give']));
  const propIdx = c.all((t) => COPY_PROPS.includes(wPre(t, 'prop:') as CopyProp));
  const props = [...new Set(propIdx.map((i) => wPre(c.ts[i], 'prop:') as CopyProp))];
  const height = c.find((t) => hasW(t, 'height'));
  if (same < 0 && sameWay < 0 && !((copyVerb >= 0 || give >= 0) && props.length)) return null;
  const span = refSpan(c, copyVerb >= 0 ? ['and', 'like', 'at', 'gen'] : ['and', 'like', 'at'], ['as', 'of', 'from', 'like']);
  const from = span ? refFrom(c, span) : null;
  if (span && !from) return null;
  c.use(same, sameWay, copyVerb, give, ...propIdx, ...(span ?? []));
  c.takeAll((t) => verbIn(t, ['align', 'make']));
  const copy = copyVerb >= 0 || props.length >= 2 || props.some((p) => COPY_ONLY.includes(p));
  if (copy) {
    if (height >= 0 || sameWay >= 0) return null;
    const r = targetOr(c, ctx, SELECTION);
    if (r.err) return r.err;
    if (!c.done()) return null;
    if (!from) return ask('target', `copy ${props.join(',')} from=? to=${formatTarget(r.target)}`);
    return ok('copy', [{ kind: 'copy', props, from, target: r.target }], { target: r.target });
  }
  const what: 'heading' | 'height' | 'scale' | null = sameWay >= 0 ? 'heading' : height >= 0 && !props.length ? 'height' : props[0] === 'scale' || props[0] === 'heading' ? props[0] : null;
  if (height >= 0 && what === 'height') c.use(height);
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (!what) return from ? ask('field', `copy ? from=${formatTarget(from)} to=${formatTarget(r.target)}`) : null;
  const intent: IntentOf<'match'> = from ? { kind: 'match', target: r.target, what, to: from } : { kind: 'match', target: r.target, what };
  return ok('match', [intent], { target: r.target });
}

function pAlign(c: Clause, ctx: Ctx): Out | null {
  // "centre them horizontally / vertically": the centres on x / z
  const centre = c.find((t) => verbIn(t, ['centre']));
  const across = c.find((t) => wPre(t, 'daxis:'));
  if (centre >= 0 && across >= 0 && c.find((t) => verbIn(t, ['align'])) < 0) {
    c.use(centre, across);
    const r = targetOr(c, ctx);
    if (r.err) return r.err;
    return c.done() ? ok('align', [{ kind: 'align', target: r.target, axis: wPre(c.ts[across], 'daxis:') as 'x' | 'z', mode: 'center', ref: 'origin' }], { target: r.target }) : null;
  }
  if (c.take((t) => verbIn(t, ['align'])) < 0) return null;
  type Edge = { axis: 'x' | 'z'; mode: 'min' | 'center' | 'max' } | { edge: 'front' | 'back' };
  const edgeOf = (t: CT): Edge | null => {
    if (hasW(t, 'front')) return { edge: 'front' };
    if (hasW(t, 'backEdge')) return { edge: 'back' };
    if (hasW(t, 'centerH')) return { axis: 'x', mode: 'center' };
    if (hasW(t, 'centerV')) return { axis: 'z', mode: 'center' };
    const d = wPre(t, 'dir:');
    if (d === 'west' || d === 'left') return { axis: 'x', mode: 'min' };
    if (d === 'east' || d === 'right') return { axis: 'x', mode: 'max' };
    if (d === 'north' || hasW(t, 'top')) return { axis: 'z', mode: 'min' };
    if (d === 'south' || hasW(t, 'bottom')) return { axis: 'z', mode: 'max' };
    return null;
  };
  const edges = c.all((t) => edgeOf(t));
  if (edges.length > 1) return null;
  const edge = edges.length ? edgeOf(c.ts[edges[0]]) : null;
  c.use(...edges);
  c.takeAll((t) => hasW(t, 'side'));
  const refI = c.find((t) => wPre(t, 'ref:'));
  const ref = refI >= 0 ? (wPre(c.ts[refI], 'ref:') as 'origin' | 'footprint') : 'origin';
  c.use(refI);
  c.takeAll((t) => hasW(t, 'basis') || (refI < 0 && hasW(t, 'byOrigins')));
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (!edge) return ask('axis', `align ${formatTarget(r.target)} axis=? mode=? ref=${ref}`);
  return ok('align', [{ kind: 'align', target: r.target, ...edge, ref }], { target: r.target });
}

function pDistribute(c: Clause, ctx: Ctx): Out | null {
  const trigger = c.find((t) => hasW(t, 'evenly') || verbIn(t, ['distribute']) || wPre(t, 'daxis:') || hasW(t, 'byOrigins'));
  if (trigger < 0) return null;
  // "고르게" about the ground is flatten (§3.9).
  if (c.find((t) => hasW(t, 'ground') || hasW(t, 'radius') || hasW(t, 'circle') || wPre(t, 'feature:')) >= 0) return null;
  // A specific gap is not distribute — it is said when placing.
  const gap = c.find((t) => hasW(t, 'gap'));
  if (gap >= 0 && (isNum(c.free(gap + 1), 'm') || isNum(c.free(gap - 1), 'm'))) return bad('cmd37.nl.unknown.specificGap');
  const axisI = c.find((t) => wPre(t, 'daxis:'));
  const axis = axisI >= 0 ? (wPre(c.ts[axisI], 'daxis:') as 'x' | 'z') : 'auto';
  const gaps = c.find((t) => hasW(t, 'byOrigins')) < 0;
  c.takeAll((t) => hasW(t, 'evenly') || verbIn(t, ['distribute', 'align']) || wPre(t, 'daxis:') || hasW(t, 'byOrigins') || hasW(t, 'gap'));
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  return c.done() ? ok('distribute', [{ kind: 'distribute', target: r.target, axis, gaps }], { target: r.target }) : null;
}

// ── §3.9 terrain · paint, §3.2 forest, §3.8 roads ────────────────────────────────────────

const isGroundish = (c: Clause): boolean =>
  c.find((t) => hasW(t, 'ground') || hasW(t, 'radius') || hasW(t, 'circle') || hasW(t, 'diameter') || hasW(t, 'rect') || hasW(t, 'around') || wPre(t, 'feature:') || t.tok.t === 'xz' || !!wPre(t, 'place:') || isNode(t)) >= 0;
const namesObject = (c: Clause): boolean =>
  c.find((t) => !!kindOf(t) || (hasW(t, 'det:selection') || hasW(t, 'det:last') || hasW(t, 'det:it') || hasW(t, 'det:this')) || (t.tok.t === 'id' && t.tok.kind === 'obj') || t.tok.t === 'q') >= 0;

function pTerrain(c: Clause, ctx: Ctx): Out | null {
  if (c.find((t) => disOf(t)) >= 0) return null;
  let op: 'raise' | 'lower' | 'flatten' | 'smooth' | null = null;
  const around = c.find((t) => hasW(t, 'around')) >= 0;
  if (c.find((t) => verbIn(t, ['flatten']) || hasW(t, 'flat')) >= 0) op = 'flatten';
  else if (c.find((t) => verbIn(t, ['smooth']) || hasW(t, 'smoothly')) >= 0) op = 'smooth';
  else if (c.find((t) => verbIn(t, ['raise', 'lower'])) >= 0 && isGroundish(c) && (!namesObject(c) || around)) op = c.find((t) => verbIn(t, ['raise'])) >= 0 ? 'raise' : 'lower';
  if (!op) return null;
  c.takeAll((t) => verbIn(t, ['flatten', 'smooth', 'raise', 'lower']) || hasW(t, 'flat') || hasW(t, 'smoothly') || hasW(t, 'ground') || (!!ctx.area && op !== 'raise' && op !== 'lower' && hasW(t, 'det:it')));
  // flatten to 3 m · 높이 3 m로 평탄화
  let to: number | undefined;
  if (op === 'flatten') {
    const h = c.find((t) => hasW(t, 'height'));
    const n = h >= 0 && isNum(c.free(h + 1), 'm') ? h + 1 : c.find((t) => isNum(t, 'm') && hasRole(t, 'to'));
    if (n >= 0) { to = (c.ts[n] as NumCT).tok.v; c.use(n, h); }
  } else if ((op === 'raise' || op === 'lower') && c.find((t) => isNum(t, 'm') && hasRole(t, 'to')) >= 0) return bad('cmd37.nl.unknown.raiseTo');
  const a = readArea(c);
  if (a && 'err' in a) return a.err;
  // raise by 2 m · 2 m 올려
  let by: number | undefined;
  if (op === 'raise' || op === 'lower') {
    c.takeAll((t) => hasW(t, 'height'));
    const n = c.find((t) => isNum(t, 'm'));
    if (n >= 0) { by = (c.ts[n] as NumCT).tok.v; c.use(n); }
    else if (c.takeAll((t) => isNum(t, null)) > 0) return c.done() ? ask('amount', `terrain ${op} by=?`) : null;
  }
  if (!c.done()) return null;
  const area = a && 'area' in a ? a.area : !a ? ctx.area : undefined;
  if (!area) return ask(a && 'ask' in a ? a.ask : 'place', `terrain ${op} ?`);
  if (by !== undefined && !(by > 0)) return ask('amount', `terrain ${op} by=?`);
  const intent: IntentOf<'terrain'> = { kind: 'terrain', op, area };
  if (by !== undefined) intent.by = by;
  if (to !== undefined) intent.to = to;
  return ok('terrain', [intent], { area });
}

function pPaint(c: Clause, ctx: Ctx): Out | null {
  const verb = c.find((t) => verbIn(t, ['paint']));
  const names = c.all((t) => wPre(t, 'ground:'));
  const floor = c.find((t) => hasW(t, 'ground'));
  if (verb < 0 && !(names.length && floor >= 0)) return null;
  if (names.length > 1) return null;
  c.use(verb, floor, ...names);
  c.takeAll((t) => verbIn(t, ['change']) || hasW(t, 'ground') || (!!ctx.area && hasW(t, 'det:it')));
  const a = readArea(c);
  if (a && 'err' in a) return a.err;
  if (!c.done()) return null;
  const area = a && 'area' in a ? a.area : !a ? ctx.area : undefined;
  if (!area) return ask(a && 'ask' in a ? a.ask : 'place', 'paint ? ground=?');
  if (!names.length) return ask('field', 'paint … ground=?');
  return ok('paint', [{ kind: 'paint', area, ground: wPre(c.ts[names[0]], 'ground:')! }], { area });
}

function pForest(c: Clause, ctx: Ctx): Out | null {
  const word = c.find((t) => hasW(t, 'forest'));
  const tree = c.find((t) => kindOf(t)?.key === 'tree');
  const counted = c.find((t, i) => isNum(t, 'count') || (isNum(t, null) && !hasW(c.free(i - 1), 'density') && !hasW(c.free(i - 1), 'seed'))) >= 0;
  const planting = word < 0 && tree >= 0 && c.find((t) => verbIn(t, ['plant'])) >= 0 && !counted
    && c.find((t) => hasW(t, 'radius') || hasW(t, 'circle') || hasW(t, 'rect') || hasW(t, 'around') || hasW(t, 'density') || wPre(t, 'dens:') || wPre(t, 'feature:')) >= 0;
  if (word < 0 && !planting) return null;
  if (word >= 0 && c.find((t) => !!kindOf(t) && kindOf(t)!.key !== 'tree') >= 0) return null;
  c.use(word);
  c.takeAll((t) => verbIn(t, ['create', 'plant', 'place', 'add', 'make']) || kindOf(t)?.key === 'tree' || hasW(t, 'plural'));
  // density: 밀도 낮게 · sparse · density 0.4
  let density: string | number | undefined;
  const label = c.find((t) => hasW(t, 'density'));
  const level = c.find((t) => wPre(t, 'dens:'));
  if (label >= 0 && isNum(c.free(label + 1), null)) { density = (c.ts[label + 1] as NumCT).tok.v; c.use(label, label + 1); }
  else if (level >= 0) { density = wPre(c.ts[level], 'dens:')!; c.use(level, label); }
  let seed: number | undefined;
  const s = c.find((t) => hasW(t, 'seed'));
  if (s >= 0 && isNum(c.free(s + 1), null)) { seed = (c.ts[s + 1] as NumCT).tok.v; c.use(s, s + 1); }
  const a = readArea(c);
  if (a && 'err' in a) return a.err;
  if (!c.done()) return null;
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) return ask('amount', 'forest … seed=?');
  const area = a && 'area' in a ? a.area : !a ? ctx.area : undefined;
  if (!area) return ask(a && 'ask' in a ? a.ask : 'place', 'forest ?');
  const intent: IntentOf<'forest'> = { kind: 'forest', area };
  if (density !== undefined) intent.density = density;
  if (seed !== undefined) intent.seed = seed;
  return ok('forest', [intent], { area, makes: true });
}

function pRoad(c: Clause): Out | null {
  const word = c.find((t) => isRoadWord(t));
  const presetI = c.find((t) => wPre(t, 'preset:'));
  const preset = presetI >= 0 ? wPre(c.ts[presetI], 'preset:')! : undefined;
  // 골목길 / an alley / a gravel road / 흙길 name a road by themselves.
  const roadByPreset = preset === 'lane' || preset === 'gravel' || preset === 'dirt';
  if ((word < 0 && !roadByPreset) || c.find((t) => !!kindOf(t) || t.tok.t === 'btw' || !!disOf(t)) >= 0) return null;
  c.use(word);
  c.use(presetI);
  const making = c.takeAll((t) => verbIn(t, ['draw', 'create', 'place'])) > 0;
  const ps = places(c);
  // 도로 만들어: a road to draw and no end at all (§6 D22)
  if (!ps.length) return making && c.done() ? ask('place', 'road ? -> ?') : null;
  if (ps.length > 2) return null;
  // One end only: it must be marked as an end (…에서 / …까지 / from … / to …), else this is not about drawing a road.
  if (ps.length === 1) {
    if (!hasRole(ps[0], 'from', 'upto', 'to')) return null;
    usePlace(c, ps[0]);
    return c.done() ? ask('place', hasRole(ps[0], 'from') ? `road ${formatPlace(ps[0].place)} -> ?` : `road ? -> ${formatPlace(ps[0].place)}`) : null;
  }
  if (!hasRole(ps[0], 'from') && !hasRole(ps[1], 'upto', 'to') && !hasRole(ps[1], 'from')) return null;
  const [a, b] = hasRole(ps[1], 'from') && !hasRole(ps[0], 'from') ? [ps[1], ps[0]] : ps;
  const from = usePlace(c, a), to = usePlace(c, b);
  if (!c.done()) return null;
  const intent: IntentOf<'road'> = preset ? { kind: 'road', from, to, preset } : { kind: 'road', from, to };
  return ok('road', [intent], { makes: true });
}

// ── §3.10 disasters ──────────────────────────────────────────────────────────────────────

const RUN_VERBS = ['trigger'];
const PLACE_VERBS = ['place', 'add', 'create'];
const OPPOSITE: Record<string, string> = { N: 'S', NE: 'SW', E: 'W', SE: 'NW', S: 'N', SW: 'NE', W: 'E', NW: 'SE' };
const LETTER: Record<string, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };
const compassLetter = (t: CT | undefined): string | null => {
  const d = wPre(t, 'dir:');
  if (d && LETTER[d]) return LETTER[d];
  const g = wPre(t, 'diag:');
  return g && g !== 'any' ? g : null;
};

function pDisaster(c: Clause): Out | null {
  const dis = c.all((t) => disOf(t));
  if (!dis.length) return null;
  const first = disOf(c.ts[dis[0]])!;
  const type = first.type;
  if (dis.some((i) => disOf(c.ts[i])!.type !== type)) return null;
  // "화재 #3" / "the third fire" names a placed disaster (§3.11) — not a new one with a number to ask about.
  if (c.find((t) => isNum(t, 'hash', 'ord')) >= 0) return null;
  const fields: Record<string, number | string> = {};
  for (const i of dis) Object.assign(fields, disOf(c.ts[i])!.fields ?? {});
  c.use(...dis);
  const text = (): string => ['disaster', type, ...Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`)].join(' ');

  // Run verbs → `now`; placing verbs / no verb → only placed. 내려 (비) and 올려 (수위) run their own disaster.
  let now = false;
  if (c.takeAll((t) => verbIn(t, RUN_VERBS)) > 0) now = true;
  else if (type === 'rain' && c.take((t) => verbIn(t, ['lower'])) >= 0) now = true;
  else if (type === 'risingWater' && c.take((t) => verbIn(t, ['raise'])) >= 0) now = true;
  else if (type === 'waterSource' && c.take((t) => verbIn(t, ['supply'])) >= 0) now = true;
  else c.takeAll((t) => verbIn(t, PLACE_VERBS));

  // Start time: 5초 뒤 · 5초 후에 · in 5 s · after 5 s · 5 s later · at 12 s
  let start: number | undefined;
  for (let i = 0; i < c.n && start === undefined; i++) {
    const t = c.free(i);
    if (!isNum(t, 's')) continue;
    const after = hasW(c.free(i + 1), 'after') ? i + 1 : hasW(c.free(i - 1), 'after') ? i - 1 : -1;
    if (after >= 0 || t.pre.includes('at') || t.post.includes('at')) { start = t.tok.v; c.use(i, after); }
  }
  // Duration: 30분 동안 · for 30 minutes
  if (DURATION_TYPES.includes(type)) {
    const i = c.find((t, k) => isNum(t, 's') && (hasW(c.free(k + 1), 'during') || t.pre.includes('for')));
    if (i >= 0) { fields.duration = (c.ts[i] as NumCT).tok.v; c.use(i); if (hasW(c.free(i + 1), 'during')) c.use(i + 1); }
  }
  // Wind direction (where it blows FROM): 동풍 · 동쪽에서 · from the east · easterly; "동쪽으로" / "toward the east" = from the west
  if (type === 'wind') {
    const named = c.ts.findIndex((t, k) => !!wPre(t, 'wind:') && (!t.used || dis.includes(k)));
    const from = c.find((t) => !!compassLetter(t) && hasRole(t, 'from'));
    const toward = c.find((t, k) => !!compassLetter(t) && (t.post.includes('to') || hasW(c.free(k - 1), 'toward')));
    if (named >= 0) { fields.direction = wPre(c.ts[named], 'wind:')!; c.use(named); }
    else if (from >= 0) { fields.direction = compassLetter(c.ts[from])!; c.use(from); }
    else if (toward >= 0) { fields.direction = OPPOSITE[compassLetter(c.ts[toward])!]; c.use(toward); if (hasW(c.free(toward - 1), 'toward')) c.use(toward - 1); }
  }
  // Rising water: 서쪽 경계 · the western boundary · from the west
  if (type === 'risingWater') {
    const side = c.find((t, k) => !!compassOf(t) && (hasW(c.free(k + 1), 'boundary') || hasRole(t, 'from')));
    if (side >= 0) { fields.boundary = LETTER[compassOf(c.ts[side])!]; c.use(side); if (hasW(c.free(side + 1), 'boundary')) c.use(side + 1); }
  }
  // Field phrases: a number with a unit of the type, next to its label when it has one.
  for (const rule of DISASTER_FIELDS[type] ?? []) {
    if (fields[rule.key] !== undefined) continue;
    for (let i = 0; i < c.n; i++) {
      const t = c.free(i);
      if (!isNum(t, ...rule.units)) continue;
      let label = -1;
      if (rule.label === '@type') {
        if (!(dis.includes(i - 1) || dis.includes(i + 1) || t.pre.includes('by'))) continue;
      } else if (rule.label) {
        const isLabel = (k: number) => !!c.ts[k] && hasW(c.ts[k], rule.label!) && (!c.ts[k].used || dis.includes(k));
        label = isLabel(i - 1) ? i - 1 : !rule.before && isLabel(i + 1) ? i + 1 : -1;
        if (label < 0) continue;
      }
      fields[rule.key] = t.tok.v * (rule.scale ?? 1);
      c.use(i, label);
      break;
    }
  }
  // Position
  const here = places(c)[0];
  const at = here && (hasRole(here, 'at', 'from') || here.pre.length + here.post.length === 0 || here.compound) ? usePlace(c, here) : undefined;
  // A number that is no field of this type → ask which field.
  const loose = c.all((t) => isNum(t));
  if (loose.length) {
    c.use(...loose);
    return c.done() ? ask('field', `${text()} ?=${loose.map((i) => c.ts[i].tok.text).join(' ')}`) : null;
  }
  if (!c.done()) return null;
  // A run-now sentence of a legacy type always writes every basic field (§6 D1): said values, else the definition's defaults.
  const intent: IntentOf<'disaster'> = { kind: 'disaster', type, fields: now && LEGACY_TYPES.includes(type) ? legacyForm(type, fields) : fields };
  if (at) intent.at = at;
  if (start !== undefined) intent.start = start;
  if (now) intent.now = true;
  return ok('disaster', [intent]);
}

// ── §3.4 transform ───────────────────────────────────────────────────────────────────────

function pSet(c: Clause, ctx: Ctx): Out | null {
  const fields: Partial<Record<'x' | 'y' | 'z' | 'heading' | 'scale' | 'lift', number>> = {};
  let missing = false;
  const setVerb = c.find((t) => verbIn(t, ['set'])) >= 0;
  /** The value of the field named at `i`: the number right after it, else the one marked "to" / "(으)로" later on. */
  const valueOf = (i: number, units: (UnitId | null)[], needsTo: boolean): number | null => {
    const next = c.free(i + 1);
    const n = isNum(next, ...units) && (!needsTo || hasRole(next, 'to', 'eq') || setVerb) ? i + 1 : c.find((t, k) => k > i && isNum(t, ...units) && hasRole(t, 'to'));
    if (n < 0) return null;
    c.use(i, n);
    return (c.ts[n] as NumCT).tok.v;
  };
  for (const axis of ['x', 'y', 'z'] as const) {
    const i = c.find((t) => hasW(t, `axis:${axis}`));
    if (i < 0) continue;
    const v = valueOf(i, [null, 'm'], false);
    if (v === null) { c.use(i); missing = true; } else fields[axis] = v;
  }
  // 방향을 90도로 · set the heading to 90° ("방향 90도" beside a kind to place is the placing heading, §3.1)
  const h = c.find((t) => hasW(t, 'heading') || hasW(t, 'prop:heading'));
  if (h >= 0) { const v = valueOf(h, ['deg', null], true); if (v !== null) fields.heading = v; }
  // 크기를 1.5로 · scale 1.5 · set the scale to 1.5
  const s = c.find((t) => hasW(t, 'prop:scale'));
  if (s >= 0) { const v = valueOf(s, [null], false); if (v !== null) fields.scale = v; }
  // 지면 위 2 m로 · 지면에서 2 m 띄워 · 2 m above the ground · 지면에 붙여 / drop … to the ground
  const above = c.find((t) => hasW(t, 'aboveGround'));
  if (above >= 0) {
    const n = isNum(c.free(above + 1), 'm') ? above + 1 : isNum(c.free(above - 1), 'm') ? above - 1 : -1;
    c.use(above);
    if (n >= 0) { fields.lift = (c.ts[n] as NumCT).tok.v; c.use(n); } else missing = true;
    c.takeAll((t) => hasW(t, 'lifted') || hasW(t, 'spaced'));
  } else if (c.take((t) => hasW(t, 'onGround')) >= 0) fields.lift = 0;
  const any = Object.keys(fields).length > 0;
  if (!any && !missing && !setVerb) return null;
  c.takeAll((t) => verbIn(t, ['set', 'change', 'align', 'move']) || (fields.lift !== undefined && verbIn(t, ['place', 'lower'])));
  // 선택한 것 10으로 설정해: a value and no field
  if (!any && !missing) c.takeAll((t) => isNum(t, null, 'm', 'deg'));
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (missing) return ask('amount', `set ${formatTarget(r.target)} ${Object.keys(fields).map((k) => `${k}=…`).join(' ')} ?`.replace('  ', ' '));
  if (!any) return ask('field', `set ${formatTarget(r.target)} ?`);
  if (fields.y !== undefined && fields.lift !== undefined) return bad('cmd37.nl.unknown.sentence');
  if (fields.scale !== undefined && !(fields.scale > 0)) return ask('amount', `set ${formatTarget(r.target)} scale=?`);
  return ok('set', [{ kind: 'set', target: r.target, ...fields }], { target: r.target });
}

function pRotate(c: Clause, ctx: Ctx): Out | null {
  const verb = c.find((t) => verbIn(t, ['rotate']));
  const around = c.find((t) => hasW(t, 'around180'));
  const cw = c.find((t) => hasW(t, 'clockwise')), ccw = c.find((t) => hasW(t, 'counterclockwise'));
  if (verb < 0 && around < 0) return null;
  if (cw >= 0 && ccw >= 0) return null;
  c.use(verb, around, cw, ccw);
  const n = c.find((t) => isNum(t, 'deg'));
  let by: number | null = null;
  if (n >= 0) { by = (c.ts[n] as NumCT).tok.v * (cw >= 0 ? -1 : 1); c.use(n); }
  else if (c.takeAll((t) => isNum(t, null)) > 0) by = null; // "30 회전": a number with no unit (§6 D24)
  else if (around >= 0) by = 180;
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (by === null) return ask('amount', `rotate ${formatTarget(r.target)} by=?`);
  return ok('rotate', [{ kind: 'rotate', target: r.target, by }], { target: r.target });
}

function pScale(c: Clause, ctx: Ctx): Out | null {
  const verb = c.find((t) => verbIn(t, ['scale']));
  const times = c.find((t) => isNum(t, 'x'));
  const pct = c.find((t) => isNum(t, 'pct'));
  const half = c.find((t) => hasW(t, 'half')), double = c.find((t) => hasW(t, 'double'));
  const bigger = c.find((t) => hasW(t, 'bigger')), smaller = c.find((t) => hasW(t, 'smaller'));
  if (verb < 0 && times < 0 && pct < 0 && half < 0 && double < 0 && bigger < 0 && smaller < 0) return null;
  if (bigger >= 0 && smaller >= 0) return null;
  let factor: number | null = null;
  if (times >= 0 && smaller < 0) factor = (c.ts[times] as NumCT).tok.v;
  else if (pct >= 0 && (bigger >= 0 || smaller >= 0)) factor = 1 + ((smaller >= 0 ? -1 : 1) * (c.ts[pct] as NumCT).tok.v) / 100;
  else if (half >= 0) factor = 0.5;
  else if (double >= 0) factor = 2;
  else if (verb >= 0) {
    const n = c.find((t) => isNum(t, null));
    if (n >= 0) { factor = (c.ts[n] as NumCT).tok.v; c.use(n); }
  }
  if (times >= 0 && smaller >= 0) return null;
  c.use(verb, times, pct, half, double, bigger, smaller);
  const little = c.takeAll((t) => hasW(t, 'little'));
  c.takeAll((t) => (hasW(t, 'prop:scale') && !isVerb(t)) || verbIn(t, ['make']));
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (factor === null || little > 0 || !(factor > 0)) return ask('amount', `scale ${formatTarget(r.target)} x?`);
  return ok('scale', [{ kind: 'scale', target: r.target, factor: Number(factor.toPrecision(12)) }], { target: r.target });
}

function pMove(c: Clause, ctx: Ctx): Out | null {
  const move = c.find((t) => verbIn(t, ['move']));
  const lift = c.find((t) => verbIn(t, ['raise', 'lower']));
  const little = c.find((t) => hasW(t, 'little'));
  if (move < 0 && lift < 0 && !dirDistance(c, false)) return null;
  if (c.find((t) => disOf(t)) >= 0) return null;
  // Raise / lower TO a height is not a move (§6 D8).
  if (lift >= 0 && c.find((t) => isNum(t, 'm') && hasRole(t, 'to')) >= 0) return bad('cmd37.nl.unknown.raiseTo');
  c.use(move, lift);
  const vertical = lift >= 0 ? (verbIn(c.ts[lift], ['raise']) ? 'up' : 'down') : null;
  // A direction inside a place phrase (n4의 남쪽으로 · to the south of n4 · 5 m north of n4) is a destination (§6 D12),
  // anywhere else it is an offset (선택한 것 동쪽으로 5 m).
  const pure = [...places(c, true), ...places(c).filter((h) => h.explicit)];
  const inPlace = (i: number) => pure.some((h) => h.compound && i >= h.from && i < h.to);
  const dirTok = c.find((t, i) => (wPre(t, 'dir:') || wPre(t, 'diag:')) && !inPlace(i));
  const distI = c.find((t, i) => isNum(t, 'm') && !inPlace(i));
  const bare = c.find((t, i) => isNum(t, null) && !inPlace(i));
  if (dirTok >= 0 || vertical || little >= 0 || ((distI >= 0 || bare >= 0) && pure.length === 0)) {
    const dir = dirTok >= 0 ? wPre(c.ts[dirTok], 'dir:') ?? 'diagonal' : vertical;
    const dist = distI >= 0 ? (c.ts[distI] as NumCT).tok.v : null;
    c.use(dirTok, distI, little);
    c.takeAll((t) => hasW(t, 'height') || isNum(t, null));
    const r = targetOr(c, ctx);
    if (r.err) return r.err;
    if (!c.done()) return null;
    const head = `move ${formatTarget(r.target)}`;
    // No distance (or a number with no unit — §6 D24, or "조금만") → the amount; a distance and no direction → the direction.
    if (little >= 0 || dist === null) return ask('amount', `${head} by=?`);
    // Camera-relative (left / right / forward / back) and diagonal moves are not supported: ask for a compass direction.
    const by: [number, number, number] | null =
      dir === 'east' ? [dist, 0, 0] : dir === 'west' ? [-dist, 0, 0] : dir === 'south' ? [0, 0, dist] : dir === 'north' ? [0, 0, -dist] : dir === 'up' ? [0, dist, 0] : dir === 'down' ? [0, -dist, 0] : null;
    if (!by) return ask('direction', `${head} by=? (${dist} m)`);
    return ok('move', [{ kind: 'move', target: r.target, by: by.map((v) => v + 0) as [number, number, number] }], { target: r.target });
  }
  if (move < 0) return null;
  // Move to a place: <place>(으)로 옮겨 · move … to <place>
  const dest = places(c).filter((h) => hasRole(h, 'to', 'upto') || h.post.includes('at') || h.compound);
  // "move it over there": one pure place word with no particle is where to
  const plain = places(c, true).filter((h) => h.pre.length + h.post.length === 0);
  const to = dest.find((h) => h.place.p !== 'selection' && h.place.p !== 'last') ?? dest[0] ?? (plain.length === 1 ? plain[0] : undefined);
  if (to) usePlace(c, to);
  const r = targetOr(c, ctx);
  if (r.err) return r.err;
  if (!c.done()) return null;
  if (!to) return ask('direction', `move ${formatTarget(r.target)} ?`);
  return ok('move', [{ kind: 'move', target: r.target, to: to.place }], { target: r.target });
}

// ── §3.1 place ───────────────────────────────────────────────────────────────────────────

function pPlace(c: Clause): Out | null {
  const ks = c.all((t) => kindOf(t));
  const countI = c.find((t) => isNum(t, 'count'));
  const verbs = c.all((t) => verbIn(t, ['place', 'create', 'add', 'plant', 'park']));
  if (ks.length > 1) return bad('cmd37.nl.unknown.twoKinds');
  if (!ks.length) {
    // A placing verb and nothing to place (여기에 다섯 대 놓아 — a counter does not name a kind, §6 D5) → ask what.
    if (!verbs.length) return null;
    c.use(...verbs, countI);
    c.takeAll((t) => isNum(t, null, 'floors'));
    roads(c).slice(0, 1).forEach((h) => { for (let k = h.from; k < h.to; k++) c.use(k); });
    places(c).slice(0, 1).forEach((h) => usePlace(c, h));
    return c.done() ? ask('kind', 'place ?') : null;
  }
  const key = kindOf(c.ts[ks[0]])!.key;
  c.use(ks[0], ...verbs);
  if (hasW(c.free(ks[0] + 1), 'plural')) c.use(ks[0] + 1);
  const { type, preset } = splitKey(key);
  if (!findKind(type, preset)) return null;
  const intent: IntentOf<'place'> = preset ? { kind: 'place', type, preset } : { kind: 'place', type };
  // floors: 2층 · 2-storey · 2 floors
  const fl = c.find((t) => isNum(t, 'floors'));
  let floors: number | undefined;
  if (fl >= 0) {
    floors = (c.ts[fl] as NumCT).tok.v;
    c.use(fl);
    if (type !== 'building') return bad('cmd37.nl.unknown.floors');
  }
  // count: 세 채 · three houses · 주택 3 (a number with no unit right beside the kind phrase)
  let count: number | undefined;
  if (countI >= 0) { count = (c.ts[countI] as NumCT).tok.v; c.use(countI); }
  else {
    const beside = (step: number): number => { let i = ks[0] + step; while (c.ts[i]?.used) i += step; return i; };
    const bare = [beside(-1), beside(1)].find((i) => isNum(c.free(i), null) && c.ts[i].pre.length === 0);
    if (bare !== undefined) { count = (c.ts[bare] as NumCT).tok.v; c.use(bare); }
  }
  // gap: 간격 2 m · 2 m 간격 · 2 m씩 띄워서 · 2 m apart · with 2 m gaps · 붙여서 / touching = 0
  let gap: number | undefined;
  const gapWord = c.find((t) => hasW(t, 'gap') || hasW(t, 'spaced'));
  if (gapWord >= 0) {
    const n = isNum(c.free(gapWord + 1), 'm') ? gapWord + 1 : isNum(c.free(gapWord - 1), 'm') ? gapWord - 1 : -1;
    const bare = isNum(c.free(gapWord + 1), null) ? gapWord + 1 : isNum(c.free(gapWord - 1), null) ? gapWord - 1 : -1;
    if (n >= 0) { gap = (c.ts[n] as NumCT).tok.v; c.use(n); c.takeAll((t) => hasW(t, 'gap') || hasW(t, 'spaced')); }
    else if (bare >= 0) { gap = NaN; c.use(bare); c.takeAll((t) => hasW(t, 'gap') || hasW(t, 'spaced')); } // no unit (§6 D24)
  }
  if (c.take((t) => hasW(t, 'touching')) >= 0 && gap === undefined) gap = 0;
  // heading: 방향 90도 · 90도 방향으로 · heading 90 · facing 90°; compass words are not supported
  let heading: number | undefined;
  const hw = c.find((t) => hasW(t, 'heading'));
  if (hw >= 0) {
    const n = isNum(c.free(hw + 1), 'deg', null) ? hw + 1 : isNum(c.free(hw - 1), 'deg') ? hw - 1 : -1;
    if (n >= 0) { heading = (c.ts[n] as NumCT).tok.v; c.use(hw, n); }
    else if (c.find((t) => wPre(t, 'dir:') || wPre(t, 'diag:')) >= 0) return bad('cmd37.nl.unknown.facing');
  }
  if (c.find((t) => hasW(t, 'face')) >= 0) return bad('cmd37.nl.unknown.facing');
  // location: a road (with a side) → along=; a place → at=
  let both = false;
  const road = roads(c)[0];
  const sideWords = c.all((t) => !!compassOf(t) || wPre(t, 'dir:') === 'left' || wPre(t, 'dir:') === 'right');
  const bothI = c.find((t) => hasW(t, 'both'));
  const alongI = c.find((t) => hasW(t, 'along') || hasW(t, 'next'));
  // "구간 s2에 / s2 도로에 / on segment s2" (§6 D13, D34): a lane for cars and people, the middle of the segment for
  // everything else — unless a side word or 따라 / along / 옆 makes it a row along the segment.
  const segPoint = !!road && road.road.r === 'seg' && !sideWords.length && bothI < 0 && alongI < 0 && type !== 'car' && type !== 'human';
  if (road && segPoint) {
    for (let k = road.from; k < road.to; k++) c.use(k);
    intent.at = { p: 'seg', id: (road.road as Extract<RoadRef, { r: 'seg' }>).id, t: 0.5 };
  } else if (road) {
    for (let k = road.from; k < road.to; k++) c.use(k);
    intent.along = road.road;
    c.takeAll((t) => hasW(t, 'along') || hasW(t, 'next') || (hasW(t, 'on') && !wPre(t, 'dir:')));
    if (bothI >= 0) { c.use(bothI); both = true; }
    else {
      if (sideWords.length > 1) return null;
      if (sideWords.length) { intent.side = wPre(c.ts[sideWords[0]], 'dir:') as 'left' | 'right' | Direction; c.use(sideWords[0]); }
    }
    c.takeAll((t) => hasW(t, 'side') || (hasW(t, 'on') && wPre(t, 'dir:') === 'up'));
  } else {
    const here = places(c).find((h) => !hasRole(h, 'upto', 'to') || h.compound || h.post.includes('at'));
    if (here) intent.at = usePlace(c, here);
  }
  if (!c.done()) return null;
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1) return ask('amount', `place ${key} count=?`);
    if (count > 1) intent.count = count;
  }
  if (gap !== undefined) { if (!(gap >= 0)) return ask('amount', `place ${key} gap=?`); intent.gap = gap; }
  if (floors !== undefined) { if (!Number.isInteger(floors) || floors < 1) return ask('amount', `place ${key} floors=?`); intent.floors = floors; }
  if (heading !== undefined) intent.heading = heading;
  // Both sides: one command per side, each with the count (§6 D4).
  const intents: Intent[] = both ? [{ ...intent, side: 'left' }, { ...intent, side: 'right' }] : [intent];
  return ok('place', intents, { makes: true });
}

// ── One clause ───────────────────────────────────────────────────────────────────────────

const CLASSES: ((c: Clause, ctx: Ctx) => Out | null)[] = [
  pUndo, pSelect, pInstance, pSim, pQuery, pFocus, pFlag, pGroup, pRename, pCopyMatch, pDistribute, pAlign,
  pTerrain, pPaint, pForest, pDisaster, pDuplicate, pDelete, pSet, pRotate, pScale, pMove, pRoad, pPlace,
];

/** One clause → the first class that reads all of it; else the first class that asks for a piece or refuses with a reason. Null: no class does. */
export function parseClause(c: Clause, ctx: Ctx): Out | null {
  let other: Out | null = null;
  for (const rule of CLASSES) {
    c.reset();
    const out = rule(c, ctx);
    if (!out) continue;
    if (out.r === 'ok') return out;
    other ??= out;
  }
  c.reset();
  return other;
}
