import type { Vec3 } from '@/core/types';
import { AIR_DENSITY } from '@/core/units';
import { DEFAULT_WIND_MODEL, type WindModelSettings } from '@/core/model';
import { WindField } from './WindField';
import { SpatialWindField } from '../wind/SpatialWindField';
import { flatSampler, type TerrainSampler } from '@/terrain/TerrainSampler';
import { GroundMotionField } from '../seismic/GroundMotionField';

/**
 * Shared environmental fields. Events WRITE the global values; systems READ local values.
 *  - wind:       global wind written by WindEvents (speed, bearing, gust)
 *  - windField:  spatial field derived from `wind` + obstacles + turbulence (what objects feel)
 *  - terrain:    read-only ground (elevation, slope, ground type, soil) shared by every system
 *  - groundMotion: earthquake ground displacement/velocity/acceleration field (Phase 13),
 *                written by EarthquakeEvents, inactive (= zero) otherwise
 * New hazards add their own field (water level, …) without touching objects.
 */
export interface EnvironmentState {
  time: number;
  airDensity: number;
  wind: WindField;
  windField: SpatialWindField;
  terrain: TerrainSampler;
  groundMotion: GroundMotionField;
  // Future: waterLevel?: WaterField (Phase 14 flood); precipitation?: number; fire?: FireField;
}

export function createEnvironment(
  airDensity = AIR_DENSITY,
  windModel: WindModelSettings = DEFAULT_WIND_MODEL,
  seed = 1,
  terrain: TerrainSampler = flatSampler(),
): EnvironmentState {
  const wind = new WindField();
  wind.terrain = terrain;
  return { time: 0, airDensity, wind, windField: new SpatialWindField(wind, windModel, seed), terrain, groundMotion: new GroundMotionField(terrain) };
}

export type { Vec3 };
