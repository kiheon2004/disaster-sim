/**
 * Phase 37 (§6, NL-CONVENTIONS §1): text normalisation — scientific notation before NFKC, Korean large numbers,
 * Korean / English numerals with counters and units, units → canonical units, quotes kept literal.
 * Expected values are written by hand from the conventions.
 */
import { describe, expect, it } from 'vitest';
import { normalizeText, quantities, readQuantity, readUnit, QUOTE_OPEN, QUOTE_CLOSE, ID_OPEN, ID_CLOSE } from './normalize';

const q = (text: string) => quantities(normalizeText(text).text).map((x) => [x.value, x.unit] as [number, string | null]);
const one = (text: string) => { const all = q(text); expect(all, text).toHaveLength(1); return all[0]; };

describe('normalizeText', () => {
  it('scientific notation is read before NFKC (which alone would turn 10⁹ into 109)', () => {
    for (const s of ['1.8×10⁹', '1.8 x 10^9', '1.8*10**9', '1.8e9', '1.8E+9', '1.8 × 10⁹', '１．８×１０⁹', '1.8·10^9']) {
      expect(one(`${s} J`), s).toEqual([1.8e9, 'J']);
    }
    expect('10⁹'.normalize('NFKC')).toBe('109'); // the trap (audit D5)
    expect(one('10⁹ J')).toEqual([1e9, 'J']);
    expect(one('10^6 J')).toEqual([1e6, 'J']);
    expect(one('2.5×10⁻³ m')).toEqual([0.0025, 'm']);
    // a superscript that is a unit, not a power of ten
    expect(one('5 m³/s')).toEqual([5, 'm3s']);
    expect(one('9.81 m/s²')).toEqual([9.81, 'mps2']);
  });

  it('full-width text, case, spaces', () => {
    expect(normalizeText('ＰＬＡＣＥ　Ｔｒｅｅ').text).toBe('place tree');
    expect(normalizeText('  Move   The Selection  ').text).toBe('move the selection');
    expect(one('５ｍ')).toEqual([5, 'm']);
  });

  it('Korean large numbers after digits', () => {
    expect(one('18억')).toEqual([1.8e9, null]);
    expect(one('3만')).toEqual([30000, null]);
    expect(one('2천')).toEqual([2000, null]);
    expect(one('5백')).toEqual([500, null]);
    expect(one('1억 5천만')).toEqual([1.5e8, null]);
    expect(one('2.5만')).toEqual([25000, null]);
    expect(one('1.8억 J')).toEqual([1.8e8, 'J']);
    expect(one('18억 줄')).toEqual([1.8e9, 'J']);
    expect(one('3만 5천')).toEqual([35000, null]);
    // 만들어 / 천천히 are words, not numbers
    expect(normalizeText('주택 3 만들어').text).toBe('주택 3 만들어');
    expect(normalizeText('2 천천히').text).toBe('2 천천히');
  });

  it('thousands separators only in groups of three; 40,60 stays a pair', () => {
    expect(one('1,800,000 J')).toEqual([1800000, 'J']);
    expect(normalizeText('40,60').text).toBe('40,60');
    expect(normalizeText('(100,200)').text).toBe('(100,200)');
    expect(normalizeText('12,5').text).toBe('12,5');
    // two groups: a number only with a unit after it — "100,200에" is a point
    expect(one('TNT 1,800 kg')).toEqual([1800, 'kg']);
    expect(one('1,200채')).toEqual([1200, 'count']);
    expect(normalizeText('100,200에 나무').text).toBe('100,200에 나무');
  });

  it('quoted text is literal and never normalised; a #id keeps its case', () => {
    const n = normalizeText("묶어서 '북쪽 블록'이라고 해");
    expect(n.quotes).toEqual(['북쪽 블록']);
    expect(n.text).toBe(`묶어서 ${QUOTE_OPEN}0${QUOTE_CLOSE}이라고 해`);
    expect(normalizeText('rename it to "Depot  ＡＢ 10⁹"').quotes).toEqual(['Depot  ＡＢ 10⁹']);
    expect(normalizeText('“North block” and ‘B’ and 「가」').quotes).toEqual(['North block', 'B', '가']);
    // apostrophes are not quotation marks
    expect(normalizeText("align these buildings' fronts, don't move").quotes).toEqual([]);
    const id = normalizeText('Delete #Building_AB12.');
    expect(id.ids).toEqual(['Building_AB12']);
    expect(id.text).toBe(`delete ${ID_OPEN}0${ID_CLOSE}.`);
  });

  it('punctuation variants', () => {
    expect(normalizeText('n2–n3 도로').text).toBe('n2-n3 도로');
    expect(normalizeText('n4 → (40, 60)').text).toBe('n4 -> (40, 60)');
    expect(normalizeText('해줘~').text).toBe('해줘');
  });
});

describe('readQuantity', () => {
  it('units → canonical units and factors', () => {
    const cases: [string, number, string | null][] = [
      ['5 m', 5, 'm'], ['5m', 5, 'm'], ['5 미터', 5, 'm'], ['5 메터', 5, 'm'], ['5 meters', 5, 'm'], ['5 metres', 5, 'm'],
      ['2 km', 2000, 'm'], ['2 킬로미터', 2000, 'm'], ['30 cm', 0.3, 'm'], ['30 센티미터', 0.3, 'm'],
      ['30도', 30, 'deg'], ['30°', 30, 'deg'], ['30 degrees', 30, 'deg'], ['30 deg', 30, 'deg'],
      ['5초', 5, 's'], ['5 s', 5, 's'], ['5 sec', 5, 's'], ['5 seconds', 5, 's'],
      ['30분', 1800, 's'], ['30 min', 1800, 's'], ['30 minutes', 1800, 's'],
      ['2시간', 7200, 's'], ['2 h', 7200, 's'], ['2 hours', 7200, 's'],
      ['1.5배', 1.5, 'x'], ['2x', 2, 'x'], ['2×', 2, 'x'], ['2 times', 2, 'x'], ['2배속', 2, 'speedx'],
      ['2층', 2, 'floors'], ['2 floors', 2, 'floors'], ['2 storeys', 2, 'floors'], ['2 stories', 2, 'floors'], ['2-storey', 2, 'floors'], ['2-story', 2, 'floors'],
      ['3채', 3, 'count'], ['3 동', 3, 'count'], ['5대', 5, 'count'], ['4그루', 4, 'count'], ['2명', 2, 'count'], ['6개', 6, 'count'],
      ['1.8e9 J', 1.8e9, 'J'], ['5 kJ', 5000, 'J'], ['3 MJ', 3e6, 'J'], ['1.8 GJ', 1.8e9, 'J'],
      ['500 kg', 500, 'kg'], ['2 t', 2000, 'kg'], ['2톤', 2000, 'kg'],
      ['500 W', 500, 'W'], ['50 kW', 50000, 'W'], ['2 MW', 2e6, 'W'],
      ['0.3 g', 0.3, 'g'], ['30 m/s', 30, 'mps'], ['72 km/h', 20, 'mps'], ['20 km/s', 20000, 'mps'],
      ['3 m/s²', 3, 'mps2'], ['80 mm/h', 80, 'mmh'], ['80 mm per hour', 80, 'mmh'], ['80mm', 80, 'mm'],
      ['5 m³/s', 5, 'm3s'], ['5 m3/s', 5, 'm3s'], ['5 세제곱미터', 5, 'm3'], ['0.5 m/min', 0.5, 'mmin'],
      ['10%', 10, 'pct'], ['3번째', 3, 'ord'], ['3번', 3, 'ord'], ['3rd', 3, 'ord'], ['-20', -20, null], ['0.5', 0.5, null],
    ];
    const bad: string[] = [];
    for (const [text, value, unit] of cases) {
      const got = q(text);
      if (got.length !== 1 || Math.abs(got[0][0] - value) > 1e-9 * Math.max(1, Math.abs(value)) || got[0][1] !== unit) bad.push(`${text} → ${JSON.stringify(got)} (want ${value} ${unit})`);
    }
    expect(bad).toEqual([]);
  });

  it('a Latin unit ends at a word boundary; a Korean particle may follow', () => {
    expect(one('5 minutes')).toEqual([300, 's']);
    expect(one('3 trees')).toEqual([3, null]);
    expect(one('45 south')).toEqual([45, null]);
    expect(one('0.8m까지')).toEqual([0.8, 'm']);
    expect(one('80mm의')).toEqual([80, 'mm']);
    expect(readUnit('5 metres', 1)?.unit).toBe('m');
    expect(readUnit(' east', 0)).toBeNull();
  });

  it('native Korean numerals with a counter', () => {
    const cases: [string, number][] = [
      ['한 채', 1], ['두 채', 2], ['세 채', 3], ['네 대', 4], ['다섯 대', 5], ['여섯 그루', 6], ['일곱 명', 7], ['여덟 개', 8], ['아홉 개', 9], ['열 채', 10],
      ['열한 그루', 11], ['열두 그루', 12], ['열아홉 개', 19], ['스무 대', 20], ['스물한 명', 21], ['서른 그루', 30], ['마흔 개', 40], ['쉰 개', 50], ['세채', 3], ['세 사람', 3],
    ];
    for (const [text, value] of cases) expect(one(text), text).toEqual([value, 'count']);
    expect(one('두 배')).toEqual([2, 'x']);
    expect(one('세 번째')).toEqual([3, 'ord']);
    expect(one('두 시간')).toEqual([7200, 's']);
    // without a counter a native numeral is not a number …
    expect(q('세워')).toEqual([]);
    expect(q('한가운데')).toEqual([]);
    expect(q('두어')).toEqual([]);
    // … except 하나 / 둘 / 셋 / 넷 standing alone
    expect(one('나무 하나')).toEqual([1, null]);
    expect(one('둘')).toEqual([2, null]);
    expect(one('셋을')).toEqual([3, null]);
    expect(one('넷')).toEqual([4, null]);
    expect(q('둘레')).toEqual([]);
  });

  it('Sino-Korean numerals with a unit', () => {
    expect(one('이층')).toEqual([2, 'floors']);
    expect(one('삼 미터')).toEqual([3, 'm']);
    expect(one('십 초')).toEqual([10, 's']);
    expect(one('삼십 도')).toEqual([30, 'deg']);
    expect(one('구십도')).toEqual([90, 'deg']);
    expect(one('백팔십 도')).toEqual([180, 'deg']);
    expect(one('사십오 도')).toEqual([45, 'deg']);
    expect(one('오 분')).toEqual([300, 's']);
    expect(one('이십 개')).toEqual([20, 'count']);
    // one syllable + a counter is a word, not a number: 이동 (move), 삼거리 (junction), 사이 (between), 이상 (or more)
    for (const w of ['이동', '삼거리', '사거리', '사이', '이상', '이하', '이름', '오른쪽', '구간', '칠해', '일시정지', '이것']) expect(q(w), w).toEqual([]);
  });

  it('English number words', () => {
    const cases: [string, number, string | null][] = [
      ['three houses', 3, null], ['one tree', 1, null], ['twenty cars', 20, null], ['twenty-five trees', 25, null], ['ninety degrees', 90, 'deg'],
      ['five m', 5, 'm'], ['two-storey', 2, 'floors'], ['two story', 2, 'floors'], ['a couple of trees', 2, null], ['a dozen cars', 12, null],
      ['half a metre', 0.5, 'm'], ['a metre', 1, 'm'], ['an hour', 3600, 's'], ['the third fire', 3, 'ord'], ['two hundred m', 200, 'm'],
    ];
    for (const [text, value, unit] of cases) expect(one(text), text).toEqual([value, unit]);
    expect(q('a house')).toEqual([]);
    expect(q('the first one')).toEqual([[1, null]]); // "one" alone reads as 1; the lexicon knows "the first one" as a phrase
    expect(q('ones')).toEqual([]);
  });

  it('both readings of digits before a possible unit are offered (3 동쪽 = 3 + east, not 3 buildings)', () => {
    const all = readQuantity('3 동쪽', 0);
    expect(all.map((x) => [x.value, x.unit, x.len])).toEqual([[3, 'count', 3], [3, null, 1]]);
  });
});
