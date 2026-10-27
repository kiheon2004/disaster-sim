import type { EntityId, ObjectType, Transform } from '@/core/types';
import type { ObjectParams, PhysicalProperties, WorldDocument, WorldObject } from '@/core/model';
import { AIR_DENSITY, GRAVITY, WORLD_SIZE } from '@/core/units';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';

export const SCHEMA_VERSION = 1 as const;

export function createEmptyDocument(name = ''): WorldDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { name, createdAt: now, updatedAt: now },
    settings: { size: [WORLD_SIZE, WORLD_SIZE], gravity: GRAVITY, airDensity: AIR_DENSITY },
    terrain: { kind: 'flat' },
    objects: {},
  };
}

export interface CreateObjectInput {
  type: ObjectType;
  transform: Transform;
  params?: ObjectParams;
  physics?: Partial<PhysicalProperties>;
  name?: string;
  seed?: number;
}

export function nextSerial(objects: Record<EntityId, WorldObject>, type: ObjectType): number {
  let max = 0;
  for (const o of Object.values(objects)) if (o.type === type && o.serial > max) max = o.serial;
  return max + 1;
}

/** Build a complete, valid WorldObject from a type + overrides using its definition. */
export function createWorldObject(input: CreateObjectInput, serial: number): WorldObject {
  const def = getDefinition(input.type);
  const params = { ...def.defaultParams, ...(input.params ?? {}) };
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  return {
    id: createId(input.type),
    type: input.type,
    name: input.name ?? '',
    serial,
    seed,
    transform: input.transform,
    physics: { ...def.defaultPhysics(params), ...(input.physics ?? {}) },
    params,
    components: def.createComponents(params, seed),
  };
}

/**
 * Apply a params patch. Physical properties that still equal their old defaults follow the
 * new defaults (e.g. mass grows with floors), while user-customized values are preserved.
 */
export function applyParams(obj: WorldObject, patch: ObjectParams): WorldObject {
  const def = getDefinition(obj.type);
  const params = { ...obj.params, ...patch };
  const oldDefaults = def.defaultPhysics(obj.params);
  const newDefaults = def.defaultPhysics(params);
  const physics = { ...obj.physics };
  for (const key of Object.keys(newDefaults) as (keyof PhysicalProperties)[]) {
    if (physics[key] === oldDefaults[key]) (physics as Record<string, unknown>)[key] = newDefaults[key];
  }
  return { ...obj, params, physics, components: def.createComponents(params, obj.seed) };
}

export function cloneDocument(doc: WorldDocument): WorldDocument {
  return structuredClone(doc);
}
