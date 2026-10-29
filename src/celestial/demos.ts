/**
 * Demo worlds of the celestial presets (Phase 32): a small block — houses, a warehouse, an office, cars, people,
 * trees, a pond — with the preset's celestial experiment and, where the preset needs it, companion phenomena: a
 * zero uniform gravity (Phase 31 gravity experiment, constant, hold) for the orbit laboratories, a larger town, a hill,
 * a tower, a meteor. Not a real place; the masses are educational (scaled to the sandbox) except where stated.
 */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { LakeFeature } from '@/landscape/types';
import { createDesign } from '@/buildings/design';
import { presetSpec as buildingSpec } from '@/buildings/spec';
import { defaultGravitySpec } from '@/gravity/types';
import { presetSpec, ZERO_G_SCENARIOS } from './presets';
import type { CelestialScenario } from './types';

export interface CelestialDemo {
  objects: CreateObjectInput[];
  lake?: LakeFeature;
  /** Terrain height (m) at a world point (flat when absent). */
  height?: (x: number, z: number) => number;
  events: EventSpec[];
  /** Assumption keys shown before loading (i18n). */
  assumptions: string[];
}

const T = (x: number, z: number, yaw = 0, y = 0): CreateObjectInput['transform'] => ({ position: [x, y, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const building = (x: number, z: number, seed: number, preset: string): CreateObjectInput => ({ type: 'building', building: createDesign(buildingSpec(preset)!, preset), seed, transform: T(x, z) });
const tree = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'tree', params: { species: seed % 2 ? 'conifer' : 'broadleaf', height: 9 + (seed % 3), canopyRadius: 2.4, trunkRadius: 0.3 }, seed, transform: T(x, z) });

function base(): CreateObjectInput[] {
  const out: CreateObjectInput[] = [
    building(-40, -30, 1, 'house'), building(-22, -30, 2, 'house'), building(-4, -30, 3, 'warehouse'), building(30, -30, 4, 'office'),
    tree(-46, -8, 5), tree(-34, -8, 6),
  ];
  for (let k = 0; k < 6; k++) out.push({ type: 'car', seed: 20 + k, transform: T(-30 + k * 9, 6, Math.PI / 2) });
  for (let k = 0; k < 6; k++) out.push({ type: 'human', seed: 40 + k, transform: T(-26 + k * 8, 14) });
  return out;
}

/** A town of 4 × 5 houses / offices around the centre (nearCity, stress). */
function town(): CreateObjectInput[] {
  const out = base();
  let seed = 100;
  for (const x of [-70, -50, 50, 70]) for (const z of [-60, -30, 0, 30, 60]) out.push(building(x, z, seed++, seed % 3 ? 'house' : 'office'));
  for (let k = 0; k < 6; k++) out.push({ type: 'car', seed: 60 + k, transform: T(-20 + k * 8, 30, 0) });
  return out;
}

const POND: LakeFeature = { id: 'pond', kind: 'lake', points: [[40, 10], [80, 10], [80, 45], [40, 45]], surface: -0.2, depth: 1.2, shoreWidth: 3, material: 7, filled: true } as LakeFeature;

/** A smooth hill (cosine bump) east of the centre: 35 m high, 60 m base radius. */
const hill = (x: number, z: number) => {
  const r = Math.hypot(x - 40, z);
  return r < 60 ? 17.5 * (1 + Math.cos((Math.PI * r) / 60)) : 0;
};

export function celestialDemo(s: CelestialScenario): CelestialDemo {
  const c = { ...presetSpec(s), startTime: 2 } as unknown as EventSpec;
  const events: EventSpec[] = [c];
  let objects = base();
  const assumptions = ['celestial.demo.world', 'celestial.lim.scaled', 'celestial.lim.noGR'];
  let height: CelestialDemo['height'];
  if (ZERO_G_SCENARIOS.includes(s)) {
    events.unshift({ ...defaultGravitySpec(), scenario: 'zero', magnitude: 0, profile: 'constant', duration: 6 * 3600, end: 'hold', startTime: 0, name: 'zero-g' } as unknown as EventSpec);
    assumptions.push('celestial.demo.zeroG');
  }
  if (s === 'nearCity' || s === 'stress') { objects = town(); assumptions.push('celestial.demo.town'); }
  if (s === 'nearMountain') {
    height = hill;
    objects = objects.filter((o) => o.type !== 'building');
    for (let k = 0; k < 10; k++) objects.push(tree(40 + 35 * Math.cos(k * 0.628), 35 * Math.sin(k * 0.628), 200 + k));
    assumptions.push('celestial.demo.mountain');
  }
  if (s === 'collapse') { objects.push(building(30, 30, 9, 'tower')); assumptions.push('celestial.demo.collapse'); }
  if (s === 'meteor') {
    events.push({ event: 'impact', target: [10, 30], material: 'stony', diameter: 1, speed: 15000, angle: 60, azimuth: 45, entry: 'direct', airBlast: true, startTime: 20 } as EventSpec);
    assumptions.push('celestial.demo.meteor');
  }
  if (s === 'comparison') assumptions.push('celestial.demo.comparison');
  return { objects, lake: POND, height, events, assumptions };
}
