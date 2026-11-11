/**
 * Phase 37 (audit D1–D5, NL-CONVENTIONS §5, §6 D1 D2): the adapter to the old disaster grammar (src/commands) and
 * the traps of that grammar. The old library itself is not changed (its own 53 tests still run).
 * Expected canonical commands are written by hand from the conventions.
 */
import { describe, expect, it } from 'vitest';
import { parseCommands } from '@/commands/RuleBasedParser';
import { phenomena } from '@/phenomena/registry';
import { LEGACY_FIELDS, LEGACY_TYPES } from './aliases';
import { LEGACY_DEFAULTS, eventsOf, legacyAllowed, legacyClause, legacyForm } from './legacyDisaster';
import { lex } from './lexicon';
import { normalizeText } from './normalize';
import { parseCommand, type ParseOutcome } from './parse';

const show = (o: ParseOutcome): string => (o.kind === 'ok' ? `${o.source}: ${o.canonical.join(' | ')}` : o.kind === 'ask' ? `ask ${o.slot}` : `unknown (${o.reason.key})`);
const toks = (text: string) => lex(normalizeText(text));

describe('legacy disaster grammar adapter', () => {
  it('its defaults are fixed constants from the wind definition — never the wind form', () => {
    const wind = phenomena.implemented('wind')!.defaults() as unknown as { direction: string; duration: number; gustStrength: number };
    expect(LEGACY_DEFAULTS).toEqual({ direction: wind.direction, duration: wind.duration, gustStrength: wind.gustStrength });
    expect(LEGACY_DEFAULTS).toEqual({ direction: 'E', duration: 60, gustStrength: 0.3 });
  });

  it('the legacy form (§6 D1): said values, the definition\'s defaults for every other basic field; earthquake only magnitude', () => {
    expect(legacyForm('wind', { speed: 30 })).toEqual({ speed: 30, direction: 'E', duration: 60 });
    expect(legacyForm('rain', {})).toEqual({ intensity: 80, duration: 1800 });
    expect(legacyForm('risingWater', { level: 0.8, boundary: 'W' })).toEqual({ level: 0.8, boundary: 'W', riseRate: 0.5 });
    expect(legacyForm('waterSource', { rate: 5 })).toEqual({ rate: 5, duration: 600 });
    expect(legacyForm('earthquake', {})).toEqual({ magnitude: 6.5 });
    expect(legacyForm('earthquake', { magnitude: 7, pga: 0.4 })).toEqual({ magnitude: 7, pga: 0.4 });
    // the basic fields are fields of the definitions
    for (const type of LEGACY_TYPES) {
      const def = phenomena.implemented(type)!.defaults() as unknown as Record<string, unknown>;
      for (const k of LEGACY_FIELDS[type]) if (type !== 'earthquake') expect(def[k], `${type}.${k}`).toBeDefined();
    }
  });

  it('TRAP D3 — "지진 멈춰" stops the earthquake; the old grammar alone would START one', () => {
    // what the old grammar returns for these sentences (why the new rules must see them first)
    const old = parseCommands('지진 멈춰', LEGACY_DEFAULTS);
    expect(old.commands.map((c) => c.command.kind === 'event' && c.command.spec.event)).toEqual(['earthquake']);
    expect(parseCommands('비 멈춰', LEGACY_DEFAULTS).commands.map((c) => c.command.kind === 'event' && c.command.spec.event)).toEqual(['rain']);
    // the new parser
    expect(show(parseCommand('지진 멈춰'))).toBe('rules: disaster earthquake stop');
    expect(show(parseCommand('비 멈춰'))).toBe('rules: disaster rain stop');
    expect(show(parseCommand('stop the earthquake'))).toBe('rules: disaster earthquake stop');
    expect(show(parseCommand('바람을 멈춰'))).toBe('rules: disaster wind stop');
    expect(show(parseCommand('stop the wind'))).toBe('rules: disaster wind stop');
    expect(show(parseCommand('지진 멈춰, 화재 #3 지워'))).toBe('rules: disaster earthquake stop | disaster fire#3 delete');
    for (const text of ['지진 멈춰', '비 멈춰', 'stop the earthquake', '지진 일시정지', '지진 지워', 'pause the rain']) {
      const o = parseCommand(text);
      expect(o.kind === 'ok' && o.intents.every((i) => i.kind === 'instance'), text).toBe(true);
    }
  });

  it('TRAP D4 — a blast keeps its place, energy and delay (the old grammar drops them: centre, 1e8 J)', () => {
    const old = parseCommands('교차로 n4에 폭발 1.8e9 J, 5초 뒤', LEGACY_DEFAULTS).commands[0];
    expect(old.command.kind === 'event' && (old.command.spec as unknown as { energy: number; position: number[] })).toMatchObject({ energy: 1e8, position: [0, 0] });
    expect(show(parseCommand('교차로 n4에 폭발 1.8e9 J, 5초 뒤'))).toBe('rules: disaster blast at=node:n4 energy=1.8e9 start=5');
    expect(show(parseCommand('교차로에 폭발 1.8×10⁹ J, 5초 뒤'))).toBe('rules: disaster blast at=junction energy=1.8e9 start=5');
    // the six types whose numbers the old grammar ignores are never handed to it
    for (const text of ['토네이도 발생', '싱크홀 발생', '운석 발생']) expect(parseCommand(text).kind, text).toBe('unknown');
    expect(legacyAllowed(toks('폭발을 일으켜'))).toBeNull();
  });

  it('TRAP D5 — 1.8×10⁹ is 1.8e9 (NFKC alone reads 10⁹ as 109)', () => {
    for (const text of ['여기에 폭발 1.8×10⁹ J', '여기에 폭발 1.8 x 10^9 J', '여기에 폭발 1.8*10**9 J', '여기에 폭발 1.8E+9 J', '여기에 폭발 18억 J']) {
      expect(show(parseCommand(text)), text).toBe('rules: disaster blast at=cursor energy=1.8e9');
    }
  });

  it('the sentences the existing Chrome scripts type give run-now commands', () => {
    const cases: [string, string][] = [
      ['시간당 80mm의 비를 30분 동안 내려줘 그리고 서쪽 경계에서 수위를 0.8m까지 올려줘', 'rules: disaster rain duration=1800 intensity=80 now | disaster risingWater boundary=W level=0.8 riseRate=0.5 now'],
      ['Start rainfall at 80 mm/h for 30 minutes then raise the western boundary water level to 0.8 meters', 'rules: disaster rain duration=1800 intensity=80 now | disaster risingWater boundary=W level=0.8 riseRate=0.5 now'],
      ['폭발을 일으켜', 'rules: disaster blast now'],
      ['make an explosion', 'rules: disaster blast now'],
      ['태풍을 발생시키고 10초 후 지진을 발생시켜', 'rules: disaster wind direction=E duration=60 speed=40 now | disaster earthquake magnitude=6.5 start=10 now'],
      ['Start an earthquake 10 seconds after the typhoon begins', 'legacy: disaster earthquake magnitude=6.5 start=10 now'],
    ];
    for (const [text, want] of cases) expect(show(parseCommand(text)), text).toBe(want);
  });

  it('run-now sentences of the five legacy types always write every basic field (§6 D1, D2) — whichever code reads them', () => {
    const cases: [string, string][] = [
      ['규모 7 지진을 발생시켜', 'disaster earthquake magnitude=7 now'],
      ['make an earthquake', 'disaster earthquake magnitude=6.5 now'],
      ['여기에 규모 7 지진을 일으켜', 'disaster earthquake at=cursor magnitude=7 now'],
      ['중앙에 초당 5세제곱미터의 물을 공급해줘', 'disaster waterSource at=center duration=600 rate=5 now'],
      ['풍속 30 m/s의 바람을 동쪽에서 발생시켜', 'disaster wind direction=E duration=60 speed=30 now'],
      ['비를 내려줘', 'disaster rain duration=1800 intensity=80 now'],
      ['남쪽 경계에서 수위를 2m까지 올려줘', 'disaster risingWater boundary=S level=2 riseRate=0.5 now'],
      ['수위를 올려줘', 'disaster risingWater boundary=S level=1.5 riseRate=0.5 now'],
      ['start a typhoon', 'disaster wind direction=E duration=60 speed=40 now'],
      ['trigger an earthquake of magnitude 6 for 30 seconds', 'disaster earthquake duration=30 magnitude=6 now'],
      ['0.3 g 지진을 일으켜', 'disaster earthquake magnitude=6.5 pga=0.3 now'],
      // through the old grammar (words only it reads): the same form
      ['규모 6 지진 발생', 'disaster earthquake magnitude=6 now'],
      ['generate a magnitude 6.5 earthquake', 'disaster earthquake magnitude=6.5 now'],
      ['강풍 발생', 'disaster wind direction=E duration=60 speed=40 now'],
      ['폭우 발생', 'disaster rain duration=1800 intensity=80 now'],
      ['pour rain at 50 mm/h', 'disaster rain duration=1800 intensity=50 now'],
    ];
    const bad: string[] = [];
    for (const [text, want] of cases) {
      const o = parseCommand(text);
      if (o.kind !== 'ok' || o.canonical.join(' | ') !== want) bad.push(`${text}: want ${want}, got ${show(o)}`);
    }
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
    // WITHOUT a run verb only what is said is written
    expect(show(parseCommand('여기에 규모 7 지진'))).toBe('rules: disaster earthquake at=cursor magnitude=7');
    expect(show(parseCommand('교차로에 바람 30 m/s'))).toBe('rules: disaster wind at=junction speed=30');
  });

  it('relative starts inside one sentence use the delay the old dispatcher would compute; unknown when it cannot be known', () => {
    // wind for 40 s from now, rain 5 s after the wind ends = 45 s
    expect(show(parseCommand('동쪽에서 30m/s 바람을 40초 동안 일으키고 태풍이 끝나고 5초 뒤에 폭우를 시간당 50mm로 내려줘')))
      .toBe('legacy: disaster wind direction=E duration=40 speed=30 now | disaster rain duration=1800 intensity=50 start=45 now');
    // relative to the START of a disaster that is not in the sentence: now + offset, with a note
    const o = parseCommand('Start an earthquake 10 seconds after the typhoon begins');
    expect(o.kind === 'ok' && o.notes).toEqual([{ key: 'cmd37.nl.note.legacy' }, { key: 'cmd37.nl.note.afterUnresolved', params: { type: 'wind', s: 10 } }]);
    // relative to the END of something that is not in the sentence: not knowable here
    expect(parseCommand('태풍이 끝나고 5초 뒤에 폭우를 내려줘').kind).toBe('unknown');
    expect(legacyClause('태풍이 끝나고 5초 뒤에 폭우를 내려줘', toks('태풍이 끝나고 5초 뒤에 폭우를 내려줘'), [])).toBeNull();
    expect(eventsOf([{ kind: 'disaster', type: 'wind', fields: { duration: 40 }, now: true }, { kind: 'disaster', type: 'blast', fields: {} }])).toEqual([{ type: 'wind', delay: 0, duration: 40 }]);
  });

  it('the old control words (play / pause / reset / speed) still work — alone', () => {
    const cases: [string, string][] = [
      ['halt', 'legacy: pause'], ['중지', 'legacy: pause'], ['restore', 'legacy: reset'], ['원래대로', 'legacy: reset'],
      ['slow motion', 'legacy: speed=0.5'], ['슬로우 모션', 'legacy: speed=0.5'],
    ];
    for (const [text, want] of cases) expect(show(parseCommand(text)), text).toBe(want);
    // "freeze" is a climate word of the old grammar (it points to the editor) and "rewind" holds "wind": not controls there, nothing runs
    expect(parseCommand('freeze').kind).toBe('unknown');
    expect(parseCommand('rewind').kind).toBe('unknown');
  });

  it('nothing else may be in a legacy sentence: the old grammar never reads part of a sentence', () => {
    // the old grammar alone accepts these (it matches words anywhere and ignores the rest) …
    expect(parseCommands('주택을 빨갛게 칠하고 시작', LEGACY_DEFAULTS).commands.length).toBeGreaterThan(0);
    expect(parseCommands('태풍을 발생시켜 나무 세 그루', LEGACY_DEFAULTS).commands.length).toBeGreaterThan(0);
    // … the adapter does not let them through
    for (const text of ['주택을 빨갛게 칠하고 시작', '태풍을 발생시켜 나무 세 그루', '건물 멈춰', 'halt the trees', '지진 발생 그리고 커피', '빨간 태풍을 발생시켜']) {
      expect(parseCommand(text).kind, text).toBe('unknown');
    }
    expect(legacyAllowed(toks('태풍을 발생시켜'))).toBe('disaster');
    expect(legacyAllowed(toks('halt'))).toBe('control');
    expect(legacyAllowed(toks('태풍을 발생시켜 나무'))).toBeNull();
    expect(legacyAllowed(toks('태풍'))).toBeNull(); // no run verb
    expect(legacyAllowed(toks('n4에 태풍을 발생시켜'))).toBeNull(); // a place the old grammar cannot read
    // a ramp or a non-basic value cannot be written in the legacy form → not accepted
    expect(parseCommand('풍속을 50m/s까지 20초 동안 증가시켜').kind).toBe('unknown');
  });
});
