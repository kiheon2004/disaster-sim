import type { Vec3 } from '@/core/types';
import { AIR_DENSITY } from '@/core/units';
import { DEFAULT_WIND_MODEL, defaultWaterSettings, type WaterSettings, type WindModelSettings } from '@/core/model';
import { WindField } from './WindField';
import { SpatialWindField } from '../wind/SpatialWindField';
import { flatSampler, type TerrainSampler } from '@/terrain/TerrainSampler';
import { GroundMotionField } from '../seismic/GroundMotionField';
import { FloodEnvironment } from '../water/FloodEnvironment';
import { DeformationChannel } from '../deformation/DeformationChannel';
import { GroundFailureChannel } from '../ground/GroundFailureChannel';
import { ImpactChannel } from '../impact/ImpactChannel';

/**
 * Shared environmental fields. Events WRITE the global values; systems READ local values.
 *  - wind:       global wind written by WindEvents (speed, bearing, gust)
 *  - windField:  spatial field derived from `wind` + obstacles + turbulence (what objects feel)
 *  - terrain:    read-only ground (elevation, slope, ground type, soil) shared by every system
 *  - groundMotion: earthquake ground displacement/velocity/acceleration field (Phase 13),
 *                written by EarthquakeEvents, inactive (= zero) otherwise
 *  - flood:      water model (Phase 14): rain / sources / boundary levels written by water
 *                events, the WaterField advanced by the WaterSolverSystem; dormant (no grid)
 *                until the first water event starts
 * New hazards add their own field (fire, …) without touching objects.
 */
export interface EnvironmentState {
  time: number;
  airDensity: number;
  wind: WindField;
  windField: SpatialWindField;
  terrain: TerrainSampler;
  groundMotion: GroundMotionField;
  flood: FloodEnvironment;
  /** Terrain deformation channel (Phase 21): runtime displacement sources over the run's terrain copy. */
  deformation: DeformationChannel;
  /** Ground-failure channel (Phase 22): sinkholes, landslides and the shared geotechnical field. */
  groundFailure: GroundFailureChannel;
  /** Impact channel (Phase 23): impact models, stats, atmospheric-blast sources for Phase 24. */
  impact: ImpactChannel;
  // Future: fire?: FireField;
}

export function createEnvironment(
  airDensity = AIR_DENSITY,
  windModel: WindModelSettings = DEFAULT_WIND_MODEL,
  seed = 1,
  terrain: TerrainSampler = flatSampler(),
  water: WaterSettings = defaultWaterSettings(),
): EnvironmentState {
  const wind = new WindField();
  wind.terrain = terrain;
  const deformation = new DeformationChannel(terrain.data, seed);
  return {
    time: 0, airDensity, wind, windField: new SpatialWindField(wind, windModel, seed), terrain, groundMotion: new GroundMotionField(terrain),
    flood: new FloodEnvironment(terrain, water),
    deformation,
    groundFailure: new GroundFailureChannel(terrain.data, deformation),
    impact: new ImpactChannel(),
  };
}

export type { Vec3 };
