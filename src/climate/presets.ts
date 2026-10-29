/**
 * Climate experiment presets (Phase 30): small worlds — terrain, ground, lakes, objects, the climate experiment and the
 * phenomena it acts with — and the assumptions / model limits they rest on (shown before loading). LOCAL reduced
 * models on the 200 m world; none is a forecast, a real place or a safety assessment. Some presets compress time
 * (a short "day", strong rates) so that the response is visible within minutes — each says so.
 */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { LakeFeature } from '@/landscape/types';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { defaultClimateSpec, type ClimateScenario, type ClimateSpec } from './types';
import { T_MELT } from './constants';

export const CLIMATE_PRESETS = [
  'summerHeatwave', 'extremeCold', 'heavySnowfall', 'snowAccumulation', 'snowmeltFlood', 'roadIcing', 'lakeFreezing', 'freezeThaw',
  'solarHeating', 'heatwaveDrying', 'snowLoadedBuilding', 'volcanoSnow',
] as const;
export type ClimatePresetId = (typeof CLIMATE_PRESETS)[number];

export interface ClimatePreset {
  height: (x: number, z: number) => number;
  /** Ground type id at a point (terrain/GroundMaterials; default grass). */
  ground?: (x: number, z: number) => number;
  lake?: LakeFeature;
  objects: CreateObjectInput[];
  events: EventSpec[];
  /** Fire settings (live crown moisture etc.). */
  fire?: { foliageMoisture: number; openings: 'asBuilt' | 'windowsOpen' | 'closed'; heatIgnition: boolean };
  assumptions: string[];
  seconds: number;
}

const K = (c: number) => c + T_MELT;
const round = (v: number) => Math.round(v * 100) / 100;
const T = (x: number, z: number, yaw = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const building = (x: number, z: number, seed: number, preset = 'house'): CreateObjectInput => ({ type: 'building', building: createDesign(presetSpec(preset)!, preset), seed, transform: T(x, z) });
const conifer = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: T(x, z) });
const broadleaf = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'tree', params: { species: 'broadleaf', height: 9, canopyRadius: 3, trunkRadius: 0.3 }, seed, transform: T(x, z) });
const car = (x: number, z: number, seed: number, yaw = 0): CreateObjectInput => ({ type: 'car', seed, transform: T(x, z, yaw) });
const person = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'human', seed, transform: T(x, z) });
const road = (x: number, z: number, seed: number, yaw = 0): CreateObjectInput => ({ type: 'road', seed, transform: T(x, z, yaw) });
const flat = () => 0;
const ASPHALT = 3;
// The default spec is a heatwave with a drying humidity target: a preset that does not ask for a humidity change keeps
// its humidity (no inherited humidityTarget — it ran snowfall presets at 25 % RH).
export const climate = (p: Partial<ClimateSpec>): EventSpec => ({ ...defaultClimateSpec(), humidityTarget: undefined, startTime: 0, ...p } as EventSpec);
const wind = (speed: number, dir = 'W', startTime = 0): EventSpec => ({ event: 'wind', speed, direction: dir, duration: 3600, startTime } as EventSpec);

/** Defaults the editor applies when a scenario is chosen (a starting point; every field stays editable). */
export function scenarioDefaults(s: ClimateScenario): Partial<ClimateSpec> {
  switch (s) {
    case 'heatwave': return { temperature: K(26), target: K(38), profile: 'smooth', ramp: 1800, humidity: 0.45, humidityTarget: 0.25, precipitation: 0, solar: 'clearSky', hour: 11, dayOfYear: 200, cloud: 0 };
    case 'coldWave': return { temperature: K(2), target: K(-18), profile: 'smooth', ramp: 1800, humidity: 0.7, humidityTarget: 0.6, precipitation: 0, solar: 'clearSky', hour: 20, dayOfYear: 20, cloud: 0 };
    case 'rapidCooling': return { temperature: K(12), target: K(-8), profile: 'linear', ramp: 600, humidity: 0.7, precipitation: 0 };
    case 'rapidWarming': return { temperature: K(-6), target: K(12), profile: 'linear', ramp: 600, humidity: 0.7, precipitation: 0 };
    case 'snowfall': return { temperature: K(-3), target: K(-3), profile: 'constant', humidity: 0.9, precipitation: 10, precipPhase: 'auto', precipProfile: 'peak', solar: 'off' };
    case 'freezingRain': return { temperature: K(-3), target: K(-3), profile: 'constant', humidity: 0.95, precipitation: 3, precipPhase: 'rain', solar: 'off', initialFrost: 0.1 };
    case 'frost': return { temperature: K(3), target: K(-4), profile: 'smooth', ramp: 2400, humidity: 0.9, precipitation: 0, solar: 'off', cloud: 0 };
    case 'roadIcing': return { temperature: K(2), target: K(-6), profile: 'linear', ramp: 1200, humidity: 0.9, precipitation: 3, precipPhase: 'rain', precipStart: 0, precipDuration: 1800, solar: 'off' };
    case 'lakeFreezing': return { temperature: K(0.5), target: K(-20), profile: 'smooth', ramp: 900, humidity: 0.7, precipitation: 0, solar: 'off' };
    case 'snowmelt': return { temperature: K(2), target: K(14), profile: 'linear', ramp: 1800, humidity: 0.85, initialSnow: 0.4, initialSnowDensity: 300, solar: 'clearSky', hour: 11, dayOfYear: 100 };
    case 'thawing': return { temperature: K(-2), target: K(10), profile: 'linear', ramp: 1800, humidity: 0.7, initialFrost: 0.3, solar: 'clearSky', hour: 11, dayOfYear: 90 };
    case 'drying': return { temperature: K(30), target: K(36), profile: 'linear', ramp: 1800, humidity: 0.3, humidityTarget: 0.15, soilMoisture: 0.25, solar: 'clearSky', hour: 11, dayOfYear: 200 };
    case 'humid': return { temperature: K(28), target: K(28), profile: 'constant', humidity: 0.95, solar: 'clearSky', hour: 14, dayOfYear: 210, cloud: 0.6 };
    case 'custom': return {};
  }
}

/** A small street: houses, cars, trees, a person. */
function street(): CreateObjectInput[] {
  return [building(-30, -20, 7), building(-5, -20, 8), building(20, -20, 9), car(-20, 5, 5), car(5, 6, 6), conifer(-35, 25, 3), conifer(-25, 28, 4), broadleaf(30, 25, 5), person(-8, 10, 11)];
}

export function climatePreset(id: ClimatePresetId): ClimatePreset {
  switch (id) {
    case 'summerHeatwave':
      return { height: flat, objects: street(), seconds: 3600,
        events: [climate({ scenario: 'heatwave', ...scenarioDefaults('heatwave'), duration: 3600 })],
        assumptions: ['climate.preset.as.flux', 'climate.preset.as.solarClear', 'climate.preset.as.noAutoIgnition'] };
    case 'extremeCold':
      return { height: flat, objects: street(), seconds: 3600,
        events: [climate({ scenario: 'coldWave', ...scenarioDefaults('coldWave'), target: K(-25), duration: 3600, soilMoisture: 0.3 }), wind(4)],
        assumptions: ['climate.preset.as.flux', 'climate.preset.as.nightSky', 'climate.preset.as.soilFreezing'] };
    case 'heavySnowfall':
      return { height: flat, objects: street(), seconds: 2400,
        events: [climate({ scenario: 'snowfall', temperature: K(-2), target: K(-4), profile: 'linear', ramp: 2400, duration: 2400, humidity: 0.92, precipitation: 20, precipPhase: 'auto', precipProfile: 'peak', solar: 'off' }), wind(5)],
        assumptions: ['climate.preset.as.splitWetBulb', 'climate.preset.as.strongRate', 'climate.preset.as.massNotParticles'] };
    case 'snowAccumulation':
      return { height: (x, z) => round(Math.max(0, 12 - Math.hypot(x + 50, z) * 0.2)), objects: [...street(), conifer(10, 30, 21), conifer(16, 34, 22), car(30, -2, 23)], seconds: 1800,
        events: [climate({ scenario: 'snowfall', temperature: K(-5), target: K(-5), duration: 1800, humidity: 0.9, precipitation: 12, precipPhase: 'snow', initialSnow: 0.15, initialSnowDensity: 150, solar: 'off' }), wind(9)],
        assumptions: ['climate.preset.as.initialSnow', 'climate.preset.as.blowing', 'climate.preset.as.interception'] };
    case 'snowmeltFlood': {
      const valley = (x: number, z: number) => round(Math.min(18, Math.abs(z) * 0.25 + Math.max(0, x + 20) * 0.05));
      return { height: valley, objects: [building(60, -25, 7), building(70, 25, 8), car(50, 8, 9), conifer(-40, 40, 3), conifer(-50, -40, 4)], seconds: 3600,
        events: [climate({ scenario: 'snowmelt', temperature: K(1), target: K(12), profile: 'linear', ramp: 1200, duration: 3600, humidity: 0.95, humidityTarget: 0.95, initialSnow: 0.3, initialSnowDensity: 400, initialFrost: 0.15, precipitation: 25, precipPhase: 'rain', precipStart: 300, precipDuration: 2700, solar: 'clearSky', hour: 11, dayOfYear: 100, cloud: 0.7 }), wind(6)],
        assumptions: ['climate.preset.as.rainOnSnow', 'climate.preset.as.meltToFlood', 'climate.preset.as.frozenGround', 'climate.preset.as.strongRate'] };
    }
    case 'roadIcing':
      return { height: flat, ground: (_x, z) => (Math.abs(z) <= 5 ? ASPHALT : 0), objects: [road(-40, 0, 1), road(0, 0, 2), road(40, 0, 3), car(-30, -2, 5), car(-10, 2, 6, Math.PI), car(15, -2, 7), person(25, 7, 11), building(0, -25, 8)], seconds: 2400,
        events: [climate({ scenario: 'roadIcing', ...scenarioDefaults('roadIcing'), duration: 2400 }), wind(6, 'N', 900)],
        assumptions: ['climate.preset.as.wetThenFreeze', 'climate.preset.as.frictionCoeff', 'climate.preset.as.noTyreModel'] };
    case 'lakeFreezing': {
      const lake: LakeFeature = { id: 'lake1', kind: 'lake', points: [[-60, -45], [40, -45], [40, 45], [-60, 45]], surface: -0.3, depth: 0.8, shoreWidth: 3, material: 7, filled: true };
      return { height: flat, lake, objects: [conifer(60, 30, 3), conifer(65, -20, 4), building(75, 0, 7)], seconds: 3600,
        events: [climate({ scenario: 'lakeFreezing', ...scenarioDefaults('lakeFreezing'), duration: 3600 }), wind(5)],
        assumptions: ['climate.preset.as.coldLake', 'climate.preset.as.mixedWater', 'climate.preset.as.floatingIce'] };
    }
    case 'freezeThaw':
      return { height: flat, ground: (x) => (x < 0 ? ASPHALT : 1), objects: [building(-30, 20, 7), building(30, 20, 8)], seconds: 7200,
        events: [climate({ scenario: 'custom', temperature: K(-6), target: K(6), profile: 'cyclic', period: 2400, duration: 7200, humidity: 0.85, soilMoisture: 0.3, precipitation: 1.5, precipPhase: 'auto', precipStart: 0, precipDuration: 1200, solar: 'off' })],
        assumptions: ['climate.preset.as.shortCycle', 'climate.preset.as.cyclesCounted', 'climate.preset.as.noCracking'] };
    case 'solarHeating':
      return { height: (x, z) => round(Math.max(0, 15 - Math.hypot(x - 50, z + 40) * 0.3)), ground: (x) => (x < -20 ? ASPHALT : x < 20 ? 4 : 0), objects: [building(-40, 30, 7), building(0, 30, 8), car(-45, -10, 9), conifer(40, 20, 3)], seconds: 1800,
        events: [climate({ scenario: 'custom', temperature: K(25), target: K(25), profile: 'constant', duration: 1800, humidity: 0.4, solar: 'clearSky', latitude: 37.5, dayOfYear: 172, hour: 12, cloud: 0 })],
        assumptions: ['climate.preset.as.solarClear', 'climate.preset.as.albedo', 'climate.preset.as.shadows'] };
    case 'heatwaveDrying': {
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) objects.push(conifer(-30 + i * 7, -10 + j * 7, 30 + i * 3 + j));
      objects.push(building(30, 0, 7));
      return { height: flat, objects, seconds: 3600, fire: { foliageMoisture: 1.2, openings: 'asBuilt', heatIgnition: false },
        events: [climate({ scenario: 'heatwave', temperature: K(32), target: K(41), profile: 'smooth', ramp: 1800, duration: 3600, humidity: 0.25, humidityTarget: 0.12, soilMoisture: 0.05, solar: 'clearSky', hour: 12, dayOfYear: 205 }), wind(4)],
        assumptions: ['climate.preset.as.drySoil', 'climate.preset.as.liveFloor', 'climate.preset.as.noAutoIgnition'] };
    }
    case 'snowLoadedBuilding':
      return { height: flat, objects: [building(0, 0, 7, 'warehouse'), building(30, 20, 8), car(-20, 18, 5)], seconds: 1800,
        events: [climate({ scenario: 'snowfall', temperature: K(-1), target: K(-1), duration: 1800, humidity: 0.95, initialSnow: 0.8, initialSnowDensity: 350, precipitation: 25, precipPhase: 'snow', solar: 'off' })],
        assumptions: ['climate.preset.as.roofLoad', 'climate.preset.as.loadPath', 'climate.preset.as.snowKept'] };
    case 'volcanoSnow': {
      const slope = (x: number) => round(x < 40 ? (40 - Math.max(-100, x)) * Math.tan(5 * Math.PI / 180) : 0);
      return { height: (x) => slope(x), objects: [building(30, -15, 7), conifer(10, 20, 3)], seconds: 1200,
        events: [
          climate({ scenario: 'custom', temperature: K(-4), target: K(-4), profile: 'constant', duration: 1200, humidity: 0.8, initialSnow: 0.5, initialSnowDensity: 300, solar: 'off' }),
          { event: 'volcano', vents: [{ kind: 'central', position: [-60, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 900, profile: 'constant', ashFraction: 0.1, plumeHeight: 60, startTime: 30 } as EventSpec,
        ],
        assumptions: ['climate.preset.as.lavaMeltsSnow', 'climate.preset.as.ashAlbedo', 'climate.preset.as.noSteamExplosion'] };
    }
  }
}
