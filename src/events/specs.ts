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
export const UNSUPPORTED_EVENT_TYPES: EventType[] = ['flood', 'tsunami', 'rain', 'snow', 'fire', 'explosion'];

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

/**
 * Earthquake (Phase 13). Magnitude and ground-motion intensity are SEPARATE inputs: the
 * magnitude describes the source (it sets default duration and frequency content), while `pga`
 * is the shaking at the site. When `pga` is omitted it is filled with a rough, clearly labeled
 * assumption (see events/earthquake/resolveEarthquake.ts) — never a prediction.
 * The ground motion is a synthetic waveform, not a recorded or predicted one.
 */
export interface EarthquakeEventSpec {
  event: 'earthquake';
  /** Moment magnitude (informational + defaults). */
  magnitude: number;
  /** Epicenter in world coordinates [x, z] (m); may lie far outside the 200 m map. */
  epicenter?: [number, number];
  /** Hypocenter depth (km). */
  depth?: number;
  /** Total event length (s): P onset → strong motion → coda. */
  duration?: number;
  /** Peak horizontal ground acceleration on the reference site (dense soil) at the map center (g). */
  pga?: number;
  /** Dominant frequency of the shaking (Hz). */
  dominantFrequency?: number;
  /** Bearing (deg, 0 = N, 90 = E) of the principal horizontal shaking axis; default = radial from the epicenter. */
  direction?: number;
  /** Peak vertical / peak horizontal acceleration (default 0.5). */
  verticalRatio?: number;
  /** Waveform seed (default: the project's simulation seed). */
  seed?: number;
  /** Absolute simulation time to start at (default: now). */
  startTime?: number;
}

export type EventSpec = WindEventSpec | EarthquakeEventSpec;
