/**
 * Phase 37 (§6, §20): the corpus files are well-formed — FORMAT only. Whether a sentence is understood as its expected
 * commands is the parser's corpus test; nothing here reads a sentence (no natural-language parser is imported).
 *
 * Checked: the JSON shape (exactly one of expect / ask / unknown per case), file names, every expected line is exactly
 * canonical (parse → format gives the same text), the kinds / disaster types / fields / ground names / road presets it
 * names exist, no sentence twice in a language, and the size floors of the specification.
 */
import { describe, expect, it } from 'vitest';
import { formatCanonical, parseCanonical } from '../canonical';
import type { Intent } from '../intent';
import { canonicalType, findKind } from '../kinds';
import { ASK_SLOTS, CORPUS_CLASSES, CORPUS_LANGS, corpusFileSchema, isAsk, isExpect, isUnknown, loadCorpus, rawCorpus, type CorpusFile } from './index';

/** Size floors (specification §6: every class ≥ 15 sentences per language, ≥ 400 in all). */
const FLOOR = { perClass: 15, reject: 40, mixed: 15, total: 400 };

/** Disaster type ids and the fields a sentence can set (NL-CONVENTIONS §2.2 — storage names). */
const DISASTER_FIELDS: Record<string, readonly string[]> = {
  wind: ['speed', 'direction', 'duration'],
  tornado: ['maxSpeed', 'coreRadius', 'duration'],
  rain: ['intensity', 'duration'],
  climate: ['scenario'],
  earthquake: ['magnitude', 'pga', 'duration'],
  sinkhole: ['cavityRadius'],
  landslide: [],
  terrainDeformation: ['kind', 'radius', 'amount'],
  volcano: ['rate', 'duration'],
  risingWater: ['level', 'boundary', 'riseRate'],
  waterSource: ['rate', 'duration'],
  fire: ['radius', 'duration'],
  heatSource: ['power', 'duration'],
  blast: ['energy', 'height'],
  impact: ['diameter', 'speed', 'angle'],
  gravity: ['magnitude', 'duration'],
  celestial: [],
  atmosphere: [],
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Word values a field may take (the others are numbers). */
const FIELD_WORDS: Record<string, readonly string[]> = {
  'wind.direction': COMPASS,
  'risingWater.boundary': ['N', 'E', 'S', 'W'],
  'terrainDeformation.kind': ['subsidence', 'uplift'],
  'climate.scenario': ['heatwave'],
};
const GROUNDS = ['grass', 'soil', 'sand', 'asphalt', 'concrete', 'gravel', 'rock', 'mud', 'riverbed'];
const ROAD_PRESETS = ['street', 'avenue', 'narrow', 'wide', 'lane', 'gravel', 'dirt'];
const DENSITIES = ['low', 'medium', 'high'];
const FEATURE_KINDS = ['hill', 'mountain', 'lake', 'river'];

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** The files that have the shape (a malformed one is reported by the first test, and does not hide the other checks). */
const files: CorpusFile[] = rawCorpus().flatMap(({ file, data }) => {
  const r = corpusFileSchema.safeParse(data);
  return r.success ? [{ file, ...r.data }] : [];
});
const where = (f: CorpusFile, text: string) => `${f.file}: ${JSON.stringify(text)}`;

/** Every value of an intent, depth first (objects and arrays). */
function* walk(v: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(v)) for (const x of v) yield* walk(x);
  else if (v !== null && typeof v === 'object') {
    yield v as Record<string, unknown>;
    for (const x of Object.values(v)) yield* walk(x);
  }
}

/** What an intent names that must exist: kinds, disaster types and fields, ground names, presets, feature kinds. */
function vocabularyProblems(i: Intent): string[] {
  const out: string[] = [];
  const kind = (type: string, preset: string | undefined, what: string) => {
    const k = findKind(type, preset);
    if (!k) out.push(`${what}: no kind ${type}${preset ? `:${preset}` : ''}`);
    else if (canonicalType(type) !== type) out.push(`${what}: type spelled ${type}, canonical ${canonicalType(type)}`);
    else if (preset !== undefined && k.key !== `${type}:${preset}`) out.push(`${what}: preset spelled ${preset}, canonical ${k.key}`);
  };
  if (i.kind === 'place') kind(i.type, i.preset, 'place');
  for (const o of walk(i)) {
    if (o.b === 'type' && typeof o.type === 'string') kind(o.type, typeof o.preset === 'string' ? o.preset : undefined, 'type:');
    if ((o.p === 'feature' || o.a === 'feature') && typeof o.id === 'string' && !FEATURE_KINDS.includes(o.id) && !/^f\d+$/.test(o.id)) out.push(`feature:${o.id} is not a feature kind or id`);
  }
  if (i.kind === 'disaster') {
    const fields = DISASTER_FIELDS[i.type];
    if (!fields) out.push(`disaster type ${i.type}`);
    else {
      for (const [k, v] of Object.entries(i.fields)) {
        if (!fields.includes(k)) out.push(`disaster ${i.type}: field ${k}`);
        const words = FIELD_WORDS[`${i.type}.${k}`];
        if (typeof v === 'string' ? !words?.includes(v) : words !== undefined && k !== 'direction') out.push(`disaster ${i.type}: ${k}=${v}`);
      }
    }
  }
  if (i.kind === 'instance' && i.ref.i === 'type' && !(i.ref.type in DISASTER_FIELDS)) out.push(`disaster instance type ${i.ref.type}`);
  if (i.kind === 'paint' && !GROUNDS.includes(i.ground)) out.push(`ground=${i.ground}`);
  if (i.kind === 'road' && i.preset !== undefined && !ROAD_PRESETS.includes(i.preset)) out.push(`road preset=${i.preset}`);
  if (i.kind === 'forest' && typeof i.density === 'string' && !DENSITIES.includes(i.density)) out.push(`density=${i.density}`);
  return out;
}

describe('command corpus — format', () => {
  it('every file has the shape { class, lang, cases[] } with exactly one of expect / ask / unknown per case', () => {
    const bad: string[] = [];
    for (const { file, data } of rawCorpus()) {
      const r = corpusFileSchema.safeParse(data);
      if (!r.success) { bad.push(`${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`); continue; }
      if (file !== `${r.data.class}.${r.data.lang}.json`) bad.push(`${file}: holds class ${r.data.class}, lang ${r.data.lang}`);
    }
    expect(bad).toEqual([]);
    // The loader the parser's corpus test uses gives the same files.
    expect(loadCorpus()).toEqual(files);
    for (const f of files) {
      for (const c of f.cases) {
        expect([isExpect(c), isAsk(c), isUnknown(c)].filter(Boolean).length, where(f, c.text)).toBe(1);
        if (isAsk(c)) expect(ASK_SLOTS, where(f, c.text)).toContain(c.ask);
        if (isUnknown(c)) expect(c.why.trim().length, where(f, c.text)).toBeGreaterThan(0);
      }
    }
  });

  it('one file per class and language', () => {
    const want = CORPUS_CLASSES.flatMap((c) => CORPUS_LANGS.map((l) => `${c}.${l}.json`)).sort();
    expect(files.map((f) => f.file).sort()).toEqual(want);
  });

  it('every expected line is exactly canonical: parse → format gives the same text', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const c of f.cases) {
        if (!isExpect(c)) continue;
        for (const line of c.expect) {
          const r = parseCanonical(line);
          if (!r.ok) { bad.push(`${where(f, c.text)}  ${line}  →  ${JSON.stringify(r.error)}`); continue; }
          const back = formatCanonical(r.intent);
          if (back !== line) bad.push(`${where(f, c.text)}  ${line}  →  ${back}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the kinds, disaster types and fields, ground names, road presets and features named exist', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const c of f.cases) {
        if (!isExpect(c)) continue;
        for (const line of c.expect) {
          const r = parseCanonical(line);
          if (r.ok) for (const p of vocabularyProblems(r.intent)) bad.push(`${where(f, c.text)}  ${line}  →  ${p}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('sentences: trimmed, in the language of the file, no sentence twice in a language', () => {
    const bad: string[] = [];
    for (const lang of CORPUS_LANGS) {
      const seen = new Map<string, string>();
      for (const f of files.filter((x) => x.lang === lang)) {
        for (const c of f.cases) {
          if (c.text !== c.text.trim()) bad.push(`${where(f, c.text)}: white space at an end`);
          if (lang === 'ko' ? !HANGUL.test(c.text) : HANGUL.test(c.text)) bad.push(`${where(f, c.text)}: not ${lang}`);
          const first = seen.get(c.text);
          if (first !== undefined) bad.push(`${where(f, c.text)}: also in ${first}`);
          else seen.set(c.text, f.file);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('reject files never expect a command; mixed sentences give several commands', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const c of f.cases) {
        if (f.class === 'reject' && isExpect(c)) bad.push(`${where(f, c.text)}: a reject case with an expectation`);
        if (f.class === 'mixed' && isExpect(c) && c.expect.length < 2) bad.push(`${where(f, c.text)}: one command only`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('size floors: every class ≥ 15 per language, reject ≥ 40 per language, mixed ≥ 15, ≥ 400 in all', () => {
    const small: string[] = [];
    for (const f of files) {
      const floor = f.class === 'reject' ? FLOOR.reject : f.class === 'mixed' ? FLOOR.mixed : FLOOR.perClass;
      if (f.cases.length < floor) small.push(`${f.file}: ${f.cases.length} < ${floor}`);
    }
    expect(small).toEqual([]);
    expect(files.reduce((n, f) => n + f.cases.length, 0)).toBeGreaterThanOrEqual(FLOOR.total);
  });
});
