import type { SimulationEvent } from './SimulationEvent';
import type { EventSpec } from './specs';
import type { TerrainData, WaterSettings } from '@/core/model';
import { phenomena } from '@/phenomena/registry';

/**
 * Event factory. Since Phase 15 it delegates to the PhenomenonRegistry: to add a hazard, write a
 * PhenomenonDefinition (src/phenomena/definitions.ts) that creates its SimulationEvent.
 */
/** Context an event may need besides its spec (e.g. the project's simulation seed). */
export interface EventDefaults {
  seed: number;
  /** Frozen terrain of the run (rising water: edge ground, default duration). */
  terrain?: TerrainData | null;
  water?: WaterSettings;
}

export function createEvent(spec: EventSpec, now: number, defaults: EventDefaults = { seed: 1 }): SimulationEvent {
  const def = phenomena.implemented(spec.event);
  if (!def) throw new Error(`Unsupported event: ${spec.event}`);
  return def.createEvent(spec, now, { seed: defaults.seed, terrain: defaults.terrain ?? null, water: defaults.water });
}

export function isEventSupported(type: string): boolean {
  return phenomena.implemented(type) !== undefined;
}
