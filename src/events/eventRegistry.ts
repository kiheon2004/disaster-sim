import type { SimulationEvent } from './SimulationEvent';
import type { EventSpec } from './specs';
import { WindEvent } from './wind/WindEvent';
import { EarthquakeEvent } from './earthquake/EarthquakeEvent';
import { RainEvent, RisingWaterEvent, WaterSourceEvent } from './flood/WaterEvents';
import type { TerrainData, WaterSettings } from '@/core/model';

/**
 * Factory per event type. To add a hazard: implement SimulationEvent, add its spec to specs.ts,
 * register it here, and add the environmental field + system that reacts to it.
 */
/** Context an event may need besides its spec (e.g. the project's simulation seed). */
export interface EventDefaults {
  seed: number;
  /** Frozen terrain of the run (rising water: edge ground, default duration). */
  terrain?: TerrainData | null;
  water?: WaterSettings;
}

type Factory = (spec: EventSpec, now: number, defaults: EventDefaults) => SimulationEvent;

const factories: Partial<Record<EventSpec['event'], Factory>> = {
  wind: (spec, now) => new WindEvent(spec as Extract<EventSpec, { event: 'wind' }>, now),
  earthquake: (spec, now, d) => new EarthquakeEvent(spec as Extract<EventSpec, { event: 'earthquake' }>, now, d.seed),
  rain: (spec, now) => new RainEvent(spec as Extract<EventSpec, { event: 'rain' }>, now),
  risingWater: (spec, now, d) => new RisingWaterEvent(spec as Extract<EventSpec, { event: 'risingWater' }>, now, d.terrain ?? null, d.water),
  waterSource: (spec, now) => new WaterSourceEvent(spec as Extract<EventSpec, { event: 'waterSource' }>, now),
};

export function createEvent(spec: EventSpec, now: number, defaults: EventDefaults = { seed: 1 }): SimulationEvent {
  const f = factories[spec.event];
  if (!f) throw new Error(`Unsupported event: ${spec.event}`);
  return f(spec, now, defaults);
}

export function isEventSupported(type: string): boolean {
  return type in factories;
}
