/**
 * Phase 37 — planning terrain, paint, roads and forests (§8).
 *
 * Terrain: a command edits the ground with the brush code itself (`applyDab`) as a PROGRAM STROKE — one small dab per
 * vertex of the area, with a set amount instead of brush time: raise / lower by exactly `by` m, flatten to a level,
 * smooth, paint. Each vertex gets a weight: 1 inside the area, easing to 0 over a feather band at its edge (no cliffs).
 * The stroke runs through the store's ordinary stroke API (begin → dabs → end), so layers, roads re-baked over the new
 * ground, objects following it and the undo step are the mouse brush's.
 * Roads: `drawRoad` — the road tool's own confirm rule (ends snap to nodes within 3 m, an end on a road splits it,
 * crossings become junctions). Forests: `planForest` with a stroke key made from the command text.
 */
import { hashString } from '@/core/math';
import { WORLD_HALF, WORLD_SIZE } from '@/core/units';
import { planForest, type ForestReject } from '@/app/natureActions';
import { areaFill, subSeed } from '@/editor/build/distribution';
import { DEFAULT_FOREST, type ForestSettings } from '@/editor/natureStore';
import { drawRoad, networkWarnings } from '@/roads/network';
import { defaultProfile, PROFILE_PRESETS, type RoadProfile } from '@/roads/types';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';
import { quantizeHeight } from '@/terrain/TerrainData';
import { MAX_RAISE_RATE, type DabOptions } from '@/terrain/TerrainEditor';
import type { TerrainData } from '@/core/model';
import { msg, type Env } from './context';
import { formatCanonical } from './canonical';
import type { IntentOf } from './intent';
import { CONFIRM_AREA_SHARE, CONFIRM_ITEMS, MAX_ITEMS, need, stop, type Draft, type PlanOptions, type ProgramStroke } from './planTypes';
import { areaContains, areaExtent, insideWorld, resolveArea, resolvePlace, type Area, type Shape } from './resolve';

// ── Areas on the terrain grid ────────────────────────────────────────────────────────

/** Widest feather band (m) and its share of the area's smallest dimension. */
export const FEATHER_MAX = 3;
export const FEATHER_SHARE = 0.25;
/** Height change of `terrain raise | lower` when none is said (m). */
export const DEFAULT_RAISE = 1;
/** Passes of `terrain smooth`. */
export const SMOOTH_PASSES = 4;

/** Distance from a point to the edge of a shape, positive inside (m). */
function depthIn(s: Shape, x: number, z: number): number {
  if (s.k === 'circle') return s.r - Math.hypot(x - s.x, z - s.z);
  if (s.k === 'rect') return Math.min(x - s.x0, s.x1 - x, z - s.z0, s.z1 - z);
  const seg = (ax: number, az: number, bx: number, bz: number) => {
    const dx = bx - ax, dz = bz - az;
    const w = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    return Math.hypot(x - (ax + dx * w), z - (az + dz * w));
  };
  if (s.k === 'path') {
    let best = Infinity;
    for (let k = 1; k < s.points.length; k++) best = Math.min(best, seg(s.points[k - 1][0], s.points[k - 1][1], s.points[k][0], s.points[k][1]));
    return s.half - best;
  }
  let edge = Infinity;
  for (let k = 0, j = s.points.length - 1; k < s.points.length; j = k++) edge = Math.min(edge, seg(s.points[j][0], s.points[j][1], s.points[k][0], s.points[k][1]));
  return areaContains({ shapes: [s], box: [0, 0, 0, 0] }, x, z) ? edge : -edge;
}

/** Smallest dimension of a shape (m): sets how wide its feather band is. */
function span(s: Shape): number {
  if (s.k === 'circle') return 2 * s.r;
  if (s.k === 'rect') return Math.min(s.x1 - s.x0, s.z1 - s.z0);
  if (s.k === 'path') return 2 * s.half;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of s.points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return Math.min(x1 - x0, z1 - z0);
}

/**
 * The terrain vertices of an area with their weights: 1 where the vertex is at least a feather band inside, easing
 * (smoothstep) to 0 at the edge. Vertices outside — and outside the grid — are not listed. Row by row (z, then x):
 * the order the dabs run in.
 */
export function areaCells(t: TerrainData, area: Area): ProgramStroke['cells'] {
  const cs = t.cellSize;
  const x0 = Math.max(0, Math.ceil((area.box[0] - t.originX) / cs)), x1 = Math.min(t.nx - 1, Math.floor((area.box[2] - t.originX) / cs));
  const z0 = Math.max(0, Math.ceil((area.box[1] - t.originZ) / cs)), z1 = Math.min(t.nz - 1, Math.floor((area.box[3] - t.originZ) / cs));
  const feather = area.shapes.map((s) => Math.max(1e-6, Math.min(FEATHER_MAX, FEATHER_SHARE * span(s))));
  const cells: ProgramStroke['cells'] = [];
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const x = t.originX + ix * cs, z = t.originZ + iz * cs;
      let w = -1;
      area.shapes.forEach((s, k) => {
        const depth = depthIn(s, x, z);
        if (depth < 0) return;
        const u = Math.min(1, depth / feather[k]);
        w = Math.max(w, u * u * (3 - 2 * u));
      });
      if (w >= 0) cells.push({ x: ix, z: iz, w: Math.round(w * 1000) / 1000 });
    }
  }
  return cells;
}

/**
 * The dabs of a program stroke on a terrain: one per vertex (a brush of half a cell touches only the vertex it is on).
 * raise / lower: brush time by · w ÷ the brush's raise rate → exactly by · w metres. flatten: one dab at strength w
 * → the level where w = 1, a blend in the feather band. smooth: a few passes at strength w. paint: every vertex of the
 * area (weights do not apply — a surface is painted or it is not).
 */
export function programDabs(t: TerrainData, stroke: ProgramStroke): DabOptions[] {
  const radius = t.cellSize * 0.5;
  const at = (c: { x: number; z: number }) => ({ x: t.originX + c.x * t.cellSize, z: t.originZ + c.z * t.cellSize });
  const dabs: DabOptions[] = [];
  const passes = stroke.op === 'smooth' ? SMOOTH_PASSES : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (const c of stroke.cells) {
      if (stroke.op === 'paint') dabs.push({ op: 'paint', ...at(c), brush: { radius, strength: 1 }, dt: 0.05, groundType: stroke.ground as DabOptions['groundType'] });
      else if (c.w <= 0) continue;
      else if (stroke.op === 'flatten') dabs.push({ op: 'flatten', ...at(c), brush: { radius, strength: c.w }, dt: 0.1, targetHeight: stroke.to ?? 0, falloff: 'flat' });
      else if (stroke.op === 'smooth') dabs.push({ op: 'smooth', ...at(c), brush: { radius, strength: c.w }, dt: 0.1, falloff: 'flat' });
      else dabs.push({ op: stroke.op, ...at(c), brush: { radius, strength: 1 }, dt: ((stroke.by ?? DEFAULT_RAISE) * c.w) / MAX_RAISE_RATE, falloff: 'flat' });
    }
  }
  return dabs;
}

function terrainArea(area: Area, env: Env, d: Draft): ProgramStroke['cells'] {
  const cells = areaCells(env.doc.terrain, area);
  if (!cells.length) stop(msg('cmd37.err.areaEmpty'));
  const share = areaExtent(area) / (WORLD_SIZE * WORLD_SIZE);
  if (share > CONFIRM_AREA_SHARE) d.confirm = msg('cmd37.confirm.area', { percent: Math.round(share * 100) });
  d.highlight = { points: [[(area.box[0] + area.box[2]) / 2, (area.box[1] + area.box[3]) / 2]] };
  return cells;
}

export function planTerrain(i: IntentOf<'terrain'>, env: Env, d: Draft): void {
  const area = need(resolveArea(i.area, env), d.notes);
  const cells = terrainArea(area, env, d);
  const stroke: ProgramStroke = { cells, op: i.op };
  if (i.op === 'raise' || i.op === 'lower') {
    stroke.by = i.by ?? DEFAULT_RAISE;
    if (i.by === undefined) d.notes.push(msg('cmd37.note.defaultRaise', { by: DEFAULT_RAISE }));
  } else if (i.op === 'flatten') {
    // The level: as said, else the ground at the middle of the area (the brush takes the height under the cursor).
    const cx = (area.box[0] + area.box[2]) / 2, cz = (area.box[1] + area.box[3]) / 2;
    stroke.to = quantizeHeight(i.to ?? env.terrain.sampleHeight(Math.max(-WORLD_HALF, Math.min(WORLD_HALF, cx)), Math.max(-WORLD_HALF, Math.min(WORLD_HALF, cz))));
    if (i.to === undefined) d.notes.push(msg('cmd37.note.flattenLevel', { to: stroke.to }));
  }
  if (env.doc.roads && Object.keys(env.doc.roads.segments).length) d.notes.push(msg('cmd37.note.terrainRoads'));
  d.notes.push(msg('cmd37.note.terrainCells', { cells: cells.length, full: cells.filter((c) => c.w >= 1).length }));
  d.ops.push({ op: 'terrain', stroke });
}

export function planPaint(i: IntentOf<'paint'>, env: Env, d: Draft): void {
  const ground = GROUND_MATERIALS.find((g) => g.key.toLowerCase() === i.ground.toLowerCase()) ?? stop(msg('cmd37.err.unknownGround', { ground: i.ground, known: GROUND_MATERIALS.map((g) => g.key).join(', ') }));
  const area = need(resolveArea(i.area, env), d.notes);
  const cells = terrainArea(area, env, d);
  d.notes.push(msg('cmd37.note.terrainCells', { cells: cells.length, full: cells.length }));
  d.ops.push({ op: 'terrain', stroke: { cells, op: 'paint', ground: ground.id } });
}

// ── Roads ────────────────────────────────────────────────────────────────────────────

export function planRoad(i: IntentOf<'road'>, env: Env, d: Draft): void {
  const a = need(resolvePlace(i.from, env), d.notes), b = need(resolvePlace(i.to, env), d.notes);
  for (const p of [a, b]) if (!insideWorld(p)) stop(msg('cmd37.err.outside', { x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, half: WORLD_HALF }));
  const name = i.preset ?? 'street';
  const key = Object.keys(PROFILE_PRESETS).find((k) => k.toLowerCase() === name.toLowerCase()) ?? stop(msg('cmd37.err.unknownRoadPreset', { preset: name, known: Object.keys(PROFILE_PRESETS).join(', ') }));
  const profile: RoadProfile = { ...defaultProfile(), ...PROFILE_PRESETS[key] };
  let res: ReturnType<typeof drawRoad>;
  try {
    res = drawRoad(env.doc.roads, [[a.x, a.z], [b.x, b.z]], { curved: false, profile });
  } catch (e) {
    return stop(msg('cmd37.err.road', { reason: (e as Error).message }));
  }
  const before = new Set(networkWarnings(env.doc.roads).map((w) => `${w.code}:${w.segment ?? w.node}`));
  const fresh = networkWarnings(res.network).filter((w) => !before.has(`${w.code}:${w.segment ?? w.node}`));
  if (fresh.length) d.warnings.push(msg('cmd37.warn.road', { codes: [...new Set(fresh.map((w) => w.code))].join(', ') }));
  d.notes.push(msg('cmd37.note.road', { segments: res.segments.join(' '), splits: res.splits.length, preset: key }));
  d.ops.push({ op: 'edit', edit: { roads: res.network }, result: 'none' });
  d.highlight = { points: [[a.x, a.z], [b.x, b.z]] };
}

// ── Forests ──────────────────────────────────────────────────────────────────────────

/** Trees per 100 m² of the density words (medium = the forest brush's default). */
export const FOREST_DENSITY = { low: DEFAULT_FOREST.density / 2, medium: DEFAULT_FOREST.density, high: DEFAULT_FOREST.density * 2 } as const;

export function planForestCommand(i: IntentOf<'forest'>, env: Env, o: PlanOptions, d: Draft): void {
  const area = need(resolveArea(i.area, env), d.notes);
  let density: number = DEFAULT_FOREST.density;
  if (typeof i.density === 'number') density = i.density;
  else if (typeof i.density === 'string') density = FOREST_DENSITY[i.density.toLowerCase() as keyof typeof FOREST_DENSITY] ?? stop(msg('cmd37.err.density', { density: i.density }));
  if (!(density > 0) || density > 25) stop(msg('cmd37.err.density', { density }));
  const canonical = formatCanonical(i);
  const settings: ForestSettings = { ...DEFAULT_FOREST, density, seed: i.seed ?? DEFAULT_FOREST.seed };
  const share = areaExtent(area) / (WORLD_SIZE * WORLD_SIZE);
  if (share > CONFIRM_AREA_SHARE) d.confirm = msg('cmd37.confirm.area', { percent: Math.round(share * 100) });
  // Scatter over the area's bounds, keep what is inside it; the stroke key comes from the command text, so the same
  // command gives the same trees (another `seed=` gives others).
  const box = { kind: 'rect' as const, x0: Math.max(-WORLD_HALF, area.box[0]), z0: Math.max(-WORLD_HALF, area.box[1]), x1: Math.min(WORLD_HALF, area.box[2]), z1: Math.min(WORLD_HALF, area.box[3]) };
  const points = areaFill(box, { mode: 'random', spacing: settings.spacing, density, jitter: 0, seed: subSeed(o.seed ^ settings.seed, 'forest', hashString(canonical)) }).filter(([x, z]) => areaContains(area, x, z));
  const key = (hashString(canonical) % 999_983) + 1;
  const r = planForest(points.map(([x, z]) => [x, z] as [number, number]), settings, { terrain: env.doc.terrain, roads: env.doc.roads, features: env.doc.landscape.features, objects: env.doc.objects }, key);
  const reasons = (Object.keys(r.reasons) as ForestReject[]).filter((k) => r.reasons[k] > 0);
  d.notes.push(msg('cmd37.note.forest', { placed: r.inputs.length, points: points.length, density }));
  for (const k of reasons) d.warnings.push(msg(`cmd37.forest.${k}`, { count: r.reasons[k] }));
  if (!r.inputs.length) stop(msg('cmd37.err.forestEmpty', { points: points.length }));
  if (r.inputs.length > MAX_ITEMS) stop(msg('cmd37.err.tooMany', { count: r.inputs.length, max: MAX_ITEMS }));
  if (r.inputs.length >= CONFIRM_ITEMS && !d.confirm) d.confirm = msg('cmd37.confirm.many', { count: r.inputs.length });
  d.ops.push({ op: 'edit', edit: { add: r.inputs }, result: 'added' });
  d.counts.create = r.inputs.length;
  for (const input of r.inputs) d.items.push({ status: 'ok', x: input.transform.position[0], z: input.transform.position[2], reasons: [] });
}
