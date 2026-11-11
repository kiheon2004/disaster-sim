/**
 * Default world (Phase 35.5) — what a first launch opens. The same small town as sampleTown() (kept unchanged: the golden /
 * regression tests are built on it), rebuilt with the systems the user can also place:
 *
 *  - roads are NETWORK roads from the cross-section presets (roads/crossSection.ts): the main street is the wide two-lane
 *    section (2 × 3.5 m lanes + 1.5 m shoulders = 10 m, the same carriageway as before), the side street the normal two-lane
 *    section (7 m = the road tool's and the palette's "2-lane road"); they meet in a T junction, baked into the terrain;
 *  - buildings are member-modelled (modular) buildings of different structural systems — masonry, reinforced-concrete
 *    frames, a steel frame, timber houses and a light steel shed — instead of single-box legacy buildings, so damage and
 *    collapse follow their members and load paths.
 *
 * Deterministic (seeded); positions keep clear of the wider road section and its sidewalks.
 */
import type { CreateObjectInput } from './WorldDocument';
import { seededRandom } from '@/core/math';
import type { ObjectParams } from '@/core/model';
import { PALETTE } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';
import { createDesign } from '@/buildings/design';
import { defaultSpec, presetSpec } from '@/buildings/spec';
import type { BuildingSpec } from '@/buildings/types';
import { drawRoad } from '@/roads/network';
import { defaultProfile, emptyNetwork, PROFILE_PRESETS, type RoadNetwork, type RoadProfile } from '@/roads/types';

const item = (id: string) => PALETTE.find((p) => p.id === id)!;

function place(id: string, x: number, z: number, yaw: number, rnd: () => number, extra: Record<string, number | string | boolean> = {}): CreateObjectInput {
  const it = item(id);
  const def = getDefinition(it.type);
  let params = { ...def.defaultParams, ...(it.params ?? {}), ...extra };
  if (it.randomize && def.randomizeParams) params = { ...params, ...(def.randomizeParams(params, rnd) as ObjectParams) };
  return { type: it.type, params, seed: Math.floor(rnd() * 2 ** 31), transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] } };
}

function building(spec: BuildingSpec, preset: string | undefined, x: number, z: number, yaw: number, rnd: () => number): CreateObjectInput {
  return { type: 'building', building: createDesign(spec, preset), seed: Math.floor(rnd() * 2 ** 31), transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] } };
}

const masonry = (patch: Partial<BuildingSpec>): BuildingSpec => ({
  ...defaultSpec(), system: 'masonry', structureMaterial: 'masonry', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'masonry',
  foundation: 'spread', bay: 4, occupancy: 'residential', ...patch,
});
const rc = (patch: Partial<BuildingSpec>): BuildingSpec => ({ ...defaultSpec(), system: 'rcFrame', ...patch });

const profile = (preset: string): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[preset] ?? {}) });

/** The town's road network: main street (wide two-lane) + side street (normal two-lane) meeting in a T. */
export function defaultTownRoads(): RoadNetwork {
  let n = emptyNetwork();
  n = drawRoad(n, [[-56, 0], [56, 0]], { curved: false, profile: profile('wide') }).network;
  n = drawRoad(n, [[-23, 0], [-23, 46]], { curved: false, profile: profile('street') }).network;
  return n;
}

/** Objects of the default town. */
export function defaultTownObjects(): CreateObjectInput[] {
  const rnd = seededRandom(20261029);
  const out: CreateObjectInput[] = [];
  const N = 0, S = Math.PI;
  // North side (front to the street, z < 0).
  out.push(building(masonry({ width: 12, depth: 10, floors: 3, color: '#c9b79c' }), undefined, -34, -15, N, rnd));
  out.push(building({ ...presetSpec('office')!, width: 16, depth: 12, floors: 9, color: '#8d9db2' }, 'office', -14, -16.5, N, rnd));
  out.push(building(presetSpec('house')!, 'house', 2, -13, N, rnd));
  out.push(building(rc({ width: 12, depth: 10, floors: 5, color: '#b88f7a', sign: true }), undefined, 16, -15, N, rnd));
  out.push(building({ ...presetSpec('apartment')!, width: 14, depth: 14, floors: 12, color: '#9aa7b8' }, 'apartment', 35, -17.5, N, rnd));
  // South side (front to the street, z > 0); the side street runs north–south at x = −23.
  out.push(building(masonry({ width: 10, depth: 10, floors: 4, color: '#d8c9a6' }), undefined, -37, 15, S, rnd));
  out.push(building({ ...presetSpec('house')!, color: '#d4c2a1' }, 'house', -9, 13, S, rnd));
  out.push(building(rc({ width: 12, depth: 9, floors: 2, color: '#c7a98d' }), undefined, 7, 14.5, S, rnd));
  out.push(building({ ...presetSpec('warehouse')!, width: 14, depth: 10, floorHeight: 5, groundFloorHeight: 5, color: '#c7ccd1' }, 'warehouse', -8, 32, S, rnd));

  // Street trees in the verge behind the sidewalks (sidewalk 5–7.5 m from the axis).
  for (let x = -44; x <= 46; x += 9) {
    if (Math.abs(x + 23) > 5) out.push(place('tree.broadleaf', x + (rnd() - 0.5), -8.6, rnd() * 6, rnd));
    if (x % 2 === 0 && Math.abs(x + 4 + 23) > 5) out.push(place('tree.broadleaf', x + 4 + (rnd() - 0.5), 8.6, rnd() * 6, rnd));
  }
  // A small park with conifers.
  for (let i = 0; i < 9; i++) {
    out.push(place(i % 3 === 0 ? 'tree.broadleaf' : 'tree.conifer', 26 + (i % 3) * 6 + rnd() * 2, 16 + Math.floor(i / 3) * 6 + rnd() * 2, rnd() * 6, rnd));
  }
  // Street furniture on the sidewalks.
  for (let x = -44; x <= 44; x += 16) {
    out.push(place('infra.streetLight', x, -6.2, Math.PI / 2, rnd));
    if (Math.abs(x + 8 + 23) > 6) out.push(place('infra.streetLight', x + 8, 6.2, -Math.PI / 2, rnd));
  }
  out.push(place('infra.sign', -46, -6.8, 0, rnd));
  out.push(place('infra.sign', 42, 6.8, Math.PI, rnd));
  out.push(place('infra.billboard', 50, -12, -Math.PI / 4, rnd));
  out.push(place('infra.fence', 35, 12.5, 0, rnd, { length: 20 }));
  out.push(place('infra.wall', -47, 22, Math.PI / 2, rnd, { length: 10 }));

  // Parked cars on the shoulders (shoulder 3.5–5 m from the axis), length along the street.
  const colors = ['#3d6fd6', '#d64545', '#e9e9e6', '#2d2f33', '#3c8f5a', '#c9a227'];
  [-32, -14, -2, 12].forEach((x, i) => out.push(place('car.sedan', x, -4.2, 0, rnd, { color: colors[i % colors.length] })));
  out.push(place('car.suv', 24, -4.2, 0, rnd, { color: '#e9e9e6' }));
  [-12, 2, 16].forEach((x, i) => out.push(place('car.sedan', x, 4.2, Math.PI, rnd, { color: colors[(i + 3) % colors.length] })));
  out.push(place('car.truck', 32, 4.3, Math.PI, rnd));
  // People on the sidewalks.
  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -6.3 : 6.3;
    const x = -40 + i * 7 + rnd() * 2;
    out.push(place('human.adult', Math.abs(x + 23) < 6 ? x + 8 : x, side + (rnd() - 0.5) * 0.8, rnd() * Math.PI * 2, rnd));
  }
  return out;
}

/**
 * Structure lab (Phase 36 §51): a flat test ground with one building of each structural type side by side at the same
 * height class (steel frame, RC frame, masonry, timber — 3 storeys, same plan), on one straight street with parked cars
 * and people on the sidewalk — for comparing how the types respond to the same disaster. Deterministic.
 */
export function structureLabRoads(): RoadNetwork {
  return drawRoad(emptyNetwork(), [[-80, 0], [80, 0]], { curved: false, profile: profile('street') }).network;
}

export function structureLabObjects(): CreateObjectInput[] {
  const rnd = seededRandom(20261110);
  const out: CreateObjectInput[] = [];
  const plan = { width: 12, depth: 10, floors: 3, floorHeight: 3.2, groundFloorHeight: 3.6, bay: 4, sign: false };
  // Street 'street' = 7 m carriageway + 2 m sidewalks: the outer edge at 5.5 m; buildings 1.5 m behind it.
  const z = -(5.5 + 1.5 + plan.depth / 2);
  const specs: [BuildingSpec, string][] = [
    [{ ...defaultSpec(), ...plan, system: 'steelFrame', structureMaterial: 'structuralSteel', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'glass', color: '#8d9db2' }, 'steel'],
    [rc({ ...plan, color: '#b88f7a' }), 'rc'],
    [masonry({ ...plan, color: '#c9b79c' }), 'masonry'],
    [{ ...defaultSpec(), ...plan, system: 'wood', structureMaterial: 'timber', slabMaterial: 'timber', claddingMaterial: 'timber', color: '#d4c2a1' }, 'timber'],
  ];
  specs.forEach(([spec], i) => out.push(building(spec, undefined, -42 + i * 28, z, 0, rnd)));
  [-30, 0, 30].forEach((x) => out.push(place('car.sedan', x, 2.2, 0, rnd)));
  for (let i = 0; i < 6; i++) out.push(place('human.adult', -50 + i * 20, -4.6, rnd() * Math.PI * 2, rnd));
  return out;
}
