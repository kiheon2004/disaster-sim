/**
 * Plain, serializable event specifications. This is the contract between the Command System
 * (parser / UI form / future LLM) and the Event System.
 */
import type { CompassDir } from '@/core/compass';
import type { BoundarySide } from '@/core/model';

export type EventType =
  | 'wind'
  | 'earthquake'
  | 'rain'
  | 'risingWater'
  | 'waterSource'
  | 'terrainDeformation'
  | 'sinkhole'
  | 'landslide'
  | 'impact'
  | 'blast'
  | 'heatSource'
  | 'flood'
  | 'tsunami'
  | 'snow'
  | 'fire'
  | 'volcano'
  | 'explosion';

/** Event types that are recognized but not simulated yet. ('flood' alone maps to rising water.) */
export const UNSUPPORTED_EVENT_TYPES: EventType[] = ['tsunami', 'snow', 'explosion'];

/** Event types that drive the water model (Phase 14). */
export const WATER_EVENT_TYPES = ['rain', 'risingWater', 'waterSource'] as const;
export type WaterEventType = (typeof WATER_EVENT_TYPES)[number];

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

/** Circular area on the map (world meters). */
export interface CircleArea {
  center: [number, number];
  radius: number;
}

/**
 * Heavy rain (Phase 14): a uniform rainfall intensity over the whole map or a circular area.
 * Water reaches the ground at `intensity` mm/h for `duration` seconds, then infiltrates, drains
 * or runs off over the terrain.
 */
export interface RainEventSpec {
  event: 'rain';
  /** Rainfall intensity, mm/h (millimeters of water depth per hour). */
  intensity: number;
  /** Seconds. */
  duration: number;
  /** null / omitted = the whole map. */
  area?: CircleArea | null;
  /** Absolute simulation time to start at (default: now). */
  startTime?: number;
}

/**
 * Rising water at a map edge (Phase 14): the edge becomes an outside water body whose SURFACE
 * ELEVATION rises from its current level to `level` at `riseRate`, holds there until the event
 * ends, then the edge reverts to its configured boundary condition.
 * `level` is an elevation on the terrain datum (like terrain heights), not a depth.
 */
export interface RisingWaterEventSpec {
  event: 'risingWater';
  boundary: BoundarySide;
  /** Target water surface elevation, m. */
  level: number;
  /** m/min (default 0.5). */
  riseRate?: number;
  /** Total seconds incl. the rise (default: rise time + 180 s hold). */
  duration?: number;
  startTime?: number;
}

/** Local water source (Phase 14): a constant inflow (pipe burst, culvert, pump) at a point. */
export interface WaterSourceEventSpec {
  event: 'waterSource';
  /** World [x, z] (m). */
  position: [number, number];
  /** Inflow, m³/s. */
  rate: number;
  /** Seconds. */
  duration: number;
  /** Radius the inflow is spread over (m, default 2). */
  radius?: number;
  startTime?: number;
}

export type WaterEventSpec = RainEventSpec | RisingWaterEventSpec | WaterSourceEventSpec;

export type EventSpec = WindEventSpec | EarthquakeEventSpec | WaterEventSpec | import('@/deformation/types').TerrainDeformationSpec | import('@/ground/types').SinkholeSpec | import('@/ground/types').LandslideSpec | import('@/impact/types').ImpactSpec | import('@/blast/types').BlastSpec | import('@/thermal/types').HeatSourceSpec | import('@/fire/types').FireSpec | import('@/volcano/types').VolcanoSpec;

export function isWaterEvent(s: EventSpec): s is WaterEventSpec {
  return s.event === 'rain' || s.event === 'risingWater' || s.event === 'waterSource';
}
