/**
 * Phase 37 (§17): the one rule for the simulation settings of copied cars (src/vehicle/carCopies.ts). The stamp data that
 * carries them (copy / paste payload, unified Blueprint) is tested in src/blueprints/carSettings.test.ts, the editor
 * paths in src/app/carStamps.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@/world/WorldDocument';
import { addCarSettings, carSettingsOfCopies, rekeyCarSettings } from './carCopies';
import type { VehicleCar } from './settings';

/** carA: drive + controls + program + autopilot. carB: a driver (p) and a front passenger (q). */
const CARS = (): Record<string, VehicleCar> => ({
  carA: { level: 'vehicle', drive: 'awd', abs: false, controls: { throttle: 0.4, gear: 'D' }, program: [{ t: 0, throttle: 1 }, { t: 4, brake: 1 }], autopilot: { path: [[0, 0], [40, 0], [40, 30]], speed: 8, loop: true } },
  carB: { drive: 'rwd', occupants: [{ human: 'p', seat: 'driver', restrained: true }, { human: 'q', seat: 'front', restrained: false }] },
});

describe('carSettingsOfCopies — the copy rule', () => {
  it('every setting goes to the copy as a deep copy; the autopilot path stays where it is (absolute coordinates)', () => {
    const cars = CARS();
    const before = JSON.stringify(cars);
    const out = carSettingsOfCopies(cars, [['carA', 'a2']]);
    expect(Object.keys(out)).toEqual(['a2']);
    expect(out.a2).toEqual(cars.carA);
    expect(out.a2.autopilot!.path).toEqual([[0, 0], [40, 0], [40, 30]]);
    // Deep copy: editing the copy's settings never reaches the source.
    out.a2.autopilot!.path[0][0] = 99;
    out.a2.program![0].throttle = 0;
    out.a2.controls!.throttle = 0;
    expect(JSON.stringify(cars)).toBe(before);
  });

  it('an occupant stays only when the person is in the same stamp, pointed at the person\'s copy', () => {
    const cars = CARS();
    const withDriver = carSettingsOfCopies(cars, [['carB', 'b2'], ['p', 'p2']]);
    expect(withDriver.b2).toEqual({ drive: 'rwd', occupants: [{ human: 'p2', seat: 'driver', restrained: true }] });
    const both = carSettingsOfCopies(cars, [['q', 'q2'], ['carB', 'b2'], ['p', 'p2']]);
    expect(both.b2.occupants).toEqual([{ human: 'p2', seat: 'driver', restrained: true }, { human: 'q2', seat: 'front', restrained: false }]);
    // Nobody copied along: the key is gone (not an empty list), as the one-car duplicate always did.
    const alone = carSettingsOfCopies(cars, [['carB', 'b2']]);
    expect(alone.b2).toEqual({ drive: 'rwd' });
    expect('occupants' in alone.b2).toBe(false);
    // The source still has both of its occupants.
    expect(cars.carB.occupants).toHaveLength(2);
  });

  it('objects without settings, missing maps and null entries give nothing', () => {
    expect(carSettingsOfCopies(undefined, [['carA', 'a2']])).toEqual({});
    expect(carSettingsOfCopies(CARS(), [['wall', 'w2'], ['p', 'p2']])).toEqual({});
    expect(carSettingsOfCopies({ carA: null, carB: undefined }, [['carA', 'a2'], ['carB', 'b2']])).toEqual({});
    // Only own keys are entries.
    expect(carSettingsOfCopies(CARS(), [['toString', 't2'], ['constructor', 'c2']])).toEqual({});
  });
});

describe('addCarSettings / rekeyCarSettings', () => {
  it('adds entries next to the existing ones; nothing to add or no vehicle settings → the same settings object', () => {
    const doc = createEmptyDocument();
    expect(addCarSettings(doc.settings, { x: { drive: 'awd' } })).toBe(doc.settings); // legacy cars: nothing is switched on
    const withVehicles = { ...doc.settings, simulation: { ...doc.settings.simulation, vehicles: { model: 'dynamics' as const, tire: 'linear' as const, cars: CARS() } } };
    expect(addCarSettings(withVehicles, {})).toBe(withVehicles);
    const next = addCarSettings(withVehicles, { a2: { drive: 'fwd' } });
    expect(next.simulation.vehicles).toEqual({ model: 'dynamics', tire: 'linear', cars: { ...CARS(), a2: { drive: 'fwd' } } });
    expect(next.simulation.vehicles!.cars!.carA).toBe(withVehicles.simulation.vehicles.cars.carA); // source entries untouched
    expect(withVehicles.simulation.vehicles.cars).not.toHaveProperty('a2');
    // A document with the vehicle model on but no car entries yet gets its first one.
    const bare = { ...doc.settings, simulation: { ...doc.settings.simulation, vehicles: { model: 'dynamics' as const } } };
    expect(addCarSettings(bare, { a2: { drive: 'fwd' } }).simulation.vehicles).toEqual({ model: 'dynamics', cars: { a2: { drive: 'fwd' } } });
  });

  it('re-keys every entry to the new ids (old keys gone, occupants re-pointed); no entries → the same object', () => {
    const doc = createEmptyDocument();
    expect(rekeyCarSettings(doc.settings, [['carA', 'n1']])).toBe(doc.settings);
    const s = { ...doc.settings, simulation: { ...doc.settings.simulation, vehicles: { model: 'dynamics' as const, abs: true, cars: CARS() } } };
    const out = rekeyCarSettings(s, [['carA', 'n1'], ['carB', 'n2'], ['p', 'n3'], ['q', 'n4']]);
    expect(Object.keys(out.simulation.vehicles!.cars!).sort()).toEqual(['n1', 'n2']);
    expect(out.simulation.vehicles!.cars!.n2.occupants!.map((o) => o.human)).toEqual(['n3', 'n4']);
    expect(out.simulation.vehicles!.abs).toBe(true);
    // No car of the entries was created: the `cars` key is left out, as the project loader writes it.
    expect(rekeyCarSettings(s, [['other', 'n9']]).simulation.vehicles).toEqual({ model: 'dynamics', abs: true });
  });
});
