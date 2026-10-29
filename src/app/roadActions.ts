/**
 * Road Editing Mode actions (Phase 18). Every action builds the complete next network (and the
 * objects it adds / removes) first and commits it as ONE atomic world edit = one undo step;
 * an invalid result throws before anything changes and is reported as a toast.
 */
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { useWorldStore, type WorldEdit } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useRoadStore, EMPTY_SELECTION } from '@/editor/roadStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { waterFeatureAvoid } from '@/landscape/hydrology';
import { yawOf } from '@/terrain/groundPlacement';
import { toast } from '@/ui/common/toast';
import type { P2 } from '@/roads/curve';
import {
  addControl, deleteSegments, drawRoad, mergeAtNode, moveControl, moveNode, setNodeElevation, setProfile, splitSegment,
} from '@/roads/network';
import { blocksOf, setZone } from '@/roads/blocks';
import {
  buildingsAlong, fillBlock, infrastructureAlong, neighborhood, vehiclesAlong, DEFAULT_FILL, INFRA_SPACING, ZONE_BUILDINGS,
  type CityContext, type CityPlan, type FrontSide, type InfraKind, type NeighborhoodKind,
} from '@/roads/city';
import { defaultProfile, type LinkPolicy, type RoadNetwork, type RoadProfile, type ZoneType } from '@/roads/types';

const W = () => useWorldStore.getState();
const R = () => useRoadStore.getState();

function locked(): boolean {
  if (W().locked || useEditorStore.getState().mode !== 'editor') {
    toast('warn', { key: 'road.locked' });
    return true;
  }
  return false;
}

/** Commit an edit; errors (invalid network) become a toast and change nothing. */
function commit(edit: WorldEdit, okKey?: Parameters<typeof toast>[1]): EntityId[] | null {
  try {
    const ids = W().applyEdit(edit);
    if (okKey) toast('success', okKey);
    return ids;
  } catch (e) {
    toast('error', { key: 'road.error.invalid' }, (e as Error).message);
    return null;
  }
}

/** Finish the current draft (draw: polyline legs, curve: one smooth segment). */
export function finishDraft(): boolean {
  const { draft, mode, profile } = R();
  if (draft.length < 2) {
    R().clearDraft();
    return false;
  }
  if (locked()) return false;
  try {
    const res = drawRoad(W().doc.roads, draft, { curved: mode === 'curve', profile });
    if (commit({ roads: res.network })) {
      R().clearDraft();
      R().select({ segments: res.segments, node: null });
      return true;
    }
  } catch (e) {
    toast('warn', { key: 'road.error.tooShort' }, (e as Error).message);
  }
  return false;
}

export function deleteRoadSegments(ids: string[]) {
  if (!ids.length || locked()) return;
  if (commit({ roads: deleteSegments(W().doc.roads, ids) })) R().select(EMPTY_SELECTION);
}

export function splitRoadAt(segId: string, x: number, z: number) {
  if (locked()) return;
  try {
    const r = splitSegment(W().doc.roads, segId, x, z);
    if (commit({ roads: r.network })) R().select({ segments: [], node: r.node });
  } catch (e) {
    toast('warn', { key: 'road.error.split' }, (e as Error).message);
  }
}

export function mergeRoadsAt(nodeId: string) {
  if (locked()) return;
  const next = mergeAtNode(W().doc.roads, nodeId);
  if (!next) {
    toast('warn', { key: 'road.error.merge' });
    return;
  }
  if (commit({ roads: next })) R().select(EMPTY_SELECTION);
}

export function updateRoadProfile(ids: string[], patch: Partial<RoadProfile>) {
  if (!ids.length || locked()) return;
  commit({ roads: setProfile(W().doc.roads, ids, patch) });
}

export function moveRoadNode(id: string, x: number, z: number) {
  if (locked()) return;
  commit({ roads: moveNode(W().doc.roads, id, x, z) });
}

export function setRoadNodeElevation(id: string, y: number | null) {
  if (locked()) return;
  commit({ roads: setNodeElevation(W().doc.roads, id, y) });
}

export function moveRoadControl(segId: string, index: number, x: number, z: number) {
  if (locked()) return;
  commit({ roads: moveControl(W().doc.roads, segId, index, x, z) });
}

export function addRoadControl(segId: string, x: number, z: number) {
  if (locked()) return;
  commit({ roads: addControl(W().doc.roads, segId, x, z) });
}

/**
 * Change the link policy of the objects linked to the given segments (all linked objects when
 * `segments` is empty).
 */
export function setLinkPolicyFor(segments: string[], policy: LinkPolicy) {
  if (locked()) return;
  const set = new Set(segments);
  const update: WorldObject[] = [];
  for (const o of Object.values(W().doc.objects)) {
    if (!o.roadLink || (set.size && !set.has(o.roadLink.segment)) || o.roadLink.policy === policy) continue;
    update.push({ ...o, roadLink: { ...o.roadLink, policy } });
  }
  if (update.length) commit({ update });
}

/** Objects linked to segments. */
export function linkedObjects(segments: readonly string[]): WorldObject[] {
  const set = new Set(segments);
  return Object.values(W().doc.objects).filter((o) => o.roadLink && set.has(o.roadLink.segment));
}

// ── Blocks & city building ─────────────────────────────────────────────────────

export function assignZone(blockId: string, zone: ZoneType | null) {
  if (locked()) return;
  commit({ roads: setZone(W().doc.roads, blockId, zone) });
}

function cityContext(): CityContext {
  const doc = W().doc;
  return { terrain: samplerFor(doc.terrain), objects: doc.objects, network: doc.roads, avoid: waterFeatureAvoid(doc.landscape.features) };
}

function report(plan: CityPlan, key: 'road.city.placed') {
  const r = plan.rejected;
  const skipped = r.slope + r.collision + r.road + r.outside;
  toast(plan.inputs.length ? 'success' : 'warn', { key, params: { n: plan.inputs.length, skipped, slope: r.slope, collision: r.collision + r.road } });
}

/** Fill blocks with buildings by their zone (only zoned blocks; `ids` empty = all zoned blocks). */
export function fillBlocks(ids: string[], seed: number, heightScale = 1) {
  if (locked()) return;
  const ctx = cityContext();
  const plan: CityPlan = { inputs: [], rejected: { slope: 0, collision: 0, road: 0, outside: 0 } };
  for (const b of blocksOf(ctx.network)) {
    if (ids.length && !ids.includes(b.id)) continue;
    if (!b.zone) continue;
    const p = fillBlock({ ...ctx, objects: withPlanned(ctx.objects, plan) }, b, b.zone, { ...DEFAULT_FILL, seed, heightScale, policy: R().linkPolicy });
    plan.inputs.push(...p.inputs);
    for (const k of Object.keys(plan.rejected) as (keyof CityPlan['rejected'])[]) plan.rejected[k] += p.rejected[k];
  }
  if (plan.inputs.length) commit({ add: plan.inputs });
  report(plan, 'road.city.placed');
}

/** Planned inputs as provisional objects (so a later stage of one action avoids them). */
function withPlanned(objects: Record<string, WorldObject>, plan: CityPlan): Record<string, WorldObject> {
  if (!plan.inputs.length) return objects;
  const out = { ...objects };
  plan.inputs.forEach((inp, i) => {
    out[`__planned${i}`] = { id: `__planned${i}`, type: inp.type, name: '', serial: 0, seed: 0, transform: inp.transform, physics: {} as WorldObject['physics'], params: inp.params ?? {}, components: [] };
  });
  return out;
}

export function addInfrastructure(segIds: string[], kind: InfraKind, side: FrontSide, spacing = INFRA_SPACING[kind], seed = 1) {
  if (locked()) return;
  const ids = segIds.length ? segIds : Object.keys(W().doc.roads.segments);
  const plan = infrastructureAlong(cityContext(), ids, { kind, side, spacing, seed, policy: R().linkPolicy });
  if (plan.inputs.length) commit({ add: plan.inputs });
  report(plan, 'road.city.placed');
}

export function addBuildingsAlong(segIds: string[], zone: Exclude<ZoneType, 'park'>, side: FrontSide, setback: number, gap: number, seed: number, slopeLimit: number) {
  if (locked()) return;
  const ids = segIds.length ? segIds : Object.keys(W().doc.roads.segments);
  const plan = buildingsAlong(cityContext(), ids, { side, presets: ZONE_BUILDINGS[zone], gap, setback, seed, slopeLimit, policy: R().linkPolicy });
  if (plan.inputs.length) commit({ add: plan.inputs });
  report(plan, 'road.city.placed');
}

export function addVehiclesAlong(segIds: string[], mode: 'lanes' | 'parked', spacing: number, seed: number) {
  if (locked()) return;
  const ids = segIds.length ? segIds : Object.keys(W().doc.roads.segments);
  const plan = vehiclesAlong(cityContext(), ids, {
    mode, spacing, seed, policy: R().linkPolicy,
    presets: [
      { type: 'car', params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#3d6fd6' } },
      { type: 'car', params: { variant: 'suv', length: 4.8, width: 1.95, height: 1.8, color: '#e9e9e6' } },
      { type: 'car', params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#b8352f' } },
    ],
  });
  if (plan.inputs.length) commit({ add: plan.inputs });
  report(plan, 'road.city.placed');
}

/** Procedural neighbourhood at (x, z): roads + objects in one undo step. */
export function placeNeighborhood(kind: NeighborhoodKind, x: number, z: number, yaw: number, seed: number) {
  if (locked()) return;
  try {
    const res = neighborhood(cityContext(), kind, x, z, yaw, seed, R().linkPolicy);
    if (commit({ roads: res.network, add: res.inputs })) {
      R().select({ segments: res.segments, node: null });
      report({ inputs: res.inputs, rejected: res.rejected }, 'road.city.placed');
    }
  } catch (e) {
    toast('error', { key: 'road.error.invalid' }, (e as Error).message);
  }
}

// ── Legacy roads ───────────────────────────────────────────────────────────────

/**
 * Convert legacy road OBJECTS (Phase 0–17: straight, flat, draped) into network roads. Safe
 * conversion only: each object becomes one straight 'follow' segment with its width and lanes
 * (no sidewalks, so the look and the ground do not change); one that would be invalid (too
 * short, outside the world) is kept as an object. One undo step; the count is reported.
 */
export function convertLegacyRoads(ids?: EntityId[]): { converted: number; kept: number } {
  if (locked()) return { converted: 0, kept: 0 };
  const doc = W().doc;
  const half = (doc.terrain.nx - 1) * doc.terrain.cellSize / 2;
  let net: RoadNetwork = doc.roads;
  const remove: EntityId[] = [];
  let kept = 0;
  // Largest roads first (main roads before side streets), so a side street ending on a main
  // road snaps onto it as a T-junction, whatever the object order.
  const area = (o: WorldObject) => Number(o.params.length) * o.transform.scale[0] * Number(o.params.width) * o.transform.scale[2];
  const legacy = Object.values(doc.objects).filter((o) => o.type === 'road' && (!ids || ids.includes(o.id))).sort((a, b) => area(b) - area(a) || (a.id < b.id ? -1 : 1));
  for (const o of legacy) {
    const L = Number(o.params.length) * o.transform.scale[0];
    const w = Number(o.params.width) * o.transform.scale[2];
    const yaw = yawOf(o.transform.rotation);
    const dx = Math.cos(yaw), dz = -Math.sin(yaw);
    const [x, , z] = o.transform.position;
    const a: P2 = [x - (dx * L) / 2, z - (dz * L) / 2], b: P2 = [x + (dx * L) / 2, z + (dz * L) / 2];
    const inside = [a, b].every(([px, pz]) => Math.abs(px) <= half && Math.abs(pz) <= half);
    const profile: RoadProfile = { ...defaultProfile(), width: w, lanes: Math.max(1, Math.round(Number(o.params.lanes) || 2)), sidewalk: 'none', elevation: 'follow', markings: true };
    if (!inside) { kept++; continue; }
    try {
      net = drawRoad(net, [a, b], { curved: false, profile }).network;
      remove.push(o.id);
    } catch {
      kept++;
    }
  }
  if (!remove.length) {
    toast('info', { key: 'road.legacy.none', params: { kept } });
    return { converted: 0, kept };
  }
  if (!commit({ roads: net, remove })) return { converted: 0, kept: legacy.length };
  toast('success', { key: 'road.legacy.converted', params: { n: remove.length, kept } });
  return { converted: remove.length, kept };
}
