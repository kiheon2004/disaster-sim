import { describe, expect, it } from 'vitest';
import { applyFatigue, healthLevel } from './fatigue';
import { boxProjectedArea, heightFactor, loadRatio } from './windLoad';
import { DamageState } from './DamageState';
import { WindEvent } from '@/events/wind/WindEvent';
import { EventScheduler } from '@/events/EventScheduler';
import { createEnvironment } from '../environment/EnvironmentState';

describe('wind load', () => {
  it('load ratio is quadratic in speed', () => {
    expect(loadRatio(30, 30)).toBe(1);
    expect(loadRatio(60, 30)).toBe(4);
  });
  it('height factor is 1 at 10 m and grows with height', () => {
    expect(heightFactor(10)).toBeCloseTo(1);
    expect(heightFactor(40)).toBeGreaterThan(1.2);
    expect(heightFactor(0)).toBe(heightFactor(2));
  });
  it('box silhouette area', () => {
    expect(boxProjectedArea([4, 2, 1], [0, 0, 1])).toBe(8);
    expect(boxProjectedArea([4, 2, 1], [1, 0, 0])).toBe(2);
  });
});

describe('fatigue', () => {
  it('no damage below onset, instant failure above break threshold', () => {
    expect(applyFatigue(1, 0.6, 50, 1.5, 10)).toBe(1);
    expect(applyFatigue(1, 1.6, 50, 1.5, 0.01)).toBe(0);
  });
  it('fails after ~40 s at design load (durability 50)', () => {
    let h = 1;
    let t = 0;
    while (h > 0 && t < 100) { h = applyFatigue(h, 1, 50, 2, 0.1); t += 0.1; }
    expect(t).toBeGreaterThan(35);
    expect(t).toBeLessThan(45);
  });
  it('health levels', () => {
    expect(healthLevel(1)).toBe(DamageState.NORMAL);
    expect(healthLevel(0.7)).toBe(DamageState.DAMAGED);
    expect(healthLevel(0.2)).toBe(DamageState.CRITICAL);
    expect(healthLevel(0)).toBe(DamageState.DESTROYED);
  });
});

describe('events', () => {
  it('wind ramps, holds and fades; a new event supersedes the old one', () => {
    const env = createEnvironment();
    const sch = new EventScheduler();
    sch.add(new WindEvent({ event: 'wind', speed: 30, direction: 'E', duration: 20, rampDuration: 2 }, 0));
    sch.add(new WindEvent({ event: 'wind', speed: 50, direction: 'S', duration: 20, rampDuration: 5, startTime: 10 }, 0));
    const run = (until: number) => { for (let t = 0; t <= until + 1e-9; t += 0.1) sch.update({ env, time: t }, 0.1); };
    run(5);
    expect(env.wind.baseSpeed).toBeCloseTo(30);
    expect(env.wind.fromBearing).toBeCloseTo(90);
    const env2 = createEnvironment();
    const sch2 = new EventScheduler();
    sch2.add(new WindEvent({ event: 'wind', speed: 30, direction: 'E', duration: 20, rampDuration: 2 }, 0));
    sch2.add(new WindEvent({ event: 'wind', speed: 50, direction: 'S', duration: 20, rampDuration: 5, startTime: 10 }, 0));
    for (let t = 0; t <= 16; t += 0.1) sch2.update({ env: env2, time: t }, 0.1);
    expect(env2.wind.baseSpeed).toBeCloseTo(50, 0);
    expect(sch2.list()[0].status).toBe('superseded');
  });
});
