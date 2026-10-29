/**
 * Copy / paste payload and the foundation of the Phase 20 blueprint system.
 *
 * A blueprint is a self-contained, JSON-serializable description of one or more objects with
 * transforms RELATIVE to an anchor (the center of their ground-plane bounds). It keeps
 * everything that defines an object — type, params (size, material, structure), physics,
 * seismic properties, seed, name, relative rotation / scale, groups — and never ids: pasting
 * always creates fresh ids (and fresh group ids), so a blueprint can be placed any number of
 * times. Objects that stood on the ground are re-seated on the terrain where they are pasted;
 * lifted objects keep their height above the ground.
 */
import { z } from 'zod';
import type { ObjectType, Vec3 } from '@/core/types';
import type { ObjectParams, PhysicalProperties, SeismicProperties, WorldObject } from '@/core/model';
import type { BuildingDesign } from '@/buildings/types';
import { parseDesign } from '@/buildings/schema';
import { designParams } from '@/buildings/design';
import { createId } from '@/core/id';
import { getDefinition, hasDefinition } from '@/objects/registry';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { groundPose, isGrounded, yawOf } from '@/terrain/groundPlacement';
import { selectionPivot, yawRotate } from './groupTransform';
import type { LinkPolicy, RoadNetwork } from '@/roads/types';
import { blueprintRoadsSchema, captureRoads, type BlueprintRoads } from '@/roads/blueprintRoads';

export const BLUEPRINT_FORMAT = 'disaster-sim/blueprint';
export const BLUEPRINT_VERSION = 1;

export interface BlueprintObject {
  type: ObjectType;
  name: string;
  seed: number;
  params: ObjectParams;
  physics: PhysicalProperties;
  seismic?: SeismicProperties;
  /** Position relative to the anchor (x, z) and height above the ground under it (y). */
  offset: Vec3;
  /** Rotation (Euler XYZ) as placed in the source world. */
  rotation: Vec3;
  scale: Vec3;
  /** Stood on the ground in the source world → re-seated on paste. */
  grounded: boolean;
  /** Local group key (objects with the same key form one group after pasting). */
  group?: string;
  /**
   * Modular building design (Phase 17): members, connections (implicit in the geometry),
   * materials, foundation settings, appearance and structural spec. Member ids are local to
   * the building, so they stay valid in every copy (the object id is new on each paste).
   */
  building?: BuildingDesign;
  /** Slope alignment chosen at placement (Phase 17). */
  terrainAlign?: number;
  /** Link to a road of this blueprint (Phase 18): index into `roads.segments`. */
  roadLink?: { segment: number; t: number; lateral: number; yaw: number; policy: LinkPolicy };
}

export interface Blueprint {
  format: typeof BLUEPRINT_FORMAT;
  version: typeof BLUEPRINT_VERSION;
  name: string;
  /** Size of the ground-plane bounds of the object origins (m). */
  size: [number, number];
  objects: BlueprintObject[];
  /** Road segments (Phase 18), relative to the anchor; pasted with fresh ids. */
  roads?: BlueprintRoads;
}

/**
 * Build a blueprint from objects of the world (deep copies; ids dropped). `roads` (Phase 18):
 * segments of the network to copy along; links of copied objects to copied segments are kept,
 * links to other roads are dropped (the copy is not attached to the source's roads).
 */
export function createBlueprint(objs: readonly WorldObject[], terrain: TerrainSampler, name = '', roads?: { network: RoadNetwork; segments: readonly string[] }): Blueprint {
  const segIds = roads ? roads.segments.filter((id) => roads.network.segments[id]) : [];
  let pivot = selectionPivot(objs);
  if (roads && segIds.length && !objs.length) {
    // Roads only: anchor at the center of the copied nodes' bounds.
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const id of segIds) for (const nd of [roads.network.nodes[roads.network.segments[id].a], roads.network.nodes[roads.network.segments[id].b]]) {
      a = Math.min(a, nd.x); b = Math.max(b, nd.x); c = Math.min(c, nd.z); d = Math.max(d, nd.z);
    }
    pivot = { x: (a + b) / 2, z: (c + d) / 2, y: 0 };
  }
  const groundAtPivot = terrain.sampleHeight(pivot.x, pivot.z);
  const captured = roads && segIds.length ? captureRoads(roads.network, segIds, pivot.x, pivot.z, groundAtPivot) : null;
  const groupKeys = new Map<string, string>();
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const objects = [...objs]
    .sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial || a.id.localeCompare(b.id))
    .map((o): BlueprintObject => {
      const [x, y, zz] = o.transform.position;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, zz); z1 = Math.max(z1, zz);
      const grounded = isGrounded(o, terrain);
      const ground = groundPose(o, x, zz, yawOf(o.transform.rotation), terrain).position[1];
      let group: string | undefined;
      if (o.group) {
        if (!groupKeys.has(o.group)) groupKeys.set(o.group, `g${groupKeys.size + 1}`);
        group = groupKeys.get(o.group);
      }
      const bo: BlueprintObject = {
        type: o.type,
        name: o.name,
        seed: o.seed,
        params: structuredClone(o.params),
        physics: structuredClone(o.physics),
        offset: [x - pivot.x, grounded ? 0 : y - ground, zz - pivot.z],
        rotation: [...o.transform.rotation] as Vec3,
        scale: [...o.transform.scale] as Vec3,
        grounded,
      };
      if (o.seismic) bo.seismic = structuredClone(o.seismic);
      if (group) bo.group = group;
      if (o.building) bo.building = structuredClone(o.building);
      if (o.terrainAlign !== undefined) bo.terrainAlign = o.terrainAlign;
      const li = o.roadLink && captured ? captured.index.get(o.roadLink.segment) : undefined;
      if (o.roadLink && li !== undefined) bo.roadLink = { segment: li, t: o.roadLink.t, lateral: o.roadLink.lateral, yaw: o.roadLink.yaw, policy: o.roadLink.policy };
      return bo;
    });
  const bp: Blueprint = {
    format: BLUEPRINT_FORMAT,
    version: BLUEPRINT_VERSION,
    name,
    size: objs.length ? [x1 - x0, z1 - z0] : [0, 0],
    objects,
  };
  if (captured) bp.roads = captured.roads;
  return bp;
}

/**
 * Inputs that place the blueprint with its anchor at (x, z), rotated by `yaw` about it.
 * Group keys map to NEW group ids (one per key per paste).
 */
export function instantiateBlueprint(bp: Blueprint, x: number, z: number, yaw: number, terrain: TerrainSampler): (CreateObjectInput & { group?: string })[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const groups = new Map<string, string>();
  return bp.objects.map((o) => {
    const px = x + o.offset[0] * c + o.offset[2] * s;
    const pz = z - o.offset[0] * s + o.offset[2] * c;
    const probe = { type: o.type, params: o.params, terrainAlign: o.terrainAlign, transform: { position: [px, 0, pz] as Vec3, rotation: o.rotation, scale: o.scale } };
    const rotated = yawRotate(o.rotation, yaw);
    const pose = groundPose(probe, px, pz, yawOf(rotated), terrain);
    const position: Vec3 = [px, pose.position[1] + (o.grounded ? 0 : o.offset[1]), pz];
    // Grounded objects take the terrain tilt of the new spot; on flat ground (and for lifted
    // objects) the source rotation is kept, turned by the paste heading.
    const rotation = o.grounded && !terrain.flat ? pose.rotation : rotated;
    const input: CreateObjectInput & { group?: string } = {
      type: o.type,
      name: o.name,
      seed: o.seed,
      params: structuredClone(o.params),
      physics: structuredClone(o.physics),
      transform: { position, rotation, scale: [...o.scale] as Vec3 },
    };
    if (o.seismic) input.seismic = structuredClone(o.seismic);
    if (o.building) input.building = o.building; // immutable value, shared by every paste
    if (o.terrainAlign !== undefined) input.terrainAlign = o.terrainAlign;
    if (o.group) {
      if (!groups.has(o.group)) groups.set(o.group, createId('grp'));
      input.group = groups.get(o.group);
    }
    return input;
  });
}

// ── JSON (Phase 20 blueprint files / clipboard text) ─────────────────────

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const blueprintSchema = z.object({
  format: z.literal(BLUEPRINT_FORMAT),
  version: z.literal(BLUEPRINT_VERSION),
  name: z.string().default(''),
  size: z.tuple([z.number(), z.number()]).default([0, 0]),
  objects: z.array(z.object({
    type: z.string(),
    name: z.string().default(''),
    seed: z.number(),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    physics: z.record(z.string(), z.union([z.number(), z.boolean()])),
    seismic: z.any().optional(),
    building: z.unknown().optional(),
    terrainAlign: z.number().min(0).max(1).optional().catch(undefined),
    offset: vec3,
    rotation: vec3,
    scale: vec3,
    grounded: z.boolean(),
    group: z.string().optional(),
    roadLink: z.object({ segment: z.number().int().min(0), t: z.number().min(0).max(1), lateral: z.number(), yaw: z.number(), policy: z.enum(['follow', 'preserve', 'detach']).catch('follow') }).optional().catch(undefined),
  })),
  roads: blueprintRoadsSchema.optional().catch(undefined),
});

export function serializeBlueprint(bp: Blueprint): string {
  return JSON.stringify(bp);
}

/** Parse + validate; objects of unknown types are dropped (like project files). */
export function parseBlueprint(json: string): Blueprint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const r = blueprintSchema.safeParse(raw);
  if (!r.success) return null;
  const objects = r.data.objects.filter((o) => hasDefinition(o.type)).map((o) => {
    const def = getDefinition(o.type as ObjectType);
    const { building: rawBuilding, ...rest } = o;
    const out = {
      ...rest,
      type: o.type as ObjectType,
      params: { ...def.defaultParams, ...o.params },
      physics: { ...def.defaultPhysics({ ...def.defaultParams, ...o.params }), ...o.physics } as PhysicalProperties,
    } as BlueprintObject;
    if (rawBuilding !== undefined && o.type === 'building') {
      const d = parseDesign(rawBuilding).design;
      if (d) {
        out.building = d;
        out.params = designParams(d);
      }
    }
    return out;
  });
  return { ...r.data, objects } as Blueprint;
}
