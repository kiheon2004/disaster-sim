/**
 * Phase 37 — the ONLY hand-written word tables of the natural-language parser (§6, §7; NL-CONVENTIONS.md).
 *
 * What is here: aliases of object kinds and disaster types (the NAMES themselves are not here — the lexicon reads them
 * from the object palette and the phenomenon registry), counters, units, numerals, and the grammar words of Korean and
 * English (verbs per class, particles, endings, deictics, directions, field phrases). `lexicon.ts` builds the lookup
 * structures from these tables; `parse.ts` holds the rules. Pure data: nothing here runs.
 */
import type { ObjectCategory } from '@/core/types';

export interface Words {
  ko?: readonly string[];
  en?: readonly string[];
}

// ── Object kinds (keys: `type` or `type:preset` of kinds.ts) ─────────────────────────────

/** Extra names of a kind, besides its palette label. A bare type (`building`, `tree`) is that type's default preset. */
export const KIND_ALIASES: Record<string, Words> = {
  building: { ko: ['건물', '빌딩'], en: ['building'] },
  'building:house': { ko: ['주택', '집', '하우스', '소형 주택'], en: ['house', 'home'] },
  'building:apartment': { ko: ['아파트', '중층 아파트'], en: ['apartment', 'apartment block'] },
  'building:office': { ko: ['오피스', '사무실', '오피스 빌딩', '사무용 건물'], en: ['office', 'office building'] },
  'building:warehouse': { ko: ['창고'], en: ['warehouse'] },
  'building:industrial': { ko: ['공장', '공장 건물'], en: ['factory', 'industrial building'] },
  'building:tower': { ko: ['타워', '고층 타워', '고층 빌딩', '마천루'], en: ['tower', 'high-rise', 'skyscraper'] },
  'building:boxHouse': { ko: ['상자 주택'], en: ['box house'] },
  'building:boxOffice': { ko: ['상자 오피스'], en: ['box office'] },
  'building:boxLowrise': { ko: ['상가 건물'], en: ['low-rise shop'] },
  tree: { ko: ['나무'], en: ['tree'] },
  'tree:broadleaf': { ko: ['활엽수'], en: ['broadleaf', 'broadleaf tree'] },
  'tree:conifer': { ko: ['침엽수', '소나무'], en: ['conifer', 'pine', 'pine tree'] },
  car: { ko: ['차', '자동차', '차량'], en: ['car', 'vehicle'] },
  'car:sedan': { ko: ['승용차', '세단'], en: ['sedan'] },
  'car:suv': { ko: ['suv'], en: ['suv'] },
  'car:truck': { ko: ['트럭', '화물차'], en: ['truck', 'lorry'] },
  human: { ko: ['사람', '보행자', '행인'], en: ['person', 'pedestrian'] },
  streetLight: { ko: ['가로등'], en: ['street light', 'streetlight', 'lamp post'] },
  sign: { ko: ['표지판', '도로 표지판'], en: ['sign', 'road sign'] },
  'sign:billboard': { ko: ['광고판', '빌보드'], en: ['billboard'] },
  'sign:signal': { ko: ['신호등'], en: ['traffic light', 'signal'] },
  wall: { ko: ['담장', '벽', '담'], en: ['wall'] },
  'wall:guardrail': { ko: ['가드레일'], en: ['guardrail'] },
  'wall:fence': { ko: ['울타리', '펜스'], en: ['fence'] },
  crate: { ko: ['상자', '나무 상자', '궤짝'], en: ['crate', 'wooden crate'] },
  'crate:steel': { ko: ['철제 상자'], en: ['steel crate'] },
  'crate:plastic': { ko: ['플라스틱 상자'], en: ['plastic crate'] },
  barrel: { ko: ['드럼통', '통'], en: ['barrel', 'drum'] },
  'barrel:water': { ko: ['물통'], en: ['water barrel'] },
  'barrel:oil': { ko: ['기름통'], en: ['oil barrel'] },
  container: { ko: ['컨테이너'], en: ['container'] },
  'container:40ft': { ko: ['40피트 컨테이너', '40피트'], en: ['40 ft container', '40ft container'] },
  'container:20ft': { ko: ['20피트 컨테이너', '20피트'], en: ['20 ft container', '20ft container'] },
  furniture: { ko: ['가구'], en: ['furniture'] },
  'furniture:sofa': { ko: ['소파'], en: ['sofa'] },
  'furniture:table': { ko: ['탁자', '테이블'], en: ['table'] },
  'furniture:cabinet': { ko: ['캐비닛', '장'], en: ['cabinet'] },
  roadBarrier: { ko: ['도로 방호벽', '바리케이드'], en: ['road barrier', 'jersey barrier'] },
  ball: { ko: ['공'], en: ['ball'] },
  'ball:hollow': { ko: ['속 빈 공'], en: ['hollow ball'] },
};

/**
 * Words that two kinds claim (a palette label and an alias, or two labels) → the kind that wins. Everything else
 * that collides is a test failure. Modular buildings win over the legacy box buildings ("주택" = building:house);
 * a bare type wins over the preset whose palette label is the same word ("나무 상자" = crate, "공" = ball).
 */
export const KIND_PRIORITY: Record<string, string> = {
  주택: 'building:house',
  house: 'building:house',
  '오피스 빌딩': 'building:office',
  '나무 상자': 'crate',
  'wooden crate': 'crate',
  공: 'ball',
  ball: 'ball',
  '도로 표지판': 'sign',
  'road sign': 'sign',
  보행자: 'human',
  pedestrian: 'human',
};

/** Palette types that are not kinds of the natural language ("도로" is a road reference, roads are drawn with `road`). */
export const KIND_EXCLUDED_TYPES: readonly string[] = ['road'];

/** English plurals that the +s / +es / y→ies rule gets wrong. */
export const PLURALS_EN: Record<string, string> = { person: 'people', furniture: 'furniture', 'lamp post': 'lamp posts' };

/** Counters per palette category (dropped after the count is read; with no kind word they name the bare type). */
export const COUNTERS: Partial<Record<ObjectCategory, readonly string[]>> & { any: readonly string[] } = {
  buildings: ['채', '동'],
  vehicles: ['대'],
  nature: ['그루'],
  people: ['명', '사람'],
  any: ['개'],
};

// ── Disasters (keys: phenomenon type ids) ────────────────────────────────────────────────

export const DISASTER_ALIASES: Record<string, Words> = {
  wind: { ko: ['바람', '강풍', '태풍', '돌풍', '동풍', '서풍', '남풍', '북풍', '북동풍', '북서풍', '남동풍', '남서풍'], en: ['wind', 'gale', 'typhoon', 'hurricane', 'gust'] },
  tornado: { ko: ['토네이도', '회오리', '회오리바람'], en: ['tornado', 'twister'] },
  rain: { ko: ['비', '폭우', '호우', '소나기'], en: ['rain', 'heavy rain', 'downpour', 'rainfall'] },
  climate: { ko: ['폭염', '한파', '폭설', '눈', '결빙'], en: ['heat wave', 'heatwave', 'cold wave', 'snow', 'snowfall', 'frost'] },
  earthquake: { ko: ['지진', '여진'], en: ['earthquake', 'quake'] },
  sinkhole: { ko: ['싱크홀', '땅 꺼짐', '지반 함몰'], en: ['sinkhole'] },
  landslide: { ko: ['산사태', '토석류'], en: ['landslide', 'mudslide', 'debris flow'] },
  terrainDeformation: { ko: ['지반 침하', '침하', '융기'], en: ['subsidence', 'uplift'] },
  volcano: { ko: ['화산', '분화', '용암'], en: ['volcano', 'eruption', 'lava'] },
  risingWater: { ko: ['수위 상승', '수위', '홍수', '범람', '침수'], en: ['rising water', 'water level', 'flood', 'flooding'] },
  waterSource: { ko: ['물 공급원', '물 유입', '수도관 파열', '물'], en: ['water source', 'inflow', 'burst pipe', 'water'] },
  fire: { ko: ['화재', '불', '산불'], en: ['fire', 'blaze', 'wildfire'] },
  heatSource: { ko: ['열원', '히터'], en: ['heat source', 'heater'] },
  blast: { ko: ['폭발', '폭발물', '압력파', '충격파'], en: ['explosion', 'blast', 'pressure wave', 'shock wave'] },
  impact: { ko: ['운석', '운석 충돌', '소행성'], en: ['meteor', 'meteorite', 'asteroid', 'asteroid impact', 'meteorite impact'] },
  gravity: { ko: ['중력', '중력 변화', '무중력', '저중력'], en: ['gravity', 'gravity change', 'zero gravity', 'low gravity'] },
  celestial: { ko: ['블랙홀'], en: ['black hole'] },
  atmosphere: { ko: ['대기', '기압', '진공'], en: ['atmosphere', 'air pressure', 'vacuum'] },
};

/**
 * Disaster words (aliases above, or names split from the registry labels) that the type's own `keywords` regex of the
 * old command system does NOT accept — kept deliberately (the conventions list them, or they are the label itself).
 */
export const DISASTER_ADDED: readonly string[] = [
  '비', '불', 'burst pipe', '물', 'water', '기후', '얼음', 'climate', 'ice', 'extreme gravity',
  '동풍', '서풍', '남풍', '북풍', '북동풍', '북서풍', '남동풍', '남서풍',
];

/** A word that a second type's label also yields → the type that wins. */
export const DISASTER_PRIORITY: Record<string, string> = {};

/** Words that also set a field of the type (conventions §2.2). */
export const DISASTER_VARIANTS: Record<string, Record<string, number | string>> = {
  폭염: { scenario: 'heatwave' },
  'heat wave': { scenario: 'heatwave' },
  heatwave: { scenario: 'heatwave' },
  무중력: { magnitude: 0 },
  'zero gravity': { magnitude: 0 },
  침하: { kind: 'subsidence' },
  '지반 침하': { kind: 'subsidence' },
  subsidence: { kind: 'subsidence' },
  융기: { kind: 'uplift' },
  uplift: { kind: 'uplift' },
};

/** The types whose run-now sentences go through the old grammar (src/commands) — conventions §5. */
export const LEGACY_TYPES: readonly string[] = ['wind', 'earthquake', 'rain', 'risingWater', 'waterSource'];

/**
 * The basic fields a run-now sentence of a legacy type always writes (conventions §6 D1): the said values, the
 * definition's defaults for the rest. Earthquake: `magnitude` (default 6.5); `pga` / `duration` only when said.
 */
export const LEGACY_FIELDS: Record<string, readonly string[]> = {
  wind: ['direction', 'duration', 'speed'],
  earthquake: ['duration', 'magnitude', 'pga'],
  rain: ['duration', 'intensity'],
  risingWater: ['boundary', 'level', 'riseRate'],
  waterSource: ['duration', 'rate'],
};

// ── Units ───────────────────────────────────────────────────────────────────────────────

export type UnitId =
  | 'm' | 'deg' | 's' | 'x' | 'speedx' | 'floors' | 'count' | 'ord' | 'pct' | 'hash'
  | 'J' | 'kg' | 'W' | 'g' | 'mps' | 'mps2' | 'mmh' | 'mm' | 'm3s' | 'm3' | 'mmin';

/** [surface forms, canonical unit, factor to the canonical unit]. Longest surface wins. */
export const UNITS: readonly (readonly [readonly string[], UnitId, number])[] = [
  [['미터', '메터', 'm', 'meter', 'meters', 'metre', 'metres'], 'm', 1],
  [['킬로미터', 'km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'], 'm', 1000],
  [['센티미터', '센티', 'cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], 'm', 0.01],
  [['도', '°', 'degrees', 'degree', 'deg'], 'deg', 1],
  [['초', 's', 'sec', 'secs', 'second', 'seconds'], 's', 1],
  [['분', 'min', 'mins', 'minute', 'minutes'], 's', 60],
  [['시간', 'h', 'hr', 'hrs', 'hour', 'hours'], 's', 3600],
  [['배', 'x', '×', 'times'], 'x', 1],
  [['배속'], 'speedx', 1],
  [['층', 'floors', 'floor', 'storeys', 'storey', 'stories', 'story'], 'floors', 1],
  [['번째', '번'], 'ord', 1],
  [['%', '퍼센트', 'percent'], 'pct', 1],
  [['j', 'joule', 'joules', '줄'], 'J', 1],
  [['kj', '킬로줄'], 'J', 1e3],
  [['mj', '메가줄'], 'J', 1e6],
  [['gj', '기가줄'], 'J', 1e9],
  [['kg', '킬로그램'], 'kg', 1],
  [['t', '톤', 'ton', 'tons', 'tonne', 'tonnes'], 'kg', 1000],
  [['w', '와트', 'watt', 'watts'], 'W', 1],
  [['kw', '킬로와트'], 'W', 1e3],
  [['mw', '메가와트'], 'W', 1e6],
  [['g'], 'g', 1],
  [['m/s', '미터/초', 'mps', 'm/sec', 'meters per second', 'metres per second'], 'mps', 1],
  [['km/h', 'kph', 'km/hr', 'kilometers per hour', 'kilometres per hour'], 'mps', 1 / 3.6],
  [['km/s', 'kilometers per second', 'kilometres per second'], 'mps', 1000],
  [['m/s2', 'm/s^2', 'meters per second squared', 'metres per second squared'], 'mps2', 1],
  [['mm/h', 'mm/hr', 'mm per hour', 'mm an hour', 'millimeters per hour', 'millimetres per hour'], 'mmh', 1],
  [['mm', '밀리미터', 'millimeters', 'millimetres'], 'mm', 1],
  [['m3/s', 'm^3/s', '세제곱미터/초', 'cubic meters per second', 'cubic metres per second'], 'm3s', 1],
  [['m3', 'm^3', '세제곱미터', '세제곱 미터', '입방미터', 'cubic meters', 'cubic metres', 'cubic meter', 'cubic metre'], 'm3', 1],
  [['m/min', '미터/분', 'meters per minute', 'metres per minute'], 'mmin', 1],
];

/** Joules per kilogram of TNT (blast `energy` from "TNT <n> kg"). */
export const TNT_J_PER_KG = 4.184e6;

/**
 * Disaster field phrases (conventions §2.2): a number with one of `units` becomes field `key` — next to the word
 * `label` (a WORDS id; `@type` = the disaster word itself, e.g. 수위 0.8 m, 2 m 침하), or anywhere when there is no
 * label. `scale` multiplies the canonical-unit value into the field's storage unit; `before`: the label stands before
 * the number only (분당 0.2 m — not "4 m, 분당 …").
 */
export interface FieldPhrase { key: string; units: readonly (UnitId | null)[]; label?: string; scale?: number; before?: boolean }

export const DISASTER_FIELDS: Record<string, readonly FieldPhrase[]> = {
  blast: [
    { key: 'energy', units: ['kg'], label: 'tnt', scale: TNT_J_PER_KG },
    { key: 'energy', units: ['J'] },
    { key: 'height', units: ['m'], label: 'atHeight' },
    { key: 'height', units: ['m'], label: 'height' },
  ],
  earthquake: [
    { key: 'magnitude', units: [null], label: 'magnitude' },
    { key: 'pga', units: [null, 'g'], label: 'pga' },
    { key: 'pga', units: ['g'] },
  ],
  fire: [{ key: 'radius', units: ['m'], label: 'radius' }],
  rain: [{ key: 'intensity', units: ['mm', 'mmh'], label: 'perHour', before: true }, { key: 'intensity', units: ['mmh'] }],
  wind: [{ key: 'speed', units: ['mps', 'm'], label: 'windSpeed' }, { key: 'speed', units: ['mps'] }],
  tornado: [{ key: 'coreRadius', units: ['m'], label: 'coreRadius' }, { key: 'maxSpeed', units: ['mps'], label: 'windSpeed' }],
  risingWater: [{ key: 'riseRate', units: ['m'], label: 'perMinute', before: true }, { key: 'riseRate', units: ['mmin'] }, { key: 'level', units: ['m'], label: 'level' }],
  waterSource: [{ key: 'rate', units: ['m3'], label: 'perSecond', before: true }, { key: 'rate', units: ['m3s'] }],
  impact: [
    { key: 'diameter', units: ['m'], label: 'diameter' },
    { key: 'speed', units: ['mps'], label: 'speedNoun' },
    { key: 'angle', units: ['deg'], label: 'angle' },
  ],
  sinkhole: [{ key: 'cavityRadius', units: ['m'], label: 'radius' }],
  terrainDeformation: [{ key: 'radius', units: ['m'], label: 'radius' }, { key: 'amount', units: ['m'], label: '@type' }],
  heatSource: [{ key: 'power', units: ['W'] }],
  volcano: [{ key: 'rate', units: ['m3'], label: 'perSecond', before: true }, { key: 'rate', units: ['m3s'] }],
  gravity: [{ key: 'magnitude', units: ['mps2'] }],
};

/** Types whose `<t> 동안` / `for <t>` is their `duration` field (s). */
export const DURATION_TYPES: readonly string[] = ['earthquake', 'fire', 'rain', 'wind', 'tornado', 'waterSource', 'heatSource', 'volcano', 'gravity'];

// ── Numerals ────────────────────────────────────────────────────────────────────────────

/** Native Korean numerals — read as a number only with a counter after them (한 채, 스무 그루). */
export const NATIVE_ONES: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
export const NATIVE_TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
/** Native numerals that stand alone (나무 하나). */
export const NATIVE_ALONE: Record<string, number> = { 하나: 1, 둘: 2, 셋: 3, 넷: 4 };
/** Sino-Korean digits — read as a number only with a unit after them (이층, 삼 미터, 십 초). */
export const SINO_DIGITS: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
export const SINO_PLACES: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
/** Units a ONE-syllable Sino-Korean numeral may take (counters like 대 / 동 / 개 would misread 이동, 사대 …). */
export const SINO_UNITS: readonly UnitId[] = ['m', 'deg', 's', 'x', 'floors', 'ord'];
/** Large-number words after digits: 18억, 3만, 2천, 5백. */
export const LARGE_KO: Record<string, number> = { 억: 8, 만: 4, 천: 3, 백: 2 };

export const NUMBERS_EN: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** Phrases that are a number: `a couple of` = 2, `a dozen` = 12, `half a` = 0.5. */
export const NUMBER_PHRASES_EN: Record<string, number> = { 'a couple of': 2, 'a couple': 2, 'a dozen': 12, 'half a': 0.5, 'half an': 0.5 };
export const ORDINALS_EN: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

// ── Particles, prepositions, fillers ─────────────────────────────────────────────────────

/** Particles (after the word they mark) by role — Korean, and the few English words that follow their phrase. */
export const PARTICLES_KO: Record<string, readonly string[]> = {
  obj: ['을', '를'],
  subj: ['이', '가'],
  topic: ['은', '는'],
  at: ['에', '에다', '에다가'],
  from: ['에서', '부터', '에서부터', '서'],
  to: ['으로', '로', '쪽으로'],
  upto: ['까지'],
  gen: ['의'],
  also: ['도', 'too', 'also', 'as well'],
  and: ['와', '과', '랑', '이랑', '하고'],
  only: ['만'],
  like: ['처럼', '같이'],
  called: ['이라고', '라고'],
};

/** English prepositions (before the phrase they mark) by role. */
export const PREPOSITIONS_EN: Record<string, readonly string[]> = {
  at: ['at', 'in', 'on', 'onto', 'into'],
  to: ['to'],
  from: ['from'],
  of: ['of'],
  by: ['by'],
  with: ['with'],
  as: ['as'],
  for: ['for'],
  like: ['like'],
};

/** Words that never change the meaning (politeness, endings, articles) — conventions §1. */
export const FILLERS: Words = {
  ko: [
    '해', '해줘', '해 줘', '해주세요', '해 주세요', '하세요', '할래', '해라', '합니다', '해요', '하자', '해봐', '해 봐', '해줄래', '해 줄래', '해주라',
    '줘', '주세요', '주십시오', '줄래', '줄래요', '주라', '봐줘', '좀', '제발', '그냥', '부탁해', '부탁합니다', '고마워', '감사합니다', '야', '이야', '요', '이에요', '예요', '입니다', '인', '인가요', '이죠',
    '있어', '있어요', '있나요', '있니', '있나', '있지', '있습니까', '있죠', '입니까', '인가', '일까', '시켜', '시켜줘', '시켜 줘', '되게', '짜리', '짜리의', '에 있는', '인지',
    '해주십시오', '하십시오', '해 주시겠어요', '주시겠어요', '해 줄 수 있어', '줄 수 있어',
  ],
  en: [
    'the', 'a', 'an', 'please', 'pls', 'thanks', 'thank you', 'could you', 'can you', 'would you', 'i want to', "i'd like to", 'i would like to', "let's", 'lets', 'just', 'kindly',
    'is', 'are', 'be', 'are there', 'is there', 'there are', 'there is', 'do i have', 'that are', 'that is', "'s", "'", 'for me', 'now please',
  ],
};

/** Clause separators (conventions §4), besides `,` `;` and the connective verb endings -고 / -서. */
export const SEPARATORS: Words = {
  ko: ['그리고', '그 다음', '그 다음에', '그다음', '그다음에', '그런 다음', '그런 다음에', '그리고 나서', '해서', '하고 나서'],
  en: ['and', 'then', 'and then', 'after that'],
};

/**
 * Negation / prohibition (conventions §5) — a sentence that matches is never a command. Regular-expression sources,
 * tested on the normalised text (quoted names removed). `NEGATION_ALLOWED` are the listed phrases that contain a marker
 * and are commands all the same ("아무것도 선택하지 마" = select none, "안 잠긴" = unlocked).
 */
export const NEGATION: readonly string[] = [
  '(?<!까)지\\s*(?:마|말|않|못)', '말고', '빼고', '않', '없이', '(?:^|\\s)안\\s+', '(?:^|\\s)못\\s+',
  "\\b(?:don't|dont|do not|does not|doesn't|never|except|but not|without|not|cannot|can't|won't|shouldn't|no longer)\\b",
];
export const NEGATION_ALLOWED: readonly string[] = ['아무것도\\s*선택하지\\s*(?:마세요|말아\\s*줘|마)', '안\\s*잠긴', '안\\s*잠겨\\s*있는', 'select nothing'];

/** Conditionals and loops (conventions §5) — never a command. */
export const CONDITIONAL: readonly string[] = [
  '\\b(?:if|unless|until|whenever|while|when|each time|repeat|repeatedly|loop)\\b', '\\bevery\\s+(?:other|few|\\d+(?:\\.\\d+)?\\s*(?:s|sec|secs|seconds?|min|mins|minutes?|h|hrs?|hours?)\\b|(?:second|minute|hour|frame|time)\\b)', '(?:하|되|이|오|나|넘으|끝나|시작하|시작되|으)면(?=[\\s,.!?]|$)', '때마다', '마다', '될 때까지',
];

// ── Verbs ───────────────────────────────────────────────────────────────────────────────

/** A Korean verb: [stem (before -고 / -자 / -세요), 아/어 form(s) (the command itself; before 줘 / 서 / 라 / 요)…]. */
export type KoVerb = readonly [stem: string, ...aForms: string[]];

export interface VerbWords {
  /** Conjugated verbs: forms are generated (놓아, 놓고, 놓아서, 놓으세요 …). */
  ko?: readonly KoVerb[];
  /** Verbal nouns and other fixed forms (배치 → 배치 / 배치해 / 배치하고 …: the light verb is a separate word). */
  noun?: readonly string[];
  en?: readonly string[];
}

export const VERBS: Record<string, VerbWords> = {
  // §3.1 place — also the placing verbs of a disaster (놓아 · 배치 · 추가 · 넣어 / place · put · add)
  place: { ko: [['놓', '놓아', '놔'], ['짓', '지어'], ['세우', '세워'], ['깔', '깔아'], ['두', '두어', '둬'], ['넣', '넣어']], noun: ['배치', '지으세요', '지을래'], en: ['place', 'put', 'build', 'drop', 'set up'] },
  create: { ko: [['만들', '만들어']], en: ['create'] },
  add: { noun: ['추가'], en: ['add'] },
  plant: { ko: [['심', '심어']], en: ['plant'] },
  park: { noun: ['주차'], en: ['park'] },
  draw: { ko: [['그리', '그려']], en: ['draw'] },
  // §3.3 select
  select: { ko: [['고르', '골라'], ['집', '집어']], noun: ['선택'], en: ['select', 'pick', 'choose', 'highlight'] },
  selAdd: { noun: ['추가 선택', '선택에 추가'], en: ['also select'] },
  selRemove: { ko: [['선택에서 빼', '선택에서 빼']], noun: ['선택에서 제외'], en: [] },
  /** 선택에서 … 빼: take out of the selection (with 선택에서). */
  takeOut: { ko: [['빼', '빼']], noun: ['제외'] },
  deselect: { noun: ['선택 해제', '선택 취소'], en: ['deselect', 'unselect'] },
  selNone: { noun: ['아무것도 선택하지 마', '아무것도 선택하지 마세요', '아무것도 선택하지 말아 줘'], en: ['clear the selection', 'clear selection', 'select nothing', 'deselect all', 'deselect everything'] },
  // §3.4 transform
  move: { ko: [['옮기', '옮겨'], ['움직이', '움직여']], noun: ['이동'], en: ['move', 'shift'] },
  rotate: { ko: [['돌리', '돌려']], noun: ['회전'], en: ['rotate', 'turn', 'spin'] },
  scale: { en: ['scale', 'resize'] },
  set: { noun: ['설정'], en: ['set'] },
  // §3.5 align · distribute · match
  align: { ko: [['맞추', '맞춰']], noun: ['정렬'], en: ['align', 'line up'] },
  /** "centre them horizontally": align the centres on an axis. */
  centre: { en: ['centre', 'center'] },
  distribute: { noun: ['분배'], en: ['distribute', 'space'] },
  give: { en: ['give'] },
  /** "make it bigger", "make them the same size", "make … visible again": the verb carries no meaning of its own. */
  make: { en: ['make'] },
  // §3.7
  group: { ko: [['묶', '묶어']], noun: ['그룹화'], en: ['group'] },
  ungroup: { noun: ['그룹 해제'], en: ['ungroup'] },
  release: { ko: [['풀', '풀어']], noun: ['해제'] },
  rename: { en: ['rename', 'name'] },
  call: { ko: [['부르', '불러']], en: ['call'] },
  change: { ko: [['바꾸', '바꿔']], en: ['change'] },
  hide: { ko: [['숨기', '숨겨'], ['감추', '감춰']], en: ['hide'] },
  unhide: { noun: ['표시', '숨김 해제', '보이게', '다시 보이게'], en: ['unhide'] },
  show: { ko: [['보이', '보여']], en: ['show', 'show me'] },
  lock: { ko: [['잠그', '잠가']], noun: ['잠금'], en: ['lock'] },
  unlock: { noun: ['잠금 해제', '잠금 풀어'], en: ['unlock'] },
  delete: { ko: [['지우', '지워'], ['없애', '없애']], noun: ['삭제', '제거'], en: ['delete', 'remove', 'erase', 'get rid of'] },
  duplicate: { noun: ['복제', '복사', '복사해서', '복제해서'], en: ['duplicate', 'copy', 'clone'] },
  // §3.9 terrain
  raise: { ko: [['올리', '올려'], ['높이', '높여'], ['쌓', '쌓아']], en: ['raise', 'lift'] },
  lower: { ko: [['내리', '내려'], ['낮추', '낮춰'], ['파', '파'], ['파내', '파내']], en: ['lower', 'dig'] },
  flatten: { noun: ['평탄화'], en: ['flatten', 'level'] },
  smooth: { en: ['smooth'] },
  paint: { ko: [['칠하', '칠해']], noun: ['칠'], en: ['paint'] },
  // §2.2 run verbs of a disaster
  trigger: {
    ko: [['발생시키', '발생시켜'], ['일으키', '일으켜'], ['터뜨리', '터뜨려'], ['터트리', '터트려'], ['쏟아붓', '쏟아부어']],
    noun: ['시작', '불게 해', '불게'],
    en: ['trigger', 'start', 'make', 'cause', 'set off', 'unleash', 'detonate'],
  },
  /** Run verbs that only the old grammar's sentences use (물을 공급해줘, Generate a magnitude 6.5 earthquake). */
  legacyRun: { noun: ['발생'], en: ['generate', 'pour'] },
  /** 공급해 / supply runs a water source (§6 D2). */
  supply: { ko: [['공급하', '공급해']], en: ['supply'] },
  // §3.11 run control and placed disasters
  run: { ko: [['돌리', '돌려']], noun: ['실행', '시작', '재생'], en: ['run', 'start', 'play', 'go'] },
  pauseSim: { ko: [['멈추', '멈춰']], noun: ['일시정지', '일시 정지', '정지', '잠깐'], en: ['pause', 'stop', 'hold'] },
  reset: { noun: ['처음으로', '리셋', '초기화', '다시 처음부터', '다시 시작'], en: ['reset', 'restart', 'start over'] },
  stop: { ko: [['멈추', '멈춰']], noun: ['정지'], en: ['stop'] },
  pause: { noun: ['일시정지', '일시 정지'], en: ['pause'] },
  resume: { noun: ['계속', '다시 시작', '재개'], en: ['resume', 'continue'] },
  /** 지진 취소 / cancel the fire takes a placed disaster out of the plan (§6 D15). */
  cancel: { noun: ['취소'], en: ['cancel'] },
  // §3.12 camera
  look: { ko: [['보', '봐']], noun: ['확대'], en: ['look at', 'zoom to', 'zoom in on', 'focus on', 'focus'] },
  go: { ko: [['가', '가']], en: ['go to'] },
  /** 이동 with a place and no object is the camera (n4로 이동); with an object it is a move. */
  travel: { noun: ['이동'] },
  // §3.13 queries
  tell: { ko: [['알리', '알려']], en: ['tell me about', 'tell me'] },
  // §3.14 undo
  undo: { ko: [['되돌리', '되돌려']], noun: ['취소', '실행 취소', '실행취소'], en: ['undo', 'revert', 'take that back'] },
  redo: { ko: [['되살리', '되살려']], noun: ['다시 실행', '다시 해', '다시실행'], en: ['redo'] },
};

/** Light-verb forms that end a clause and start the next (선택하고, 묶어서 → generated; these stand alone after a noun). */
export const LIGHT_CONNECTIVES: readonly string[] = ['하고', '해서', '시키고', '시켜서', '해 주고', '해주고'];

// ── Grammar words ───────────────────────────────────────────────────────────────────────

/** Every other word a rule looks for, by id (`dir:north`, `rank:tallest` …). */
export const WORDS: Record<string, Words> = {
  // §2.3 targets
  'det:selection': {
    ko: ['이것', '이거', '이것들', '이거들', '이걸', '선택한 것', '선택한 거', '선택한 것들', '선택된 것', '선택된 것들', '선택 영역', '선택한 물체', '선택한 객체'],
    en: ['this', 'these', 'this one', 'selection', 'the selection', 'the selected ones', 'selected ones', 'the selected', 'selected objects', 'the selected objects'],
  },
  'det:this': { ko: ['이'], en: [] },
  'det:last': {
    ko: ['방금 만든 것', '방금 만든 것들', '방금 만든 거', '방금 놓은 것', '방금 놓은 것들', '방금 놓은 거', '방금 거', '방금 것', '아까 만든 것', '아까 만든 것들'],
    en: ['the ones i just made', 'the ones i just placed', 'what i just made', 'what i just placed', 'the new ones', 'new ones', 'the one i just made', 'the one i just placed'],
  },
  'det:lastOf': { ko: ['방금 만든', '방금 놓은', '아까 만든', '아까 놓은'], en: ['i just made', 'i just placed'] },
  'det:it': { ko: ['그것', '그거', '그것들', '그거들', '그걸', '걔네'], en: ['it', 'them', 'those', 'that'] },
  all: { ko: ['전부', '모두', '다', '모든 것', '모든', '전체'], en: ['everything', 'all', 'every', 'all of', 'all the', 'all of the'] },
  plural: { ko: ['들'], en: [] },
  thing: { ko: ['것', '거', '것들', '곳'], en: ['ones', 'thing', 'things', 'objects'] },
  groupNoun: { ko: ['그룹'], en: ['group', 'groups'] },
  nameNoun: { ko: ['이름'], en: ['name'] },
  called: { ko: [], en: ['called', 'named'] },
  // §2.3 filters
  slope: { ko: ['경사', '경사가', '기울기'], en: ['slope', 'slopes'] },
  steeper: { ko: [], en: ['steeper than'] },
  'cmp:gt': { ko: ['넘는', '초과', '초과인', '초과하는', '넘은'], en: ['over', 'more than', 'greater than', 'above'] },
  'cmp:ge': { ko: ['이상', '이상인', '이상의'], en: ['at least', 'or more'] },
  'cmp:lt': { ko: ['미만', '미만인', '미만의', '아래'], en: ['under', 'less than', 'below'] },
  'cmp:le': { ko: ['이하', '이하인', '이하의'], en: ['at most', 'or less'] },
  height: { ko: ['높이'], en: ['height'] },
  taller: { ko: [], en: ['taller than', 'higher than'] },
  shorter: { ko: [], en: ['shorter than', 'lower than'] },
  near: { ko: ['근처', '부근'], en: ['near'] },
  within: { ko: ['안', '안의', '안에', '이내', '이내의', '이내에'], en: ['within'] },
  'flag:hidden': { ko: ['숨긴', '숨겨진'], en: ['hidden'] },
  'flag:visible': { ko: ['보이는'], en: ['visible'] },
  'flag:locked': { ko: ['잠긴'], en: ['locked'] },
  'flag:unlocked': { ko: ['안 잠긴'], en: ['unlocked'] },
  warning: { ko: ['경고', '문제'], en: ['warning', 'warnings'] },
  brace: { ko: ['가새'], en: ['brace'] },
  exist: { ko: ['있는', '가 있는', '이 있는'], en: ['have', 'has', 'having', 'that have'] },
  'rank:largest': { ko: ['가장 큰', '제일 큰'], en: ['largest', 'biggest'] },
  'rank:tallest': { ko: ['가장 높은', '제일 높은'], en: ['tallest', 'highest'] },
  'rank:nearest': { ko: ['가장 가까운', '제일 가까운'], en: ['nearest', 'closest'] },
  first: { ko: ['첫 번째', '첫', '처음', '앞의', '맨 앞'], en: ['first', '1st'] },
  // §2.4 places
  'place:cursor': { ko: ['여기', '이곳', '이 자리'], en: ['here', 'this spot'] },
  'place:view': { ko: ['저기', '저곳'], en: ['over there', 'there'] },
  'place:last': { ko: ['거기'], en: ['back there'] },
  'place:center': { ko: ['가운데', '중앙', '지도 중앙', '지도 가운데', '한가운데'], en: ['center', 'centre', 'middle', 'the middle of the map', 'the centre of the map', 'the center of the map', 'map centre', 'map center'] },
  'place:junction': { ko: ['교차로', '사거리', '삼거리'], en: ['junction', 'intersection', 'crossroads'] },
  nodeNoun: { ko: ['노드'], en: ['node'] },
  segNoun: { ko: ['구간'], en: ['segment'] },
  coordNoun: { ko: ['좌표'], en: ['coordinates', 'coordinate'] },
  'feature:hill': { ko: ['언덕'], en: ['hill'] },
  'feature:mountain': { ko: ['산'], en: ['mountain'] },
  'feature:lake': { ko: ['호수'], en: ['lake'] },
  'feature:river': { ko: ['강'], en: ['river'] },
  'dir:north': { ko: ['북쪽', '북'], en: ['north', 'northern'] },
  'dir:south': { ko: ['남쪽', '남'], en: ['south', 'southern'] },
  'dir:east': { ko: ['동쪽'], en: ['east', 'eastern'] },
  'dir:west': { ko: ['서쪽'], en: ['west', 'western'] },
  'dir:up': { ko: ['위', '위로', '위쪽'], en: ['up', 'upward', 'upwards'] },
  'dir:down': { ko: ['아래', '아래로', '아래쪽', '밑으로'], en: ['down', 'downward', 'downwards'] },
  'dir:left': { ko: ['왼쪽', '좌측'], en: ['left'] },
  'dir:right': { ko: ['오른쪽', '우측'], en: ['right'] },
  'dir:forward': { ko: ['앞', '앞으로', '앞쪽'], en: ['forward', 'forwards', 'ahead'] },
  'dir:back': { ko: ['뒤', '뒤로', '뒤쪽'], en: ['back', 'backward', 'backwards'] },
  'diag:NE': { ko: ['북동', '북동쪽', '동북쪽'], en: ['north east', 'northeast', 'north eastern', 'northeastern'] },
  'diag:NW': { ko: ['북서', '북서쪽', '서북쪽'], en: ['north west', 'northwest', 'north western', 'northwestern'] },
  'diag:SE': { ko: ['남동', '남동쪽', '동남쪽'], en: ['south east', 'southeast', 'south eastern', 'southeastern'] },
  'diag:SW': { ko: ['남서', '남서쪽', '서남쪽'], en: ['south west', 'southwest', 'south western', 'southwestern'] },
  'diag:any': { ko: ['대각선', '대각선으로'], en: ['diagonally'] },
  next: { ko: ['옆', '곁'], en: ['next to', 'beside'] },
  on: { ko: ['위'], en: ['on top of'] },
  between: { ko: ['사이', '사이의'], en: ['between'] },
  // §2.5 roads
  'road:main': { ko: ['큰길', '대로', '간선도로'], en: ['main road', 'main street', 'avenue'] },
  'road:any': { ko: ['도로', '길'], en: ['road', 'street', 'roads', 'streets'] },
  'road:nearest': { ko: ['이 도로', '여기 도로', '가장 가까운 도로'], en: ['this road', 'the nearest road', 'nearest road', 'the closest road'] },
  // §3.1 place
  gap: { ko: ['간격'], en: ['gap', 'gaps', 'apart', 'spacing'] },
  spaced: { ko: ['띄워서', '띄워', '띄우고', '씩 띄워서', '씩 띄워', '씩'], en: ['spaced'] },
  touching: { ko: ['붙여서', '맞닿게', '붙여'], en: ['touching', 'side by side'] },
  heading: { ko: ['방향'], en: ['heading', 'facing'] },
  face: { ko: ['보게', '을 보게', '를 보게', '향하게', '바라보게'], en: ['face', 'faces'] },
  both: { ko: ['양쪽', '양옆', '양편'], en: ['both sides', 'both sides of', 'either side'] },
  side: { ko: ['쪽', '편', '끝'], en: ['side', 'sides', 'edge', 'edges'] },
  along: { ko: ['따라', '을 따라', '를 따라'], en: ['along'] },
  // §3.2 forest
  forest: { ko: ['숲', '조림'], en: ['forest', 'woods'] },
  density: { ko: ['밀도'], en: ['density'] },
  'dens:low': { ko: ['낮게', '성기게', '듬성듬성'], en: ['sparse', 'thin', 'low density', 'low'] },
  'dens:high': { ko: ['높게', '빽빽하게', '울창하게'], en: ['dense', 'thick', 'high density', 'high'] },
  'dens:medium': { ko: ['보통'], en: ['medium', 'normal', 'medium density'] },
  seed: { ko: ['시드'], en: ['seed'] },
  // §3.3 select
  selectionNoun: { ko: ['선택'], en: ['the selection', 'selection'] },
  // §3.4 transform
  clockwise: { ko: ['시계 방향', '시계 방향으로', '시계방향', '시계방향으로'], en: ['clockwise'] },
  counterclockwise: { ko: ['반시계', '반시계 방향', '반시계 방향으로', '반시계방향', '반시계방향으로'], en: ['counter clockwise', 'counterclockwise', 'anticlockwise', 'anti clockwise'] },
  around180: { ko: ['반대로', '뒤로 돌려', '뒤로 돌려줘'], en: ['turn around', 'around'] },
  bigger: { ko: ['크게', '키워'], en: ['bigger', 'larger', 'as big', 'as large'] },
  smaller: { ko: ['작게', '줄여'], en: ['smaller'] },
  double: { ko: [], en: ['twice', 'double'] },
  half: { ko: ['절반', '반'], en: ['half', 'half the size', 'halve'] },
  little: { ko: ['조금', '조금만', '약간', '살짝', '더', '좀 더'], en: ['a bit', 'a little', 'slightly', 'more', 'a little bit'] },
  'axis:x': { ko: ['x', 'x 좌표', 'x좌표'], en: ['x', 'x coordinate'] },
  'axis:y': { ko: ['y', 'y 좌표', 'y좌표'], en: ['y', 'y coordinate'] },
  'axis:z': { ko: ['z', 'z 좌표', 'z좌표'], en: ['z', 'z coordinate'] },
  aboveGround: { ko: ['지면 위', '지면에서', '지면 위로'], en: ['above the ground', 'above ground', 'off the ground'] },
  lifted: { ko: ['띄워', '띄워줘'], en: [] },
  onGround: { ko: ['지면에 붙여', '지면에 붙여줘', '바닥에 붙여', '땅에 붙여'], en: ['to the ground', 'onto the ground', 'on the ground'] },
  // §3.5 align · distribute · match
  centerH: { ko: ['가로 가운데', 'x 가운데'], en: ['centre horizontally', 'center horizontally', 'centres on x', 'centers on x'] },
  centerV: { ko: ['세로 가운데', 'z 가운데'], en: ['centre vertically', 'center vertically', 'centres on z', 'centers on z'] },
  top: { ko: ['위쪽'], en: ['top', 'tops'] },
  bottom: { ko: ['아래쪽'], en: ['bottom', 'bottoms'] },
  front: { ko: ['앞쪽', '정면'], en: ['front', 'fronts'] },
  backEdge: { ko: ['뒤쪽', '뒷면'], en: ['back', 'backs'] },
  'ref:footprint': { ko: ['바닥면', '가장자리', '외곽'], en: ['footprint', 'footprints', 'their edges', 'outline', 'outlines'] },
  'ref:origin': { ko: ['원점', '중심점'], en: ['origin', 'origins', 'pivot', 'pivots'] },
  basis: { ko: ['기준', '기준으로'], en: [] },
  evenly: { ko: ['같은 간격으로', '같은 간격', '간격 맞춰', '고르게', '균등하게', '균등 간격'], en: ['evenly', 'equal gaps', 'equally'] },
  'daxis:x': { ko: ['동서로', '가로로', '동서 방향으로'], en: ['east west', 'horizontally'] },
  'daxis:z': { ko: ['남북으로', '세로로', '남북 방향으로'], en: ['north south', 'vertically'] },
  byOrigins: { ko: ['원점 간격', '원점 간격으로', '중심 간격'], en: ['by origins', 'equal spacing of centres', 'equal spacing of centers'] },
  same: { ko: ['같은', '똑같은', '같게'], en: ['same'] },
  sameWay: { ko: ['같은 방향으로', '방향 맞춰'], en: ['face the same way'] },
  // §3.6 properties
  'prop:structure': { ko: ['구조'], en: ['structure'] },
  'prop:scale': { ko: ['크기'], en: ['size', 'scale'] },
  'prop:heading': { ko: ['방향'], en: ['heading', 'direction'] },
  'prop:params': { ko: ['매개변수', '설정'], en: ['parameters', 'params', 'settings'] },
  'prop:physics': { ko: ['물성', '물리'], en: ['physics', 'material properties'] },
  // §3.7 duplicate
  apartBy: { ko: ['떨어뜨려', '떨어뜨려서', '떨어진 곳에', '떨어져서'], en: ['away'] },
  again: { ko: ['다시'], en: ['again'] },
  // §3.8 roads
  laneCount: { ko: ['차로', '차선'], en: ['lanes'] },
  'preset:street': { ko: ['2차로', '이차선', '2차선', '이차로'], en: ['two lane', '2 lane'] },
  'preset:avenue': { ko: ['4차로', '사차선', '4차선', '사차로'], en: ['four lane', '4 lane'] },
  'preset:narrow': { ko: ['좁은'], en: ['narrow'] },
  'preset:wide': { ko: ['넓은'], en: ['wide'] },
  'preset:lane': { ko: ['골목', '골목길'], en: ['lane', 'alley'] },
  'preset:gravel': { ko: ['자갈길'], en: ['gravel road', 'gravel'] },
  'preset:dirt': { ko: ['흙길', '비포장', '비포장 도로'], en: ['dirt road', 'dirt', 'unpaved'] },
  // §3.9 terrain and areas
  ground: { ko: ['땅', '지면', '지형', '바닥'], en: ['ground', 'terrain', 'land'] },
  flat: { ko: ['평평하게', '평탄하게', '고르게', '평평히'], en: ['flat'] },
  smoothly: { ko: ['부드럽게', '매끄럽게'], en: [] },
  radius: { ko: ['반경', '반지름'], en: ['radius'] },
  diameter: { ko: ['지름', '직경'], en: ['diameter', 'across'] },
  circle: { ko: ['원'], en: ['circle'] },
  rect: { ko: ['사각형', '직사각형'], en: ['rectangle', 'rect'] },
  around: { ko: ['주변', '둘레'], en: ['around'] },
  'ground:grass': { ko: ['잔디', '풀'], en: ['grass'] },
  'ground:soil': { ko: ['흙'], en: ['soil'] },
  'ground:sand': { ko: ['모래'], en: ['sand'] },
  'ground:asphalt': { ko: ['아스팔트'], en: ['asphalt'] },
  'ground:concrete': { ko: ['콘크리트'], en: ['concrete'] },
  'ground:gravel': { ko: ['자갈'], en: ['gravel'] },
  'ground:rock': { ko: ['암반', '바위'], en: ['rock'] },
  'ground:mud': { ko: ['진흙'], en: ['mud'] },
  'ground:riverbed': { ko: ['강바닥'], en: ['riverbed'] },
  // §2.2 disaster field phrases
  tnt: { ko: ['tnt'], en: ['tnt'] },
  magnitude: { ko: ['규모'], en: ['magnitude'] },
  pga: { ko: ['pga'], en: ['pga'] },
  during: { ko: ['동안', '간'], en: [] },
  perHour: { ko: ['시간당'], en: [] },
  perMinute: { ko: ['분당'], en: [] },
  perSecond: { ko: ['초당'], en: [] },
  windSpeed: { ko: ['풍속', '초속'], en: ['wind speed'] },
  speedNoun: { ko: ['속도'], en: ['speed'] },
  angle: { ko: ['각도'], en: ['angle'] },
  coreRadius: { ko: ['중심 반경'], en: ['core radius'] },
  level: { ko: ['수위'], en: ['water level'] },
  boundary: { ko: ['경계'], en: ['boundary', 'edge of the map'] },
  'wind:N': { ko: ['북풍'], en: ['northerly'] },
  'wind:NE': { ko: ['북동풍'], en: ['northeasterly'] },
  'wind:E': { ko: ['동풍'], en: ['easterly'] },
  'wind:SE': { ko: ['남동풍'], en: ['southeasterly'] },
  'wind:S': { ko: ['남풍'], en: ['southerly'] },
  'wind:SW': { ko: ['남서풍'], en: ['southwesterly'] },
  'wind:W': { ko: ['서풍'], en: ['westerly'] },
  'wind:NW': { ko: ['북서풍'], en: ['northwesterly'] },
  toward: { ko: [], en: ['toward', 'towards'] },
  after: { ko: ['뒤', '뒤에', '후', '후에', '이후', '이후에'], en: ['after', 'later', 'from now'] },
  atHeight: { ko: ['높이에서'], en: ['at a height of'] },
  // §3.11
  simNoun: { ko: ['시뮬레이션', '시뮬'], en: ['simulation', 'the simulation', 'sim'] },
  disasterNoun: { ko: ['재난', '재해'], en: ['disaster', 'disasters'] },
  faster: { ko: ['빠르게', '느리게', '빨리', '천천히'], en: ['faster', 'slower'] },
  halfSpeed: { ko: ['절반 속도', '반속'], en: ['half speed'] },
  normalSpeed: { ko: ['정상 속도', '보통 속도'], en: ['normal speed'] },
  // §3.13 queries
  howMany: { ko: ['몇', '몇 채', '몇 개', '몇 그루', '몇 대', '몇 명', '몇 동', '개수', '몇 개나'], en: ['how many', 'number of', 'the number of'] },
  which: { ko: ['어떤', '어느'], en: ['which', 'what'] },
  listNoun: { ko: ['목록', '나열', '리스트'], en: ['list'] },
  distance: { ko: ['거리', '얼마나 떨어져', '얼마나 떨어져 있어', '얼마나 멀어'], en: ['how far', 'distance', 'the distance'] },
  howBig: { ko: ['넓이', '면적'], en: ['how tall', 'how big', 'how high', 'how large', 'how wide'] },
  info: { ko: ['정보', '뭐야', '뭐지', '무엇'], en: ['info', 'information', 'what is', "what's", 'what are'] },
  damage: { ko: ['피해', '얼마나 무너졌어', '붕괴 현황', '피해 현황', '피해 상황'], en: ['damage', 'how much collapsed', 'collapse summary'] },
};

// ── Words of the old grammar (src/commands) the adapter lets through ─────────────────────

/**
 * Words that only the old disaster grammar reads (relative starts, simultaneity, its control words). A legacy sentence
 * may contain these besides disaster names, run verbs, numbers and directions — and nothing else.
 */
export const LEGACY_WORDS: Words = {
  ko: ['시작되고', '시작하고', '발생하고', '끝나고', '종료되고', '시작되면', '동시에', '함께', '지점', '만큼', '중지', '원래대로', '슬로우', '슬로우 모션', '실시간'],
  en: ['begins', 'starts', 'started', 'ends', 'ended', 'stops', 'stopped', 'finishes', 'simultaneously', 'together', 'halt', 'restore', 'slow motion', 'real time', 'fast'],
};

// ── Suggestions ─────────────────────────────────────────────────────────────────────────

/** Template commands per class (shown as "nearest commands" when a sentence is not understood). `tags`: word ids / verb ids / `kind` / `disaster`. */
export const TEMPLATES: readonly { text: string; tags: readonly string[] }[] = [
  { text: 'place building:house count=3 along=road:main side=north gap=2', tags: ['place', 'create', 'add', 'kind', 'road:main', 'gap'] },
  { text: 'place tree at=cursor', tags: ['place', 'plant', 'kind', 'place:cursor'] },
  { text: 'place car count=5 along=road:any', tags: ['place', 'park', 'kind', 'road:any'] },
  { text: 'forest feature:hill density=low', tags: ['forest', 'plant', 'density'] },
  { text: 'select type:tree where slope>20', tags: ['select', 'slope', 'kind'] },
  { text: 'select none', tags: ['deselect', 'selNone', 'select'] },
  { text: 'move selection by=5,0,0', tags: ['move', 'dir:east', 'dir:west', 'dir:north', 'dir:south', 'raise', 'lower'] },
  { text: 'move selection to=cursor', tags: ['move', 'place:cursor'] },
  { text: 'rotate selection by=30', tags: ['rotate', 'clockwise', 'counterclockwise'] },
  { text: 'scale selection x2', tags: ['scale', 'bigger', 'smaller', 'double', 'half'] },
  { text: 'set selection x=10', tags: ['set', 'axis:x', 'axis:y', 'axis:z', 'aboveGround'] },
  { text: 'align selection edge=front ref=footprint', tags: ['align', 'front', 'backEdge', 'ref:footprint'] },
  { text: 'distribute selection axis=auto gaps', tags: ['distribute', 'evenly'] },
  { text: 'match selection heading', tags: ['same', 'sameWay', 'prop:heading'] },
  { text: 'copy structure from=(selection first 1) to=selection', tags: ['duplicate', 'give', 'prop:structure', 'same'] },
  { text: 'group last name="North block"', tags: ['group', 'groupNoun', 'nameNoun'] },
  { text: 'rename selection "North block"', tags: ['rename', 'call', 'nameNoun'] },
  { text: 'hide type:tree', tags: ['hide', 'flag:hidden'] },
  { text: 'show all where hidden', tags: ['unhide', 'show', 'flag:hidden'] },
  { text: 'lock selection', tags: ['lock', 'unlock'] },
  { text: 'delete selection', tags: ['delete'] },
  { text: 'duplicate selection offset=10,0', tags: ['duplicate'] },
  { text: 'terrain flatten circle cursor r=10', tags: ['flatten', 'flat', 'raise', 'lower', 'smooth', 'ground', 'radius'] },
  { text: 'paint circle cursor r=10 ground=grass', tags: ['paint', 'ground'] },
  { text: 'road node:n4 -> 40,60 preset=street', tags: ['draw', 'road:any', 'preset:street'] },
  { text: 'disaster blast at=junction energy=1.8e9 start=5', tags: ['disaster', 'trigger', 'after'] },
  { text: 'disaster earthquake stop', tags: ['stop', 'pause', 'resume', 'disaster'] },
  { text: 'run', tags: ['run', 'simNoun'] },
  { text: 'pause', tags: ['pauseSim', 'simNoun'] },
  { text: 'reset', tags: ['reset'] },
  { text: 'speed=2', tags: ['speedNoun', 'halfSpeed', 'normalSpeed'] },
  { text: 'focus type:building tallest', tags: ['look', 'show', 'go', 'rank:tallest'] },
  { text: 'count type:building', tags: ['howMany'] },
  { text: 'list type:building where warning', tags: ['which', 'listNoun', 'warning'] },
  { text: 'measure selection', tags: ['distance', 'howBig', 'height'] },
  { text: 'info selection', tags: ['info', 'tell', 'damage'] },
  { text: 'undo', tags: ['undo', 'redo'] },
];
