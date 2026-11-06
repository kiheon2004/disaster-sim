import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { Vec3 } from '@/core/types';
import type { VehicleSettings } from '@/vehicle/settings';
import { OCCUPANT_STATES, ROLLOVER, VEHICLE_DAMAGE, VEHICLE_SERIES_KEYS } from '@/simulation/vehicle/state';
import {
  aggregateVehicles, vehicleCsv, vehicleEntities, vehicleJson, vehicleRow, VEHICLE_CSV_COLUMNS, VEHICLE_EXPORT_SCHEMA, VEHICLE_MODEL_VERSION, VEHICLE_SERIES_UNITS, WHEEL_NAMES,
} from '@/simulation/vehicle/summary';
import { clearLiveInput, enableLiveInput, setLiveInput, startAutopilot, stopAutopilot } from '@/simulation/vehicle/control';
import { koVehicleUi } from '@/i18n/locales/ko.vehicleUi';
import { enVehicleUi } from '@/i18n/locales/en.vehicleUi';
import { isMessageKey } from '@/i18n/i18n';
import { SLIP_COLORS } from '@/rendering/vehicle/VehicleLayer';
import { keyInput } from '@/ui/Inspector/VehicleControls';

const S = () => useWorldStore.getState();
const car = (x: number) => ({ type: 'car', params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#ffffff' }, transform: { position: [x, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } });

/** A wheeled car (first id) and a rigid Level 1 car (second id), both parked. */
async function load() {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 5;
  S().applyEdit({ add: [car(0), car(20)] as never });
  const doc = structuredClone(S().doc);
  const [a, b] = Object.keys(doc.objects).sort();
  doc.settings.simulation.vehicles = { model: 'dynamics', cars: { [b]: { level: 'rigid' } } } satisfies VehicleSettings;
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  return { c, a, b };
}

describe('vehicle results (Phase 35 UI)', () => {
  it('rows, aggregate, CSV and JSON carry the schema, units, parameters; uncomputed = null / empty, never 0; live input drives the car', async () => {
    const { c, a, b } = await load();
    const rt = c.getRuntime()!;
    const cars = vehicleEntities(rt.entities.values());
    expect(cars.map((e) => e.id).sort()).toEqual([a, b]);
    const ea = cars.find((e) => e.id === a)!, eb = cars.find((e) => e.id === b)!;
    // Before the first step: no energy ledger yet.
    const r0 = vehicleRow(ea, c.getPhysics());
    expect(r0.E).toBeNull();
    expect(r0.residual).toBeNull();
    expect(r0.controlSource).toBe('parked');

    // Live input (same API as the sliders / keyboard): clamped, rigid car refused, acts from the next step.
    expect(setLiveInput(c, b, { throttle: 1 })).toBe(false);
    expect(enableLiveInput(c, a)).toBe(true);
    expect(ea.vehicle.live).toMatchObject({ throttle: 0, brake: 0, steer: 0, gear: 'D', handbrake: false });
    expect(setLiveInput(c, a, { throttle: 7, steer: -3 })).toBe(true);
    expect(ea.vehicle.live!.throttle).toBe(1);
    expect(ea.vehicle.live!.steer).toBe(-1);
    setLiveInput(c, a, { steer: 0, throttle: 0.6 });
    c.advance(4);
    const r = vehicleRow(ea, c.getPhysics());
    expect(r.controlSource).toBe('live');
    expect(r.throttle).toBeCloseTo(0.6, 9);
    expect(r.speed!).toBeGreaterThan(2);
    expect(r.wheels).toHaveLength(4);
    expect(r.wheels!.map((w) => w.wheel)).toEqual([...WHEEL_NAMES]);
    expect(r.E).not.toBeNull();
    expect(r.ledgerDrive!).toBeGreaterThan(0);
    expect(r.engineRpm!).toBeGreaterThan(0);
    // The rigid car: no wheels / powertrain / LTR (null), speed only with the physics engine.
    const rb = vehicleRow(eb, c.getPhysics());
    expect(rb.wheels).toBeNull();
    expect(rb.gear).toBeNull();
    expect(rb.ltr).toBeNull();
    expect(rb.accelLong).toBeNull();
    expect(rb.speed).not.toBeNull();
    expect(vehicleRow(eb).speed).toBeNull();
    expect(clearLiveInput(c, a)).toBe(true);
    expect(ea.vehicle.live).toBeNull();

    const ag = aggregateVehicles(rt.entities.values(), c.getPhysics());
    expect(ag.vehicles).toBe(2);
    expect(ag.wheeled).toBe(1);
    expect(ag.rigid).toBe(1);
    expect(ag.damage.intact).toBe(2);
    expect(ag.maxSpeed!).toBeGreaterThan(2);

    const csv = vehicleCsv(rt.entities.values(), c.getDamageEvents(), c.getTime(), c.getPhysics()).split('\n');
    expect(csv[0]).toBe(`# schema: disaster-sim.vehicles v${VEHICLE_EXPORT_SCHEMA}`);
    expect(csv[1]).toContain(VEHICLE_MODEL_VERSION);
    expect(csv.some((l) => l.startsWith('# units:'))).toBe(true);
    expect(csv.some((l) => l.startsWith('# limits:') && l.includes('crash-test'))).toBe(true);
    const cols = VEHICLE_CSV_COLUMNS as readonly string[];
    const hi = csv.indexOf(cols.join(','));
    expect(hi).toBeGreaterThan(0);
    const rows = [csv[hi + 1].split(','), csv[hi + 2].split(',')];
    for (const row of rows) expect(row).toHaveLength(cols.length);
    const rigid = rows.find((row) => row[cols.indexOf('vehicle_id')] === b)!;
    expect(rigid[cols.indexOf('level')]).toBe('rigid');
    expect(rigid[cols.indexOf('gear')]).toBe('');
    expect(rigid[cols.indexOf('ltr')]).toBe('');
    expect(rigid[cols.indexOf('drive_work_J')]).toBe('');
    const wheeled = rows.find((row) => row[cols.indexOf('vehicle_id')] === a)!;
    expect(wheeled[cols.indexOf('model_version')]).toBe(VEHICLE_MODEL_VERSION);
    expect(Number(wheeled[cols.indexOf('speed_ms')])).toBeGreaterThan(2);
    expect(csv.some((l) => l.startsWith('# wheels'))).toBe(true);
    expect(csv.filter((l) => l.startsWith(`${a},FL,`) || l.startsWith(`${a},RR,`))).toHaveLength(2);
    expect(csv.some((l) => l.startsWith('# series'))).toBe(true);

    const j = JSON.parse(JSON.stringify(vehicleJson(rt.entities.values(), c.getDamageEvents(), rt.vehicles, c.getPhysics())));
    expect(j.schemaVersion).toBe(VEHICLE_EXPORT_SCHEMA);
    expect(j.modelVersion).toBe(VEHICLE_MODEL_VERSION);
    expect(j.units.force).toBe('N');
    expect(j.parameters.ckPerLoad.unit).toBe('1');
    expect(j.variants.sedan.wheelRadius).toBeGreaterThan(0);
    expect(j.limits.length).toBeGreaterThan(3);
    expect(Object.keys(j.seriesUnits).sort()).toEqual([...VEHICLE_SERIES_KEYS].sort());
    const ja = j.vehicles.find((v: { id: string }) => v.id === a), jb = j.vehicles.find((v: { id: string }) => v.id === b);
    expect(ja.wheels).toHaveLength(4);
    expect(ja.geometry.springRate).toHaveLength(4);
    expect(ja.series.t.length).toBeGreaterThan(4);
    expect(jb.wheels).toBeNull();
    // The rigid car records no wheel quantities: its wheel series are gaps (null), not zeros.
    expect(jb.series.slip.every((x: number | null) => x === null)).toBe(true);
    expect(jb.series.speed.some((x: number | null) => x !== null)).toBe(true);
    expect(vehicleJson([], [], undefined)).toBeUndefined();

    // Autopilot: to a typed point, stopped; nothing to restart without a configured one.
    expect(startAutopilot(c, a, { x: 50, z: 0, speed: 5 })).toBe(true);
    expect(ea.vehicle.autopilot!.path).toHaveLength(2);
    expect(vehicleRow(ea).controlSource).toBe('autopilot');
    expect(stopAutopilot(c, a)).toBe(true);
    expect(ea.vehicle.autopilot).toBeNull();
    expect(startAutopilot(c, a)).toBe(false);
    expect(startAutopilot(c, b, { x: 1, z: 1 })).toBe(false);
    c.unload();
  });

  it('keyboard axes: pressed = full input, released = 0, opposite steering keys cancel', () => {
    expect(keyInput(new Set(['KeyW']), 'KeyW')).toEqual({ throttle: 1 });
    expect(keyInput(new Set(), 'KeyW')).toEqual({ throttle: 0 });
    expect(keyInput(new Set(['ArrowDown']), 'ArrowDown')).toEqual({ brake: 1 });
    expect(keyInput(new Set(['KeyA']), 'KeyA')).toEqual({ steer: 1 });
    expect(keyInput(new Set(['KeyD']), 'KeyD')).toEqual({ steer: -1 });
    expect(keyInput(new Set(['KeyA', 'ArrowRight']), 'KeyA')).toEqual({ steer: 0 });
    expect(keyInput(new Set(['KeyX']), 'KeyX')).toEqual({ handbrake: true });
    expect(keyInput(new Set(), 'KeyQ')).toEqual({});
  });

  it('i18n: every UI key in both languages, non-empty; every state / label family has its keys', () => {
    const ko = Object.keys(koVehicleUi), en = Object.keys(enVehicleUi);
    expect([...en].sort()).toEqual([...ko].sort());
    expect(ko.every((k) => k.startsWith('vehicleUi.'))).toBe(true);
    for (const v of [...Object.values(koVehicleUi), ...Object.values(enVehicleUi)]) expect((v as string).length).toBeGreaterThan(0);
    const fam: [string, readonly string[]][] = [
      ['damage', VEHICLE_DAMAGE], ['roll', ROLLOVER], ['occ', OCCUPANT_STATES], ['seat', ['driver', 'front', 'rearLeft', 'rearRight']],
      ['src', ['parked', 'constant', 'program', 'autopilot', 'live']], ['drive', ['fwd', 'rwd', 'awd']], ['tire', ['saturating', 'linear']],
      ['level', ['vehicle', 'rigid']], ['variant', ['sedan', 'suv', 'truck']], ['partner', ['ground', 'vehicle', 'human', 'structure', 'object', 'debris']],
      ['gear', ['P', 'R', 'N', 'D']], ['wheel', WHEEL_NAMES], ['legend', Object.keys(SLIP_COLORS)],
      ['overlay', ['contacts', 'normals', 'tyre', 'suspension', 'com', 'velocity', 'slip', 'ltr', 'impulse']],
    ];
    for (const [f, ids] of fam) for (const id of ids) expect(isMessageKey(`vehicleUi.${f}.${id}`), `${f}.${id}`).toBe(true);
    expect(Object.keys(VEHICLE_SERIES_UNITS).sort()).toEqual([...VEHICLE_SERIES_KEYS].sort());
  });
});
