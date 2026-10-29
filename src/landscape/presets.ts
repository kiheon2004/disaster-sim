/**
 * Environment presets (Phase 19): whole landscapes made of the same editable parts the tools
 * make — a base terrain, natural features, roads, buildings (Phase 17/18 city builder) and
 * trees (forest brush planner). Deterministic: the same preset + seed gives the same world.
 *
 * The objects are planned on a SCRATCH composition of the new terrain (so trees avoid the new
 * lakes and buildings sit on the new ground); the result is committed as ONE world edit.
 */
import type { TerrainData, WorldObject } from '@/core/model';
import { Rng } from '@/core/random';
import { createFlatTerrain, fullRect, quantizeHeight } from '@/terrain/TerrainData';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { bakeRegion } from '@/roads/bake';
import { drawRoad } from '@/roads/network';
import { buildingsAlong, infrastructureAlong, ZONE_BUILDINGS, type CityContext } from '@/roads/city';
import { defaultProfile, emptyNetwork, PROFILE_PRESETS, type RoadNetwork, type RoadProfile } from '@/roads/types';
import type { CreateObjectInput } from '@/world/WorldDocument';
import { planForest } from '@/app/natureActions';
import { composeAll, createLandscape, landformSampler } from './compose';
import { naturalProvider } from './apply';
import { featureLine, polygonDistance } from './features';
import { nearest } from '@/roads/curve';
import type { Feature, Landscape, P2, RiverFeature } from './types';

export type EnvironmentPreset = 'mountainValley' | 'riverBasin' | 'coastalPlain' | 'forestedHills' | 'lakeDistrict' | 'mixedUrbanNatural';
export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = ['mountainValley', 'riverBasin', 'coastalPlain', 'forestedHills', 'lakeDistrict', 'mixedUrbanNatural'];

export interface EnvironmentResult {
  base: { heights: Float32Array; ground: Uint8Array; soil: Uint8Array; settings: TerrainData['settings'] };
  features: Feature[];
  next: number;
  roads: RoadNetwork;
  inputs: CreateObjectInput[];
}

const river = (id: string, points: P2[], extra: Partial<RiverFeature> = {}): RiverFeature => ({
  id, kind: 'river', points, width: 6, depth: 1.5, bankSlope: 2, material: 8,
  meander: { amplitude: 0, wavelength: 70, seed: 1 }, grading: 'downhill', crossing: 'culvert',
  water: { fill: 0.5, inflow: 3, downstream: 'open' }, ...extra,
});
const prof = (k: string, extra: Partial<RoadProfile> = {}): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[k] ?? {}), ...extra });

/** Scratch composition: the final terrain the preset will have (natural + roads baked). */
function scratch(base: TerrainData, features: Feature[], roads: RoadNetwork): { t: TerrainData; land: Landscape; roads: RoadNetwork } {
  const t: TerrainData = { ...base, heights: base.heights.slice(), ground: base.ground.slice(), soil: base.soil.slice(), settings: { ...base.settings }, revision: 0 };
  const land = createLandscape(base);
  land.features = features;
  composeAll(land, t, t.settings.waterLevel ?? 0);
  t.heights.set(land.natural.heights);
  t.ground.set(land.natural.ground);
  const r = bakeRegion(t, emptyNetwork(), roads, fullRect(t), naturalProvider(land));
  return { t, land, roads: { ...roads, underlay: r.underlay } };
}

/** Jittered grid points where `keep` is true (forest areas). */
function areaPoints(seed: number, step: number, keep: (x: number, z: number) => boolean): P2[] {
  const rng = new Rng(seed);
  const out: P2[] = [];
  for (let z = -96; z <= 96; z += step) for (let x = -96; x <= 96; x += step) {
    const px = x + rng.spread(step * 0.45), pz = z + rng.spread(step * 0.45);
    if (keep(px, pz)) out.push([px, pz]);
  }
  return out;
}

const forest = { coniferShare: 0.5, density: 1, spacing: 3.5, radius: 10, seed: 1, slopeLimit: 35, minElevation: -2, maxElevation: 80, variation: true };

export function buildEnvironment(kind: EnvironmentPreset, seed: number): EnvironmentResult {
  const rng = new Rng(seed);
  let base = createFlatTerrain();
  const features: Feature[] = [];
  let n = 1;
  const id = () => `f${n++}`;
  let net = emptyNetwork();
  const draw = (pts: P2[], p: RoadProfile, curved = false) => { net = drawRoad(net, pts, { curved, profile: p }).network; };
  const j = (v: number, a: number) => Math.round((v + rng.spread(a)) * 10) / 10;
  type Plan = { trees?: { keep: (x: number, z: number) => boolean; conifer: number; step: number }; streets?: { zone: 'residential' | 'commercial' | 'mixed'; setback: number; lights: boolean } };
  let plan: Plan = {};

  switch (kind) {
    case 'mountainValley': {
      features.push({ id: id(), kind: 'mountain', x: j(-55, 6), z: j(-58, 6), radius: 45, height: j(30, 4), roughness: 0.45, seed: seed + 1 });
      features.push({ id: id(), kind: 'mountain', x: j(52, 6), z: j(-62, 6), radius: 40, height: j(26, 4), roughness: 0.4, seed: seed + 2 });
      features.push({ id: id(), kind: 'ridge', points: [[-98, -92], [0, -80], [98, -90]], width: 40, height: 10, roughness: 0.35, seed: seed + 3 });
      features.push({ id: id(), kind: 'valley', points: [[-99, 18], [0, 25], [99, 32]], width: 56, height: 5, roughness: 0.15, seed: seed + 4 });
      features.push(river(id(), [[-99, 14], [-20, 24], [40, 26], [99, 32]], { meander: { amplitude: 6, wavelength: 70, seed }, water: { fill: 0.5, inflow: 3, downstream: 'open' } }));
      draw([[-96, 62], [96, 66]], prof('street', { sidewalk: 'none', elevation: 'graded' }));
      plan = { trees: { keep: (_x, z) => z < -12, conifer: 0.75, step: 6 }, streets: { zone: 'residential', setback: 3, lights: false } };
      break;
    }
    case 'riverBasin': {
      features.push({ id: id(), kind: 'valley', points: [[-99, 0], [99, 0]], width: 130, height: 3, roughness: 0.1, seed: seed + 1 });
      features.push({ id: id(), kind: 'hill', x: j(-62, 5), z: -78, radius: 35, height: 8, roughness: 0.2, seed: seed + 2 });
      features.push({ id: id(), kind: 'hill', x: j(55, 5), z: 80, radius: 35, height: 7, roughness: 0.2, seed: seed + 3 });
      const r = river(id(), [[-99, 2], [-30, -6], [30, 6], [99, -2]], { width: 8, depth: 2, meander: { amplitude: 12, wavelength: 80, seed }, water: { fill: 0.6, inflow: 6, downstream: 'open' } });
      features.push(r);
      draw([[8, -96], [8, 96]], prof('street', { elevation: 'graded' }));
      plan = {
        trees: { keep: (x, z) => { const d = nearest(featureLine(r), x, z).dist; return d > 7 && d < 22; }, conifer: 0.1, step: 5 },
        streets: { zone: 'residential', setback: 4, lights: true },
      };
      break;
    }
    case 'coastalPlain': {
      base = createFlatTerrain();
      for (let iz = 0; iz < base.nz; iz++) for (let ix = 0; ix < base.nx; ix++) {
        const z = base.originZ + iz * base.cellSize;
        base.heights[iz * base.nx + ix] = quantizeHeight(1.2 + Math.max(0, 0.04 * (40 - z)));
      }
      base.settings = { ...base.settings, preset: 'flat', waterLevel: 0 };
      features.push({ id: id(), kind: 'coast', points: [[-99, j(50, 4)], [0, j(58, 4)], [99, j(48, 4)]], seaSide: 1, beachSlope: 0.05, beachWidth: 18, offshoreSlope: 0.06, maxDepth: 6, material: 2 });
      features.push({ id: id(), kind: 'hill', x: j(-45, 8), z: -72, radius: 40, height: 9, roughness: 0.2, seed: seed + 2 });
      draw([[-96, 18], [96, 22]], prof('avenue', { elevation: 'graded' }));
      draw([[0, -96], [0, 20]], prof('street', { elevation: 'graded' }));
      plan = { trees: { keep: (_x, z) => z < -40, conifer: 0.3, step: 6 }, streets: { zone: 'mixed', setback: 3, lights: true } };
      break;
    }
    case 'forestedHills': {
      base = generateTerrain('gentleHills', seed);
      for (let k = 0; k < 5; k++) features.push({ id: id(), kind: 'hill', x: j(-70 + k * 35, 10), z: j(k % 2 ? -45 : 45, 15), radius: j(30, 6), height: j(9, 3), roughness: 0.3, seed: seed + k });
      draw([[-96, -10], [-30, 15], [30, -15], [96, 10]], prof('dirt'), true);
      plan = { trees: { keep: () => true, conifer: 0.55, step: 4.5 } };
      break;
    }
    case 'lakeDistrict': {
      base = generateTerrain('gentleHills', seed);
      const lake1: P2[] = [[-80, -60], [-35, -70], [-25, -35], [-60, -20], [-85, -35]];
      const lake2: P2[] = [[30, 30], [75, 25], [85, 60], [50, 80], [25, 60]];
      for (const pts of [lake1, lake2]) features.push({ id: id(), kind: 'lake', points: pts, surface: 0, depth: j(4, 1), shoreWidth: 10, material: 7, filled: true });
      features.push(river(id(), [[-30, -40], [0, 0], [32, 35]], { width: 4, depth: 1.2, water: { fill: 0.4, inflow: 0, downstream: 'closed' } }));
      // Lake surfaces just below their shorelines (set after composition below).
      plan = { trees: { keep: (x, z) => !(polygonDistance(lake1, x, z).inside || polygonDistance(lake2, x, z).inside), conifer: 0.6, step: 7 } };
      draw([[-96, 80], [96, 88]], prof('lane', { elevation: 'follow' }));
      break;
    }
    case 'mixedUrbanNatural': {
      features.push(river(id(), [[-99, -8], [0, 6], [99, -4]], { width: 7, depth: 1.8, meander: { amplitude: 4, wavelength: 90, seed }, water: { fill: 0.5, inflow: 4, downstream: 'open' } }));
      features.push({ id: id(), kind: 'hill', x: 70, z: -75, radius: 30, height: 10, roughness: 0.25, seed: seed + 2 });
      features.push({ id: id(), kind: 'lake', points: [[-90, 64], [-55, 62], [-50, 90], [-88, 92]], surface: 0, depth: 2.5, shoreWidth: 6, material: 7, filled: true });
      for (const z of [-60, 45]) draw([[-96, z], [96, z]], prof('street', { elevation: 'graded' }));
      for (const x of [-30, 30]) draw([[x, -96], [x, 96]], prof('street', { elevation: 'graded' }));
      plan = { trees: { keep: (x, z) => x > 40 && z < -10, conifer: 0.3, step: 5 }, streets: { zone: 'mixed', setback: 2, lights: true } };
      break;
    }
  }

  // Lakes: surface just below the lowest shore point of the composed landform.
  let sc = scratch(base, features, net);
  const L = landformSampler(sc.land, sc.t);
  const sampler0 = new TerrainSampler(sc.t);
  const rivers = features.filter((f): f is RiverFeature => f.kind === 'river');
  let lakesFixed = false;
  for (let k = 0; k < features.length; k++) {
    const f = features[k];
    if (f.kind !== 'lake' || f.surface !== 0) continue;
    let low = Infinity;
    const P = f.points;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      for (let s = 0; s <= 1; s += 0.02) {
        const x = a[0] + (b[0] - a[0]) * s, z = a[1] + (b[1] - a[1]) * s;
        // The final shore (road cuts included), except where a river leaves the lake (outlet).
        if (rivers.some((rv) => nearest(featureLine(rv), x, z).dist < rv.width / 2 + rv.depth * rv.bankSlope + 2)) continue;
        low = Math.min(low, Math.min(L(x, z), sampler0.sampleHeight(x, z)));
      }
    }
    features[k] = { ...f, surface: Math.round((low - 0.3) * 100) / 100 };
    lakesFixed = true;
  }
  if (lakesFixed) sc = scratch(base, features, net);

  // Objects on the new ground.
  const inputs: CreateObjectInput[] = [];
  const objects: Record<string, WorldObject> = {};
  const addPlanned = (list: CreateObjectInput[]) => {
    list.forEach((inp, i) => { objects[`__p${inputs.length + i}`] = { id: `__p${inputs.length + i}`, type: inp.type, name: '', serial: 0, seed: 0, transform: inp.transform, physics: {} as WorldObject['physics'], params: inp.params ?? {}, components: [] }; });
    inputs.push(...list);
  };
  const sampler = new TerrainSampler(sc.t);
  if (plan.streets) {
    const ctx: CityContext = { terrain: sampler, objects, network: sc.roads };
    const ids = Object.keys(sc.roads.segments);
    if (plan.streets.lights) addPlanned(infrastructureAlong(ctx, ids, { kind: 'streetLight', side: 'both', spacing: 30, seed, policy: 'follow' }).inputs);
    addPlanned(buildingsAlong({ ...ctx, objects }, ids, { side: 'both', presets: ZONE_BUILDINGS[plan.streets.zone], gap: 4, setback: plan.streets.setback, seed, slopeLimit: 18, policy: 'follow' }).inputs);
  }
  if (plan.trees) {
    const pts = areaPoints(seed + 99, plan.trees.step, plan.trees.keep);
    addPlanned(planForest(pts, { ...forest, coniferShare: plan.trees.conifer, seed }, { terrain: sc.t, roads: sc.roads, features, objects }).inputs);
  }
  return { base: { heights: base.heights, ground: base.ground, soil: base.soil, settings: base.settings }, features, next: n, roads: net, inputs };
}
