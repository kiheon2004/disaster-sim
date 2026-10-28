import { describe, expect, it } from 'vitest';
import { parseCommands } from './RuleBasedParser';
import type { ParseDefaults } from './CommandParser';

const D: ParseDefaults = { direction: 'E', duration: 60, gustStrength: 0.25 };

function specs(input: string) {
  const r = parseCommands(input, D);
  return { r, specs: r.commands.map((c) => (c.command.kind === 'event' ? c.command.spec : null)), notes: r.commands.flatMap((c) => c.notes.map((n) => n.key)) };
}

describe('flood commands (Korean)', () => {
  it('"시간당 80mm의 비를 30분 동안 내려줘" → rain 80 mm/h for 1800 s', () => {
    const { r, specs: s } = specs('시간당 80mm의 비를 30분 동안 내려줘');
    expect(r.ok).toBe(true);
    expect(s[0]).toEqual({ event: 'rain', intensity: 80, duration: 1800 });
  });

  it('"남쪽 경계에서 수위를 2m까지 올려줘" → rising water, S, surface elevation 2 m (noted as elevation, not depth)', () => {
    const { specs: s, notes } = specs('남쪽 경계에서 수위를 2m까지 올려줘');
    expect(s[0]).toEqual({ event: 'risingWater', boundary: 'S', level: 2 });
    expect(notes).toContain('parse.note.flood.levelIsElevation');
  });

  it('"중앙에 초당 5세제곱미터의 물을 공급해줘" → source 5 m³/s at (0, 0)', () => {
    const { specs: s, notes } = specs('중앙에 초당 5세제곱미터의 물을 공급해줘');
    expect(s[0]).toMatchObject({ event: 'waterSource', position: [0, 0], rate: 5 });
    expect(notes).toContain('parse.note.flood.defaultSourceDuration');
  });

  it('unit conversions: total rainfall over a duration, L/s, m³/h, per-minute rise, 미터', () => {
    expect(specs('30분 동안 40mm의 비').specs[0]).toMatchObject({ event: 'rain', intensity: 80, duration: 1800 });
    expect(specs('동쪽에 200리터/초의 물을 10분 동안 공급').specs[0]).toMatchObject({ event: 'waterSource', rate: 0.2, duration: 600, position: [50, 0] });
    expect(specs('중앙에 시간당 3600세제곱미터 물 공급').specs[0]).toMatchObject({ rate: 1 });
    expect(specs('초당 3톤의 물을 중앙에 쏟아').specs[0]).toMatchObject({ rate: 3 });
    expect(specs('서쪽 수위를 분당 0.2m 속도로 1.5미터까지 올려').specs[0]).toEqual({ event: 'risingWater', boundary: 'W', level: 1.5, riseRate: 0.2 });
    expect(specs('북쪽 경계 수위를 10분 동안 3m까지 상승').specs[0]).toEqual({ event: 'risingWater', boundary: 'N', level: 3, duration: 600 });
  });

  it('defaults are listed as notes; bad values are rejected', () => {
    const { specs: s, notes } = specs('폭우 내려줘');
    expect(s[0]).toMatchObject({ event: 'rain', intensity: 50, duration: 1800 });
    expect(notes).toEqual(expect.arrayContaining(['parse.note.flood.defaultIntensity', 'parse.note.flood.defaultDuration']));
    expect(specs('시간당 900mm 비').r.errors[0].key).toBe('parse.flood.rainRange');
    expect(specs('수위를 2m만큼 올려줘').r.errors[0].key).toBe('parse.flood.relativeLevel');
    expect(specs('홍수').specs[0]).toMatchObject({ event: 'risingWater', boundary: 'S', level: 1.5 });
  });

  it('typhoon + rain in one clause → a wind AND a rain command', () => {
    const { specs: s } = specs('태풍과 함께 시간당 60mm의 비를 20분 동안');
    expect(s.map((x) => x?.event).sort()).toEqual(['rain', 'wind']);
  });

  it('wind and earthquake commands are unaffected', () => {
    expect(specs('동쪽에서 45m/s 태풍').specs[0]).toMatchObject({ event: 'wind', speed: 45 });
    expect(specs('규모 6.5 지진').specs[0]).toMatchObject({ event: 'earthquake', magnitude: 6.5 });
  });
});

describe('flood commands (English)', () => {
  it('"Start rainfall at 80 mm/h for 30 minutes"', () => {
    expect(specs('Start rainfall at 80 mm/h for 30 minutes').specs[0]).toEqual({ event: 'rain', intensity: 80, duration: 1800 });
  });

  it('"Raise the southern boundary water level to 2 meters"', () => {
    expect(specs('Raise the southern boundary water level to 2 meters').specs[0]).toEqual({ event: 'risingWater', boundary: 'S', level: 2 });
  });

  it('flow units and positions', () => {
    expect(specs('Supply 5 cubic meters per second of water at the center').specs[0]).toMatchObject({ event: 'waterSource', rate: 5, position: [0, 0] });
    expect(specs('Pour water at 2 m3/s at (10, -20) for 5 minutes').specs[0]).toEqual({ event: 'waterSource', rate: 2, position: [10, -20], duration: 300 });
    expect(specs('Heavy rain 1.2 inches').specs[0]).toMatchObject({ event: 'rain' });
    expect(specs('Raise the west water level to 1.5 m at 0.3 m/min').specs[0]).toEqual({ event: 'risingWater', boundary: 'W', level: 1.5, riseRate: 0.3 });
  });
});
