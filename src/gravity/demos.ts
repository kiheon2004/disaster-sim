/**
 * Demo worlds of the gravity presets (Phase 31): a small flat block — houses, a warehouse, an office, cars, people,
 * trees, a pond — with the preset's gravity experiment and, where the preset needs it, a companion phenomenon
 * (roof snow for "High gravity + snow", a taller frame for "High gravity + structural collapse"). Not a real place;
 * the Moon / Mars presets change the gravity magnitude only (air, ground and climate stay the project's).
 */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { LakeFeature } from '@/landscape/types';
import { createDesign } from '@/buildings/design';
import { presetSpec as buildingSpec } from '@/buildings/spec';
import { defaultClimateSpec } from '@/climate/types';
import { T_MELT } from '@/climate/constants';
import { presetSpec } from './presets';
import type { GravityScenario } from './types';

export interface GravityDemo {
  objects: CreateObjectInput[];
  lake?: LakeFeature;
  events: EventSpec[];
  /** Assumption keys shown before loading (i18n). */
  assumptions: string[];
}

const T = (x: number, z: number, yaw = 0, y = 0): CreateObjectInput['transform'] => ({ position: [x, y, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const building = (x: number, z: number, seed: number, preset: string): CreateObjectInput => ({ type: 'building', building: createDesign(buildingSpec(preset)!, preset), seed, transform: T(x, z) });

function base(): CreateObjectInput[] {
  const out: CreateObjectInput[] = [
    building(-40, -30, 1, 'house'), building(-22, -30, 2, 'house'), building(-4, -30, 3, 'warehouse'), building(30, -30, 4, 'office'),
    { type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed: 5, transform: T(-46, -8) },
    { type: 'tree', params: { species: 'broadleaf', height: 9, canopyRadius: 3, trunkRadius: 0.3 }, seed: 6, transform: T(-34, -8) },
  ];
  for (let k = 0; k < 6; k++) out.push({ type: 'car', seed: 20 + k, transform: T(-30 + k * 9, 6, Math.PI / 2) });
  for (let k = 0; k < 6; k++) out.push({ type: 'human', seed: 40 + k, transform: T(-26 + k * 8, 14) });
  return out;
}

const POND: LakeFeature = { id: 'pond', kind: 'lake', points: [[40, 10], [80, 10], [80, 45], [40, 45]], surface: -0.2, depth: 1.2, shoreWidth: 3, material: 7, filled: true } as LakeFeature;

export function gravityDemo(s: GravityScenario): GravityDemo {
  const g = { ...presetSpec(s), startTime: 2 } as unknown as EventSpec;
  const events: EventSpec[] = [g];
  const objects = base();
  const assumptions = ['gravity.demo.world', 'gravity.as.mass'];
  if (s === 'highSnow') {
    events.unshift({ ...defaultClimateSpec(), scenario: 'custom', profile: 'constant', solar: 'off', precipitation: 0, temperature: T_MELT - 4, target: T_MELT - 4, humidity: 0.85, humidityTarget: undefined, duration: 3600, initialSnow: 0.6, initialSnowDensity: 200, blowingSnow: false, startTime: 0 } as unknown as EventSpec);
    assumptions.push('gravity.demo.snow');
  }
  if (s === 'highCollapse') {
    objects.push(building(30, 30, 9, 'tower'));
    assumptions.push('gravity.demo.collapse');
  }
  if (s === 'moon' || s === 'mars') assumptions.push('gravity.as.bodyMagnitude');
  return { objects, lake: POND, events, assumptions };
}
