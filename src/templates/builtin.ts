/**
 * Built-in world templates (Phase 20): complete starting worlds generated from a template kind
 * and a seed with the same tools a user has — environment presets (Phase 19), road drawing and
 * the city builder (Phase 18), modular buildings (Phase 17), forest planning — through a
 * headless world store (the very same edit pipeline as the app).
 *
 * Deterministic: the same kind + seed gives the same document, object ids included (they are
 * renumbered from the generation order), so two worlds made from one template and seed have
 * the same fingerprint and start every experiment identically.
 */
import type { WorldDocument, WorldObject } from '@/core/model';
import { createEmptyDocument, type CreateObjectInput } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { buildEnvironment, type EnvironmentPreset } from '@/landscape/presets';
import { waterFeatureAvoid } from '@/landscape/hydrology';
import { blocksOf } from '@/roads/blocks';
import { buildingsAlong, fillBlock, infrastructureAlong, neighborhood, vehiclesAlong, DEFAULT_FILL, ZONE_BUILDINGS, type CityContext, type CityPlan, type NeighborhoodKind } from '@/roads/city';
import { drawRoad } from '@/roads/network';
import { defaultProfile, PROFILE_PRESETS, type RoadProfile } from '@/roads/types';
import { subSeed } from '@/editor/build/distribution';
import { planForest } from '@/app/natureActions';
import type { P2 } from '@/landscape/types';
import { Rng } from '@/core/random';

export type BuiltinTemplate = 'emptyFlat' | 'smallTown' | 'denseCity' | 'coastalCity' | 'mountainVillage' | 'riverValley' | 'industrialDistrict' | 'forestLake';
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = ['emptyFlat', 'smallTown', 'denseCity', 'coastalCity', 'mountainVillage', 'riverValley', 'industrialDistrict', 'forestLake'];

/** Templates that start with an experiment setup (saved hazard scenario). */
export const TEMPLATE_EXPERIMENT: Partial<Record<BuiltinTemplate, true>> = { coastalCity: true, riverValley: true };

const prof = (k: string, extra: Partial<RoadProfile> = {}): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[k] ?? {}), ...extra });

type Store = ReturnType<typeof scratchWorld>;

/** City context over the scratch world's current state. */
const cityCtx = (st: Store): CityContext => {
  const d = st.getState().doc;
  return { terrain: samplerFor(d.terrain), objects: d.objects, network: d.roads, avoid: waterFeatureAvoid(d.landscape.features) };
};

/** Commit city plan inputs (seeded when the generator did not seed them). */
function add(st: Store, inputs: CreateObjectInput[], seed: number, label: string) {
  if (!inputs.length) return;
  st.getState().applyEdit({ add: inputs.map((inp, k) => (inp.seed === undefined ? { ...inp, seed: subSeed(seed, label, k) } : inp)) });
}

const take = (st: Store, plan: CityPlan, seed: number, label: string) => add(st, plan.inputs, seed, label);

function draw(st: Store, pts: P2[], p: RoadProfile, curved = false): string[] {
  const r = drawRoad(st.getState().doc.roads, pts, { curved, profile: p });
  st.getState().applyEdit({ roads: r.network });
  return r.segments.filter((id) => st.getState().doc.roads.segments[id]);
}

function hood(st: Store, kind: NeighborhoodKind, x: number, z: number, yaw: number, seed: number) {
  const r = neighborhood(cityCtx(st), kind, x, z, yaw, seed);
  st.getState().applyEdit({ roads: r.network, add: r.inputs.map((inp, k) => (inp.seed === undefined ? { ...inp, seed: subSeed(seed, `hood${kind}`, k) } : inp)) });
}

function environment(st: Store, kind: EnvironmentPreset, seed: number) {
  const r = buildEnvironment(kind, seed);
  st.getState().applyEdit({ roads: r.roads, landscape: { base: r.base, features: r.features, next: r.next }, add: r.inputs });
}

/** Ids renumbered in generation order (type + running number): deterministic documents. */
function normalizeIds(doc: WorldDocument, kind: BuiltinTemplate, seed: number): WorldDocument {
  const objects: Record<string, WorldObject> = {};
  const groups = new Map<string, string>();
  let k = 0;
  for (const o of Object.values(doc.objects)) {
    const id = `${o.type}_${kind}${seed}n${(k++).toString(36)}`;
    const copy: WorldObject = { ...o, id };
    if (o.group) {
      if (!groups.has(o.group)) groups.set(o.group, `grp_${kind}${seed}g${groups.size}`);
      copy.group = groups.get(o.group);
    }
    objects[id] = copy;
  }
  return { ...doc, objects };
}

export interface TemplateBuildOptions {
  /** meta.createdAt / updatedAt (tests pass a fixed time). */
  now?: string;
  name?: string;
}

export function buildTemplate(kind: BuiltinTemplate, seed: number, opts: TemplateBuildOptions = {}): WorldDocument {
  const st = scratchWorld(createEmptyDocument(opts.name ?? ''));
  const rng = new Rng(seed);
  switch (kind) {
    case 'emptyFlat':
      break;
    case 'smallTown': {
      hood(st, 'parkBlock', 0, 0, 0, seed);
      hood(st, 'residentialStreet', 0, -68, 0, seed + 1);
      hood(st, 'residentialStreet', 0, 68, 0, seed + 2);
      for (const x of [-40, 40]) {
        const segs = [...draw(st, [[x, -40], [x, -68]], prof('street')), ...draw(st, [[x, 40], [x, 68]], prof('street'))];
        take(st, infrastructureAlong(cityCtx(st), segs, { kind: 'tree', side: 'both', spacing: 12, seed, policy: 'follow' }), seed, `t${x}`);
      }
      take(st, vehiclesAlong(cityCtx(st), Object.keys(st.getState().doc.roads.segments), { spacing: 26, mode: 'parked', seed, policy: 'follow', presets: [{ type: 'car' }] }), seed, 'cars');
      break;
    }
    case 'denseCity': {
      const lines = [-66, -2, 62].map((v) => v + Math.round(rng.spread(2)));
      for (const z of lines) draw(st, [[-96, z], [96, z]], prof('avenue'));
      for (const x of lines) draw(st, [[x, -96], [x, 96]], prof('avenue'));
      const net = st.getState().doc.roads;
      blocksOf(net).forEach((b, i) => {
        const zone = i % 3 === 1 ? 'mixed' : 'commercial';
        take(st, fillBlock(cityCtx(st), b, zone, { ...DEFAULT_FILL, seed: subSeed(seed, 'block', i), setback: 1.5, gap: 2, heightScale: 1.4 }), seed, `b${i}`);
      });
      const segs = Object.keys(st.getState().doc.roads.segments);
      take(st, infrastructureAlong(cityCtx(st), segs, { kind: 'streetLight', side: 'both', spacing: 24, seed, policy: 'follow' }), seed, 'lights');
      take(st, vehiclesAlong(cityCtx(st), segs, { spacing: 22, mode: 'lanes', seed, policy: 'follow', presets: [{ type: 'car', params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#3d6fd6' } }, { type: 'car', params: { variant: 'suv', length: 4.8, width: 1.95, height: 1.8, color: '#e9e9e6' } }, { type: 'car', params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#b8352f' } }] }), seed, 'traffic');
      break;
    }
    case 'coastalCity': {
      environment(st, 'coastalPlain', seed);
      hood(st, 'commercialStreet', 0, -28, 0, seed + 3);
      const d = st.getState();
      d.setFloodScenario({ risingWater: { event: 'risingWater', boundary: 'S', level: 1.6, riseRate: 0.4, duration: 900 }, enabled: { rain: false, risingWater: true, sources: false } });
      break;
    }
    case 'mountainVillage':
      environment(st, 'mountainValley', seed);
      break;
    case 'riverValley': {
      environment(st, 'riverBasin', seed);
      st.getState().setFloodScenario({ rain: { event: 'rain', intensity: 80, duration: 1800 }, enabled: { rain: true, risingWater: false, sources: false } });
      break;
    }
    case 'industrialDistrict': {
      hood(st, 'industrialBlock', -45, -48, 0, seed);
      hood(st, 'industrialBlock', 45, 48, 0, seed + 1);
      const main = draw(st, [[-96, 0], [96, 0]], prof('avenue', { sidewalk: 'none' }));
      take(st, vehiclesAlong(cityCtx(st), main, { spacing: 30, mode: 'parked', seed, policy: 'follow', presets: [{ type: 'car', params: { variant: 'truck', length: 7.5, width: 2.4, height: 3, color: '#d9d4c7' } }, { type: 'car', params: { variant: 'suv', length: 4.8, width: 1.95, height: 1.8, color: '#5b6470' } }] }), seed, 'trucks');
      take(st, buildingsAlong(cityCtx(st), main, { side: 'both', presets: ZONE_BUILDINGS.industrial, gap: 6, setback: 3, seed: seed + 5, slopeLimit: 20, policy: 'follow' }), seed, 'row');
      break;
    }
    case 'forestLake': {
      environment(st, 'lakeDistrict', seed);
      // A denser forest on the higher ground away from the lakes.
      const d = st.getState().doc;
      const pts: P2[] = [];
      for (let z = -90; z <= 90; z += 9) for (let x = -90; x <= 90; x += 9) pts.push([x + rng.spread(3), z + rng.spread(3)]);
      const f = planForest(pts.filter(([, z]) => z < -10 || z > 85), { coniferShare: 0.7, density: 1, spacing: 4, radius: 10, seed, slopeLimit: 35, minElevation: -2, maxElevation: 80, variation: true }, { terrain: d.terrain, roads: d.roads, features: d.landscape.features, objects: d.objects });
      add(st, f.inputs, seed, 'forest');
      break;
    }
  }
  st.getState().updateSimulationSettings({ seed });
  const now = opts.now ?? new Date().toISOString();
  const doc = normalizeIds(st.getState().doc, kind, seed);
  return { ...doc, meta: { name: opts.name ?? '', createdAt: now, updatedAt: now } };
}
