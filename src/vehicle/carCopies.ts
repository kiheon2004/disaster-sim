/**
 * Car settings of copied cars (Phase 37 §17). `settings.simulation.vehicles.cars` is keyed by object id, so a copy of a
 * car (duplicate, paste, Blueprint placement, a template applied over the current world) has no settings until they are
 * written under its new id. This is the ONE rule for all of those paths — and for the stamp data in between: a
 * clipboard / Blueprint carries the settings of its cars under its own local keys, made and read by the same function.
 *
 * Rule
 *   - every setting of a car (level, drive, ABS, constant controls, timed program, autopilot) goes to its copy;
 *   - an occupant stays only when the person was copied in the same stamp, pointed at that person's copy; otherwise
 *     it is dropped (a person cannot sit in two cars);
 *   - autopilot paths are NOT moved with the copy: they are absolute world coordinates (Phase 37 audit §6, decision
 *     E9), so a copy drives the source's path until the user edits it.
 *
 * Pure: no stores, no ids made here. Values are deep copies (the source entries are never shared or changed).
 */
import type { WorldDocument } from '@/core/model';
import type { VehicleCar } from './settings';

/** Car entries by key (object id, or a stamp's local key). A null entry (an invalid one in a file) is skipped. */
export type CarSettingsMap = Readonly<Record<string, VehicleCar | null | undefined>>;

/**
 * Settings for the copies. `pairs` = [key of the source, key of its copy] for EVERY object of the stamp (cars, people,
 * anything else) — one copy per source. Returns only the entries of the copies (empty when no copied car had settings).
 */
export function carSettingsOfCopies(cars: CarSettingsMap | undefined, pairs: Iterable<readonly [source: string, copy: string]>): Record<string, VehicleCar> {
  const out: Record<string, VehicleCar> = {};
  if (!cars) return out;
  const copyOf = new Map<string, string>();
  for (const [source, copy] of pairs) copyOf.set(source, copy);
  for (const [source, copy] of copyOf) {
    const entry = Object.hasOwn(cars, source) ? cars[source] : null;
    if (!entry) continue;
    const car: VehicleCar = structuredClone(entry);
    const occupants = car.occupants?.filter((o) => copyOf.has(o.human)).map((o) => ({ ...o, human: copyOf.get(o.human)! }));
    if (occupants?.length) car.occupants = occupants;
    else delete car.occupants;
    out[copy] = car;
  }
  return out;
}

/**
 * `settings` with `entries` added to `simulation.vehicles.cars`. The SAME object comes back when there is nothing to
 * add or the document has no vehicle settings (legacy cars: a copy never switches the vehicle model on).
 */
export function addCarSettings(settings: WorldDocument['settings'], entries: Readonly<Record<string, VehicleCar>>): WorldDocument['settings'] {
  const vehicles = settings.simulation.vehicles;
  if (!vehicles || !Object.keys(entries).length) return settings;
  return { ...settings, simulation: { ...settings.simulation, vehicles: { ...vehicles, cars: { ...vehicles.cars, ...entries } } } };
}

/**
 * The settings of a document whose objects all get new ids (a template applied over the current world): the car
 * entries are re-keyed to the new ids (entries of objects that were not created are left out). The same object comes
 * back when the settings hold no car entries.
 */
export function rekeyCarSettings(settings: WorldDocument['settings'], pairs: Iterable<readonly [source: string, copy: string]>): WorldDocument['settings'] {
  const vehicles = settings.simulation.vehicles;
  if (!vehicles?.cars) return settings;
  const cars = carSettingsOfCopies(vehicles.cars, pairs);
  const { cars: _old, ...rest } = vehicles;
  void _old;
  return { ...settings, simulation: { ...settings.simulation, vehicles: { ...rest, ...(Object.keys(cars).length ? { cars } : {}) } } };
}
