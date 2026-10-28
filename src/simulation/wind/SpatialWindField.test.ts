import { describe, expect, it } from 'vitest';
import { WindField } from '../environment/WindField';
import { SpatialWindField } from './SpatialWindField';
import type { WindObstacle } from './obstacles';
import { DEFAULT_WIND_MODEL } from '@/core/model';

/** 20 m tall, 10×10 m building at the origin; wind FROM the west → flows toward +X. */
function setup(seed = 7, params = DEFAULT_WIND_MODEL) {
  const wind = new WindField();
  wind.baseSpeed = 45;
  wind.fromBearing = 270;
  wind.gustStrength = 0; // isolate the obstacle effect
  const field = new SpatialWindField(wind, params, seed);
  const b: WindObstacle = { id: 'b1', cx: 0, cz: 0, hx: 5, hz: 5, ax: [1, 0], az: [0, 1], height: 20, active: true };
  field.setObstacles([b]);
  return { wind, field };
}

const y = 5;

describe('SpatialWindField — wind shadow', () => {
  it('upwind of the building the wind is undisturbed', () => {
    const { field } = setup();
    const s = field.sample([-40, y, 0], 0);
    expect(s.speed).toBeCloseTo(s.freeStream, 1);
    expect(s.shadowSource).toBeNull();
  });

  it('directly behind is strongly reduced and recovers with distance', () => {
    const { field } = setup();
    const near = field.sample([7, y, 0], 0);
    const mid = field.sample([60, y, 0], 0);
    const far = field.sample([200, y, 0], 0);
    const free = near.freeStream;
    expect(near.speed / free).toBeLessThan(0.6);
    expect(near.shadowSource).toBe('b1');
    expect(mid.speed).toBeGreaterThan(near.speed);
    expect(mid.speed).toBeLessThan(free);
    expect(far.speed / far.freeStream).toBeGreaterThan(0.99);
  });

  it('far above the roof there is no shadow', () => {
    const { field } = setup();
    const s = field.sample([10, 40, 0], 0);
    expect(s.speed / s.freeStream).toBeGreaterThan(0.99);
  });

  it('beside the building the wind speeds up (corner effect)', () => {
    const { field } = setup();
    const s = field.sample([0, y, 7], 0);
    expect(s.corner).toBe(true);
    expect(s.shelter).toBeGreaterThan(1.05);
  });

  it('an object is never affected by its own wake', () => {
    const { field } = setup();
    const s = field.sample([7, y, 0], 0, 'b1');
    expect(s.speed / s.freeStream).toBeCloseTo(1, 2);
  });

  it('shelter can be disabled via model parameters', () => {
    const { field } = setup(7, { ...DEFAULT_WIND_MODEL, shelterEnabled: false });
    const s = field.sample([7, y, 0], 0);
    expect(s.speed).toBeCloseTo(s.freeStream, 5);
  });

  it('removing the obstacle (collapse) clears its wake', () => {
    const { field } = setup();
    field.removeObstacle('b1');
    const s = field.sample([7, y, 0], 0);
    expect(s.speed).toBeCloseTo(s.freeStream, 5);
  });

  it('follows the wind when it changes direction', () => {
    const { wind, field } = setup();
    wind.fromBearing = 90; // now flowing toward −X
    expect(field.sample([7, y, 0], 0).shadowSource).toBeNull();
    expect(field.sample([-7, y, 0], 0).shadowSource).toBe('b1');
  });
});

describe('SpatialWindField — turbulence', () => {
  it('is deterministic for a given seed and differs between seeds', () => {
    const a = setup(11).field.sample([12, y, 3], 4.2);
    const b = setup(11).field.sample([12, y, 3], 4.2);
    const c = setup(12).field.sample([12, y, 3], 4.2);
    expect(a.speed).toBe(b.speed);
    expect(a.velocity).toEqual(b.velocity);
    expect(a.speed).not.toBe(c.speed);
    expect(a.turbulence).toBeGreaterThan(0);
  });
});
