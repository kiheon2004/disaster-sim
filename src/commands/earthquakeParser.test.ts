import { describe, expect, it } from 'vitest';
import { parseCommands } from './RuleBasedParser';
import { commandJsonSchema } from './schema';
import type { EarthquakeEventSpec } from '@/events/specs';

const D = { direction: 'E' as const, duration: 60, gustStrength: 0.25 };

function eq(input: string) {
  const r = parseCommands(input, D);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  const c = r.commands[0];
  expect(c.command.kind).toBe('event');
  if (c.command.kind !== 'event' || c.command.spec.event !== 'earthquake') throw new Error('not an earthquake');
  return { spec: c.command.spec as EarthquakeEventSpec, notes: c.notes.map((n) => n.key), delay: c.delay };
}

describe('earthquake command parsing', () => {
  it('규모 6.5의 지진을 발생시켜', () => {
    const { spec, notes } = eq('규모 6.5의 지진을 발생시켜');
    expect(spec).toEqual({ event: 'earthquake', magnitude: 6.5 });
    // Nothing is silently fixed: PGA, duration … are listed as assumptions.
    expect(notes).toEqual(expect.arrayContaining(['eq.assume.pga', 'eq.assume.duration', 'eq.assume.frequency']));
  });

  it('중앙에서 30초 동안 지진을 발생시켜', () => {
    const { spec, notes } = eq('중앙에서 30초 동안 지진을 발생시켜');
    expect(spec.epicenter).toEqual([0, 0]);
    expect(spec.duration).toBe(30);
    expect(notes).toContain('parse.note.eq.defaultMagnitude');
    expect(notes).not.toContain('eq.assume.epicenter');
  });

  it('최대 지반가속도 0.3g의 지진을 발생시켜', () => {
    const { spec, notes } = eq('최대 지반가속도 0.3g의 지진을 발생시켜');
    expect(spec.pga).toBe(0.3);
    expect(notes).not.toContain('eq.assume.pga');
  });

  it('Generate a magnitude 6.5 earthquake', () => {
    expect(eq('Generate a magnitude 6.5 earthquake').spec).toEqual({ event: 'earthquake', magnitude: 6.5 });
  });

  it('Apply 0.3g peak ground acceleration for 30 seconds (no "earthquake" word)', () => {
    const { spec } = eq('Apply 0.3g peak ground acceleration for 30 seconds');
    expect(spec.pga).toBe(0.3);
    expect(spec.duration).toBe(30);
  });

  it('units, depth, epicenter direction, axis, delay', () => {
    expect(eq('지진 300gal').spec.pga).toBeCloseTo(0.31, 2);
    expect(eq('earthquake with 2.5 m/s² pga').spec.pga).toBeCloseTo(0.25, 2);
    const a = eq('규모 7 지진, 진원 깊이 15km, 동쪽 20km 지점');
    expect(a.spec.depth).toBe(15);
    expect(a.spec.epicenter).toEqual([20000, 0]);
    expect(eq('M6.8 quake 5 km north, east-west shaking').spec).toMatchObject({ magnitude: 6.8, epicenter: [0, -5000], direction: 90 });
    expect(eq('10초 후 규모 6 지진').delay).toBe(10);
    expect(eq('규모 6 지진 2Hz 시드 42').spec).toMatchObject({ dominantFrequency: 2, seed: 42 });
  });

  it('out-of-range values are errors, not clamped silently', () => {
    expect(parseCommands('규모 12의 지진', D).ok).toBe(false);
    expect(parseCommands('5g earthquake', D).ok).toBe(false);
  });

  it('wind commands are unaffected', () => {
    const r = parseCommands('동쪽에서 서쪽 방향으로 풍속 45m/s의 태풍 발생', D);
    expect(r.commands[0].command).toMatchObject({ kind: 'event', spec: { event: 'wind', speed: 45, direction: 'E' } });
  });

  it('the JSON schema for LLM output includes the earthquake event', () => {
    expect(JSON.stringify(commandJsonSchema())).toContain('earthquake');
  });
});
