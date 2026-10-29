/**
 * Atmosphere experiment presets (Phase 29): small educational worlds — terrain, objects, the experiment
 * and the phenomena it acts on — with the assumptions and model limits they rest on (shown before
 * loading). Every preset is a LOCAL reduced model on the 200 m world; none is a model of a real place,
 * a weather situation or a safety assessment.
 */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { FireSettings } from '@/fire/types';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { AtmosphereSpec } from './types';

export const ATMOS_PRESETS = ['standard', 'highAltitude', 'reducedPressure', 'gradualRemoval', 'restoration', 'heatedPlume', 'pressureFlow', 'windDensity', 'smoke', 'volcanicAsh', 'fireReduced'] as const;
export type AtmosPresetId = (typeof ATMOS_PRESETS)[number];

export interface AtmosPreset {
  /** Terrain height (m) at a world point. */
  height: (x: number, z: number) => number;
  objects: CreateObjectInput[];
  events: EventSpec[];
  /** Fire settings of the world (fire presets: dry crowns). */
  fire?: FireSettings;
  assumptions: string[];
  seconds: number;
}

const DEG = Math.PI / 180;
const round = (v: number) => Math.round(v * 100) / 100;
const T = (x: number, z: number, yaw = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const building = (x: number, z: number, seed: number, preset = 'house'): CreateObjectInput => ({ type: 'building', building: createDesign(presetSpec(preset)!, preset), seed, transform: T(x, z) });
const conifer = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: T(x, z) });
const car = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'car', seed, transform: T(x, z) });
const sign = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'sign', seed, transform: T(x, z) });
const lamp = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'streetLight', seed, transform: T(x, z) });
const atmos = (p: Partial<AtmosphereSpec>): EventSpec => ({ event: 'atmosphere', altitude: 0, boundary: 'open', thermo: 'adiabatic', removal: 'none', startTime: 0, ...p } as EventSpec);
const wind = (speed: number, startTime = 0): EventSpec => ({ event: 'wind', speed, direction: 'W', duration: 3600, startTime } as EventSpec);
const flat = () => 0;
const hill = (x: number, z: number) => round(Math.max(0, 30 - Math.hypot(x - 40, z) * 0.6));
const DRY: FireSettings = { foliageMoisture: 0.2, openings: 'asBuilt', heatIgnition: false };

/** A small street: houses, cars, trees, a sign and a streetlight. */
function street(): CreateObjectInput[] {
  return [building(-30, -20, 7), building(-5, -20, 8), building(20, -20, 9), car(-20, 5, 5), car(5, 6, 6), conifer(-35, 25, 3), conifer(-25, 28, 4), conifer(30, 25, 5), sign(-10, 12, 2), lamp(15, 12, 3)];
}

export function atmosPreset(id: AtmosPresetId): AtmosPreset {
  switch (id) {
    case 'standard':
      return { height: flat, objects: street(), events: [atmos({}), wind(12)], seconds: 120,
        assumptions: ['atmos.preset.as.isa', 'atmos.preset.as.restState', 'atmos.preset.as.windBackground'] };
    case 'highAltitude':
      return { height: hill, objects: street(), events: [atmos({ altitude: 3000 }), wind(12)], seconds: 120,
        assumptions: ['atmos.preset.as.isa3000', 'atmos.preset.as.hydrostatic', 'atmos.preset.as.loadsDensity'] };
    case 'reducedPressure':
      return { height: flat, objects: street(), events: [atmos({ pressure: 50_000 }), wind(18)], seconds: 120,
        assumptions: ['atmos.preset.as.partial', 'atmos.preset.as.loadsDensity', 'atmos.preset.as.notPlanet'] };
    case 'gradualRemoval':
      return { height: flat, objects: street(), events: [atmos({ removal: 'linear', extent: 'uniform', target: 0.1, duration: 600 }), wind(12)], seconds: 900,
        assumptions: ['atmos.preset.as.massLeaves', 'atmos.preset.as.adiabatic', 'atmos.preset.as.groundWarms'] };
    case 'restoration':
      return { height: flat, objects: street(), seconds: 900,
        events: [atmos({ removal: 'linear', extent: 'uniform', target: 0.3, duration: 300, restore: 'boundary', restoreAt: 360, restoreDuration: 300, restoreTarget: 1 }), wind(8)],
        assumptions: ['atmos.preset.as.massLeaves', 'atmos.preset.as.restoreBoundary', 'atmos.preset.as.ledger'] };
    case 'heatedPlume':
      return { height: flat, objects: [conifer(-20, 10, 3), conifer(20, -10, 4), building(30, 25, 7)], seconds: 300,
        events: [atmos({}), { event: 'heatSource', kind: 'volume', position: [0, 0], height: 5, radius: 4, input: 'power', power: 3e6, profile: 'constant', duration: 300, startTime: 0 } as EventSpec],
        assumptions: ['atmos.preset.as.plume', 'atmos.preset.as.continuity', 'atmos.preset.as.notCfd'] };
    case 'pressureFlow':
      return { height: flat, objects: [sign(-30, 0, 2), sign(30, 0, 3), conifer(0, -30, 4), conifer(0, 30, 5), lamp(-15, 15, 6)], seconds: 360,
        events: [atmos({ removal: 'linear', extent: 'local', position: [0, 0], radius: 15, target: 0.995, duration: 300 })],
        assumptions: ['atmos.preset.as.sink', 'atmos.preset.as.continuity', 'atmos.preset.as.openRefill'] };
    case 'windDensity': {
      const objects = street();
      objects.push(conifer(-45, -40, 6), conifer(-40, -45, 7), sign(40, 10, 8), lamp(40, -5, 9), car(35, 30, 10));
      return { height: flat, objects, events: [atmos({ removal: 'linear', extent: 'uniform', target: 0.4, duration: 120 }), wind(26)], seconds: 240,
        assumptions: ['atmos.preset.as.loadsDensity', 'atmos.preset.as.designSeaLevel', 'atmos.preset.as.windBackground'] };
    }
    case 'smoke': {
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) objects.push(conifer(-40 + i * 6, -6 + j * 6, 20 + i * 3 + j));
      return { height: flat, objects, fire: DRY, seconds: 300,
        events: [atmos({ removal: 'linear', extent: 'local', position: [20, 0], radius: 12, target: 0.997, duration: 240 }), wind(3), { event: 'fire', position: [-40, 0], height: 6, radius: 2.5, duration: 600, startTime: 5 } as EventSpec],
        assumptions: ['atmos.preset.as.smokeSeparate', 'atmos.preset.as.sink', 'atmos.preset.as.dryCrowns'] };
    }
    case 'volcanicAsh': {
      const h = (x: number) => round(x < 40 ? (40 - Math.max(-100, x)) * Math.tan(5 * DEG) : 0);
      return { height: (x) => h(x), objects: [building(10, -15, 7), building(30, 15, 8)], seconds: 600,
        events: [
          atmos({ removal: 'linear', extent: 'uniform', target: 0.3, duration: 120 }), wind(6),
          { event: 'volcano', vents: [{ kind: 'central', position: [-60, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 1.5, duration: 400, profile: 'constant', ashFraction: 0.2, plumeHeight: 80, startTime: 120 } as EventSpec,
        ],
        assumptions: ['atmos.preset.as.ashSettling', 'atmos.preset.as.gasTracer', 'atmos.preset.as.ashSeparate'] };
    }
    case 'fireReduced': {
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) objects.push(conifer(-6 + i * 6, -6 + j * 6, 40 + i * 3 + j));
      return { height: flat, objects, fire: DRY, seconds: 300,
        events: [atmos({ removal: 'linear', extent: 'uniform', boundary: 'closed', target: 0.3, duration: 60 }), { event: 'fire', position: [-6, -6], height: 6, radius: 2.5, duration: 600, startTime: 70 } as EventSpec],
        assumptions: ['atmos.preset.as.o2Mass', 'atmos.preset.as.fireRange', 'atmos.preset.as.dryCrowns'] };
    }
  }
}
