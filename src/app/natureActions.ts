/**
 * Natural environment actions (Phase 19). Every action builds the complete next feature list
 * (immutable values) and commits it through worldStore.applyEdit({ landscape }) — the terrain
 * is recomposed locally, roads re-graded, objects re-seated, ONE undo step; on error nothing
 * changes and a toast explains why.
 */
import type { TerrainData, WorldObject } from '@/core/model';
import type { RoadNetwork } from '@/roads/types';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useNatureStore, type ForestSettings } from '@/editor/natureStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { toast } from '@/ui/common/toast';
import { t } from '@/i18n/i18n';
import { buildEnvironment, type EnvironmentPreset } from '@/landscape/presets';
import { Rng } from '@/core/random';
import { foundationContact } from '@/buildings/foundation';
import { featureBounds, landformDelta, polygonDistance, riverProfile } from '@/landscape/features';
import { landformSampler } from '@/landscape/compose';
import { lakeRimLow, waterFeatureAvoid } from '@/landscape/hydrology';
import type { Feature, P2 } from '@/landscape/types';
import { MIN_RIVER_WIDTH } from '@/landscape/types';
import { BrushScatter, subSeed } from '@/editor/build/distribution';
import { DEFAULT_PLACEMENT, planPlacement } from '@/editor/build/placementPlan';
import { FootprintIndex, footprintOf } from '@/editor/build/footprint';
import { footprintOnRoad } from '@/roads/city';
import { segmentLine } from '@/roads/network';
import { nearest } from '@/roads/curve';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { TerrainToolId } from '@/editor/editorStore';

const W = () => useWorldStore.getState();
const N = () => useNatureStore.getState();

function locked(): boolean {
  if (W().locked || useEditorStore.getState().mode !== 'editor') {
    toast('warn', { key: 'nature.locked' });
    return true;
  }
  return false;
}

const nextId = () => {
  const n = W().doc.landscape.next;
  return { id: `f${n}`, next: n + 1 };
};

/** Commit a new feature list; warns about buildings left without foundation support. */
export function commitFeatures(features: Feature[], next?: number): boolean {
  if (locked()) return false;
  const before = W().doc.landscape.features;
  try {
    W().applyEdit({ landscape: { features, next } });
  } catch (e) {
    toast('error', { key: 'nature.error' }, (e as Error).message);
    return false;
  }
  warnFoundations(before, features);
  return true;
}

/** Buildings within the changed features' reach that lost ground contact (Phase 17 check). */
function warnFoundations(before: readonly Feature[], after: readonly Feature[]) {
  const changed = [...before.filter((f) => !after.includes(f)), ...after.filter((f) => !before.includes(f))];
  if (!changed.length) return;
  const boxes = changed.map(featureBounds);
  const sampler = samplerFor(W().doc.terrain);
  let bad = 0;
  for (const o of Object.values(W().doc.objects)) {
    if (o.type !== 'building') continue;
    const [x, , z] = o.transform.position;
    if (!boxes.some((b) => x >= b[0] - 20 && x <= b[2] + 20 && z >= b[1] - 20 && z <= b[3] + 20)) continue;
    const c = foundationContact(o, sampler);
    if (c.contact < 0.75 || c.buried) bad++;
  }
  if (bad) toast('warn', { key: 'nature.foundationWarn', params: { n: bad } });
}

export function placePeak(kind: 'mountain' | 'hill', x: number, z: number) {
  const { id, next } = nextId();
  const p = N().params[kind];
  const f: Feature = { id, kind, x: round(x), z: round(z), ...p };
  if (commitFeatures([...W().doc.landscape.features, f], next)) N().select(id);
}

const round = (v: number) => Math.round(v * 100) / 100;
const roundPts = (pts: readonly P2[]): P2[] => pts.map(([x, z]) => [round(x), round(z)]);

/** Finish the drawn line / polygon of a feature tool. */
export function finishNatureDraft(tool: TerrainToolId): boolean {
  const pts = roundPts(N().draft);
  const kind = tool === 'ridgeLine' ? 'ridge' : tool === 'valleyLine' ? 'valley' : tool;
  if (kind === 'lake' ? pts.length < 3 : pts.length < 2) {
    toast('warn', { key: kind === 'lake' ? 'nature.needPolygon' : 'nature.needLine' });
    return false;
  }
  const { id, next } = nextId();
  const P = N().params;
  let f: Feature;
  switch (kind) {
    case 'ridge':
    case 'valley':
    case 'canyon':
      f = { id, kind, points: pts, ...P[kind] };
      break;
    case 'river':
      f = { id, kind, points: pts, ...P.river, width: Math.max(MIN_RIVER_WIDTH, P.river.width) };
      break;
    case 'lake': {
      // Surface: just below the lowest point of the shoreline, so the basin holds its water.
      const { freeboard, ...rest } = P.lake;
      const probe = { id, kind: 'lake' as const, points: pts, surface: 0, ...rest };
      const t = W().doc.terrain;
      const natural = { ...t, heights: W().doc.landscape.natural.heights };
      f = { ...probe, surface: round(lakeRimLow(probe, natural) - freeboard) };
      break;
    }
    case 'coast':
      f = { id, kind, points: pts, ...P.coast };
      break;
    default:
      return false;
  }
  N().clearDraft();
  if (commitFeatures([...W().doc.landscape.features, f], next)) {
    N().select(id);
    return true;
  }
  return false;
}

/** Replace a feature by a patched copy (one undo step). */
export function updateFeature(id: string, patch: Partial<Feature>) {
  const fs = W().doc.landscape.features;
  const k = fs.findIndex((f) => f.id === id);
  if (k < 0) return;
  const next = [...fs];
  next[k] = { ...fs[k], ...patch } as Feature;
  commitFeatures(next);
}

export function moveFeaturePoint(id: string, index: number, x: number, z: number) {
  const f = W().doc.landscape.features.find((g) => g.id === id);
  if (!f) return;
  if (f.kind === 'mountain' || f.kind === 'hill') updateFeature(id, { x: round(x), z: round(z) });
  else if ('points' in f) updateFeature(id, { points: f.points.map((p, i) => (i === index ? [round(x), round(z)] : p)) as P2[] });
}

/** Delete a feature: its terrain change goes, every other layer stays. */
export function deleteFeature(id: string) {
  if (commitFeatures(W().doc.landscape.features.filter((f) => f.id !== id))) N().select(null);
}

// ── Warnings ───────────────────────────────────────────────────────────────────

export interface FeatureWarning {
  /** i18n key suffix: nature.warn.<code> */
  code: 'adverseSlope' | 'steep' | 'deepCut' | 'crossesRoad' | 'spills' | 'tooSmall' | 'narrow';
  value?: number;
}

/** Checks of a feature against the current landform / roads (shown in the feature inspector). */
export function featureWarnings(f: Feature): FeatureWarning[] {
  const doc = W().doc;
  const out: FeatureWarning[] = [];
  if (f.kind === 'river') {
    const p = riverProfile(f, landformSampler(doc.landscape, doc.terrain));
    const S = p.line.samples;
    let rise = 0, steep = 0, cut = 0;
    for (let i = 10; i < S.length; i += 5) {
      const d = p.bed[i] - p.bed[i - 10];
      if (d > rise) rise = d;
      steep = Math.max(steep, Math.abs(d) / Math.max(1e-6, S[i].s - S[i - 10].s));
    }
    for (let i = 0; i < S.length; i++) cut = Math.max(cut, p.ground[i] - p.bed[i]);
    if (rise > 0.2) out.push({ code: 'adverseSlope', value: rise });
    if (steep > 0.15) out.push({ code: 'steep', value: steep * 100 });
    if (cut > f.depth + 4) out.push({ code: 'deepCut', value: cut });
    let cross = 0;
    for (const seg of Object.values(doc.roads.segments)) {
      const line = segmentLine(doc.roads, seg);
      if (line.samples.some((q) => nearest(p.line, q.x, q.z).dist < f.width / 2)) cross++;
    }
    if (cross) out.push({ code: 'crossesRoad', value: cross });
  }
  if (f.kind === 'lake') {
    const rim = lakeRimLow(f, doc.terrain);
    if (rim < f.surface - 0.05) out.push({ code: 'spills', value: f.surface - rim });
    let area = 0;
    for (let i = 0, j = f.points.length - 1; i < f.points.length; j = i++) area += f.points[j][0] * f.points[i][1] - f.points[i][0] * f.points[j][1];
    if (Math.abs(area / 2) < 30) out.push({ code: 'tooSmall', value: Math.abs(area / 2) });
  }
  return out;
}

/** The feature nearest to a point (within `reach` m), for selection. */
export function featureAt(x: number, z: number, reach = 6): Feature | null {
  let best: Feature | null = null, bd = reach;
  for (const f of W().doc.landscape.features) {
    let d = Infinity;
    if (f.kind === 'mountain' || f.kind === 'hill') d = Math.max(0, Math.hypot(x - f.x, z - f.z) - Math.min(8, f.radius * 0.25));
    else if (f.kind === 'lake') { const pd = polygonDistance(f.points, x, z); d = pd.inside ? 0 : pd.dist; }
    else if ('points' in f) {
      for (let i = 0; i < f.points.length - 1; i++) {
        const [ax, az] = f.points[i], [bx, bz] = f.points[i + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        d = Math.min(d, Math.hypot(x - ax - dx * u, z - az - dz * u));
      }
      if (f.kind !== 'coast') d = Math.max(0, d - ('width' in f ? f.width / 2 : 0));
    }
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

/** Height change a landform makes at its center (inspector). */
export const landformPeak = (f: Feature) => (f.kind === 'mountain' || f.kind === 'hill' ? landformDelta(f, f.x, f.z) : 0);

// ── Forest brush ───────────────────────────────────────────────────────────────

/** Persistent scatter of the current forest stroke (Phase 16 brush distribution). */
let scatter: BrushScatter | null = null;
let strokeIndex = 0;

export function beginForestStroke() {
  const f = N().forest;
  scatter = new BrushScatter({ radius: f.radius, density: f.density, spacing: f.spacing, seed: f.seed });
  strokeIndex++;
}

/** New tree positions of a dab (min spacing to the earlier ones of the stroke). */
export function forestDab(x: number, z: number): P2[] {
  return scatter ? (scatter.extend([x, z]) as P2[]) : [];
}

/**
 * Plan trees at the stroke's points: species by share (seeded), elevation band, slope limit,
 * no trees in standing water, on roads or on other objects. Returns the accepted inputs.
 */
export interface ForestContext {
  terrain: TerrainData;
  roads: RoadNetwork;
  features: readonly Feature[];
  objects: Record<string, WorldObject>;
}

export function planForest(points: readonly P2[], f: ForestSettings = N().forest, ctx?: ForestContext): { inputs: CreateObjectInput[]; rejected: number } {
  const doc: ForestContext = ctx ?? { terrain: W().doc.terrain, roads: W().doc.roads, features: W().doc.landscape.features, objects: W().doc.objects };
  const sampler = samplerFor(doc.terrain);
  const existing = new FootprintIndex();
  for (const o of Object.values(doc.objects).sort((a, b) => (a.id < b.id ? -1 : 1))) { const fp = footprintOf(o); if (fp) existing.add(fp, o.id); }
  const own = new FootprintIndex();
  const inputs: CreateObjectInput[] = [];
  let rejected = 0;
  const lakes = doc.features.filter((g) => g.kind === 'lake');
  const inWater = waterFeatureAvoid(doc.features.filter((g) => g.kind === 'river'));
  points.forEach(([x, z], i) => {
    const rng = new Rng(subSeed(f.seed, `forest${strokeIndex}`, i));
    const conifer = rng.next() < f.coniferShare;
    const h = sampler.sampleHeight(x, z);
    const inLake = lakes.some((l) => l.kind === 'lake' && l.filled && h < l.surface && polygonDistance(l.points, x, z).inside);
    const sea = doc.terrain.settings.waterLevel;
    if (h < f.minElevation || h > f.maxElevation || inLake || inWater(x, z, 0.5) || (sea !== null && h < sea + 0.2)) { rejected++; return; }
    const params = conifer ? { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 } : { species: 'broadleaf', height: 8, canopyRadius: 3, trunkRadius: 0.28 };
    const plan = planPlacement({ type: 'tree', params, randomize: f.variation }, [{ x, z }], { ...DEFAULT_PLACEMENT, seed: subSeed(f.seed, 'tree', i + strokeIndex * 100000), slopeLimit: f.slopeLimit, variation: f.variation }, { terrain: sampler, existing }, 0, own)[0];
    if (!plan.ok) { rejected++; return; }
    const fp = footprintOf({ type: 'tree', params: plan.input.params ?? params, transform: plan.input.transform } as WorldObject);
    if (fp && footprintOnRoad(doc.roads, fp, 0.2)) { rejected++; return; }
    inputs.push(plan.input);
  });
  return { inputs, rejected };
}

export function commitForest(points: readonly P2[]) {
  scatter = null;
  if (!points.length || locked()) return;
  const { inputs, rejected } = planForest(points);
  if (inputs.length) W().applyEdit({ add: inputs });
  toast(inputs.length ? 'success' : 'warn', { key: 'nature.forest.placed', params: { n: inputs.length, skipped: rejected } });
}

// ── Environment presets ────────────────────────────────────────────────────────

/**
 * Replace the world by an environment preset (confirmation first): terrain layers, roads,
 * buildings and trees in ONE undo step. Every part stays editable afterwards.
 */
export function applyEnvironment(kind: EnvironmentPreset, seed: number): boolean {
  if (locked()) return false;
  if (Object.keys(W().doc.objects).length && !window.confirm(t('nature.env.confirm'))) return false;
  const t0 = performance.now();
  const r = buildEnvironment(kind, seed);
  try {
    W().applyEdit({
      remove: Object.keys(W().doc.objects),
      roads: r.roads,
      landscape: { base: r.base, features: r.features, next: r.next },
      add: r.inputs,
    });
  } catch (e) {
    toast('error', { key: 'nature.error' }, (e as Error).message);
    return false;
  }
  N().select(null);
  toast('success', { key: 'nature.env.done', params: { name: t(`nature.env.${kind}`), n: r.inputs.length, ms: Math.round(performance.now() - t0) } });
  return true;
}
