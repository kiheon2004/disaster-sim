import type { EntityId, ObjectType, Transform } from '@/core/types';
import { defaultFloodScenario, defaultSimulationSettings, type ObjectParams, type PhysicalProperties, type ScenarioSettings, type WorldDocument, type WorldObject } from '@/core/model';
import { defaultSeismic } from '@/simulation/seismic/structuralProps';
import { AIR_DENSITY, GRAVITY, WORLD_SIZE } from '@/core/units';
import { createId } from '@/core/id';
import { getDefinition } from '@/objects/registry';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { defaultExperiment } from '@/phenomena/types';
import type { BuildingDesign } from '@/buildings/types';
import { deriveFields, regenerate, withDesign } from '@/buildings/design';
import { emptyNetwork } from '@/roads/types';

/**
 * 6 = Phase 18 (road network; modular building designs stored once in a design table).
 * 5 = Phase 15 (experiment: phenomenon instances + timing + seeds; interaction setting).
 * 4 = Phase 14 (water settings, saved flood scenario, lowland preset).
 * 3 = Phase 13 (soil layer, seismic properties, saved earthquake scenario).
 * 2 = Phase 12 (heightfield terrain). 1 = Phase 0–11 (flat). Older files are migrated on load.
 */
export const SCHEMA_VERSION = 6 as const;

export function defaultScenario(): ScenarioSettings {
  return { earthquake: null, flood: defaultFloodScenario(), experiment: defaultExperiment() };
}

export function createEmptyDocument(name = ''): WorldDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { name, createdAt: now, updatedAt: now },
    settings: { size: [WORLD_SIZE, WORLD_SIZE], gravity: GRAVITY, airDensity: AIR_DENSITY, simulation: defaultSimulationSettings() },
    terrain: createFlatTerrain(),
    objects: {},
    scenario: defaultScenario(),
    roads: emptyNetwork(),
  };
}

export interface CreateObjectInput {
  type: ObjectType;
  transform: Transform;
  params?: ObjectParams;
  physics?: Partial<PhysicalProperties>;
  name?: string;
  seed?: number;
  seismic?: WorldObject['seismic'];
  /** Editing group id (Phase 16). */
  group?: string;
  /** Modular building design (Phase 17): params / physics / seismic / components are derived from it. */
  building?: BuildingDesign;
  /** Slope alignment chosen at placement (Phase 17). */
  terrainAlign?: number;
  /** Link to a road (Phase 18). */
  roadLink?: import('@/roads/types').RoadLink;
}

export function nextSerial(objects: Record<EntityId, WorldObject>, type: ObjectType): number {
  let max = 0;
  for (const o of Object.values(objects)) if (o.type === type && o.serial > max) max = o.serial;
  return max + 1;
}

/** Build a complete, valid WorldObject from a type + overrides using its definition. */
export function createWorldObject(input: CreateObjectInput, serial: number): WorldObject {
  const def = getDefinition(input.type);
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  if (input.building && input.type === 'building') {
    // Modular building: everything but identity / transform derives from the design.
    const d = deriveFields(input.building, seed, input.seismic);
    const obj: WorldObject = {
      id: createId(input.type), type: input.type, name: input.name ?? '', serial, seed, transform: input.transform,
      physics: { ...d.physics, ...(input.physics ?? {}) }, params: d.params, components: d.components, seismic: d.seismic,
      // Designs are immutable values (edits make new ones): copies of a preset share one object.
      building: input.building,
    };
    if (input.group) obj.group = input.group;
    if (input.terrainAlign !== undefined) obj.terrainAlign = input.terrainAlign;
    if (input.roadLink) obj.roadLink = { ...input.roadLink };
    return obj;
  }
  const params = { ...def.defaultParams, ...(input.params ?? {}) };
  const obj: WorldObject = {
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
  const seismic = input.seismic ?? defaultSeismic(input.type);
  if (seismic) obj.seismic = structuredClone(seismic);
  if (input.group) obj.group = input.group;
  if (input.terrainAlign !== undefined) obj.terrainAlign = input.terrainAlign;
  if (input.roadLink) obj.roadLink = { ...input.roadLink };
  return obj;
}

/**
 * Apply a params patch. Physical properties that still equal their old defaults follow the
 * new defaults (e.g. mass grows with floors), while user-customized values are preserved.
 */
export function applyParams(obj: WorldObject, patch: ObjectParams): WorldObject {
  if (obj.building) return applyDesignParams(obj, patch);
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

/**
 * Legacy params edits (inspector, commands) on a modular building: appearance-only keys update
 * the spec; size / floor keys regenerate the members from the new spec (the Building Creator
 * warns before doing that to a design with manual member edits).
 */
function applyDesignParams(obj: WorldObject, patch: ObjectParams): WorldObject {
  const d = obj.building!;
  const spec = { ...d.spec };
  let structural = false;
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'color': if (typeof v === 'string') spec.color = v; break;
      case 'sign': if (typeof v === 'boolean') spec.sign = v; break;
      case 'rooftopUnits': if (typeof v === 'number') spec.rooftopUnits = Math.max(0, Math.min(6, Math.round(v))); break;
      case 'floors': if (typeof v === 'number') { spec.floors = Math.max(1, Math.min(40, Math.round(v))); structural = true; } break;
      case 'width': if (typeof v === 'number') { spec.width = v; structural = true; } break;
      case 'depth': if (typeof v === 'number') { spec.depth = v; structural = true; } break;
      case 'floorHeight': if (typeof v === 'number') { spec.floorHeight = v; spec.groundFloorHeight = v; structural = true; } break;
    }
  }
  return withDesign(obj, structural ? regenerate(d, spec) : { ...d, spec });
}

export function cloneDocument(doc: WorldDocument): WorldDocument {
  return structuredClone(doc);
}
