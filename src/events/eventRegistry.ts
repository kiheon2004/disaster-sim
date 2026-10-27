import type { SimulationEvent } from './SimulationEvent';
import type { EventSpec } from './specs';
import { WindEvent } from './wind/WindEvent';

/**
 * Factory per event type. To add a hazard: implement SimulationEvent, add its spec to specs.ts,
 * register it here, and add the environmental field + system that reacts to it.
 */
type Factory = (spec: EventSpec, now: number) => SimulationEvent;

const factories: Partial<Record<EventSpec['event'], Factory>> = {
  wind: (spec, now) => new WindEvent(spec, now),
};

export function createEvent(spec: EventSpec, now: number): SimulationEvent {
  const f = factories[spec.event];
  if (!f) throw new Error(`Unsupported event: ${spec.event}`);
  return f(spec, now);
}

export function isEventSupported(type: string): boolean {
  return type in factories;
}
