import { describe, expect, it } from 'vitest';
import { parseCommands, normalize, extractDirection, tokenizeNumbers } from './RuleBasedParser';
import type { ParseDefaults } from './CommandParser';

const D: ParseDefaults = { direction: 'N', duration: 60, gustStrength: 0.25 };

function wind(input: string) {
  const r = parseCommands(input, D);
  const cmds = r.commands.map((c) => c.command).filter((c) => c.kind === 'event').map((c) => (c as { spec: unknown }).spec);
  return { r, cmds: cmds as Record<string, unknown>[], delays: r.commands.map((c) => c.delay ?? 0) };
}

describe('normalize', () => {
  it('unifies units', () => {
    expect(normalize('초속 30미터')).toBe('30m/s');
    expect(normalize('시속 108km')).toBe('108km/h');
    expect(normalize('45 meters per second')).toBe('45 m/s');
    expect(normalize('45㎧')).toBe('45m/s');
  });
});

describe('Korean wind commands', () => {
  it('basic wind from the east', () => {
    const { r, cmds } = wind('풍속 30m/s의 바람을 동쪽에서 발생시켜');
    expect(r.ok).toBe(true);
    expect(cmds[0]).toMatchObject({ event: 'wind', speed: 30, direction: 'E', duration: 60 });
  });

  it('east → west typhoon (spec example)', () => {
    const { cmds } = wind('동쪽에서 서쪽 방향으로 풍속 45m/s의 태풍 발생');
    expect(cmds[0]).toMatchObject({ speed: 45, direction: 'E', gustStrength: 0.35 });
  });

  it('ramp: increase to 50 over 20 seconds', () => {
    const { cmds } = wind('풍속을 50m/s까지 20초 동안 증가시켜');
    expect(cmds[0]).toMatchObject({ speed: 50, rampDuration: 20 });
    expect(cmds[0].rampFrom).toBeUndefined();
  });

  it('ramp with explicit start speed', () => {
    const { cmds } = wind('바람을 20m/s에서 60m/s까지 30초에 걸쳐 강하게');
    expect(cmds[0]).toMatchObject({ speed: 60, rampFrom: 20, rampDuration: 30 });
  });

  it('toward-direction is inverted', () => {
    const { cmds } = wind('서쪽으로 부는 25m/s 바람');
    expect(cmds[0]).toMatchObject({ direction: 'E', speed: 25 });
  });

  it('does not mistake 동안 for a direction', () => {
    const { cmds } = wind('풍속 20m/s 바람을 90초 동안');
    expect(cmds[0]).toMatchObject({ direction: 'N', duration: 90 });
  });

  it('compound directions and 풍 suffix', () => {
    expect(wind('남서풍 35m/s').cmds[0]).toMatchObject({ direction: 'SW', speed: 35 });
    expect(wind('북동쪽에서 강풍').cmds[0]).toMatchObject({ direction: 'NE', speed: 20 });
  });

  it('delay and minutes', () => {
    const { cmds, delays } = wind('10초 후 남쪽에서 40m/s 바람 2분간');
    expect(cmds[0]).toMatchObject({ direction: 'S', speed: 40, duration: 120 });
    expect(delays[0]).toBe(10);
  });

  it('gust percent', () => {
    expect(wind('동풍 30m/s 돌풍 50%').cmds[0]).toMatchObject({ gustStrength: 0.5 });
    expect(wind('동풍 30m/s 돌풍 없이').cmds[0]).toMatchObject({ gustStrength: 0 });
  });

  it('sequence of two wind commands is chained', () => {
    const { cmds, delays } = wind('동쪽에서 30m/s 바람 40초, 그 다음 50m/s까지 20초 동안 증가');
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).toMatchObject({ speed: 50, rampDuration: 20, direction: 'E' });
    expect(delays[1]).toBe(36);
  });

  it('unsupported hazards are recognized', () => {
    const r = parseCommands('화재를 발생시켜', D);
    expect(r.ok).toBe(true);
    expect(r.unsupported[0]).toMatchObject({ event: 'fire' });
    expect(r.commands).toHaveLength(0);
  });

  it('heavy rain is a supported event since Phase 14 (was "unsupported" before)', () => {
    const r = parseCommands('폭우를 시간당 100mm로 발생시켜', D);
    expect(r.ok).toBe(true);
    expect(r.unsupported).toHaveLength(0);
    expect(r.commands[0].command).toMatchObject({ kind: 'event', spec: { event: 'rain', intensity: 100 } });
  });

  it('바람이 불어 is not fire', () => {
    const r = parseCommands('바람이 동쪽에서 30m/s로 불어', D);
    expect(r.unsupported).toHaveLength(0);
    expect(r.commands).toHaveLength(1);
  });
});

describe('English wind commands', () => {
  it('Wind 45m/s from East', () => {
    expect(wind('Wind 45m/s from East').cmds[0]).toMatchObject({ speed: 45, direction: 'E' });
  });
  it('abbreviation and km/h conversion', () => {
    expect(wind('wind 108 km/h NE for 90 seconds').cmds[0]).toMatchObject({ speed: 30, direction: 'NE', duration: 90 });
  });
  it('easterly / toward', () => {
    expect(wind('easterly gale').cmds[0]).toMatchObject({ direction: 'E', speed: 20 });
    expect(wind('35 m/s wind blowing toward the north').cmds[0]).toMatchObject({ direction: 'S' });
  });
  it('increase to 50 m/s over 20 seconds', () => {
    expect(wind('increase wind to 50 m/s over 20 seconds').cmds[0]).toMatchObject({ speed: 50, rampDuration: 20 });
  });
  it('east to west', () => {
    expect(wind('typhoon east to west 55 m/s').cmds[0]).toMatchObject({ direction: 'E', speed: 55 });
  });
  it('degrees', () => {
    expect(wind('wind 30 m/s from 270°').cmds[0]).toMatchObject({ direction: 270 });
  });
  it('"45 south" is not 45 seconds', () => {
    const t = tokenizeNumbers(normalize('wind 45 south'));
    expect(t[0].kind).toBe('bare');
  });
  it('stop the wind', () => {
    expect(wind('stop the wind').cmds[0]).toMatchObject({ speed: 0 });
  });
});

describe('controls', () => {
  const kinds = (s: string) => parseCommands(s, D).commands.map((c) => c.command);
  it('pause / play / reset', () => {
    expect(kinds('일시정지')).toEqual([{ kind: 'control', action: 'pause' }]);
    expect(kinds('resume')).toEqual([{ kind: 'control', action: 'play' }]);
    expect(kinds('초기화')).toEqual([{ kind: 'control', action: 'reset' }]);
  });
  it('simulation speed', () => {
    expect(kinds('속도 2배')).toEqual([{ kind: 'speed', value: 2 }]);
    expect(kinds('speed 0.5x')).toEqual([{ kind: 'speed', value: 0.5 }]);
    expect(kinds('4배속')).toEqual([{ kind: 'speed', value: 4 }]);
    expect(kinds('slow motion')).toEqual([{ kind: 'speed', value: 0.5 }]);
  });
  it('garbage is an error', () => {
    const r = parseCommands('안녕하세요', D);
    expect(r.ok).toBe(false);
    expect(r.errors[0].key).toBe('parse.noIntent');
  });
  it('speed out of range', () => {
    expect(parseCommands('풍속 300m/s', D).errors[0].key).toBe('parse.speedRange');
  });
});

describe('extractDirection', () => {
  it('handles 동→서', () => {
    const s = normalize('동→서 30m/s');
    expect(extractDirection(s, '동→서', tokenizeNumbers(s))?.dir).toBe('E');
  });
});
