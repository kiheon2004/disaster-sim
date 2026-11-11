/**
 * Capture (Phase 20): part of a world → UnifiedBlueprint. Pure — reads the document, never
 * writes it. Every thing that is left out, cut or detached is REPORTED as a dependency; nothing
 * is dropped silently.
 *
 * What belongs to the selection
 *   objects    origin inside the area, or explicitly selected (+ objects linked to explicitly
 *              selected roads, as Phase 18 road copy did)
 *   roads      explicitly selected segments (whole), or segments over the area by the road
 *              boundary policy: whole / inside / clip (cut at the boundary on a scratch copy)
 *   rivers     by the nature boundary policy: whole / inside / clip (clipped pieces keep the
 *              exact channel path; the meander is baked into the points)
 *   lakes      kept whole when partly inside (inside policy: left out) — a basin cannot be cut
 *   peaks      belong where their summit is (inside policy: only when entirely inside)
 *   ridges …   line landforms are kept whole or left out (cutting would taper the cut ends)
 *   coasts     never (they are map-scale: extended to the map edges); reported when overlapping
 *   terrain    surface (base + sculpt), sculpt, paint, ground and soil layers on the area's
 *              vertex grid; polygon areas carry a vertex mask
 */
import type { P2 } from '@/landscape/types';
import type { WorldDocument, WorldObject, PhysicalProperties } from '@/core/model';
import type { BuildingDesign } from '@/buildings/types';
import { analysisOf, designPhysics, designSeismic } from '@/buildings/design';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';
import { defaultSeismic } from '@/simulation/seismic/structuralProps';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundPose, isGrounded, yawOf } from '@/terrain/groundPlacement';
import { encodeElevation, encodeGround } from '@/terrain/terrainCodec';
import { quantizeHeight } from '@/terrain/TerrainData';
import { featureBounds, featureLine } from '@/landscape/features';
import { NO_PAINT, type Feature, type LineLandformFeature, type RiverFeature } from '@/landscape/types';
import { segmentBounds } from '@/roads/bake';
import { segmentLine, splitSegment, MIN_SEGMENT } from '@/roads/network';
import { measureLink } from '@/roads/links';
import { emptyNetwork, type RoadNetwork } from '@/roads/types';
import { footprintOf } from '@/editor/build/footprint';
import { mapFeature, roundMm } from './frame';
import { boundaryDistance, inside, insideIntervals, lineCoverage, perimeterMean, piecePoints, polygonBounds, shapePolygon, type SelectionShape } from './selection';
import { preFeatureAt } from './place';
import { carSettingsOfCopies } from '@/vehicle/carCopies';
import {
  ALL_INCLUDED, BLUEPRINT_FORMAT, BLUEPRINT_VERSION, MIN_READER_VERSION,
  type BlueprintAttachment, type BlueprintCategory, type BlueprintDependency, type BlueprintItem, type BlueprintMeta, type BlueprintRoads,
  type BlueprintTerrain, type BoundaryPolicy, type CaptureInclude, type UnifiedBlueprint,
} from './types';

export interface CaptureSelection {
  /** Area drawn by the user (rectangle / polygon), or null = derived from the explicit selections. */
  shape: SelectionShape | null;
  objects?: readonly string[];
  segments?: readonly string[];
  features?: readonly string[];
}

export interface CaptureOptions {
  include?: Partial<CaptureInclude>;
  roads?: BoundaryPolicy;
  nature?: BoundaryPolicy;
  meta?: Partial<BlueprintMeta>;
  id?: string;
  /** Timestamp for meta.createdAt / updatedAt (tests pass a fixed one). */
  now?: string;
}

export interface CaptureReport {
  /** World polygon actually used (drawn or derived). */
  area: P2[];
  anchor: P2;
  datum: number;
  counts: UnifiedBlueprint['preview']['counts'];
  /** Things in the area left out by the element toggles (by kind). */
  excluded: Record<'buildings' | 'objects' | 'vegetation' | 'roads' | 'landforms' | 'water' | 'coasts', number>;
  dependencies: BlueprintDependency[];
  empty: boolean;
}

/** Margin around explicit selections when no area was drawn (m). */
const DERIVED_MARGIN = 3;
/** Clipped river pieces shorter than this are not kept (m). */
const MIN_RIVER_PIECE = 6;

const sortIds = (a: string, b: string) => {
  const na = parseInt(a.replace(/\D+/g, ''), 10), nb = parseInt(b.replace(/\D+/g, ''), 10);
  return Number.isFinite(na) && Number.isFinite(nb) && na !== nb ? na - nb : a < b ? -1 : a > b ? 1 : 0;
};

const kindOf = (o: WorldObject): 'buildings' | 'vegetation' | 'objects' => (o.type === 'building' ? 'buildings' : o.type === 'tree' ? 'vegetation' : 'objects');

/** Default physics / seismic of a design (seed-independent; cached per immutable design). */
const designDefaults = new WeakMap<BuildingDesign, { physics: PhysicalProperties; seismic: string }>();
function defaultsOf(d: BuildingDesign) {
  let v = designDefaults.get(d);
  if (!v) {
    const a = analysisOf(d);
    v = { physics: designPhysics(d, a), seismic: JSON.stringify(designSeismic(d, a, undefined)) };
    designDefaults.set(d, v);
  }
  return v;
}

/** Physics keys that differ from what the object would get by default (designs / definitions). */
function customPhysics(o: WorldObject): Partial<PhysicalProperties> | undefined {
  const def = o.building ? defaultsOf(o.building).physics : getDefinition(o.type).defaultPhysics(o.params);
  const out: Partial<PhysicalProperties> = {};
  let any = false;
  for (const k of Object.keys(o.physics) as (keyof PhysicalProperties)[]) {
    if (o.physics[k] !== def[k]) { (out as Record<string, unknown>)[k] = o.physics[k]; any = true; }
  }
  return any ? out : undefined;
}

export function captureBlueprint(doc: WorldDocument, sel: CaptureSelection, opts: CaptureOptions = {}): { blueprint: UnifiedBlueprint; report: CaptureReport } {
  const include: CaptureInclude = { ...ALL_INCLUDED, ...(opts.include ?? {}) };
  const roadPolicy = opts.roads ?? 'clip';
  const naturePolicy = opts.nature ?? 'clip';
  const t = doc.terrain;
  const land = doc.landscape;
  const sampler = samplerFor(t);
  const deps: BlueprintDependency[] = [];
  const excluded: CaptureReport['excluded'] = { buildings: 0, objects: 0, vegetation: 0, roads: 0, landforms: 0, water: 0, coasts: 0 };
  const explicitObjects = new Set((sel.objects ?? []).filter((id) => doc.objects[id]));
  const explicitSegments = new Set((sel.segments ?? []).filter((id) => doc.roads.segments[id]));
  const explicitFeatures = new Set((sel.features ?? []).filter((id) => land.features.some((f) => f.id === id)));

  // ── Area ──────────────────────────────────────────────────────────────────
  let area: P2[];
  if (sel.shape) area = shapePolygon(sel.shape);
  else {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const grow = (b: readonly number[]) => { x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); };
    for (const id of explicitObjects) {
      const o = doc.objects[id];
      const f = footprintOf(o);
      const r = f ? Math.hypot(f.hx, f.hz) : 0.5;
      grow([o.transform.position[0] - r, o.transform.position[2] - r, o.transform.position[0] + r, o.transform.position[2] + r]);
    }
    for (const id of explicitSegments) grow(segmentBounds(doc.roads, doc.roads.segments[id]));
    for (const f of land.features) if (explicitFeatures.has(f.id)) grow(featureBounds(f));
    if (!Number.isFinite(x0)) area = [];
    else {
      const wx0 = t.originX, wz0 = t.originZ, wx1 = t.originX + (t.nx - 1) * t.cellSize, wz1 = t.originZ + (t.nz - 1) * t.cellSize;
      const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      x0 = c(x0 - DERIVED_MARGIN, wx0, wx1); x1 = c(x1 + DERIVED_MARGIN, wx0, wx1); z0 = c(z0 - DERIVED_MARGIN, wz0, wz1); z1 = c(z1 + DERIVED_MARGIN, wz0, wz1);
      area = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    }
  }
  const hasArea = area.length >= 3;
  const isRect = !sel.shape || sel.shape.kind === 'rect';
  const inArea = (x: number, z: number) => hasArea && inside(area, x, z);
  const [bx0, bz0, bx1, bz1] = hasArea ? polygonBounds(area) : [0, 0, 0, 0];

  // ── Anchor (a terrain vertex at the centre) and datum ─────────────────────
  const snap = (v: number, o: number) => o + Math.round((v - o) / t.cellSize) * t.cellSize;
  const clampX = (v: number) => Math.min(t.originX + (t.nx - 1) * t.cellSize, Math.max(t.originX, v));
  const clampZ = (v: number) => Math.min(t.originZ + (t.nz - 1) * t.cellSize, Math.max(t.originZ, v));
  const ax = clampX(snap((bx0 + bx1) / 2, t.originX)), az = clampZ(snap((bz0 + bz1) / 2, t.originZ));
  const datum = hasArea ? quantizeHeight(perimeterMean(area, (x, z) => preFeatureAt(doc, clampX(x), clampZ(z)))) : 0;
  // Area-based capture only for a drawn area (a derived area just frames the explicit selection).
  const areaBased = hasArea && !!sel.shape;
  const local = (x: number, z: number): P2 => [roundMm(x - ax), roundMm(z - az)];

  // ── Roads ─────────────────────────────────────────────────────────────────
  let net: RoadNetwork = doc.roads;
  const captured = new Set<string>();
  /** Original segment id → captured pieces (ids in the scratch network). */
  const piecesOf = new Map<string, string[]>();
  if (include.roads) {
    for (const id of explicitSegments) { captured.add(id); piecesOf.set(id, [id]); }
    if (areaBased) {
      for (const seg of Object.values(doc.roads.segments).sort((a, b) => sortIds(a.id, b.id))) {
        if (captured.has(seg.id)) continue;
        const line = segmentLine(doc.roads, seg);
        const cov = lineCoverage(area, line.samples);
        if (cov === 'outside') continue;
        if (cov === 'inside' || roadPolicy === 'whole') {
          captured.add(seg.id);
          piecesOf.set(seg.id, [seg.id]);
          if (cov === 'partial') deps.push({ kind: 'roadPartial', refs: [], resolution: 'kept' });
          continue;
        }
        if (roadPolicy === 'inside') { deps.push({ kind: 'roadPartial', refs: [], resolution: 'dropped' }); continue; }
        // clip: split the scratch network at every boundary crossing, keep the inside pieces.
        const cuts: P2[] = [];
        for (const iv of insideIntervals(area, line)) {
          if (iv.cutStart) cuts.push(pointAtS(line, iv.s0));
          if (iv.cutEnd) cuts.push(pointAtS(line, iv.s1));
        }
        let ids = [seg.id];
        for (const [x, z] of cuts) {
          // The piece containing the cut point.
          let best: string | null = null, bd = Infinity;
          for (const id of ids) {
            const l = segmentLine(net, net.segments[id]);
            const d = Math.min(...l.samples.map((p) => Math.hypot(p.x - x, p.z - z)));
            if (d < bd) { bd = d; best = id; }
          }
          if (!best) continue;
          try {
            const before = new Set(Object.keys(net.segments));
            const r = splitSegment(net, best, x, z);
            net = r.network;
            const made = Object.keys(net.segments).filter((k) => !before.has(k));
            ids = [...ids.filter((k) => k !== best), ...made];
          } catch {
            // Too close to an end (< MIN_SEGMENT): the end node itself is the cut.
          }
        }
        const keep = ids.filter((id) => {
          const l = segmentLine(net, net.segments[id]);
          const mid = pointAtS(l, l.length / 2);
          return inArea(mid[0], mid[1]) && l.length >= MIN_SEGMENT;
        });
        if (keep.length) {
          for (const id of keep) captured.add(id);
          piecesOf.set(seg.id, keep);
        } else deps.push({ kind: 'roadPartial', refs: [], resolution: 'dropped' });
      }
    }
  } else if (areaBased) {
    for (const seg of Object.values(doc.roads.segments)) if (lineCoverage(area, segmentLine(doc.roads, seg).samples) !== 'outside') excluded.roads++;
  }
  const roads: BlueprintRoads = { nodes: [], segments: [], zones: [] };
  const nodeLocal = new Map<string, string>();
  const segLocal = new Map<string, string>();
  const nodeOf = (id: string) => {
    let k = nodeLocal.get(id);
    if (!k) {
      const nd = net.nodes[id];
      k = `n${nodeLocal.size + 1}`;
      nodeLocal.set(id, k);
      const [x, z] = local(nd.x, nd.z);
      roads.nodes.push({ id: k, x, z, y: nd.y === null ? null : Math.round((nd.y - datum) * 100) / 100 });
    }
    return k;
  };
  for (const id of [...captured].sort(sortIds)) {
    const s = net.segments[id];
    const k = `s${segLocal.size + 1}`;
    segLocal.set(id, k);
    const out: BlueprintRoads['segments'][number] = { id: k, a: nodeOf(s.a), b: nodeOf(s.b), control: s.control.map(([x, z]) => local(x, z)), profile: { ...s.profile } };
    if (s.condition) out.condition = s.condition;
    roads.segments.push(out);
  }
  // Ends that continue outside (connected to roads not captured, or cut at the boundary).
  if (captured.size) {
    const external: string[] = [];
    for (const [world, k] of nodeLocal) {
      if (Object.values(net.segments).some((s) => !captured.has(s.id) && (s.a === world || s.b === world))) external.push(k);
    }
    if (external.length) deps.push({ kind: 'roadExternal', refs: external, resolution: 'clipped', value: external.length });
  }
  for (const [key, zone] of Object.entries(net.zones)) {
    const ids = key.replace(/^b:/, '').split('+');
    if (ids.length && ids.every((id) => segLocal.has(id))) roads.zones.push({ segments: ids.map((id) => segLocal.get(id)!).sort(sortIds), zone });
  }

  // ── Objects ───────────────────────────────────────────────────────────────
  const linkedToExplicit = (o: WorldObject) => !!o.roadLink && explicitSegments.has(o.roadLink.segment);
  const chosen: WorldObject[] = [];
  for (const o of Object.values(doc.objects)) {
    const [x, , z] = o.transform.position;
    if (!(explicitObjects.has(o.id) || linkedToExplicit(o) || (sel.shape && inArea(x, z)))) continue;
    const kind = kindOf(o);
    if (!include[kind]) { excluded[kind]++; continue; }
    chosen.push(o);
  }
  chosen.sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial || (a.id < b.id ? -1 : 1));
  const designs: Record<string, BuildingDesign> = {};
  const designKey = new Map<BuildingDesign, string>();
  const groupKey = new Map<string, string>();
  const objects: BlueprintItem[] = [];
  const vegetation: BlueprintItem[] = [];
  const objLocal = new Map<string, string>();
  const crossing: string[] = [];
  const chosenIds = new Set(chosen.map((o) => o.id));
  for (const o of chosen) {
    const veg = o.type === 'tree';
    const id = veg ? `v${vegetation.length + 1}` : `o${objects.length + 1}`;
    objLocal.set(o.id, id);
    const [x, y, z] = o.transform.position;
    const grounded = isGrounded(o, sampler);
    const ground = groundPose(o, x, z, yawOf(o.transform.rotation), sampler).position[1];
    const [lx, lz] = local(x, z);
    const item: BlueprintItem = {
      id, type: o.type, name: o.name, seed: o.seed,
      offset: [lx, grounded ? 0 : roundMm(y - ground), lz],
      rotation: [...o.transform.rotation],
      scale: [...o.transform.scale],
      grounded,
      base: roundMm(y - datum),
    };
    if (o.building) {
      let k = designKey.get(o.building);
      if (!k) {
        k = `d${designKey.size + 1}`;
        designKey.set(o.building, k);
        designs[k] = o.building;
      }
      item.design = k;
    } else item.params = { ...o.params };
    const phys = customPhysics(o);
    if (phys) item.physics = phys;
    if (o.seismic && JSON.stringify(o.seismic) !== (o.building ? defaultsOf(o.building).seismic : JSON.stringify(defaultSeismic(o.type)))) item.seismic = structuredClone(o.seismic);
    if (o.terrainAlign !== undefined) item.terrainAlign = o.terrainAlign;
    if (o.group) {
      if (!groupKey.has(o.group)) groupKey.set(o.group, `g${groupKey.size + 1}`);
      item.group = groupKey.get(o.group);
    }
    (veg ? vegetation : objects).push(item);
    if (hasArea && sel.shape) {
      const fp = footprintOf(o);
      if (fp) {
        const c = Math.cos(fp.yaw), s = Math.sin(fp.yaw);
        const out = [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([u, v]) => { const px = x + u * fp.hx * c + v * fp.hz * s, pz = z - u * fp.hx * s + v * fp.hz * c; return !inside(area, px, pz); });
        if (out) crossing.push(id);
      }
    }
  }
  if (crossing.length) deps.push({ kind: 'objectCrossesBoundary', refs: crossing, resolution: 'kept', value: crossing.length });
  // Groups only partly captured.
  const partialGroups = [...groupKey.keys()].filter((g) => Object.values(doc.objects).some((o) => o.group === g && !chosenIds.has(o.id)));
  if (partialGroups.length) deps.push({ kind: 'groupPartial', refs: partialGroups.map((g) => groupKey.get(g)!), resolution: 'kept', value: partialGroups.length });
  // Designs shared with objects outside the blueprint (the blueprint carries its own copy).
  const sharedOutside = [...designKey.entries()].filter(([d]) => Object.values(doc.objects).some((o) => o.building === d && !chosenIds.has(o.id))).map(([, k]) => k);
  if (sharedOutside.length) deps.push({ kind: 'sharedDesign', refs: sharedOutside, resolution: 'copied', value: sharedOutside.length });

  // ── Attachments (links re-measured on the captured roads, local frame) ─────
  const attachments: BlueprintAttachment[] = [];
  const detached: string[] = [];
  if (roads.segments.length) {
    const ln: RoadNetwork = { ...emptyNetwork(), nodes: {}, segments: {} };
    for (const nd of roads.nodes) ln.nodes[nd.id] = { id: nd.id, x: nd.x, z: nd.z, y: nd.y };
    for (const s of roads.segments) ln.segments[s.id] = { id: s.id, a: s.a, b: s.b, control: s.control, profile: s.profile };
    for (const o of chosen) {
      if (!o.roadLink) continue;
      const pieces = (piecesOf.get(o.roadLink.segment) ?? []).map((p) => segLocal.get(p)).filter((k): k is string => !!k);
      if (!pieces.length) { detached.push(objLocal.get(o.id)!); continue; }
      const [lx, lz] = local(o.transform.position[0], o.transform.position[2]);
      const yaw = yawOf(o.transform.rotation);
      const l = measureLink(ln, lx, lz, yaw, o.roadLink.policy, pieces.length === 1 ? pieces[0] : undefined);
      if (l && pieces.includes(l.segment)) attachments.push({ object: objLocal.get(o.id)!, segment: l.segment, t: l.t, lateral: l.lateral, yaw: l.yaw, policy: l.policy });
      else detached.push(objLocal.get(o.id)!);
    }
  } else for (const o of chosen) if (o.roadLink) detached.push(objLocal.get(o.id)!);
  if (detached.length) deps.push({ kind: 'externalLink', refs: detached, resolution: 'detached', value: detached.length });

  // ── Natural features ──────────────────────────────────────────────────────
  const features: Feature[] = [];
  const toLocalFeature = (f: Feature) => mapFeature(f, `r${features.length + 1}`, (x, z) => [x - ax, z - az], 0, -datum);
  const stripWater = (f: Feature): Feature => (include.waterState ? f : f.kind === 'river' ? { ...f, water: { ...f.water, fill: 0, inflow: 0 } } : f.kind === 'lake' ? { ...f, filled: false } : f);
  for (const f of land.features) {
    const explicit = explicitFeatures.has(f.id);
    const isWater = f.kind === 'river' || f.kind === 'lake';
    const overlaps = areaBased && boxOverlapsPolygon(featureBounds(f), area);
    if (f.kind === 'coast') {
      if (explicit || overlaps) { deps.push({ kind: 'coastExcluded', refs: [], resolution: 'dropped' }); excluded.coasts++; }
      continue;
    }
    if (!explicit && !overlaps) continue;
    if (!(isWater ? include.water : include.landforms)) { if (explicit || featureTouches(f, area)) excluded[isWater ? 'water' : 'landforms']++; continue; }
    if (explicit) { features.push(toLocalFeature(stripWater(f))); continue; }
    if (f.kind === 'mountain' || f.kind === 'hill') {
      const summitIn = inArea(f.x, f.z);
      const whollyIn = summitIn && boundaryDistance(area, f.x, f.z) >= f.radius;
      if (!summitIn && !circleTouches(area, f.x, f.z, f.radius)) continue;
      if (summitIn && (whollyIn || naturePolicy !== 'inside')) {
        const local = toLocalFeature(f);
        features.push(local);
        if (!whollyIn) deps.push({ kind: 'landformPartial', refs: [local.id], resolution: 'kept' });
      } else deps.push({ kind: 'landformPartial', refs: [], resolution: 'dropped' });
      continue;
    }
    if (f.kind === 'lake') {
      const cov = lineCoverage(area, f.points.map(([x, z]) => ({ x, z })));
      if (cov === 'outside' && !inArea(f.points[0][0], f.points[0][1])) {
        // The area may lie inside a big lake: then it is partial too.
        if (!featureTouches(f, area)) continue;
      }
      if (cov === 'inside') { features.push(toLocalFeature(stripWater(f))); continue; }
      if (naturePolicy === 'inside') { deps.push({ kind: 'lakePartial', refs: [], resolution: 'dropped' }); continue; }
      const local = toLocalFeature(stripWater(f));
      features.push(local);
      deps.push({ kind: 'lakePartial', refs: [local.id], resolution: 'kept' });
      continue;
    }
    // Line features (ridge / valley / canyon / river).
    const line = featureLine(f as LineLandformFeature | RiverFeature);
    const cov = lineCoverage(area, line.samples);
    if (cov === 'outside') continue;
    if (cov === 'inside') { features.push(toLocalFeature(stripWater(f))); continue; }
    if (naturePolicy === 'inside') { deps.push({ kind: f.kind === 'river' ? 'riverPartial' : 'landformPartial', refs: [], resolution: 'dropped' }); continue; }
    if (f.kind !== 'river' || naturePolicy === 'whole') {
      const local = toLocalFeature(stripWater(f));
      features.push(local);
      deps.push({ kind: f.kind === 'river' ? 'riverPartial' : 'landformPartial', refs: [local.id], resolution: 'kept' });
      continue;
    }
    // Clip the river: one feature per inside piece, the channel path exact (meander baked in).
    const pieces = insideIntervals(area, line, MIN_RIVER_PIECE);
    if (!pieces.length) { deps.push({ kind: 'riverPartial', refs: [], resolution: 'dropped' }); continue; }
    pieces.forEach((iv, k) => {
      const r = f as RiverFeature;
      const piece: RiverFeature = {
        ...r,
        points: piecePoints(line, iv.s0, iv.s1, 48),
        meander: { ...r.meander, amplitude: 0 },
        // The inflow enters at the upstream end of the river: only the most upstream piece keeps it.
        water: { ...r.water, inflow: k === 0 ? r.water.inflow : 0 },
      };
      const loc = toLocalFeature(stripWater(piece));
      features.push(loc);
      if (iv.cutStart) deps.push({ kind: 'riverInflowOutside', refs: [loc.id], resolution: 'clipped', value: k === 0 ? r.water.inflow : 0 });
      if (iv.cutEnd) deps.push({ kind: 'riverOutletOutside', refs: [loc.id], resolution: 'clipped' });
    });
  }

  // ── Terrain layers ────────────────────────────────────────────────────────
  let terrain: BlueprintTerrain | null = null;
  let relief: [number, number] = [0, 0];
  if (include.terrain && hasArea) {
    const ix0 = Math.max(0, Math.floor((bx0 - t.originX) / t.cellSize + 1e-9)), iz0 = Math.max(0, Math.floor((bz0 - t.originZ) / t.cellSize + 1e-9));
    const ix1 = Math.min(t.nx - 1, Math.ceil((bx1 - t.originX) / t.cellSize - 1e-9)), iz1 = Math.min(t.nz - 1, Math.ceil((bz1 - t.originZ) / t.cellSize - 1e-9));
    const nx = ix1 - ix0 + 1, nz = iz1 - iz0 + 1;
    if (nx >= 2 && nz >= 2) {
      const n = nx * nz;
      const surface = new Float32Array(n), sculpt = new Float32Array(n), soil = new Uint8Array(n), ground = new Uint8Array(n), paint = new Uint8Array(n), mask = new Uint8Array(n);
      let usedS = false, usedP = false, lo = Infinity, hi = -Infinity, below = 0;
      const sea = t.settings.waterLevel;
      for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
        const i = (iz0 + iz) * t.nx + ix0 + ix, k = iz * nx + ix;
        const x = t.originX + (ix0 + ix) * t.cellSize, z = t.originZ + (iz0 + iz) * t.cellSize;
        surface[k] = quantizeHeight(land.base.heights[i] + land.sculpt[i] - datum);
        sculpt[k] = land.sculpt[i];
        paint[k] = land.paint[i];
        ground[k] = land.base.ground[i];
        soil[k] = t.soil[i];
        mask[k] = isRect || inside(area, x, z) || boundaryDistance(area, x, z) < t.cellSize * 0.5 ? 1 : 0;
        if (!mask[k]) continue;
        usedS ||= sculpt[k] !== 0;
        usedP ||= paint[k] !== NO_PAINT;
        lo = Math.min(lo, surface[k]); hi = Math.max(hi, surface[k]);
        if (sea !== null && land.natural.heights[i] < sea) below++;
      }
      const [lx0, lz0] = local(t.originX + ix0 * t.cellSize, t.originZ + iz0 * t.cellSize);
      terrain = {
        grid: { x0: lx0, z0: lz0, nx, nz, cell: t.cellSize },
        surface: encodeElevation(surface, nx),
        sculpt: usedS ? encodeElevation(sculpt, nx) : null,
        paint: usedP ? encodeGround(paint) : null,
        ground: encodeGround(ground),
        soil: encodeGround(soil),
        mask: isRect ? null : encodeGround(mask),
      };
      relief = Number.isFinite(lo) ? [lo, hi] : [0, 0];
      if (below) deps.push({ kind: 'seaLevel', refs: [], resolution: 'info', value: sea ?? 0 });
      // Buildings whose foundation reaches past the captured ground.
      const unsupported = chosen.filter((o) => o.type === 'building' && crossing.includes(objLocal.get(o.id)!)).map((o) => objLocal.get(o.id)!);
      if (unsupported.length) deps.push({ kind: 'foundationSupport', refs: unsupported, resolution: 'info', value: unsupported.length });
    }
  }

  // ── Preview / meta ────────────────────────────────────────────────────────
  const counts = {
    objects: objects.length,
    buildings: objects.filter((o) => o.type === 'building').length,
    vegetation: vegetation.length,
    roads: roads.segments.length,
    features: features.length,
    water: features.filter((f) => f.kind === 'river' || f.kind === 'lake').length,
  };
  const localArea: P2[] = area.map(([x, z]) => local(x, z));
  const lb = localBounds(localArea, [...objects, ...vegetation], roads, features);
  const now = opts.now ?? new Date().toISOString();
  const meta: BlueprintMeta = {
    name: opts.meta?.name ?? '',
    description: opts.meta?.description ?? '',
    category: opts.meta?.category ?? guessCategory(counts),
    tags: [...(opts.meta?.tags ?? [])],
    createdAt: opts.meta?.createdAt ?? now,
    updatedAt: now,
  };
  if (opts.meta?.author) meta.author = opts.meta.author;
  const blueprint: UnifiedBlueprint = {
    format: BLUEPRINT_FORMAT,
    version: BLUEPRINT_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    id: opts.id ?? createId('bp'),
    meta,
    origin: { datum, seaLevel: t.settings.waterLevel },
    area: localArea,
    objects,
    vegetation,
    designs,
    roads,
    attachments,
    features,
    terrain,
    dependencies: deps,
    preview: { size: hasArea ? [roundMm(bx1 - bx0), roundMm(bz1 - bz0)] : [0, 0], bounds: lb, relief, counts, thumbnail: null },
  };
  // Phase 37: the captured cars' simulation settings, under local ids (occupants: captured people only).
  const cars = carSettingsOfCopies(doc.settings.simulation.vehicles?.cars, objLocal);
  if (Object.keys(cars).length) blueprint.cars = cars;
  const empty = !objects.length && !vegetation.length && !roads.segments.length && !features.length && !terrain;
  return { blueprint, report: { area, anchor: [ax, az], datum, counts, excluded, dependencies: deps, empty } };
}

function guessCategory(c: UnifiedBlueprint['preview']['counts']): BlueprintCategory {
  const nature = c.features > 0 || (c.vegetation > 0 && !c.buildings && !c.roads && c.objects === 0);
  if (nature && (c.buildings || c.roads)) return 'mixed';
  if (nature) return 'nature';
  if (c.buildings && c.roads) return 'mixed';
  if (c.buildings) return 'buildings';
  if (c.roads) return 'roads';
  return c.objects ? 'infrastructure' : 'mixed';
}

/** Local bounds of everything (area, objects, road nodes / controls, features). */
function localBounds(area: P2[], items: readonly BlueprintItem[], roads: BlueprintRoads, features: readonly Feature[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const add = (x: number, z: number) => { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); };
  for (const [x, z] of area) add(x, z);
  for (const o of items) add(o.offset[0], o.offset[2]);
  for (const n of roads.nodes) add(n.x, n.z);
  for (const s of roads.segments) for (const [x, z] of s.control) add(x, z);
  for (const f of features) { const b = featureBounds(f); add(b[0], b[1]); add(b[2], b[3]); }
  return Number.isFinite(x0) ? [roundMm(x0), roundMm(z0), roundMm(x1), roundMm(z1)] : [0, 0, 0, 0];
}

function pointAtS(line: { samples: { x: number; z: number; s: number }[]; length: number }, s: number): P2 {
  const S = line.samples;
  if (s <= 0) return [S[0].x, S[0].z];
  if (s >= line.length) return [S[S.length - 1].x, S[S.length - 1].z];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].s <= s) lo = m; else hi = m; }
  const w = (s - S[lo].s) / Math.max(1e-9, S[hi].s - S[lo].s);
  return [S[lo].x + (S[hi].x - S[lo].x) * w, S[lo].z + (S[hi].z - S[lo].z) * w];
}

function boxOverlapsPolygon(b: readonly number[], poly: readonly P2[]): boolean {
  const [x0, z0, x1, z1] = polygonBounds(poly);
  return b[0] <= x1 && b[2] >= x0 && b[1] <= z1 && b[3] >= z0;
}

function circleTouches(poly: readonly P2[], x: number, z: number, r: number): boolean {
  return inside(poly, x, z) || boundaryDistance(poly, x, z) < r;
}

/** Does a feature's influence reach into the area (sampled)? */
function featureTouches(f: Feature, poly: readonly P2[]): boolean {
  if (f.kind === 'mountain' || f.kind === 'hill') return circleTouches(poly, f.x, f.z, f.radius);
  if (f.kind === 'lake') {
    if (f.points.some(([x, z]) => inside(poly, x, z))) return true;
    // Area entirely inside the lake?
    return poly.some(([x, z]) => inside(f.points, x, z));
  }
  const line = featureLine(f as LineLandformFeature | RiverFeature);
  return line.samples.some((p) => inside(poly, p.x, p.z));
}

