/**
 * Phase 37: the phenomenon helpers the command planner shares with the panels — the control-support table (checked
 * against the real event classes), single states, and writing spec values in their stored units with the field
 * limits (the clamp that before lived only in the panel's number fields).
 */
import { describe, expect, it } from 'vitest';
import type { EventSpec } from '@/events/specs';
import { controlsOf } from '@/events/EventScheduler';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { assignSpecValue, clampField, fieldValue, setField, storedLimits } from './fields';
import { CONTROL_SUPPORT, controlSupport, singleStateOf } from './controls';
import { phenomena } from './registry';

const def = (type: string) => phenomena.implemented(type)!;
const get = (spec: EventSpec, key: string) => (spec as unknown as Record<string, unknown>)[key];

describe('control support by type', () => {
  it('the table lists every implemented phenomenon and agrees with its event class', () => {
    const types = phenomena.listImplemented().map((d) => d.type).sort();
    expect(Object.keys(CONTROL_SUPPORT).sort()).toEqual(types);
    const terrain = createFlatTerrain();
    for (const d of phenomena.listImplemented()) {
      const event = d.createEvent(d.defaults(), 0, { seed: 1, terrain });
      expect(controlSupport(d.type), d.type).toEqual(controlsOf(event));
    }
    expect(controlSupport('nothing')).toEqual({ stop: false, pause: false });
  });

  it('single states: map-wide wind, map-wide rain, rising water per map edge', () => {
    expect(singleStateOf('wind', def('wind').defaults())).toBe('wind');
    expect(singleStateOf('rain', def('rain').defaults())).toBe('rain');
    expect(singleStateOf('rain', { ...def('rain').defaults(), area: { center: [0, 0], radius: 30 } } as EventSpec)).toBeNull();
    expect(singleStateOf('risingWater', { ...def('risingWater').defaults(), boundary: 'W' } as EventSpec)).toBe('water.W');
    expect(singleStateOf('blast', def('blast').defaults())).toBeNull();
  });
});

describe('spec values in stored units', () => {
  it('display ⇄ stored: the panel shows MJ, the spec holds J', () => {
    const blast = def('blast');
    const energy = blast.fields.find((f) => f.key === 'energy')!;
    const spec = blast.defaults();
    expect(get(spec, 'energy')).toBe(1e8);
    expect(fieldValue(energy, spec)).toBeCloseTo(100, 9); // MJ
    expect(get(setField(energy, spec, 1800), 'energy')).toBeCloseTo(1.8e9, 0);
    expect(storedLimits(energy)).toEqual({ min: 1e3, max: 1e12 });
    expect(clampField(energy, 5e13)).toEqual({ value: 1e12, clamped: true });
    expect(clampField(energy, 1.8e9)).toEqual({ value: 1.8e9, clamped: false });
  });

  it('a command writes the stored value by the spec key; out-of-range numbers are clamped and reported', () => {
    const blast = def('blast');
    const a = assignSpecValue(blast, blast.defaults(), 'energy', 1.8e9);
    expect(a.ok && get(a.spec, 'energy')).toBe(1.8e9);
    expect(a.ok && a.clamped).toBeUndefined();
    const big = assignSpecValue(blast, blast.defaults(), 'energy', 5e13);
    expect(big.ok && get(big.spec, 'energy')).toBe(1e12);
    expect(big.ok && big.clamped).toEqual({ from: 5e13, to: 1e12, min: 1e3, max: 1e12 });
    // The spec that comes out passes the type's own schema (a clamp is not allowed to produce an invalid spec).
    expect(big.ok && blast.schema.safeParse(big.spec).success).toBe(true);
    // Keys are found whatever their case; unknown keys are refused with the list of known ones.
    expect(assignSpecValue(blast, blast.defaults(), 'ENERGY', 2e6).ok).toBe(true);
    const bad = assignSpecValue(blast, blast.defaults(), 'megatons', 3);
    expect(bad).toMatchObject({ ok: false, reason: 'unknownField' });
    expect(!bad.ok && bad.known).toContain('energy');
    // The original spec is never modified.
    const spec = blast.defaults();
    assignSpecValue(blast, spec, 'energy', 9e9);
    expect(get(spec, 'energy')).toBe(1e8);
  });

  it('seconds stay seconds (the panel shows minutes), choices must be one of the options', () => {
    const rain = def('rain');
    const d = assignSpecValue(rain, rain.defaults(), 'duration', 600);
    expect(d.ok && get(d.spec, 'duration')).toBe(600);
    const quake = def('earthquake');
    const m = assignSpecValue(quake, quake.defaults(), 'magnitude', 12);
    expect(m.ok && get(m.spec, 'magnitude')).toBe(9.5);
    expect(m.ok && m.clamped?.to).toBe(9.5);
    const deform = def('terrainDeformation');
    const kind = deform.fields.find((f) => f.key === 'kind');
    if (kind?.options) {
      const good = assignSpecValue(deform, deform.defaults(), 'kind', kind.options[1].value);
      expect(good.ok && get(good.spec, 'kind')).toBe(kind.options[1].value);
      expect(assignSpecValue(deform, deform.defaults(), 'kind', 'sideways')).toMatchObject({ ok: false, reason: 'badOption' });
    }
    // A text value for a numeric key is refused, never coerced.
    expect(assignSpecValue(quake, quake.defaults(), 'magnitude', 'big')).toMatchObject({ ok: false, reason: 'notANumber' });
  });

  it('every type: each numeric field without a custom mapping can be written at both of its limits', () => {
    const failures: string[] = [];
    for (const d of phenomena.listImplemented()) {
      for (const f of d.fields) {
        if (f.options || f.get || f.set) continue;
        if (f.visible && !f.visible(d.defaults())) continue;
        for (const v of [storedLimits(f).min, storedLimits(f).max]) {
          const r = assignSpecValue(d, d.defaults(), f.key, v);
          if (!r.ok) failures.push(`${d.type}.${f.key}=${v}: ${r.reason}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
