/**
 * Fire scenario presets (Phase 27): small educational worlds with their fire scenario, world fire
 * settings and the assumptions they rest on (shown before loading). They only place objects,
 * conditions and an ignition point — no fuel recipes or anything tuned to make a fire bigger.
 */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { CreateObjectInput } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { FireSettings } from './types';

export const FIRE_PRESETS = ['singleRoom', 'materialHeating', 'vegetation', 'windFire', 'structuralWeakening', 'burningDebris', 'waterCooling'] as const;
export type FirePresetId = (typeof FIRE_PRESETS)[number];

export interface FirePreset {
  objects: CreateObjectInput[];
  settings: FireSettings;
  /** Phenomena of the experiment (startTime = experiment start offset). */
  events: EventSpec[];
  /** Assumptions shown before loading (i18n keys). */
  assumptions: string[];
  /** Suggested run length (s). */
  seconds: number;
}

const T = (x: number, z: number, yaw = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const building = (preset: string, x: number, z: number, seed: number): CreateObjectInput => ({ type: 'building', building: createDesign(presetSpec(preset)!, preset), seed, transform: T(x, z) });
const conifer = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: T(x, z) });
const fire = (x: number, z: number, height: number, radius: number, duration: number, startTime = 0): EventSpec => ({ event: 'fire', position: [x, z], height, radius, duration, startTime } as EventSpec);
const base: FireSettings = { foliageMoisture: 1.5, openings: 'asBuilt', heatIgnition: false };

export function firePreset(id: FirePresetId): FirePreset {
  switch (id) {
    case 'singleRoom':
      return { objects: [building('house', 0, 0, 7)], settings: { ...base, openings: 'windowsOpen' }, events: [fire(0, 0, 1, 1, 1500)], seconds: 1500,
        assumptions: ['fire.preset.as.dwelling', 'fire.preset.as.windowsOpen', 'fire.preset.as.oneRoom'] };
    case 'materialHeating':
      return { objects: [building('warehouse', 0, 0, 11)], settings: { ...base, openings: 'windowsOpen' }, events: [fire(0, 0, 1, 1, 1800)], seconds: 1800,
        assumptions: ['fire.preset.as.storage', 'fire.preset.as.steel', 'fire.preset.as.windowsOpen'] };
    case 'vegetation': {
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) objects.push(conifer(-7.5 + i * 5, -5 + j * 5, 20 + i * 3 + j));
      return { objects, settings: { ...base, foliageMoisture: 0.2 }, events: [fire(-7.5, -5, 6, 2, 300)], seconds: 300,
        assumptions: ['fire.preset.as.dryCrowns', 'fire.preset.as.crownDensity', 'fire.preset.as.noGround'] };
    }
    case 'windFire': {
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) objects.push(conifer(-17.5 + i * 7, -7 + j * 7, 40 + i * 3 + j));
      return { objects, settings: { ...base, foliageMoisture: 0.2 }, events: [{ event: 'wind', speed: 10, direction: 'W', duration: 600, startTime: 0 } as EventSpec, fire(-17.5, 0, 6, 2, 400, 5)], seconds: 400,
        assumptions: ['fire.preset.as.dryCrowns', 'fire.preset.as.spacing7', 'fire.preset.as.windTilt'] };
    }
    case 'structuralWeakening':
      return { objects: [building('house', 0, 0, 7)], settings: { ...base, openings: 'windowsOpen' }, events: [fire(0, 0, 1, 1, 3600)], seconds: 3600,
        assumptions: ['fire.preset.as.dwelling', 'fire.preset.as.timberFrame', 'fire.preset.as.charSection'] };
    case 'burningDebris':
      return { objects: [building('house', 0, 0, 7), conifer(9, -2, 51), conifer(9, 4, 52), conifer(-9, 3, 53)], settings: { ...base, openings: 'windowsOpen', foliageMoisture: 0.25 }, events: [fire(0, 0, 1, 1, 3600)], seconds: 3600,
        assumptions: ['fire.preset.as.dwelling', 'fire.preset.as.debris', 'fire.preset.as.dryCrowns'] };
    case 'waterCooling': {
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) objects.push(conifer(-7.5 + i * 5, -5 + j * 5, 60 + i * 3 + j));
      return { objects, settings: { ...base, foliageMoisture: 0.2 }, events: [fire(-7.5, -5, 6, 2, 300), { event: 'rain', intensity: 150, duration: 240, startTime: 20 } as EventSpec], seconds: 300,
        assumptions: ['fire.preset.as.dryCrowns', 'fire.preset.as.rain', 'fire.preset.as.evaporation'] };
    }
  }
}
