/**
 * Phase 37 (§7 "손으로 중복 정의 금지"): the lexicon has ONE source per kind of word — kind names from the object palette,
 * disaster names from the phenomenon registry, aliases and grammar words from aliases.ts — and no word means two things
 * unless a priority table says which one wins.
 */
import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n/i18n';
import { phenomena } from '@/phenomena/registry';
import { CATALOG } from '@/phenomena/catalog';
import { parseCanonical } from './canonical';
import { KINDS, KIND_TYPES, findKind } from './kinds';
import {
  COUNTERS, DISASTER_ADDED, DISASTER_ALIASES, DISASTER_FIELDS, DISASTER_PRIORITY, DISASTER_VARIANTS, DURATION_TYPES, KIND_ALIASES, KIND_EXCLUDED_TYPES, KIND_PRIORITY,
  LEGACY_FIELDS, LEGACY_TYPES, TEMPLATES, VERBS, WORDS,
} from './aliases';
import { DISASTER_NAMES, KIND_NAMES, LEXICON, detectLanguage, koVerbForms, labelNames, lex, matchAt, type Tok } from './lexicon';
import { normalizeText } from './normalize';

const clean = (s: string) => s.normalize('NFKC').toLowerCase();
const isKindKey = (key: string): boolean => {
  const [type, preset] = key.split(':');
  return preset !== undefined ? findKind(type, preset)?.key === key : (KIND_TYPES as readonly string[]).includes(type);
};
const brief = (toks: Tok[]): string =>
  toks.map((t) => (t.t === 'num' ? `${t.v}${t.u ?? ''}` : t.t === 'w' ? t.text : t.t === '?' ? `?${t.text}` : t.t === 'q' ? `"${t.text}"` : t.t === 'p' ? t.text : `${t.t}:${t.text}`)).join(' ');
const tokens = (text: string) => brief(lex(normalizeText(text)));

describe('lexicon sources', () => {
  it('names are split from UI labels at / · (…)', () => {
    expect(labelNames('소형 주택 (목조)')).toEqual(['소형 주택']);
    expect(labelNames('바람 / 태풍')).toEqual(['바람', '태풍']);
    expect(labelNames('기후·눈·얼음')).toEqual(['기후', '눈', '얼음']);
    expect(labelNames('지형 변형(침하·융기)')).toEqual(['지형 변형']);
    expect(labelNames('Terrain deformation (subsidence / uplift)')).toEqual(['terrain deformation']);
    expect(labelNames('Office building (steel + core)')).toEqual(['office building']);
  });

  it('every alias key is an existing kind / an implemented disaster type', () => {
    expect(Object.keys(KIND_ALIASES).filter((k) => !isKindKey(k))).toEqual([]);
    expect(Object.values(KIND_PRIORITY).filter((k) => !isKindKey(k))).toEqual([]);
    const types = phenomena.listImplemented().map((d) => d.type);
    expect(Object.keys(DISASTER_ALIASES).filter((t) => !types.includes(t))).toEqual([]);
    // every implemented disaster has words, field rules name real types, legacy tables name legacy types
    expect(types.filter((t) => !DISASTER_ALIASES[t])).toEqual([]);
    for (const t of [...Object.keys(DISASTER_FIELDS), ...DURATION_TYPES, ...LEGACY_TYPES, ...Object.keys(LEGACY_FIELDS)]) expect(types, t).toContain(t);
    for (const t of new Set(DISASTER_NAMES.words.values())) expect(types, t).toContain(t);
    for (const k of new Set(KIND_NAMES.words.values())) expect(isKindKey(k), k).toBe(true);
    for (const category of Object.keys(COUNTERS)) if (category !== 'any') expect(KINDS.some((k) => k.item.category === category), category).toBe(true);
  });

  it('kind names come from the palette: every label of a placeable kind is a word of the lexicon', () => {
    for (const k of KINDS) {
      for (const lang of ['ko', 'en'] as const) {
        for (const name of labelNames(translate(lang, k.item.labelKey))) {
          const senses = LEXICON.get(name.replace(/-/g, ' ')) ?? [];
          if (KIND_EXCLUDED_TYPES.includes(k.type)) expect(senses.some((s) => s.c === 'kind'), `${name} (excluded type)`).toBe(false);
          else expect(senses.some((s) => s.c === 'kind'), `${k.key} ← ${name}`).toBe(true);
        }
      }
    }
    // "도로" is a road reference, not a kind to place
    expect(KIND_EXCLUDED_TYPES).toEqual(['road']);
    expect([...KIND_NAMES.words.values()].some((k) => k === 'road' || k.startsWith('road:'))).toBe(false);
  });

  it('disaster names come from the registry: every label of an implemented disaster is a word of its type', () => {
    for (const def of phenomena.listImplemented()) {
      expect(CATALOG[def.type], def.type).toBeDefined();
      for (const lang of ['ko', 'en'] as const) for (const name of labelNames(translate(lang, def.labelKey))) expect(DISASTER_NAMES.words.get(name), name).toBe(def.type);
    }
  });

  it('no word names two kinds unless the priority table says which wins — the collisions, listed', () => {
    expect([...KIND_NAMES.collisions.keys()].sort()).toEqual(Object.keys(KIND_PRIORITY).sort());
    // written by hand: a palette label that another kind's alias (or label) also claims
    expect(Object.fromEntries([...KIND_NAMES.collisions].map(([w, keys]) => [w, [...keys].sort()]))).toEqual({
      '주택': ['building:boxHouse', 'building:house'],
      house: ['building:boxHouse', 'building:house'],
      '오피스 빌딩': ['building:boxOffice', 'building:office'],
      '보행자': ['human', 'human:adult'],
      pedestrian: ['human', 'human:adult'],
      '도로 표지판': ['sign', 'sign:road'],
      'road sign': ['sign', 'sign:road'],
      '나무 상자': ['crate', 'crate:wood'],
      'wooden crate': ['crate', 'crate:wood'],
      '공': ['ball', 'ball:solid'],
      ball: ['ball', 'ball:solid'],
    });
    for (const [word, key] of Object.entries(KIND_PRIORITY)) expect(KIND_NAMES.words.get(word), word).toBe(key);
  });

  it('modular buildings win over the legacy box buildings', () => {
    expect(KIND_NAMES.words.get('주택')).toBe('building:house');
    expect(KIND_NAMES.words.get('house')).toBe('building:house');
    expect(KIND_NAMES.words.get('오피스 빌딩')).toBe('building:office');
    expect(KIND_NAMES.words.get('상자 주택')).toBe('building:boxHouse');
    expect(KIND_NAMES.words.get('box office')).toBe('building:boxOffice');
    expect(KIND_NAMES.words.get('건물')).toBe('building');
    expect(KIND_NAMES.words.get('벽')).toBe('wall');
    expect(findKind('building')?.key).toBe('building:house');
  });

  it('no word names two disaster types (the priority table is empty), and none is both a kind and a disaster', () => {
    expect([...DISASTER_NAMES.collisions.keys()]).toEqual(Object.keys(DISASTER_PRIORITY));
    expect(Object.keys(DISASTER_PRIORITY)).toEqual([]);
    const both = [...LEXICON].filter(([, s]) => s.some((x) => x.c === 'kind') && s.some((x) => x.c === 'dis')).map(([w]) => w);
    expect(both).toEqual([]);
  });

  it('every disaster word is accepted by its type\'s own keywords (the old grammar) — or is a listed, deliberate addition', () => {
    const outside: string[] = [];
    for (const [word, type] of DISASTER_NAMES.words) {
      const def = phenomena.implemented(type)!;
      if (!def.keywords.test(word)) outside.push(word);
    }
    expect(outside.sort()).toEqual([...DISASTER_ADDED].map(clean).sort());
    // the variants (폭염 → scenario=heatwave …) are disaster words
    for (const w of Object.keys(DISASTER_VARIANTS)) expect(DISASTER_NAMES.words.has(w), w).toBe(true);
  });

  it('Korean verb forms are generated: the command, endings, and the two connectives that end a clause', () => {
    const forms = (stem: string, ...a: string[]) => koVerbForms(stem, a).map((f) => (f.conn ? `${f.form}~` : f.form));
    expect(forms('놓', '놓아', '놔')).toEqual(['놓아', '놓아라', '놓아요', '놓아서~', '놔', '놔라', '놔요', '놔서~', '놓고~', '놓자', '놓으세요', '놓을래', '놓습니다']);
    expect(forms('옮기', '옮겨')).toEqual(['옮겨', '옮겨라', '옮겨요', '옮겨서~', '옮기고~', '옮기자', '옮기세요', '옮길래', '옮깁니다']);
    expect(forms('만들', '만들어')).toEqual(['만들어', '만들어라', '만들어요', '만들어서~', '만들고~', '만들자', '만드세요', '만들래', '만듭니다']);
    for (const form of ['묶어서', '묶고', '발생시키고', '숨기세요', '지울래', '세웁니다']) expect(LEXICON.has(form), form).toBe(true);
  });

  it('the suggestion templates are canonical commands, and their tags are ids of the lexicon', () => {
    const ids = new Set<string>(['kind', 'disaster', ...Object.keys(VERBS), ...Object.keys(WORDS)]);
    for (const t of TEMPLATES) {
      expect(parseCanonical(t.text).ok, t.text).toBe(true);
      for (const tag of t.tags) expect(ids.has(tag), `${t.text}: ${tag}`).toBe(true);
    }
  });
});

describe('lex', () => {
  it('Korean without spaces: longest dictionary match', () => {
    expect(tokens('주택세채')).toBe('주택 3count');
    expect(tokens('큰길북쪽에')).toBe('큰길 북쪽 에');
    expect(tokens('선택한것')).toBe('선택한것');
    expect(tokens('2층주택')).toBe('2floors 주택');
    expect(tokens('나무다섯그루심어줘')).toBe('나무 5count 심어 줘');
    expect(tokens('큰길북쪽에2층주택세채간격2미터')).toBe('큰길 북쪽 에 2floors 주택 3count 간격 2m');
  });

  it('a phrase is one token; a longer word wins over a shorter one inside it', () => {
    expect(tokens('이 도로 옆에')).toBe('이 도로 옆 에');
    expect(lex(normalizeText('이 도로'))).toHaveLength(1);
    expect(lex(normalizeText('40피트 컨테이너'))).toHaveLength(1);
    expect(lex(normalizeText('main road'))).toHaveLength(1);
    expect(lex(normalizeText('street lights'))).toHaveLength(1);
    expect(tokens('모두 동쪽으로 5 m')).toBe('모두 동쪽 으로 5m');
    expect(tokens('이동')).toBe('이동');
    expect(tokens('high-rise')).toBe('high-rise');
    expect(matchAt('mainroad', 0)).toEqual([]);
  });

  it('ids, coordinates, quoted names', () => {
    expect(tokens('N4에서 (40, 60)까지')).toBe('id:n4 에서 xz:(40, 60) 까지');
    expect(tokens('n2–n3 도로')).toBe('btw:n2-n3 도로');
    expect(tokens('x 40 z 60')).toBe('xz:x 40 z 60');
    expect(tokens('40,60')).toBe('xz:40,60');
    expect(tokens("'북쪽 블록' 그룹 #Building_AB12 p3 s2")).toBe('"북쪽 블록" 그룹 id:#Building_AB12 id:p3 id:s2');
    expect(tokens('화재 #3')).toBe('화재 3hash');
    expect(tokens('M7 earthquake')).toBe('m 7 earthquake');
  });

  it('a word outside the lexicon is marked — never dropped', () => {
    expect(tokens('나무를 빨갛게 칠해')).toBe('나무 를 ?빨갛게 칠해');
    expect(tokens('delete the trees quickly')).toBe('delete the trees ?quickly');
    expect(lex(normalizeText('주택 세 채 놓고 블라블라')).some((t) => t.t === '?')).toBe(true);
  });

  it('English plurals of kind words; language by script', () => {
    for (const w of ['houses', 'factories', 'people', 'street lights', 'lorries', 'high-rises', 'crates']) expect(LEXICON.get(w.replace(/-/g, ' '))?.some((s) => s.c === 'kind' && s.plural), w).toBe(true);
    expect(detectLanguage('n4에 blast')).toBe('ko');
    expect(detectLanguage('blast at n4')).toBe('en');
  });
});
