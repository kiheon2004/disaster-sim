/**
 * Plain, serializable event specifications. This is the contract between the Command System
 * (parser / UI form / future LLM) and the Event System.
 */
import type { CompassDir } from '@/core/compass';

export type EventType =
  | 'wind'
  | 'earthquake'
  | 'flood'
  | 'tsunami'
  | 'rain'
  | 'snow'
  | 'fire'
  | 'explosion';

/** Event types that are recognized but not simulated yet. */
export const UNSUPPORTED_EVENT_TYPES: EventType[] = ['earthquake', 'flood', 'tsunami', 'rain', 'snow', 'fire', 'explosion'];

export interface WindEventSpec {
  event: 'wind';
  /** Target mean wind speed at 10 m (m/s). */
  speed: number;
  /** Direction the wind blows FROM: compass point or bearing in degrees. */
  direction: CompassDir | number;
  /** Total event length in seconds, including ramps. */
  duration: number;
  /** 0–1 gust intensity (default 0.25). */
  gustStrength?: number;
  /** Absolute simulation time to start at (default: now). */
  startTime?: number;
  /** Speed at the beginning of the ramp (default: the wind blowing at that moment). */
  rampFrom?: number;
  /** Seconds to reach the target speed (default 3). */
  rampDuration?: number;
}

export type EventSpec = WindEventSpec;
