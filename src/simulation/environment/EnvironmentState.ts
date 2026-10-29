import { FireChannel } from '../fire/FireChannel';
import { VolcanoChannel } from '../volcano/VolcanoChannel';
import { AtmosphereChannel } from '../atmosphere/AtmosphereChannel';
import { ClimateChannel } from '../climate/ClimateChannel';
import { GravityChannel } from '../gravity/GravityChannel';
import { defaultFireSettings, type FireSettings } from '@/fire/types';
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
import { BlastChannel } from '../blast/BlastChannel';
import { ThermalChannel } from '../thermal/ThermalChannel';
import { defaultThermalSettings, type ThermalSettings } from '@/thermal/ThermalWorld';

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
  /** Pressure channel (Phase 24): air-pressure waves (virtual releases, impact airbursts / air-coupled shares). */
  blast: BlastChannel;
  /** Temperature channel (Phase 26): heat sources, impact heat deposits, the thermal state of the run. */
  thermal: ThermalChannel;
  /** Fire channel (Phase 27): ignitions and the combustion state on top of the thermal state. */
  fire: FireChannel;
  /** Volcano channel (Phase 28): eruptions, the lava / deposit / ash state on top of the thermal state. */
  volcano: VolcanoChannel;
  /** Atmosphere channel (Phase 29): the air mass / pressure / flow of an atmosphere experiment (dormant otherwise). */
  atmosphere: AtmosphereChannel;
  /** Climate channel (Phase 30): heatwaves / cold waves, humidity, snow, ice and water phase change (dormant otherwise). */
  climate: ClimateChannel;
  /** Gravity channel (Phase 31): the field g(x, t) of gravity experiments (dormant otherwise — every system on its constant). */
  gravity: GravityChannel;
}

export function createEnvironment(
  airDensity = AIR_DENSITY,
  windModel: WindModelSettings = DEFAULT_WIND_MODEL,
  seed = 1,
  terrain: TerrainSampler = flatSampler(),
  water: WaterSettings = defaultWaterSettings(),
  thermal: ThermalSettings = defaultThermalSettings(),
  fire: FireSettings = defaultFireSettings(),
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
    blast: new BlastChannel(),
    thermal: new ThermalChannel(thermal, airDensity),
    fire: new FireChannel(fire),
    volcano: new VolcanoChannel(deformation),
    atmosphere: new AtmosphereChannel(),
    climate: new ClimateChannel(),
    gravity: new GravityChannel(),
  };
}

export type { Vec3 };
