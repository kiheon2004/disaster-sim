/**
 * City building along roads (Phase 18): buildings along a road's frontage, infrastructure
 * (streetlights, signs, traffic signals, guardrails, fences), block fills by zone, vehicles
 * along a road, and procedural neighbourhood presets. Pure functions returning placement
 * inputs (and road networks) — the caller commits them as ONE atomic world edit.
 *
 * Every result is deterministic for the same network, world and seed. Objects are ordinary,
 * individually editable world objects carrying a road link (follow by default). Placement
 * reuses the Phase 16 placement plan (slope limit, collision avoidance, world bounds) and the
 * Phase 17 modular buildings; designs of one preset and height are shared (one immutable
 * object, one design-table entry in the file).
 */
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { ObjectParams, WorldObject } from '@/core/model';
import type { ObjectType } from '@/core/types';
import { Rng } from '@/core/random';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { getDefinition } from '@/objects/registry';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { BuildingDesign } from '@/buildings/types';
import { collisionFootprint, footprintOf, FootprintIndex, type Footprint } from '@/editor/build/footprint';
import { DEFAULT_PLACEMENT, planPlacement, type PlanItem, type PlannedObject } from '@/editor/build/placementPlan';
import { subSeed } from '@/editor/build/distribution';
import { nearest, pointAt } from './curve';
import { intersectionsOf } from './intersections';
import { degree, drawRoad, segmentLine } from './network';
import { blocksOf, pointInPolygon, type Block } from './blocks';
import { measureLink, roadYaw } from './links';
import { segmentBounds } from './bake';
import { defaultProfile, PROFILE_PRESETS, sideWidth, type LinkPolicy, type RoadNetwork, type RoadProfile, type RoadSegment, type ZoneType } from './types';

type P2 = [number, number];

// ── Road clearance ─────────────────────────────────────────────────────────────

/** Does a footprint reach onto a carriageway or sidewalk (+ margin)? */
export function footprintOnRoad(n: RoadNetwork, f: Footprint, margin = 0.3): boolean {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  const pts: P2[] = [];
  for (const [u, v] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const lx = u * f.hx, lz = v * f.hz;
    pts.push([f.x + lx * c + lz * s, f.z - lx * s + lz * c]);
  }
  const r = Math.hypot(f.hx, f.hz);
  for (const seg of Object.values(n.segments)) {
    const [x0, z0, x1, z1] = segmentBounds(n, seg);
    if (f.x + r < x0 || f.x - r > x1 || f.z + r < z0 || f.z - r > z1) continue;
    const line = segmentLine(n, seg);
    for (const [x, z] of pts) {
      const h = nearest(line, x, z);
      const reach = sideWidth(seg.profile, h.side > 0 ? 'right' : 'left') + margin;
      if (h.dist < reach) return true;
    }
    // Footprint edges crossing the centerline between sample points (large footprints).
    const p = pointAt(line, nearest(line, f.x, f.z).s);
    const lx = (p.x - f.x) * c - (p.z - f.z) * s, lz = (p.x - f.x) * s + (p.z - f.z) * c;
    if (Math.abs(lx) < f.hx && Math.abs(lz) < f.hz) return true;
  }
  return false;
}

/** Junction areas (intersection surfaces + crosswalk room) as circles — no buildings there. */
function junctionDiscs(n: RoadNetwork): { x: number; z: number; r: number }[] {
  const out: { x: number; z: number; r: number }[] = [];
  for (const ix of intersectionsOf(n).values()) {
    const node = n.nodes[ix.node];
    let r = 0;
    for (const p of ix.surface) r = Math.max(r, Math.hypot(p[0] - node.x, p[1] - node.z));
    out.push({ x: node.x, z: node.z, r: r + 4 });
  }
  return out;
}

// ── Frontage layout ────────────────────────────────────────────────────────────

export type FrontSide = 'left' | 'right' | 'both';

export interface FrontagePoint {
  x: number;
  z: number;
  /** Heading that puts the object's FRONT (local +z) toward the road. */
  yaw: number;
  segment: string;
  /** +1 right of travel a→b, −1 left. */
  side: 1 | -1;
  s: number;
}

export interface FrontageOptions {
  side: FrontSide;
  /** Distance between object centers along the road (m). */
  spacing: number;
  /** Gap between the sidewalk (or road edge) and the object's front (m). */
  setback: number;
  /** Object depth across the road (m) — its center sits depth/2 behind the setback line. */
  depth: number;
  /** Clearance kept from the trimmed road ends / junctions (m). */
  endClearance?: number;
  /** Shift of the first object (fraction of spacing, 0–1). */
  phase?: number;
}

/** Points along the frontage of segments (deterministic, in segment id order). */
export function frontage(n: RoadNetwork, segIds: readonly string[], o: FrontageOptions): FrontagePoint[] {
  const ints = intersectionsOf(n);
  const out: FrontagePoint[] = [];
  for (const id of [...segIds].sort()) {
    const seg = n.segments[id];
    if (!seg) continue;
    const line = segmentLine(n, seg);
    const clear = o.endClearance ?? 2;
    const s0 = (ints.get(seg.a)?.trim.get(id) ?? 0) + clear;
    const s1 = line.length - (ints.get(seg.b)?.trim.get(id) ?? 0) - clear;
    if (s1 - s0 < Math.min(o.spacing, 4)) continue;
    const sides: (1 | -1)[] = o.side === 'both' ? [1, -1] : o.side === 'right' ? [1] : [-1];
    const count = Math.max(1, Math.floor((s1 - s0) / o.spacing));
    const used = count * o.spacing;
    const start = s0 + (s1 - s0 - used) / 2 + o.spacing * (o.phase ?? 0.5);
    for (const side of sides) {
      const lateral = side * (sideWidth(seg.profile, side > 0 ? 'right' : 'left') + o.setback + o.depth / 2);
      for (let k = 0; k < count; k++) {
        const s = start + k * o.spacing;
        if (s > s1 + 1e-6) break;
        const p = pointAt(line, s);
        const x = p.x - p.tz * lateral, z = p.z + p.tx * lateral;
        // Toward the road = −side · right normal = side · (tz, −tx).
        const dx = side * p.tz, dz = -side * p.tx;
        out.push({ x, z, yaw: Math.atan2(dx, dz), segment: id, side, s });
      }
    }
  }
  return out;
}

// ── Buildings & designs ────────────────────────────────────────────────────────

/** Modular building presets used per zone (height ranges in floors). */
export const ZONE_BUILDINGS: Record<Exclude<ZoneType, 'park'>, { preset: string; floors: [number, number]; weight: number }[]> = {
  residential: [{ preset: 'house', floors: [1, 2], weight: 3 }, { preset: 'apartment', floors: [3, 6], weight: 1 }],
  commercial: [{ preset: 'office', floors: [4, 10], weight: 2 }, { preset: 'apartment', floors: [4, 8], weight: 1 }],
  industrial: [{ preset: 'warehouse', floors: [1, 1], weight: 2 }, { preset: 'industrial', floors: [1, 3], weight: 2 }],
  mixed: [{ preset: 'house', floors: [2, 3], weight: 1 }, { preset: 'apartment', floors: [3, 6], weight: 1 }, { preset: 'office', floors: [3, 6], weight: 1 }],
};

const designCache = new Map<string, BuildingDesign>();
/** Shared immutable design of a preset with a floor count (structure sharing). */
export function presetDesign(preset: string, floors: number): BuildingDesign | null {
  const key = `${preset}:${floors}`;
  let d = designCache.get(key);
  if (d) return d;
  const spec = presetSpec(preset);
  if (!spec) return null;
  d = createDesign({ ...spec, floors }, preset);
  designCache.set(key, d);
  return d;
}

export interface BuildingRowOptions extends Omit<FrontageOptions, 'depth' | 'spacing'> {
  presets: { preset: string; floors: [number, number]; weight: number }[];
  /** Gap between neighbouring buildings (m). */
  gap: number;
  seed: number;
  /** Max. terrain slope at a building (deg). */
  slopeLimit: number;
  policy: LinkPolicy;
}

export interface CityContext {
  terrain: TerrainSampler;
  /** Objects already in the world (collision avoidance). */
  objects: Record<string, WorldObject>;
  network: RoadNetwork;
}

export interface CityPlan {
  inputs: CreateObjectInput[];
  /** Points rejected and why (UI summary). */
  rejected: { slope: number; collision: number; road: number; outside: number };
}

const emptyPlan = (): CityPlan => ({ inputs: [], rejected: { slope: 0, collision: 0, road: 0, outside: 0 } });

function existingIndex(objects: Record<string, WorldObject>): FootprintIndex {
  const idx = new FootprintIndex();
  for (const o of Object.values(objects).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const f = footprintOf(o);
    if (f) idx.add(f, o.id);
  }
  return idx;
}

function pickWeighted<T extends { weight: number }>(rng: Rng, list: readonly T[]): T {
  let total = 0;
  for (const x of list) total += x.weight;
  let r = rng.next() * total;
  for (const x of list) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return list[list.length - 1];
}

/**
 * One plan entry per point, with road clearance and junction checks on top of the Phase 16
 * plan (slope, collisions with the world and with each other).
 */
function planAt(ctx: CityContext, item: PlanItem, pts: FrontagePoint[], seed: number, slopeLimit: number, policy: LinkPolicy, own: FootprintIndex, existing: FootprintIndex, plan: CityPlan, label: string, offRoad = true) {
  const discs = junctionDiscs(ctx.network);
  pts.forEach((p, i) => {
    const res: PlannedObject[] = planPlacement(item, [{ x: p.x, z: p.z, yaw: p.yaw }], {
      ...DEFAULT_PLACEMENT, seed: subSeed(seed, label, i), randomRotation: false, variation: item.type !== 'building', slopeLimit, avoidCollisions: true,
    }, { terrain: ctx.terrain, existing }, 0, own);
    const e = res[0];
    if (!e.ok) {
      plan.rejected[e.rejected === 'slope' ? 'slope' : e.rejected === 'outside' ? 'outside' : 'collision']++;
      return;
    }
    const t = e.input.transform;
    const fp = collisionFootprint(item.type, e.input.params ?? {}, t.scale, t.position[0], t.position[2], p.yaw);
    if (offRoad && fp && (footprintOnRoad(ctx.network, fp) || discs.some((d) => Math.hypot(d.x - fp.x, d.z - fp.z) < d.r + Math.min(fp.hx, fp.hz)))) {
      plan.rejected.road++;
      // The plan registered it as placed: keep the index honest by not counting it further
      // (FootprintIndex has no removal; a rejected entry only makes neighbours more cautious).
      return;
    }
    const link = measureLink(ctx.network, p.x, p.z, p.yaw, policy, p.segment);
    if (link) e.input.roadLink = link;
    plan.inputs.push(e.input);
  });
}

/** Modular buildings along the frontage of segments, facing the road. */
export function buildingsAlong(ctx: CityContext, segIds: readonly string[], o: BuildingRowOptions): CityPlan {
  const plan = emptyPlan();
  const existing = existingIndex(ctx.objects);
  const own = new FootprintIndex();
  const rng = new Rng(subSeed(o.seed, 'buildings'));
  for (const id of [...segIds].sort()) {
    // Walk the frontage, choosing each building first so its width sets the spacing.
    const seg = ctx.network.segments[id];
    if (!seg) continue;
    const sides: (1 | -1)[] = o.side === 'both' ? [1, -1] : o.side === 'right' ? [1] : [-1];
    for (const side of sides) {
      const line = segmentLine(ctx.network, seg);
      const ints = intersectionsOf(ctx.network);
      const clear = o.endClearance ?? 3;
      let s = (ints.get(seg.a)?.trim.get(id) ?? 0) + clear;
      const s1 = line.length - (ints.get(seg.b)?.trim.get(id) ?? 0) - clear;
      let k = 0;
      while (s < s1) {
        const choice = pickWeighted(rng, o.presets);
        const floors = choice.floors[0] + rng.int(choice.floors[1] - choice.floors[0] + 1);
        const design = presetDesign(choice.preset, floors);
        if (!design) break;
        const w = design.spec.width, d = design.spec.depth;
        if (s + w > s1) break;
        const mid = s + w / 2;
        const p = pointAt(line, mid);
        const lateral = side * (sideWidth(seg.profile, side > 0 ? 'right' : 'left') + o.setback + d / 2);
        const pt: FrontagePoint = { x: p.x - p.tz * lateral, z: p.z + p.tx * lateral, yaw: Math.atan2(side * p.tz, -side * p.tx), segment: id, side, s: mid };
        planAt(ctx, { type: 'building', building: design }, [pt], subSeed(o.seed, `${id}:${side}`, k), o.slopeLimit, o.policy, own, existing, plan, 'b');
        s += w + o.gap;
        k++;
      }
    }
  }
  return plan;
}

// ── Infrastructure ─────────────────────────────────────────────────────────────

export type InfraKind = 'streetLight' | 'sign' | 'signal' | 'guardrail' | 'fence' | 'tree';
export const INFRA_KINDS: readonly InfraKind[] = ['streetLight', 'sign', 'signal', 'guardrail', 'fence', 'tree'];

/** Object type + params of each infrastructure kind (existing object types). */
export const INFRA_ITEMS: Record<InfraKind, { type: ObjectType; params?: ObjectParams }> = {
  streetLight: { type: 'streetLight' },
  sign: { type: 'sign', params: { height: 2.6, panelWidth: 0.8, panelHeight: 0.8, color: '#c8312f' } },
  signal: { type: 'sign', params: { height: 5.2, panelWidth: 0.45, panelHeight: 1.2, color: '#24272b' } },
  guardrail: { type: 'wall', params: { length: 4, height: 0.75, thickness: 0.15, color: '#a9b0b6' } },
  fence: { type: 'wall', params: { length: 4, height: 1.6, thickness: 0.1, color: '#d9d6cf' } },
  tree: { type: 'tree', params: { species: 'broadleaf', height: 7, canopyRadius: 2.2, trunkRadius: 0.22 } },
};

export interface InfraOptions {
  kind: InfraKind;
  side: FrontSide;
  /** Spacing along the road (m) — lights, trees, guardrail / fence pieces. */
  spacing: number;
  seed: number;
  policy: LinkPolicy;
}

/** Default spacing per kind (m). */
export const INFRA_SPACING: Record<InfraKind, number> = { streetLight: 25, sign: 0, signal: 0, guardrail: 4, fence: 4, tree: 10 };

/**
 * Infrastructure along / at the ends of segments:
 *  - streetlights, trees: on the sidewalk near the curb (road edge without a sidewalk), lamps
 *    reaching over the road
 *  - guardrails: along the carriageway edge (outside the sidewalk if there is one)
 *  - fences: along the property line (outer sidewalk edge + 0.5 m)
 *  - signs: at each segment end entering a junction, right side, facing the traffic
 *  - signals: at every junction with ≥ 3 roads, one per approach, right corner
 */
export function infrastructureAlong(ctx: CityContext, segIds: readonly string[], o: InfraOptions): CityPlan {
  const n = ctx.network;
  const plan = emptyPlan();
  const existing = existingIndex(ctx.objects);
  const own = new FootprintIndex();
  const item: PlanItem = { ...INFRA_ITEMS[o.kind], randomize: o.kind === 'tree' };
  const ints = intersectionsOf(n);
  const pts: FrontagePoint[] = [];
  const ids = [...segIds].sort().filter((id) => n.segments[id]);
  /** Point on the sidewalk near the curb (or just outside a road without sidewalk). */
  const curbPoint = (seg: RoadSegment, s: number, side: 1 | -1): FrontagePoint => {
    const p = pointAt(segmentLine(n, seg), s);
    const walk = sideWidth(seg.profile, side > 0 ? 'right' : 'left') - seg.profile.width / 2;
    const lateral = side * (seg.profile.width / 2 + (walk > 0 ? Math.min(0.7, walk / 2) : 0.8));
    return { x: p.x - p.tz * lateral, z: p.z + p.tx * lateral, yaw: 0, segment: seg.id, side, s };
  };
  const sidesOf = (): (1 | -1)[] => (o.side === 'both' ? [1, -1] : o.side === 'right' ? [1] : [-1]);
  if (o.kind === 'streetLight' || o.kind === 'tree') {
    for (const id of ids) {
      const seg = n.segments[id];
      const line = segmentLine(n, seg);
      const s0 = (ints.get(seg.a)?.trim.get(id) ?? 0) + 2;
      const s1 = line.length - (ints.get(seg.b)?.trim.get(id) ?? 0) - 2;
      if (s1 <= s0) continue;
      const count = Math.max(1, Math.floor((s1 - s0) / o.spacing) + 1);
      const step = count > 1 ? (s1 - s0) / (count - 1) : 0;
      sidesOf().forEach((side, si) => {
        for (let k = 0; k < count; k++) {
          // Both sides: staggered by half a spacing (more even light).
          const s = count > 1 ? s0 + k * step + (si === 1 && k < count - 1 ? step / 2 : 0) : (s0 + s1) / 2;
          const p = curbPoint(seg, s, side);
          const t = pointAt(line, s);
          // Lamp arm (local +x) toward the road = −side · right normal.
          p.yaw = o.kind === 'streetLight' ? roadYaw(side * t.tz, -side * t.tx) : 0;
          pts.push(p);
        }
      });
    }
  } else if (o.kind === 'guardrail' || o.kind === 'fence') {
    const len = Number(INFRA_ITEMS[o.kind].params?.length ?? 4);
    for (const id of ids) {
      const seg = n.segments[id];
      const line = segmentLine(n, seg);
      const s0 = (ints.get(seg.a)?.trim.get(id) ?? 0) + 1;
      const s1 = line.length - (ints.get(seg.b)?.trim.get(id) ?? 0) - 1;
      for (const side of sidesOf()) {
        for (let s = s0 + len / 2; s + len / 2 <= s1 + 1e-6; s += Math.max(len, o.spacing)) {
          const t = pointAt(line, s);
          const walk = sideWidth(seg.profile, side > 0 ? 'right' : 'left');
          const lateral = side * (o.kind === 'fence' ? walk + 0.5 : walk + 0.35);
          pts.push({ x: t.x - t.tz * lateral, z: t.z + t.tx * lateral, yaw: roadYaw(t.tx, t.tz), segment: id, side, s });
        }
      }
    }
  } else if (o.kind === 'sign') {
    for (const id of ids) {
      const seg = n.segments[id];
      const line = segmentLine(n, seg);
      for (const atEnd of [false, true]) {
        const node = atEnd ? seg.b : seg.a;
        if (degree(n, node) < 3) continue;
        const trim = ints.get(node)?.trim.get(id) ?? 0;
        const s = atEnd ? line.length - trim - 3 : trim + 3;
        if (s < 0 || s > line.length) continue;
        // Traffic toward the node drives on its right: right of travel a→b at the b end,
        // left of a→b at the a end.
        const side: 1 | -1 = atEnd ? 1 : -1;
        const p = curbPoint(seg, s, side);
        const t = pointAt(line, s);
        // Panel (local +z) faces the approaching traffic (away from the node).
        const dx = atEnd ? -t.tx : t.tx, dz = atEnd ? -t.tz : t.tz;
        p.yaw = Math.atan2(dx, dz);
        pts.push(p);
      }
    }
  } else if (o.kind === 'signal') {
    const nodes = new Set<string>();
    for (const id of ids) for (const nd of [n.segments[id].a, n.segments[id].b]) if (degree(n, nd) >= 3) nodes.add(nd);
    for (const nd of [...nodes].sort()) {
      const ix = ints.get(nd);
      if (!ix) continue;
      for (const r of ix.roads) {
        // Approach of road r: right side of traffic driving toward the node.
        const seg = r.segment;
        const line = segmentLine(n, seg);
        const s = r.atStart ? r.trim + 1 : line.length - r.trim - 1;
        const side: 1 | -1 = r.atStart ? -1 : 1;
        const p = curbPoint(seg, Math.max(0, Math.min(line.length, s)), side);
        p.yaw = Math.atan2(r.dx, r.dz);
        pts.push(p);
      }
    }
  }
  // Street furniture belongs on the sidewalk / road edge: no road-clearance check.
  planAt(ctx, item, pts, o.seed, 45, o.policy, own, existing, plan, `infra:${o.kind}`, false);
  return plan;
}

// ── Vehicles ───────────────────────────────────────────────────────────────────

export interface VehicleOptions {
  /** Distance between vehicles (m, bumper to bumper + length). */
  spacing: number;
  /** 'lanes': in the driving lanes facing the direction of travel; 'parked': at the curb. */
  mode: 'lanes' | 'parked';
  seed: number;
  policy: LinkPolicy;
  presets: { type: ObjectType; params?: ObjectParams }[];
}

/** Vehicles along segments, aligned with the road, snapped to lanes or the curb. */
export function vehiclesAlong(ctx: CityContext, segIds: readonly string[], o: VehicleOptions): CityPlan {
  const n = ctx.network;
  const plan = emptyPlan();
  const existing = existingIndex(ctx.objects);
  const own = new FootprintIndex();
  const ints = intersectionsOf(n);
  const rng = new Rng(subSeed(o.seed, 'vehicles'));
  let k = 0;
  for (const id of [...segIds].sort()) {
    const seg = n.segments[id];
    if (!seg) continue;
    const line = segmentLine(n, seg);
    const p = seg.profile;
    const s0 = (ints.get(seg.a)?.trim.get(id) ?? 0) + 4;
    const s1 = line.length - (ints.get(seg.b)?.trim.get(id) ?? 0) - 4;
    const laneW = p.width / p.lanes;
    // Lane centers (lateral) with their travel direction (+1 = a→b).
    const lanes: { lateral: number; dir: 1 | -1 }[] = [];
    if (o.mode === 'parked') {
      lanes.push({ lateral: p.width / 2 - 1.1, dir: 1 });
      if (!p.oneWay) lanes.push({ lateral: -(p.width / 2 - 1.1), dir: -1 });
    } else {
      for (let i = 0; i < p.lanes; i++) {
        const lateral = -p.width / 2 + laneW * (i + 0.5);
        lanes.push({ lateral, dir: p.oneWay ? 1 : lateral >= 0 ? 1 : -1 });
      }
    }
    for (const lane of lanes) {
      for (let s = s0 + rng.next() * o.spacing * 0.5; s <= s1; s += o.spacing * (0.8 + rng.next() * 0.4)) {
        const t = pointAt(line, s);
        const item = rng.pick(o.presets);
        const yaw = roadYaw(lane.dir * t.tx, lane.dir * t.tz);
        const pt: FrontagePoint = { x: t.x - t.tz * lane.lateral, z: t.z + t.tx * lane.lateral, yaw, segment: id, side: lane.lateral >= 0 ? 1 : -1, s };
        planVehicle(ctx, item, pt, subSeed(o.seed, 'v', k++), o.policy, own, existing, plan);
      }
    }
  }
  return plan;
}

function planVehicle(ctx: CityContext, item: { type: ObjectType; params?: ObjectParams }, p: FrontagePoint, seed: number, policy: LinkPolicy, own: FootprintIndex, existing: FootprintIndex, plan: CityPlan) {
  const res = planPlacement({ ...item, randomize: true }, [{ x: p.x, z: p.z, yaw: p.yaw }], { ...DEFAULT_PLACEMENT, seed, randomRotation: false, slopeLimit: 30 }, { terrain: ctx.terrain, existing }, 0, own);
  const e = res[0];
  if (!e.ok) {
    plan.rejected[e.rejected === 'slope' ? 'slope' : e.rejected === 'outside' ? 'outside' : 'collision']++;
    return;
  }
  const link = measureLink(ctx.network, p.x, p.z, p.yaw, policy, p.segment);
  if (link) e.input.roadLink = link;
  plan.inputs.push(e.input);
}

// ── Blocks ─────────────────────────────────────────────────────────────────────

export interface FillOptions {
  seed: number;
  setback: number;
  gap: number;
  slopeLimit: number;
  /** Height variation: multiplies the preset floor range (0.5–2). */
  heightScale: number;
  policy: LinkPolicy;
}

export const DEFAULT_FILL: FillOptions = { seed: 1, setback: 3, gap: 4, slopeLimit: 20, heightScale: 1, policy: 'follow' };

/**
 * Fill a block by its zone: buildings along the inner frontage of every boundary road (facing
 * it); parks get trees on a jittered grid inside (clear of the roads) and lamps at the edge.
 */
export function fillBlock(ctx: CityContext, block: Block, zone: ZoneType, o: FillOptions): CityPlan {
  if (zone === 'park') return parkFill(ctx, block, o);
  const presets = ZONE_BUILDINGS[zone].map((p) => ({
    ...p,
    floors: [Math.max(1, Math.round(p.floors[0] * o.heightScale)), Math.max(1, Math.round(p.floors[1] * o.heightScale))] as [number, number],
  }));
  const plan = emptyPlan();
  const existing = existingIndex(ctx.objects);
  const own = new FootprintIndex();
  const rng = new Rng(subSeed(o.seed, block.id));
  const n = ctx.network;
  const ints = intersectionsOf(n);
  let k = 0;
  for (const e of block.edges) {
    const seg = n.segments[e.segment];
    const line = segmentLine(n, seg);
    const side = e.side;
    let s = (ints.get(seg.a)?.trim.get(seg.id) ?? 0) + 3;
    const s1 = line.length - (ints.get(seg.b)?.trim.get(seg.id) ?? 0) - 3;
    while (s < s1) {
      const choice = pickWeighted(rng, presets);
      const floors = choice.floors[0] + rng.int(choice.floors[1] - choice.floors[0] + 1);
      const design = presetDesign(choice.preset, floors);
      if (!design) break;
      const w = design.spec.width, d = design.spec.depth;
      if (s + w > s1) break;
      const mid = s + w / 2;
      const p = pointAt(line, mid);
      const lateral = side * (sideWidth(seg.profile, side > 0 ? 'right' : 'left') + o.setback + d / 2);
      const pt: FrontagePoint = { x: p.x - p.tz * lateral, z: p.z + p.tx * lateral, yaw: Math.atan2(side * p.tz, -side * p.tx), segment: seg.id, side, s: mid };
      // Only inside the block (deep buildings on short sides would cross the far road).
      if (pointInPolygon(block.polygon, pt.x, pt.z)) planAt(ctx, { type: 'building', building: design }, [pt], subSeed(o.seed, block.id, k), o.slopeLimit, o.policy, own, existing, plan, 'fill');
      s += w + o.gap;
      k++;
    }
  }
  return plan;
}

function parkFill(ctx: CityContext, block: Block, o: FillOptions): CityPlan {
  const plan = emptyPlan();
  const existing = existingIndex(ctx.objects);
  const own = new FootprintIndex();
  const rng = new Rng(subSeed(o.seed, `park:${block.id}`));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of block.polygon) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const pts: FrontagePoint[] = [];
  const step = 9;
  for (let z = z0 + step / 2; z < z1; z += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      const px = x + rng.spread(2.5), pz = z + rng.spread(2.5);
      if (!pointInPolygon(block.polygon, px, pz)) continue;
      pts.push({ x: px, z: pz, yaw: rng.next() * Math.PI * 2, segment: block.edges[0].segment, side: 1, s: 0 });
    }
  }
  planAt(ctx, { ...INFRA_ITEMS.tree, randomize: true }, pts, o.seed, 35, 'preserve', own, existing, plan, 'park');
  return plan;
}

// ── Neighbourhood presets ──────────────────────────────────────────────────────

export type NeighborhoodKind = 'residentialStreet' | 'commercialStreet' | 'industrialBlock' | 'parkBlock';
export const NEIGHBORHOODS: readonly NeighborhoodKind[] = ['residentialStreet', 'commercialStreet', 'industrialBlock', 'parkBlock'];

export interface NeighborhoodResult {
  network: RoadNetwork;
  inputs: CreateObjectInput[];
  rejected: CityPlan['rejected'];
  segments: string[];
}

/**
 * A procedural neighbourhood centred at (x, z) with heading `yaw` (rad): roads first (added to
 * the current network — snapping / junctions with existing roads like hand-drawn ones), then
 * buildings / infrastructure along them. Same inputs + seed → same result. Everything it makes
 * is ordinary roads and objects, editable afterwards.
 */
export function neighborhood(ctx: CityContext, kind: NeighborhoodKind, x: number, z: number, yaw: number, seed: number, policy: LinkPolicy = 'follow'): NeighborhoodResult {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (u: number, v: number): P2 => [Math.round((x + u * c + v * s) * 100) / 100, Math.round((z - u * s + v * c) * 100) / 100];
  const prof = (k: string): RoadProfile => ({ ...defaultProfile(), ...(PROFILE_PRESETS[k] ?? {}) });
  let net = ctx.network;
  const segs: string[] = [];
  const draw = (pts: P2[], p: RoadProfile) => {
    const r = drawRoad(net, pts, { curved: false, profile: p });
    net = r.network;
    segs.push(...r.segments);
  };
  if (kind === 'residentialStreet') draw([at(-60, 0), at(60, 0)], prof('street'));
  else if (kind === 'commercialStreet') draw([at(-70, 0), at(70, 0)], prof('avenue'));
  else if (kind === 'industrialBlock') draw([at(-50, -40), at(50, -40), at(50, 40), at(-50, 40), at(-50, -40)], { ...prof('street'), width: 8, sidewalkWidth: 1.5 });
  else draw([at(-40, -40), at(40, -40), at(40, 40), at(-40, 40), at(-40, -40)], prof('street'));
  // Segments that still exist after the later legs split earlier ones.
  const live = () => segs.filter((id) => net.segments[id]);
  const ids = live();
  const cctx: CityContext = { ...ctx, network: net };
  const inputs: CreateObjectInput[] = [];
  const rejected = { slope: 0, collision: 0, road: 0, outside: 0 };
  const take = (p: CityPlan) => {
    inputs.push(...p.inputs);
    for (const k of Object.keys(rejected) as (keyof typeof rejected)[]) rejected[k] += p.rejected[k];
    // Later stages avoid what earlier stages placed (as if already in the world).
    cctx.objects = { ...cctx.objects };
    p.inputs.forEach((inp, i) => {
      const id = `__plan${Object.keys(cctx.objects).length}_${i}`;
      cctx.objects[id] = { id, type: inp.type, name: '', serial: 0, seed: 0, transform: inp.transform, physics: getDefinition(inp.type).defaultPhysics(inp.params ?? getDefinition(inp.type).defaultParams), params: inp.params ?? getDefinition(inp.type).defaultParams, components: [] };
    });
  };
  if (kind === 'parkBlock' || kind === 'industrialBlock') {
    const block = blocksOf(net).find((b) => b.edges.every((e) => ids.includes(e.segment)) && pointInPolygon(b.polygon, x, z));
    if (block) take(fillBlock(cctx, block, kind === 'parkBlock' ? 'park' : 'industrial', { ...DEFAULT_FILL, seed, policy }));
    take(infrastructureAlong(cctx, ids, { kind: 'streetLight', side: kind === 'parkBlock' ? 'right' : 'both', spacing: 30, seed, policy }));
  } else {
    const zone = kind === 'residentialStreet' ? 'residential' : 'commercial';
    // Lights first (on the sidewalk), then buildings behind them.
    take(infrastructureAlong(cctx, ids, { kind: 'streetLight', side: 'both', spacing: kind === 'commercialStreet' ? 22 : 28, seed, policy }));
    if (kind === 'residentialStreet') take(infrastructureAlong(cctx, ids, { kind: 'tree', side: 'both', spacing: 14, seed, policy }));
    take(buildingsAlong(cctx, ids, { side: 'both', presets: ZONE_BUILDINGS[zone], gap: kind === 'residentialStreet' ? 5 : 3, setback: kind === 'residentialStreet' ? 4 : 1.5, seed, slopeLimit: 20, policy }));
  }
  return { network: net, inputs, rejected, segments: live() };
}
