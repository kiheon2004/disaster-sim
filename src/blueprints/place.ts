/**
 * Blueprint placement (Phase 20): UnifiedBlueprint + destination world + options → ONE atomic
 * WorldEdit (objects, roads, natural features, terrain layers) and a report. Pure: reads the
 * document, builds new immutable values (road networks, features) and typed-array layer
 * patches; nothing is written until the caller commits the edit with worldStore.applyEdit —
 * which applies it as one undo step or not at all.
 *
 * Heights
 *   destination datum D = mean pre-feature ground (base + sculpt) along the placed
 *                         footprint's boundary                                (terrain snap on)
 *                       = the blueprint's source datum (absolute elevations)  (terrain snap off)
 *                       + the user's height offset
 *   objects     grounded → seated on the FINAL destination ground (after this edit's terrain
 *               and road changes), lifted → that ground + their lift; "preserve relative
 *               transforms" → D + their source height above the datum (rigid, no seating)
 *   roads       fixed node elevations = D + stored relative elevation
 *   lakes       surface = D + stored relative surface
 *   terrain     see TerrainPolicy
 */
import type { WorldDocument } from '@/core/model';
import type { Vec3 } from '@/core/types';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { WorldEdit } from '@/world/worldStore';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';
import { designParams } from '@/buildings/design';
import type { BuildingDesign } from '@/buildings/types';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundPose, yawOf } from '@/terrain/groundPlacement';
import { decodeElevation, decodeGround } from '@/terrain/terrainCodec';
import type { GridRect } from '@/terrain/TerrainData';
import { smoothstep } from '@/core/math';
import { yawRotate } from '@/editor/build/groupTransform';
import { collisionFootprint, FootprintIndex } from '@/editor/build/footprint';
import { isInsideWorld } from '@/editor/placement';
import { pasteRoads, snapEndpoints, type BlueprintRoads as IndexedRoads } from '@/roads/blueprintRoads';
import { measureLink } from '@/roads/links';
import { blocksOf } from '@/roads/blocks';
import { assertValid, crossings, findNode, findSegment, insertSubnetwork, segmentLine, SNAP_NODE, SNAP_SEGMENT } from '@/roads/network';
import type { RoadNetwork } from '@/roads/types';
import { featureBounds, featureLine, polygonDistance } from '@/landscape/features';
import { edgeAt, hydrologyPlan, type HydrologyIssue } from '@/landscape/hydrology';
import { NO_PAINT, type Feature, type P2 } from '@/landscape/types';
import { mapFeature, nearestIndex, placementMap, rotate, roundCm, sampleBilinear, toLocal, toWorld, type LocalGrid, type Placement } from './frame';
import { boundaryDistance, inside, perimeterMean } from './selection';
import type { BlueprintItem, CaptureInclude, UnifiedBlueprint } from './types';

/**
 * How the blueprint's terrain meets the destination (inside the blueprint's footprint):
 *  - preserve: the destination ground is not changed at all (no sculpt / paint / soil written)
 *  - offset:   the blueprint's relief (its sculpt layer) is ADDED on the destination ground,
 *              its paint is applied — Phase 19 region behaviour; the destination shape stays
 *  - apply:    the destination pre-feature ground becomes the blueprint's (relative to D),
 *              paint / ground / soil of the blueprint are applied
 *  - blend:    like apply, faded to the destination over `blendWidth` m inside the edge
 * All of it goes into the destination's SCULPT / PAINT layers (and soil) as one patch: the base
 * terrain, earlier sculpts, features and roads of the destination stay their own layers, and
 * undo removes exactly this change.
 */
export type TerrainPolicy = 'preserve' | 'offset' | 'apply' | 'blend';
export const TERRAIN_POLICIES: readonly TerrainPolicy[] = ['preserve', 'offset', 'apply', 'blend'];

/**
 * How pasted roads meet the destination's roads:
 *  - separate: inserted exactly as stored, no connection (crossings are reported, not split)
 *  - connect:  drawn like hand-drawn roads (ends snap, crossings become junctions)
 *  - snap:     inserted as stored, then only OPEN ends attach to a nearby node / road
 */
export type RoadPolicy = 'separate' | 'connect' | 'snap';
export const ROAD_POLICIES: readonly RoadPolicy[] = ['separate', 'connect', 'snap'];

export interface PlacementOptions extends Placement {
  terrain: TerrainPolicy;
  blendWidth: number;
  roads: RoadPolicy;
  /** Datum from the destination ground (true) or the blueprint's absolute source elevations. */
  terrainSnap: boolean;
  heightOffset: number;
  /** Rigid heights (source heights above the datum) instead of seating objects on the ground. */
  preserveRelative: boolean;
  include: CaptureInclude;
}

export function defaultPlacement(x = 0, z = 0): PlacementOptions {
  return {
    x, z, yaw: 0, terrain: 'offset', blendWidth: 8, roads: 'separate', terrainSnap: true, heightOffset: 0, preserveRelative: false,
    include: { buildings: true, objects: true, vegetation: true, roads: true, landforms: true, water: true, waterState: true, terrain: true },
  };
}

export type PlacementIssueCode =
  | 'empty' | 'outside' | 'roadInvalid' | 'roadRemoved'
  | 'objectsOutside' | 'collisions' | 'terrainDiff' | 'existingSculpt' | 'featureOverlap' | 'roadOverlap' | 'roadCrossings' | 'roadSplits'
  | 'riverInflowOutside' | 'riverOutletOutside' | 'riverUnconnected' | 'riverJoins' | 'hydrology' | 'seaLevel' | 'noSurface' | 'roadExternal'
  | 'externalLinks' | 'foundation' | 'zonesDropped' | 'unsupported';

export interface PlacementIssue {
  code: PlacementIssueCode;
  value?: number;
  /** Extra detail (e.g. hydrology issue code). */
  detail?: string;
}

export interface ConnectionHint {
  from: P2;
  to: P2;
  kind: 'node' | 'road' | 'river' | 'lake' | 'edge';
}

export interface PlacementReport {
  datum: number;
  counts: { objects: number; vegetation: number; roads: number; features: number };
  /** Blocking problems: the edit must not be committed. */
  errors: PlacementIssue[];
  warnings: PlacementIssue[];
  /** Indices (into `edit.add`) of objects overlapping existing objects. */
  collisions: number[];
  terrain: { policy: TerrainPolicy; rect: GridRect | null; raise: number; cut: number; meanDiff: number; maxDiff: number };
  roads: { policy: RoadPolicy; split: string[]; snapped: number; unconnected: number; segments: string[]; network: RoadNetwork | null };
  /** Road / river ends of the blueprint and what they would meet (preview lines). */
  connections: ConnectionHint[];
  /** World footprint polygon of the blueprint area. */
  footprint: P2[];
}

export interface PlacementPlan {
  edit: WorldEdit & { add: CreateObjectInput[]; addSeat: (number | null)[] };
  report: PlacementReport;
}

const designParamCache = new WeakMap<BuildingDesign, ReturnType<typeof designParams>>();
const paramsOf = (bp: UnifiedBlueprint, o: BlueprintItem) => {
  if (!o.design) return o.params!;
  const d = bp.designs[o.design];
  let p = designParamCache.get(d);
  if (!p) { p = designParams(d); designParamCache.set(d, p); }
  return p;
};

/** Pre-feature ground (base + sculpt) of a document at a point (bilinear). */
export function preFeatureAt(doc: WorldDocument, x: number, z: number): number {
  const t = doc.terrain, land = doc.landscape;
  const fx = Math.min(t.nx - 1.000001, Math.max(0, (x - t.originX) / t.cellSize));
  const fz = Math.min(t.nz - 1.000001, Math.max(0, (z - t.originZ) / t.cellSize));
  const ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz;
  const i = iz * t.nx + ix;
  const v = (k: number) => land.base.heights[k] + land.sculpt[k];
  return (v(i) * (1 - ax) + v(i + 1) * ax) * (1 - az) + (v(i + t.nx) * (1 - ax) + v(i + t.nx + 1) * ax) * az;
}

/** Decoded terrain layers of a blueprint (cached per blueprint terrain value). */
interface Layers { grid: LocalGrid; surface: Float32Array | null; sculpt: Float32Array | null; paint: Uint8Array | null; ground: Uint8Array | null; soil: Uint8Array | null; mask: Uint8Array | null }
const layerCache = new WeakMap<object, Layers>();
export function decodeLayers(bp: UnifiedBlueprint): Layers | null {
  const tr = bp.terrain;
  if (!tr) return null;
  let l = layerCache.get(tr);
  if (l) return l;
  const n = tr.grid.nx * tr.grid.nz;
  const f = (s: string | null) => { if (!s) return null; const a = new Float32Array(n); decodeElevation(s, a, tr.grid.nx); return a; };
  const b = (s: string | null) => { if (!s) return null; const a = new Uint8Array(n); decodeGround(s, a); return a; };
  l = { grid: tr.grid, surface: f(tr.surface), sculpt: f(tr.sculpt), paint: b(tr.paint), ground: b(tr.ground), soil: b(tr.soil), mask: b(tr.mask) };
  layerCache.set(tr, l);
  return l;
}

/** World polygon of the blueprint area (or its bounds) under a placement. */
export function footprintOf(bp: UnifiedBlueprint, p: Placement): P2[] {
  const area: P2[] = bp.area.length >= 3 ? bp.area : (() => { const [a, b, c, d] = bp.preview.bounds; return [[a, b], [c, b], [c, d], [a, d]] as P2[]; })();
  return area.map(([u, v]) => toWorld(p, u, v));
}

export function planPlacement(doc: WorldDocument, bp: UnifiedBlueprint, o: PlacementOptions, existing?: FootprintIndex): PlacementPlan {
  const t = doc.terrain;
  const sampler = samplerFor(t);
  const p: Placement = { x: o.x, z: o.z, yaw: o.yaw };
  const inc = o.include;
  const errors: PlacementIssue[] = [];
  const warnings: PlacementIssue[] = [];
  const footprint = footprintOf(bp, p);
  const wx0 = t.originX, wz0 = t.originZ, wx1 = t.originX + (t.nx - 1) * t.cellSize, wz1 = t.originZ + (t.nz - 1) * t.cellSize;
  if (o.x < wx0 || o.x > wx1 || o.z < wz0 || o.z > wz1) errors.push({ code: 'outside' });
  const clampX = (v: number) => Math.min(wx1, Math.max(wx0, v)), clampZ = (v: number) => Math.min(wz1, Math.max(wz0, v));
  // Datum: the destination level along the placed footprint (as the source datum was taken).
  const datum = (o.terrainSnap ? perimeterMean(footprint, (x, z) => preFeatureAt(doc, clampX(x), clampZ(z))) : bp.origin.datum) + o.heightOffset;
  const report: PlacementReport = {
    datum, counts: { objects: 0, vegetation: 0, roads: 0, features: 0 }, errors, warnings, collisions: [],
    terrain: { policy: o.terrain, rect: null, raise: 0, cut: 0, meanDiff: 0, maxDiff: 0 },
    roads: { policy: o.roads, split: [], snapped: 0, unconnected: 0, segments: [], network: null },
    connections: [], footprint,
  };
  const edit: PlacementPlan['edit'] = { add: [], addSeat: [] };

  // ── Terrain layers ─────────────────────────────────────────────────────────
  const layers = inc.terrain ? decodeLayers(bp) : null;
  let policy = o.terrain;
  if ((policy === 'apply' || policy === 'blend') && layers && !layers.surface) {
    warnings.push({ code: 'noSurface' });
    policy = 'offset';
  }
  report.terrain.policy = policy;
  let layerEdit: NonNullable<WorldEdit['landscape']>['layers'] | undefined;
  if (layers) {
    const g = layers.grid;
    const corners: P2[] = [[g.x0, g.z0], [g.x0 + (g.nx - 1) * g.cell, g.z0], [g.x0, g.z0 + (g.nz - 1) * g.cell], [g.x0 + (g.nx - 1) * g.cell, g.z0 + (g.nz - 1) * g.cell]].map(([u, v]) => toWorld(p, u, v));
    const xs = corners.map((c) => c[0]), zs = corners.map((c) => c[1]);
    const rect: GridRect = {
      x0: Math.max(0, Math.floor((Math.min(...xs) - t.originX) / t.cellSize)), z0: Math.max(0, Math.floor((Math.min(...zs) - t.originZ) / t.cellSize)),
      x1: Math.min(t.nx - 1, Math.ceil((Math.max(...xs) - t.originX) / t.cellSize)), z1: Math.min(t.nz - 1, Math.ceil((Math.max(...zs) - t.originZ) / t.cellSize)),
    };
    if (rect.x1 >= rect.x0 && rect.z1 >= rect.z0) {
      const w = rect.x1 - rect.x0 + 1, h = rect.z1 - rect.z0 + 1;
      const sculpt = new Float32Array(w * h), paint = new Uint8Array(w * h).fill(NO_PAINT), soil = new Uint8Array(w * h).fill(NO_PAINT);
      const land = doc.landscape;
      const localArea = bp.area.length >= 3 && layers.mask ? bp.area : null;
      const gx1 = g.x0 + (g.nx - 1) * g.cell, gz1 = g.z0 + (g.nz - 1) * g.cell;
      let usedS = false, usedP = false, usedSoil = false, raise = 0, cut = 0, diffSum = 0, diffN = 0, diffMax = 0, sculpted = 0;
      for (let iz = 0; iz < h; iz++) for (let ix = 0; ix < w; ix++) {
        const vi = (rect.z0 + iz) * t.nx + rect.x0 + ix, k = iz * w + ix;
        const x = t.originX + (rect.x0 + ix) * t.cellSize, z = t.originZ + (rect.z0 + iz) * t.cellSize;
        const [u, v] = toLocal(p, x, z);
        const ni = nearestIndex(g, u, v);
        if (ni < 0 || u < g.x0 - 1e-6 || v < g.z0 - 1e-6 || u > gx1 + 1e-6 || v > gz1 + 1e-6) continue;
        if (layers.mask && !layers.mask[ni]) continue;
        const current = land.base.heights[vi] + land.sculpt[vi];
        if (layers.surface) {
          const target = sampleBilinear(g, layers.surface, u, v)! + datum;
          const d = target - current;
          diffSum += Math.abs(d); diffN++; diffMax = Math.max(diffMax, Math.abs(d));
        }
        if (land.sculpt[vi] !== 0) sculpted++;
        if (policy === 'preserve') continue;
        let wgt = 1;
        if (policy === 'blend') {
          const edge = localArea ? (inside(localArea, u, v) ? boundaryDistance(localArea, u, v) : 0) : Math.min(u - g.x0, gx1 - u, v - g.z0, gz1 - v);
          wgt = o.blendWidth > 0 ? smoothstep(0, o.blendWidth, edge) : 1;
        }
        let add = 0;
        if (policy === 'offset') add = layers.sculpt ? sampleBilinear(g, layers.sculpt, u, v) ?? 0 : 0;
        else add = wgt * (sampleBilinear(g, layers.surface!, u, v)! + datum - current);
        add = Math.round(add * 100) / 100;
        if (add !== 0) { sculpt[k] = add; usedS = true; raise = Math.max(raise, add); cut = Math.min(cut, add); }
        const strong = policy === 'offset' || wgt >= 0.5;
        if (!strong) continue;
        const pv = layers.paint ? layers.paint[ni] : NO_PAINT;
        if (pv !== NO_PAINT) { paint[k] = pv; usedP = true; }
        else if (policy !== 'offset' && layers.ground && layers.ground[ni] !== land.base.ground[vi]) { paint[k] = layers.ground[ni]; usedP = true; }
        if (policy !== 'offset' && layers.soil && layers.soil[ni] !== t.soil[vi]) { soil[k] = layers.soil[ni]; usedSoil = true; }
      }
      report.terrain = { policy, rect, raise, cut: -cut, meanDiff: diffN ? diffSum / diffN : 0, maxDiff: diffMax };
      if (diffMax > 0.5) warnings.push({ code: 'terrainDiff', value: Math.round(diffMax * 10) / 10 });
      if ((policy === 'apply' || policy === 'blend') && sculpted) warnings.push({ code: 'existingSculpt', value: sculpted * t.cellSize * t.cellSize });
      if (usedS || usedP || usedSoil) layerEdit = { rect, sculpt: usedS ? sculpt : null, paint: usedP ? paint : null, soil: usedSoil ? soil : null };
    }
  }

  // ── Natural features ───────────────────────────────────────────────────────
  const land = doc.landscape;
  let next = land.next;
  const placedFeatures: Feature[] = [];
  const featureIds = new Map<string, string>();
  for (const f of bp.features) {
    const water = f.kind === 'river' || f.kind === 'lake';
    if (!(water ? inc.water : inc.landforms)) continue;
    let g = f;
    if (!inc.waterState) g = g.kind === 'river' ? { ...g, water: { ...g.water, fill: 0, inflow: 0 } } : g.kind === 'lake' ? { ...g, filled: false } : g;
    const id = `f${next++}`;
    featureIds.set(f.id, id);
    placedFeatures.push(mapFeature(g, id, placementMap(p), o.yaw, datum));
  }
  report.counts.features = placedFeatures.length;
  if (placedFeatures.length) {
    // Destination features under the footprint (they compose with the new ones).
    const fpBox = bounds(footprint);
    const overlap = land.features.filter((f) => boxOverlap(featureBounds(f), fpBox)).length;
    if (overlap) warnings.push({ code: 'featureOverlap', value: overlap });
  } else if (layerEdit && (policy === 'apply' || policy === 'blend')) {
    const fpBox = bounds(footprint);
    const overlap = land.features.filter((f) => boxOverlap(featureBounds(f), fpBox)).length;
    if (overlap) warnings.push({ code: 'featureOverlap', value: overlap });
  }
  if (layerEdit || placedFeatures.length) {
    edit.landscape = {};
    if (placedFeatures.length) { edit.landscape.features = [...land.features, ...placedFeatures]; edit.landscape.next = next; }
    if (layerEdit) edit.landscape.layers = layerEdit;
  }
  if ((policy === 'apply' || policy === 'blend') && layerEdit) {
    const fpBox = bounds(footprint);
    const n = Object.values(doc.roads.segments).filter((s) => segmentLine(doc.roads, s).samples.some((q) => q.x >= fpBox[0] && q.x <= fpBox[2] && q.z >= fpBox[1] && q.z <= fpBox[3] && inside(footprint, q.x, q.z))).length;
    if (n) warnings.push({ code: 'roadOverlap', value: n });
  }
  // Sea level: a blueprint captured relative to a sea placed in a world without one (or another).
  if (bp.dependencies.some((d) => d.kind === 'seaLevel') && bp.origin.seaLevel !== t.settings.waterLevel) warnings.push({ code: 'seaLevel', value: bp.origin.seaLevel ?? 0 });

  // ── Roads ──────────────────────────────────────────────────────────────────
  let network: RoadNetwork | null = null;
  let pieces: string[][] = [];
  const segIndex = new Map(bp.roads.segments.map((s, i) => [s.id, i]));
  if (inc.roads && bp.roads.segments.length) {
    const nodeIndex = new Map(bp.roads.nodes.map((n, i) => [n.id, i]));
    const indexed: IndexedRoads = {
      nodes: bp.roads.nodes.map((n) => ({ x: n.x, z: n.z, y: n.y })),
      segments: bp.roads.segments.map((s) => ({ a: nodeIndex.get(s.a)!, b: nodeIndex.get(s.b)!, control: s.control, profile: s.profile, ...(s.condition ? { condition: s.condition } : {}) })),
    };
    try {
      const before = doc.roads;
      if (o.roads === 'snap') {
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
        const tr = (u: number, v: number): P2 => [o.x + u * c + v * s, o.z - u * s + v * c];
        const ins = insertSubnetwork(before, indexed.nodes.map((n) => { const [x, z] = tr(n.x, n.z); return { x, z, y: n.y === null ? null : n.y + datum }; }), indexed.segments.map((g) => ({ ...g, control: g.control.map(([u, v]) => tr(u, v)) })));
        const r = snapEndpoints(ins.network, { nodes: ins.nodeIds, segments: ins.segmentIds });
        network = r.network;
        pieces = ins.segmentIds.map((id) => [id]);
        report.roads.snapped = r.snapped;
        report.roads.split = r.split;
        let un = 0;
        for (const id of ins.segmentIds) { const seg = network.segments[id]; if (seg) un += crossings(before, segmentLine(network, seg), seg.a, seg.b).length; }
        report.roads.unconnected = un;
      } else {
        const r = pasteRoads(before, indexed, o.x, o.z, o.yaw, o.roads === 'connect' ? 'connect' : 'isolate', datum);
        network = r.network;
        pieces = r.segments;
        report.roads.split = r.split;
        report.roads.unconnected = r.unconnectedCrossings;
      }
      // Never remove an existing road: only splits (pieces keep the geometry) are allowed.
      const removed = Object.keys(before.segments).filter((id) => !network!.segments[id]);
      if (removed.some((id) => !report.roads.split.includes(id))) errors.push({ code: 'roadRemoved', value: removed.length });
      // Zones of blocks pasted unchanged.
      let dropped = 0;
      for (const zn of bp.roads.zones) {
        const ids = zn.segments.map((sid) => pieces[segIndex.get(sid)!] ?? []);
        if (ids.some((x) => x.length !== 1)) { dropped++; continue; }
        const key = `b:${ids.map((x) => x[0]).sort().join('+')}`;
        if (blocksOf(network).some((b) => b.id === key)) network = { ...network, zones: { ...network.zones, [key]: zn.zone } };
        else dropped++;
      }
      if (dropped) warnings.push({ code: 'zonesDropped', value: dropped });
      assertValid(network);
    } catch (e) {
      errors.push({ code: 'roadInvalid', detail: (e as Error).message });
      network = null;
    }
    if (network) {
      edit.roads = network;
      report.roads.network = network;
      report.roads.segments = pieces.flat();
      report.counts.roads = pieces.flat().length;
      if (report.roads.unconnected) warnings.push({ code: 'roadCrossings', value: report.roads.unconnected });
      if (report.roads.split.length) warnings.push({ code: 'roadSplits', value: report.roads.split.length });
    }
    // Open ends of the blueprint roads and what they would meet (preview), whatever the policy.
    const degree = new Map<string, number>();
    for (const s of bp.roads.segments) { degree.set(s.a, (degree.get(s.a) ?? 0) + 1); degree.set(s.b, (degree.get(s.b) ?? 0) + 1); }
    let externalOpen = 0;
    const externalRefs = new Set(bp.dependencies.filter((d) => d.kind === 'roadExternal').flatMap((d) => d.refs));
    for (const n of bp.roads.nodes) {
      if (degree.get(n.id) !== 1) continue;
      const from = toWorld(p, n.x, n.z);
      const node = findNode(doc.roads, from[0], from[1], SNAP_NODE * 2);
      if (node) { report.connections.push({ from, to: [node.x, node.z], kind: 'node' }); continue; }
      const hit = findSegment(doc.roads, from[0], from[1], SNAP_SEGMENT * 2);
      if (hit) { report.connections.push({ from, to: [hit.x, hit.z], kind: 'road' }); continue; }
      if (externalRefs.has(n.id)) externalOpen++;
    }
    if (externalOpen) warnings.push({ code: 'roadExternal', value: externalOpen });
  }

  // ── Objects ────────────────────────────────────────────────────────────────
  const groups = new Map<string, string>();
  const items: { item: BlueprintItem; veg: boolean }[] = [
    ...(inc.buildings || inc.objects ? bp.objects.filter((it) => (it.type === 'building' ? inc.buildings : inc.objects)).map((item) => ({ item, veg: false })) : []),
    ...(inc.vegetation ? bp.vegetation.map((item) => ({ item, veg: true })) : []),
  ];
  const attach = new Map(bp.attachments.map((a) => [a.object, a]));
  let outside = 0;
  const idx = existing ?? FootprintIndex.fromObjects(Object.values(doc.objects));
  const paramsList: ReturnType<typeof paramsOf>[] = [];
  for (const { item, veg } of items) {
    const params = paramsOf(bp, item);
    const [px, pz] = toWorld(p, item.offset[0], item.offset[2]);
    const rotated = yawRotate(item.rotation, o.yaw);
    const dims = getDefinition(item.type).getDimensions(params);
    const scaled: Vec3 = [dims[0] * item.scale[0], dims[1] * item.scale[1], dims[2] * item.scale[2]];
    const yaw = yawOf(rotated);
    if (!isInsideWorld([px, 0, pz], scaled, yaw)) { outside++; continue; }
    const probe = { type: item.type, params, terrainAlign: item.terrainAlign, transform: { position: [px, 0, pz] as Vec3, rotation: rotated, scale: item.scale } };
    let position: Vec3, rotation: Vec3, seat: number | null;
    if (o.preserveRelative) {
      position = [px, roundCm(datum + item.base), pz];
      rotation = rotated;
      seat = null;
    } else {
      const pose = groundPose(probe, px, pz, yaw, sampler);
      position = [px, pose.position[1] + (item.grounded ? 0 : item.offset[1]), pz];
      rotation = item.grounded && !sampler.flat ? pose.rotation : rotated;
      seat = item.grounded ? 0 : item.offset[1];
    }
    const input: CreateObjectInput = { type: item.type, name: item.name, seed: item.seed, transform: { position, rotation, scale: [...item.scale] as Vec3 } };
    if (item.design) input.building = bp.designs[item.design];
    else input.params = { ...item.params! };
    if (item.physics) input.physics = { ...item.physics };
    if (item.seismic) input.seismic = structuredClone(item.seismic);
    if (item.terrainAlign !== undefined) input.terrainAlign = item.terrainAlign;
    if (item.group) {
      if (!groups.has(item.group)) groups.set(item.group, createId('grp'));
      input.group = groups.get(item.group);
    }
    const a = attach.get(item.id);
    if (a && network) {
      const ids = pieces[segIndex.get(a.segment) ?? -1] ?? [];
      const link = measureLink(network, px, pz, yaw, a.policy, ids.length === 1 ? ids[0] : undefined);
      if (link && ids.includes(link.segment)) input.roadLink = link;
    }
    const fp = collisionFootprint(item.type, params, item.scale, px, pz, yaw);
    if (fp && idx.overlaps(fp)) report.collisions.push(edit.add.length);
    paramsList.push(params);
    edit.add.push(input);
    edit.addSeat.push(seat);
    if (veg) report.counts.vegetation++;
    else report.counts.objects++;
  }
  if (outside) warnings.push({ code: 'objectsOutside', value: outside });
  if (report.collisions.length) warnings.push({ code: 'collisions', value: report.collisions.length });
  const links = bp.dependencies.find((d) => d.kind === 'externalLink');
  if (links) warnings.push({ code: 'externalLinks', value: links.value ?? links.refs.length });

  // ── Rivers: dependencies and connections ──────────────────────────────────
  const cutIn = new Set(bp.dependencies.filter((d) => d.kind === 'riverInflowOutside').flatMap((d) => d.refs));
  const cutOut = new Set(bp.dependencies.filter((d) => d.kind === 'riverOutletOutside').flatMap((d) => d.refs));
  for (const f of bp.features) {
    if (f.kind !== 'river' || !featureIds.has(f.id)) continue;
    const placed = placedFeatures.find((g) => g.id === featureIds.get(f.id))!;
    const pts = (placed as typeof f).points;
    for (const [end, cut] of [[pts[0], cutIn.has(f.id)], [pts[pts.length - 1], cutOut.has(f.id)]] as [P2, boolean][]) {
      const meet = riverMeets(doc, end);
      if (meet) { report.connections.push({ from: end, to: meet.to, kind: meet.kind }); if (cut) warnings.push({ code: 'riverJoins' }); }
      else if (cut) warnings.push({ code: 'riverUnconnected' });
    }
    if (cutIn.has(f.id)) warnings.push({ code: 'riverInflowOutside' });
    if (cutOut.has(f.id)) warnings.push({ code: 'riverOutletOutside' });
  }
  // Hydrology checks of the placed water (inflow at a fixed-level edge, inflow without outlet …).
  if (placedFeatures.some((f) => f.kind === 'river' || f.kind === 'lake')) {
    const probe = { ...land, features: placedFeatures.filter((f) => f.kind === 'river') };
    const plan = hydrologyPlan(probe, t, doc.settings.simulation.water);
    const seen = new Set<HydrologyIssue['code']>();
    for (const is of plan.issues) if (!seen.has(is.code)) { seen.add(is.code); warnings.push({ code: 'hydrology', detail: is.code }); }
  }
  if (bp.unsupported?.objects?.length || bp.unsupported?.features?.length) warnings.push({ code: 'unsupported', value: (bp.unsupported.objects?.length ?? 0) + (bp.unsupported.features?.length ?? 0) });
  // Buildings that would stand on poor ground (current destination; apply / blend reshape it).
  if (policy === 'offset' || policy === 'preserve') {
    let poor = 0;
    edit.add.forEach((inp, k) => {
      if (inp.type !== 'building' || sampler.flat) return;
      const [x, , z] = inp.transform.position;
      const d = getDefinition('building').getDimensions(paramsList[k]);
      const yaw = yawOf(inp.transform.rotation);
      const hs: number[] = [];
      for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const [a, b] = rotate((u * d[0]) / 2, (v * d[2]) / 2, yaw); hs.push(sampler.sampleHeight(x + a, z + b)); }
      if (Math.max(...hs) - Math.min(...hs) > 2.5) poor++;
    });
    if (poor) warnings.push({ code: 'foundation', value: poor });
  }
  if (!edit.add.length && !edit.roads && !edit.landscape) errors.push({ code: 'empty' });
  return { edit, report };
}

function riverMeets(doc: WorldDocument, [x, z]: P2): { to: P2; kind: ConnectionHint['kind'] } | null {
  const t = doc.terrain;
  if (edgeAt(t, x, z)) {
    const cx = Math.min(t.originX + (t.nx - 1) * t.cellSize, Math.max(t.originX, x)), cz = Math.min(t.originZ + (t.nz - 1) * t.cellSize, Math.max(t.originZ, z));
    const d = [Math.abs(cx - t.originX), Math.abs(t.originX + (t.nx - 1) * t.cellSize - cx), Math.abs(cz - t.originZ), Math.abs(t.originZ + (t.nz - 1) * t.cellSize - cz)];
    const k = d.indexOf(Math.min(...d));
    const to: P2 = k === 0 ? [t.originX, cz] : k === 1 ? [t.originX + (t.nx - 1) * t.cellSize, cz] : k === 2 ? [cx, t.originZ] : [cx, t.originZ + (t.nz - 1) * t.cellSize];
    return { to, kind: 'edge' };
  }
  for (const f of doc.landscape.features) {
    if (f.kind === 'lake') {
      const pd = polygonDistance(f.points, x, z);
      if (pd.inside || pd.dist < 6) return { to: [x, z], kind: 'lake' };
    } else if (f.kind === 'river') {
      const line = featureLine(f);
      let best = Infinity, at: P2 = [x, z];
      for (const q of line.samples) { const d = Math.hypot(q.x - x, q.z - z); if (d < best) { best = d; at = [q.x, q.z]; } }
      if (best < f.width / 2 + 6) return { to: at, kind: 'river' };
    }
  }
  return null;
}

function bounds(poly: readonly P2[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0, z0, x1, z1];
}
const boxOverlap = (a: readonly number[], b: readonly number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
