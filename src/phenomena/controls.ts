/**
 * Which run-time controls a phenomenon supports, by type (Phase 37). While a simulation runs this is read from the live
 * event (`SimulationController.instances()[i].stop / pause`); a command planned in the editor has no event to ask, so
 * the same facts are kept here as a table — and a test builds every type's event and checks the table against it
 * (`events/EventScheduler.ts controlsOf`). Before its start every instance can be cancelled, whatever its type.
 */
import type { EventSpec } from '@/events/specs';

export interface ControlSupport {
  /** Can be stopped for good after it started. */
  stop: boolean;
  /** Can be paused and resumed. */
  pause: boolean;
}

const BOTH: ControlSupport = { stop: true, pause: true };
const STOP: ControlSupport = { stop: true, pause: false };
const NONE: ControlSupport = { stop: false, pause: false };

export const CONTROL_SUPPORT: Readonly<Record<string, ControlSupport>> = {
  wind: STOP, heatSource: STOP,
  rain: BOTH, risingWater: BOTH, waterSource: BOTH, earthquake: BOTH, tornado: BOTH,
  blast: NONE, impact: NONE, sinkhole: NONE, landslide: NONE, terrainDeformation: NONE, fire: NONE, volcano: NONE,
  atmosphere: NONE, climate: NONE, gravity: NONE, celestial: NONE,
};

export const controlSupport = (type: string): ControlSupport => CONTROL_SUPPORT[type] ?? NONE;

/**
 * The single state a spec occupies, or null: map-wide wind, map-wide rain and rising water on one map edge exist once
 * — when a second one starts it replaces the first (events/EventScheduler.ts, same channel). Placing two is allowed;
 * the planner says that the newer one takes over.
 */
export function singleStateOf(type: string, spec: EventSpec): string | null {
  if (type === 'wind') return 'wind';
  if (type === 'rain') return (spec as { area?: unknown }).area ? null : 'rain';
  if (type === 'risingWater') return `water.${String((spec as { boundary?: string }).boundary ?? '')}`;
  return null;
}
