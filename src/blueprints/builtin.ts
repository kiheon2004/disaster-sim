/**
 * Built-in example blueprints (Phase 20): read-only library entries generated on demand — a
 * small scene is built in a headless world with the regular tools, then CAPTURED like a user
 * selection. Deterministic (fixed seeds and timestamps), so an example is always the same value.
 */
import type { CreateObjectInput } from '@/world/WorldDocument';
import { createEmptyDocument } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundPose } from '@/terrain/groundPlacement';
import { getDefinition } from '@/objects/registry';
import { designParams } from '@/buildings/design';
import { presetDesign, infrastructureAlong, neighborhood, type CityContext } from '@/roads/city';
import { drawRoad } from '@/roads/network';
import { defaultProfile, PROFILE_PRESETS, type RoadProfile } from '@/roads/types';
import { buildEnvironment } from '@/landscape/presets';
import { waterFeatureAvoid } from '@/landscape/hydrology';
import { planForest } from '@/app/natureActions';
import type { Feature, P2 } from '@/landscape/types';
import { subSeed } from '@/editor/build/distribution';
import { captureBlueprint, type CaptureOptions } from './capture';
import type { BlueprintCategory, UnifiedBlueprint } from './types';
import type { SelectionShape } from './selection';

export type BuiltinBlueprint = 'house' | 'apartments' | 'shoppingStreet' | 'industrialPark' | 'crossroads' | 'forest' | 'mountain' | 'riverBasin' | 'lakeVillage' | 'mixedDistrict';

export const BUILTIN_BLUEPRINTS: { id: BuiltinBlueprint; category: BlueprintCategory; tags: string[] }[] = [
  { id: 'house', category: 'residential', tags: ['house', 'building'] },
  { id: 'apartments', category: 'residential', tags: ['apartment', 'building'] },
  { id: 'shoppingStreet', category: 'commercial', tags: ['street', 'office', 'road'] },
  { id: 'industrialPark', category: 'industrial', tags: ['factory', 'warehouse', 'road'] },
  { id: 'crossroads', category: 'roads', tags: ['intersection', 'road', 'signal'] },
  { id: 'forest', category: 'nature', tags: ['tree', 'forest', 'hill'] },
  { id: 'mountain', category: 'nature', tags: ['mountain', 'ridge', 'terrain'] },
  { id: 'riverBasin', category: 'nature', tags: ['river', 'valley', 'water'] },
  { id: 'lakeVillage', category: 'mixed', tags: ['lake', 'house', 'road'] },
  { id: 'mixedDistrict', category: 'mixed', tags: ['city', 'river', 'forest'] },
];

export const BUILTIN_PREFIX = 'builtin-';
export const isBuiltinId = (id: string) => id.startsWith(BUILTIN_PREFIX);
const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const prof = (k: string, extra: Partial<RoadProfile> = {}): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[k] ?? {}), ...extra });
const rect = (x0: number, z0: number, x1: number, z1: number): SelectionShape => ({ kind: 'rect', x0, z0, x1, z1 });

type Store = ReturnType<typeof scratchWorld>;
const ctx = (st: Store): CityContext => { const d = st.getState().doc; return { terrain: samplerFor(d.terrain), objects: d.objects, network: d.roads, avoid: waterFeatureAvoid(d.landscape.features) }; };
const seeded = (inputs: CreateObjectInput[], seed: number, label: string) => inputs.map((inp, k) => (inp.seed === undefined ? { ...inp, seed: subSeed(seed, label, k) } : inp));

function put(st: Store, type: CreateObjectInput['type'], x: number, z: number, yaw: number, extra: Partial<CreateObjectInput> = {}, seed = 1): CreateObjectInput {
  const params = extra.building ? designParams(extra.building) : { ...getDefinition(type).defaultParams, ...(extra.params ?? {}) };
  const pose = groundPose({ type, params, transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] } }, x, z, yaw, samplerFor(st.getState().doc.terrain));
  return { type, seed, ...extra, transform: { position: pose.position, rotation: pose.rotation, scale: [1, 1, 1] } };
}

function draw(st: Store, pts: P2[], p: RoadProfile) {
  st.getState().applyEdit({ roads: drawRoad(st.getState().doc.roads, pts, { curved: false, profile: p }).network });
}

/** Generate a built-in blueprint (≈ 0.1–1 s; cache the result). */
export function buildBuiltinBlueprint(id: BuiltinBlueprint): UnifiedBlueprint {
  const st = scratchWorld(createEmptyDocument('builtin'));
  const W = () => st.getState();
  let shape: SelectionShape = rect(-20, -20, 20, 20);
  let opts: CaptureOptions = {};
  switch (id) {
    case 'house': {
      const house = presetDesign('house', 2)!;
      W().applyEdit({ add: [
        put(st, 'building', 0, 0, 0, { building: house }, 11),
        put(st, 'tree', -8, 6, 0.4, {}, 12), put(st, 'tree', 8, 7, 1.2, {}, 13), put(st, 'tree', -7, -7, 2.1, {}, 14),
        put(st, 'car', 7, -6, Math.PI / 2, {}, 15),
        put(st, 'wall', 0, 11, 0, { params: { length: 14, height: 1.2, thickness: 0.25 } }, 16),
      ] });
      shape = rect(-13, -12, 13, 13);
      break;
    }
    case 'apartments': {
      const apt = presetDesign('apartment', 6)!;
      draw(st, [[-30, 0], [30, 0]], prof('lane'));
      const add: CreateObjectInput[] = [];
      for (const [x, z, yaw] of [[-14, -14, Math.PI], [14, -14, Math.PI], [-14, 14, 0], [14, 14, 0]] as const) add.push(put(st, 'building', x, z, yaw, { building: apt }, 20 + add.length));
      for (let i = 0; i < 8; i++) add.push(put(st, 'tree', -26 + i * 7.4, i % 2 ? 26 : -26, i * 0.7, {}, 40 + i));
      W().applyEdit({ add });
      shape = rect(-30, -30, 30, 30);
      opts = { roads: 'clip' };
      break;
    }
    case 'shoppingStreet': {
      const r = neighborhood(ctx(st), 'commercialStreet', 0, 0, 0, 7);
      W().applyEdit({ roads: r.network, add: seeded(r.inputs, 7, 'shop') });
      shape = rect(-72, -32, 72, 32);
      opts = { roads: 'clip' };
      break;
    }
    case 'industrialPark': {
      const r = neighborhood(ctx(st), 'industrialBlock', 0, 0, 0, 9);
      W().applyEdit({ roads: r.network, add: seeded(r.inputs, 9, 'ind') });
      shape = rect(-58, -48, 58, 48);
      break;
    }
    case 'crossroads': {
      draw(st, [[-40, 0], [40, 0]], prof('avenue'));
      draw(st, [[0, -40], [0, 40]], prof('street'));
      const segs = Object.keys(W().doc.roads.segments);
      W().applyEdit({ add: seeded([
        ...infrastructureAlong(ctx(st), segs, { kind: 'streetLight', side: 'both', spacing: 18, seed: 3, policy: 'follow' }).inputs,
        ...infrastructureAlong(ctx(st), segs, { kind: 'signal', side: 'right', spacing: 0, seed: 3, policy: 'follow' }).inputs,
      ], 3, 'x') });
      shape = rect(-40, -40, 40, 40);
      opts = { roads: 'clip' };
      break;
    }
    case 'forest': {
      W().setFeatures([{ id: 'f1', kind: 'hill', x: 0, z: 0, radius: 32, height: 6, roughness: 0.4, seed: 5 } as Feature], 2);
      const pts: P2[] = [];
      for (let z = -34; z <= 34; z += 5) for (let x = -34; x <= 34; x += 5) pts.push([x + ((x * 7 + z * 3) % 3), z + ((x * 5 + z) % 2)]);
      const d = W().doc;
      const f = planForest(pts, { coniferShare: 0.5, density: 1, spacing: 3.5, radius: 10, seed: 5, slopeLimit: 40, minElevation: -5, maxElevation: 80, variation: true }, { terrain: d.terrain, roads: d.roads, features: d.landscape.features, objects: d.objects });
      W().applyEdit({ add: seeded(f.inputs, 5, 'forest') });
      shape = rect(-36, -36, 36, 36);
      break;
    }
    case 'mountain': {
      W().setFeatures([
        { id: 'f1', kind: 'mountain', x: -6, z: -4, radius: 42, height: 26, roughness: 0.5, seed: 21 },
        { id: 'f2', kind: 'ridge', points: [[-40, 30], [0, 22], [40, 32]], width: 26, height: 8, roughness: 0.4, seed: 22 },
      ] as Feature[], 3);
      const pts: P2[] = [];
      for (let z = -50; z <= 50; z += 7) for (let x = -50; x <= 50; x += 7) pts.push([x, z]);
      const d = W().doc;
      const f = planForest(pts, { coniferShare: 0.9, density: 1, spacing: 4, radius: 10, seed: 21, slopeLimit: 32, minElevation: -5, maxElevation: 14, variation: true }, { terrain: d.terrain, roads: d.roads, features: d.landscape.features, objects: d.objects });
      W().applyEdit({ add: seeded(f.inputs, 21, 'mtn') });
      shape = rect(-55, -55, 55, 55);
      break;
    }
    case 'riverBasin': {
      const env = buildEnvironment('riverBasin', 4);
      W().applyEdit({ roads: env.roads, landscape: { base: env.base, features: env.features, next: env.next }, add: env.inputs });
      shape = rect(-60, -45, 60, 45);
      opts = { roads: 'clip', nature: 'clip' };
      break;
    }
    case 'lakeVillage': {
      W().setFeatures([{ id: 'f1', kind: 'lake', points: [[-22, -16], [10, -24], [24, -6], [14, 14], [-16, 12]], surface: -1.2, depth: 3, shoreWidth: 6, material: 7, filled: true } as Feature], 2);
      draw(st, [[-50, 34], [50, 34]], prof('street', { sidewalk: 'none' }));
      const r = neighborhood({ ...ctx(st) }, 'residentialStreet', 0, 34, 0, 13);
      W().applyEdit({ roads: r.network, add: seeded(r.inputs, 13, 'lake') });
      shape = rect(-50, -30, 50, 50);
      opts = { roads: 'clip' };
      break;
    }
    case 'mixedDistrict': {
      const env = buildEnvironment('mixedUrbanNatural', 6);
      W().applyEdit({ roads: env.roads, landscape: { base: env.base, features: env.features, next: env.next }, add: env.inputs });
      shape = rect(-80, -80, 80, 80);
      opts = { roads: 'clip', nature: 'clip' };
      break;
    }
  }
  const meta = BUILTIN_BLUEPRINTS.find((b) => b.id === id)!;
  const { blueprint } = captureBlueprint(W().doc, { shape }, { ...opts, id: `${BUILTIN_PREFIX}${id}`, now: FIXED_TIME, meta: { name: id, category: meta.category, tags: meta.tags, createdAt: FIXED_TIME } });
  return blueprint;
}
