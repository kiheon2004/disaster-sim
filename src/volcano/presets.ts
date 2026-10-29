/**
 * Volcano scenario presets (Phase 28): small educational worlds — terrain, objects, the eruption and the
 * conditions — with the assumptions and model limits they rest on (shown before loading). Every preset is
 * a LOCAL eruption on the 200 m world; none is a model of a real volcano or a hazard forecast.
 */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { LakeFeature } from '@/landscape/types';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { VolcanoSpec } from './types';

export const VOLCANO_PRESETS = ['smallVent', 'fissureFlow', 'cooling', 'lavaDam', 'lavaWater', 'ashFall', 'vegetationFire', 'buildings'] as const;
export type VolcanoPresetId = (typeof VOLCANO_PRESETS)[number];

export interface VolcanoPreset {
  /** Terrain height (m) at a world point. */
  height: (x: number, z: number) => number;
  lake?: LakeFeature;
  /** Objects (their y is set on the terrain by the loader). */
  objects: CreateObjectInput[];
  events: EventSpec[];
  assumptions: string[];
  seconds: number;
}

const DEG = Math.PI / 180;
const round = (v: number) => Math.round(v * 100) / 100;
/** A plane descending toward +x at `deg` up to x = x1, flat beyond. */
const plane = (deg: number, x1 = 40) => (x: number) => round(x < x1 ? (x1 - Math.max(-100, x)) * Math.tan(deg * DEG) : 0);
const T = (x: number, z: number, yaw = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const building = (preset: string, x: number, z: number, seed: number): CreateObjectInput => ({ type: 'building', building: createDesign(presetSpec(preset)!, preset), seed, transform: T(x, z) });
const conifer = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: T(x, z) });
const erupt = (p: Partial<VolcanoSpec>): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-70, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 600, profile: 'constant', startTime: 0, ...p } as EventSpec);

export function volcanoPreset(id: VolcanoPresetId): VolcanoPreset {
  switch (id) {
    case 'smallVent': {
      const h = plane(6);
      return { height: (x) => h(x), objects: [], events: [erupt({ rate: 2, duration: 600 })], seconds: 900,
        assumptions: ['volcano.preset.as.slope6', 'volcano.preset.as.basalt', 'volcano.preset.as.prescribed'] };
    }
    case 'fissureFlow': {
      const h = plane(5);
      return { height: (x) => h(x), objects: [], events: [erupt({ vents: [{ kind: 'fissure', position: [-72, -18], end: [-72, 18], radius: 1.5 }], rate: 5, duration: 600, profile: 'ramp', rampTime: 120 })], seconds: 900,
        assumptions: ['volcano.preset.as.fissure', 'volcano.preset.as.basalt', 'volcano.preset.as.prescribed'] };
    }
    case 'cooling': {
      const h = plane(4);
      return { height: (x) => h(x), objects: [], events: [erupt({ rate: 1, temperature: 1100, duration: 300, profile: 'wane', declineTime: 120 })], seconds: 1800,
        assumptions: ['volcano.preset.as.nearLockup', 'volcano.preset.as.crust', 'volcano.preset.as.deposit'] };
    }
    case 'lavaDam': {
      // A V-shaped valley along x (stream fed upstream); the lava comes down its north flank and crosses it.
      const h = (x: number, z: number) => round(Math.max(0, (60 - Math.max(-100, x)) * Math.tan(3 * DEG)) + Math.abs(z) * 0.18);
      return { height: h, objects: [], seconds: 1500,
        events: [{ event: 'waterSource', position: [-85, 0], rate: 0.3, duration: 1500, radius: 2, startTime: 0 } as EventSpec, erupt({ vents: [{ kind: 'central', position: [-30, -45], radius: 2 }], rate: 3, temperature: 1120, duration: 600 })],
        assumptions: ['volcano.preset.as.valley', 'volcano.preset.as.damWater', 'volcano.preset.as.deposit'] };
    }
    case 'lavaWater': {
      const h = plane(6, 30);
      const lake: LakeFeature = { id: 'lake1', kind: 'lake', points: [[34, -45], [95, -45], [95, 45], [34, 45]], surface: -0.3, depth: 2, shoreWidth: 3, material: 7, filled: true };
      return { height: (x) => h(x), lake, objects: [], events: [erupt({ vents: [{ kind: 'central', position: [10, 0], radius: 2 }], rate: 3, duration: 600 })], seconds: 900,
        assumptions: ['volcano.preset.as.water', 'volcano.preset.as.noSteam', 'volcano.preset.as.prescribed'] };
    }
    case 'ashFall': {
      const h = plane(4);
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) objects.push(building('house', -10 + i * 22, -14 + j * 28, 7 + i * 3 + j));
      return { height: (x) => h(x), objects, seconds: 900,
        events: [{ event: 'wind', speed: 8, direction: 'W', duration: 900, startTime: 0 } as EventSpec, erupt({ rate: 2, duration: 600, ashFraction: 0.25, bombFraction: 0.05, plumeHeight: 80 })],
        assumptions: ['volcano.preset.as.ashRelease', 'volcano.preset.as.ashRoof', 'volcano.preset.as.wind'] };
    }
    case 'vegetationFire': {
      const h = plane(6);
      const objects: CreateObjectInput[] = [];
      for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) objects.push(conifer(-52 + i * 7, -10.5 + j * 7, 30 + i * 4 + j));
      return { height: (x) => h(x), objects, events: [erupt({ rate: 3, duration: 600 })], seconds: 900,
        assumptions: ['volcano.preset.as.fireRules', 'volcano.preset.as.liveCrowns', 'volcano.preset.as.prescribed'] };
    }
    case 'buildings': {
      const h = plane(6);
      return { height: (x) => h(x), objects: [building('house', -45, 0, 7), building('house', -30, 14, 9), { type: 'car', seed: 5, transform: T(-52, -6) }], seconds: 900,
        events: [erupt({ rate: 3, duration: 600 })],
        assumptions: ['volcano.preset.as.obstacle', 'volcano.preset.as.heatedMembers', 'volcano.preset.as.notSafety'] };
    }
  }
}
